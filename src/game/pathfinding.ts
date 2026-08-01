/**
 * Tile pathfinding: A* over the 96x96 grid + string-pulling smoothing.
 *
 * - 8-directional, no cutting corners past impassable diagonals.
 * - Binary-heap open list, scratch buffers reused between calls (a generation
 *   stamp avoids clearing 9k-entry arrays every request).
 * - Expansion is capped (`DEFAULT_MAX_NODES`); when the goal is blocked or the
 *   cap is hit, the best node seen so far is returned as a partial path so
 *   callers always get a "walk as close as you can" answer.
 *
 * The buffers below are pure scratch space — they hold nothing between calls,
 * so this does not violate the "no module-level game state" rule.
 */

import { MAP_H, MAP_W, TERRAIN_COST, tileIndex } from './constants';
import { isPassable } from './map';
import type { MapData, TilePos } from './state';

const CELLS = MAP_W * MAP_H;

/** Default cap on expanded nodes. Roughly 45% of the map. */
export const DEFAULT_MAX_NODES = 4000;

const SQRT2 = Math.SQRT2;

// --- scratch buffers --------------------------------------------------------

const gScore = new Float64Array(CELLS);
const fScore = new Float64Array(CELLS);
const parent = new Int32Array(CELLS);
const seenGen = new Int32Array(CELLS);
const closedGen = new Int32Array(CELLS);
const heap = new Int32Array(CELLS * 4);
let heapSize = 0;
let generation = 0;

function heapClear(): void {
  heapSize = 0;
}

function heapPush(node: number): boolean {
  if (heapSize >= heap.length) return false;
  let i = heapSize++;
  heap[i] = node;
  const fv = fScore[node] as number;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const pn = heap[p] as number;
    if ((fScore[pn] as number) <= fv) break;
    heap[i] = pn;
    i = p;
  }
  heap[i] = node;
  return true;
}

function heapPop(): number {
  const top = heap[0] as number;
  heapSize--;
  if (heapSize > 0) {
    const moved = heap[heapSize] as number;
    const fv = fScore[moved] as number;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= heapSize) break;
      const r = l + 1;
      let c = l;
      if (r < heapSize && (fScore[heap[r] as number] as number) < (fScore[heap[l] as number] as number)) {
        c = r;
      }
      const cn = heap[c] as number;
      if ((fScore[cn] as number) >= fv) break;
      heap[i] = cn;
      i = c;
    }
    heap[i] = moved;
  }
  return top;
}

// --- helpers ----------------------------------------------------------------

/** Movement cost multiplier for entering this tile (>= 1, Infinity = blocked). */
function tileCost(map: MapData, tx: number, ty: number): number {
  const c = TERRAIN_COST[map.terrain[tileIndex(tx, ty)] as number];
  return c === undefined ? 1 : c;
}

/** Octile distance — admissible because the cheapest terrain costs exactly 1. */
function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx - dy + SQRT2 * dy : dy - dx + SQRT2 * dx;
}

const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export interface PathResult {
  /** Smoothed waypoints in tiles, start tile excluded. Empty = already there. */
  waypoints: TilePos[];
  /** True when the path actually reaches the requested goal tile. */
  complete: boolean;
  /** Tile the returned path ends on (equals the goal when `complete`). */
  end: TilePos;
  /** Nodes expanded — for diagnostics and budgeting. */
  expanded: number;
}

export interface FindPathOptions {
  /** Cap on expanded nodes before falling back to the closest node seen. */
  maxNodes?: number;
  /** Skip string-pulling (useful for tests / debugging). */
  smooth?: boolean;
}

const EMPTY_RESULT = (tx: number, ty: number, complete: boolean): PathResult => ({
  waypoints: [],
  complete,
  end: { tx, ty },
  expanded: 0,
});

/**
 * Nearest tile to (tx, ty) that ground units can occupy, or null within
 * `maxRadius`. Deterministic: rings are scanned in a fixed order and ties break
 * toward the lowest (ty, tx).
 */
export function findNearestPassable(
  map: MapData,
  tx: number,
  ty: number,
  maxRadius = 12,
): TilePos | null {
  if (isPassable(map, tx, ty)) return { tx, ty };

  let best: TilePos | null = null;
  let bestD = Infinity;

  for (let r = 1; r <= maxRadius; r++) {
    for (let oy = -r; oy <= r; oy++) {
      const onYEdge = oy === -r || oy === r;
      for (let ox = -r; ox <= r; ox++) {
        if (!onYEdge && ox !== -r && ox !== r) continue; // ring only
        const nx = tx + ox;
        const ny = ty + oy;
        if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
        if (!isPassable(map, nx, ny)) continue;
        const d = ox * ox + oy * oy;
        if (d < bestD) {
          bestD = d;
          best = { tx: nx, ty: ny };
        }
      }
    }
    // A hit on ring r can still be beaten by ring r+1 only if it is farther
    // than r+1 away, so scan one extra ring before committing.
    if (best && Math.sqrt(bestD) <= r + 1) return best;
  }
  return best;
}

/**
 * True when a straight line between two tile centres only crosses passable
 * tiles (and never squeezes through a blocked diagonal). Used for smoothing.
 */
export function lineOfSight(
  map: MapData,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  if (!isPassable(map, ax, ay) || !isPassable(map, bx, by)) return false;

  let x = ax;
  let y = ay;
  const dx = Math.abs(bx - ax);
  const dy = Math.abs(by - ay);
  const sx = bx > ax ? 1 : -1;
  const sy = by > ay ? 1 : -1;
  let err = dx - dy;
  let steps = dx + dy;

  while (steps > 0) {
    if (err > 0) {
      x += sx;
      err -= 2 * dy;
      steps--;
    } else if (err < 0) {
      y += sy;
      err += 2 * dx;
      steps--;
    } else {
      // Exact diagonal: both orthogonal neighbours must be clear.
      if (!isPassable(map, x + sx, y) || !isPassable(map, x, y + sy)) return false;
      x += sx;
      y += sy;
      err -= 2 * dy;
      err += 2 * dx;
      steps -= 2;
    }
    if (!isPassable(map, x, y)) return false;
  }
  return true;
}

/** String-pull: drop waypoints that a straight line can skip. */
export function smoothPath(map: MapData, sx: number, sy: number, path: TilePos[]): TilePos[] {
  if (path.length <= 1) return path;
  const out: TilePos[] = [];
  let curX = sx;
  let curY = sy;
  let i = 0;

  while (i < path.length) {
    let best = i;
    for (let j = path.length - 1; j > i; j--) {
      const t = path[j] as TilePos;
      if (lineOfSight(map, curX, curY, t.tx, t.ty)) {
        best = j;
        break;
      }
    }
    const chosen = path[best] as TilePos;
    out.push(chosen);
    curX = chosen.tx;
    curY = chosen.ty;
    i = best + 1;
  }
  return out;
}

/**
 * A* from (sx, sy) to (gx, gy).
 *
 * Blocked goals are retargeted to the nearest passable tile; unreachable goals
 * (or a blown node budget) return the closest node reached, with
 * `complete === false`.
 */
export function findPath(
  map: MapData,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  options: FindPathOptions = {},
): PathResult {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const smooth = options.smooth !== false;

  if (sx < 0 || sy < 0 || sx >= MAP_W || sy >= MAP_H) return EMPTY_RESULT(sx, sy, false);

  let tgx = Math.max(0, Math.min(MAP_W - 1, Math.floor(gx)));
  let tgy = Math.max(0, Math.min(MAP_H - 1, Math.floor(gy)));

  if (!isPassable(map, tgx, tgy)) {
    const alt = findNearestPassable(map, tgx, tgy, 12);
    if (alt) {
      tgx = alt.tx;
      tgy = alt.ty;
    }
  }

  if (sx === tgx && sy === tgy) return EMPTY_RESULT(sx, sy, true);

  generation++;
  heapClear();

  const startIdx = tileIndex(sx, sy);
  const goalIdx = tileIndex(tgx, tgy);

  gScore[startIdx] = 0;
  fScore[startIdx] = heuristic(sx, sy, tgx, tgy);
  parent[startIdx] = -1;
  seenGen[startIdx] = generation;
  heapPush(startIdx);

  let bestIdx = startIdx;
  let bestH = fScore[startIdx] as number;
  let expanded = 0;
  let reached = false;

  while (heapSize > 0) {
    const current = heapPop();
    if (closedGen[current] === generation) continue;
    closedGen[current] = generation;

    if (current === goalIdx) {
      bestIdx = current;
      reached = true;
      break;
    }

    expanded++;
    if (expanded > maxNodes) break;

    const cx = current % MAP_W;
    const cy = (current - cx) / MAP_W;
    const cg = gScore[current] as number;

    for (let d = 0; d < 8; d++) {
      const dir = DIRS[d] as readonly [number, number];
      const nx = cx + dir[0];
      const ny = cy + dir[1];
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      if (!isPassable(map, nx, ny)) continue;
      if (dir[0] !== 0 && dir[1] !== 0) {
        // No corner cutting: both orthogonal neighbours must be open.
        if (!isPassable(map, cx + dir[0], cy) || !isPassable(map, cx, cy + dir[1])) continue;
      }
      const ni = tileIndex(nx, ny);
      if (closedGen[ni] === generation) continue;

      const step = (dir[0] !== 0 && dir[1] !== 0 ? SQRT2 : 1) * tileCost(map, nx, ny);
      const tentative = cg + step;
      if (seenGen[ni] === generation && tentative >= (gScore[ni] as number)) continue;

      seenGen[ni] = generation;
      gScore[ni] = tentative;
      parent[ni] = current;
      const h = heuristic(nx, ny, tgx, tgy);
      fScore[ni] = tentative + h;
      if (!heapPush(ni)) break;

      if (h < bestH) {
        bestH = h;
        bestIdx = ni;
      }
    }
  }

  // Reconstruct (from the goal, or from the closest node we managed to reach).
  const endIdx = reached ? goalIdx : bestIdx;
  const raw: TilePos[] = [];
  let node = endIdx;
  let guard = CELLS;
  while (node !== -1 && node !== startIdx && guard-- > 0) {
    const tx = node % MAP_W;
    raw.push({ tx, ty: (node - tx) / MAP_W });
    node = parent[node] as number;
  }
  raw.reverse();

  if (raw.length === 0) return EMPTY_RESULT(sx, sy, reached);

  const waypoints = smooth ? smoothPath(map, sx, sy, raw) : raw;
  const last = waypoints[waypoints.length - 1] as TilePos;
  return { waypoints, complete: reached, end: { tx: last.tx, ty: last.ty }, expanded };
}
