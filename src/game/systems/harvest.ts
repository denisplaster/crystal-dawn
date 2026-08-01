/**
 * Harvest — the harvester economic cycle.
 *
 * Runs after `movement`, so a harvester that reached its destination this tick
 * (movement cleared the order on arrival) advances its state machine in the
 * same tick.
 *
 * Cycle: seeking -> harvesting -> returning -> unloading -> seeking …
 *
 *   seeking     drive to the crystal tile we are working (or acquire one)
 *   harvesting  sit on the tile and scoop HARVEST_RATE credits every few ticks
 *   returning   drive to a dock tile adjacent to the nearest own refinery
 *   unloading   drip the cargo into the player's account (respecting storage)
 *
 * Integration with the order/movement system: this system never drives units
 * itself. It issues plain `move` orders (exactly like `orders.ts` does) and
 * only acts on a harvester that is *idle* (no live order), so a manual player
 * order always wins and the harvester resumes its cycle once that order ends.
 * A player-issued `harvest` / `deliver` order is consumed here and turned into
 * the matching cycle state.
 */

import {
  HARVEST_RATE,
  PLAYER_HUMAN,
  TILE,
  inBounds,
  secondsToTicks,
  tileCenter,
  worldToTile,
} from '../constants';
import { crystalAt, depleteCrystal, isPassable } from '../map';
import { findNearestPassable } from '../pathfinding';
import { UNIT_TYPES } from '../rules';
import {
  findBuilding,
  findUnit,
  markMapTileDirty,
  postMessage,
  type Building,
  type GameState,
  type TilePos,
  type Unit,
} from '../state';

// --- tunables ---------------------------------------------------------------

/** Ticks between crystal scoops while parked on a tile. */
const GATHER_INTERVAL = 4;
/** Credits transferred per tick while docked (700cr load ≈ 14 ticks). */
const UNLOAD_PER_TICK = 50;
/** Close enough to the refinery footprint to start unloading. */
const DOCK_RANGE = TILE * 1.6;
/** Close enough to a crystal tile to work it. */
const GATHER_RANGE = TILE * 1.15;
/** Pushed further than this off the worked tile -> re-approach it. */
const GATHER_LEASH = TILE * 2.4;
/** Ring-search radius (tiles) when acquiring a crystal tile / dock. */
const CRYSTAL_SEARCH_RADIUS = 40;
/** Ticks to wait before retrying a failed search (no crystal / no refinery). */
const RETRY_DELAY = 20;

// --- self-preservation (post-release) ---------------------------------------

/**
 * Sim ticks a harvester stays out of the field after it is shot at, or after a
 * player order pulls it off the cycle. 12 seconds: long enough for whatever is
 * shooting to move on or be dealt with, short enough that the economy is only
 * dented rather than stopped.
 */
export const DANGER_HOLD_TICKS = secondsToTicks(12);
/**
 * How far (in tiles) the harvester would *like* the next field to be from the
 * tile it was attacked on. If nothing that far away has crystal on a passable
 * tile it falls back to the nearest field — money has to keep flowing, so the
 * preference is a preference, not a rule.
 */
export const SAFE_FIELD_TILES = 8;
/** Ticks before a panicking harvester re-plans its run home. */
const FLEE_REISSUE = 20;

/** A flee destination closer than this (tiles) to the shooter is no refuge. */
const FLEE_MIN_GAP = 6;
/** How far past its own position a harvester runs when fleeing the shooter. */
const FLEE_AWAY_TILES = 10;

// --- small helpers ----------------------------------------------------------

function capacityOf(u: Unit): number {
  return UNIT_TYPES[u.type].cargoCapacity;
}

function clearOrder(u: Unit): void {
  u.order = undefined;
  u.orderQueue = [];
  u.path = undefined;
  u.pathIndex = undefined;
  u.goal = undefined;
  u.repathAt = undefined;
  u.blockedTicks = 0;
}

/** Issue an internal move order, mirroring what `orders.ts` assigns. */
function issueMoveTo(u: Unit, tx: number, ty: number): void {
  const already =
    u.order !== undefined &&
    u.order.kind === 'move' &&
    u.order.tile !== undefined &&
    u.order.tile.tx === tx &&
    u.order.tile.ty === ty;
  if (already) return;
  clearOrder(u);
  u.order = {
    kind: 'move',
    tile: { tx, ty },
    target: { x: tileCenter(tx), y: tileCenter(ty) },
  };
}

function distToTile(u: Unit, tile: TilePos): number {
  return Math.hypot(tileCenter(tile.tx) - u.pos.x, tileCenter(tile.ty) - u.pos.y);
}

/** Distance from a world point to the nearest edge of a building footprint. */
export function distanceToBuilding(x: number, y: number, b: Building): number {
  const x0 = b.tx * TILE;
  const y0 = b.ty * TILE;
  const x1 = x0 + b.w * TILE;
  const y1 = y0 + b.h * TILE;
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
  const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
  return Math.hypot(dx, dy);
}

// --- queries ----------------------------------------------------------------

/** Tile-space distance between two tiles. */
export function tileDistance(a: TilePos, b: TilePos): number {
  return Math.hypot(a.tx - b.tx, a.ty - b.ty);
}

/**
 * Nearest tile with crystal left that a harvester can stand on, searched in
 * rings out from (tx, ty). Deterministic (fixed scan order, no RNG).
 *
 * `avoid` / `avoidRadius` are the post-release danger filter: tiles within
 * `avoidRadius` of `avoid` are skipped entirely, which is how a harvester that
 * was shot at resumes in a *different* field. Reachability is approximated by
 * passability here, exactly as the unfiltered search always has — a genuine
 * path test per candidate would cost an A* per tile.
 */
export function nearestCrystalTile(
  state: GameState,
  tx: number,
  ty: number,
  maxRadius = CRYSTAL_SEARCH_RADIUS,
  avoid?: TilePos,
  avoidRadius = 0,
): TilePos | null {
  const map = state.map;
  const shunned = (nx: number, ny: number): boolean =>
    avoid !== undefined &&
    avoidRadius > 0 &&
    Math.hypot(nx - avoid.tx, ny - avoid.ty) < avoidRadius;

  if (
    inBounds(tx, ty) &&
    crystalAt(map, tx, ty) > 0 &&
    isPassable(map, tx, ty) &&
    !shunned(tx, ty)
  ) {
    return { tx, ty };
  }

  let best: TilePos | null = null;
  let bestD = Infinity;
  for (let r = 1; r <= maxRadius; r++) {
    for (let oy = -r; oy <= r; oy++) {
      const onYEdge = oy === -r || oy === r;
      for (let ox = -r; ox <= r; ox++) {
        if (!onYEdge && ox !== -r && ox !== r) continue; // ring only
        const nx = tx + ox;
        const ny = ty + oy;
        if (!inBounds(nx, ny)) continue;
        if (crystalAt(map, nx, ny) <= 0) continue;
        if (!isPassable(map, nx, ny)) continue;
        if (shunned(nx, ny)) continue;
        const d = ox * ox + oy * oy;
        if (d < bestD) {
          bestD = d;
          best = { tx: nx, ty: ny };
        }
      }
    }
    if (best && Math.sqrt(bestD) <= r + 1) return best;
  }
  return best;
}

/** Nearest living, finished refinery owned by this unit's player. */
export function nearestRefinery(state: GameState, u: Unit): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of state.buildings) {
    if (b.dead || b.player !== u.player || b.type !== 'refinery') continue;
    if (b.status !== 'ready') continue;
    const d = distanceToBuilding(u.pos.x, u.pos.y, b);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * Nearest living, finished refinery *or* construction yard owned by this unit's
 * player — i.e. "home", the thing a panicking harvester runs to. A ConYard
 * cannot take a load, but it is inside the base and usually defended, which is
 * the whole point of the retreat.
 */
export function nearestHome(state: GameState, u: Unit): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of state.buildings) {
    if (b.dead || b.player !== u.player) continue;
    if (b.type !== 'refinery' && b.type !== 'conyard') continue;
    if (b.status !== 'ready') continue;
    // A refinery is preferred over a ConYard at equal distance: a loaded
    // harvester can dock there and the trip is not wasted.
    const d = distanceToBuilding(u.pos.x, u.pos.y, b) - (b.type === 'refinery' ? TILE : 0);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Is this harvester currently refusing to go back into the field? */
export function onDangerHold(state: GameState, u: Unit): boolean {
  return state.tick < (u.dangerHoldUntil ?? 0);
}

/**
 * A harvester just took a hit. It drops whatever leg of the cycle it was on,
 * runs for home (nearest own refinery / ConYard) and arms the danger hold, so
 * it will not drive straight back into the same fire when it settles.
 *
 * Hardwired for *every* harvester, human and AI alike — this is unit behaviour,
 * not a UI feature — and deliberately not a stance: harvesters take no stance.
 */
export function harvesterUnderFire(state: GameState, u: Unit, sourceId?: number): void {
  if (u.dead) return;
  if (UNIT_TYPES[u.type].kind !== 'harvester') return;

  u.dangerTile = { tx: worldToTile(u.pos.x), ty: worldToTile(u.pos.y) };
  // The hold is refreshed by every hit, so sustained fire keeps it parked.
  u.dangerHoldUntil = state.tick + DANGER_HOLD_TICKS;

  // ...but the run home is only re-planned occasionally, or a burst of
  // machine-gun fire would throw away the path 10 times a second.
  if (state.tick < (u.fleeAt ?? 0)) return;
  u.fleeAt = state.tick + FLEE_REISSUE;

  // Player intent wins: a live manual order (a rescue move, say) is never
  // stomped by the reflex — the hold stays armed, the player keeps the wheel.
  if (u.order && !u.order.auto) return;

  // A load already aboard is still worth delivering: home is where it was
  // going anyway, so the retreat doubles as the delivery leg.
  u.harvestState = (u.cargo ?? 0) > 0 ? 'returning' : 'seeking';
  u.harvestTimer = 0;

  // Where the shot came from, in tiles, when the sim knows.
  let attacker: TilePos | undefined;
  if (sourceId !== undefined) {
    const au = findUnit(state, sourceId);
    if (au) attacker = { tx: worldToTile(au.pos.x), ty: worldToTile(au.pos.y) };
    else {
      const ab = findBuilding(state, sourceId);
      if (ab) attacker = { tx: ab.tx, ty: ab.ty };
    }
  }

  const home = nearestHome(state, u);
  clearOrder(u);
  let dest: TilePos | null = null;
  if (home) dest = dockTile(state, home, u);
  // "Run home" is no refuge when home is inside the attacker's reach (a field
  // raided right next to its own refinery) — then run AWAY from the shooter.
  const tooClose =
    attacker && dest && Math.hypot(dest.tx - attacker.tx, dest.ty - attacker.ty) < FLEE_MIN_GAP;
  if (attacker && (tooClose || !dest)) {
    const ux = worldToTile(u.pos.x);
    const uy = worldToTile(u.pos.y);
    const dx = ux - attacker.tx;
    const dy = uy - attacker.ty;
    const len = Math.hypot(dx, dy) || 1;
    const away = findNearestPassable(
      state.map,
      Math.max(0, Math.min(state.map.w - 1, Math.round(ux + (dx / len) * FLEE_AWAY_TILES))),
      Math.max(0, Math.min(state.map.h - 1, Math.round(uy + (dy / len) * FLEE_AWAY_TILES))),
      6,
    );
    if (away) dest = away;
  }
  if (dest) {
    u.order = {
      kind: 'move',
      tile: { tx: dest.tx, ty: dest.ty },
      target: { x: tileCenter(dest.tx), y: tileCenter(dest.ty) },
      // Self-issued: not a player order, so it never re-anchors anything.
      auto: true,
    };
  }
  if (u.player === PLAYER_HUMAN) postMessage(state, 'Harvester under attack', 'alert');
}

/**
 * A player order took this harvester off its cycle. The field/refinery bond is
 * dropped and the danger hold is armed, so the harvester idles where it was
 * sent and then re-acquires from its NEW position instead of walking straight
 * back to the tile the player just pulled it away from.
 */
export function releaseHarvester(state: GameState, u: Unit): void {
  if (UNIT_TYPES[u.type].kind !== 'harvester') return;
  u.harvestTile = undefined;
  u.refineryId = undefined;
  u.harvestTimer = 0;
  u.dangerTile = { tx: worldToTile(u.pos.x), ty: worldToTile(u.pos.y) };
  u.dangerHoldUntil = state.tick + DANGER_HOLD_TICKS;
  // Always 'seeking': the hold suppresses seeking, so the harvester goes idle
  // at the destination the player picked rather than resuming a delivery run.
  u.harvestState = 'seeking';
}

/** Passable tile touching a building's footprint, nearest to the harvester. */
export function dockTile(state: GameState, b: Building, u: Unit): TilePos | null {
  const map = state.map;
  let best: TilePos | null = null;
  let bestD = Infinity;
  const consider = (tx: number, ty: number): void => {
    if (!inBounds(tx, ty) || !isPassable(map, tx, ty)) return;
    const d = Math.hypot(tileCenter(tx) - u.pos.x, tileCenter(ty) - u.pos.y);
    if (d < bestD) {
      bestD = d;
      best = { tx, ty };
    }
  };
  for (let x = b.tx - 1; x <= b.tx + b.w; x++) {
    consider(x, b.ty - 1);
    consider(x, b.ty + b.h);
  }
  for (let y = b.ty; y < b.ty + b.h; y++) {
    consider(b.tx - 1, y);
    consider(b.tx + b.w, y);
  }
  return best;
}

// --- system -----------------------------------------------------------------

export function updateHarvest(state: GameState): void {
  for (const u of state.units) {
    if (u.dead) continue;
    if (UNIT_TYPES[u.type].kind !== 'harvester') continue;
    stepHarvester(state, u);
  }
}

function stepHarvester(state: GameState, u: Unit): void {
  if (u.cargo === undefined) u.cargo = 0;
  if (u.harvestState === undefined) u.harvestState = 'seeking';
  const cap = capacityOf(u);

  const order = u.order;
  if (order) {
    if (order.kind === 'harvest') {
      // Explicit "go work this field" order.
      const hint = order.tile ??
        (order.target
          ? { tx: worldToTile(order.target.x), ty: worldToTile(order.target.y) }
          : { tx: worldToTile(u.pos.x), ty: worldToTile(u.pos.y) });
      const tile = nearestCrystalTile(state, hint.tx, hint.ty);
      clearOrder(u);
      if (tile) u.harvestTile = { tx: tile.tx, ty: tile.ty };
      u.harvestTimer = 0;
      u.harvestState = u.cargo >= cap ? 'returning' : 'seeking';
    } else if (order.kind === 'deliver') {
      const hint = order.tile ??
        (order.target
          ? { tx: worldToTile(order.target.x), ty: worldToTile(order.target.y) }
          : undefined);
      clearOrder(u);
      const ref =
        order.targetId !== undefined
          ? state.buildings.find(
              (b) => b.id === order.targetId && !b.dead && b.type === 'refinery',
            )
          : refineryNear(state, u, hint);
      if (ref) u.refineryId = ref.id;
      u.harvestTimer = 0;
      u.harvestState = 'returning';
    } else {
      // A player move/attack-move order is in flight: stand down until it ends.
      if (u.harvestState === 'harvesting' || u.harvestState === 'unloading') {
        u.harvestState = u.cargo >= cap ? 'returning' : 'seeking';
      }
      return;
    }
  }

  // Danger hold: the harvester was shot at (or pulled off the cycle by the
  // player) and will not go back into a field for a while. Delivery legs are
  // deliberately still allowed — a load already aboard is banked instead of
  // being carried around for 12 seconds.
  if (onDangerHold(state, u)) {
    if (u.harvestState === 'harvesting') u.harvestState = 'seeking';
    if (u.harvestState === 'seeking') {
      if ((u.cargo ?? 0) >= cap) u.harvestState = 'returning';
      else return; // park
    }
  }

  switch (u.harvestState) {
    case 'seeking':
      stepSeeking(state, u, cap);
      break;
    case 'harvesting':
      stepHarvesting(state, u, cap);
      break;
    case 'returning':
      stepReturning(state, u);
      break;
    case 'unloading':
      stepUnloading(state, u);
      break;
    default:
      u.harvestState = 'seeking';
      break;
  }
}

/** Refinery nearest to a hint tile (falls back to nearest to the harvester). */
function refineryNear(
  state: GameState,
  u: Unit,
  hint: TilePos | undefined,
): Building | undefined {
  if (!hint) return nearestRefinery(state, u);
  const hx = tileCenter(hint.tx);
  const hy = tileCenter(hint.ty);
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of state.buildings) {
    if (b.dead || b.player !== u.player || b.type !== 'refinery') continue;
    if (b.status !== 'ready') continue;
    const d = distanceToBuilding(hx, hy, b);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best ?? nearestRefinery(state, u);
}

function stepSeeking(state: GameState, u: Unit, cap: number): void {
  if ((u.cargo ?? 0) >= cap) {
    u.harvestState = 'returning';
    u.harvestTimer = 0;
    return;
  }

  const danger = u.dangerTile;
  let tile = u.harvestTile;
  // A remembered tile inside the danger zone is thrown away along with the
  // spent ones: that is the "I moved you and you walked straight back" fix.
  const unsafe =
    tile !== undefined && danger !== undefined && tileDistance(tile, danger) < SAFE_FIELD_TILES;

  if (!tile || unsafe || crystalAt(state.map, tile.tx, tile.ty) <= 0) {
    if ((u.harvestTimer ?? 0) > 0) {
      u.harvestTimer = (u.harvestTimer ?? 0) - 1;
      return;
    }
    // Search out from the last worked tile so the harvester stays in its field
    // — unless it has been scared off one, in which case the anchor is where it
    // is standing NOW, so it resumes near wherever it ended up.
    const here = { tx: worldToTile(u.pos.x), ty: worldToTile(u.pos.y) };
    const from = danger ? here : (tile ?? here);
    let found = danger
      ? nearestCrystalTile(state, from.tx, from.ty, CRYSTAL_SEARCH_RADIUS, danger, SAFE_FIELD_TILES)
      : null;
    // Nothing far enough away has crystal: take the nearest field anyway. The
    // economy stalling for good is strictly worse than one risky trip.
    if (!found) found = nearestCrystalTile(state, from.tx, from.ty);
    if (found && danger) {
      // Either we found somewhere safe or we accepted the risk; either way the
      // memory has done its job and is cleared, so the harvester is not barred
      // from that whole quarter of the map for the rest of the mission.
      u.dangerTile = undefined;
    }
    if (!found) {
      u.harvestTimer = RETRY_DELAY;
      u.harvestTile = undefined;
      if ((u.cargo ?? 0) > 0) u.harvestState = 'returning';
      else if (u.player === PLAYER_HUMAN) postMessage(state, 'No crystal in range', 'warning');
      return;
    }
    tile = { tx: found.tx, ty: found.ty };
    u.harvestTile = tile;
  }

  if (distToTile(u, tile) <= GATHER_RANGE) {
    u.harvestState = 'harvesting';
    u.harvestTimer = 0;
    return;
  }
  issueMoveTo(u, tile.tx, tile.ty);
}

function stepHarvesting(state: GameState, u: Unit, cap: number): void {
  const tile = u.harvestTile;
  if (!tile) {
    u.harvestState = 'seeking';
    return;
  }
  if (crystalAt(state.map, tile.tx, tile.ty) <= 0) {
    u.harvestState = (u.cargo ?? 0) >= cap ? 'returning' : 'seeking';
    return;
  }
  if (distToTile(u, tile) > GATHER_LEASH) {
    // Shoved off the tile (separation / traffic) — walk back onto it.
    u.harvestState = 'seeking';
    return;
  }

  const timer = u.harvestTimer ?? 0;
  if (timer > 0) {
    u.harvestTimer = timer - 1;
    return;
  }
  u.harvestTimer = GATHER_INTERVAL;

  const want = Math.min(HARVEST_RATE, cap - (u.cargo ?? 0));
  if (want <= 0) {
    u.harvestState = 'returning';
    return;
  }
  const { taken, terrainChanged } = depleteCrystal(state.map, tile.tx, tile.ty, want);
  u.cargo = (u.cargo ?? 0) + taken;
  if (terrainChanged) markMapTileDirty(state, tile.tx, tile.ty);

  if ((u.cargo ?? 0) >= cap) {
    u.harvestState = 'returning';
    u.harvestTimer = 0;
  } else if (taken <= 0 || crystalAt(state.map, tile.tx, tile.ty) <= 0) {
    // Tile is spent: keep it as the search anchor and hop to the next one.
    u.harvestState = 'seeking';
    u.harvestTimer = 0;
  }
}

function stepReturning(state: GameState, u: Unit): void {
  let ref: Building | undefined;
  if (u.refineryId !== undefined) {
    ref = state.buildings.find(
      (b) =>
        b.id === u.refineryId &&
        !b.dead &&
        b.type === 'refinery' &&
        b.player === u.player &&
        b.status === 'ready',
    );
  }
  if (!ref) ref = nearestRefinery(state, u);

  if (!ref) {
    if ((u.harvestTimer ?? 0) > 0) {
      u.harvestTimer = (u.harvestTimer ?? 0) - 1;
      return;
    }
    u.harvestTimer = RETRY_DELAY;
    u.refineryId = undefined;
    if (u.player === PLAYER_HUMAN) postMessage(state, 'Refinery needed', 'warning');
    return;
  }

  u.refineryId = ref.id;
  if (distanceToBuilding(u.pos.x, u.pos.y, ref) <= DOCK_RANGE) {
    u.harvestState = 'unloading';
    u.harvestTimer = 0;
    return;
  }
  const dock = dockTile(state, ref, u);
  if (dock) issueMoveTo(u, dock.tx, dock.ty);
}

function stepUnloading(state: GameState, u: Unit): void {
  if ((u.cargo ?? 0) <= 0) {
    u.cargo = 0;
    u.harvestState = 'seeking';
    u.harvestTimer = 0;
    return;
  }
  // The owner test matters as of the capture feature: a refinery taken by an
  // enemy engineer must stop accepting the previous owner's loads. (Capture
  // also unbonds every harvester on the spot; this is the second half of it.)
  const ref = state.buildings.find(
    (b) => b.id === u.refineryId && !b.dead && b.player === u.player && b.status === 'ready',
  );
  if (!ref) {
    u.harvestState = 'returning';
    return;
  }

  const step = Math.min(u.cargo ?? 0, UNLOAD_PER_TICK);
  u.cargo = (u.cargo ?? 0) - step;

  const p = state.players[u.player];
  const room = Math.max(0, p.storage - p.credits);
  const gained = Math.min(step, room);
  p.credits += gained;
  if (gained < step && u.player === PLAYER_HUMAN) {
    postMessage(state, 'Silos needed', 'warning');
  }

  if ((u.cargo ?? 0) <= 0) {
    u.cargo = 0;
    u.harvestState = 'seeking';
    u.harvestTimer = 0;
  }
}
