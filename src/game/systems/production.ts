/**
 * Production — build queues, power bookkeeping and structure placement.
 *
 * C&C rules, per SPEC:
 *   - one queue for structures, one for units, per player
 *   - only the head item of a queue progresses
 *   - credits are drip-charged as progress accrues; the item pauses (keeping
 *     what it already paid) when the player runs out of money
 *   - low power halves build speed
 *   - a finished structure does not auto-place: it goes "ready" and waits for
 *     the player to click it out (`placeStructure`)
 *   - a finished unit spawns on a passable tile *outside* the producing
 *     building's footprint and walks to a rally point
 *
 * Runs after `harvest` so credits banked this tick can be spent this tick.
 */

import {
  BASE_STORAGE,
  MAP_H,
  MAP_W,
  PLAYER_HUMAN,
  SELL_REFUND,
  SELL_TIME,
  TILE,
  clamp,
  tileCenter,
  worldToTile,
  type PlayerId,
} from '../constants';
import { isBuildable, isPassable } from '../map';
import { findNearestPassable } from '../pathfinding';
import {
  BUILDING_TYPES,
  BUILDING_TYPE_IDS,
  UNIT_TYPES,
  UNIT_TYPE_IDS,
  isBuildingType,
  type BuildingTypeId,
  type UnitTypeId,
} from '../rules';
import {
  createBuilding,
  createUnit,
  markMapRectDirty,
  postMessage,
  type Building,
  type GameState,
  type PlayerState,
  type ProductionItem,
  type TilePos,
  type Unit,
} from '../state';
import { killEntity } from './combat';
import { issueGroundOrder } from './orders';

// --- tunables ---------------------------------------------------------------

/** Build-speed multiplier while the player's power is in deficit. */
export const LOW_POWER_FACTOR = 0.5;
/** A new structure must sit within this many tiles of an existing structure. */
export const BUILD_RADIUS = 4;
/** C&C: one structure at a time. */
export const MAX_STRUCTURE_QUEUE = 1;
/** C&C: up to five units queued. */
export const MAX_UNIT_QUEUE = 5;
/** Tiles beyond the factory door the fresh unit walks to. */
const RALLY_OFFSET = 3;

/** Structures offered in the sidebar (the ConYard is pre-placed, never built). */
export const BUILDABLE_STRUCTURES: readonly BuildingTypeId[] = BUILDING_TYPE_IDS.filter(
  (id) => id !== 'conyard',
);
/** Units offered in the sidebar. */
export const BUILDABLE_UNITS: readonly UnitTypeId[] = UNIT_TYPE_IDS;

export type QueueTab = 'structures' | 'units';

// --- queries ----------------------------------------------------------------

export function queueTabFor(type: BuildingTypeId | UnitTypeId): QueueTab {
  return isBuildingType(type) ? 'structures' : 'units';
}

/**
 * Does this player own a finished, living building of that type? A structure
 * that is still going up — or one the owner has sold and is dismantling — does
 * not count.
 */
export function hasBuilding(
  state: GameState,
  player: PlayerId,
  type: BuildingTypeId,
): boolean {
  for (const b of state.buildings) {
    if (b.dead || b.player !== player || b.type !== type) continue;
    if (b.status !== 'ready') continue;
    return true;
  }
  return false;
}

/** Prereqs met (and, for units, a producing structure exists)? */
export function canBuild(
  state: GameState,
  player: PlayerId,
  type: BuildingTypeId | UnitTypeId,
): boolean {
  if (isBuildingType(type)) {
    if (type === 'conyard') return false;
    const def = BUILDING_TYPES[type];
    return def.prereq.every((p) => hasBuilding(state, player, p));
  }
  const def = UNIT_TYPES[type];
  if (!hasBuilding(state, player, def.producedAt)) return false;
  return def.prereq.every((p) => hasBuilding(state, player, p));
}

export function costOf(type: BuildingTypeId | UnitTypeId): number {
  return isBuildingType(type) ? BUILDING_TYPES[type].cost : UNIT_TYPES[type].cost;
}

export function buildTimeOf(type: BuildingTypeId | UnitTypeId): number {
  return isBuildingType(type) ? BUILDING_TYPES[type].buildTime : UNIT_TYPES[type].buildTime;
}

/** Head item of the queue that owns this type, when it is that very type. */
export function activeItem(p: PlayerState, tab: QueueTab): ProductionItem | undefined {
  return p.queues[tab].items[0];
}

// --- queueing ---------------------------------------------------------------

/**
 * Append an item to the owning queue. Returns false (and posts an EVA line for
 * the human) when prereqs are unmet or the queue is full.
 */
export function enqueue(
  state: GameState,
  player: PlayerId,
  type: BuildingTypeId | UnitTypeId,
): boolean {
  const p = state.players[player];
  const tab = queueTabFor(type);
  const queue = p.queues[tab];
  const limit = tab === 'structures' ? MAX_STRUCTURE_QUEUE : MAX_UNIT_QUEUE;

  if (!canBuild(state, player, type)) return false;
  if (queue.items.length >= limit) return false;

  queue.items.push({
    type,
    progress: 0,
    total: Math.max(1, buildTimeOf(type)),
    spent: 0,
  });
  return true;
}

/** Cancel a queued item and refund what it already paid. */
export function cancelQueueItem(
  state: GameState,
  player: PlayerId,
  tab: QueueTab,
  index = 0,
): boolean {
  const p = state.players[player];
  const queue = p.queues[tab];
  const item = queue.items[index];
  if (!item) return false;
  p.credits += item.spent;
  queue.items.splice(index, 1);
  if (index === 0 && item.ready) queue.pendingPlacement = undefined;
  if (player === PLAYER_HUMAN && state.ui.placement && item.ready) {
    state.ui.placement = null;
  }
  return true;
}

// --- placement --------------------------------------------------------------

/** Chebyshev gap in tiles between a candidate footprint and an existing one. */
function footprintGap(
  tx: number,
  ty: number,
  w: number,
  h: number,
  b: Building,
): number {
  const dx = Math.max(b.tx - (tx + w - 1), tx - (b.tx + b.w - 1), 0);
  const dy = Math.max(b.ty - (ty + h - 1), ty - (b.ty + b.h - 1), 0);
  return Math.max(dx, dy);
}

/** Is any of this player's non-wall structures within BUILD_RADIUS? */
export function withinBuildRadius(
  state: GameState,
  player: PlayerId,
  type: BuildingTypeId,
  tx: number,
  ty: number,
): boolean {
  const def = BUILDING_TYPES[type];
  for (const b of state.buildings) {
    if (b.dead || b.player !== player || b.type === 'sandbag') continue;
    if (footprintGap(tx, ty, def.w, def.h, b) <= BUILD_RADIUS) return true;
  }
  return false;
}

/** Every footprint tile buildable + unoccupied + no unit standing on it. */
export function canPlaceAt(
  state: GameState,
  player: PlayerId,
  type: BuildingTypeId,
  tx: number,
  ty: number,
): boolean {
  const def = BUILDING_TYPES[type];
  if (tx < 0 || ty < 0 || tx + def.w > MAP_W || ty + def.h > MAP_H) return false;
  for (let y = ty; y < ty + def.h; y++) {
    for (let x = tx; x < tx + def.w; x++) {
      if (!isBuildable(state.map, x, y)) return false;
    }
  }
  for (const u of state.units) {
    if (u.dead) continue;
    const ux = worldToTile(u.pos.x);
    const uy = worldToTile(u.pos.y);
    if (ux >= tx && ux < tx + def.w && uy >= ty && uy < ty + def.h) return false;
  }
  return withinBuildRadius(state, player, type, tx, ty);
}

/**
 * Drop the player's completed structure onto the map. Consumes the ready queue
 * item, grants the type's free unit (Refinery -> Harvester) and refreshes the
 * power/storage books.
 */
export function placeStructure(
  state: GameState,
  player: PlayerId,
  tx: number,
  ty: number,
): Building | null {
  const p = state.players[player];
  const queue = p.queues.structures;
  const item = queue.items[0];
  if (!item || !item.ready) return null;
  const type = item.type as BuildingTypeId;
  if (!canPlaceAt(state, player, type, tx, ty)) return null;

  const building = createBuilding(state, type, tx, ty, player);
  markMapRectDirty(state, building.tx, building.ty, building.w, building.h);

  queue.items.shift();
  queue.pendingPlacement = undefined;
  if (player === PLAYER_HUMAN && state.ui.placement?.type === type) {
    state.ui.placement = null;
  }

  const def = BUILDING_TYPES[type];
  if (def.freeUnit) spawnFromBuilding(state, building, def.freeUnit, false);
  if (player === PLAYER_HUMAN) postMessage(state, `${def.name} online`);

  recomputeEconomy(state);
  return building;
}

// --- selling ----------------------------------------------------------------

/** Credits a structure of this type gives back when sold. */
export function refundOf(type: BuildingTypeId): number {
  return Math.floor(BUILDING_TYPES[type].cost * SELL_REFUND);
}

/** A structure can be sold when it is the player's own, alive and finished. */
export function canSell(state: GameState, player: PlayerId, b: Building): boolean {
  if (b.dead || b.player !== player) return false;
  return b.status === 'ready';
}

/**
 * Sell a structure, C&C style. The refund lands **immediately** (that is the
 * whole point — it is the emergency cash button that gets a player out of the
 * no-refinery/no-income trap), and the building then spends `SELL_TIME`
 * dismantling itself before it dies through the ordinary death path with no
 * explosion. The ConYard is deliberately sellable: going all-in is a legitimate
 * move.
 *
 * The refund is not clamped to storage, exactly like the queue-cancel refund
 * (Phase 3: only harvester deposits are capped).
 *
 * Returns the credits refunded, or -1 when the structure cannot be sold.
 */
export function sellBuilding(state: GameState, player: PlayerId, b: Building): number {
  if (!canSell(state, player, b)) return -1;
  const refund = refundOf(b.type);
  const p = state.players[player];
  p.credits += refund;

  b.status = 'selling';
  b.sellAt = state.tick + SELL_TIME;
  // It stops being a functioning structure the moment it is sold: no fire, no
  // production, no power, no storage (see `weaponOf` / `hasBuilding` /
  // `recomputeEconomy`, which all test for `status === 'ready'`).
  b.targetId = undefined;
  if (b.queue) b.queue = [];
  recomputeEconomy(state);
  if (player === PLAYER_HUMAN) postMessage(state, 'Structure sold');
  return refund;
}

/** Sell by entity id (input handling, AI, debug hook). -1 when not sellable. */
export function sellBuildingById(state: GameState, player: PlayerId, id: number): number {
  const b = state.buildings.find((x) => x.id === id && !x.dead);
  if (!b) return -1;
  return sellBuilding(state, player, b);
}

/**
 * Retire structures whose dismantle clock has run out. `killEntity(quiet)` is
 * the normal death path minus the fireball, so the footprint is released and
 * the tiles are marked dirty exactly as they are for a destroyed building;
 * `removeDead` drops it from the arrays at the end of the tick.
 */
export function updateSelling(state: GameState): void {
  for (const b of state.buildings) {
    if (b.dead || b.status !== 'selling') continue;
    if (state.tick < (b.sellAt ?? 0)) continue;
    killEntity(state, b, true);
  }
}

// --- unit spawning ----------------------------------------------------------

/**
 * A passable tile touching the building's footprint, preferring the "door"
 * (south side). Never returns a tile inside a footprint: `isPassable` already
 * rejects occupied tiles.
 */
export function spawnTileFor(state: GameState, b: Building): TilePos | null {
  const map = state.map;
  const candidates: TilePos[] = [];
  for (let x = b.tx; x < b.tx + b.w; x++) candidates.push({ tx: x, ty: b.ty + b.h });
  for (let y = b.ty; y < b.ty + b.h; y++) {
    candidates.push({ tx: b.tx + b.w, ty: y });
    candidates.push({ tx: b.tx - 1, ty: y });
  }
  for (let x = b.tx; x < b.tx + b.w; x++) candidates.push({ tx: x, ty: b.ty - 1 });
  candidates.push({ tx: b.tx - 1, ty: b.ty + b.h });
  candidates.push({ tx: b.tx + b.w, ty: b.ty + b.h });
  candidates.push({ tx: b.tx - 1, ty: b.ty - 1 });
  candidates.push({ tx: b.tx + b.w, ty: b.ty - 1 });

  for (const c of candidates) {
    if (isPassable(map, c.tx, c.ty)) return c;
  }
  // Boxed in: fall back to the nearest open ground near the door.
  const doorX = clamp(b.tx + Math.floor(b.w / 2), 0, MAP_W - 1);
  const doorY = clamp(b.ty + b.h, 0, MAP_H - 1);
  return findNearestPassable(map, doorX, doorY, 8);
}

/** Create a unit next to a building and walk it to the rally point. */
export function spawnFromBuilding(
  state: GameState,
  b: Building,
  type: UnitTypeId,
  useRally = true,
): Unit | null {
  // V2: aircraft roll out *on* their pad, not beside it — they do not need open
  // ground, and a pad hemmed in by structures must still be able to produce.
  if (UNIT_TYPES[type].isAir) {
    const unit = createUnit(state, type, b.tx, b.ty, b.player);
    const c = buildingCenter(b);
    unit.pos.x = c.x;
    unit.pos.y = c.y;
    // No default rally hop for aircraft (the ground default walks a unit 3
    // tiles clear of the door, which an aircraft has no reason to do); an
    // explicit rally point is still honoured.
    if (useRally && b.rally) {
      issueGroundOrder(state, [unit], 'move', worldToTile(b.rally.x), worldToTile(b.rally.y));
    }
    return unit;
  }

  const tile = spawnTileFor(state, b);
  if (!tile) return null;
  const unit = createUnit(state, type, tile.tx, tile.ty, b.player);
  if (!useRally) return unit;

  let rtx: number;
  let rty: number;
  if (b.rally) {
    rtx = worldToTile(b.rally.x);
    rty = worldToTile(b.rally.y);
  } else {
    rtx = tile.tx;
    rty = tile.ty + RALLY_OFFSET;
  }
  rtx = clamp(rtx, 0, MAP_W - 1);
  rty = clamp(rty, 0, MAP_H - 1);
  const dest = findNearestPassable(state.map, rtx, rty, 6);
  if (dest) issueGroundOrder(state, [unit], 'move', dest.tx, dest.ty);
  return unit;
}

/** The player's building that produces this unit type, nearest to its rally. */
function producerFor(state: GameState, player: PlayerId, type: UnitTypeId): Building | undefined {
  const producedAt = UNIT_TYPES[type].producedAt;
  let fallback: Building | undefined;
  for (const b of state.buildings) {
    if (b.dead || b.player !== player || b.type !== producedAt) continue;
    if (b.status !== 'ready') continue;
    if (b.rally) return b; // a rally point marks the player's preferred factory
    if (!fallback) fallback = b;
  }
  return fallback;
}

// --- power / storage --------------------------------------------------------

/**
 * Recompute both players' power, storage and radar from the buildings they own.
 * Structures still under construction — and structures being sold — neither
 * produce nor drain, and grant no storage.
 */
export function recomputeEconomy(state: GameState): void {
  const produced = [0, 0];
  const drain = [0, 0];
  const storage = [BASE_STORAGE, BASE_STORAGE];
  const hasRadar = [false, false];

  for (const b of state.buildings) {
    if (b.dead || b.status !== 'ready') continue;
    const def = BUILDING_TYPES[b.type];
    const idx = b.player;
    if (def.power > 0) produced[idx] += def.power;
    else drain[idx] += -def.power;
    storage[idx] += def.storage;
    if (def.radar) hasRadar[idx] = true;
  }

  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i] as PlayerState;
    p.powerProduced = produced[i] as number;
    p.powerDrain = drain[i] as number;
    p.storage = storage[i] as number;
    const low = p.powerDrain > p.powerProduced;
    if (low && !p.lowPower && p.id === PLAYER_HUMAN) {
      postMessage(state, 'Low power', 'warning');
    }
    p.lowPower = low;
    // Radar (and Phase 4/6 minimap) needs a Comm Center and spare power.
    p.radar = (hasRadar[i] as boolean) && !low;
  }

  for (const b of state.buildings) {
    if (b.dead) continue;
    b.powered = !(state.players[b.player] as PlayerState).lowPower;
  }
}

// --- system -----------------------------------------------------------------

export function updateProduction(state: GameState): void {
  updateSelling(state);
  recomputeEconomy(state);
  for (const p of state.players) {
    advanceQueue(state, p, 'structures');
    advanceQueue(state, p, 'units');
  }
}

function advanceQueue(state: GameState, p: PlayerState, tab: QueueTab): void {
  const queue = p.queues[tab];
  const item = queue.items[0];
  if (!item) return;
  if (item.ready) return; // structure waiting to be placed blocks the queue

  if (item.progress < item.total) {
    const rate = p.lowPower ? LOW_POWER_FACTOR : 1;
    const next = Math.min(item.total, item.progress + rate);
    const cost = costOf(item.type);
    // Pay-as-you-build: charge the delta between what this progress is worth
    // and what has been paid. Rounded to whole credits so a finished item has
    // cost exactly `cost`, never a fraction more or less.
    const targetSpent = Math.round(cost * (next / item.total));
    const need = targetSpent - item.spent;
    if (need > p.credits) {
      if (p.id === PLAYER_HUMAN) postMessage(state, 'Insufficient funds', 'warning');
      return;
    }
    p.credits -= need;
    item.spent = targetSpent;
    item.progress = next;
  }

  if (item.progress >= item.total) finishItem(state, p, tab, item);
}

function finishItem(
  state: GameState,
  p: PlayerState,
  tab: QueueTab,
  item: ProductionItem,
): void {
  if (tab === 'structures') {
    item.ready = true;
    p.queues.structures.pendingPlacement = item.type as BuildingTypeId;
    if (p.id === PLAYER_HUMAN) postMessage(state, 'Construction complete');
    return;
  }

  const type = item.type as UnitTypeId;
  const producer = producerFor(state, p.id, type);
  // No factory (destroyed mid-build): hold the finished unit until one exists.
  if (!producer) return;
  const unit = spawnFromBuilding(state, producer, type);
  if (!unit) return; // completely boxed in — retry next tick
  p.queues.units.items.shift();
  if (p.id === PLAYER_HUMAN) postMessage(state, 'Unit ready');
}

// --- helpers for the sidebar ------------------------------------------------

/** Progress 0..1 of the head item of a queue, or 0. */
export function queueProgress(p: PlayerState, tab: QueueTab): number {
  const item = p.queues[tab].items[0];
  if (!item) return 0;
  return clamp(item.progress / item.total, 0, 1);
}

/** World-space centre of a building footprint (rally helpers, UI). */
export function buildingCenter(b: Building): { x: number; y: number } {
  return {
    x: tileCenter(b.tx) + ((b.w - 1) * TILE) / 2,
    y: tileCenter(b.ty) + ((b.h - 1) * TILE) / 2,
  };
}
