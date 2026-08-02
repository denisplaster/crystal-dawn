/**
 * Movement — path following, turning, local separation, arrival.
 *
 * Runs after `orders`. Every living unit gets its `vel` rewritten each tick
 * (the renderer interpolates `pos + vel * alpha`), so an idle unit must end the
 * tick with a zero velocity rather than a stale one.
 *
 * Shape of a tick:
 *   1. path management — request/refresh a path (throttled + staggered by id)
 *   2. steer           — turn toward the next waypoint, advance along facing
 *   3. separate        — soft push apart from overlapping neighbours
 *   4. commit          — clamp out of impassable tiles, write `vel`
 *
 * Infantry, vehicles and harvesters all use this system; only the numbers in
 * `UNIT_TYPES` differ.
 */

import { TERRAIN_COST, TILE, tileCenter, tileIndex, worldToTile } from '../constants';
import { isPassable } from '../map';
import { findNearestPassable, findPath } from '../pathfinding';
import { UNIT_TYPES } from '../rules';
import type { GameState, TilePos, Unit } from '../state';
import { isMoveOrder } from './orders';

// --- tunables ---------------------------------------------------------------

/** Full A* computations allowed per tick across the whole sim. */
const PATH_BUDGET_PER_TICK = 32;
/** Base ticks between voluntary path refreshes (plus an id-derived stagger). */
const REPATH_INTERVAL = 60;
const REPATH_STAGGER = 32;
/** Ticks of no progress before forcing a repath. */
const STUCK_REPATH_TICKS = 18;
/** Ticks of no progress before the unit gives up and settles where it is. */
const STUCK_GIVEUP_TICKS = 90;
/** Fraction of an overlap resolved per tick. */
const SEPARATION_STRENGTH = 0.5;
/** Spatial-hash cell size in world px. */
const HASH_CELL = TILE * 2;
/** Beyond this angle the unit pivots in place instead of driving. */
const PIVOT_ANGLE = 1.15;
/** Beyond this angle the unit drives at reduced speed while turning. */
const SLOW_TURN_ANGLE = 0.35;
/**
 * V2 (air): how much of the ground separation strength air units apply to each
 * other. Aircraft only nudge each other apart so a flight does not stack into a
 * single sprite; they never interact with ground units at all.
 */
const AIR_SEPARATION_SCALE = 0.5;

// --- small math helpers -----------------------------------------------------

function normalizeAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

function terrainFactor(state: GameState, x: number, y: number): number {
  const tx = worldToTile(x);
  const ty = worldToTile(y);
  if (tx < 0 || ty < 0 || tx >= state.map.w || ty >= state.map.h) return 1;
  const cost = TERRAIN_COST[state.map.terrain[tileIndex(tx, ty)] as number];
  if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return 1;
  return 1 / cost;
}

/** Deterministic unit-length jitter so perfectly coincident units still split. */
function idNudge(id: number): { x: number; y: number } {
  const a = (id * 2.399963229728653) % (Math.PI * 2);
  return { x: Math.cos(a), y: Math.sin(a) };
}

// --- order lifecycle --------------------------------------------------------

function clearNav(u: Unit): void {
  u.path = undefined;
  u.pathIndex = undefined;
  u.goal = undefined;
  u.repathAt = undefined;
  u.blockedTicks = 0;
}

/** Finish the current order and pull the next one off the queue. */
function completeOrder(u: Unit): void {
  clearNav(u);
  const queue = u.orderQueue;
  u.order = queue && queue.length > 0 ? queue.shift() : undefined;
}

function orderGoalTile(u: Unit): TilePos | null {
  const order = u.order;
  if (!order) return null;
  if (order.tile) return order.tile;
  if (order.target) return { tx: worldToTile(order.target.x), ty: worldToTile(order.target.y) };
  return null;
}

// --- system -----------------------------------------------------------------

export function updateMovement(state: GameState): void {
  const units = state.units;
  const count = units.length;
  if (count === 0) return;

  const startX = new Float64Array(count);
  const startY = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const u = units[i] as Unit;
    startX[i] = u.pos.x;
    startY[i] = u.pos.y;
  }

  let pathBudget = PATH_BUDGET_PER_TICK;

  // --- 1 + 2: path management and steering ---------------------------------
  for (let i = 0; i < count; i++) {
    const u = units[i] as Unit;
    if (u.dead) continue;
    // A docked aircraft is pinned to its pad by the air system: no steering, no
    // separation, no arrival logic.
    if (u.docked) continue;
    const order = u.order;
    if (!order || !isMoveOrder(order.kind)) {
      if (order && order.kind === 'stop') completeOrder(u);
      continue;
    }

    const def = UNIT_TYPES[u.type];
    const goal = orderGoalTile(u);
    if (!goal) {
      completeOrder(u);
      continue;
    }

    // Arrived?
    const destX = order.target ? order.target.x : tileCenter(goal.tx);
    const destY = order.target ? order.target.y : tileCenter(goal.ty);
    const arriveDist = Math.max(TILE * 0.3, def.radius * 0.7);
    if (Math.hypot(destX - u.pos.x, destY - u.pos.y) <= arriveDist) {
      completeOrder(u);
      continue;
    }

    // V2: aircraft fly. No A*, no passability, no terrain cost — just turn
    // toward the destination and go, keeping the same pivot/slow-turn feel the
    // ground units have so the two read as one game.
    if (def.isAir) {
      steerAir(u, def.speed, def.turnRate, destX, destY);
      continue;
    }

    // Path (re)computation.
    const goalChanged = !u.goal || u.goal.tx !== goal.tx || u.goal.ty !== goal.ty;
    const stale = u.repathAt !== undefined && state.tick >= u.repathAt;
    const nextTileBlocked =
      u.path !== undefined &&
      u.pathIndex !== undefined &&
      u.pathIndex < u.path.length &&
      !isPassable(state.map, (u.path[u.pathIndex] as TilePos).tx, (u.path[u.pathIndex] as TilePos).ty);

    if (u.path === undefined || goalChanged || stale || nextTileBlocked) {
      if (pathBudget > 0) {
        pathBudget--;
        const from = { tx: worldToTile(u.pos.x), ty: worldToTile(u.pos.y) };
        const result = findPath(state.map, from.tx, from.ty, goal.tx, goal.ty);
        u.pathIndex = 0;
        u.goal = { tx: goal.tx, ty: goal.ty };
        u.repathAt =
          state.tick + REPATH_INTERVAL + (u.id % REPATH_STAGGER) + (result.complete ? 0 : 10);
        if (result.waypoints.length > 0) {
          u.path = result.waypoints;
        } else if (result.complete) {
          // Already standing on the goal tile — walk in to the exact point.
          u.path = [{ tx: goal.tx, ty: goal.ty }];
        } else {
          // A* found nothing. If we are standing inside a blocked cluster
          // (e.g. deep in a building footprint), every neighbour is impassable
          // and A* can never start — walk straight to the nearest open tile,
          // then repath normally from there.
          const escape = !isPassable(state.map, from.tx, from.ty)
            ? findNearestPassable(state.map, from.tx, from.ty, 6)
            : null;
          if (escape) {
            u.path = [{ tx: escape.tx, ty: escape.ty }];
            u.repathAt = state.tick + 8;
          } else {
            // Fully boxed in: nothing reachable at all.
            u.path = [];
            u.blockedTicks = (u.blockedTicks ?? 0) + 6;
            if ((u.blockedTicks ?? 0) >= STUCK_GIVEUP_TICKS) {
              completeOrder(u);
              continue;
            }
          }
        }
      } else if (u.path === undefined) {
        // Out of budget this tick; try again next tick without stalling forever.
        u.repathAt = state.tick + 1;
        continue;
      }
    }

    const path = u.path;
    if (!path || path.length === 0) continue;
    let idx = u.pathIndex ?? 0;

    // Consume any waypoints we are already standing on.
    const wpDist = Math.max(TILE * 0.28, def.radius * 0.55);
    while (idx < path.length - 1) {
      const wp = path[idx] as TilePos;
      if (Math.hypot(tileCenter(wp.tx) - u.pos.x, tileCenter(wp.ty) - u.pos.y) > wpDist) break;
      idx++;
    }
    if (idx >= path.length) {
      // Reached the end of a partial path without reaching the destination.
      u.pathIndex = path.length;
      u.path = undefined;
      u.repathAt = state.tick + 15;
      u.blockedTicks = (u.blockedTicks ?? 0) + 6;
      if ((u.blockedTicks ?? 0) >= STUCK_GIVEUP_TICKS) completeOrder(u);
      continue;
    }
    u.pathIndex = idx;

    const isLast = idx === path.length - 1;
    const wp = path[idx] as TilePos;
    const aimX = isLast ? destX : tileCenter(wp.tx);
    const aimY = isLast ? destY : tileCenter(wp.ty);
    const dx = aimX - u.pos.x;
    const dy = aimY - u.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) continue;

    // Turn toward the waypoint.
    const desired = Math.atan2(dy, dx);
    const diff = normalizeAngle(desired - u.facing);
    const turn = Math.max(-def.turnRate, Math.min(def.turnRate, diff));
    u.facing = normalizeAngle(u.facing + turn);
    const misalign = Math.abs(normalizeAngle(desired - u.facing));

    // C1: a hover unit ignores the terrain *cost* multiplier (sand / crystal
    // never slow it). It is emphatically not a passability exemption — the path
    // above is the ordinary A* one, so rock and cliffs still stop it.
    let speed = def.ignoresTerrainCost
      ? def.speed
      : def.speed * terrainFactor(state, u.pos.x, u.pos.y);
    if (misalign > PIVOT_ANGLE) speed = 0;
    else if (misalign > SLOW_TURN_ANGLE) speed *= 0.45;

    if (speed > 0) {
      const step = Math.min(speed, dist);
      const nx = u.pos.x + Math.cos(u.facing) * step;
      const ny = u.pos.y + Math.sin(u.facing) * step;
      moveClamped(state, u, nx, ny);
    }
  }

  // --- 3: separation --------------------------------------------------------
  applySeparation(state, units);

  // --- 4: commit velocity + bookkeeping ------------------------------------
  for (let i = 0; i < count; i++) {
    const u = units[i] as Unit;
    if (u.dead) {
      u.vel.x = 0;
      u.vel.y = 0;
      continue;
    }
    const dx = u.pos.x - (startX[i] as number);
    const dy = u.pos.y - (startY[i] as number);
    u.vel.x = dx;
    u.vel.y = dy;

    // Phase 4 owns turret aiming; until then the turret tracks the hull so the
    // placeholder sprite's notch points where the unit is going.
    if (u.turretFacing !== undefined && u.targetId === undefined) u.turretFacing = u.facing;

    const order = u.order;
    if (!order || !isMoveOrder(order.kind)) {
      u.blockedTicks = 0;
      continue;
    }

    const def = UNIT_TYPES[u.type];
    const moved = Math.hypot(dx, dy);
    if (moved >= def.speed * 0.25) {
      u.blockedTicks = 0;
      continue;
    }

    const blocked = (u.blockedTicks ?? 0) + 1;
    u.blockedTicks = blocked;
    if (blocked === STUCK_REPATH_TICKS) {
      u.repathAt = state.tick; // force a fresh path next tick
      u.path = undefined;
    } else if (blocked >= STUCK_GIVEUP_TICKS) {
      // Permanently wedged (usually crowded around a shared destination):
      // settle here rather than jitter forever.
      completeOrder(u);
    }
  }
}

// --- movement primitives ----------------------------------------------------

/**
 * V2: one tick of flight. Turn toward the destination at the type's own turn
 * rate and advance along the (new) facing — the same steering the ground units
 * use, minus every ground constraint: no path, no `moveClamped`, no terrain
 * cost multiplier. Straight-line travel time is therefore exactly
 * `distance / speed` ticks once the aircraft has finished turning.
 */
function steerAir(
  u: Unit,
  speed: number,
  turnRate: number,
  destX: number,
  destY: number,
): void {
  const dx = destX - u.pos.x;
  const dy = destY - u.pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return;

  const desired = Math.atan2(dy, dx);
  const diff = normalizeAngle(desired - u.facing);
  u.facing = normalizeAngle(u.facing + Math.max(-turnRate, Math.min(turnRate, diff)));
  const misalign = Math.abs(normalizeAngle(desired - u.facing));

  let v = speed;
  if (misalign > PIVOT_ANGLE) v = 0;
  else if (misalign > SLOW_TURN_ANGLE) v *= 0.45;
  if (v <= 0) return;

  const step = Math.min(v, dist);
  u.pos.x += Math.cos(u.facing) * step;
  u.pos.y += Math.sin(u.facing) * step;
}

/** Move to (nx, ny) if the destination tile is passable; slide along axes if not. */
function moveClamped(state: GameState, u: Unit, nx: number, ny: number): void {
  const map = state.map;
  // A unit already standing on an impassable tile (e.g. displaced into a
  // building footprint) must be allowed to move regardless, or it can never
  // escape — every micro-step would start inside the blocked tile.
  if (!isPassable(map, worldToTile(u.pos.x), worldToTile(u.pos.y))) {
    u.pos.x = nx;
    u.pos.y = ny;
    return;
  }
  if (isPassable(map, worldToTile(nx), worldToTile(ny))) {
    u.pos.x = nx;
    u.pos.y = ny;
    return;
  }
  if (isPassable(map, worldToTile(nx), worldToTile(u.pos.y))) {
    u.pos.x = nx;
    return;
  }
  if (isPassable(map, worldToTile(u.pos.x), worldToTile(ny))) {
    u.pos.y = ny;
  }
}

/**
 * Soft body separation. Units resolve part of any overlap each tick; heavier
 * (bigger) and actively-moving units yield less, so a moving column pushes
 * loiterers aside instead of being deflected by them.
 */
function applySeparation(state: GameState, units: Unit[]): void {
  const count = units.length;
  if (count < 2) return;

  const pushX = new Float64Array(count);
  const pushY = new Float64Array(count);
  const buckets = new Map<number, number[]>();

  const cellOf = (x: number, y: number): number =>
    (Math.floor(y / HASH_CELL) & 0xffff) * 65536 + (Math.floor(x / HASH_CELL) & 0xffff);

  for (let i = 0; i < count; i++) {
    const u = units[i] as Unit;
    if (u.dead || u.docked) continue;
    const key = cellOf(u.pos.x, u.pos.y);
    const list = buckets.get(key);
    if (list) list.push(i);
    else buckets.set(key, [i]);
  }

  for (let i = 0; i < count; i++) {
    const a = units[i] as Unit;
    if (a.dead || a.docked) continue;
    const aAir = UNIT_TYPES[a.type].isAir;
    const ra = UNIT_TYPES[a.type].radius;
    const cx = Math.floor(a.pos.x / HASH_CELL);
    const cy = Math.floor(a.pos.y / HASH_CELL);

    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const list = buckets.get(((cy + oy) & 0xffff) * 65536 + ((cx + ox) & 0xffff));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const j = list[k] as number;
          if (j <= i) continue; // handle each pair once
          const b = units[j] as Unit;
          if (b.dead || b.docked) continue;
          // V2: air and ground share no airspace. A gunship never pushes a tank
          // and never gets shoved by a crowd it is flying over; aircraft only
          // nudge each other, and gently (see AIR_SEPARATION_SCALE).
          if (UNIT_TYPES[b.type].isAir !== aAir) continue;
          const rb = UNIT_TYPES[b.type].radius;
          const minDist = ra + rb;
          let dx = b.pos.x - a.pos.x;
          let dy = b.pos.y - a.pos.y;
          let d2 = dx * dx + dy * dy;
          if (d2 >= minDist * minDist) continue;

          let d = Math.sqrt(d2);
          if (d < 1e-4) {
            // Perfectly coincident: split along a stable per-unit direction.
            const n = idNudge(a.id + b.id * 7);
            dx = n.x;
            dy = n.y;
            d = 1;
            d2 = 1;
          }
          const inv = 1 / d;
          const nx = dx * inv;
          const ny = dy * inv;
          const overlap =
            (minDist - d) * SEPARATION_STRENGTH * (aAir ? AIR_SEPARATION_SCALE : 1);

          // Mass: bigger units and units under orders hold their ground.
          const ma = ra * ra * (isMoving(a) ? 1.6 : 1);
          const mb = rb * rb * (isMoving(b) ? 1.6 : 1);
          const total = ma + mb;
          const shareA = mb / total;
          const shareB = ma / total;

          pushX[i] -= nx * overlap * shareA;
          pushY[i] -= ny * overlap * shareA;
          pushX[j] += nx * overlap * shareB;
          pushY[j] += ny * overlap * shareB;
        }
      }
    }
  }

  for (let i = 0; i < count; i++) {
    const u = units[i] as Unit;
    if (u.dead || u.docked) continue;
    let px = pushX[i] as number;
    let py = pushY[i] as number;
    if (px === 0 && py === 0) continue;
    // Never let separation outrun the unit's own speed.
    const cap = Math.max(0.6, UNIT_TYPES[u.type].speed);
    const mag = Math.hypot(px, py);
    if (mag > cap) {
      px = (px / mag) * cap;
      py = (py / mag) * cap;
    }
    if (UNIT_TYPES[u.type].isAir) {
      u.pos.x += px;
      u.pos.y += py;
      continue;
    }
    moveClamped(state, u, u.pos.x + px, u.pos.y + py);
  }
}

function isMoving(u: Unit): boolean {
  return u.order !== undefined && isMoveOrder(u.order.kind);
}
