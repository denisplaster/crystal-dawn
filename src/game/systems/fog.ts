/**
 * Fog of war — the human player's knowledge of the map.
 *
 * Two grids, both tile-granular and both owned by `state.fog`:
 *
 *   explored  persistent. 1 once a human unit/structure has ever seen the tile.
 *             Terrain stays drawn (darkened) but no enemies are shown.
 *   visible   volatile. 1 while a living human unit/structure has the tile
 *             inside its sight radius *this* recompute. Enemy entities are only
 *             drawn — and only pickable — on visible tiles.
 *
 * The AI ignores fog entirely (Phase 5 may give it a shroud of its own).
 *
 * Cost control: `visible` has to shrink behind a moving unit, which means a
 * full rebuild; that runs every `FOG_INTERVAL` ticks. On the ticks in between,
 * a 1/FOG_INTERVAL slice of the sources (selected by entity id, so the work is
 * staggered) additively re-marks its circle, which makes newly uncovered ground
 * appear immediately without paying for a whole rebuild.
 *
 * `state.fog.version` is bumped whenever a tile actually changed state, so the
 * renderer can cache its fog layer and rebuild only when something moved.
 *
 * `fog.enabled === false` means "revealed" (`__game.reveal()`): the system does
 * nothing and leaves whatever is in the grids alone.
 */

import { MAP_H, MAP_W, PLAYER_HUMAN, TILE, worldToTile } from '../constants';
import { BUILDING_TYPES, UNIT_TYPES } from '../rules';
import type { Building, GameState, Unit } from '../state';

/** Ticks between full `visible` rebuilds. */
export const FOG_INTERVAL = 4;

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------

/**
 * Mark a filled circle (tile radius `r`, centred on tile-space floats cx/cy).
 * Returns true if any tile changed state.
 */
function markCircle(
  explored: Uint8Array,
  visible: Uint8Array,
  cx: number,
  cy: number,
  r: number,
): boolean {
  let changed = false;
  const r2 = r * r;
  const ty0 = Math.max(0, Math.ceil(cy - r));
  const ty1 = Math.min(MAP_H - 1, Math.floor(cy + r));
  for (let ty = ty0; ty <= ty1; ty++) {
    const dy = ty - cy;
    const span = Math.sqrt(Math.max(0, r2 - dy * dy));
    const tx0 = Math.max(0, Math.ceil(cx - span));
    const tx1 = Math.min(MAP_W - 1, Math.floor(cx + span));
    const base = ty * MAP_W;
    for (let tx = tx0; tx <= tx1; tx++) {
      const i = base + tx;
      if (visible[i] === 0) {
        visible[i] = 1;
        changed = true;
      }
      if (explored[i] === 0) {
        explored[i] = 1;
        changed = true;
      }
    }
  }
  return changed;
}

/** Sight radius in tiles for a unit. */
export function unitSight(u: Unit): number {
  return UNIT_TYPES[u.type].sight;
}

/** Sight radius in tiles for a structure (its footprint counts as bulk). */
export function buildingSight(b: Building): number {
  return BUILDING_TYPES[b.type].sight + Math.max(b.w, b.h) * 0.5;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export function updateFog(state: GameState): void {
  const fog = state.fog;
  if (!fog.enabled) return;

  const slice = state.tick % FOG_INTERVAL;
  const full = slice === 0;
  const { explored, visible } = fog;
  let changed = false;

  if (full) {
    visible.fill(0);
    changed = true;
  }

  for (const u of state.units) {
    if (u.dead || u.player !== PLAYER_HUMAN) continue;
    if (!full && u.id % FOG_INTERVAL !== slice) continue;
    const cx = u.pos.x / TILE - 0.5;
    const cy = u.pos.y / TILE - 0.5;
    if (markCircle(explored, visible, cx, cy, unitSight(u))) changed = true;
  }

  for (const b of state.buildings) {
    if (b.dead || b.player !== PLAYER_HUMAN) continue;
    if (!full && b.id % FOG_INTERVAL !== slice) continue;
    const cx = b.tx + (b.w - 1) * 0.5;
    const cy = b.ty + (b.h - 1) * 0.5;
    if (markCircle(explored, visible, cx, cy, buildingSight(b))) changed = true;
  }

  if (changed) fog.version++;
}

// ---------------------------------------------------------------------------
// Queries (renderer + input + debug hook)
// ---------------------------------------------------------------------------

export function isTileExplored(state: GameState, tx: number, ty: number): boolean {
  if (!state.fog.enabled) return true;
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false;
  return state.fog.explored[ty * MAP_W + tx] === 1;
}

export function isTileVisible(state: GameState, tx: number, ty: number): boolean {
  if (!state.fog.enabled) return true;
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false;
  return state.fog.visible[ty * MAP_W + tx] === 1;
}

export function fogAt(
  state: GameState,
  tx: number,
  ty: number,
): { explored: boolean; visible: boolean } {
  return { explored: isTileExplored(state, tx, ty), visible: isTileVisible(state, tx, ty) };
}

/**
 * The renderer's culling predicate (also used by right-click targeting): may
 * the human see this entity right now?
 *
 * Own entities always. Enemy units and structures only while the tile they
 * stand on is *currently* visible — an explored-but-dark tile shows terrain
 * only, never enemies, exactly like C&C1's shroud.
 */
export function isEntityVisibleToHuman(state: GameState, e: Unit | Building): boolean {
  if (e.player === PLAYER_HUMAN) return true;
  if (!state.fog.enabled) return true;
  const asUnit = e as Unit;
  if (asUnit.pos !== undefined) {
    return isTileVisible(state, worldToTile(asUnit.pos.x), worldToTile(asUnit.pos.y));
  }
  const b = e as Building;
  for (let ty = b.ty; ty < b.ty + b.h; ty++) {
    for (let tx = b.tx; tx < b.tx + b.w; tx++) {
      if (isTileVisible(state, tx, ty)) return true;
    }
  }
  return false;
}
