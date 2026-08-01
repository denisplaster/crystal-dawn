/**
 * Orders — turns the per-tick input snapshot into selection changes and unit
 * orders for the HUMAN player only. Runs first in the tick, before movement.
 *
 * Bindings (SPEC "Player-facing conventions"):
 *   left drag  — box select own units
 *   left click — select the unit/building under the cursor (shift toggles)
 *   right click— context order for the selection (move; shift queues)
 *   A + click  — attack-move (movement is identical until Phase 4 adds combat)
 *   Ctrl+1..9  — assign control group, 1..9 recall (shift+N adds to selection)
 *   Z / X / C  — stance: explore / defensive / offensive (post-release)
 *   Escape     — clear the armed cursor / selection
 */

import type { InputSnapshot } from '../../engine/input';
import { MAP_H, MAP_W, PLAYER_HUMAN, TILE, tileCenter, worldToTile } from '../constants';
import { isPassable } from '../map';
import { findNearestPassable } from '../pathfinding';
import { UNIT_TYPES } from '../rules';
import {
  postMessage,
  type Building,
  type GameState,
  type Order,
  type OrderKind,
  type TilePos,
  type Unit,
  type UnitStance,
} from '../state';
import { canCapture, isCaptureTarget, issueCaptureOrder } from './capture';
import { issueAttackOrder, isUnitEntity } from './combat';
import { isEntityVisibleToHuman } from './fog';
import { releaseHarvester } from './harvest';
// production.ts imports `issueGroundOrder` from here, so this pair is a cycle.
// It is safe in both the bundler and the CommonJS mirror: every binding
// involved is an `export function` (hoisted) and neither module calls into the
// other while it is being evaluated.
import { canSell, sellBuilding } from './production';

/**
 * Order kinds the movement system drives toward a ground destination.
 *
 * V2: `capture` is one of them. An engineer's approach to a building it is
 * taking is an ordinary walk to a tile beside the footprint — `systems/capture.ts`
 * only owns the contact test, never the steering.
 */
const MOVE_KINDS: ReadonlySet<OrderKind> = new Set<OrderKind>([
  'move',
  'attackMove',
  'capture',
]);

export function isMoveOrder(kind: OrderKind): boolean {
  return MOVE_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

/** Closest living unit whose body covers the world point, or undefined. */
export function unitAtPoint(state: GameState, wx: number, wy: number): Unit | undefined {
  let best: Unit | undefined;
  let bestD = Infinity;
  for (const u of state.units) {
    if (u.dead) continue;
    const r = UNIT_TYPES[u.type].radius + 3;
    const dx = u.pos.x - wx;
    const dy = u.pos.y - wy;
    const d = dx * dx + dy * dy;
    if (d <= r * r && d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

/** Living building whose footprint contains the tile, or undefined. */
export function buildingAtTile(state: GameState, tx: number, ty: number): Building | undefined {
  for (const b of state.buildings) {
    if (b.dead) continue;
    if (tx >= b.tx && tx < b.tx + b.w && ty >= b.ty && ty < b.ty + b.h) return b;
  }
  return undefined;
}

/**
 * Enemy unit (preferred) or structure under a world point, but only when the
 * human can actually see it through the fog.
 */
export function enemyAtPoint(
  state: GameState,
  wx: number,
  wy: number,
  tx: number,
  ty: number,
): Unit | Building | undefined {
  const unit = unitAtPoint(state, wx, wy);
  if (unit) {
    if (unit.player === PLAYER_HUMAN) return undefined;
    return isEntityVisibleToHuman(state, unit) ? unit : undefined;
  }
  const b = buildingAtTile(state, tx, ty);
  if (!b || b.player === PLAYER_HUMAN) return undefined;
  return isEntityVisibleToHuman(state, b) ? b : undefined;
}

/**
 * Is this right-click target a *structure* the human's engineers could take?
 * Units are never capturable, and a structure that is still going up or is
 * being dismantled is not a legal target (`isCaptureTarget`).
 */
function isCapturableEntity(e: Unit | Building): boolean {
  if (isUnitEntity(e)) return false;
  return isCaptureTarget(e, PLAYER_HUMAN);
}

/**
 * The single own, finished structure the human has selected, or undefined.
 * Exported so the sidebar can offer the same thing as a footer hint.
 */
export function sellableSelection(state: GameState): Building | undefined {
  if (state.selection.length !== 1) return undefined;
  const id = state.selection[0] as number;
  const b = state.buildings.find((x) => x.id === id && !x.dead);
  if (!b) return undefined;
  return canSell(state, PLAYER_HUMAN, b) ? b : undefined;
}

/** Sell the selected structure, if the selection is exactly one. */
function trySellSelection(state: GameState): boolean {
  const b = sellableSelection(state);
  if (!b) return false;
  return sellBuilding(state, PLAYER_HUMAN, b) >= 0;
}

// ---------------------------------------------------------------------------
// Stances (post-release)
// ---------------------------------------------------------------------------

/** Key -> stance, and the EVA line each one posts. */
export const STANCE_KEYS: readonly (readonly [code: string, stance: UnitStance])[] = [
  ['KeyZ', 'explore'],
  ['KeyX', 'defensive'],
  ['KeyC', 'offensive'],
];

export const STANCE_MESSAGE: Readonly<Record<UnitStance, string>> = {
  explore: 'Explore stance',
  defensive: 'Defensive stance',
  offensive: 'Offensive stance',
};

/** Short sidebar/manual label for a stance. */
export const STANCE_LABEL: Readonly<Record<UnitStance, string>> = {
  explore: 'EXP',
  defensive: 'DEF',
  offensive: 'OFF',
};

/** Harvesters are hardwired to self-preservation and take no stance. */
export function acceptsStance(u: Unit): boolean {
  return UNIT_TYPES[u.type].kind !== 'harvester';
}

/**
 * Apply a stance to every unit that accepts one. Harvesters in the list are
 * skipped silently, so a mixed selection still does the right thing. Returns
 * how many units changed.
 */
export function setUnitStance(units: Unit[], stance: UnitStance): number {
  let n = 0;
  for (const u of units) {
    if (u.dead || !acceptsStance(u)) continue;
    u.stance = stance;
    // The post is re-taken where the unit is standing right now; the other two
    // stances have no post at all.
    u.holdPos = stance === 'defensive' ? { x: u.pos.x, y: u.pos.y } : undefined;
    if (stance !== 'explore') u.fleeAt = undefined;
    n++;
  }
  return n;
}

/** The human's selected units that can hold a stance (for the sidebar row). */
export function stanceSelection(state: GameState): Unit[] {
  return ownUnitsInSelection(state).filter(acceptsStance);
}

/**
 * V2: the human's selected engineers (for the sidebar's capture hint). Capture
 * is a right-click, not a key, so the only UI it needs is a prompt saying so.
 */
export function captureSelection(state: GameState): Unit[] {
  return ownUnitsInSelection(state).filter(canCapture);
}

/**
 * The stance a mixed selection should show as active: the strict majority, or
 * `null` on a tie (nothing highlighted). Absent stance counts as 'offensive'.
 */
export function majorityStance(units: Unit[]): UnitStance | null {
  if (units.length === 0) return null;
  const tally: Record<UnitStance, number> = { explore: 0, defensive: 0, offensive: 0 };
  for (const u of units) tally[u.stance ?? 'offensive']++;
  let best: UnitStance | null = null;
  let bestN = 0;
  let tied = false;
  for (const s of ['explore', 'defensive', 'offensive'] as const) {
    if (tally[s] > bestN) {
      bestN = tally[s];
      best = s;
      tied = false;
    } else if (tally[s] === bestN && bestN > 0) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/** Apply a stance to the human's current selection and announce it. */
export function applyStanceToSelection(state: GameState, stance: UnitStance): number {
  const n = setUnitStance(ownUnitsInSelection(state), stance);
  if (n > 0) postMessage(state, STANCE_MESSAGE[stance], 'info');
  return n;
}

/** Debug hook / harness entry point: set a stance by entity id. */
export function setStanceByIds(state: GameState, ids: number[], stance: UnitStance): number {
  const wanted = new Set(ids);
  return setUnitStance(
    state.units.filter((u) => !u.dead && wanted.has(u.id)),
    stance,
  );
}

function ownUnitsInSelection(state: GameState): Unit[] {
  if (state.selection.length === 0) return [];
  const ids = new Set(state.selection);
  const out: Unit[] = [];
  for (const u of state.units) {
    if (!u.dead && u.player === PLAYER_HUMAN && ids.has(u.id)) out.push(u);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formation targets
// ---------------------------------------------------------------------------

/**
 * `count` distinct passable tiles clustered around (tx, ty), nearest first.
 * A breadth-first ring walk, so a group ordered onto one spot spreads into the
 * surrounding open ground instead of fighting over a single tile.
 */
export function formationTiles(
  state: GameState,
  count: number,
  tx: number,
  ty: number,
  flying = false,
): TilePos[] {
  const map = state.map;
  const out: TilePos[] = [];
  if (count <= 0) return out;

  let originX = tx;
  let originY = ty;
  // V2: aircraft ignore passability in both places it matters — the origin does
  // not have to be open ground, and neighbours are never rejected. That is what
  // lets a gunship be sent onto a cliff, a rock field or its own base.
  if (!flying && !isPassable(map, originX, originY)) {
    const alt = findNearestPassable(map, originX, originY, 12);
    if (!alt) return out;
    originX = alt.tx;
    originY = alt.ty;
  }
  if (originX < 0 || originY < 0 || originX >= MAP_W || originY >= MAP_H) return out;

  const seen = new Set<number>();
  const queue: number[] = [originY * MAP_W + originX];
  seen.add(queue[0] as number);
  const maxVisited = Math.max(256, count * 12);
  let visited = 0;

  for (let head = 0; head < queue.length && out.length < count; head++) {
    const idx = queue[head] as number;
    const cx = idx % MAP_W;
    const cy = (idx - cx) / MAP_W;
    out.push({ tx: cx, ty: cy });
    if (++visited > maxVisited) break;

    for (let d = 0; d < 8; d++) {
      const dir = RING_DIRS[d] as readonly [number, number];
      const nx = cx + dir[0];
      const ny = cy + dir[1];
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      const ni = ny * MAP_W + nx;
      if (seen.has(ni)) continue;
      seen.add(ni);
      if (!flying && !isPassable(map, nx, ny)) continue;
      queue.push(ni);
    }
  }
  return out;
}

const RING_DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

function assignOrder(unit: Unit, order: Order, queued: boolean): void {
  // Any externally issued order releases the defensive anchor. The unit
  // re-anchors on the spot where it next settles with nothing left to do,
  // which is what "the place it last completed an order" means.
  unit.holdPos = undefined;
  // ...and drops a pending capture: telling an engineer to go somewhere else is
  // telling it to stop walking into that building.
  unit.captureId = undefined;
  if (queued && unit.order) {
    (unit.orderQueue ??= []).push(order);
    return;
  }
  unit.order = order;
  unit.orderQueue = [];
  unit.path = undefined;
  unit.pathIndex = undefined;
  unit.goal = undefined;
  unit.repathAt = undefined;
  unit.blockedTicks = 0;
}

/**
 * Give a set of units a ground order, spread across a formation so they do not
 * all target the same tile. Exported for `window.__game.order()` and for later
 * phases (AI, rally points) that need to issue orders without input.
 *
 * `manual` marks an order the *player* gave (right-click, or the debug hook).
 * It is what breaks a harvester's cycle bond: production rally points and the
 * AI leave it false, so a freshly built harvester still walks to its rally and
 * starts work immediately.
 */
export function issueGroundOrder(
  state: GameState,
  units: Unit[],
  kind: OrderKind,
  tx: number,
  ty: number,
  queued = false,
  manual = false,
): void {
  if (units.length === 0) return;

  // V2: a mixed selection is issued as two orders — the ground half spreads over
  // passable tiles, the air half over any tiles at all. Splitting here keeps the
  // formation code below single-purpose (and the recursion terminates: each half
  // is uniform).
  const air: Unit[] = [];
  const ground: Unit[] = [];
  for (const u of units) {
    if (UNIT_TYPES[u.type].isAir) air.push(u);
    else ground.push(u);
  }
  if (air.length > 0 && ground.length > 0) {
    issueGroundOrder(state, ground, kind, tx, ty, queued, manual);
    issueGroundOrder(state, air, kind, tx, ty, queued, manual);
    return;
  }
  const flying = air.length > 0;

  const cx = tileCenter(tx);
  const cy = tileCenter(ty);
  // Closest unit takes the closest slot: keeps the group from crossing itself.
  const ordered = units
    .map((u) => ({ u, d: (u.pos.x - cx) ** 2 + (u.pos.y - cy) ** 2 }))
    .sort((a, b) => (a.d === b.d ? a.u.id - b.u.id : a.d - b.d))
    .map((e) => e.u);

  const slots = formationTiles(state, ordered.length, tx, ty, flying);
  if (slots.length === 0) return;

  for (let i = 0; i < ordered.length; i++) {
    const slot = slots[Math.min(i, slots.length - 1)] as TilePos;
    const unit = ordered[i] as Unit;
    assignOrder(
      unit,
      {
        kind,
        tile: { tx: slot.tx, ty: slot.ty },
        target: { x: tileCenter(slot.tx), y: tileCenter(slot.ty) },
        queued,
      },
      queued,
    );
    // "I moved it somewhere else and it walked straight back into danger":
    // a hand-issued move breaks the field/refinery bond and arms the danger
    // hold, so the harvester idles where it was sent and then re-acquires from
    // there rather than from the tile it was working.
    if (manual && isMoveOrder(kind) && UNIT_TYPES[unit.type].kind === 'harvester') {
      releaseHarvester(state, unit);
    }
  }
}

/** Halt: drop the current order and everything queued behind it. */
export function stopUnits(units: Unit[]): void {
  for (const u of units) {
    u.order = undefined;
    u.orderQueue = [];
    u.path = undefined;
    u.pathIndex = undefined;
    u.goal = undefined;
    u.blockedTicks = 0;
    u.vel.x = 0;
    u.vel.y = 0;
    // Stopping here means "hold this ground": a defensive unit re-anchors on
    // the spot on its next idle tick.
    u.holdPos = undefined;
    // Stop also calls off a capture run.
    u.captureId = undefined;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function setSelection(state: GameState, ids: number[]): void {
  state.selection = ids;
}

function toggleInto(selection: number[], ids: number[]): number[] {
  const set = new Set(selection);
  for (const id of ids) {
    if (set.has(id)) set.delete(id);
    else set.add(id);
  }
  return [...set];
}

function boxSelect(state: GameState, wx0: number, wy0: number, wx1: number, wy1: number): number[] {
  const hits: number[] = [];
  for (const u of state.units) {
    if (u.dead || u.player !== PLAYER_HUMAN) continue;
    if (u.pos.x >= wx0 && u.pos.x <= wx1 && u.pos.y >= wy0 && u.pos.y <= wy1) hits.push(u.id);
  }
  if (hits.length > 0) return hits;

  // Units are preferred; only fall back to structures when the box caught none.
  for (const b of state.buildings) {
    if (b.dead || b.player !== PLAYER_HUMAN) continue;
    const bx0 = b.tx * TILE;
    const by0 = b.ty * TILE;
    const bx1 = bx0 + b.w * TILE;
    const by1 = by0 + b.h * TILE;
    if (bx0 < wx1 && bx1 > wx0 && by0 < wy1 && by1 > wy0) {
      hits.push(b.id);
      break; // one structure at a time, C&C style
    }
  }
  return hits;
}

function recallGroup(state: GameState, group: number, add: boolean): void {
  const stored = state.controlGroups[group] ?? [];
  const alive = new Set<number>();
  for (const u of state.units) if (!u.dead) alive.add(u.id);
  for (const b of state.buildings) if (!b.dead) alive.add(b.id);
  const ids = stored.filter((id) => alive.has(id));
  state.controlGroups[group] = ids;
  if (ids.length === 0) return;
  setSelection(state, add ? [...new Set([...state.selection, ...ids])] : [...ids]);
  state.ui.lastGroupRecall = { group, tick: state.tick };
}

// ---------------------------------------------------------------------------
// System entry point
// ---------------------------------------------------------------------------

const DIGIT_CODES = [
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
] as const;

export function updateOrders(state: GameState, snap: InputSnapshot): void {
  const ui = state.ui;
  const ctrlHeld =
    snap.keys.has('ControlLeft') ||
    snap.keys.has('ControlRight') ||
    snap.keys.has('MetaLeft') ||
    snap.keys.has('MetaRight');
  const shiftHeld = snap.keys.has('ShiftLeft') || snap.keys.has('ShiftRight');

  // --- keyboard: control groups, attack-move arming, stop -------------------
  for (let i = 0; i < DIGIT_CODES.length; i++) {
    const code = DIGIT_CODES[i] as string;
    if (!snap.pressed.has(code)) continue;
    if (ctrlHeld) {
      state.controlGroups[i] = [...state.selection];
    } else {
      recallGroup(state, i, shiftHeld);
    }
  }

  if (snap.pressed.has('KeyA') && !ctrlHeld && ownUnitsInSelection(state).length > 0) {
    ui.pendingOrder = 'attackMove';
  }
  if (snap.pressed.has('Escape')) {
    if (ui.pendingOrder) ui.pendingOrder = null;
    else setSelection(state, []);
  }
  // Stances: Z explore / X defensive / C offensive, for everything selected
  // that can hold one. Ctrl is excluded so browser Ctrl/Cmd+Z/X/C never fires
  // a stance change.
  if (!ctrlHeld) {
    for (const [code, stance] of STANCE_KEYS) {
      if (!snap.pressed.has(code)) continue;
      applyStanceToSelection(state, stance);
      break;
    }
  }
  if (snap.pressed.has('KeyS')) {
    // 'S' is Stop for units and Sell for structures. The two never collide:
    // selling needs the selection to be *exactly one* of the player's own
    // finished structures, and a structure selection never contains units
    // (`boxSelect` only falls back to a structure when it caught no units, and
    // a left click picks one entity).
    const sold = trySellSelection(state);
    if (!sold) stopUnits(ownUnitsInSelection(state));
  }

  // --- drag boxes -----------------------------------------------------------
  for (const box of snap.dragBoxes) {
    if (box.button !== 0) continue;
    ui.pendingOrder = null;
    const hits = boxSelect(
      state,
      Math.min(box.wx0, box.wx1),
      Math.min(box.wy0, box.wy1),
      Math.max(box.wx0, box.wx1),
      Math.max(box.wy0, box.wy1),
    );
    setSelection(state, box.shift ? toggleInto(state.selection, hits) : hits);
  }

  // --- clicks ---------------------------------------------------------------
  for (const click of snap.clicks) {
    if (!click.inView) continue;
    const tx = Math.max(0, Math.min(MAP_W - 1, click.tx));
    const ty = Math.max(0, Math.min(MAP_H - 1, click.ty));

    if (click.button === 0) {
      const armed = ui.pendingOrder === 'attackMove' || snap.keys.has('KeyA');
      if (armed) {
        ui.pendingOrder = null;
        issueGroundOrder(
          state,
          ownUnitsInSelection(state),
          'attackMove',
          tx,
          ty,
          click.shift,
          true,
        );
        continue;
      }
      const unit = unitAtPoint(state, click.worldX, click.worldY);
      const picked: number[] = [];
      if (unit && unit.player === PLAYER_HUMAN) picked.push(unit.id);
      else if (!unit) {
        const b = buildingAtTile(state, tx, ty);
        if (b && b.player === PLAYER_HUMAN) picked.push(b.id);
      }
      setSelection(state, click.shift ? toggleInto(state.selection, picked) : picked);
      continue;
    }

    if (click.button === 2) {
      if (ui.pendingOrder) {
        ui.pendingOrder = null;
        continue;
      }
      // Context order: an enemy under the cursor means attack, anything else
      // means move. Enemies hidden by fog cannot be targeted — the player is
      // not allowed to click something they cannot see.
      const enemy = enemyAtPoint(state, click.worldX, click.worldY, tx, ty);
      const selected = ownUnitsInSelection(state);
      if (enemy) {
        // V2 — mixed selections on an enemy *structure* split by capability:
        // engineers walk in and take it, everything else attacks it. That is
        // the only sensible reading of one right-click meaning two things, and
        // it keeps the "unarmed units are sent to the spot" fallback for
        // anything unarmed that is not an engineer (a harvester).
        const engineers = isCapturableEntity(enemy) ? selected.filter(canCapture) : [];
        if (engineers.length > 0) {
          issueCaptureOrder(state, engineers, enemy.id, click.shift);
          const rest = selected.filter((u) => !canCapture(u));
          if (rest.length > 0) issueAttackOrder(state, rest, enemy.id, click.shift);
          continue;
        }
        issueAttackOrder(state, selected, enemy.id, click.shift);
        continue;
      }
      issueGroundOrder(state, selected, 'move', tx, ty, click.shift, true);
    }
  }
}

/** Convenience for the debug hook: order units by id. */
export function orderUnitsById(
  state: GameState,
  ids: number[],
  kind: OrderKind,
  wxOrTx: number,
  wyOrTy: number,
  opts: { world?: boolean; queued?: boolean } = {},
): number {
  const wanted = new Set(ids);
  const units = state.units.filter(
    (u) => !u.dead && wanted.has(u.id) && u.player === PLAYER_HUMAN,
  );
  if (units.length === 0) return 0;
  const tx = opts.world ? worldToTile(wxOrTx) : Math.floor(wxOrTx);
  const ty = opts.world ? worldToTile(wyOrTy) : Math.floor(wyOrTy);
  if (kind === 'stop') {
    stopUnits(units);
    return units.length;
  }
  // The debug hook stands in for the player, so its orders are manual.
  issueGroundOrder(state, units, kind, tx, ty, opts.queued === true, true);
  return units.length;
}

/** Convenience for the debug hook / AI: attack an entity id with unit ids. */
export function attackTargetById(
  state: GameState,
  ids: number[],
  targetId: number,
  queued = false,
): number {
  const wanted = new Set(ids);
  const units = state.units.filter((u) => !u.dead && wanted.has(u.id));
  if (units.length === 0) return 0;
  return issueAttackOrder(state, units, targetId, queued);
}
