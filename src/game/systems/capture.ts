/**
 * Engineer capture (V2).
 *
 * C&C Tiberian Dawn's engineer: an unarmed 500cr infantryman that walks into an
 * enemy structure and takes it over. The `capture` OrderKind has existed since
 * Phase 1 and was inert; this file is the behaviour behind it.
 *
 * Shape of the feature, in three parts:
 *
 *   1. **Intent** — `Unit.captureId` names the structure an engineer is going
 *      in to take. It lives on the unit, not on the order, because the movement
 *      system owns the order and may finish it (arrival) or abandon it (stuck,
 *      give-up); the intent has to outlive both. Every *externally* issued
 *      order clears it (`assignOrder` / `issueAttackOrder` / `stopUnits`), which
 *      is the same contract `holdPos` already has: player intent always wins.
 *   2. **Approach** — a plain `{ kind: 'capture', tile }` order pointed at a
 *      passable tile touching the footprint. `'capture'` is a move kind, so the
 *      ordinary movement system does the driving (A*, steering, separation);
 *      nothing here steers a unit.
 *   3. **Contact** — `updateCapture` runs immediately after `movement` (beside
 *      `harvest` and `air`, for the same reason: it needs "where the unit ended
 *      up this tick"). Inside `CAPTURE_RANGE` of the footprint the structure
 *      changes hands and the engineer is consumed.
 *
 * The conversion is deliberately *total*: the building becomes an ordinary
 * structure of the new owner. Ownership, power/storage books, radar, production
 * capability, prereq contribution and sell rights all follow from `b.player`,
 * so flipping that one field plus a `recomputeEconomy` is the whole transfer.
 * HP is untouched — you capture a wreck as a wreck.
 */

import { PLAYER_HUMAN, TILE } from '../constants';
import { BUILDING_TYPES, UNIT_TYPES } from '../rules';
import {
  findBuilding,
  type Building,
  type GameState,
  type Order,
  type Unit,
} from '../state';
import { killEntity, postThrottled } from './combat';
import { dockTile, distanceToBuilding, releaseHarvester } from './harvest';
import { recomputeEconomy } from './production';

// --- tunables ---------------------------------------------------------------

/**
 * Contact range, measured from the engineer's centre to the nearest edge of the
 * footprint.
 *
 * It has to cover the *worst* adjacent tile: a diagonal corner tile's centre is
 * `hypot(12, 12)` = 17.0px from the footprint, and the movement system parks a
 * unit anywhere within its arrival tolerance (`max(TILE * 0.3, radius * 0.7)` =
 * 7.2px for infantry) of that centre, so 24.2px is reachable while genuinely
 * standing against the wall. 1.2 tiles (28.8px) covers it with room for a
 * separation nudge — and still cannot reach a *non*-adjacent tile, whose
 * nearest centre is 1.5 tiles (36px) out.
 */
export const CAPTURE_RANGE = TILE * 1.2;

/** EVA throttle for the capture lines (3s), matching the Phase 4 loss lines. */
const EVA_CAPTURE_THROTTLE = 60;

// --- queries ----------------------------------------------------------------

/** Can this unit take structures? (`UnitTypeDef.captures`, i.e. the engineer.) */
export function canCapture(u: Unit): boolean {
  return !u.dead && UNIT_TYPES[u.type].captures;
}

/**
 * Is this structure a legal capture target for `player`?
 *
 * Enemy-owned and *finished*. A structure that is still going up or is being
 * dismantled by its owner is not takeable: `'ready'` is the same test every
 * other "is this structure working" question in the codebase uses (`weaponOf`,
 * `hasBuilding`, `producerFor`, `recomputeEconomy`).
 */
export function isCaptureTarget(b: Building | undefined, player: number): boolean {
  if (!b || b.dead) return false;
  if (b.player === player) return false;
  return b.status === 'ready';
}

// --- ordering ---------------------------------------------------------------

function clearNav(u: Unit): void {
  u.path = undefined;
  u.pathIndex = undefined;
  u.goal = undefined;
  u.repathAt = undefined;
  u.blockedTicks = 0;
}

/** Drop the capture intent (and the approach order it is driving, if live). */
export function clearCapture(u: Unit): void {
  u.captureId = undefined;
  if (u.order && u.order.kind === 'capture') {
    const queue = u.orderQueue;
    u.order = queue && queue.length > 0 ? queue.shift() : undefined;
    clearNav(u);
  }
}

/**
 * Order engineers to capture a structure. Units that cannot capture are
 * ignored — the caller (the right-click handler) splits the selection, so this
 * never has to guess what the rest of a mixed selection should do.
 *
 * Returns how many units took the order.
 */
export function issueCaptureOrder(
  state: GameState,
  units: Unit[],
  targetId: number,
  queued = false,
): number {
  const target = findBuilding(state, targetId);
  let n = 0;
  for (const u of units) {
    if (!canCapture(u)) continue;
    if (!isCaptureTarget(target, u.player)) continue;
    const b = target as Building;
    const dock = dockTile(state, b, u);
    const order: Order = {
      kind: 'capture',
      targetId,
      tile: dock ? { tx: dock.tx, ty: dock.ty } : { tx: b.tx, ty: b.ty },
      queued,
    };
    if (queued && u.order) {
      (u.orderQueue ??= []).push(order);
    } else {
      u.order = order;
      u.orderQueue = [];
      clearNav(u);
      // An externally issued order releases the defensive anchor, exactly like
      // `assignOrder` and `issueAttackOrder`.
      u.holdPos = undefined;
    }
    u.captureId = targetId;
    n++;
  }
  return n;
}

/** Debug hook / harness entry point: capture by entity id. */
export function captureByIds(state: GameState, ids: number[], targetId: number): number {
  const wanted = new Set(ids);
  return issueCaptureOrder(
    state,
    state.units.filter((u) => !u.dead && wanted.has(u.id)),
    targetId,
  );
}

// --- the conversion ---------------------------------------------------------

/**
 * Hand `b` to `engineer`'s player and consume the engineer. Returns false when
 * the target is not (any longer) a legal one.
 *
 * Everything the structure *does* is derived from `b.player` at read time, so
 * the transfer is one assignment plus a `recomputeEconomy`. What needs explicit
 * work is the state other entities hold *about* this building:
 *
 *   - a docked / inbound aircraft on a captured helipad does **not** change
 *     sides. It is kicked airborne and its reservation dropped; `air.ts` then
 *     re-pads it somewhere else or flies it to the base perimeter.
 *   - a harvester bonded to a captured refinery unbonds through the ordinary
 *     `releaseHarvester` path, so it idles out its danger hold and then
 *     re-acquires a field from where it is standing.
 *   - the queue, rally point and turret target belong to the old owner and are
 *     dropped. The build *queue* of the losing player is untouched: queues live
 *     on `PlayerState`, not on the building.
 *   - selection / control groups: a structure that leaves the human's hands
 *     leaves their selection too.
 */
export function captureBuilding(state: GameState, engineer: Unit, b: Building): boolean {
  if (engineer.dead || !canCapture(engineer)) return false;
  if (!isCaptureTarget(b, engineer.player)) return false;

  const from = b.player;
  const to = engineer.player;

  // Aircraft never change hands with their pad — they scramble.
  for (const u of state.units) {
    if (u.dead || u.padId !== b.id) continue;
    u.padId = undefined;
    if (u.docked) {
      u.docked = false;
      u.rearmAt = undefined;
    }
  }

  // Harvesters bonded to a captured refinery go back on the market.
  for (const u of state.units) {
    if (u.dead || u.refineryId !== b.id) continue;
    releaseHarvester(state, u);
  }

  b.player = to;
  b.rally = undefined;
  b.targetId = undefined;
  b.cooldown = 0;
  if (BUILDING_TYPES[b.type].produces) b.queue = [];
  // hp / maxHp / status / footprint / occupancy are all deliberately untouched.

  if (from === PLAYER_HUMAN) {
    if (state.selection.length > 0) {
      state.selection = state.selection.filter((id) => id !== b.id);
    }
    for (let i = 0; i < state.controlGroups.length; i++) {
      const group = state.controlGroups[i] as number[];
      if (group.includes(b.id)) {
        state.controlGroups[i] = group.filter((id) => id !== b.id);
      }
    }
  }

  // The engineer is spent. `quiet` skips the fireball and the "Unit lost" line:
  // it walked in, it did not blow up.
  engineer.captureId = undefined;
  killEntity(state, engineer, true);

  // Power, storage and radar move with the building, for both players at once.
  recomputeEconomy(state);

  if (to === PLAYER_HUMAN) {
    postThrottled(state, 'Structure captured', 'info', EVA_CAPTURE_THROTTLE);
  } else if (from === PLAYER_HUMAN) {
    postThrottled(state, 'Structure lost', 'alert', EVA_CAPTURE_THROTTLE);
  }
  return true;
}

// --- system -----------------------------------------------------------------

/**
 * Runs after `movement` (so an engineer that reached the door this tick takes
 * the building in the same tick) and before `production`, exactly like `harvest`
 * and `air`.
 */
export function updateCapture(state: GameState): void {
  for (const u of state.units) {
    if (u.dead || u.captureId === undefined) continue;
    if (!canCapture(u)) {
      u.captureId = undefined;
      continue;
    }
    stepEngineer(state, u);
  }
}

function stepEngineer(state: GameState, u: Unit): void {
  const b = findBuilding(state, u.captureId as number);
  // Razed, sold out from under us, or already ours (someone else got there).
  if (!isCaptureTarget(b, u.player)) {
    clearCapture(u);
    return;
  }
  const target = b as Building;

  if (distanceToBuilding(u.pos.x, u.pos.y, target) <= CAPTURE_RANGE) {
    captureBuilding(state, u, target);
    return;
  }

  // Still walking. The approach order is only (re)issued when there is none —
  // movement completed it on arrival, or gave up, or the player's order that
  // replaced it has since been discharged. A live order of any other kind means
  // the player is driving and the intent just waits its turn.
  if (u.order) return;

  const dock = dockTile(state, target, u);
  if (!dock) {
    // Completely walled in: nothing to walk to, so do not wedge the unit.
    clearCapture(u);
    return;
  }
  u.order = {
    kind: 'capture',
    targetId: target.id,
    tile: { tx: dock.tx, ty: dock.ty },
  };
  u.orderQueue = [];
  clearNav(u);
}

// ---------------------------------------------------------------------------
// Introspection (debug hook / harnesses)
// ---------------------------------------------------------------------------

export interface CaptureReport {
  id: number;
  player: number;
  /** Structure being walked in on, or null. */
  targetId: number | null;
  /** Distance to the target footprint in tiles, or null. */
  distance: number | null;
  order: string | null;
}

/** Every unit that can capture, with what it is doing. */
export function captureReport(state: GameState, player?: number): CaptureReport[] {
  const out: CaptureReport[] = [];
  for (const u of state.units) {
    if (u.dead || !canCapture(u)) continue;
    if (player !== undefined && u.player !== player) continue;
    const b = u.captureId !== undefined ? findBuilding(state, u.captureId) : undefined;
    out.push({
      id: u.id,
      player: u.player,
      targetId: u.captureId ?? null,
      distance: b ? distanceToBuilding(u.pos.x, u.pos.y, b) / TILE : null,
      order: u.order ? `${u.order.kind}${u.order.auto ? ' (auto)' : ''}` : null,
    });
  }
  return out;
}
