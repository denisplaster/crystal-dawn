/**
 * Air — the aircraft ammo / rearm cycle (V2).
 *
 * Everything that makes an aircraft *fly* lives in `movement.ts` (straight-line
 * steering, no A*, air-only separation) and everything about who may shoot it
 * lives in `combat.ts` (`Weapon.targetsAir` / `vsAirScale`). This file owns the
 * one piece of state that is neither: the pod.
 *
 * Cycle, for any unit type with `ammo > 0`:
 *
 *   flying, ammo > 0    normal unit. Fires until the pod is empty.
 *   flying, ammo === 0  cannot shoot at all (combat drops its target and any
 *                       attack order). This system flies it home to a *free*
 *                       own helipad and docks it.
 *   docked              parked on the pad, `rearmAt` counting down. When the
 *                       clock runs out the pod is refilled and the aircraft is
 *                       a normal idle unit again, still sitting on the pad.
 *   no pad at all       falls back to the base perimeter and idles there, with
 *                       one EVA line (human only).
 *
 * Order discipline is the same contract the harvest system and the defensive
 * stance already use: this system only ever issues **self errands** (`move`
 * orders carrying `auto: true`), and it never overrides a live player order. A
 * manual order therefore interrupts a return trip — and because the retry runs
 * off "the aircraft is idle", it re-attempts the moment that order is done.
 */

import { PLAYER_HUMAN, TILE, clamp, tileCenter } from '../constants';
import { UNIT_TYPES } from '../rules';
import { postMessage, type Building, type GameState, type Unit } from '../state';

// --- tunables ---------------------------------------------------------------

/** Close enough to the pad centre to touch down. */
const DOCK_RANGE = TILE * 0.6;
/** A refreshed return order within this many px of the live one is not re-issued. */
const ERRAND_SLACK = 8;
/** Tiles from the fallback structure an aircraft with no pad loiters at. */
const PERIMETER_TILES = 3;

// --- helpers ----------------------------------------------------------------

/** Does this unit carry a finite pod (i.e. does it ever need to rearm)? */
export function usesAmmo(u: Unit): boolean {
  return UNIT_TYPES[u.type].ammo > 0;
}

/** Rounds left, treating "unlimited" as Infinity so callers can just compare. */
export function ammoOf(u: Unit): number {
  const max = UNIT_TYPES[u.type].ammo;
  if (max <= 0) return Infinity;
  return u.ammo ?? max;
}

/** Out of rounds and therefore unable to fire at anything. */
export function isOutOfAmmo(u: Unit): boolean {
  return ammoOf(u) <= 0;
}

/** Spend one round. No-op for unlimited-ammo units. */
export function spendAmmo(u: Unit): void {
  if (!usesAmmo(u)) return;
  u.ammo = Math.max(0, ammoOf(u) - 1);
}

/** World-space centre of a structure footprint (local copy: no import cycle). */
function centerOf(b: Building): { x: number; y: number } {
  return {
    x: tileCenter(b.tx) + ((b.w - 1) * TILE) / 2,
    y: tileCenter(b.ty) + ((b.h - 1) * TILE) / 2,
  };
}

/** A live order the *player* (or the AI) gave, as opposed to a self errand. */
function hasCommandedOrder(u: Unit): boolean {
  const o = u.order;
  return o !== undefined && o.auto !== true;
}

/**
 * Issue (or refresh) a flight errand to a world point. Air movement needs no
 * passable tile — the aircraft flies to the exact point — so unlike the ground
 * errands in `combat.ts` this never falls back to `findNearestPassable`.
 */
function flyTo(state: GameState, u: Unit, wx: number, wy: number): void {
  const x = clamp(wx, TILE * 0.5, state.map.w * TILE - TILE * 0.5);
  const y = clamp(wy, TILE * 0.5, state.map.h * TILE - TILE * 0.5);
  const cur = u.order;
  if (
    cur &&
    cur.kind === 'move' &&
    cur.auto === true &&
    cur.target &&
    Math.hypot(cur.target.x - x, cur.target.y - y) <= ERRAND_SLACK
  ) {
    return; // already on the way
  }
  u.order = {
    kind: 'move',
    tile: { tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) },
    target: { x, y },
    auto: true,
  };
  u.orderQueue = [];
  u.path = undefined;
  u.pathIndex = undefined;
  u.goal = undefined;
  u.repathAt = undefined;
  u.blockedTicks = 0;
}

/**
 * A finished pad of this player that produces this aircraft and is not already
 * claimed by another living aircraft. Nearest wins; ties break on id so the sim
 * stays deterministic.
 */
export function freePadFor(state: GameState, u: Unit): Building | undefined {
  const padType = UNIT_TYPES[u.type].producedAt;
  const claimed = new Set<number>();
  for (const other of state.units) {
    if (other.dead || other.id === u.id) continue;
    if (other.padId !== undefined) claimed.add(other.padId);
  }
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of state.buildings) {
    if (b.dead || b.player !== u.player || b.type !== padType) continue;
    if (b.status !== 'ready') continue;
    if (claimed.has(b.id)) continue;
    const c = centerOf(b);
    const d = Math.hypot(c.x - u.pos.x, c.y - u.pos.y);
    if (d < bestD || (d === bestD && best && b.id < best.id)) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Nearest own living structure — where an aircraft with no pad goes to loiter. */
function nearestOwnBuilding(state: GameState, u: Unit): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of state.buildings) {
    if (b.dead || b.player !== u.player) continue;
    const c = centerOf(b);
    const d = Math.hypot(c.x - u.pos.x, c.y - u.pos.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Take off: drop the dock, keep whatever ammo is aboard. */
function undock(u: Unit): void {
  u.docked = false;
  u.rearmAt = undefined;
}

// --- system -----------------------------------------------------------------

/**
 * Runs after `movement` (so an aircraft that reached its pad this tick docks in
 * the same tick) and before `production`, exactly like `harvest`.
 */
export function updateAir(state: GameState): void {
  for (const u of state.units) {
    if (u.dead) continue;
    if (!UNIT_TYPES[u.type].isAir) continue;
    if (!usesAmmo(u)) continue;
    stepAircraft(state, u);
  }
}

function stepAircraft(state: GameState, u: Unit): void {
  const def = UNIT_TYPES[u.type];
  if (u.ammo === undefined) u.ammo = def.ammo;

  // --- docked: rearming ----------------------------------------------------
  if (u.docked) {
    // The owner test matters as of the capture feature: a pad taken by an
    // enemy engineer stops being this aircraft's pad. `captureBuilding` already
    // kicks it airborne; this is the belt-and-braces half of that rule.
    const pad = state.buildings.find(
      (b) => b.id === u.padId && !b.dead && b.player === u.player && b.status === 'ready',
    );
    if (!pad) {
      // The pad was destroyed, sold or captured out from under it.
      undock(u);
      u.padId = undefined;
      return;
    }
    // A commanded order scrambles the aircraft immediately, part-rearmed.
    if (hasCommandedOrder(u)) {
      undock(u);
      u.padId = undefined;
      return;
    }
    // Pinned to the pad while it sits there (movement skips docked units).
    const c = centerOf(pad);
    u.pos.x = c.x;
    u.pos.y = c.y;
    u.vel.x = 0;
    u.vel.y = 0;
    if (state.tick >= (u.rearmAt ?? 0)) {
      u.ammo = def.ammo;
      undock(u);
      u.padId = undefined;
      u.airNoted = false;
      if (u.player === PLAYER_HUMAN) postMessage(state, 'Aircraft rearmed');
    }
    return;
  }

  // --- flying with rounds left: nothing to do ------------------------------
  if (!isOutOfAmmo(u)) {
    // Release a stale reservation (rearm was interrupted, or ammo was restored).
    if (u.padId !== undefined) u.padId = undefined;
    return;
  }

  // --- flying, empty: go home ----------------------------------------------
  // Player intent wins. The retry is driven by "the aircraft is idle", so the
  // return re-attempts by itself the moment the commanded order is discharged.
  if (hasCommandedOrder(u)) {
    u.padId = undefined;
    return;
  }

  let pad =
    u.padId !== undefined
      ? state.buildings.find(
          (b) => b.id === u.padId && !b.dead && b.player === u.player && b.status === 'ready',
        )
      : undefined;
  if (!pad) pad = freePadFor(state, u);

  if (pad) {
    u.padId = pad.id;
    u.airNoted = false;
    const c = centerOf(pad);
    if (Math.hypot(c.x - u.pos.x, c.y - u.pos.y) <= DOCK_RANGE) {
      u.order = undefined;
      u.orderQueue = [];
      u.path = undefined;
      u.pathIndex = undefined;
      u.goal = undefined;
      u.targetId = undefined;
      u.pos.x = c.x;
      u.pos.y = c.y;
      u.vel.x = 0;
      u.vel.y = 0;
      u.docked = true;
      u.rearmAt = state.tick + def.rearmTime;
      return;
    }
    flyTo(state, u, c.x, c.y);
    return;
  }

  // --- no pad anywhere: fall back to the base perimeter and idle -----------
  u.padId = undefined;
  const home = nearestOwnBuilding(state, u);
  if (home) {
    const c = centerOf(home);
    const dx = u.pos.x - c.x;
    const dy = u.pos.y - c.y;
    const len = Math.hypot(dx, dy);
    const reach = PERIMETER_TILES * TILE;
    // Already loitering at the perimeter: stop, do not orbit.
    if (Math.abs(len - reach) <= TILE) {
      if (u.order?.auto === true) {
        u.order = undefined;
        u.vel.x = 0;
        u.vel.y = 0;
      }
    } else {
      const nx = len > 1e-3 ? dx / len : 1;
      const ny = len > 1e-3 ? dy / len : 0;
      flyTo(state, u, c.x + nx * reach, c.y + ny * reach);
    }
  }
  if (!u.airNoted) {
    u.airNoted = true;
    if (u.player === PLAYER_HUMAN) postMessage(state, 'No helipad available', 'warning');
  }
}

// ---------------------------------------------------------------------------
// Introspection (debug hook / harnesses)
// ---------------------------------------------------------------------------

export interface AircraftReport {
  id: number;
  type: string;
  ammo: number;
  maxAmmo: number;
  docked: boolean;
  padId: number | null;
  /** Ticks of rearm left (0 when it is not rearming). */
  rearmTicks: number;
  order: string | null;
  pos: { x: number; y: number };
}

/** Every aircraft this player owns, with its pod state. */
export function airReport(state: GameState, player: number): AircraftReport[] {
  const out: AircraftReport[] = [];
  for (const u of state.units) {
    if (u.dead || u.player !== player) continue;
    const def = UNIT_TYPES[u.type];
    if (!def.isAir) continue;
    out.push({
      id: u.id,
      type: u.type,
      ammo: u.ammo ?? def.ammo,
      maxAmmo: def.ammo,
      docked: u.docked === true,
      padId: u.padId ?? null,
      rearmTicks: u.docked ? Math.max(0, (u.rearmAt ?? 0) - state.tick) : 0,
      order: u.order ? `${u.order.kind}${u.order.auto ? ' (auto)' : ''}` : null,
      pos: { x: u.pos.x, y: u.pos.y },
    });
  }
  return out;
}
