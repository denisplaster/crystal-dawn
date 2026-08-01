/**
 * Terrain generation + grid queries.
 *
 * Deterministic: everything here is driven by a seeded RNG derived from the
 * game seed. No `Math.random`.
 *
 * Layout: two start corners on opposite diagonals, each with a 12x12 clear,
 * buildable area and a large crystal field just outside it, plus neutral
 * fields around mid-map.
 */

import { makeRng, type Rng } from '../engine/rng';
import {
  CRYSTAL_TILE_AMOUNT,
  MAP_H,
  MAP_W,
  Terrain,
  TERRAIN_BUILDABLE,
  TERRAIN_PASSABLE,
  TERRAIN_VARIANTS,
  tileIndex,
  inBounds,
} from './constants';
import type { CrystalField, MapData, TilePos } from './state';

/** Half-width of the guaranteed-clear square around each start position. */
const START_CLEAR_RADIUS = 6; // -> 13x13 tiles clear, covers the required 12x12

const START_TILES: readonly TilePos[] = [
  { tx: 13, ty: 13 },
  { tx: MAP_W - 14, ty: MAP_H - 14 },
];

// ---------------------------------------------------------------------------
// Value noise
// ---------------------------------------------------------------------------

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * Build a smoothed value-noise field over the map at the given feature size,
 * summing two octaves. Returns values roughly in [0, 1].
 */
function valueNoise(rng: Rng, cellSize: number): Float32Array {
  const octave = (size: number): Float32Array => {
    const gw = Math.ceil(MAP_W / size) + 2;
    const gh = Math.ceil(MAP_H / size) + 2;
    const grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i++) grid[i] = rng.next();

    const out = new Float32Array(MAP_W * MAP_H);
    for (let ty = 0; ty < MAP_H; ty++) {
      const gy = Math.floor(ty / size);
      const fy = smoothstep((ty % size) / size);
      for (let tx = 0; tx < MAP_W; tx++) {
        const gx = Math.floor(tx / size);
        const fx = smoothstep((tx % size) / size);
        const a = grid[gy * gw + gx] as number;
        const b = grid[gy * gw + gx + 1] as number;
        const c = grid[(gy + 1) * gw + gx] as number;
        const d = grid[(gy + 1) * gw + gx + 1] as number;
        const top = a + (b - a) * fx;
        const bottom = c + (d - c) * fx;
        out[ty * MAP_W + tx] = top + (bottom - top) * fy;
      }
    }
    return out;
  };

  const coarse = octave(cellSize);
  const fine = octave(Math.max(2, Math.floor(cellSize / 2)));
  const out = new Float32Array(MAP_W * MAP_H);
  for (let i = 0; i < out.length; i++) {
    out[i] = (coarse[i] as number) * 0.68 + (fine[i] as number) * 0.32;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function isInStartClear(tx: number, ty: number): boolean {
  for (const s of START_TILES) {
    if (
      Math.abs(tx - s.tx) <= START_CLEAR_RADIUS &&
      Math.abs(ty - s.ty) <= START_CLEAR_RADIUS
    ) {
      return true;
    }
  }
  return false;
}

/** Grow a roughly circular blob of `count` tiles out from (cx, cy). */
function growBlob(
  rng: Rng,
  cx: number,
  cy: number,
  count: number,
  accept: (tx: number, ty: number) => boolean,
): number[] {
  const taken = new Set<number>();
  const result: number[] = [];
  const frontier: TilePos[] = [];

  const push = (tx: number, ty: number): void => {
    if (!inBounds(tx, ty)) return;
    const idx = tileIndex(tx, ty);
    if (taken.has(idx)) return;
    if (!accept(tx, ty)) return;
    taken.add(idx);
    result.push(idx);
    frontier.push({ tx, ty });
  };

  push(cx, cy);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  let guard = count * 40;
  while (result.length < count && frontier.length > 0 && guard-- > 0) {
    // Bias toward earlier (inner) frontier tiles so blobs stay compact.
    const pickIdx = Math.min(
      frontier.length - 1,
      Math.floor(rng.next() * rng.next() * frontier.length),
    );
    const from = frontier[pickIdx] as TilePos;
    const d = rng.pick(dirs);
    const nx = from.tx + d[0];
    const ny = from.ty + d[1];
    const before = result.length;
    push(nx, ny);
    if (result.length === before && rng.chance(0.25)) {
      frontier.splice(pickIdx, 1);
    }
  }

  return result;
}

/** Carve a passable corridor between two tiles (used to guarantee connectivity). */
function carveCorridor(
  terrain: Uint8Array,
  from: TilePos,
  to: TilePos,
  halfWidth: number,
): void {
  let x = from.tx;
  let y = from.ty;
  const dx = Math.abs(to.tx - x);
  const dy = Math.abs(to.ty - y);
  const sx = x < to.tx ? 1 : -1;
  const sy = y < to.ty ? 1 : -1;
  let err = dx - dy;
  let guard = MAP_W * MAP_H;

  for (;;) {
    for (let oy = -halfWidth; oy <= halfWidth; oy++) {
      for (let ox = -halfWidth; ox <= halfWidth; ox++) {
        const tx = x + ox;
        const ty = y + oy;
        if (!inBounds(tx, ty)) continue;
        const i = tileIndex(tx, ty);
        const t = terrain[i] as number;
        if (t === Terrain.Rock || t === Terrain.Cliff) terrain[i] = Terrain.Grass;
      }
    }
    if ((x === to.tx && y === to.ty) || guard-- <= 0) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Flood fill over passable terrain; returns a reachability mask. */
function reachableFrom(terrain: Uint8Array, start: TilePos): Uint8Array {
  const seen = new Uint8Array(MAP_W * MAP_H);
  const queue: number[] = [tileIndex(start.tx, start.ty)];
  seen[queue[0] as number] = 1;
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head] as number;
    const tx = idx % MAP_W;
    const ty = (idx - tx) / MAP_W;
    const neighbours = [
      [tx + 1, ty],
      [tx - 1, ty],
      [tx, ty + 1],
      [tx, ty - 1],
    ] as const;
    for (const [nx, ny] of neighbours) {
      if (!inBounds(nx, ny)) continue;
      const ni = tileIndex(nx, ny);
      if (seen[ni]) continue;
      if (!TERRAIN_PASSABLE[terrain[ni] as number]) continue;
      seen[ni] = 1;
      queue.push(ni);
    }
  }
  return seen;
}

export function generateMap(seed: number): MapData {
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);

  const cells = MAP_W * MAP_H;
  const terrain = new Uint8Array(cells);
  const variant = new Uint8Array(cells);
  const crystal = new Uint16Array(cells);

  const aridity = valueNoise(rng, 14);
  const rockiness = valueNoise(rng, 9);

  // --- base terrain: grass with sand patches, rock/cliff clusters ---
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const i = tileIndex(tx, ty);
      const rock = rockiness[i] as number;
      const arid = aridity[i] as number;

      let t: Terrain = Terrain.Grass;
      if (arid > 0.62) t = Terrain.Sand;
      if (rock > 0.70) t = Terrain.Rock;
      if (rock > 0.79) t = Terrain.Cliff;

      // Ragged edges on the map border so nothing looks laser-cut.
      if (tx === 0 || ty === 0 || tx === MAP_W - 1 || ty === MAP_H - 1) {
        t = Terrain.Cliff;
      }

      terrain[i] = t;
      variant[i] = rng.int(TERRAIN_VARIANTS);
    }
  }

  // --- clear the start areas (grass/sand only, fully buildable) ---
  for (const s of START_TILES) {
    for (let oy = -START_CLEAR_RADIUS; oy <= START_CLEAR_RADIUS; oy++) {
      for (let ox = -START_CLEAR_RADIUS; ox <= START_CLEAR_RADIUS; ox++) {
        const tx = s.tx + ox;
        const ty = s.ty + oy;
        if (!inBounds(tx, ty)) continue;
        const i = tileIndex(tx, ty);
        const t = terrain[i] as number;
        if (t !== Terrain.Grass && t !== Terrain.Sand) terrain[i] = Terrain.Grass;
      }
    }
  }

  // --- crystal fields ---
  const fieldSpecs: { tx: number; ty: number; size: number; nearStart: number }[] = [];

  // One large field just outside each start's clear zone, toward map centre.
  START_TILES.forEach((s, idx) => {
    const towardCentreX = Math.sign(MAP_W / 2 - s.tx);
    const towardCentreY = Math.sign(MAP_H / 2 - s.ty);
    fieldSpecs.push({
      tx: s.tx + towardCentreX * (START_CLEAR_RADIUS + 4),
      ty: s.ty + towardCentreY * (START_CLEAR_RADIUS + 2),
      size: rng.intRange(58, 74),
      nearStart: idx,
    });
  });

  // Neutral fields: contested mid-map + the two "off" corners.
  const neutralAnchors: TilePos[] = [
    { tx: Math.floor(MAP_W / 2), ty: Math.floor(MAP_H / 2) },
    { tx: Math.floor(MAP_W * 0.22), ty: Math.floor(MAP_H * 0.74) },
    { tx: Math.floor(MAP_W * 0.76), ty: Math.floor(MAP_H * 0.24) },
    { tx: Math.floor(MAP_W * 0.5), ty: Math.floor(MAP_H * 0.2) },
  ];
  for (const a of neutralAnchors) {
    fieldSpecs.push({
      tx: a.tx + rng.intRange(-4, 4),
      ty: a.ty + rng.intRange(-4, 4),
      size: rng.intRange(30, 46),
      nearStart: -1,
    });
  }

  const crystalFields: CrystalField[] = [];
  const growable = (tx: number, ty: number): boolean => {
    if (!inBounds(tx, ty) || isInStartClear(tx, ty)) return false;
    const t = terrain[tileIndex(tx, ty)] as number;
    return t === Terrain.Grass || t === Terrain.Sand;
  };

  for (const spec of fieldSpecs) {
    // A seed tile can land in a pocket that is too small to hold the field, so
    // try several candidates around the anchor and keep the best blob.
    let bestTiles: number[] = [];
    let bestX = spec.tx;
    let bestY = spec.ty;

    for (let attempt = 0; attempt < 24; attempt++) {
      const jitter = attempt === 0 ? 0 : Math.min(9, 2 + Math.floor(attempt / 2));
      const cx = Math.max(
        2,
        Math.min(MAP_W - 3, spec.tx + (jitter ? rng.intRange(-jitter, jitter) : 0)),
      );
      const cy = Math.max(
        2,
        Math.min(MAP_H - 3, spec.ty + (jitter ? rng.intRange(-jitter, jitter) : 0)),
      );
      if (!growable(cx, cy)) continue;

      const tiles = growBlob(rng, cx, cy, spec.size, growable);
      if (tiles.length > bestTiles.length) {
        bestTiles = tiles;
        bestX = cx;
        bestY = cy;
      }
      if (bestTiles.length >= spec.size * 0.75) break;
    }

    if (bestTiles.length < 8) continue;

    for (const i of bestTiles) {
      terrain[i] = Terrain.Crystal;
      // Phase 7: jitter scaled with the tile value (was +-200 on 1500).
      crystal[i] = CRYSTAL_TILE_AMOUNT + rng.intRange(-100, 100);
    }
    crystalFields.push({ tx: bestX, ty: bestY, tiles: bestTiles, nearStart: spec.nearStart });
  }

  // --- connectivity: make sure both starts and every field are reachable ---
  const start0 = START_TILES[0] as TilePos;
  let reach = reachableFrom(terrain, start0);
  const start1 = START_TILES[1] as TilePos;
  if (!reach[tileIndex(start1.tx, start1.ty)]) {
    carveCorridor(terrain, start0, start1, 1);
    reach = reachableFrom(terrain, start0);
  }
  for (const field of crystalFields) {
    if (!reach[tileIndex(field.tx, field.ty)]) {
      carveCorridor(terrain, start0, { tx: field.tx, ty: field.ty }, 1);
      reach = reachableFrom(terrain, start0);
    }
  }

  // --- derived grids ---
  const passable = new Uint8Array(cells);
  const buildable = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    const t = terrain[i] as number;
    passable[i] = TERRAIN_PASSABLE[t] ? 1 : 0;
    buildable[i] = TERRAIN_BUILDABLE[t] ? 1 : 0;
    if (t !== Terrain.Crystal) crystal[i] = 0;
  }

  return {
    w: MAP_W,
    h: MAP_H,
    terrain,
    variant,
    passable,
    buildable,
    crystal,
    occupied: new Uint16Array(cells),
    startTiles: START_TILES.map((s) => ({ tx: s.tx, ty: s.ty })),
    crystalFields,
    seed,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function terrainAt(map: MapData, tx: number, ty: number): Terrain {
  if (!inBounds(tx, ty)) return Terrain.Cliff;
  return map.terrain[tileIndex(tx, ty)] as Terrain;
}

/** True if ground units can occupy this tile (terrain + structures). */
export function isPassable(map: MapData, tx: number, ty: number): boolean {
  if (!inBounds(tx, ty)) return false;
  const i = tileIndex(tx, ty);
  return map.passable[i] === 1 && map.occupied[i] === 0;
}

/** True if a structure footprint tile may be placed here. */
export function isBuildable(map: MapData, tx: number, ty: number): boolean {
  if (!inBounds(tx, ty)) return false;
  const i = tileIndex(tx, ty);
  return map.buildable[i] === 1 && map.occupied[i] === 0;
}

export function crystalAt(map: MapData, tx: number, ty: number): number {
  if (!inBounds(tx, ty)) return 0;
  return map.crystal[tileIndex(tx, ty)] as number;
}

/**
 * Remove up to `amount` credits worth of crystal from a tile.
 * Returns how much was taken and whether the tile's terrain changed
 * (callers should mark the render tile dirty when it did).
 */
export function depleteCrystal(
  map: MapData,
  tx: number,
  ty: number,
  amount: number,
): { taken: number; terrainChanged: boolean } {
  if (!inBounds(tx, ty)) return { taken: 0, terrainChanged: false };
  const i = tileIndex(tx, ty);
  const have = map.crystal[i] as number;
  if (have <= 0) return { taken: 0, terrainChanged: false };
  const taken = Math.min(have, amount);
  const left = have - taken;
  map.crystal[i] = left;
  if (left <= 0) {
    map.terrain[i] = Terrain.Sand;
    map.passable[i] = 1;
    map.buildable[i] = 1;
    return { taken, terrainChanged: true };
  }
  return { taken, terrainChanged: false };
}

/** Sum of remaining crystal across the map (debug / AI economy heuristics). */
export function totalCrystal(map: MapData): number {
  let total = 0;
  for (let i = 0; i < map.crystal.length; i++) total += map.crystal[i] as number;
  return total;
}
