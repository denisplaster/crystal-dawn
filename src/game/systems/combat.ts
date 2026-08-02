/**
 * Combat — target acquisition, weapons, projectiles, damage and death.
 *
 * Runs after `production`, so anything built this tick can already be shot at,
 * and after `movement`, so a unit that arrived this tick engages immediately.
 *
 * How a unit decides what to do (see `stepUnitCombat`):
 *
 *   commanded attack   `order.kind === 'attack'` with a `targetId` and no
 *                      `auto` flag. Mobile shooters pursue for as long as the
 *                      target lives; the pursuit itself is a `move` order that
 *                      carries `targetId`, so the ordinary movement system does
 *                      the driving and combat only flips the order back to
 *                      `attack` when the target comes into range.
 *   attack-move        the unit advances under its own `attackMove` order until
 *                      something enemy comes inside weapon range. Combat then
 *                      pushes the attack-move back onto the order queue and
 *                      installs an `auto` attack order, which parks the unit
 *                      while it fires. When the target dies (or breaks the
 *                      leash) the queued attack-move is popped and the advance
 *                      resumes.
 *   idle / guard       fires at anything that wanders into weapon range, never
 *                      chases and never takes an order — so the harvest system
 *                      keeps seeing an idle harvester escort, and a player's
 *                      order is never overwritten.
 *
 * Projectiles: `bullet` and `shell` are direct-fire and always connect with the
 * entity they were fired at (weapon inaccuracy only moves the *impact point*,
 * which matters for splash); `rocket` steers toward its target at a limited
 * turn rate; `arc` (artillery) has no target entity at all — it lands at the
 * aimed point and splashes whatever is standing there, friendly units included.
 */

import {
  PLAYER_HUMAN,
  TILE,
  WORLD_H,
  WORLD_W,
  clamp,
  tileCenter,
  worldToTile,
  type PlayerId,
} from '../constants';
import { isPassable } from '../map';
import { findNearestPassable } from '../pathfinding';
import {
  BUILDING_TYPES,
  UNIT_TYPES,
  WARHEADS,
  WEAPONS,
  damageAgainst,
  type ArmorClass,
  type Weapon,
  type WeaponId,
} from '../rules';
import {
  markMapRectDirty,
  nextEntityId,
  setFootprintOccupied,
  stanceOf,
  type Building,
  type Effect,
  type GameState,
  type Order,
  type Projectile,
  type Unit,
  type Vec2,
} from '../state';
// harvest.ts does not import combat.ts, so this is a plain one-way dependency.
import { harvesterUnderFire } from './harvest';
// air.ts imports nothing from here either: another one-way dependency.
import { isOutOfAmmo, spendAmmo, usesAmmo } from './air';

// --- tunables ---------------------------------------------------------------

/** Ticks between target scans for an entity that has no target. */
const ACQUIRE_INTERVAL = 5;
/** Extra tiles an attack-moving unit looks beyond its weapon range. */
const ACQUIRE_BONUS = 2;
/** Tiles past weapon range before an auto-acquired target is let go. */
const LEASH = 2.5;
/** Turret traverse in radians per tick. */
const TURRET_TURN_RATE = 0.22;
/** How closely a turret/hull must point at the target before it may fire. */
const AIM_TOLERANCE = 0.14;
/** Pursuit converts back to "stand and shoot" at this fraction of range. */
const ENGAGE_FRACTION = 0.92;
/** Pursuit goal is refreshed once the target has drifted this far (px). */
const PURSUIT_SLACK = TILE * 1.5;

/** Scoring weights: armed units are the juicier target, structures the least. */
const PRIORITY_ARMED = 0.78;
const PRIORITY_SOFT = 1;
const PRIORITY_BUILDING = 1.35;

/** Spatial-hash cell size for target lookup, in world px. */
const HASH_CELL = TILE * 4;

/** Ticks between repeats of the same EVA line. */
const EVA_LOSS_THROTTLE = 60;
const EVA_ATTACK_THROTTLE = 300; // 15s
const EVA_FLEE_THROTTLE = 60; // 3s

// --- stance tunables (post-release) -----------------------------------------

/**
 * Defensive: how far from its held position a unit will drift to bring an
 * enemy into weapon range. It walks back the moment it has nothing to shoot.
 */
const DEFENSIVE_LEASH = TILE * 1.5;
/**
 * Close enough to the held position to count as "back on post". Comfortably
 * above the movement system's own arrival tolerance (~7px), so a unit that has
 * just walked home does not immediately re-issue the walk.
 */
const HOLD_SETTLE = TILE * 0.5;
/** Explore: how far a damaged unit runs from whatever hit it. */
const FLEE_DISTANCE = TILE * 10;
/** Explore: ticks before a fleeing unit re-plans its escape. */
const FLEE_REISSUE = 20;

/** Hard cap on the decoration list. */
const MAX_EFFECTS = 192;

// --- entity helpers ---------------------------------------------------------

export type Combatant = Unit | Building;

export function isUnitEntity(e: Combatant): e is Unit {
  return (e as Unit).pos !== undefined;
}

export function entityCenterX(e: Combatant): number {
  return isUnitEntity(e) ? e.pos.x : tileCenter(e.tx) + ((e.w - 1) * TILE) / 2;
}

export function entityCenterY(e: Combatant): number {
  return isUnitEntity(e) ? e.pos.y : tileCenter(e.ty) + ((e.h - 1) * TILE) / 2;
}

export function armorOf(e: Combatant): ArmorClass {
  return isUnitEntity(e) ? UNIT_TYPES[e.type].armor : BUILDING_TYPES[e.type].armor;
}

/** The weapon this entity fires, or null. Unpowered defences have none. */
export function weaponOf(state: GameState, e: Combatant): Weapon | null {
  if (isUnitEntity(e)) {
    const id = UNIT_TYPES[e.type].weapon;
    return id ? WEAPONS[id] : null;
  }
  const id = BUILDING_TYPES[e.type].weapon;
  if (!id) return null;
  // Only a finished structure fires: one still going up, or one the owner has
  // already sold and is dismantling, is inert.
  if (e.status !== 'ready') return null;
  // A defensive structure is offline while its owner is in power deficit.
  if (state.players[e.player].lowPower) return null;
  return WEAPONS[id];
}

/**
 * V2: is this entity flying? Structures never are, so the whole air/ground
 * split reduces to one flag on the unit type — no type-name checks anywhere.
 */
export function isAirEntity(e: Combatant): boolean {
  return isUnitEntity(e) && UNIT_TYPES[e.type].isAir;
}

/**
 * V2: may this weapon engage that target at all? The rule is symmetric by
 * construction — a tank cannot acquire a gunship *and* its shells cannot hurt
 * one, because both paths ask this same question.
 */
export function canWeaponHit(weapon: Weapon, target: Combatant): boolean {
  return weapon.targetsAir || !isAirEntity(target);
}

/** Damage multiplier this weapon suffers against that target (air penalty). */
function airFactor(weapon: Weapon, target: Combatant): number {
  return isAirEntity(target) ? weapon.vsAirScale : 1;
}

/** Distance from a world point to an entity (footprint edge for structures). */
export function distanceToEntity(x: number, y: number, e: Combatant): number {
  if (isUnitEntity(e)) return Math.hypot(e.pos.x - x, e.pos.y - y);
  const x0 = e.tx * TILE;
  const y0 = e.ty * TILE;
  const x1 = x0 + e.w * TILE;
  const y1 = y0 + e.h * TILE;
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
  const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
  return Math.hypot(dx, dy);
}

/** Living entity with this id, or undefined. */
export function findCombatant(state: GameState, id: number): Combatant | undefined {
  for (const u of state.units) if (u.id === id && !u.dead) return u;
  for (const b of state.buildings) if (b.id === id && !b.dead) return b;
  return undefined;
}

function normalizeAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

// --- EVA --------------------------------------------------------------------

/**
 * Post a line at most once per `window` ticks (scans the ticker backlog).
 * Exported for `systems/capture.ts`, which needs the same throttle for its own
 * "Structure captured" / "Structure lost" pair.
 */
export function postThrottled(
  state: GameState,
  text: string,
  kind: 'info' | 'warning' | 'alert',
  window: number,
): void {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i] as { text: string; tick: number };
    if (state.tick - m.tick > window) break;
    if (m.text === text) return;
  }
  state.messages.push({ text, tick: state.tick, kind });
  if (state.messages.length > 64) state.messages.shift();
}

// --- effects ----------------------------------------------------------------

function addEffect(state: GameState, e: Effect): void {
  state.effects.push(e);
  if (state.effects.length > MAX_EFFECTS) state.effects.shift();
}

// --- spatial index ----------------------------------------------------------

interface TargetIndex {
  cells: Map<number, Combatant[]>;
}

function cellKey(cx: number, cy: number): number {
  return ((cy & 0xffff) << 16) | (cx & 0xffff);
}

function buildIndex(state: GameState): TargetIndex {
  const cells = new Map<number, Combatant[]>();
  const push = (x: number, y: number, e: Combatant): void => {
    const key = cellKey(Math.floor(x / HASH_CELL), Math.floor(y / HASH_CELL));
    const list = cells.get(key);
    if (list) list.push(e);
    else cells.set(key, [e]);
  };
  for (const u of state.units) {
    if (u.dead) continue;
    push(u.pos.x, u.pos.y, u);
  }
  for (const b of state.buildings) {
    if (b.dead) continue;
    // Structures span several cells; register every one so a shooter parked
    // next to a big footprint still finds it.
    for (let ty = b.ty; ty < b.ty + b.h; ty++) {
      for (let tx = b.tx; tx < b.tx + b.w; tx++) {
        const key = cellKey(
          Math.floor((tx * TILE) / HASH_CELL),
          Math.floor((ty * TILE) / HASH_CELL),
        );
        const list = cells.get(key);
        if (list) {
          if (list[list.length - 1] !== b) list.push(b);
        } else cells.set(key, [b]);
      }
    }
  }
  return { cells };
}

/**
 * Best enemy target for `shooter` within `rangePx`, or undefined. Nearest wins,
 * with a slight preference for armed units over harvesters and structures.
 */
function acquireTarget(
  state: GameState,
  index: TargetIndex,
  shooter: Combatant,
  rangePx: number,
  weapon: Weapon,
): Combatant | undefined {
  const x = entityCenterX(shooter);
  const y = entityCenterY(shooter);
  const c0 = Math.floor((x - rangePx) / HASH_CELL);
  const c1 = Math.floor((x + rangePx) / HASH_CELL);
  const r0 = Math.floor((y - rangePx) / HASH_CELL);
  const r1 = Math.floor((y + rangePx) / HASH_CELL);

  let best: Combatant | undefined;
  let bestScore = Infinity;
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      const list = index.cells.get(cellKey(cx, cy));
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const t = list[i] as Combatant;
        if (t.dead || t.player === shooter.player) continue;
        // A weapon that cannot reach the air never even sees an aircraft.
        if (!canWeaponHit(weapon, t)) continue;
        const d = distanceToEntity(x, y, t);
        if (d > rangePx) continue;
        let weight = PRIORITY_SOFT;
        if (isUnitEntity(t)) {
          if (UNIT_TYPES[t.type].weapon) weight = PRIORITY_ARMED;
        } else {
          weight = PRIORITY_BUILDING;
        }
        const score = d * weight;
        // Stable tie-break by id so the sim stays deterministic.
        if (score < bestScore || (score === bestScore && best && t.id < best.id)) {
          bestScore = score;
          best = t;
        }
      }
    }
  }
  return best;
}

// --- order plumbing ---------------------------------------------------------

function clearNav(u: Unit): void {
  u.path = undefined;
  u.pathIndex = undefined;
  u.goal = undefined;
  u.repathAt = undefined;
  u.blockedTicks = 0;
}

/** Finish the current order and pull the next queued one (mirrors movement). */
function completeOrder(u: Unit): void {
  clearNav(u);
  const queue = u.orderQueue;
  u.order = queue && queue.length > 0 ? queue.shift() : undefined;
}

/** Point a pursuit `move` order at the target's current position. */
function aimPursuit(order: Order, target: Combatant): void {
  const x = entityCenterX(target);
  const y = entityCenterY(target);
  order.target = { x, y };
  order.tile = { tx: worldToTile(x), ty: worldToTile(y) };
}

// --- stance plumbing --------------------------------------------------------

/**
 * A self-issued errand: the leashed step a defensive unit takes to lean out or
 * to walk back to its post, and the explore stance's retreat. It is a plain
 * `move` order carrying `auto: true` and *no* `targetId`, which distinguishes
 * it from a commanded pursuit (`move` + `targetId`, handled in section 2) and
 * from a player order (no `auto`, and `assignOrder` clears `holdPos`).
 */
function isSelfErrand(u: Unit): boolean {
  const o = u.order;
  return o !== undefined && o.kind === 'move' && o.auto === true && o.targetId === undefined;
}

/** A refreshed errand within this many px of the live one is not re-issued. */
const ERRAND_SLACK = 6;

/**
 * Issue (or refresh) a self errand toward a world point. The order carries the
 * *exact* point as its target (so the unit lands on its post rather than on the
 * nearest tile centre) and the tile only as the pathfinding goal; a point on
 * impassable ground falls back to the nearest open tile's centre.
 */
function issueErrand(state: GameState, u: Unit, wx: number, wy: number): void {
  let x = clamp(wx, TILE * 0.5, WORLD_W - TILE * 0.5);
  let y = clamp(wy, TILE * 0.5, WORLD_H - TILE * 0.5);
  let tx = worldToTile(x);
  let ty = worldToTile(y);
  if (!isPassable(state.map, tx, ty)) {
    const alt = findNearestPassable(state.map, tx, ty, 12);
    if (!alt) return;
    tx = alt.tx;
    ty = alt.ty;
    x = tileCenter(tx);
    y = tileCenter(ty);
  }
  const cur = u.order;
  // Already walking there: leave the path alone rather than repathing per tick.
  if (
    isSelfErrand(u) &&
    cur &&
    cur.target &&
    Math.hypot(cur.target.x - x, cur.target.y - y) <= ERRAND_SLACK
  ) {
    return;
  }
  u.order = {
    kind: 'move',
    tile: { tx, ty },
    target: { x, y },
    auto: true,
  };
  u.orderQueue = [];
  clearNav(u);
}

/** Drop a self errand and stand still. */
function endErrand(u: Unit): void {
  if (!isSelfErrand(u)) return;
  u.order = undefined;
  clearNav(u);
  u.vel.x = 0;
  u.vel.y = 0;
}

/**
 * Defensive stance, no player order in flight. The unit may step at most
 * `DEFENSIVE_LEASH` from `holdPos` to bring `target` into range, and walks back
 * to `holdPos` when it has nothing to shoot. It never chases.
 */
function stepDefensiveHold(
  state: GameState,
  u: Unit,
  hold: Vec2,
  target: Combatant | undefined,
  rangePx: number,
): void {
  if (!target) {
    const back = Math.hypot(u.pos.x - hold.x, u.pos.y - hold.y);
    if (back > HOLD_SETTLE) issueErrand(state, u, hold.x, hold.y);
    else endErrand(u);
    return;
  }

  const tx = entityCenterX(target);
  const ty = entityCenterY(target);
  const dx = tx - hold.x;
  const dy = ty - hold.y;
  const fromHold = Math.hypot(dx, dy);
  // How far past the post we would have to lean to put the target in range.
  const need = fromHold - rangePx * ENGAGE_FRACTION;
  if (need <= 0 || fromHold < 1e-6) {
    // In range from the post itself: stand on it.
    const back = Math.hypot(u.pos.x - hold.x, u.pos.y - hold.y);
    if (back > HOLD_SETTLE) issueErrand(state, u, hold.x, hold.y);
    else endErrand(u);
    return;
  }
  if (need > DEFENSIVE_LEASH) {
    // Out of reach without breaking the leash — let it go and hold the post.
    u.targetId = undefined;
    const back = Math.hypot(u.pos.x - hold.x, u.pos.y - hold.y);
    if (back > HOLD_SETTLE) issueErrand(state, u, hold.x, hold.y);
    else endErrand(u);
    return;
  }
  const step = Math.min(need, DEFENSIVE_LEASH) / fromHold;
  issueErrand(state, u, hold.x + dx * step, hold.y + dy * step);
}

/** Nearest own living structure — the fallback bolt-hole for an unattributed hit. */
function nearestOwnBuilding(state: GameState, u: Unit): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of state.buildings) {
    if (b.dead || b.player !== u.player) continue;
    const d = distanceToEntity(u.pos.x, u.pos.y, b);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * Explore stance: run `FLEE_DISTANCE` directly away from whatever hit us,
 * cancelling the current move order. The destination is clamped into the world
 * and onto passable ground through the existing pathfinding fallback.
 */
function fleeFrom(state: GameState, u: Unit, attacker: Combatant | undefined): void {
  let dx: number;
  let dy: number;
  if (attacker) {
    dx = u.pos.x - entityCenterX(attacker);
    dy = u.pos.y - entityCenterY(attacker);
  } else {
    // No attributable shooter (splash from a dead firer, or the debug hook):
    // fall back to running home instead of picking a direction out of nothing.
    const home = nearestOwnBuilding(state, u);
    dx = home ? entityCenterX(home) - u.pos.x : 0;
    dy = home ? entityCenterY(home) - u.pos.y : 0;
  }
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) {
    dx = 1;
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  u.targetId = undefined;
  // Force a fresh errand even if one is already in flight toward another tile.
  if (isSelfErrand(u)) u.order = undefined;
  issueErrand(state, u, u.pos.x + dx * FLEE_DISTANCE, u.pos.y + dy * FLEE_DISTANCE);
}

/**
 * Something just damaged this unit. Two hardwired reflexes hang off this:
 * harvester self-preservation (every player), and the explore stance's retreat
 * (human only in practice — the AI never sets a stance).
 */
function reactToDamage(state: GameState, u: Unit, sourceId?: number): void {
  if (UNIT_TYPES[u.type].kind === 'harvester') {
    harvesterUnderFire(state, u, sourceId);
    return;
  }
  if (stanceOf(u) !== 'explore') return;

  // Player intent wins: a unit that was explicitly told to attack something
  // (or is closing on it) keeps its order and fights.
  const o = u.order;
  if (o && ((o.kind === 'attack' && !o.auto) || (o.kind === 'move' && o.targetId !== undefined))) {
    return;
  }

  if (state.tick < (u.fleeAt ?? 0)) return;
  u.fleeAt = state.tick + FLEE_REISSUE;
  fleeFrom(state, u, sourceId !== undefined ? findCombatant(state, sourceId) : undefined);
  if (u.player === PLAYER_HUMAN) {
    postThrottled(state, 'Unit falling back', 'warning', EVA_FLEE_THROTTLE);
  }
}

/**
 * Issue a commanded attack. Armed units get an `attack` order; unarmed ones
 * (engineers, harvesters) are simply sent to the target's position so a mixed
 * selection still behaves sensibly. Exported for the debug hook and for the
 * Phase 5 AI.
 */
export function issueAttackOrder(
  state: GameState,
  units: Unit[],
  targetId: number,
  queued = false,
): number {
  const target = findCombatant(state, targetId);
  if (!target) return 0;
  let count = 0;
  for (const u of units) {
    if (u.dead || u.id === targetId) continue;
    // V2: "armed" means *armed against this target*. A unit whose weapon cannot
    // reach the air is treated exactly like an engineer ordered onto a tank —
    // it drives to the spot instead of being handed an order it cannot execute.
    const weaponId = UNIT_TYPES[u.type].weapon;
    const armed = weaponId !== null && canWeaponHit(WEAPONS[weaponId], target);
    const order: Order = armed
      ? { kind: 'attack', targetId, queued }
      : {
          kind: 'move',
          target: { x: entityCenterX(target), y: entityCenterY(target) },
          tile: { tx: worldToTile(entityCenterX(target)), ty: worldToTile(entityCenterY(target)) },
          queued,
        };
    if (queued && u.order) {
      (u.orderQueue ??= []).push(order);
    } else {
      u.order = order;
      u.orderQueue = [];
      clearNav(u);
      // An externally issued order releases the defensive anchor; the unit
      // re-anchors wherever it settles once the order is done. It also drops a
      // pending capture: an engineer told to go somewhere stops walking in.
      u.holdPos = undefined;
      u.captureId = undefined;
      if (armed) u.targetId = targetId;
    }
    count++;
  }
  return count;
}

// --- damage / death ---------------------------------------------------------

/**
 * Apply already-multiplied damage to an entity, posting the human's EVA lines
 * and killing it when it runs out of hp.
 *
 * `sourceId` is the entity that fired (post-release, optional): it is what the
 * explore stance runs *away* from, and it is passed straight through from the
 * projectile's `sourceId`. An unattributed hit still triggers the reflex, it
 * just has to guess a direction (see `fleeFrom`).
 *
 * `sourcePlayer` is the *house* that fired, carried alongside `sourceId` for the
 * match statistics. It is deliberately a separate argument rather than something
 * derived from `sourceId`: the firer may already be dead (or gone) by the time
 * its round lands, and resolving an id would cost an entity scan per hit.
 * `Projectile.player` already holds exactly this value, so every real shot has
 * it and only test helpers arrive unattributed.
 */
export function damageEntity(
  state: GameState,
  e: Combatant,
  amount: number,
  sourceId?: number,
  sourcePlayer?: PlayerId,
): void {
  if (e.dead || amount <= 0) return;
  e.hp -= amount;
  if (!isUnitEntity(e) && e.player === PLAYER_HUMAN && e.hp > 0) {
    postThrottled(state, 'Base under attack', 'alert', EVA_ATTACK_THROTTLE);
  }
  if (e.hp <= 0) {
    killEntity(state, e, false, sourcePlayer);
    return;
  }
  if (isUnitEntity(e)) reactToDamage(state, e, sourceId);
}

/**
 * Mark an entity dead. It stays in the arrays until `removeDead` runs at the
 * end of the tick so that everything holding an id this tick can still resolve
 * it. Structures give their footprint back immediately — the map's `occupied`
 * grid is what pathfinding reads, and leaving it set would block the tiles
 * forever.
 *
 * `quiet` is the Phase 7 sell path: the same death (footprint released, rect
 * marked dirty, queue dropped) with no fireball and no "Structure lost" line —
 * the structure was dismantled, not blown up. V2 extends it to *units* for the
 * same reason: an engineer that captures a structure is consumed, not lost, so
 * it neither explodes nor posts "Unit lost".
 *
 * `sourcePlayer` is the house that killed it, used only for the match
 * statistics. Kill credit needs an attributable source of a *different* player:
 * a friendly-fire death (own artillery splash) is the victim's loss and nobody's
 * kill, and an unattributed death is a loss for the victim only. A `quiet` death
 * is neither a loss nor a kill — the thing was dismantled or consumed, not
 * destroyed (selling has `buildingsSold`, capture has `buildingsCaptured`).
 */
export function killEntity(
  state: GameState,
  e: Combatant,
  quiet = false,
  sourcePlayer?: PlayerId,
): void {
  if (e.dead) return;
  e.dead = true;
  e.hp = 0;

  if (!quiet) {
    const unit = isUnitEntity(e);
    const victim = state.stats[e.player];
    if (unit) victim.unitsLost++;
    else victim.buildingsLost++;
    if (sourcePlayer !== undefined && sourcePlayer !== e.player) {
      const killer = state.stats[sourcePlayer];
      if (unit) killer.unitsKilled++;
      else killer.buildingsRazed++;
    }
  }

  if (isUnitEntity(e)) {
    e.order = undefined;
    e.orderQueue = [];
    e.targetId = undefined;
    clearNav(e);
    e.vel.x = 0;
    e.vel.y = 0;
    if (quiet) return;
    addEffect(state, {
      kind: 'explosion',
      x: e.pos.x,
      y: e.pos.y,
      size: UNIT_TYPES[e.type].radius + 8,
      startTick: state.tick,
      life: 12,
    });
    if (e.player === PLAYER_HUMAN) postThrottled(state, 'Unit lost', 'alert', EVA_LOSS_THROTTLE);
    return;
  }

  setFootprintOccupied(state, e, false);
  markMapRectDirty(state, e.tx, e.ty, e.w, e.h);
  e.queue = [];
  if (quiet) return;
  addEffect(state, {
    kind: 'explosion',
    x: entityCenterX(e),
    y: entityCenterY(e),
    size: Math.max(e.w, e.h) * TILE * 0.6,
    startTick: state.tick,
    life: 20,
  });
  if (e.player === PLAYER_HUMAN) postThrottled(state, 'Structure lost', 'alert', EVA_LOSS_THROTTLE);
}

/**
 * Splash damage around an impact point. Falls off linearly to zero at the edge
 * of the radius and hits *everything* in it, friend or foe, exactly like the
 * classic games. `exclude` is the entity that already took the direct hit.
 */
export function applySplash(
  state: GameState,
  x: number,
  y: number,
  damage: number,
  warhead: Weapon['warhead'],
  radius: number,
  exclude?: number,
  sourceId?: number,
  weaponId?: WeaponId,
  sourcePlayer?: PlayerId,
): void {
  if (radius <= 0) return;
  // V2: a burst only reaches the air if the weapon that produced it does. An
  // artillery shell landing under a gunship does nothing to it.
  const weapon = weaponId !== undefined ? WEAPONS[weaponId] : undefined;
  const hit = (e: Combatant): void => {
    if (e.dead || e.id === exclude) return;
    if (isAirEntity(e) && !(weapon?.targetsAir ?? false)) return;
    const d = distanceToEntity(x, y, e);
    if (d >= radius) return;
    const falloff = 1 - d / radius;
    const scale = weapon ? airFactor(weapon, e) : 1;
    damageEntity(
      state,
      e,
      damageAgainst(damage * falloff * scale, warhead, armorOf(e)),
      sourceId,
      sourcePlayer,
    );
  };
  // Small radii, so a straight scan beats maintaining another index.
  for (let i = state.units.length - 1; i >= 0; i--) hit(state.units[i] as Unit);
  for (let i = state.buildings.length - 1; i >= 0; i--) hit(state.buildings[i] as Building);
}

// --- firing -----------------------------------------------------------------

/**
 * C1: ticks a spent beam stays in `state.projectiles` purely so the renderer has
 * a line to draw. It carries `spent: true`, so it deals no further damage and
 * nothing can intercept it.
 */
export const BEAM_LIFE = 4;

function spawnProjectile(
  state: GameState,
  attacker: Combatant,
  target: Combatant,
  weapon: Weapon,
  facing: number,
): void {
  const wh = WARHEADS[weapon.warhead];
  const ax = entityCenterX(attacker);
  const ay = entityCenterY(attacker);
  const muzzle = isUnitEntity(attacker) ? UNIT_TYPES[attacker.type].radius + 2 : TILE * 0.4;
  const x = ax + Math.cos(facing) * muzzle;
  const y = ay + Math.sin(facing) * muzzle;

  // --- C1: beams are instant ------------------------------------------------
  // There is nothing in flight: the damage lands on this tick, at the target's
  // current position, and the round that goes into the array is a decoration
  // with a lifespan. `prev` is the muzzle and `pos` the impact, which is exactly
  // the line C2 draws.
  if (weapon.projectile === 'beam') {
    const bx = entityCenterX(target);
    const by = entityCenterY(target);
    const beam: Projectile = {
      id: nextEntityId(state),
      kind: 'beam',
      player: attacker.player,
      pos: { x: bx, y: by },
      prev: { x, y },
      vel: { x: 0, y: 0 },
      target: { x: bx, y: by },
      damage: weapon.damage,
      warhead: weapon.warhead,
      splash: wh.splash,
      life: BEAM_LIFE,
      sourceId: attacker.id,
      weapon: weapon.id,
      spent: true,
    };
    state.projectiles.push(beam);
    resolveHit(state, beam, target);
    addEffect(state, {
      kind: 'muzzle',
      x,
      y,
      size: weapon.damage >= 40 ? 9 : 6,
      startTick: state.tick,
      life: 3,
      facing,
      weapon: weapon.id,
    });
    return;
  }

  const spread = weapon.inaccuracy;
  const jitterX = spread > 0 ? state.rng.range(-spread, spread) : 0;
  const jitterY = spread > 0 ? state.rng.range(-spread, spread) : 0;
  const tx = entityCenterX(target) + jitterX;
  const ty = entityCenterY(target) + jitterY;

  const dist = Math.hypot(tx - x, ty - y);
  const speed = Math.max(1, weapon.speed);
  const dir = Math.atan2(ty - y, tx - x);
  const arcing = weapon.projectile === 'arc';

  const p: Projectile = {
    id: nextEntityId(state),
    kind: weapon.projectile,
    player: attacker.player,
    pos: { x, y },
    prev: { x, y },
    vel: { x: Math.cos(dir) * speed, y: Math.sin(dir) * speed },
    target: { x: tx, y: ty },
    damage: weapon.damage,
    warhead: weapon.warhead,
    splash: wh.splash,
    life: Math.ceil(dist / speed) + 30,
    sourceId: attacker.id,
    // V2: the round remembers what fired it, so the air rules survive the
    // flight (a shell that arrives where an aircraft now hovers still misses).
    weapon: weapon.id,
  };
  // Artillery is indirect fire: it commits to a *point*, so a target that
  // drives away is missed and whatever moved in is hit instead.
  if (!arcing) p.targetId = target.id;
  if (arcing) {
    p.arc = 0;
    p.travel = dist;
  }
  state.projectiles.push(p);

  addEffect(state, {
    kind: 'muzzle',
    x,
    y,
    size: weapon.damage >= 40 ? 9 : 6,
    startTick: state.tick,
    life: 3,
    facing,
    // Render-only tag: Phase 6's audio consumer picks the firing sound from it.
    weapon: weapon.id,
  });
}

/**
 * Aim and (if aligned and off cooldown) shoot. Turreted vehicles traverse their
 * turret first; non-turreted vehicles swing the hull; infantry and defensive
 * structures snap on and fire immediately.
 */
function tryFire(
  state: GameState,
  attacker: Combatant,
  target: Combatant,
  weapon: Weapon,
): void {
  const ax = entityCenterX(attacker);
  const ay = entityCenterY(attacker);
  const desired = Math.atan2(entityCenterY(target) - ay, entityCenterX(target) - ax);

  let facing = desired;
  if (isUnitEntity(attacker)) {
    const def = UNIT_TYPES[attacker.type];
    if (def.turret) {
      const cur = attacker.turretFacing ?? attacker.facing;
      const diff = normalizeAngle(desired - cur);
      attacker.turretFacing = normalizeAngle(
        cur + clamp(diff, -TURRET_TURN_RATE, TURRET_TURN_RATE),
      );
      facing = attacker.turretFacing;
      if (Math.abs(diff) > AIM_TOLERANCE) return; // still traversing
    } else if (def.kind === 'infantry') {
      attacker.facing = desired;
    } else {
      const diff = normalizeAngle(desired - attacker.facing);
      attacker.facing = normalizeAngle(attacker.facing + clamp(diff, -def.turnRate, def.turnRate));
      facing = attacker.facing;
      if (Math.abs(diff) > AIM_TOLERANCE) return;
    }
  } else {
    attacker.turretFacing = desired;
  }

  if ((attacker.cooldown ?? 0) > 0) return;
  spawnProjectile(state, attacker, target, weapon, facing);
  attacker.cooldown = weapon.cooldown;
  // V2: burn a round. No-op for every unlimited-ammo shooter, i.e. everything
  // except aircraft.
  if (isUnitEntity(attacker)) spendAmmo(attacker);
}

// --- per-entity step --------------------------------------------------------

function inMinRange(weapon: Weapon, d: number): boolean {
  return weapon.minRange > 0 && d < weapon.minRange * TILE;
}

function stepUnitCombat(state: GameState, index: TargetIndex, u: Unit): void {
  if ((u.cooldown ?? 0) > 0) u.cooldown = (u.cooldown as number) - 1;

  const weaponId = UNIT_TYPES[u.type].weapon;
  if (!weaponId) {
    u.targetId = undefined;
    return;
  }
  const weapon = WEAPONS[weaponId];
  const rangePx = weapon.range * TILE;
  const def = UNIT_TYPES[u.type];
  const order = u.order;

  // --- 0. V2: an empty pod cannot fight ------------------------------------
  // An aircraft out of rounds drops its target and any attack it was given, so
  // it goes *idle* — which is exactly the signal `updateAir` waits for before
  // flying it home to rearm. A commanded **move** is left alone: player intent
  // over a destination still wins, it just cannot shoot on the way.
  if (usesAmmo(u) && isOutOfAmmo(u)) {
    u.targetId = undefined;
    if (order && (order.kind === 'attack' || (order.kind === 'move' && order.targetId !== undefined))) {
      completeOrder(u);
    }
    return;
  }

  // --- 1. commanded / auto attack order ------------------------------------
  if (order && order.kind === 'attack') {
    if (order.targetId === undefined) {
      // An attack order with nothing to attack (e.g. issued by a test helper)
      // would otherwise wedge the unit forever.
      completeOrder(u);
      return;
    }
    // `canWeaponHit` here is what stops a tank chasing a gunship forever: an
    // attack order on something its gun cannot reach is dropped, not pursued.
    const t = findCombatant(state, order.targetId);
    if (!t || t.player === u.player || !canWeaponHit(weapon, t)) {
      u.targetId = undefined;
      completeOrder(u);
      return;
    }
    u.targetId = t.id;
    const d = distanceToEntity(u.pos.x, u.pos.y, t);
    if (d <= rangePx && !inMinRange(weapon, d)) {
      tryFire(state, u, t, weapon);
      return;
    }
    if (order.auto) {
      // Auto engagement: short leash, then go back to whatever we were doing.
      if (d > rangePx + LEASH * TILE) {
        u.targetId = undefined;
        completeOrder(u);
      }
      return;
    }
    if (def.speed > 0) {
      // Commanded: walk it down. The movement system drives the pursuit.
      u.order = { kind: 'move', targetId: t.id };
      aimPursuit(u.order, t);
      clearNav(u);
    }
    return;
  }

  // --- 2. pursuit move (a commanded attack that is closing) -----------------
  if (order && order.kind === 'move' && order.targetId !== undefined) {
    const t = findCombatant(state, order.targetId);
    if (!t || t.player === u.player || !canWeaponHit(weapon, t)) {
      u.targetId = undefined;
      completeOrder(u);
      return;
    }
    u.targetId = t.id;
    const d = distanceToEntity(u.pos.x, u.pos.y, t);
    if (d <= rangePx * ENGAGE_FRACTION && !inMinRange(weapon, d)) {
      u.order = { kind: 'attack', targetId: t.id };
      clearNav(u);
      tryFire(state, u, t, weapon);
      return;
    }
    // Follow a target that is running away.
    const goalX = order.target ? order.target.x : 0;
    const goalY = order.target ? order.target.y : 0;
    if (
      !order.target ||
      Math.hypot(entityCenterX(t) - goalX, entityCenterY(t) - goalY) > PURSUIT_SLACK
    ) {
      aimPursuit(order, t);
      clearNav(u);
    }
    return;
  }

  // --- 3. free fire: idle, guarding, moving or attack-moving ----------------
  const stance = stanceOf(u);

  // Explore never engages on its own: no acquisition, no attack-move
  // engagement, no return fire. Sections 1 and 2 above are the only way it ever
  // shoots, and both of those are explicit player orders.
  if (stance === 'explore') {
    u.targetId = undefined;
    return;
  }

  // A defensive unit is "on post" whenever nothing but its own errands are
  // driving it. A real order (move / attack / attack-move) overrides the leash
  // for as long as it is active.
  const onPost = stance === 'defensive' && (order === undefined || isSelfErrand(u));
  if (onPost && u.holdPos === undefined) u.holdPos = { x: u.pos.x, y: u.pos.y };

  let target: Combatant | undefined;
  if (u.targetId !== undefined) {
    const t = findCombatant(state, u.targetId);
    if (
      t &&
      t.player !== u.player &&
      canWeaponHit(weapon, t) &&
      distanceToEntity(u.pos.x, u.pos.y, t) <= rangePx + LEASH * TILE
    ) {
      target = t;
    }
  }
  const attackMoving = order !== undefined && order.kind === 'attackMove';
  if (!target && (state.tick + u.id) % ACQUIRE_INTERVAL === 0) {
    // A unit holding a post looks a little past its own weapon range, so it can
    // lean out (within the leash) instead of waiting to be shot first.
    const reach = attackMoving || onPost ? rangePx + ACQUIRE_BONUS * TILE : rangePx;
    target = acquireTarget(state, index, u, reach, weapon);
  }
  u.targetId = target?.id;
  if (!target) {
    if (onPost) stepDefensiveHold(state, u, u.holdPos as Vec2, undefined, rangePx);
    return;
  }

  const d = distanceToEntity(u.pos.x, u.pos.y, target);
  if (d > rangePx || inMinRange(weapon, d)) {
    // Out of range (or inside a minimum-range band): an ordinary unit just
    // keeps doing what it was doing; one on post leans out, leash permitting.
    if (onPost && !inMinRange(weapon, d)) {
      stepDefensiveHold(state, u, u.holdPos as Vec2, target, rangePx);
    }
    return;
  }
  // In range and on post: stop walking and shoot.
  if (onPost) endErrand(u);

  if (attackMoving && order) {
    // Stop and engage: the advance is parked on the queue and resumes when the
    // auto attack ends.
    (u.orderQueue ??= []).unshift(order);
    u.order = { kind: 'attack', targetId: target.id, auto: true };
    clearNav(u);
    u.vel.x = 0;
    u.vel.y = 0;
  }
  tryFire(state, u, target, weapon);
}

function stepBuildingCombat(state: GameState, index: TargetIndex, b: Building): void {
  if ((b.cooldown ?? 0) > 0) b.cooldown = (b.cooldown as number) - 1;
  const weapon = weaponOf(state, b);
  if (!weapon) {
    b.targetId = undefined;
    return;
  }
  const rangePx = weapon.range * TILE;

  let target: Combatant | undefined;
  if (b.targetId !== undefined) {
    const t = findCombatant(state, b.targetId);
    if (t && t.player !== b.player) {
      const d = distanceToEntity(entityCenterX(b), entityCenterY(b), t);
      if (d <= rangePx) target = t;
    }
  }
  if (!target && (state.tick + b.id) % ACQUIRE_INTERVAL === 0) {
    target = acquireTarget(state, index, b, rangePx, weapon);
  }
  b.targetId = target?.id;
  if (!target) return;
  tryFire(state, b, target, weapon);
}

// --- projectiles ------------------------------------------------------------

/**
 * Apply a round's damage (direct hit + splash) and spawn its impact effect.
 *
 * Split out of `detonate` for C1's beams: an instant-hit round resolves at the
 * moment it is fired and then *stays in the array* for a few ticks as a visual,
 * so it must not be marked dead here.
 */
function resolveHit(state: GameState, p: Projectile, direct?: Combatant): void {
  const warhead = p.warhead as Weapon['warhead'];
  const weapon = p.weapon !== undefined ? WEAPONS[p.weapon] : undefined;
  if (direct && (!isAirEntity(direct) || (weapon?.targetsAir ?? false))) {
    const scale = weapon ? airFactor(weapon, direct) : 1;
    damageEntity(
      state,
      direct,
      damageAgainst(p.damage * scale, warhead, armorOf(direct)),
      p.sourceId,
      p.player,
    );
  }
  if (p.splash > 0) {
    applySplash(
      state,
      p.pos.x,
      p.pos.y,
      p.damage,
      warhead,
      p.splash,
      direct?.id,
      p.sourceId,
      p.weapon,
      // Kill credit follows the *house* that fired, which the round carries
      // itself — so a shot still scores after its firer has died in flight.
      p.player,
    );
  }
  addEffect(state, {
    kind: 'explosion',
    x: p.pos.x,
    y: p.pos.y,
    size: p.splash > 0 ? Math.max(10, p.splash * 0.7) : 6,
    startTick: state.tick,
    life: p.splash > 0 ? 10 : 5,
  });
}

/** Resolve a round and retire it. Everything that flies ends here. */
function detonate(state: GameState, p: Projectile, direct?: Combatant): void {
  p.dead = true;
  resolveHit(state, p, direct);
}

/** Rocket steering, in radians per tick. */
const ROCKET_TURN = 0.16;

export function updateProjectiles(state: GameState): void {
  for (const p of state.projectiles) {
    if (p.dead) continue;

    // C1: a spent round (a beam that has already hit) is a decoration. It keeps
    // its muzzle -> impact line for the renderer and simply ages out; it never
    // moves, re-aims, or damages anything a second time.
    if (p.spent) {
      if (p.life-- <= 0) p.dead = true;
      continue;
    }

    p.prev.x = p.pos.x;
    p.prev.y = p.pos.y;

    if (p.life-- <= 0) {
      detonate(state, p);
      continue;
    }

    const target = p.targetId !== undefined ? findCombatant(state, p.targetId) : undefined;
    if (p.targetId !== undefined && !target) {
      // Its mark died mid-flight: fizzle (or burst harmlessly if it splashes).
      if (p.splash > 0) detonate(state, p);
      else p.dead = true;
      continue;
    }

    const speed = Math.hypot(p.vel.x, p.vel.y) || 1;
    if (target) {
      const tx = entityCenterX(target);
      const ty = entityCenterY(target);
      p.target.x = tx;
      p.target.y = ty;
      const want = Math.atan2(ty - p.pos.y, tx - p.pos.x);
      if (p.kind === 'rocket') {
        // Slight homing: a limited turn rate, so a fast mover can be led away.
        const cur = Math.atan2(p.vel.y, p.vel.x);
        const dir = cur + clamp(normalizeAngle(want - cur), -ROCKET_TURN, ROCKET_TURN);
        p.vel.x = Math.cos(dir) * speed;
        p.vel.y = Math.sin(dir) * speed;
      } else {
        p.vel.x = Math.cos(want) * speed;
        p.vel.y = Math.sin(want) * speed;
      }
    }

    const remaining = Math.hypot(p.target.x - p.pos.x, p.target.y - p.pos.y);
    const hitRadius = target && isUnitEntity(target) ? UNIT_TYPES[target.type].radius : 0;
    if (remaining <= speed + hitRadius) {
      p.pos.x = p.target.x;
      p.pos.y = p.target.y;
      if (p.arc !== undefined) p.arc = 0;
      detonate(state, p, target);
      continue;
    }

    p.pos.x += p.vel.x;
    p.pos.y += p.vel.y;
    if (p.arc !== undefined) {
      // Ballistic height, purely for the renderer: a sine hump whose peak
      // scales with the shot's total flight length.
      const total = p.travel ?? 0;
      const t = total > 0 ? clamp(1 - remaining / total, 0, 1) : 1;
      p.arc = Math.sin(t * Math.PI) * Math.min(52, total * 0.22);
    }
  }
}

// --- system -----------------------------------------------------------------

export function updateCombat(state: GameState): void {
  const index = buildIndex(state);
  for (const u of state.units) {
    if (u.dead) continue;
    stepUnitCombat(state, index, u);
  }
  for (const b of state.buildings) {
    if (b.dead) continue;
    stepBuildingCombat(state, index, b);
  }
  updateProjectiles(state);
}

/**
 * End-of-tick cleanup: drop dead entities and spent projectiles, and scrub the
 * ids they leave behind out of the selection and the control groups.
 */
export function removeDead(state: GameState): void {
  let deadEntities = false;
  for (const u of state.units) {
    if (u.dead) {
      deadEntities = true;
      break;
    }
  }
  if (!deadEntities) {
    for (const b of state.buildings) {
      if (b.dead) {
        deadEntities = true;
        break;
      }
    }
  }

  if (deadEntities) {
    state.units = state.units.filter((u) => !u.dead);
    state.buildings = state.buildings.filter((b) => !b.dead);
    const alive = new Set<number>();
    for (const u of state.units) alive.add(u.id);
    for (const b of state.buildings) alive.add(b.id);
    if (state.selection.length > 0) {
      state.selection = state.selection.filter((id) => alive.has(id));
    }
    for (let i = 0; i < state.controlGroups.length; i++) {
      const group = state.controlGroups[i] as number[];
      if (group.length > 0) state.controlGroups[i] = group.filter((id) => alive.has(id));
    }
  }

  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    if ((state.projectiles[i] as Projectile).dead) state.projectiles.splice(i, 1);
  }
  for (let i = state.effects.length - 1; i >= 0; i--) {
    const fx = state.effects[i] as Effect;
    if (state.tick - fx.startTick > fx.life) state.effects.splice(i, 1);
  }
}
