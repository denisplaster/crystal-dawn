/**
 * Procedural pixel-art sprite factory.
 *
 * Everything is drawn into cached offscreen canvases at boot — no binary
 * assets. Style: chunky 90s-RTS pixel art on a muted military palette, drawn in
 * 2x2 "pixel" blocks so a 24px tile reads as a 12x12 pixel sprite.
 *
 * Sprite generation uses its own seeded RNG (art is deterministic but is not
 * part of the simulation).
 */

import { makeRng, type Rng } from '../engine/rng';
import { Terrain, TERRAIN_COUNT, TERRAIN_VARIANTS, TILE } from '../game/constants';
import {
  BUILDING_TYPES,
  BUILDING_TYPE_IDS,
  UNIT_TYPES,
  UNIT_TYPE_IDS,
  type BuildingTypeId,
  type UnitTypeId,
} from '../game/rules';

/** Size of one chunky art pixel, in device-independent px. */
export const PX = 2;
/** Tile is PX_PER_TILE art-pixels square. */
const PX_PER_TILE = TILE / PX; // 12

const SPRITE_SEED = 0x5c0de;

type Canvas = HTMLCanvasElement;

function makeCanvas(w: number, h: number): { canvas: Canvas; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

/** Fill a chunky pixel block at art-pixel coordinates. */
function blk(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, w = 1, h = 1): void {
  ctx.fillStyle = color;
  ctx.fillRect(x * PX, y * PX, w * PX, h * PX);
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * A terrain colour ramp. C2 turns the single Phase 1 table into one table per
 * era (`EraDef.paletteKey`), so 1917 mud, a 1943 winter, the 1991 desert and
 * 2077's mineral wastes are the *same drawers* run on different colours plus a
 * small per-style flourish pass.
 *
 * `crystal*` is deliberately near-constant across every palette: crystal is the
 * economy and must read as crystal in every era. Only the ground it sits on and
 * the strength of its glow move.
 */
export interface TerrainPalette {
  grassBase: string;
  grassLight: string;
  grassDark: string;
  grassTuft: string;

  sandBase: string;
  sandLight: string;
  sandDark: string;
  sandRipple: string;

  rockGround: string;
  rockBody: string;
  rockLight: string;
  rockShadow: string;

  cliffTop: string;
  cliffLight: string;
  cliffFace: string;
  cliffShadow: string;

  crystalGround: string;
  crystalDark: string;
  crystalBody: string;
  crystalLight: string;
  crystalHot: string;
  crystalGlow: string;
  /** Outer stop of the crystal glow gradient (always fully transparent). */
  crystalGlowEdge: string;

  /**
   * Extra pass run *after* every shared draw. `desert` is a no-op and makes no
   * RNG draws at all, which is what keeps `siliconDesert` byte-identical to the
   * pre-C2 art.
   */
  style: 'desert' | 'mud' | 'winter' | 'neon';
  /** Flourish ink, used by the style pass. */
  styleLight: string;
  styleDark: string;
}

/** 1991 — the shipped ramp, unchanged to the byte. */
const C: TerrainPalette = {
  grassBase: '#42502e',
  grassLight: '#4c5c38',
  grassDark: '#374428',
  grassTuft: '#5b6d41',

  sandBase: '#96865b',
  sandLight: '#a89769',
  sandDark: '#7f7049',
  sandRipple: '#b3a377',

  rockGround: '#57513f',
  rockBody: '#77705f',
  rockLight: '#8e8776',
  rockShadow: '#3a352a',

  cliffTop: '#6d6754',
  cliffLight: '#877f6a',
  cliffFace: '#4a4538',
  cliffShadow: '#2c2921',

  crystalGround: '#2a3326',
  crystalDark: '#1d5c31',
  crystalBody: '#3fbf5f',
  crystalLight: '#7cf09a',
  crystalHot: '#d8ffe6',
  crystalGlow: 'rgba(90, 240, 130, 0.16)',
  crystalGlowEdge: 'rgba(90, 240, 130, 0)',

  style: 'desert',
  styleLight: '#b3a377',
  styleDark: '#3a352a',
};

/** 1917 — churned brown, standing water, shell-pocked grass. */
const TRENCH_MUD: TerrainPalette = {
  grassBase: '#46482c',
  grassLight: '#525436',
  grassDark: '#343722',
  grassTuft: '#68703f',

  sandBase: '#6d5c3e',
  sandLight: '#7d6b4a',
  sandDark: '#584931',
  sandRipple: '#8a7855',

  rockGround: '#4a4436',
  rockBody: '#6d6553',
  rockLight: '#847b66',
  rockShadow: '#302b21',

  cliffTop: '#5e5744',
  cliffLight: '#79705a',
  cliffFace: '#413a2d',
  cliffShadow: '#28241b',

  crystalGround: '#2b2c20',
  crystalDark: '#1d5c31',
  crystalBody: '#3fbf5f',
  crystalLight: '#7cf09a',
  crystalHot: '#d8ffe6',
  crystalGlow: 'rgba(90, 240, 130, 0.14)',
  crystalGlowEdge: 'rgba(90, 240, 130, 0)',

  style: 'mud',
  styleLight: '#5d5a3e', // standing water in a crater
  styleDark: '#241f14', // churned earth
};

/** 1943 — frost, pale grey-green, snow lying on the rock. */
const STEEL_WINTER: TerrainPalette = {
  grassBase: '#4d564a',
  grassLight: '#5e6759',
  grassDark: '#3c443b',
  grassTuft: '#7d8a78',

  sandBase: '#a6ada7',
  sandLight: '#c0c6c0',
  sandDark: '#8b918c',
  sandRipple: '#d9ddd8',

  rockGround: '#555b57',
  rockBody: '#787e7b',
  rockLight: '#9ba19d',
  rockShadow: '#373b39',

  cliffTop: '#6d7370',
  cliffLight: '#a5aba8',
  cliffFace: '#494e4c',
  cliffShadow: '#2b2e2d',

  crystalGround: '#2c3630',
  crystalDark: '#1d5c31',
  crystalBody: '#3fbf5f',
  crystalLight: '#8ef2a8',
  crystalHot: '#e6fff0',
  crystalGlow: 'rgba(120, 245, 165, 0.16)',
  crystalGlowEdge: 'rgba(120, 245, 165, 0)',

  style: 'winter',
  styleLight: '#e8eeea', // lying snow
  styleDark: '#6e7673', // wind-scoured ground
};

/** 2077 — dark ground under a teal/violet mineral cast; the crystal burns. */
const FUTURE_NEON: TerrainPalette = {
  grassBase: '#2b3138',
  grassLight: '#353d46',
  grassDark: '#1f242a',
  grassTuft: '#3f6068',

  sandBase: '#3a3947',
  sandLight: '#474657',
  sandDark: '#2c2c37',
  sandRipple: '#585670',

  rockGround: '#2a2f3a',
  rockBody: '#454c5c',
  rockLight: '#5f6678',
  rockShadow: '#191c24',

  cliffTop: '#3a4152',
  cliffLight: '#555f76',
  cliffFace: '#262b36',
  cliffShadow: '#14171e',

  crystalGround: '#17202a',
  crystalDark: '#17663c',
  crystalBody: '#4ee070',
  crystalLight: '#9cffb8',
  crystalHot: '#f0fff5',
  crystalGlow: 'rgba(110, 255, 165, 0.30)',
  crystalGlowEdge: 'rgba(110, 255, 165, 0)',

  style: 'neon',
  styleLight: '#59f0d0', // teal mineral glint
  styleDark: '#7b5bd6', // violet vein
};

/** Palette ids, matching `EraDef.paletteKey` exactly. */
export type TerrainPaletteKey = 'trenchMud' | 'steelWinter' | 'siliconDesert' | 'futureNeon';

export const TERRAIN_PALETTE_KEYS: readonly TerrainPaletteKey[] = [
  'trenchMud',
  'steelWinter',
  'siliconDesert',
  'futureNeon',
];

const TERRAIN_PALETTES: Record<TerrainPaletteKey, TerrainPalette> = {
  trenchMud: TRENCH_MUD,
  steelWinter: STEEL_WINTER,
  siliconDesert: C,
  futureNeon: FUTURE_NEON,
};

function isPaletteKey(v: string): v is TerrainPaletteKey {
  return v === 'trenchMud' || v === 'steelWinter' || v === 'siliconDesert' || v === 'futureNeon';
}

// ---------------------------------------------------------------------------
// Terrain tiles
// ---------------------------------------------------------------------------

/**
 * Per-era flourish, run after the shared drawing. It is the *last* thing on the
 * tile and only draws (and only pulls RNG) for a non-desert style, so silicon's
 * random stream — and therefore its pixels — are exactly the pre-C2 ones.
 */
function terrainStyle(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  p: TerrainPalette,
  kind: 'ground' | 'rock',
): void {
  switch (p.style) {
    case 'desert':
      return;

    case 'mud': {
      // Shell craters: a dark churned ring with water standing in the bottom.
      const holes = kind === 'ground' ? rng.intRange(1, 2) : 1;
      for (let i = 0; i < holes; i++) {
        const r = rng.intRange(2, 3);
        const x = rng.intRange(r, PX_PER_TILE - r - 1);
        const y = rng.intRange(r, PX_PER_TILE - r - 1);
        blk(ctx, x - r, y - 1, p.styleDark, r * 2, 2);
        blk(ctx, x - r + 1, y - r + 1, p.styleDark, r * 2 - 2, 1);
        blk(ctx, x - r + 1, y + r - 2, p.styleDark, r * 2 - 2, 1);
        blk(ctx, x - r + 1, y - 1, p.styleLight, r * 2 - 2, 1);
      }
      return;
    }

    case 'winter': {
      // Wind-driven snow: a couple of drifts plus loose flecks.
      const drifts = kind === 'rock' ? rng.intRange(2, 3) : rng.intRange(1, 2);
      for (let i = 0; i < drifts; i++) {
        const w = rng.intRange(3, 5);
        const x = rng.intRange(0, PX_PER_TILE - w);
        const y = rng.intRange(0, PX_PER_TILE - 1);
        blk(ctx, x, y, p.styleLight, w, 1);
        blk(ctx, x + 1, y + 1, p.styleDark, Math.max(1, w - 2), 1);
      }
      for (let i = 0; i < 5; i++) {
        blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), p.styleLight);
      }
      return;
    }

    case 'neon': {
      // Mineral glints: single teal/violet pixels, a vein or two on rock.
      const glints = kind === 'rock' ? 5 : 3;
      for (let i = 0; i < glints; i++) {
        blk(
          ctx,
          rng.int(PX_PER_TILE),
          rng.int(PX_PER_TILE),
          i % 2 === 0 ? p.styleLight : p.styleDark,
        );
      }
      if (kind === 'rock') {
        const x = rng.intRange(1, PX_PER_TILE - 2);
        const y = rng.intRange(1, PX_PER_TILE - 4);
        blk(ctx, x, y, p.styleDark, 1, rng.intRange(2, 3));
      }
      return;
    }
  }
}

function drawGrass(ctx: CanvasRenderingContext2D, rng: Rng, p: TerrainPalette): void {
  ctx.fillStyle = p.grassBase;
  ctx.fillRect(0, 0, TILE, TILE);
  for (let i = 0; i < 22; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), p.grassLight);
  }
  for (let i = 0; i < 16; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), p.grassDark);
  }
  // A couple of scrub tufts.
  const tufts = rng.intRange(1, 3);
  for (let i = 0; i < tufts; i++) {
    const x = rng.intRange(1, PX_PER_TILE - 2);
    const y = rng.intRange(1, PX_PER_TILE - 3);
    blk(ctx, x, y, p.grassTuft);
    blk(ctx, x, y + 1, p.grassTuft);
    blk(ctx, x + 1, y + 1, p.grassDark);
  }
  terrainStyle(ctx, rng, p, 'ground');
}

function drawSand(ctx: CanvasRenderingContext2D, rng: Rng, p: TerrainPalette): void {
  ctx.fillStyle = p.sandBase;
  ctx.fillRect(0, 0, TILE, TILE);
  for (let i = 0; i < 20; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), p.sandLight);
  }
  for (let i = 0; i < 14; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), p.sandDark);
  }
  // Wind ripples.
  const ripples = rng.intRange(1, 2);
  for (let i = 0; i < ripples; i++) {
    const y = rng.intRange(1, PX_PER_TILE - 2);
    const x = rng.intRange(0, PX_PER_TILE - 4);
    blk(ctx, x, y, p.sandRipple, 3, 1);
    blk(ctx, x + 1, y + 1, p.sandDark, 2, 1);
  }
  terrainStyle(ctx, rng, p, 'ground');
}

function drawRock(ctx: CanvasRenderingContext2D, rng: Rng, p: TerrainPalette): void {
  ctx.fillStyle = p.rockGround;
  ctx.fillRect(0, 0, TILE, TILE);
  for (let i = 0; i < 12; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), p.rockShadow);
  }
  const boulders = rng.intRange(3, 5);
  for (let i = 0; i < boulders; i++) {
    const w = rng.intRange(3, 5);
    const h = rng.intRange(2, 4);
    const x = rng.intRange(0, PX_PER_TILE - w);
    const y = rng.intRange(0, PX_PER_TILE - h);
    blk(ctx, x, y + h, p.rockShadow, w, 1); // ground shadow
    blk(ctx, x, y, p.rockBody, w, h);
    blk(ctx, x, y, p.rockLight, w - 1, 1); // lit top
    blk(ctx, x + w - 1, y + 1, p.rockShadow, 1, h - 1); // right face
  }
  terrainStyle(ctx, rng, p, 'rock');
}

function drawCliff(ctx: CanvasRenderingContext2D, rng: Rng, p: TerrainPalette): void {
  ctx.fillStyle = p.cliffFace;
  ctx.fillRect(0, 0, TILE, TILE);
  // Blocky plateau top with a lit rim and a heavy drop shadow.
  blk(ctx, 0, 0, p.cliffTop, PX_PER_TILE, PX_PER_TILE - 2);
  blk(ctx, 0, 0, p.cliffLight, PX_PER_TILE, 1);
  blk(ctx, 0, PX_PER_TILE - 2, p.cliffFace, PX_PER_TILE, 1);
  blk(ctx, 0, PX_PER_TILE - 1, p.cliffShadow, PX_PER_TILE, 1);
  // Fissures.
  const cracks = rng.intRange(2, 4);
  for (let i = 0; i < cracks; i++) {
    const x = rng.intRange(1, PX_PER_TILE - 2);
    const y = rng.intRange(1, PX_PER_TILE - 4);
    const len = rng.intRange(2, 4);
    blk(ctx, x, y, p.cliffShadow, 1, len);
    blk(ctx, x + 1, y, p.cliffLight, 1, 1);
  }
  terrainStyle(ctx, rng, p, 'rock');
}

function drawCrystal(ctx: CanvasRenderingContext2D, rng: Rng, p: TerrainPalette): void {
  ctx.fillStyle = p.crystalGround;
  ctx.fillRect(0, 0, TILE, TILE);
  for (let i = 0; i < 10; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), p.crystalDark);
  }

  // Soft green glow behind the shards.
  const glow = ctx.createRadialGradient(TILE / 2, TILE / 2, 1, TILE / 2, TILE / 2, TILE * 0.7);
  glow.addColorStop(0, p.crystalGlow);
  glow.addColorStop(1, p.crystalGlowEdge);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, TILE, TILE);

  // Shard clusters: a stepped triangle with a hot core.
  const shards = rng.intRange(4, 6);
  for (let i = 0; i < shards; i++) {
    const h = rng.intRange(3, 5);
    const x = rng.intRange(1, PX_PER_TILE - 3);
    const y = rng.intRange(2, PX_PER_TILE - h - 1);
    for (let row = 0; row < h; row++) {
      const w = Math.max(1, Math.round(((row + 1) / h) * 3));
      const rx = x - Math.floor((w - 1) / 2);
      blk(ctx, rx, y + row, p.crystalBody, w, 1);
    }
    blk(ctx, x, y, p.crystalHot); // tip
    blk(ctx, x, y + 1, p.crystalLight);
    blk(ctx, x - 1, y + h - 1, p.crystalDark);
    blk(ctx, x + 1, y + h - 1, p.crystalDark);
  }
  // Crystal keeps its own style pass off: the shards must read identically in
  // every era (they are the economy), and snow/mud on top of them muddies that.
}

const TERRAIN_DRAWERS: Record<
  number,
  (ctx: CanvasRenderingContext2D, rng: Rng, p: TerrainPalette) => void
> = {
  [Terrain.Grass]: drawGrass,
  [Terrain.Sand]: drawSand,
  [Terrain.Rock]: drawRock,
  [Terrain.Cliff]: drawCliff,
  [Terrain.Crystal]: drawCrystal,
};

/**
 * One built terrain set per palette (terrainIndex * TERRAIN_VARIANTS + variant),
 * so switching era swaps a cache entry rather than re-rasterising. Built lazily:
 * a silicon-only session never pays for the other three.
 */
const terrainSets = new Map<TerrainPaletteKey, Canvas[]>();
let activePalette: TerrainPaletteKey = 'siliconDesert';
let spriteSeed = SPRITE_SEED;

function buildTerrainSet(key: TerrainPaletteKey): Canvas[] {
  const p = TERRAIN_PALETTES[key];
  const set: Canvas[] = [];
  for (let t = 0; t < TERRAIN_COUNT; t++) {
    for (let v = 0; v < TERRAIN_VARIANTS; v++) {
      const { canvas, ctx } = makeCanvas(TILE, TILE);
      const rng = makeRng((spriteSeed + t * 977 + v * 31) >>> 0);
      const draw = TERRAIN_DRAWERS[t];
      if (draw) draw(ctx, rng, p);
      set.push(canvas);
    }
  }
  return set;
}

function terrainSet(key: TerrainPaletteKey): Canvas[] {
  let set = terrainSets.get(key);
  if (!set) {
    set = buildTerrainSet(key);
    terrainSets.set(key, set);
  }
  return set;
}

/**
 * Select the era's terrain ramp. Returns true when the palette actually changed,
 * which is the caller's cue that the composited terrain layer is now stale (see
 * `main.ts`: `setTerrainPalette(...)` then `renderer.buildTerrain(...)`).
 *
 * Unknown keys fall back to the shipped desert rather than throwing — a new era
 * with a typo'd `paletteKey` should look wrong, not crash.
 */
export function setTerrainPalette(key: string): boolean {
  const next: TerrainPaletteKey = isPaletteKey(key) ? key : 'siliconDesert';
  if (next === activePalette) return false;
  activePalette = next;
  return true;
}

/** The palette the terrain cache is currently serving. */
export function terrainPaletteKey(): TerrainPaletteKey {
  return activePalette;
}

/** The active ramp itself, for anything that must match the ground (minimap). */
export function terrainPalette(key: TerrainPaletteKey = activePalette): TerrainPalette {
  return TERRAIN_PALETTES[key];
}

/** Build (or rebuild) every cached sprite. Safe to call once at boot. */
export function initSprites(seed = SPRITE_SEED): void {
  spriteSeed = seed;
  terrainSets.clear();
  // Eagerly build the palette in use, exactly as Phase 1 did; the other three
  // are built the first time an era asks for them.
  terrainSets.set(activePalette, buildTerrainSet(activePalette));
  unitCache.clear();
  buildingCache.clear();
  iconCache.clear();
  fxCache.clear();
}

export function getTerrainSprite(terrain: Terrain, variant: number): Canvas {
  const t = terrain % TERRAIN_COUNT;
  const v = variant % TERRAIN_VARIANTS;
  return terrainSet(activePalette)[t * TERRAIN_VARIANTS + v] as Canvas;
}

// ---------------------------------------------------------------------------
// Entity art (Phase 6)
//
// Units are described once, in *body space* (a list of axis-aligned rectangles
// with +x pointing forward), and rasterised into the 2px art grid at each of
// the 16 cached facings. Rotating the description rather than the bitmap keeps
// every facing crisply on-grid — no smeared drawImage-rotate.
//
// Turreted types get a separate turret sprite so the renderer can composite
// hull(facing) + turret(turretFacing).
// ---------------------------------------------------------------------------

/** Number of quantised facing directions used by cached sprites. */
export const FACINGS = 16;

/** Radians -> cached facing bucket. */
export function facingIndex(facing: number): number {
  const step = (Math.PI * 2) / FACINGS;
  return ((Math.round(facing / step) % FACINGS) + FACINGS) % FACINGS;
}

/** Per-player house colours. Player 0 = Coalition (gold/olive), 1 = Order (crimson/slate). */
export interface Scheme {
  hull: string;
  hullLight: string;
  hullDark: string;
  accent: string;
  accentDark: string;
  outline: string;
  glass: string;
  track: string;
  barrel: string;
  cloth: string;
  clothDark: string;
}

export const SCHEMES: readonly [Scheme, Scheme] = [
  {
    hull: '#7d8350',
    hullLight: '#9ba268',
    hullDark: '#535838',
    accent: '#e0b53c',
    accentDark: '#9c7a1c',
    outline: '#191c12',
    glass: '#7fb0d8',
    track: '#2a2b21',
    barrel: '#41443a',
    cloth: '#6f7546',
    clothDark: '#4a4e2c',
  },
  {
    hull: '#5c626b',
    hullLight: '#7b828d',
    hullDark: '#3b4046',
    accent: '#c8402c',
    accentDark: '#8a2618',
    outline: '#141519',
    glass: '#8fb8d8',
    track: '#22242a',
    barrel: '#383b41',
    cloth: '#535962',
    clothDark: '#383c43',
  },
];

export function schemeFor(player: number): Scheme {
  return SCHEMES[player === 1 ? 1 : 0] as Scheme;
}

/** One body-space rectangle, in art pixels, origin at the sprite centre. */
interface Shape {
  x: number;
  y: number;
  w: number;
  h: number;
  c: string;
}

const S = (x: number, y: number, w: number, h: number, c: string): Shape => ({ x, y, w, h, c });

/** Canvas size (art px) that fits every rotation of `shapes` plus outline/shadow. */
function requiredDim(shapes: readonly Shape[], min = 10): number {
  let r = 0;
  for (const s of shapes) {
    for (const x of [s.x, s.x + s.w]) {
      for (const y of [s.y, s.y + s.h]) r = Math.max(r, Math.hypot(x, y));
    }
  }
  let d = Math.max(min, Math.ceil(r * 2) + 4);
  if (d % 2 === 1) d += 1;
  return d;
}

const SHADOW = 'rgba(0,0,0,0.34)';

/**
 * Rasterise a body-space shape list at `angle`. One pass fills a coverage map
 * (topmost shape wins per pixel); the drop shadow and the 1px dark outline are
 * then derived from that map, so the whole sprite costs dim^2 * shapes.
 */
function rasterizeBody(shapes: readonly Shape[], angle: number, outline: string): Canvas {
  const dim = requiredDim(shapes);
  const { canvas, ctx } = makeCanvas(dim * PX, dim * PX);
  const cov = new Int16Array(dim * dim).fill(-1);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const c = dim / 2;

  for (let py = 0; py < dim; py++) {
    const sy = py - c + 0.5;
    for (let px = 0; px < dim; px++) {
      const sx = px - c + 0.5;
      // Inverse-rotate the pixel centre into body space.
      const bx = sx * cos + sy * sin;
      const by = -sx * sin + sy * cos;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i] as Shape;
        if (bx >= s.x && bx < s.x + s.w && by >= s.y && by < s.y + s.h) {
          cov[py * dim + px] = i;
          break;
        }
      }
    }
  }

  // Drop shadow: body silhouette offset one art pixel down-right.
  ctx.fillStyle = SHADOW;
  for (let py = 0; py < dim - 1; py++) {
    for (let px = 0; px < dim - 1; px++) {
      if ((cov[py * dim + px] as number) < 0) continue;
      if ((cov[(py + 1) * dim + px + 1] as number) >= 0) continue;
      ctx.fillRect((px + 1) * PX, (py + 1) * PX, PX, PX);
    }
  }

  // Hard outline: uncovered pixels orthogonally touching the silhouette.
  ctx.fillStyle = outline;
  for (let py = 0; py < dim; py++) {
    for (let px = 0; px < dim; px++) {
      if ((cov[py * dim + px] as number) >= 0) continue;
      const near =
        (px > 0 && (cov[py * dim + px - 1] as number) >= 0) ||
        (px < dim - 1 && (cov[py * dim + px + 1] as number) >= 0) ||
        (py > 0 && (cov[(py - 1) * dim + px] as number) >= 0) ||
        (py < dim - 1 && (cov[(py + 1) * dim + px] as number) >= 0);
      if (near) ctx.fillRect(px * PX, py * PX, PX, PX);
    }
  }

  // Body.
  for (let py = 0; py < dim; py++) {
    for (let px = 0; px < dim; px++) {
      const i = cov[py * dim + px] as number;
      if (i < 0) continue;
      ctx.fillStyle = (shapes[i] as Shape).c;
      ctx.fillRect(px * PX, py * PX, PX, PX);
    }
  }

  return canvas;
}

// --- unit body descriptions -------------------------------------------------

/** Crystal ore colours reused for harvester cargo / refinery hoppers. */
const ORE = {
  dark: C.crystalDark,
  body: C.crystalBody,
  light: C.crystalLight,
  hot: C.crystalHot,
} as const;

const MUZZLE_DARK = '#17190f';

// --- C2 era materials -------------------------------------------------------
// House-independent *materials*, so an era reads by silhouette and surface while
// the scheme keeps carrying the faction trim (gold/olive vs crimson/slate).
// Used sparingly — never on more than a corner of a sprite.

/** 1917: riveted iron plate, timber and mud-caked webbing. */
const IRON = '#3c3930';
const IRON_LIGHT = '#585340';
const WOOD = '#7a5c34';
const WOOD_DARK = '#4d3a20';
/** 1943: gunmetal barrels and a streak of winter whitewash. */
const GUNMETAL = '#2f332d';
const WHITEWASH = '#c3c8bd';
/** 2077: the energy palette. Teal is plasma, violet is phase/laser. */
const NEON_TEAL = '#5fd8ff';
const NEON_HOT = '#6ff0d8';
const NEON_VIOLET = '#b46bff';
const NEON_PALE = '#e2c8ff';
const LASER_PALE = '#d6fbff';
/** Dimmed lift-cushion teal, so a hover skirt does not read as a selection box. */
const HOVER_GLOW = '#2e8ba8';
const MECH_HOT = '#ff8a4c';

function infantryBase(sc: Scheme): Shape[] {
  return [
    S(-2, -2, 4, 4, sc.cloth), // torso
    S(-2, -3, 4, 1, sc.clothDark), // left arm
    S(-2, 2, 4, 1, sc.clothDark), // right arm
    S(-1, -1, 2, 2, sc.hullDark), // helmet
    S(-1, -1, 2, 1, sc.hullLight), // helmet highlight
  ];
}

function unitShapes(type: UnitTypeId, sc: Scheme, loaded: boolean): Shape[] {
  switch (type) {
    case 'minigunner':
      return [
        S(-4, -1, 2, 2, sc.clothDark), // webbing pack
        ...infantryBase(sc),
        S(-2, -2, 1, 2, sc.accent), // house flash
        S(1, -1, 4, 1, sc.barrel), // minigun
        S(5, -1, 1, 1, MUZZLE_DARK),
      ];

    case 'rocketSoldier':
      return [
        S(-4, -2, 3, 4, sc.hullDark), // reload tubes on the back
        S(-4, -2, 3, 1, sc.hullLight),
        ...infantryBase(sc),
        S(-2, 2, 1, 1, sc.accent),
        S(0, -2, 5, 2, sc.barrel), // launcher tube over the shoulder
        S(5, -2, 2, 2, sc.accent), // warhead
      ];

    case 'engineer':
      return [
        S(-4, -1, 2, 3, sc.hullDark), // toolbox
        S(-4, -1, 2, 1, '#b9bda2'),
        S(-2, -2, 4, 4, '#e8d24a'), // hi-vis vest
        S(-2, -1, 4, 1, '#2b2e1c'), // vest stripe
        S(-2, -3, 4, 1, sc.cloth),
        S(-2, 2, 4, 1, sc.cloth),
        S(-1, -1, 2, 2, '#eef0e4'), // white hard hat
        S(-1, -1, 2, 1, sc.accent),
        S(2, -1, 3, 1, '#b9bda2'), // wrench
      ];

    case 'harvester': {
      const shapes: Shape[] = [
        S(-6, -5, 13, 1, sc.track),
        S(-6, 4, 13, 1, sc.track),
        S(-5, -5, 1, 1, sc.hullDark),
        S(-2, -5, 1, 1, sc.hullDark),
        S(1, -5, 1, 1, sc.hullDark),
        S(4, -5, 1, 1, sc.hullDark),
        S(-5, 4, 1, 1, sc.hullDark),
        S(-2, 4, 1, 1, sc.hullDark),
        S(1, 4, 1, 1, sc.hullDark),
        S(4, 4, 1, 1, sc.hullDark),
        S(-6, -4, 13, 8, sc.hullDark), // chassis
        S(-6, -4, 8, 8, sc.hull), // ore bin
        S(-6, -4, 8, 1, sc.hullLight),
        S(-4, -4, 1, 8, sc.hullDark), // bin ribs
        S(-1, -4, 1, 8, sc.hullDark),
        S(-6, -4, 1, 8, sc.accent), // tail gate
        S(2, -3, 4, 6, sc.hullLight), // cab
        S(2, -3, 4, 1, sc.accent),
        S(4, -2, 2, 4, sc.glass),
        S(6, -5, 1, 10, sc.barrel), // intake arm
        S(7, -5, 1, 10, sc.hullDark), // teeth
      ];
      if (loaded) {
        shapes.push(
          S(-5, -3, 6, 6, ORE.dark),
          S(-4, -2, 4, 4, ORE.body),
          S(-4, -2, 4, 1, ORE.light),
          S(-3, -1, 2, 2, ORE.hot), // cargo glow
        );
      }
      return shapes;
    }

    case 'buggy':
      return [
        S(-4, -4, 3, 2, sc.track), // wheels
        S(-4, 2, 3, 2, sc.track),
        S(1, -4, 3, 2, sc.track),
        S(1, 2, 3, 2, sc.track),
        S(-5, -3, 10, 6, sc.hull), // chassis
        S(-5, -3, 10, 1, sc.hullLight),
        S(-5, -2, 1, 4, sc.hullDark), // tail
        S(-2, -3, 2, 6, sc.hullDark), // roll bar
        S(0, -2, 2, 4, sc.clothDark), // crew
        S(4, -2, 2, 4, sc.accent), // nose
      ];

    case 'lightTank':
      return [
        S(-6, -5, 12, 2, sc.track),
        S(-6, 3, 12, 2, sc.track),
        S(-5, -5, 1, 2, sc.hullDark),
        S(-2, -5, 1, 2, sc.hullDark),
        S(1, -5, 1, 2, sc.hullDark),
        S(4, -5, 1, 2, sc.hullDark),
        S(-5, 3, 1, 2, sc.hullDark),
        S(-2, 3, 1, 2, sc.hullDark),
        S(1, 3, 1, 2, sc.hullDark),
        S(4, 3, 1, 2, sc.hullDark),
        S(-6, -3, 11, 6, sc.hull),
        S(-6, -3, 11, 1, sc.hullLight),
        S(4, -3, 2, 6, sc.hullLight), // glacis
        S(-6, -2, 3, 4, sc.hullDark), // engine deck
        S(-6, -3, 1, 6, sc.accent),
      ];

    case 'mediumTank':
      return [
        S(-7, -6, 14, 2, sc.track),
        S(-7, 4, 14, 2, sc.track),
        S(-6, -6, 1, 2, sc.hullDark),
        S(-3, -6, 1, 2, sc.hullDark),
        S(0, -6, 1, 2, sc.hullDark),
        S(3, -6, 1, 2, sc.hullDark),
        S(-6, 4, 1, 2, sc.hullDark),
        S(-3, 4, 1, 2, sc.hullDark),
        S(0, 4, 1, 2, sc.hullDark),
        S(3, 4, 1, 2, sc.hullDark),
        S(-7, -4, 13, 8, sc.hull),
        S(-7, -4, 13, 1, sc.hullLight),
        S(4, -4, 2, 8, sc.hullLight), // glacis
        S(-7, -3, 4, 6, sc.hullDark), // engine grill
        S(-7, -2, 4, 1, sc.hull),
        S(-7, 0, 4, 1, sc.hull),
        S(-7, -4, 1, 8, sc.accent),
      ];

    case 'artillery':
      return [
        S(-10, -5, 1, 3, sc.hullDark), // spade pads
        S(-10, 2, 1, 3, sc.hullDark),
        S(-9, -4, 4, 2, sc.barrel), // spade legs
        S(-9, 2, 4, 2, sc.barrel),
        S(-5, -5, 10, 2, sc.track),
        S(-5, 3, 10, 2, sc.track),
        S(-4, -5, 1, 2, sc.hullDark),
        S(-1, -5, 1, 2, sc.hullDark),
        S(2, -5, 1, 2, sc.hullDark),
        S(-4, 3, 1, 2, sc.hullDark),
        S(-1, 3, 1, 2, sc.hullDark),
        S(2, 3, 1, 2, sc.hullDark),
        S(-5, -3, 10, 6, sc.hull),
        S(-5, -3, 10, 1, sc.hullLight),
        S(-5, -3, 1, 6, sc.accent),
        S(-1, -2, 3, 4, sc.hullDark), // trunnion
        S(1, -2, 3, 4, sc.hullLight), // recoil sleeve
        S(4, -1, 7, 2, sc.barrel), // long barrel
        S(11, -2, 2, 4, '#2a2c22'), // muzzle brake
      ];

    // V2 — the gunship. Silhouette is deliberately unlike anything on the
    // ground: a slim fuselage with a bubble canopy well forward, stub wings
    // carrying two rocket pods, and a tall tail fin. The main rotor is a
    // separate cached sprite (it spins independently of the airframe).
    case 'gunship':
      return [
        S(-8, -1, 3, 2, sc.hullDark), // tail boom
        S(-9, -4, 2, 4, sc.hullDark), // tail fin
        S(-9, -4, 2, 1, sc.accent),
        S(-3, -5, 3, 10, sc.hullDark), // wing spar
        S(-4, -6, 4, 2, sc.barrel), // port rocket pod
        S(-4, 4, 4, 2, sc.barrel), // starboard rocket pod
        S(0, -6, 1, 2, MUZZLE_DARK),
        S(0, 4, 1, 2, MUZZLE_DARK),
        S(-6, -3, 13, 6, sc.hull), // fuselage
        S(-6, -3, 13, 1, sc.hullLight),
        S(-6, 2, 13, 1, sc.hullDark),
        S(-6, -3, 1, 6, sc.accent), // house stripe
        S(-2, -3, 2, 6, sc.hullDark), // engine housing
        S(3, -2, 3, 4, sc.glass), // canopy
        S(6, -2, 2, 4, sc.hullLight), // nose
      ];

    // =====================================================================
    // C2 — era rosters. Silhouette and materials carry the era; the house
    // scheme still carries the faction (olive/gold vs slate/crimson trim), so
    // the readability rules from Phase 6 hold in all four time periods.
    // =====================================================================

    // --- 1917: canvas, timber and riveted iron ----------------------------

    /** Greatcoated infantryman under a soup-plate helmet, bolt rifle at port. */
    case 'rifleman':
      return [
        S(-5, -1.5, 2, 3, sc.clothDark), // haversack
        S(-4, -2.5, 3, 5, sc.clothDark), // rolled blanket
        S(-3.5, -3, 6, 6, sc.clothDark), // greatcoat skirt, flaring behind
        S(-2, -2, 4, 4, sc.cloth), // torso
        S(-2, -3, 4, 1, sc.clothDark), // arms
        S(-2, 2, 4, 1, sc.clothDark),
        S(-2, -2, 1, 4, sc.accent), // shoulder flash
        S(-2.5, -2, 5, 4, IRON), // helmet brim (the soup plate)
        S(-1, -1.5, 2, 3, sc.hullDark), // dome
        S(-1, -1.5, 2, 1, sc.hullLight),
        S(-0.5, -2, 2, 1, sc.clothDark), // hands on the fore-end
        S(0, -1, 5, 1, WOOD), // rifle stock
        S(3, -1, 3, 1, sc.barrel), // barrel
        S(6, -1, 1, 1, MUZZLE_DARK),
        S(2, 0, 1, 1, IRON_LIGHT), // bolt handle
      ];

    /**
     * Stormtrooper: hunched, coal-scuttle helmet, a bag of stick grenades on
     * the chest and one cocked back ready to throw.
     */
    case 'stormtrooper':
      return [
        S(-6, -2.5, 3, 5, sc.hullDark), // satchel bundle
        S(-6, -2.5, 3, 1, sc.accentDark),
        S(-6, 0, 3, 1, IRON),
        S(-3.5, -2.5, 4, 5, sc.clothDark), // hunched back
        S(-2, -2, 4, 4, sc.cloth), // torso
        S(-2, -3, 4, 1, sc.clothDark),
        S(-1.5, 2, 4, 1, sc.clothDark),
        S(-1, -2, 3, 1, sc.accent), // chest bandolier
        S(-2, -2, 3.5, 4, IRON), // deep helmet + neck guard
        S(-0.5, -1.5, 2, 3, sc.hullDark),
        S(-0.5, -1.5, 2, 1, sc.hullLight),
        S(-1, -5, 2, 2.5, sc.cloth), // arm cocked back and out
        S(-1.5, -6.5, 1.5, 2, WOOD), // stick grenade handle
        S(-2, -8, 2.5, 2, IRON_LIGHT), // grenade head
        S(1.5, 1, 3, 2, WOOD_DARK), // trench club in the off hand
        S(4, 1.5, 1, 1, IRON),
      ];

    /**
     * Landship: the lozenge. Tracks run right around a rhomboid frame that
     * tapers at both ends, a sponson gun bulges from each flank, and a steering
     * tail trails off the back. Nothing else on any battlefield looks like it.
     */
    case 'landship':
      return [
        S(-13, -1, 3, 2, IRON), // steering tail
        S(-13.5, -2, 1, 4, sc.track),
        // Rhomboid track frame: full-length rails, drawn in from both ends.
        S(-10, -7, 20, 2.5, sc.track),
        S(-10, 4.5, 20, 2.5, sc.track),
        S(-11.5, -5.5, 2, 11, sc.track), // rear curve
        S(9.5, -5.5, 2, 11, sc.track), // front curve
        S(-11, -6, 1.5, 3, sc.track),
        S(-11, 3, 1.5, 3, sc.track),
        S(9, -6, 1.5, 3, sc.track),
        S(9, 3, 1.5, 3, sc.track),
        // Track links.
        S(-8, -7, 1, 2.5, IRON),
        S(-4, -7, 1, 2.5, IRON),
        S(0, -7, 1, 2.5, IRON),
        S(4, -7, 1, 2.5, IRON),
        S(8, -7, 1, 2.5, IRON),
        S(-8, 4.5, 1, 2.5, IRON),
        S(-4, 4.5, 1, 2.5, IRON),
        S(0, 4.5, 1, 2.5, IRON),
        S(4, 4.5, 1, 2.5, IRON),
        S(8, 4.5, 1, 2.5, IRON),
        // Riveted hull between the rails.
        S(-9, -4.5, 18, 9, sc.hull),
        S(-9, -4.5, 18, 1, sc.hullLight),
        S(-9, 3.5, 18, 1, sc.hullDark),
        S(-9, -4.5, 1, 9, sc.accent), // house plate at the rear
        S(-5, -4, 1, 8, IRON), // rivet strakes
        S(0, -4, 1, 8, IRON),
        S(5, -4, 1, 8, IRON),
        S(6, -3, 3, 6, sc.hullLight), // armoured nose
        // Side sponsons, one per flank, guns raked forward.
        S(0, -8, 6, 3.5, sc.hullDark),
        S(0, -8, 6, 1, sc.hullLight),
        S(0, 4.5, 6, 3.5, sc.hullDark),
        S(0, 6.5, 6, 1, IRON),
        S(5, -7.5, 5, 1.5, sc.barrel),
        S(10, -7.5, 1, 1.5, MUZZLE_DARK),
        S(5, 6, 5, 1.5, sc.barrel),
        S(10, 6, 1, 1.5, MUZZLE_DARK),
        S(-3, -2, 5, 4, sc.hullDark), // commander's cab
        S(-3, -2, 5, 1, sc.hullLight),
        S(-2, -1, 2, 2, IRON_LIGHT), // hatch
      ];

    /** Field gun: big spoked wheels, a crew shield and a long barrel. */
    case 'fieldgun':
      return [
        S(-11, -3.5, 5, 1.5, WOOD), // split trail legs
        S(-11, 2, 5, 1.5, WOOD),
        S(-11.5, -4, 1.5, 2, IRON), // spades
        S(-11.5, 2, 1.5, 2, IRON),
        S(-6, -1.5, 5, 3, WOOD_DARK), // trail box
        // Spoked wheels: a dark tyre with a light hub and cross spokes.
        S(-5, -7, 3.5, 5, IRON),
        S(-5, 2, 3.5, 5, IRON),
        S(-4.5, -6.5, 2.5, 4, sc.track),
        S(-4.5, 2.5, 2.5, 4, sc.track),
        S(-4.5, -4.8, 2.5, 0.8, IRON_LIGHT), // spokes
        S(-3.8, -6.5, 0.8, 4, IRON_LIGHT),
        S(-4.5, 4.2, 2.5, 0.8, IRON_LIGHT),
        S(-3.8, 2.5, 0.8, 4, IRON_LIGHT),
        S(-4, -5.2, 1.5, 1.5, sc.accent), // hub caps
        S(-4, 3.7, 1.5, 1.5, sc.accent),
        S(-4, -2.5, 7, 5, sc.hull), // carriage
        S(-4, -2.5, 7, 1, sc.hullLight),
        S(-4, -2.5, 1, 5, sc.accent),
        S(-1, -1.5, 4, 3, IRON), // cradle + recoil sleeve
        S(1, -5, 2.5, 10, sc.hullDark), // crew shield
        S(1, -5, 2.5, 1, sc.hullLight),
        S(1, 4, 2.5, 1, IRON),
        S(1.5, -1, 1.5, 2, IRON_LIGHT), // sighting slot
        S(3, -1, 8, 2, sc.barrel), // barrel
        S(11, -1.5, 2, 3, IRON), // muzzle
      ];

    // --- 1943: pressed steel, whitewash and gunmetal ----------------------

    /**
     * Rifle squad: three men on one base — a lead pair up front and a rifleman
     * covering behind, so it reads as a *section* rather than one soldier.
     */
    case 'riflesquad':
      return [
        // Rear man.
        S(-4.5, -1, 3.5, 3.5, sc.clothDark),
        S(-3.5, -0.5, 2, 2.5, sc.hullDark),
        S(-3.5, -0.5, 2, 1, sc.hullLight),
        S(-1.5, 0.5, 3, 1, sc.barrel),
        // Lead man, left file.
        S(-1, -4.5, 4, 3.5, sc.cloth),
        S(-1, -4.5, 4, 1, sc.clothDark),
        S(0, -4, 2, 2.5, sc.hullDark), // helmet
        S(0, -4, 2, 1, sc.hullLight),
        S(-1, -4.5, 1, 3.5, sc.accent), // house flash
        S(2, -3.5, 4, 1, sc.barrel), // rifle
        S(6, -3.5, 1, 1, MUZZLE_DARK),
        // Lead man, right file.
        S(-1.5, 1, 4, 3.5, sc.cloth),
        S(-1.5, 3.5, 4, 1, sc.clothDark),
        S(-0.5, 1.5, 2, 2.5, sc.hullDark),
        S(-0.5, 1.5, 2, 1, sc.hullLight),
        S(1.5, 2.5, 4, 1, sc.barrel),
        S(5.5, 2.5, 1, 1, MUZZLE_DARK),
        S(-3, -3, 2, 2, sc.hullDark), // section radio
        S(-3, -3.5, 0.8, 3, IRON_LIGHT), // whip aerial
      ];

    /** Anti-tank gun: low split-trail carriage behind a wide sloped shield. */
    case 'atgun':
      return [
        S(-9.5, -3, 4, 1.5, GUNMETAL), // split trail
        S(-9.5, 1.5, 4, 1.5, GUNMETAL),
        S(-10, -3.5, 1, 2, sc.hullDark),
        S(-10, 1.5, 1, 2, sc.hullDark),
        S(-5.5, -1.5, 4, 3, sc.hullDark), // trail box
        S(-4.5, -6, 2.5, 4, GUNMETAL), // wheels
        S(-4.5, 2, 2.5, 4, GUNMETAL),
        S(-4.2, -5.4, 1.9, 2.8, sc.track),
        S(-4.2, 2.6, 1.9, 2.8, sc.track),
        S(-4, -4.3, 1.5, 0.8, sc.hullLight), // hub
        S(-4, 3.5, 1.5, 0.8, sc.hullLight),
        S(-4, -2, 5, 4, sc.hullDark), // cradle
        S(-2, -5.5, 2, 11, sc.hull), // wide gun shield
        S(-2, -5.5, 2, 1, sc.hullLight),
        S(-2, 4.5, 2, 1, sc.hullDark),
        S(-2, -5.5, 0.8, 11, sc.accent), // house edge
        S(-1.6, -1, 1.2, 2, GUNMETAL), // sight aperture
        S(-0.5, -3, 1.5, 6, WHITEWASH), // whitewash streak
        S(0, -1, 10, 2, sc.barrel), // long thin barrel
        S(10, -1.5, 2, 3, GUNMETAL), // muzzle brake
      ];

    /**
     * 1943 medium tank: sloped glacis, road wheels under the track guards,
     * stowage on the engine deck. Turret is a separate sprite.
     */
    case 'mediumtank43':
      return [
        S(-7, -5.5, 14, 2.5, sc.track),
        S(-7, 3, 14, 2.5, sc.track),
        // Road wheels showing through the run of the track.
        S(-6, -5.5, 1.5, 2.5, GUNMETAL),
        S(-3.5, -5.5, 1.5, 2.5, GUNMETAL),
        S(-1, -5.5, 1.5, 2.5, GUNMETAL),
        S(1.5, -5.5, 1.5, 2.5, GUNMETAL),
        S(4, -5.5, 1.5, 2.5, GUNMETAL),
        S(-6, 3, 1.5, 2.5, GUNMETAL),
        S(-3.5, 3, 1.5, 2.5, GUNMETAL),
        S(-1, 3, 1.5, 2.5, GUNMETAL),
        S(1.5, 3, 1.5, 2.5, GUNMETAL),
        S(4, 3, 1.5, 2.5, GUNMETAL),
        S(-7, -4, 14, 8, sc.hullDark), // track guards
        S(-6.5, -3.5, 12, 7, sc.hull), // hull
        S(-6.5, -3.5, 12, 1, sc.hullLight),
        S(-6.5, 2.5, 12, 1, sc.hullDark),
        S(4.5, -3.5, 3, 7, sc.hullLight), // sloped glacis
        S(6, -2, 1.5, 4, sc.hull),
        S(5, -1, 1.5, 2, GUNMETAL), // hull machine gun
        S(-6.5, -3, 3, 6, sc.hullDark), // engine deck
        S(-6, -2, 2, 1, sc.hull),
        S(-6, 0, 2, 1, sc.hull),
        S(-6.5, -3.5, 1, 7, sc.accent), // house plate
        S(-4, -3.5, 2.5, 1.5, WHITEWASH), // whitewash streaks
        S(1, 2.5, 3, 1, WHITEWASH),
        S(-3, 1.5, 3, 2, WOOD_DARK), // stowage box
      ];

    /** Heavy tank: longer, wider tracks, a great slab of frontal plate. */
    case 'heavytank':
      return [
        S(-8, -7, 16, 3.5, sc.track),
        S(-8, 3.5, 16, 3.5, sc.track),
        S(-7, -7, 1.5, 3.5, GUNMETAL),
        S(-4, -7, 1.5, 3.5, GUNMETAL),
        S(-1, -7, 1.5, 3.5, GUNMETAL),
        S(2, -7, 1.5, 3.5, GUNMETAL),
        S(5, -7, 1.5, 3.5, GUNMETAL),
        S(-7, 3.5, 1.5, 3.5, GUNMETAL),
        S(-4, 3.5, 1.5, 3.5, GUNMETAL),
        S(-1, 3.5, 1.5, 3.5, GUNMETAL),
        S(2, 3.5, 1.5, 3.5, GUNMETAL),
        S(5, 3.5, 1.5, 3.5, GUNMETAL),
        S(-8, -4.5, 16, 9, sc.hullDark), // track guards
        S(-7.5, -4, 14.5, 8, sc.hull),
        S(-7.5, -4, 14.5, 1, sc.hullLight),
        S(-7.5, 3, 14.5, 1, sc.hullDark),
        S(5, -4, 3, 8, sc.hullLight), // thick glacis
        S(7, -2.5, 1.5, 5, sc.hull),
        S(-7.5, -3.5, 4, 7, sc.hullDark), // engine grill
        S(-7, -2.5, 3, 1, sc.hull),
        S(-7, -0.5, 3, 1, sc.hull),
        S(-7, 1.5, 3, 1, sc.hull),
        S(-7.5, -4, 1, 8, sc.accent),
        S(-2, -4, 3, 1.5, WHITEWASH),
        S(0, 3, 3, 1, WHITEWASH),
        S(-4.5, 1, 3, 2.5, WOOD_DARK), // stowage bin
        S(-4.5, 1, 3, 1, WOOD),
      ];

    /**
     * Dive bomber: inverted gull wing, spatted fixed undercarriage, radial
     * cowling and a bomb under the belly. Reads as 1943 from a tile away.
     */
    case 'divebomber':
      return [
        S(-10, -1.5, 4, 3, sc.hullDark), // tail cone
        S(-11, -5, 2.5, 10, sc.hull), // tailplane
        S(-11, -5, 2.5, 1, sc.hullLight),
        S(-11, 4, 2.5, 1, sc.hullDark),
        S(-11.5, -1, 1.5, 2, sc.accent), // fin
        // Gull wing: an inner section angled forward, outer panels swept back.
        S(-1.5, -5, 4.5, 10, sc.hull), // inner (kinked) section
        S(-2.5, -11, 4, 6, sc.hull), // port outer panel
        S(-2.5, 5, 4, 6, sc.hull), // starboard outer panel
        S(-2.5, -11, 4, 1, sc.hullLight),
        S(-2.5, 10, 4, 1, sc.hullDark),
        S(-1.5, -5, 4.5, 1, sc.hullLight),
        S(-1, -9.5, 2, 2, sc.accentDark), // wing markings
        S(-1, 7.5, 2, 2, sc.accentDark),
        // Spatted undercarriage hanging under the wing kink.
        S(-1, -6.5, 3.5, 2, sc.hullDark),
        S(-1, 4.5, 3.5, 2, sc.hullDark),
        S(1.5, -6.5, 1, 2, GUNMETAL),
        S(1.5, 4.5, 1, 2, GUNMETAL),
        S(-8, -2.5, 16, 5, sc.hull), // fuselage
        S(-8, -2.5, 16, 1, sc.hullLight),
        S(-8, 1.5, 16, 1, sc.hullDark),
        S(-8, -2.5, 1, 5, sc.accent),
        S(-4, -1, 3, 2, sc.hullDark), // rear cockpit / gunner
        S(0, -2, 4, 4, sc.glass), // canopy
        S(-1, -2, 1, 4, sc.hullDark), // canopy frame
        S(-2.5, -1.5, 3, 3, GUNMETAL), // bomb on the centreline crutch
        S(0.5, -1, 1.5, 2, GUNMETAL),
        S(4.5, -3, 3.5, 6, sc.hullDark), // radial cowling
        S(4.5, -3, 3.5, 1, sc.hullLight),
        S(8, -1, 1.5, 2, GUNMETAL), // spinner
      ];

    // --- 2077: ceramic armour and contained energy ------------------------

    /** Plasma trooper: bulky powered armour, lit seams, shoulder-fed caster. */
    case 'plasmatrooper':
      return [
        S(-5, -2.5, 3, 5, sc.hullDark), // reactor pack
        S(-5, -2.5, 3, 1, NEON_HOT),
        S(-5, 1.5, 3, 1, NEON_HOT),
        S(-3, -3.5, 4, 7, sc.hullDark), // armour backplate
        S(-2.5, -3, 5, 6, sc.hull), // torso shell
        S(-2.5, -3, 5, 1, sc.hullLight),
        S(-2.5, 2, 5, 1, sc.hullDark),
        S(-2.5, -3.5, 3, 1.5, sc.hull), // pauldrons
        S(-2.5, 2, 3, 1.5, sc.hull),
        S(-2.5, -3.5, 1, 1.5, sc.accent),
        S(-1, -1, 2, 2, NEON_HOT), // chest core
        S(-1.5, -1.5, 3, 3, sc.hullDark),
        S(-1, -1, 2, 2, NEON_HOT),
        S(0, -1.5, 2.5, 3, sc.hullDark), // sealed helm
        S(0, -1.5, 2.5, 1, sc.hullLight),
        S(2, -1, 0.8, 2, NEON_TEAL), // visor band
        S(1, -2.5, 5, 2, sc.barrel), // plasma caster
        S(1, -2.5, 5, 0.8, sc.hullDark),
        S(6, -2.5, 1.5, 2, NEON_HOT), // emitter
        S(0.5, -3, 1.5, 1, NEON_TEAL), // feed line
      ];

    /**
     * Hover tank: a chamfered slab riding a skirt of lift emitters. No tracks
     * anywhere on it, and the underlight is what sells that it is floating.
     */
    case 'hovertank':
      return [
        // Lift glow spilling out from under the skirt: segmented, dimmer along
        // the flanks and brightest at the rear thrusters, so it reads as an air
        // cushion rather than as a selection box drawn round the hull.
        S(-6.5, -7, 4, 1.5, HOVER_GLOW),
        S(0.5, -7, 4, 1.5, HOVER_GLOW),
        S(-6.5, 5.5, 4, 1.5, HOVER_GLOW),
        S(0.5, 5.5, 4, 1.5, HOVER_GLOW),
        S(-8.5, -4, 2, 8, HOVER_GLOW), // rear thruster wash
        S(-8.5, -2, 2, 4, NEON_TEAL),
        S(-6.5, -6.5, 1.5, 1, NEON_TEAL), // bright vents
        S(3.5, -6.5, 1.5, 1, NEON_TEAL),
        S(-6.5, 6, 1.5, 1, NEON_TEAL),
        S(3.5, 6, 1.5, 1, NEON_TEAL),
        S(-7, -6.5, 14, 1.5, sc.hullDark), // skirt
        S(-7, 5, 14, 1.5, sc.hullDark),
        S(-7.5, -5, 1.5, 10, sc.hullDark),
        S(7, -5, 1.5, 10, sc.hullDark),
        S(-6.5, -5, 13, 10, sc.hullDark), // underbody
        // Chamfered top plate: narrows toward the nose.
        S(-6, -4.5, 12, 9, sc.hull),
        S(-6, -4.5, 12, 1, sc.hullLight),
        S(-6, 3.5, 12, 1, sc.hullDark),
        S(5, -3.5, 2.5, 7, sc.hull),
        S(6.5, -2.5, 1.5, 5, sc.hullLight), // prow
        S(-6, -4.5, 1, 9, sc.accent), // house plate
        S(-5, -3, 3, 6, sc.hullDark), // intake vent
        S(-4.5, -2.5, 2, 5, NEON_TEAL),
        S(-1, -4.5, 1, 9, sc.hullLight), // spine
      ];

    /**
     * Spider mech: a high-stanced four-legged walker. Each leg is a thigh out
     * to a knee block and a foot beyond it, so the body reads as *lifted* well
     * clear of the ground.
     */
    case 'spidermech':
      return [
        // Legs: thigh, knee, foot. Splayed off all four corners.
        S(-8, -8, 5, 1.5, sc.barrel),
        S(-8, 6.5, 5, 1.5, sc.barrel),
        S(3, -8, 5, 1.5, sc.barrel),
        S(3, 6.5, 5, 1.5, sc.barrel),
        S(-10, -10, 2.5, 2.5, sc.hullDark), // knees
        S(-10, 7.5, 2.5, 2.5, sc.hullDark),
        S(7.5, -10, 2.5, 2.5, sc.hullDark),
        S(7.5, 7.5, 2.5, 2.5, sc.hullDark),
        S(-11.5, -11.5, 2, 2, IRON), // feet
        S(-11.5, 9.5, 2, 2, IRON),
        S(9.5, -11.5, 2, 2, IRON),
        S(9.5, 9.5, 2, 2, IRON),
        S(-8, -11, 2, 3.5, sc.barrel), // shin
        S(-8, 7.5, 2, 3.5, sc.barrel),
        S(6, -11, 2, 3.5, sc.barrel),
        S(6, 7.5, 2, 3.5, sc.barrel),
        S(-6, -7, 3.5, 3.5, sc.hullDark), // hip actuators
        S(-6, 3.5, 3.5, 3.5, sc.hullDark),
        S(2.5, -7, 3.5, 3.5, sc.hullDark),
        S(2.5, 3.5, 3.5, 3.5, sc.hullDark),
        S(-6.5, -5.5, 13, 11, sc.hullDark), // chassis underside
        S(-6, -5, 12, 10, sc.hull), // chassis
        S(-6, -5, 12, 1, sc.hullLight),
        S(-6, 4, 12, 1, sc.hullDark),
        S(-6, -5, 1, 10, sc.accent),
        S(4, -3.5, 2.5, 7, sc.hullLight), // forward sensor mast
        S(-4.5, -2, 3, 4, sc.hullDark), // reactor housing
        S(-4, -1.5, 2, 3, MECH_HOT),
        S(-1, -3.5, 1, 7, sc.hullDark), // turret ring shoulders
      ];

    /**
     * Swarm drone: a small rotor-less diamond. Four stub vanes with lit tips,
     * a glowing core, and nothing that spins — it hangs on a field, not a rotor.
     */
    case 'swarmdrone':
      return [
        S(-6, -6, 2.5, 2.5, sc.hullDark), // vanes
        S(-6, 3.5, 2.5, 2.5, sc.hullDark),
        S(3.5, -6, 2.5, 2.5, sc.hullDark),
        S(3.5, 3.5, 2.5, 2.5, sc.hullDark),
        S(-6.5, -6.5, 1.5, 1.5, NEON_TEAL), // lit tips
        S(-6.5, 5, 1.5, 1.5, NEON_TEAL),
        S(5, -6.5, 1.5, 1.5, NEON_TEAL),
        S(5, 5, 1.5, 1.5, NEON_TEAL),
        // Diamond body, stepped so it stays on the art grid.
        S(-1, -4.5, 2, 9, sc.hull),
        S(-2.5, -3.5, 5, 7, sc.hull),
        S(-4, -2.5, 8, 5, sc.hull),
        S(-4, -1.5, 8, 1, sc.hullLight),
        S(-2.5, -3.5, 5, 1, sc.hullLight),
        S(-4, 1, 8, 1, sc.hullDark),
        S(-4, -1.5, 1.5, 3, sc.accent), // house wedge
        S(-1, -1.5, 2.5, 3, sc.hullDark), // core well
        S(-0.5, -1, 1.5, 2, NEON_HOT),
        S(2, -1, 3, 2, sc.barrel), // bolt emitter
        S(5, -0.75, 1.5, 1.5, NEON_TEAL),
      ];

    /**
     * Phase lancer: almost all gun. A long rail runs the length of a low
     * chassis, fed by two capacitor banks that glow violet when charged.
     */
    case 'phaselancer':
      return [
        S(-7, -5.5, 12, 2, sc.track),
        S(-7, 3.5, 12, 2, sc.track),
        S(-6, -5.5, 1.5, 2, sc.hullDark),
        S(-2.5, -5.5, 1.5, 2, sc.hullDark),
        S(1, -5.5, 1.5, 2, sc.hullDark),
        S(-6, 3.5, 1.5, 2, sc.hullDark),
        S(-2.5, 3.5, 1.5, 2, sc.hullDark),
        S(1, 3.5, 1.5, 2, sc.hullDark),
        S(-7, -4, 12, 8, sc.hullDark),
        S(-6.5, -3.5, 11, 7, sc.hull), // chassis
        S(-6.5, -3.5, 11, 1, sc.hullLight),
        S(-6.5, 2.5, 11, 1, sc.hullDark),
        S(-6.5, -3.5, 1, 7, sc.accent),
        S(-5.5, -3, 3.5, 2, sc.hullDark), // capacitor banks
        S(-5.5, 1, 3.5, 2, sc.hullDark),
        S(-5, -2.5, 2.5, 1, NEON_VIOLET),
        S(-5, 1.5, 2.5, 1, NEON_VIOLET),
        S(-1.5, -3, 4, 6, sc.hullLight), // emitter housing
        S(-1.5, -3, 4, 1, sc.hullLight),
        S(-0.5, -1, 2, 2, NEON_VIOLET), // charge chamber
        S(2, -2, 9, 4, sc.barrel), // rail assembly
        S(2, -2, 9, 1, sc.hullDark),
        S(2, 1, 9, 1, sc.hullDark),
        S(2.5, -0.5, 9, 1, NEON_VIOLET), // charged rail
        S(11, -1.5, 2, 3, NEON_PALE), // aperture
        S(12.5, -0.75, 1, 1.5, NEON_VIOLET),
      ];

    default: {
      const never: never = type;
      throw new Error(`unit art missing for ${String(never)}`);
    }
  }
}

/** Turret description for turreted units, or null. */
function turretShapes(type: UnitTypeId, sc: Scheme): Shape[] | null {
  switch (type) {
    case 'buggy':
      return [
        S(-2, -2, 4, 4, sc.hullDark), // pintle mount
        S(-2, -2, 4, 1, sc.hullLight),
        S(2, -1, 4, 2, sc.barrel),
        S(6, -1, 1, 2, MUZZLE_DARK),
      ];
    case 'lightTank':
      return [
        S(-3, -3, 7, 6, sc.hull),
        S(-3, -3, 7, 1, sc.hullLight),
        S(-3, 2, 7, 1, sc.hullDark),
        S(-3, -1, 1, 2, sc.accent),
        S(-2, -1, 2, 2, sc.hullDark), // hatch
        S(4, -2, 1, 4, sc.hullDark), // mantlet
        S(5, -1, 5, 2, sc.barrel),
        S(10, -1, 1, 2, MUZZLE_DARK),
      ];
    case 'mediumTank':
      return [
        S(-4, -4, 9, 8, sc.hull),
        S(-4, -4, 9, 1, sc.hullLight),
        S(-4, 3, 9, 1, sc.hullDark),
        S(-4, -1, 1, 2, sc.accent),
        S(-3, -1, 3, 2, sc.hullDark), // hatch
        S(5, -3, 2, 6, sc.hullDark), // mantlet
        S(6, -2, 5, 1, sc.barrel), // twin-look barrels
        S(6, 1, 5, 1, sc.barrel),
        S(11, -2, 1, 1, MUZZLE_DARK),
        S(11, 1, 1, 1, MUZZLE_DARK),
      ];

    // --- C2 era turrets ---------------------------------------------------

    /** 1943 medium: rounded cast turret, single 75, coax and a loader's hatch. */
    case 'mediumtank43':
      return [
        S(-4, -3.5, 8.5, 7, sc.hullDark), // cast shell
        S(-3.5, -3, 7.5, 6, sc.hull),
        S(-3.5, -3, 7.5, 1, sc.hullLight),
        S(-3.5, 2, 7.5, 1, sc.hullDark),
        S(-4, -1, 1, 2, sc.accent), // house band
        S(-2.5, -1.5, 3, 3, sc.hullDark), // commander's hatch
        S(-2, -1, 2, 2, sc.hullLight),
        S(1, -3, 2, 1.5, GUNMETAL), // stowage rail
        S(4, -2, 2, 4, sc.hullDark), // mantlet
        S(4, -2, 2, 1, sc.hullLight),
        S(6, -1, 5, 2, sc.barrel), // 75mm
        S(11, -1, 1, 2, MUZZLE_DARK),
        S(4.5, 1.5, 3, 1, GUNMETAL), // coaxial machine gun
      ];

    /** Heavy: angular welded turret, long 88 with a double-baffle brake. */
    case 'heavytank':
      return [
        S(-5.5, -4.5, 11, 9, sc.hullDark),
        S(-5, -4, 10, 8, sc.hull),
        S(-5, -4, 10, 1, sc.hullLight),
        S(-5, 3, 10, 1, sc.hullDark),
        S(-5, -1, 1, 2, sc.accent),
        S(-4.5, -3, 3, 3, sc.hullDark), // cupola
        S(-4, -2.5, 2, 2, sc.hullLight),
        S(-4.5, 1, 4, 2.5, WOOD_DARK), // turret stowage bin
        S(-4.5, 1, 4, 1, WOOD),
        S(0, -4, 2, 1.5, WHITEWASH), // whitewash streak
        S(5, -3, 2.5, 6, sc.hullDark), // heavy mantlet
        S(5, -3, 2.5, 1, sc.hullLight),
        S(7.5, -1, 6, 2, sc.barrel), // long 88
        S(13.5, -1.5, 1, 3, GUNMETAL), // muzzle brake
        S(14.5, -1.5, 1, 3, GUNMETAL),
        S(15.5, -1, 0.8, 2, MUZZLE_DARK),
      ];

    /** Hover tank: a low disc mount with a pulse cannon and a lit charge ring. */
    case 'hovertank':
      return [
        S(-3.5, -3.5, 8, 7, sc.hullDark),
        S(-3, -3, 7, 6, sc.hull),
        S(-3, -3, 7, 1, sc.hullLight),
        S(-3, 2, 7, 1, sc.hullDark),
        S(-3, -1, 1, 2, sc.accent),
        S(-2, -2.5, 5, 1, NEON_TEAL), // charge ring
        S(-2, 1.5, 5, 1, NEON_TEAL),
        S(-1.5, -1.5, 3, 3, sc.hullDark), // core well
        S(-1, -1, 2, 2, NEON_TEAL),
        S(4, -2, 2, 4, sc.hullDark), // mount
        S(6, -1.5, 4, 3, sc.barrel), // pulse cannon
        S(6, -1.5, 4, 1, sc.hullDark),
        S(10, -1, 1.5, 2, NEON_TEAL), // emitter
      ];

    /** Spider mech: a twin railgun cradle, capacitors lit orange between rails. */
    case 'spidermech':
      return [
        S(-4.5, -4.5, 9.5, 9, sc.hullDark),
        S(-4, -4, 8.5, 8, sc.hull),
        S(-4, -4, 8.5, 1, sc.hullLight),
        S(-4, 3, 8.5, 1, sc.hullDark),
        S(-4, -1, 1, 2, sc.accent),
        S(-2.5, -2, 3.5, 4, sc.hullDark), // capacitor stack
        S(-2, -1.5, 2.5, 1, MECH_HOT),
        S(-2, 0.5, 2.5, 1, MECH_HOT),
        S(4, -4.5, 2.5, 9, sc.hullDark), // twin mantlet
        S(4, -4.5, 2.5, 1, sc.hullLight),
        S(6.5, -3.5, 7, 2, sc.barrel), // rail A
        S(6.5, 1.5, 7, 2, sc.barrel), // rail B
        S(6.5, -3, 7, 0.8, sc.hullLight),
        S(6.5, 2, 7, 0.8, sc.hullLight),
        S(13.5, -3.5, 1.2, 2, MECH_HOT),
        S(13.5, 1.5, 1.2, 2, MECH_HOT),
      ];
    default:
      return null;
  }
}

/**
 * Defence-emplacement guns, composited over the tower base at `turretFacing`.
 *
 * C1 gave every era's emplacement the 1991 autocannon because `getTowerTurret`
 * took no type; C2 gives each era its own weapon. `guardTower` is unchanged to
 * the pixel — it is the shipped sprite and the silicon reference.
 */
function towerTurretShapes(type: BuildingTypeId, sc: Scheme): Shape[] {
  switch (type) {
    /** 1917: a water-cooled machine gun on a low tripod, with an ammo can. */
    case 'mgnest':
      return [
        S(-3, -2, 5, 4, IRON), // tripod plate
        S(-3, -2, 5, 1, IRON_LIGHT),
        S(-3.5, -1, 2, 2, sc.accent), // house marker on the trail
        S(-1, -1.5, 3, 3, sc.hullDark), // receiver
        S(-1, -1.5, 3, 1, sc.hullLight),
        S(-1.5, 1.5, 3, 2, WOOD_DARK), // ammunition can
        S(-1.5, 1.5, 3, 0.8, WOOD),
        S(2, -1.2, 5, 2.4, IRON), // water jacket
        S(2, -1.2, 5, 0.8, IRON_LIGHT),
        S(3, -0.4, 4, 0.8, sc.barrel),
        S(7, -0.5, 1, 1, MUZZLE_DARK),
      ];

    /** 1943: a quad flak mount — four barrels fanned and elevated. */
    case 'flaktower':
      return [
        S(-3, -3, 6, 6, sc.hullDark), // rotating mount
        S(-3, -3, 6, 1, sc.hullLight),
        S(-3, -1, 1, 2, sc.accent),
        S(-2.5, -2.5, 2, 2, GUNMETAL), // gunner seats
        S(-2.5, 0.5, 2, 2, GUNMETAL),
        S(0.5, -3.5, 2.5, 7, sc.hull), // cradle
        S(0.5, -3.5, 2.5, 1, sc.hullLight),
        // Four barrels, splayed: the outer pair angled off the axis reads as
        // elevation from directly above.
        S(3, -3.4, 4.5, 1.2, sc.barrel),
        S(3, -1.6, 5.5, 1.2, sc.barrel),
        S(3, 0.4, 5.5, 1.2, sc.barrel),
        S(3, 2.2, 4.5, 1.2, sc.barrel),
        S(7.5, -3.4, 1, 1.2, MUZZLE_DARK),
        S(8.5, -1.6, 1, 1.2, MUZZLE_DARK),
        S(8.5, 0.4, 1, 1.2, MUZZLE_DARK),
        S(7.5, 2.2, 1, 1.2, MUZZLE_DARK),
      ];

    /** 2077: an emitter head — focusing rings around a lit lens. */
    case 'lasertower':
      return [
        S(-3, -2.5, 5, 5, sc.hullDark), // yoke
        S(-3, -2.5, 5, 1, sc.hullLight),
        S(-3, -1, 1, 2, sc.accent),
        S(-1.5, -2, 4, 4, sc.hull), // emitter body
        S(-1.5, -2, 4, 1, sc.hullLight),
        S(-1, -1, 2, 2, NEON_TEAL), // charge core
        S(2.5, -1.8, 1.2, 3.6, sc.hullDark), // focusing rings
        S(4.5, -1.4, 1.2, 2.8, sc.hullDark),
        S(2.5, -0.6, 4.5, 1.2, NEON_TEAL), // beam channel
        S(6, -1.2, 1.5, 2.4, sc.hullLight), // lens housing
        S(7, -0.8, 1, 1.6, LASER_PALE), // lens
      ];

    /** 1991 Guard Tower — the shipped autocannon, unchanged. */
    default:
      return [
        S(-3, -2, 6, 4, sc.hull),
        S(-3, -2, 6, 1, sc.hullLight),
        S(-3, -2, 1, 4, sc.accent),
        S(1, -3, 2, 6, sc.hullDark), // gun shield
        S(3, -1, 5, 2, sc.barrel),
        S(8, -1, 1, 2, MUZZLE_DARK),
      ];
  }
}

// --- unit sprite cache ------------------------------------------------------

const unitCache = new Map<string, Canvas>();

/**
 * Hull sprite for a unit type at a cached facing. `loaded` only matters for the
 * harvester (a glowing ore load in the bin).
 */
export function getUnitSprite(
  type: UnitTypeId,
  player: number,
  dir: number,
  loaded = false,
): Canvas {
  const p = player === 1 ? 1 : 0;
  const d = ((dir % FACINGS) + FACINGS) % FACINGS;
  const load = type === 'harvester' && loaded;
  const key = `u|${type}|${p}|${d}|${load ? 'l' : 'e'}`;
  const cached = unitCache.get(key);
  if (cached) return cached;
  const sc = schemeFor(p);
  const canvas = rasterizeBody(unitShapes(type, sc, load), (d / FACINGS) * Math.PI * 2, sc.outline);
  unitCache.set(key, canvas);
  return canvas;
}

/** Turret sprite for a turreted unit type, or null for hull-only types. */
export function getUnitTurret(type: UnitTypeId, player: number, dir: number): Canvas | null {
  const p = player === 1 ? 1 : 0;
  const d = ((dir % FACINGS) + FACINGS) % FACINGS;
  const key = `t|${type}|${p}|${d}`;
  const cached = unitCache.get(key);
  if (cached) return cached;
  const sc = schemeFor(p);
  const shapes = turretShapes(type, sc);
  if (!shapes) return null;
  const canvas = rasterizeBody(shapes, (d / FACINGS) * Math.PI * 2, sc.outline);
  unitCache.set(key, canvas);
  return canvas;
}

// --- rotor (V2) -------------------------------------------------------------

/** Main-rotor animation frames. A 4-blade disc repeats every 90 degrees. */
export const ROTOR_FRAMES = 4;

const ROTOR_BLADE = '#3c4048';

function rotorShapes(sc: Scheme): Shape[] {
  return [
    S(-9, -0.5, 18, 1, ROTOR_BLADE), // blade pair
    S(-0.5, -9, 1, 18, ROTOR_BLADE),
    S(-1.5, -1.5, 3, 3, sc.hullLight), // hub
    S(-1.5, -1.5, 3, 1, sc.accent),
  ];
}

/**
 * Spinning main rotor, composited over an aircraft hull. It is orientation
 * independent — the disc looks the same whichever way the airframe points — so
 * it is cached per (player, frame) rather than per facing: 4 frames stepping a
 * quarter of the blade spacing each.
 */
export function getRotorSprite(player: number, frame: number): Canvas {
  const p = player === 1 ? 1 : 0;
  const f = ((frame % ROTOR_FRAMES) + ROTOR_FRAMES) % ROTOR_FRAMES;
  const key = `r|${p}|${f}`;
  const cached = unitCache.get(key);
  if (cached) return cached;
  const sc = schemeFor(p);
  const canvas = rasterizeBody(
    rotorShapes(sc),
    (f / ROTOR_FRAMES) * (Math.PI / 2),
    sc.outline,
  );
  unitCache.set(key, canvas);
  return canvas;
}

/**
 * Defence-emplacement gun, composited over the tower base at `turretFacing`.
 *
 * The type argument is the C2 addition (C1 shipped every era wearing the 1991
 * autocannon). It defaults to `guardTower`, so the Phase 6 call signature still
 * works and the shipped sprite keeps its cache key.
 */
export function getTowerTurret(
  player: number,
  dir: number,
  type: BuildingTypeId = 'guardTower',
): Canvas {
  const p = player === 1 ? 1 : 0;
  const d = ((dir % FACINGS) + FACINGS) % FACINGS;
  const key = `t|${type}|${p}|${d}`;
  const cached = unitCache.get(key);
  if (cached) return cached;
  const sc = schemeFor(p);
  const canvas = rasterizeBody(towerTurretShapes(type, sc), (d / FACINGS) * Math.PI * 2, sc.outline);
  unitCache.set(key, canvas);
  return canvas;
}

// --- aircraft chrome (C2) ---------------------------------------------------

/**
 * What spins over an aircraft. V2 keyed the rotor on `isAir`, which put a
 * helicopter disc over a 1943 prop bomber and over a 2077 drone that has no
 * moving parts at all. This is the render-side art table that fixes it — the
 * sim still knows nothing about it.
 */
export type AirChrome = 'rotor' | 'prop' | 'none';

export function airChromeFor(type: UnitTypeId): AirChrome {
  switch (type) {
    case 'divebomber':
      return 'prop';
    case 'swarmdrone':
      return 'none';
    default:
      return 'rotor';
  }
}

/** Propeller-disc animation frames. */
export const PROP_FRAMES = 4;

function propShapes(sc: Scheme, frame: number): Shape[] {
  // A two-blade prop caught at four points of its arc: the blades shorten and
  // the blur band fills in as they come side-on.
  const t = frame / PROP_FRAMES;
  const len = 3.2 - 1.6 * Math.abs(Math.sin(t * Math.PI * 2));
  return [
    S(-0.6, -3.4, 1.2, 6.8, 'rgba(40,44,38,0.45)'), // blur band
    S(-len, -0.5, len * 2, 1, ROTOR_BLADE), // blade pair
    S(-0.4, -3.4, 0.8, 6.8, 'rgba(210,214,196,0.30)'), // glint
    S(-1, -1, 2, 2, sc.hullDark), // spinner
    S(-1, -1, 2, 1, sc.accent),
  ];
}

/**
 * Spinning propeller disc for a prop aircraft, drawn at the nose. Like the
 * rotor it is orientation-independent (a disc looks the same whichever way the
 * airframe points), so it is cached per (player, frame) and the renderer offsets
 * it along the hull's facing.
 */
export function getPropSprite(player: number, frame: number): Canvas {
  const p = player === 1 ? 1 : 0;
  const f = ((frame % PROP_FRAMES) + PROP_FRAMES) % PROP_FRAMES;
  const key = `p|${p}|${f}`;
  const cached = unitCache.get(key);
  if (cached) return cached;
  const sc = schemeFor(p);
  const canvas = rasterizeBody(
    propShapes(sc, f),
    (f / PROP_FRAMES) * (Math.PI / 2),
    sc.outline,
  );
  unitCache.set(key, canvas);
  return canvas;
}

// ---------------------------------------------------------------------------
// Structures
//
// Buildings never rotate, so they are painted straight onto a footprint-sized
// canvas in the 2px art grid. `frame` animates the few types that have a tiny
// (<= 4 frame) loop; `constructing` re-uses frame 0 under a scaffold overlay.
// ---------------------------------------------------------------------------

export type BuildingArtState = 'ready' | 'constructing';

const buildingCache = new Map<string, Canvas>();

/** Fill an art-pixel rect (w/h in art pixels). */
function bk(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  blk(ctx, x, y, color, w, h);
}

const SANDBAG = {
  light: '#a89769',
  base: '#96865b',
  dark: '#7f7049',
  seam: '#5f5436',
} as const;

/** Animation frames (or storage levels) a building type cycles through. */
export function buildingFrameCount(type: BuildingTypeId): number {
  if (type === 'powerPlant') return 2;
  if (type === 'commCenter') return 4;
  if (type === 'silo') return 4;
  // C2: the Laser Tower's two frames are its *power* state, not an animation —
  // frame 0 is the cold tower a `lowPower` owner leaves standing in the dark.
  if (type === 'lasertower') return 2;
  return 1;
}

const BUILDING_DRAWERS: Record<
  BuildingTypeId,
  (ctx: CanvasRenderingContext2D, sc: Scheme, frame: number) => void
> = {
  // 3x3 — armoured slab with a gantry crane over the assembly bay.
  conyard: (ctx, sc) => {
    bk(ctx, 0, 0, 36, 36, sc.hullDark);
    bk(ctx, 1, 1, 34, 34, sc.hull);
    bk(ctx, 1, 1, 34, 2, sc.hullLight);
    bk(ctx, 1, 33, 34, 2, sc.outline);
    bk(ctx, 18, 10, 14, 9, sc.hullDark); // roof block
    bk(ctx, 19, 11, 12, 7, sc.hull);
    bk(ctx, 19, 11, 12, 1, sc.hullLight);
    bk(ctx, 3, 21, 12, 2, sc.accent); // hazard stripe
    bk(ctx, 3, 24, 12, 11, sc.outline); // assembly bay
    for (let i = 0; i < 4; i++) bk(ctx, 4, 26 + i * 2, 10, 1, sc.hullDark);
    bk(ctx, 24, 6, 3, 26, sc.hullDark); // crane mast
    bk(ctx, 24, 6, 3, 1, sc.hullLight);
    bk(ctx, 8, 4, 20, 2, sc.hullLight); // jib
    bk(ctx, 8, 6, 20, 1, sc.hullDark);
    bk(ctx, 12, 6, 1, 9, sc.accentDark); // cable
    bk(ctx, 10, 15, 5, 4, sc.accent); // hook block
    bk(ctx, 10, 15, 5, 1, '#ffe9a0');
  },

  // 2x2 — cooling stacks + a 2-frame glow pulse in the reactor windows.
  powerPlant: (ctx, sc, frame) => {
    bk(ctx, 0, 7, 24, 17, sc.hullDark);
    bk(ctx, 1, 8, 22, 15, sc.hull);
    bk(ctx, 1, 8, 22, 2, sc.hullLight);
    bk(ctx, 1, 21, 22, 2, sc.outline);
    bk(ctx, 3, 0, 7, 10, sc.hullDark); // main stack
    bk(ctx, 3, 0, 7, 2, sc.hullLight);
    bk(ctx, 4, 3, 5, 1, sc.outline);
    bk(ctx, 13, 3, 6, 7, sc.hullDark); // second stack
    bk(ctx, 13, 3, 6, 2, sc.hullLight);
    const on = frame === 1;
    bk(ctx, 3, 12, 7, 5, sc.outline);
    bk(ctx, 4, 13, 5, 3, on ? '#ffd964' : '#8a6b18');
    bk(ctx, 13, 12, 8, 5, sc.outline);
    bk(ctx, 14, 13, 6, 3, on ? '#ffe9a0' : '#a8801f');
    bk(ctx, 1, 18, 22, 2, sc.accent);
  },

  // 3x2 — unloading bay on the left, crystal hopper on the right.
  refinery: (ctx, sc) => {
    bk(ctx, 0, 2, 36, 22, sc.hullDark);
    bk(ctx, 1, 3, 34, 20, sc.hull);
    bk(ctx, 1, 3, 34, 2, sc.hullLight);
    bk(ctx, 1, 21, 34, 2, sc.outline);
    bk(ctx, 2, 13, 15, 11, sc.outline); // dock bay
    bk(ctx, 3, 14, 13, 3, sc.hullDark);
    for (let i = 0; i < 4; i++) bk(ctx, 3 + i * 4, 21, 2, 3, sc.accent);
    bk(ctx, 20, 4, 13, 10, sc.hullDark); // hopper
    bk(ctx, 20, 4, 13, 1, sc.hullLight);
    bk(ctx, 22, 6, 9, 6, ORE.dark);
    bk(ctx, 23, 7, 7, 4, ORE.body);
    bk(ctx, 24, 8, 5, 2, ORE.light);
    bk(ctx, 33, 0, 3, 9, sc.hullDark); // exhaust stack
    bk(ctx, 33, 0, 3, 1, sc.hullLight);
    bk(ctx, 18, 8, 2, 13, sc.hullLight); // feed pipe
  },

  // 2x2 — two ridge tents behind a sandbag line, flag on the corner.
  barracks: (ctx, sc) => {
    bk(ctx, 0, 8, 24, 16, sc.hullDark);
    bk(ctx, 1, 9, 22, 14, sc.hull);
    bk(ctx, 1, 9, 22, 1, sc.hullLight);
    // Big tent: stepped ridge.
    const rows: [number, number][] = [
      [6, 3],
      [5, 5],
      [4, 7],
      [3, 9],
      [3, 9],
      [3, 9],
      [3, 9],
    ];
    rows.forEach(([x, w], i) => {
      bk(ctx, x, 10 + i, w, 1, i < 2 ? sc.clothDark : sc.cloth);
    });
    bk(ctx, 7, 14, 3, 3, sc.outline); // tent mouth
    // Small tent.
    const rows2: [number, number][] = [
      [17, 2],
      [16, 4],
      [15, 6],
      [15, 6],
      [15, 6],
    ];
    rows2.forEach(([x, w], i) => {
      bk(ctx, x, 12 + i, w, 1, i < 2 ? sc.clothDark : sc.cloth);
    });
    bk(ctx, 21, 2, 1, 11, sc.hullLight); // flag pole
    bk(ctx, 16, 2, 5, 4, sc.accent);
    for (let i = 0; i < 6; i++) {
      bk(ctx, i * 4, 21, 4, 3, i % 2 === 0 ? SANDBAG.base : SANDBAG.dark);
    }
  },

  // 3x2 — two roll-up doors under a chevron-striped lintel.
  warFactory: (ctx, sc) => {
    bk(ctx, 0, 2, 36, 22, sc.hullDark);
    bk(ctx, 1, 3, 34, 20, sc.hull);
    bk(ctx, 1, 3, 34, 2, sc.hullLight);
    for (let i = 0; i < 5; i++) bk(ctx, 4 + i * 6, 5, 1, 4, sc.hullDark); // roof ribs
    bk(ctx, 3, 9, 29, 2, sc.accent);
    bk(ctx, 3, 12, 13, 12, sc.outline);
    bk(ctx, 4, 13, 11, 10, sc.hullDark);
    for (let i = 0; i < 5; i++) bk(ctx, 4, 13 + i * 2, 11, 1, sc.hull);
    bk(ctx, 19, 12, 13, 12, sc.outline);
    bk(ctx, 20, 13, 11, 10, sc.hullDark);
    for (let i = 0; i < 5; i++) bk(ctx, 20, 13 + i * 2, 11, 1, sc.hull);
    bk(ctx, 2, 0, 4, 4, sc.hullDark); // vent stacks
    bk(ctx, 2, 0, 4, 1, sc.hullLight);
    bk(ctx, 30, 0, 4, 4, sc.hullDark);
    bk(ctx, 30, 0, 4, 1, sc.hullLight);
  },

  // 2x2 — radar dish sweeping through 4 frames.
  commCenter: (ctx, sc, frame) => {
    bk(ctx, 0, 10, 24, 14, sc.hullDark);
    bk(ctx, 1, 11, 22, 12, sc.hull);
    bk(ctx, 1, 11, 22, 2, sc.hullLight);
    bk(ctx, 2, 15, 7, 5, sc.glass); // ops windows
    bk(ctx, 14, 15, 8, 5, sc.outline);
    bk(ctx, 15, 16, 6, 2, sc.accent);
    bk(ctx, 11, 6, 3, 6, sc.hullLight); // mast
    bk(ctx, 11, 6, 3, 1, '#eef0e4');
    const dw = [12, 8, 4, 8][frame % 4] as number;
    const off = [0, 2, 0, -2][frame % 4] as number;
    const dx = 12 - Math.floor(dw / 2) + off;
    bk(ctx, dx, 1, dw, 5, sc.hullDark);
    bk(ctx, dx, 1, dw, 2, '#c9d0b4'); // dish face
    bk(ctx, dx + Math.floor(dw / 2), 4, 1, 3, sc.hullDark); // feed stem
    bk(ctx, 11, 0, 2, 1, frame % 2 === 0 ? '#ff5a48' : '#7a1c14'); // beacon
  },

  // 2x1 — paired tanks; `frame` is the fill level 0..3.
  silo: (ctx, sc, frame) => {
    const fillH = [0, 3, 6, 9][frame % 4] as number;
    for (const tx of [1, 13]) {
      bk(ctx, tx, 1, 10, 10, sc.hullDark);
      bk(ctx, tx + 1, 2, 8, 8, sc.hull);
      if (fillH > 0) {
        bk(ctx, tx + 1, 10 - fillH, 8, fillH, ORE.body);
        bk(ctx, tx + 1, 10 - fillH, 8, 1, ORE.light);
      }
      bk(ctx, tx + 1, 2, 8, 1, sc.hullLight);
      bk(ctx, tx, 4, 10, 1, sc.hullDark);
      bk(ctx, tx, 8, 10, 1, sc.hullDark);
    }
    bk(ctx, 11, 3, 2, 6, sc.accent); // coupling
    bk(ctx, 0, 11, 24, 1, sc.outline);
  },

  // 1x1 — sandbagged legs holding an elevated platform (gun is a turret sprite).
  guardTower: (ctx, sc) => {
    bk(ctx, 1, 9, 10, 3, sc.hullDark);
    bk(ctx, 1, 10, 3, 2, SANDBAG.base);
    bk(ctx, 4, 10, 4, 2, SANDBAG.dark);
    bk(ctx, 8, 10, 3, 2, SANDBAG.base);
    bk(ctx, 3, 5, 2, 5, sc.outline); // legs
    bk(ctx, 7, 5, 2, 5, sc.outline);
    bk(ctx, 1, 3, 10, 4, sc.hull); // platform
    bk(ctx, 1, 3, 10, 1, sc.hullLight);
    bk(ctx, 1, 6, 10, 1, sc.hullDark);
    bk(ctx, 1, 3, 1, 4, sc.accent);
  },

  // 2x2 (V2) — a landing pad: tarmac square, painted circle + H, corner lights,
  // and a small service shed with a windsock mast so it never reads as a silo.
  helipad: (ctx, sc) => {
    bk(ctx, 0, 0, 24, 24, sc.hullDark); // apron kerb
    bk(ctx, 1, 1, 22, 22, '#26291f'); // tarmac
    bk(ctx, 2, 2, 20, 1, sc.hullLight);
    bk(ctx, 2, 21, 20, 1, sc.outline);

    // Painted touchdown circle, stepped so it stays on the art grid.
    const ring = '#b9bda2';
    bk(ctx, 8, 3, 8, 1, ring);
    bk(ctx, 8, 20, 8, 1, ring);
    bk(ctx, 4, 8, 1, 8, ring);
    bk(ctx, 19, 8, 1, 8, ring);
    bk(ctx, 5, 5, 3, 1, ring);
    bk(ctx, 5, 6, 1, 2, ring);
    bk(ctx, 16, 5, 3, 1, ring);
    bk(ctx, 18, 6, 1, 2, ring);
    bk(ctx, 5, 18, 3, 1, ring);
    bk(ctx, 5, 16, 1, 2, ring);
    bk(ctx, 16, 18, 3, 1, ring);
    bk(ctx, 18, 16, 1, 2, ring);

    // The H.
    bk(ctx, 8, 8, 2, 8, '#e6ead2');
    bk(ctx, 14, 8, 2, 8, '#e6ead2');
    bk(ctx, 10, 11, 4, 2, '#e6ead2');

    // Corner approach lights.
    for (const [lx, ly] of [
      [1, 1],
      [21, 1],
      [1, 21],
      [21, 21],
    ] as const) {
      bk(ctx, lx, ly, 2, 2, sc.accent);
    }

    // Service shed + windsock mast on the north-west corner.
    bk(ctx, 0, 0, 7, 5, sc.hullDark);
    bk(ctx, 1, 1, 5, 3, sc.hull);
    bk(ctx, 1, 1, 5, 1, sc.hullLight);
    bk(ctx, 2, 2, 2, 2, sc.glass);
    bk(ctx, 6, 0, 1, 4, sc.hullLight);
    bk(ctx, 7, 0, 3, 2, sc.accent); // windsock
    bk(ctx, 10, 0, 2, 2, sc.accentDark);
  },

  // 1x1 — two staggered courses of bags.
  sandbag: (ctx, sc) => {
    bk(ctx, 0, 3, 12, 1, sc.accentDark);
    bk(ctx, 0, 4, 4, 4, SANDBAG.base);
    bk(ctx, 4, 4, 4, 4, SANDBAG.light);
    bk(ctx, 8, 4, 4, 4, SANDBAG.base);
    bk(ctx, 0, 8, 3, 3, SANDBAG.dark);
    bk(ctx, 3, 8, 4, 3, SANDBAG.base);
    bk(ctx, 7, 8, 5, 3, SANDBAG.dark);
    bk(ctx, 4, 4, 1, 4, SANDBAG.seam);
    bk(ctx, 8, 4, 1, 4, SANDBAG.seam);
    bk(ctx, 3, 8, 1, 3, SANDBAG.seam);
    bk(ctx, 7, 8, 1, 3, SANDBAG.seam);
    bk(ctx, 0, 11, 12, 1, SANDBAG.seam);
  },

  // =========================================================================
  // C2 — era emplacements and the 1943 pad.
  //
  // All three emplacements are 1x1 (12 art px) and composite their era's own
  // gun at `turretFacing` (see `towerTurretShapes`), exactly as the Guard Tower
  // has always done.
  // =========================================================================

  /**
   * 1917 MG Nest: a horseshoe of sandbags around a dug-in pit, a black firing
   * slit facing out, and a couple of timber baulks over the back of the
   * emplacement. The bags are the silhouette — no metal anywhere.
   */
  mgnest: (ctx, sc) => {
    // Spoil ring / churned earth the position is dug into.
    bk(ctx, 0, 1, 12, 11, '#33301f');
    bk(ctx, 1, 2, 10, 9, '#3d3925');

    // Sandbag horseshoe: three courses, staggered, open toward the gun.
    const bag = (x: number, y: number, w: number, shade: 0 | 1 | 2): void => {
      const col = shade === 0 ? SANDBAG.light : shade === 1 ? SANDBAG.base : SANDBAG.dark;
      bk(ctx, x, y, w, 2, col);
      bk(ctx, x, y, w, 1, shade === 2 ? SANDBAG.base : SANDBAG.light);
      bk(ctx, x + w - 1, y, 1, 2, SANDBAG.seam);
    };
    bag(0, 1, 4, 1); // back course
    bag(4, 1, 4, 0);
    bag(8, 1, 4, 2);
    bag(0, 3, 3, 0); // flanks
    bag(9, 3, 3, 1);
    bag(0, 5, 3, 2);
    bag(9, 5, 3, 0);
    bag(0, 7, 4, 1); // front course, split by the embrasure
    bag(8, 7, 4, 2);
    bag(0, 9, 4, 0);
    bag(4, 9, 4, 2);
    bag(8, 9, 4, 1);

    // The pit and its firing slit.
    bk(ctx, 3, 3, 6, 6, '#20200f');
    bk(ctx, 3, 3, 6, 1, SANDBAG.seam);
    bk(ctx, 4, 4, 4, 4, '#12130b');
    bk(ctx, 3, 7, 6, 2, '#0d0e08'); // embrasure mouth

    // Timber baulks over the rear of the pit, and the house pennant.
    bk(ctx, 2, 3, 8, 1, WOOD_DARK);
    bk(ctx, 2, 3, 8, 0.5, WOOD);
    bk(ctx, 0, 0, 12, 1, sc.hullDark);
    bk(ctx, 0, 0, 3, 1, sc.accent);
  },

  /**
   * 1943 Flak Tower: an open steel platform on a concrete plinth. Railings on
   * all four corners, ammunition lockers on the deck, a range-finder post — the
   * quad barrels themselves are the turret sprite, angled up.
   */
  flaktower: (ctx, sc) => {
    bk(ctx, 0, 6, 12, 6, '#3b3d36'); // concrete plinth
    bk(ctx, 1, 7, 10, 4, '#6b6d62');
    bk(ctx, 1, 7, 10, 1, '#8b8d80');
    bk(ctx, 1, 10, 10, 1, '#2b2d27');
    bk(ctx, 2, 8, 2, 2, '#4a4c44'); // blast doors
    bk(ctx, 8, 8, 2, 2, '#4a4c44');

    bk(ctx, 0, 1, 12, 6, sc.hullDark); // open gun deck
    bk(ctx, 1, 2, 10, 4, sc.hull);
    bk(ctx, 1, 2, 10, 1, sc.hullLight);
    bk(ctx, 1, 5, 10, 1, sc.hullDark);
    // Deck plating grooves.
    bk(ctx, 3, 2, 1, 4, sc.hullDark);
    bk(ctx, 8, 2, 1, 4, sc.hullDark);

    // Corner railings — the "open platform" read.
    for (const rx of [0, 10]) {
      bk(ctx, rx, 0, 2, 1, GUNMETAL);
      bk(ctx, rx, 0, 2, 2, GUNMETAL);
      bk(ctx, rx, 6, 2, 1, GUNMETAL);
    }
    bk(ctx, 0, 0, 12, 1, GUNMETAL);
    bk(ctx, 0, 0, 2, 1, sc.accent);
    bk(ctx, 10, 0, 2, 1, sc.accent);

    // Ammunition lockers + range-finder post on the deck.
    bk(ctx, 1, 3, 2, 2, sc.accentDark);
    bk(ctx, 1, 3, 2, 1, sc.accent);
    bk(ctx, 9, 3, 2, 2, sc.accentDark);
    bk(ctx, 9, 3, 2, 1, sc.accent);
    bk(ctx, 5, 5, 2, 2, GUNMETAL);
    bk(ctx, 5, 5, 2, 1, WHITEWASH);
  },

  /**
   * 2077 Laser Tower: a slim pylon carrying a focusing crystal. `frame` is the
   * power state — frame 0 is the cold, dark tower (drawn while its owner is in
   * deficit, matching the Guard Tower going offline under `lowPower`), frame 1
   * has the crystal lit and the conduits burning.
   */
  lasertower: (ctx, sc, frame) => {
    const lit = frame === 1;
    const core = lit ? NEON_TEAL : '#31424e';
    const lens = lit ? LASER_PALE : '#5f6f78';
    const spill = lit ? 'rgba(95, 216, 255, 0.20)' : 'rgba(0,0,0,0)';

    // Ground spill, so a live tower lights its own footing.
    if (lit) {
      ctx.fillStyle = spill;
      ctx.fillRect(0, 5 * PX, 12 * PX, 7 * PX);
    }

    bk(ctx, 1, 8, 10, 4, sc.hullDark); // hex footing
    bk(ctx, 2, 8, 8, 3, sc.hull);
    bk(ctx, 2, 8, 8, 1, sc.hullLight);
    bk(ctx, 2, 11, 8, 1, sc.outline);
    bk(ctx, 1, 9, 1, 2, sc.accent); // house corners
    bk(ctx, 10, 9, 1, 2, sc.accent);
    bk(ctx, 3, 10, 2, 1, core); // conduit run into the ground
    bk(ctx, 7, 10, 2, 1, core);

    bk(ctx, 4, 3, 4, 6, sc.hullDark); // pylon
    bk(ctx, 4, 3, 1, 6, sc.hullLight);
    bk(ctx, 7, 3, 1, 6, sc.outline);
    bk(ctx, 5, 4, 2, 5, core); // energy column

    bk(ctx, 3, 1, 6, 3, sc.hullDark); // emitter yoke
    bk(ctx, 3, 1, 6, 1, sc.hullLight);
    bk(ctx, 2, 1, 1, 3, sc.accent);
    bk(ctx, 9, 1, 1, 3, sc.accent);
    // Focusing crystal: a stepped shard, hot at the tip when powered.
    bk(ctx, 5, 0, 2, 3, core);
    bk(ctx, 4, 1, 4, 1, core);
    bk(ctx, 5, 0, 2, 1, lens);
  },

  /**
   * 1943 Airstrip (3x2): a graded strip laid across the middle of the plot, so
   * a docked Dive Bomber — which the air system parks on the structure's centre
   * — sits square on the runway. Hangar and revetment at the west end, fuel
   * dump and windsock at the east.
   */
  airstrip: (ctx, sc) => {
    bk(ctx, 0, 0, 36, 24, sc.hullDark); // perimeter kerb
    bk(ctx, 1, 1, 34, 22, '#2a2b22'); // graded earth
    bk(ctx, 1, 1, 34, 1, sc.hullLight);
    bk(ctx, 1, 22, 34, 1, sc.outline);
    // Grader marks across the field.
    for (let x = 2; x < 34; x += 4) bk(ctx, x, 3, 2, 1, '#313228');
    for (let x = 3; x < 34; x += 5) bk(ctx, x, 20, 2, 1, '#333428');

    // Runway, centred on the footprint.
    bk(ctx, 1, 8, 34, 9, '#3c3d31');
    bk(ctx, 1, 8, 34, 1, '#51533f');
    bk(ctx, 1, 16, 34, 1, '#22231b');
    // Dashed centre line + touchdown marks.
    for (let x = 4; x < 32; x += 6) bk(ctx, x, 12, 3, 1, '#c3c8bd');
    for (let y = 9; y < 16; y += 2) {
      bk(ctx, 2, y, 2, 1, '#e6ead2'); // threshold bars
      bk(ctx, 32, y, 2, 1, '#e6ead2');
    }
    bk(ctx, 6, 9, 1, 6, '#8d9084');
    bk(ctx, 29, 9, 1, 6, '#8d9084');

    // Hangar with an open mouth on the runway, sandbagged revetment beside it.
    bk(ctx, 2, 0, 13, 8, sc.hullDark);
    bk(ctx, 3, 1, 11, 6, sc.hull);
    bk(ctx, 3, 1, 11, 1, sc.hullLight);
    for (let i = 0; i < 4; i++) bk(ctx, 4 + i * 3, 2, 1, 4, sc.hullDark); // roof ribs
    bk(ctx, 6, 4, 5, 4, '#12130b'); // hangar mouth
    bk(ctx, 2, 0, 1, 8, sc.accent);
    for (let i = 0; i < 4; i++) {
      bk(ctx, 16 + i * 3, 2, 3, 2, i % 2 === 0 ? SANDBAG.base : SANDBAG.dark);
    }

    // Fuel dump, ground crew hut and a windsock at the east end.
    bk(ctx, 24, 18, 3, 4, sc.accentDark);
    bk(ctx, 24, 18, 3, 1, sc.accent);
    bk(ctx, 28, 18, 3, 4, sc.accentDark);
    bk(ctx, 28, 18, 3, 1, sc.accent);
    bk(ctx, 32, 18, 3, 4, GUNMETAL);
    bk(ctx, 32, 18, 3, 1, WHITEWASH);
    bk(ctx, 18, 18, 5, 4, sc.hullDark);
    bk(ctx, 19, 19, 3, 2, sc.hull);
    bk(ctx, 19, 19, 3, 1, sc.hullLight);
    bk(ctx, 14, 17, 1, 6, sc.hullLight); // windsock mast
    bk(ctx, 15, 17, 3, 2, sc.accent);
    bk(ctx, 18, 17, 2, 2, sc.accentDark);
  },
};

/** Darken + hazard frame + girder cross: the "under construction" look. */
function scaffoldOverlay(
  ctx: CanvasRenderingContext2D,
  aw: number,
  ah: number,
  sc: Scheme,
): void {
  ctx.fillStyle = 'rgba(8, 10, 6, 0.58)';
  ctx.fillRect(0, 0, aw * PX, ah * PX);
  bk(ctx, 0, 0, aw, 1, sc.accentDark);
  bk(ctx, 0, ah - 1, aw, 1, sc.accentDark);
  bk(ctx, 0, 0, 1, ah, sc.accentDark);
  bk(ctx, aw - 1, 0, 1, ah, sc.accentDark);
  const n = Math.max(aw, ah);
  for (let i = 0; i < n; i++) {
    const gx = Math.min(aw - 1, Math.floor((i * aw) / n));
    const gy = Math.min(ah - 1, Math.floor((i * ah) / n));
    bk(ctx, gx, gy, 1, 1, sc.accent);
    bk(ctx, aw - 1 - gx, gy, 1, 1, sc.accent);
  }
}

export function getBuildingSprite(
  type: BuildingTypeId,
  player: number,
  status: BuildingArtState = 'ready',
  frame = 0,
): Canvas {
  const p = player === 1 ? 1 : 0;
  const frames = buildingFrameCount(type);
  const f = status === 'constructing' ? 0 : ((frame % frames) + frames) % frames;
  const key = `b|${type}|${p}|${status}|${f}`;
  const cached = buildingCache.get(key);
  if (cached) return cached;

  const def = BUILDING_TYPES[type];
  const aw = (def.w * TILE) / PX;
  const ah = (def.h * TILE) / PX;
  const { canvas, ctx } = makeCanvas(def.w * TILE, def.h * TILE);
  const sc = schemeFor(p);
  BUILDING_DRAWERS[type](ctx, sc, f);
  if (status === 'constructing') scaffoldOverlay(ctx, aw, ah, sc);

  buildingCache.set(key, canvas);
  return canvas;
}

// ---------------------------------------------------------------------------
// Combat FX (Phase 4)
// ---------------------------------------------------------------------------

const fxCache = new Map<string, Canvas>();

/** Number of animation frames in an explosion. */
export const EXPLOSION_FRAMES = 5;

const FX = {
  core: '#fff6d0',
  hot: '#ffd75e',
  flame: '#f28a2b',
  ember: '#c1441c',
  smoke: '#4a4438',
  smokeLight: '#6d6555',
} as const;

/**
 * One frame of a chunky procedural blast. Frame 0 is a white-hot core, the
 * middle frames bloom orange, the last frames are smoke rings that fade out.
 * Radii are quantised to the 2px art grid so it matches the terrain style.
 */
export function getExplosionSprite(frame: number, size: number): Canvas {
  const f = Math.max(0, Math.min(EXPLOSION_FRAMES - 1, Math.round(frame)));
  const s = Math.max(4, Math.round(size / PX) * PX);
  const key = `x|${f}|${s}`;
  const cached = fxCache.get(key);
  if (cached) return cached;

  const dim = s * 2 + PX * 2;
  const { canvas, ctx } = makeCanvas(dim, dim);
  const c = dim / 2;
  const rng = makeRng((0x9e3779b9 ^ (f * 7919) ^ (s * 131)) >>> 0);
  const t = f / (EXPLOSION_FRAMES - 1);
  const radius = s * (0.45 + t * 0.55);

  const ring = (r: number, color: string): void => {
    if (r <= 0) return;
    ctx.fillStyle = color;
    const steps = Math.max(6, Math.round(r / PX) * 4);
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const rr = r * rng.range(0.78, 1);
      const x = Math.round((c + Math.cos(a) * rr) / PX) * PX;
      const y = Math.round((c + Math.sin(a) * rr) / PX) * PX;
      ctx.fillRect(x - PX, y - PX, PX * 2, PX * 2);
    }
  };

  ctx.globalAlpha = 1 - t * 0.55;
  ring(radius, f < 3 ? FX.flame : FX.smoke);
  ring(radius * 0.72, f < 2 ? FX.hot : f < 4 ? FX.ember : FX.smokeLight);
  if (f < 3) {
    ctx.fillStyle = f === 0 ? FX.core : FX.hot;
    const cr = Math.max(PX, Math.round((radius * (0.42 - t * 0.3)) / PX) * PX);
    ctx.fillRect(c - cr, c - cr, cr * 2, cr * 2);
  }
  ctx.globalAlpha = 1;

  fxCache.set(key, canvas);
  return canvas;
}

// --- C2 projectile / impact art ---------------------------------------------

/** Beam colour families. `towerLaser` and `beamLance` read as different weapons. */
export type BeamStyle = 'laser' | 'lance';

interface BeamInk {
  glow: string;
  mid: string;
  core: string;
  flare: string;
}

const BEAM_INK: Record<BeamStyle, BeamInk> = {
  // 2077 tower laser: a hard teal cutting beam.
  laser: {
    glow: 'rgba(95, 216, 255, 0.20)',
    mid: 'rgba(150, 236, 255, 0.75)',
    core: 'rgba(240, 255, 255, 0.95)',
    flare: '#5fd8ff',
  },
  // Phase lance: violet, and much heavier — it is a siege weapon.
  lance: {
    glow: 'rgba(180, 107, 255, 0.22)',
    mid: 'rgba(206, 156, 255, 0.78)',
    core: 'rgba(250, 240, 255, 0.98)',
    flare: '#b46bff',
  },
};

export function beamInk(style: BeamStyle): BeamInk {
  return BEAM_INK[style];
}

/** Frames in the beam impact flare / flak puff / bomb shockwave animations. */
export const FLARE_FRAMES = 3;
export const FLAK_FRAMES = 4;
export const SHOCKWAVE_FRAMES = 5;
/** Tumble frames on a falling bomb. */
export const BOMB_FRAMES = 8;

/**
 * Impact flare for a beam: a hot core with four spikes that collapse over three
 * frames. Colour follows the weapon family.
 */
export function getBeamFlare(style: BeamStyle, frame: number): Canvas {
  const f = Math.max(0, Math.min(FLARE_FRAMES - 1, Math.round(frame)));
  const key = `bf|${style}|${f}`;
  const cached = fxCache.get(key);
  if (cached) return cached;

  const dim = 14; // art px
  const { canvas, ctx } = makeCanvas(dim * PX, dim * PX);
  const c = dim / 2;
  const ink = BEAM_INK[style];
  const t = f / (FLARE_FRAMES - 1);
  const spike = Math.max(1, Math.round(5 - t * 3));
  const core = Math.max(1, Math.round(2 - t));

  ctx.globalAlpha = 1 - t * 0.45;
  // Spikes.
  blk(ctx, c - spike, c - 0.5, ink.flare, spike * 2, 1);
  blk(ctx, c - 0.5, c - spike, ink.flare, 1, spike * 2);
  // Diagonal sparks on the first frame only.
  if (f === 0) {
    blk(ctx, c - 3, c - 3, ink.flare, 2, 2);
    blk(ctx, c + 1, c - 3, ink.flare, 2, 2);
    blk(ctx, c - 3, c + 1, ink.flare, 2, 2);
    blk(ctx, c + 1, c + 1, ink.flare, 2, 2);
  }
  blk(ctx, c - core, c - core, ink.mid, core * 2, core * 2);
  blk(ctx, c - core / 2, c - core / 2, ink.core, Math.max(1, core), Math.max(1, core));
  ctx.globalAlpha = 1;

  fxCache.set(key, canvas);
  return canvas;
}

/**
 * A glowing energy round — plasma bolts, drone bolts, pulse-cannon shells. Two
 * sizes so a 9-damage drone bolt does not look like a 36-damage pulse shell.
 */
export function getPlasmaBolt(size: number, style: 'plasma' | 'rail' = 'plasma'): Canvas {
  const s = Math.max(2, Math.min(4, Math.round(size)));
  const key = `pb|${style}|${s}`;
  const cached = fxCache.get(key);
  if (cached) return cached;

  const dim = s * 4 + 2;
  const { canvas, ctx } = makeCanvas(dim * PX, dim * PX);
  const c = dim / 2;
  const outer = style === 'plasma' ? 'rgba(90, 240, 200, 0.22)' : 'rgba(200, 190, 255, 0.22)';
  const mid = style === 'plasma' ? '#3fd8b0' : '#9c9cff';
  const hot = style === 'plasma' ? NEON_HOT : NEON_PALE;

  blk(ctx, c - s * 1.5, c - s, outer, s * 3, s * 2);
  blk(ctx, c - s, c - s * 1.5, outer, s * 2, s * 3);
  blk(ctx, c - s, c - s / 2, mid, s * 2, s);
  blk(ctx, c - s / 2, c - s, mid, s, s * 2);
  blk(ctx, c - s / 2, c - s / 2, hot, s, s);

  fxCache.set(key, canvas);
  return canvas;
}

/**
 * Flak airburst: a dirty grey-white puff with a hot centre on the first frame
 * and dark shrapnel specks that linger. Nothing else in the game reads like it,
 * which is the point — a 1943 sky should be full of these.
 */
export function getFlakPuff(frame: number): Canvas {
  const f = Math.max(0, Math.min(FLAK_FRAMES - 1, Math.round(frame)));
  const key = `fp|${f}`;
  const cached = fxCache.get(key);
  if (cached) return cached;

  const dim = 16;
  const { canvas, ctx } = makeCanvas(dim * PX, dim * PX);
  const c = dim / 2;
  const rng = makeRng((0x51ed270b ^ (f * 2654435761)) >>> 0);
  const t = f / (FLAK_FRAMES - 1);
  const r = 2 + t * 4;

  ctx.globalAlpha = 1 - t * 0.7;
  const blobs = 7;
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + f;
    const rr = r * rng.range(0.55, 1);
    const x = Math.round(c + Math.cos(a) * rr);
    const y = Math.round(c + Math.sin(a) * rr);
    blk(ctx, x - 1, y - 1, f < 2 ? '#8d8f83' : '#5c5e55', 2, 2);
  }
  if (f === 0) {
    blk(ctx, c - 2, c - 1, '#ffd75e', 4, 2);
    blk(ctx, c - 1, c - 2, '#ffd75e', 2, 4);
    blk(ctx, c - 1, c - 1, '#fff6d0', 2, 2);
  } else {
    blk(ctx, c - 1, c - 1, '#b6b8ac', 2, 2);
  }
  // Shrapnel specks flying out.
  for (let i = 0; i < 4; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = r * rng.range(1, 1.6);
    blk(ctx, Math.round(c + Math.cos(a) * rr), Math.round(c + Math.sin(a) * rr), '#3a3b33');
  }
  ctx.globalAlpha = 1;

  fxCache.set(key, canvas);
  return canvas;
}

/**
 * Bomb blast shockwave: a hard expanding ring drawn *over* the ordinary
 * explosion, which is what makes a 125-damage bomb read heavier than a shell.
 */
export function getShockwave(frame: number, size: number): Canvas {
  const f = Math.max(0, Math.min(SHOCKWAVE_FRAMES - 1, Math.round(frame)));
  // `size` is a world-px radius (the warhead's splash), so it is converted into
  // the art grid rather than used as art pixels — a 50px splash must draw a
  // 50px ring, not a 100px one.
  const s = Math.max(8, Math.round(size));
  const key = `sw|${f}|${s}`;
  const cached = fxCache.get(key);
  if (cached) return cached;

  const a = s / PX;
  const dim = Math.round(a * 2.6);
  const { canvas, ctx } = makeCanvas(dim * PX, dim * PX);
  const c = dim / 2;
  const t = f / (SHOCKWAVE_FRAMES - 1);
  const r = a * (0.35 + t * 0.9);

  // Never reaches zero: the last frame is the faint dust ring, not a blank.
  ctx.globalAlpha = 0.75 - 0.6 * t;
  const steps = Math.max(10, Math.round(r * 3));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const x = Math.round(c + Math.cos(a) * r);
    const y = Math.round(c + Math.sin(a) * r);
    blk(ctx, x, y, f < 2 ? '#ffd75e' : '#7a6f52', 1, 1);
    blk(ctx, x, y - 1, f < 2 ? '#fff6d0' : '#5b5442', 1, 1);
  }
  // Debris kicked out along four axes on the early frames.
  if (f < 3) {
    const d = Math.round(r * 1.15);
    ctx.globalAlpha = 0.6 - 0.4 * t;
    blk(ctx, c - 1, c - d, '#4a4438', 2, 2);
    blk(ctx, c - 1, c + d - 2, '#4a4438', 2, 2);
    blk(ctx, c - d, c - 1, '#4a4438', 2, 2);
    blk(ctx, c + d - 2, c - 1, '#4a4438', 2, 2);
  }
  ctx.globalAlpha = 1;

  fxCache.set(key, canvas);
  return canvas;
}

/** A falling bomb, tumbling nose-over-tail through `BOMB_FRAMES` steps. */
export function getBombSprite(frame: number): Canvas {
  const f = ((Math.round(frame) % BOMB_FRAMES) + BOMB_FRAMES) % BOMB_FRAMES;
  const key = `bmb|${f}`;
  const cached = fxCache.get(key);
  if (cached) return cached;
  const shapes: Shape[] = [
    S(-3.5, -2, 2, 4, '#5a5f4b'), // tail fins
    S(-3, -1, 6, 2, '#3f4338'), // body
    S(-3, -1, 6, 1, '#6a6f5c'), // lit top
    S(0, -1, 1, 2, '#b9bda2'), // yellow band
    S(3, -0.75, 1.5, 1.5, '#25281f'), // nose
  ];
  const canvas = rasterizeBody(shapes, (f / BOMB_FRAMES) * Math.PI * 2, '#12140e');
  fxCache.set(key, canvas);
  return canvas;
}

/** A small directional muzzle flash, drawn pointing east (rotate to aim). */
export function getMuzzleFlash(size: number): Canvas {
  const s = Math.max(4, Math.round(size / PX) * PX);
  const key = `m|${s}`;
  const cached = fxCache.get(key);
  if (cached) return cached;

  const { canvas, ctx } = makeCanvas(s * 2, s);
  const cy = s / 2;
  ctx.fillStyle = FX.flame;
  ctx.fillRect(0, cy - s * 0.3, s * 1.4, s * 0.6);
  ctx.fillStyle = FX.hot;
  ctx.fillRect(0, cy - s * 0.18, s * 1.05, s * 0.36);
  ctx.fillStyle = FX.core;
  ctx.fillRect(0, cy - PX / 2, s * 0.6, PX);

  fxCache.set(key, canvas);
  return canvas;
}

// ---------------------------------------------------------------------------
// Sidebar icons (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Small readable glyphs for the build sidebar. Deliberately simple — these are
 * schematic icons, not the final unit/structure art (Phase 6 polishes them).
 * Everything is drawn on a 16x16 logical grid scaled to the requested size.
 */

const iconCache = new Map<string, Canvas>();

const ICON_GRID = 16;

const IC = {
  plate: '#232a1a',
  plateEdge: '#39422a',
  metal: '#8b8f76',
  metalDark: '#5a5f4b',
  metalLight: '#b9bda2',
  accent: '#e0b53c',
  hot: '#ffd964',
  crystal: '#3fbf5f',
  crystalLight: '#7cf09a',
  flesh: '#c99b6a',
  dark: '#191c12',
  red: '#c8402c',
  blue: '#6fa8d6',
  // C2: era inks, so a 1917 icon does not read as a 2077 one at 34px.
  wood: '#7a5c34',
  earth: '#5a5136',
  snow: '#dde3dc',
  teal: '#5fd8ff',
  violet: '#b46bff',
} as const;

/** Fill a rect in the 16x16 icon grid. */
function g(
  ctx: CanvasRenderingContext2D,
  s: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x * s), Math.round(y * s), Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
}

function iconPlate(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = IC.plate;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = IC.plateEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
}

const BUILDING_ICON_DRAWERS: Record<
  BuildingTypeId,
  (ctx: CanvasRenderingContext2D, s: number) => void
> = {
  conyard: (ctx, s) => {
    g(ctx, s, 2, 8, 12, 6, IC.metalDark);
    g(ctx, s, 2, 8, 12, 1, IC.metalLight);
    g(ctx, s, 4, 2, 1, 6, IC.metal); // crane mast
    g(ctx, s, 4, 2, 8, 1, IC.metal); // jib
    g(ctx, s, 10, 3, 1, 3, IC.accent); // cable + load
    g(ctx, s, 9, 6, 3, 2, IC.accent);
  },
  powerPlant: (ctx, s) => {
    g(ctx, s, 2, 6, 4, 8, IC.metalDark); // towers
    g(ctx, s, 10, 6, 4, 8, IC.metalDark);
    g(ctx, s, 2, 6, 4, 1, IC.metalLight);
    g(ctx, s, 10, 6, 4, 1, IC.metalLight);
    g(ctx, s, 6, 10, 4, 4, IC.metal);
    // Lightning bolt.
    g(ctx, s, 8, 1, 2, 4, IC.hot);
    g(ctx, s, 6, 4, 3, 2, IC.hot);
    g(ctx, s, 7, 5, 2, 4, IC.accent);
  },
  refinery: (ctx, s) => {
    g(ctx, s, 1, 7, 14, 7, IC.metalDark);
    g(ctx, s, 1, 7, 14, 1, IC.metalLight);
    g(ctx, s, 3, 3, 2, 4, IC.metal); // stack
    g(ctx, s, 3, 2, 2, 1, IC.metalLight);
    g(ctx, s, 9, 9, 5, 3, IC.dark); // dock bay
    g(ctx, s, 7, 3, 2, 3, IC.crystal); // crystal load
    g(ctx, s, 7, 2, 2, 1, IC.crystalLight);
  },
  barracks: (ctx, s) => {
    g(ctx, s, 2, 6, 12, 8, IC.metalDark);
    g(ctx, s, 2, 5, 12, 2, IC.metal);
    g(ctx, s, 2, 5, 12, 1, IC.metalLight);
    g(ctx, s, 7, 9, 3, 5, IC.dark); // door
    g(ctx, s, 12, 1, 1, 5, IC.metalLight); // flagpole
    g(ctx, s, 9, 1, 3, 2, IC.accent);
  },
  warFactory: (ctx, s) => {
    g(ctx, s, 1, 5, 14, 9, IC.metalDark);
    g(ctx, s, 1, 5, 14, 1, IC.metalLight);
    g(ctx, s, 4, 8, 8, 6, IC.dark); // roll-up door
    for (let i = 0; i < 3; i++) g(ctx, s, 4, 9 + i * 2, 8, 1, IC.metal);
    g(ctx, s, 2, 2, 2, 3, IC.metal); // vent stack
  },
  commCenter: (ctx, s) => {
    g(ctx, s, 3, 9, 10, 5, IC.metalDark);
    g(ctx, s, 3, 9, 10, 1, IC.metalLight);
    g(ctx, s, 7, 5, 2, 4, IC.metal); // mast
    g(ctx, s, 4, 2, 8, 2, IC.metalLight); // dish
    g(ctx, s, 5, 4, 6, 1, IC.metal);
    g(ctx, s, 7, 1, 2, 1, IC.blue);
  },
  silo: (ctx, s) => {
    g(ctx, s, 2, 4, 5, 10, IC.metalDark);
    g(ctx, s, 9, 4, 5, 10, IC.metalDark);
    g(ctx, s, 2, 3, 5, 2, IC.metal);
    g(ctx, s, 9, 3, 5, 2, IC.metal);
    g(ctx, s, 2, 3, 5, 1, IC.metalLight);
    g(ctx, s, 9, 3, 5, 1, IC.metalLight);
    g(ctx, s, 3, 7, 3, 1, IC.accent);
    g(ctx, s, 10, 7, 3, 1, IC.accent);
  },
  guardTower: (ctx, s) => {
    g(ctx, s, 4, 6, 8, 8, IC.metalDark);
    g(ctx, s, 4, 6, 8, 1, IC.metalLight);
    g(ctx, s, 3, 3, 10, 3, IC.metal); // head
    g(ctx, s, 3, 3, 10, 1, IC.metalLight);
    g(ctx, s, 12, 4, 4, 1, IC.dark); // barrel
    g(ctx, s, 6, 9, 4, 2, IC.dark); // slit
  },
  helipad: (ctx, s) => {
    g(ctx, s, 1, 4, 14, 10, IC.metalDark); // pad
    g(ctx, s, 1, 4, 14, 1, IC.metalLight);
    g(ctx, s, 5, 6, 1.5, 6, IC.metalLight); // H
    g(ctx, s, 9.5, 6, 1.5, 6, IC.metalLight);
    g(ctx, s, 6.5, 8, 3, 2, IC.metalLight);
    g(ctx, s, 1, 4, 1.5, 1.5, IC.accent); // corner lights
    g(ctx, s, 13.5, 4, 1.5, 1.5, IC.accent);
    g(ctx, s, 1, 12.5, 1.5, 1.5, IC.accent);
    g(ctx, s, 13.5, 12.5, 1.5, 1.5, IC.accent);
    g(ctx, s, 5, 1, 6, 1, IC.metal); // rotor over the pad
    g(ctx, s, 7.5, 1, 1, 3, IC.dark);
  },
  sandbag: (ctx, s) => {
    for (let row = 0; row < 3; row++) {
      const y = 6 + row * 3;
      const off = row % 2 === 0 ? 0 : 2;
      for (let i = 0; i < 4; i++) {
        g(ctx, s, 1 + off + i * 3.5, y, 3, 2.5, row % 2 === 0 ? IC.metal : IC.metalDark);
      }
    }
  },

  // --- C2 era structures --------------------------------------------------

  /** Sandbag horseshoe seen from the front, black embrasure, MG poking out. */
  mgnest: (ctx, s) => {
    g(ctx, s, 1, 3, 14, 1, IC.earth); // spoil
    g(ctx, s, 1, 4, 14, 3, IC.metal); // back course
    g(ctx, s, 1, 4, 14, 1, IC.metalLight);
    for (let i = 0; i < 4; i++) g(ctx, s, 1 + i * 3.5, 4, 1, 3, IC.metalDark);
    g(ctx, s, 1, 7, 4, 3, IC.metalDark); // flanks
    g(ctx, s, 11, 7, 4, 3, IC.metalDark);
    g(ctx, s, 5, 7, 6, 4, IC.dark); // embrasure
    g(ctx, s, 6, 8, 4, 2, '#0d0e08');
    g(ctx, s, 1, 11, 14, 3, IC.metal); // front course
    g(ctx, s, 1, 11, 14, 1, IC.metalLight);
    for (let i = 0; i < 4; i++) g(ctx, s, 2.5 + i * 3.5, 11, 1, 3, IC.metalDark);
    g(ctx, s, 9, 8, 6, 1, IC.dark); // gun barrel
    g(ctx, s, 7, 7.5, 3, 2, IC.metalDark);
  },

  /** Open steel platform on a plinth, four barrels elevated at the sky. */
  flaktower: (ctx, s) => {
    g(ctx, s, 4, 10, 8, 4, IC.metalDark); // plinth
    g(ctx, s, 4, 10, 8, 1, IC.metalLight);
    g(ctx, s, 2, 8, 12, 2, IC.metal); // deck
    g(ctx, s, 2, 8, 12, 1, IC.metalLight);
    g(ctx, s, 2, 7, 1, 2, IC.metalDark); // railings
    g(ctx, s, 13, 7, 1, 2, IC.metalDark);
    g(ctx, s, 6, 6, 4, 2, IC.metalDark); // mount
    // Four barrels raked up and to the right.
    g(ctx, s, 8, 4, 6, 1, IC.metal);
    g(ctx, s, 8.5, 2.5, 6, 1, IC.metal);
    g(ctx, s, 9, 1, 6, 1, IC.metal);
    g(ctx, s, 7.5, 5.5, 6, 1, IC.metal);
    g(ctx, s, 13.5, 1, 1.5, 1, IC.dark);
    g(ctx, s, 13, 4, 1.5, 1, IC.dark);
    g(ctx, s, 3, 11, 2, 2, IC.accent); // ammunition
  },

  /** Slim pylon, crystal head, a teal beam leaving the lens. */
  lasertower: (ctx, s) => {
    g(ctx, s, 3, 12, 10, 2, IC.metalDark); // footing
    g(ctx, s, 4, 11, 8, 1, IC.metal);
    g(ctx, s, 6, 5, 4, 7, IC.metalDark); // pylon
    g(ctx, s, 6, 5, 1, 7, IC.metalLight);
    g(ctx, s, 7.5, 6, 1.5, 6, IC.teal); // energy column
    g(ctx, s, 4, 2, 8, 3, IC.metalDark); // emitter yoke
    g(ctx, s, 4, 2, 8, 1, IC.metalLight);
    g(ctx, s, 6.5, 0.5, 3, 3, IC.teal); // focusing crystal
    g(ctx, s, 7, 0.5, 2, 1, '#d6fbff');
    g(ctx, s, 12, 3, 4, 1, IC.teal); // beam
    g(ctx, s, 12, 2.5, 4, 0.5, '#d6fbff');
  },

  /** Graded strip with threshold bars, a hangar and a windsock. */
  airstrip: (ctx, s) => {
    g(ctx, s, 1, 2, 14, 12, IC.earth); // field
    g(ctx, s, 1, 6, 14, 6, IC.metalDark); // runway
    g(ctx, s, 1, 6, 14, 1, IC.metal);
    g(ctx, s, 1, 11, 14, 1, IC.dark);
    for (let i = 0; i < 4; i++) g(ctx, s, 2.5 + i * 3.2, 8.5, 2, 1, IC.metalLight);
    g(ctx, s, 1, 6.5, 1, 5, IC.metalLight); // threshold bars
    g(ctx, s, 14, 6.5, 1, 5, IC.metalLight);
    g(ctx, s, 2, 1, 6, 4, IC.metal); // hangar
    g(ctx, s, 2, 1, 6, 1, IC.metalLight);
    g(ctx, s, 4, 3, 3, 2, IC.dark); // hangar mouth
    g(ctx, s, 11, 1, 1, 4, IC.metalLight); // windsock mast
    g(ctx, s, 12, 1, 3, 2, IC.accent);
    g(ctx, s, 12, 12, 2, 2, IC.accent); // fuel drums
  },
};

const UNIT_ICON_DRAWERS: Record<
  UnitTypeId,
  (ctx: CanvasRenderingContext2D, s: number) => void
> = {
  minigunner: (ctx, s) => {
    g(ctx, s, 7, 2, 3, 3, IC.flesh); // head
    g(ctx, s, 6, 5, 5, 6, IC.metal); // torso
    g(ctx, s, 6, 11, 2, 3, IC.metalDark); // legs
    g(ctx, s, 9, 11, 2, 3, IC.metalDark);
    g(ctx, s, 10, 6, 5, 1, IC.dark); // gun
    g(ctx, s, 11, 7, 3, 1, IC.metalDark);
  },
  rocketSoldier: (ctx, s) => {
    g(ctx, s, 6, 2, 3, 3, IC.flesh);
    g(ctx, s, 5, 5, 5, 6, IC.metalDark);
    g(ctx, s, 5, 11, 2, 3, IC.metalDark);
    g(ctx, s, 8, 11, 2, 3, IC.metalDark);
    g(ctx, s, 8, 4, 7, 2, IC.metal); // tube
    g(ctx, s, 14, 4, 1, 2, IC.red);
  },
  engineer: (ctx, s) => {
    g(ctx, s, 7, 2, 3, 3, IC.flesh);
    g(ctx, s, 6, 5, 5, 6, IC.blue); // overalls
    g(ctx, s, 6, 11, 2, 3, IC.metalDark);
    g(ctx, s, 9, 11, 2, 3, IC.metalDark);
    g(ctx, s, 11, 5, 2, 2, IC.metalLight); // wrench
    g(ctx, s, 12, 7, 1, 4, IC.metal);
  },
  harvester: (ctx, s) => {
    g(ctx, s, 2, 5, 11, 6, IC.metalDark); // body
    g(ctx, s, 2, 5, 11, 1, IC.metalLight);
    g(ctx, s, 4, 3, 6, 2, IC.crystal); // load
    g(ctx, s, 4, 2, 6, 1, IC.crystalLight);
    g(ctx, s, 13, 7, 3, 3, IC.metal); // scoop
    g(ctx, s, 2, 11, 11, 3, IC.dark); // tracks
    for (let i = 0; i < 4; i++) g(ctx, s, 3 + i * 3, 12, 1, 1, IC.metal);
  },
  buggy: (ctx, s) => {
    g(ctx, s, 2, 7, 12, 4, IC.metal);
    g(ctx, s, 4, 5, 6, 2, IC.metalDark); // cabin
    g(ctx, s, 2, 7, 12, 1, IC.metalLight);
    g(ctx, s, 3, 11, 3, 3, IC.dark); // wheels
    g(ctx, s, 10, 11, 3, 3, IC.dark);
    g(ctx, s, 9, 3, 1, 3, IC.dark); // pintle gun
  },
  lightTank: (ctx, s) => {
    g(ctx, s, 2, 5, 12, 5, IC.metalDark); // hull
    g(ctx, s, 2, 5, 12, 1, IC.metalLight);
    g(ctx, s, 5, 3, 6, 3, IC.metal); // turret
    g(ctx, s, 10, 4, 5, 1, IC.dark); // barrel
    g(ctx, s, 2, 10, 12, 4, IC.dark); // tracks
    for (let i = 0; i < 5; i++) g(ctx, s, 2.5 + i * 2.4, 11, 1.4, 2, IC.metalDark);
  },
  mediumTank: (ctx, s) => {
    g(ctx, s, 1, 5, 14, 5, IC.metalDark);
    g(ctx, s, 1, 5, 14, 1, IC.metalLight);
    g(ctx, s, 4, 2, 8, 4, IC.metal);
    g(ctx, s, 11, 3, 5, 2, IC.dark); // heavy barrel
    g(ctx, s, 1, 10, 14, 4, IC.dark);
    for (let i = 0; i < 6; i++) g(ctx, s, 1.5 + i * 2.3, 11, 1.5, 2, IC.metalDark);
  },
  artillery: (ctx, s) => {
    g(ctx, s, 2, 7, 10, 4, IC.metalDark);
    g(ctx, s, 2, 7, 10, 1, IC.metalLight);
    g(ctx, s, 5, 2, 9, 2, IC.metal); // raised barrel
    g(ctx, s, 13, 2, 2, 2, IC.dark);
    g(ctx, s, 4, 4, 3, 3, IC.metalDark); // mount
    g(ctx, s, 2, 11, 10, 3, IC.dark);
  },
  gunship: (ctx, s) => {
    g(ctx, s, 1, 2, 14, 1, IC.metal); // rotor disc
    g(ctx, s, 7, 3, 2, 2, IC.metalLight); // mast
    g(ctx, s, 3, 5, 10, 4, IC.metalDark); // fuselage
    g(ctx, s, 3, 5, 10, 1, IC.metalLight);
    g(ctx, s, 10, 6, 3, 2, IC.blue); // canopy
    g(ctx, s, 1, 6, 2, 2, IC.metal); // tail fin
    g(ctx, s, 4, 9, 8, 1, IC.metalDark); // wing spar
    g(ctx, s, 4, 10, 3, 2, IC.dark); // rocket pods
    g(ctx, s, 9, 10, 3, 2, IC.dark);
    g(ctx, s, 6, 11, 1, 1, IC.red);
    g(ctx, s, 11, 11, 1, 1, IC.red);
  },

  // --- C2: 1917 -----------------------------------------------------------

  /** Greatcoat, soup-plate helmet, bolt rifle held across the body. */
  rifleman: (ctx, s) => {
    g(ctx, s, 5, 2.5, 6, 1, IC.metalDark); // helmet brim
    g(ctx, s, 6.5, 1.5, 3, 1.5, IC.metalDark); // dome
    g(ctx, s, 7, 3.5, 2, 1, IC.flesh);
    g(ctx, s, 5, 4.5, 6, 5, IC.metal); // torso
    g(ctx, s, 4.5, 9, 7, 3, IC.metalDark); // greatcoat skirt
    g(ctx, s, 5.5, 12, 2, 3, IC.metalDark); // legs
    g(ctx, s, 8.5, 12, 2, 3, IC.metalDark);
    g(ctx, s, 3, 5, 2, 3, IC.earth); // haversack
    g(ctx, s, 4, 8.5, 10, 1, IC.wood); // rifle stock
    g(ctx, s, 11, 8.5, 5, 1, IC.dark); // barrel
    g(ctx, s, 9, 7.5, 1, 1, IC.metalLight); // bolt
  },

  /** Crouched, satchel of grenades, one stick grenade cocked overhead. */
  stormtrooper: (ctx, s) => {
    g(ctx, s, 6, 3, 4, 3, IC.metalDark); // deep helmet
    g(ctx, s, 6, 5, 1, 2, IC.metalDark); // neck guard
    g(ctx, s, 7.5, 5.5, 2, 1, IC.flesh);
    g(ctx, s, 5, 6.5, 6, 5, IC.metal); // torso
    g(ctx, s, 5, 8, 6, 1, IC.accent); // bandolier
    g(ctx, s, 2, 7, 3, 4, IC.earth); // satchel
    g(ctx, s, 2, 7, 3, 1, IC.metalDark);
    g(ctx, s, 5, 11.5, 3, 3.5, IC.metalDark); // legs
    g(ctx, s, 8.5, 11.5, 3, 3.5, IC.metalDark);
    g(ctx, s, 10, 5, 2, 2, IC.metal); // throwing arm
    g(ctx, s, 11.5, 2.5, 1, 3, IC.wood); // grenade handle
    g(ctx, s, 10.5, 0.5, 3, 2, IC.metalDark); // grenade head
  },

  /** The lozenge, side on: rhomboid track run with a sponson gun. */
  landship: (ctx, s) => {
    g(ctx, s, 1, 3, 14, 10, IC.dark); // track frame
    g(ctx, s, 2, 4, 12, 8, IC.metalDark); // hull between the rails
    g(ctx, s, 2, 4, 12, 1, IC.metalLight);
    for (let i = 0; i < 5; i++) g(ctx, s, 2 + i * 2.7, 2.5, 1.6, 1.5, IC.metal); // links
    for (let i = 0; i < 5; i++) g(ctx, s, 2 + i * 2.7, 12, 1.6, 1.5, IC.metal);
    g(ctx, s, 4, 6, 1, 5, IC.dark); // rivet strakes
    g(ctx, s, 8, 6, 1, 5, IC.dark);
    g(ctx, s, 5, 6.5, 4, 3, IC.metal); // cab
    g(ctx, s, 9, 9.5, 5, 3, IC.metalDark); // sponson
    g(ctx, s, 12, 10, 4, 1.2, IC.dark); // sponson gun
    g(ctx, s, 0, 7, 2, 1, IC.metalDark); // steering tail
  },

  /** Big spoked wheel, crew shield, long barrel. */
  fieldgun: (ctx, s) => {
    g(ctx, s, 0.5, 8, 5, 1, IC.wood); // trail legs
    g(ctx, s, 0.5, 10, 5, 1, IC.wood);
    g(ctx, s, 3, 4, 6, 8, IC.dark); // wheel tyre
    g(ctx, s, 4, 5, 4, 6, IC.earth);
    g(ctx, s, 4, 7.5, 4, 1, IC.metalLight); // spokes
    g(ctx, s, 5.5, 5, 1, 6, IC.metalLight);
    g(ctx, s, 5, 7, 2, 2, IC.accent); // hub
    g(ctx, s, 8, 2, 3, 12, IC.metalDark); // crew shield
    g(ctx, s, 8, 2, 3, 1, IC.metalLight);
    g(ctx, s, 8.5, 6.5, 2, 2, IC.dark); // sight slot
    g(ctx, s, 11, 7, 5, 2, IC.metal); // barrel
    g(ctx, s, 15, 6.5, 1, 3, IC.dark);
  },

  // --- C2: 1943 -----------------------------------------------------------

  /** Three helmets, not one: the icon has to say *squad*. */
  riflesquad: (ctx, s) => {
    // Rear man.
    g(ctx, s, 2, 6, 4, 4, IC.metalDark);
    g(ctx, s, 2.5, 4.5, 3, 2, IC.metalDark);
    g(ctx, s, 2.5, 4.5, 3, 1, IC.metal);
    g(ctx, s, 2, 10, 4, 3, IC.metalDark);
    // Front left.
    g(ctx, s, 6, 4, 4, 4, IC.metal);
    g(ctx, s, 6.5, 2, 3, 2, IC.metalDark);
    g(ctx, s, 6.5, 2, 3, 1, IC.metalLight);
    g(ctx, s, 6, 8, 4, 4, IC.metalDark);
    g(ctx, s, 10, 4.5, 5, 1, IC.dark); // rifle
    // Front right.
    g(ctx, s, 9, 8, 4, 4, IC.metal);
    g(ctx, s, 9.5, 6, 3, 2, IC.metalDark);
    g(ctx, s, 9.5, 6, 3, 1, IC.metalLight);
    g(ctx, s, 9, 12, 4, 3, IC.metalDark);
    g(ctx, s, 13, 8.5, 3, 1, IC.dark); // rifle
    g(ctx, s, 1, 3, 1, 3, IC.metalLight); // section aerial
  },

  /** Low carriage, tall sloped shield, very long thin barrel. */
  atgun: (ctx, s) => {
    g(ctx, s, 0.5, 6, 5, 1, IC.metalDark); // split trail
    g(ctx, s, 0.5, 10, 5, 1, IC.metalDark);
    g(ctx, s, 4, 5, 3, 7, IC.dark); // wheel
    g(ctx, s, 4.5, 6, 2, 5, IC.metalDark);
    g(ctx, s, 4.5, 8, 2, 1, IC.metalLight);
    g(ctx, s, 7, 2, 3, 13, IC.metal); // wide shield
    g(ctx, s, 7, 2, 3, 1, IC.metalLight);
    g(ctx, s, 7, 14, 3, 1, IC.dark);
    g(ctx, s, 7.5, 7.5, 2, 1.5, IC.dark); // sight
    g(ctx, s, 8.5, 6, 1.5, 4, IC.snow); // whitewash streak
    g(ctx, s, 10, 7.5, 6, 1.5, IC.metalDark); // barrel
    g(ctx, s, 14.5, 6.5, 1.5, 3, IC.dark); // muzzle brake
  },

  /** Sherman/T-34 plan view: road wheels, sloped nose, cast turret. */
  mediumtank43: (ctx, s) => {
    g(ctx, s, 2, 3, 12, 3, IC.dark); // track runs
    g(ctx, s, 2, 10, 12, 3, IC.dark);
    for (let i = 0; i < 5; i++) g(ctx, s, 2.4 + i * 2.4, 3.5, 1.4, 2, IC.metalDark);
    for (let i = 0; i < 5; i++) g(ctx, s, 2.4 + i * 2.4, 10.5, 1.4, 2, IC.metalDark);
    g(ctx, s, 2, 5.5, 12, 5, IC.metalDark); // hull
    g(ctx, s, 2, 5.5, 12, 1, IC.metalLight);
    g(ctx, s, 12.5, 6, 2, 4, IC.metal); // sloped glacis
    g(ctx, s, 5, 5, 6, 6, IC.metal); // turret
    g(ctx, s, 5, 5, 6, 1, IC.metalLight);
    g(ctx, s, 11, 7.5, 5, 1.2, IC.dark); // 75mm
    g(ctx, s, 6.5, 7, 2, 2, IC.metalDark); // hatch
    g(ctx, s, 3, 5.5, 2, 1, IC.snow); // whitewash
  },

  /** Bigger box, wider tracks, an 88 with a muzzle brake overhanging. */
  heavytank: (ctx, s) => {
    g(ctx, s, 1, 2, 13, 3.5, IC.dark);
    g(ctx, s, 1, 10.5, 13, 3.5, IC.dark);
    for (let i = 0; i < 5; i++) g(ctx, s, 1.4 + i * 2.6, 2.5, 1.6, 2.5, IC.metalDark);
    for (let i = 0; i < 5; i++) g(ctx, s, 1.4 + i * 2.6, 11, 1.6, 2.5, IC.metalDark);
    g(ctx, s, 1, 5, 13, 6, IC.metalDark); // hull
    g(ctx, s, 1, 5, 13, 1, IC.metalLight);
    g(ctx, s, 12.5, 5.5, 1.8, 5, IC.metal); // thick glacis
    g(ctx, s, 3.5, 4, 7, 8, IC.metal); // big turret
    g(ctx, s, 3.5, 4, 7, 1, IC.metalLight);
    g(ctx, s, 4, 6.5, 2.5, 2.5, IC.metalDark); // cupola
    g(ctx, s, 10, 7.2, 5.2, 1.6, IC.dark); // long 88
    g(ctx, s, 14.5, 6.6, 1.5, 2.8, IC.metalDark); // muzzle brake
    g(ctx, s, 2, 11, 2, 1, IC.snow);
  },

  /** Nose-up plan view: inverted gull wing, spatted gear, bomb on the crutch. */
  divebomber: (ctx, s) => {
    g(ctx, s, 6.5, 1, 3, 14, IC.metalDark); // fuselage
    g(ctx, s, 6.5, 1, 3, 1, IC.metalLight);
    g(ctx, s, 5.5, 6, 5, 3, IC.metal); // inner (kinked) wing
    g(ctx, s, 0.5, 5, 5, 3, IC.metal); // port outer panel
    g(ctx, s, 10.5, 5, 5, 3, IC.metal); // starboard outer panel
    g(ctx, s, 0.5, 5, 5, 1, IC.metalLight);
    g(ctx, s, 10.5, 5, 5, 1, IC.metalLight);
    g(ctx, s, 2, 6, 1.5, 1.5, IC.red); // markings
    g(ctx, s, 12.5, 6, 1.5, 1.5, IC.red);
    g(ctx, s, 4.5, 8.5, 2, 2.5, IC.dark); // spatted undercarriage
    g(ctx, s, 9.5, 8.5, 2, 2.5, IC.dark);
    g(ctx, s, 7, 3.5, 2, 2, IC.blue); // canopy
    g(ctx, s, 7, 9, 2, 3, IC.metalDark); // bomb on the crutch
    g(ctx, s, 4, 13, 8, 1.5, IC.metal); // tailplane
    g(ctx, s, 6.5, 0.5, 3, 1, IC.dark); // cowling
    g(ctx, s, 7.5, 0, 1, 1, IC.hot); // spinner
  },

  // --- C2: 2077 -----------------------------------------------------------

  /** Powered armour: broad pauldrons, lit visor and chest core, caster. */
  plasmatrooper: (ctx, s) => {
    g(ctx, s, 5, 4.5, 7, 2, IC.metalDark); // pauldrons
    g(ctx, s, 6, 1.5, 4, 3, IC.metalDark); // helm
    g(ctx, s, 6, 1.5, 4, 1, IC.metalLight);
    g(ctx, s, 6.5, 3, 3, 1, IC.teal); // visor
    g(ctx, s, 5.5, 6, 6, 5, IC.metal); // torso shell
    g(ctx, s, 7, 7.5, 2.5, 2.5, IC.teal); // chest core
    g(ctx, s, 5.5, 11, 2.5, 4, IC.metalDark); // legs
    g(ctx, s, 9, 11, 2.5, 4, IC.metalDark);
    g(ctx, s, 2.5, 5.5, 3, 5, IC.metalDark); // reactor pack
    g(ctx, s, 2.5, 5.5, 3, 1, IC.teal);
    g(ctx, s, 11, 6, 4, 2.5, IC.metalDark); // plasma caster
    g(ctx, s, 14.5, 6.2, 1.5, 2, IC.teal);
  },

  /** Skirted slab with no tracks and a lit cushion under it. */
  hovertank: (ctx, s) => {
    g(ctx, s, 1, 11.5, 14, 1.5, IC.teal); // lift glow
    g(ctx, s, 2, 13, 12, 1, '#2c6b7a');
    g(ctx, s, 1.5, 9.5, 13, 2, IC.metalDark); // skirt
    g(ctx, s, 2, 4, 12, 6, IC.metalDark); // hull
    g(ctx, s, 2, 4, 12, 1, IC.metalLight);
    g(ctx, s, 12.5, 5, 2, 4, IC.metal); // prow
    g(ctx, s, 5, 3, 6, 5, IC.metal); // turret
    g(ctx, s, 5, 3, 6, 1, IC.metalLight);
    g(ctx, s, 7, 5, 2, 2, IC.teal); // core
    g(ctx, s, 11, 4.8, 5, 1.5, IC.metalDark); // pulse cannon
    g(ctx, s, 15, 5, 1, 1.2, IC.teal);
  },

  /** Four legs with knees, a raised body, twin rails. */
  spidermech: (ctx, s) => {
    g(ctx, s, 0.5, 1, 4, 1.5, IC.metal); // legs out to knees
    g(ctx, s, 11.5, 1, 4, 1.5, IC.metal);
    g(ctx, s, 0.5, 13.5, 4, 1.5, IC.metal);
    g(ctx, s, 11.5, 13.5, 4, 1.5, IC.metal);
    g(ctx, s, 0, 0, 2, 2.5, IC.metalDark); // knee blocks
    g(ctx, s, 14, 0, 2, 2.5, IC.metalDark);
    g(ctx, s, 0, 13, 2, 2.5, IC.metalDark);
    g(ctx, s, 14, 13, 2, 2.5, IC.metalDark);
    g(ctx, s, 3.5, 2.5, 2, 3, IC.metalDark); // hips
    g(ctx, s, 10.5, 2.5, 2, 3, IC.metalDark);
    g(ctx, s, 3.5, 10.5, 2, 3, IC.metalDark);
    g(ctx, s, 10.5, 10.5, 2, 3, IC.metalDark);
    g(ctx, s, 3.5, 5, 9, 6, IC.metalDark); // chassis
    g(ctx, s, 3.5, 5, 9, 1, IC.metalLight);
    g(ctx, s, 6, 7, 4, 2, IC.red); // reactor
    g(ctx, s, 11, 5.5, 5, 1.2, IC.dark); // twin rails
    g(ctx, s, 11, 9.3, 5, 1.2, IC.dark);
    g(ctx, s, 15, 5.5, 1, 1.2, IC.hot);
    g(ctx, s, 15, 9.3, 1, 1.2, IC.hot);
  },

  /** Rotor-less diamond with four lit vane tips. */
  swarmdrone: (ctx, s) => {
    g(ctx, s, 2, 2, 3, 3, IC.metalDark); // vanes
    g(ctx, s, 11, 2, 3, 3, IC.metalDark);
    g(ctx, s, 2, 11, 3, 3, IC.metalDark);
    g(ctx, s, 11, 11, 3, 3, IC.metalDark);
    g(ctx, s, 1, 1, 2, 2, IC.teal); // lit tips
    g(ctx, s, 13, 1, 2, 2, IC.teal);
    g(ctx, s, 1, 13, 2, 2, IC.teal);
    g(ctx, s, 13, 13, 2, 2, IC.teal);
    g(ctx, s, 7, 3.5, 2, 9, IC.metal); // diamond body
    g(ctx, s, 5.5, 5, 5, 6, IC.metal);
    g(ctx, s, 4, 6.5, 8, 3, IC.metal);
    g(ctx, s, 4, 6.5, 8, 1, IC.metalLight);
    g(ctx, s, 7, 7, 2, 2, IC.teal); // core
    g(ctx, s, 12, 7.5, 3, 1, IC.metalDark); // emitter
  },

  /** Almost all gun: a long violet rail over a low chassis. */
  phaselancer: (ctx, s) => {
    g(ctx, s, 1, 3.5, 8, 2, IC.dark); // tracks
    g(ctx, s, 1, 10.5, 8, 2, IC.dark);
    g(ctx, s, 1, 5, 8, 6, IC.metalDark); // chassis
    g(ctx, s, 1, 5, 8, 1, IC.metalLight);
    g(ctx, s, 2, 6.5, 2.5, 1.2, IC.violet); // capacitor banks
    g(ctx, s, 2, 8.5, 2.5, 1.2, IC.violet);
    g(ctx, s, 6.5, 5.5, 3, 5, IC.metal); // emitter housing
    g(ctx, s, 9, 6, 6.5, 4, IC.metalDark); // rail assembly
    g(ctx, s, 9, 7.4, 7, 1.4, IC.violet); // charged rail
    g(ctx, s, 15, 6.5, 1, 3, '#e2c8ff'); // aperture
  },
};

export function getBuildingIcon(type: BuildingTypeId, size = 34): Canvas {
  const key = `b|${type}|${size}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const { canvas, ctx } = makeCanvas(size, size);
  iconPlate(ctx, size);
  BUILDING_ICON_DRAWERS[type](ctx, size / ICON_GRID);
  iconCache.set(key, canvas);
  return canvas;
}

export function getUnitIcon(type: UnitTypeId, size = 34): Canvas {
  const key = `u|${type}|${size}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const { canvas, ctx } = makeCanvas(size, size);
  iconPlate(ctx, size);
  UNIT_ICON_DRAWERS[type](ctx, size / ICON_GRID);
  iconCache.set(key, canvas);
  return canvas;
}

/** Shared colour ramp, so the renderer/UI can match the terrain art. */
export const SPRITE_PALETTE = C;

// ---------------------------------------------------------------------------
// Chunky 5x7 pixel type (Phase 6)
//
// Used by the title logotype and the radar's NO SIGNAL card. Every glyph is a
// 5x7 bitmap so headlines stay on the same pixel grid as the sprites instead of
// falling back to an anti-aliased system font.
// ---------------------------------------------------------------------------

export const GLYPH_W = 5;
export const GLYPH_H = 7;
/** Columns between glyphs, in font pixels. */
const GLYPH_GAP = 1;

const FONT_ROWS: Record<string, string> = {
  A: '01110 10001 10001 11111 10001 10001 10001',
  B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111',
  F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111',
  H: '10001 10001 10001 11111 10001 10001 10001',
  I: '11111 00100 00100 00100 00100 00100 11111',
  J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101',
  R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110',
  T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001',
  X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100',
  Z: '11111 00001 00010 00100 01000 10000 11111',
  '0': '01110 10011 10011 10101 11001 11001 01110',
  '1': '00100 01100 00100 00100 00100 00100 01110',
  '2': '01110 10001 00001 00010 00100 01000 11111',
  '3': '11111 00010 00100 00010 00001 10001 01110',
  '4': '00010 00110 01010 10010 11111 00010 00010',
  '5': '11111 10000 11110 00001 00001 10001 01110',
  '6': '00110 01000 10000 11110 10001 10001 01110',
  '7': '11111 00001 00010 00100 01000 01000 01000',
  '8': '01110 10001 10001 01110 10001 10001 01110',
  '9': '01110 10001 10001 01111 00001 00010 01100',
  ' ': '00000 00000 00000 00000 00000 00000 00000',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  '.': '00000 00000 00000 00000 00000 01100 01100',
  ':': '00000 01100 01100 00000 01100 01100 00000',
  '/': '00001 00010 00010 00100 01000 01000 10000',
  '!': '00100 00100 00100 00100 00100 00000 00100',
  // Post-release: the briefing / objectives / help copy needs punctuation the
  // Phase 6 logotype never did. Additive only — no existing glyph moved.
  ',': '00000 00000 00000 00000 01100 01100 11000',
  '+': '00000 00100 00100 11111 00100 00100 00000',
  '=': '00000 00000 11111 00000 11111 00000 00000',
  '[': '01110 01000 01000 01000 01000 01000 01110',
  ']': '01110 00010 00010 00010 00010 00010 01110',
  '(': '00010 00100 01000 01000 01000 00100 00010',
  ')': '01000 00100 00010 00010 00010 00100 01000',
  '<': '00001 00010 00100 01000 00100 00010 00001',
  '>': '10000 01000 00100 00010 00100 01000 10000',
  '?': '01110 10001 00001 00010 00100 00000 00100',
  "'": '00100 00100 00000 00000 00000 00000 00000',
  '%': '11001 11010 00010 00100 01000 01011 10011',
  '*': '00000 10101 01110 11111 01110 10101 00000',
};

/** glyph -> 7 row bitmasks (bit 4 = leftmost column). */
const GLYPHS = new Map<string, number[]>();
for (const [ch, spec] of Object.entries(FONT_ROWS)) {
  GLYPHS.set(
    ch,
    spec.split(' ').map((row) => parseInt(row, 2)),
  );
}

/** Width in device px of `text` drawn at `scale` px per font pixel. */
export function measurePixelText(text: string, scale: number): number {
  if (text.length === 0) return 0;
  return (text.length * (GLYPH_W + GLYPH_GAP) - GLYPH_GAP) * scale;
}

/**
 * Draw chunky bitmap type. `x`/`y` is the top-left corner; unknown characters
 * render as blanks so a stray glyph can never throw.
 */
export function drawPixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: string,
): void {
  ctx.fillStyle = color;
  const upper = text.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const rows = GLYPHS.get(upper[i] as string);
    const gx = x + i * (GLYPH_W + GLYPH_GAP) * scale;
    if (!rows) continue;
    for (let r = 0; r < GLYPH_H; r++) {
      const bits = rows[r] as number;
      if (bits === 0) continue;
      for (let cIdx = 0; cIdx < GLYPH_W; cIdx++) {
        if ((bits & (1 << (GLYPH_W - 1 - cIdx))) === 0) continue;
        ctx.fillRect(gx + cIdx * scale, y + r * scale, scale, scale);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sprite audit (Phase 6 test hook)
// ---------------------------------------------------------------------------

export interface SpriteAuditEntry {
  key: string;
  w: number;
  h: number;
  /** Pixels with a non-zero alpha channel. A near-zero count means a bug. */
  opaquePx: number;
}

function countOpaque(canvas: Canvas): number {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] as number) > 0) n++;
  }
  return n;
}

function auditEntry(key: string, canvas: Canvas): SpriteAuditEntry {
  return { key, w: canvas.width, h: canvas.height, opaquePx: countOpaque(canvas) };
}

/**
 * Force every sprite the factory can produce and report its size + opaque pixel
 * count. Exposed as `__game.spriteAudit()`: any entry with a near-zero
 * `opaquePx` is a blank sprite, i.e. a bug in the art tables.
 *
 * Covers terrain (type x variant), unit hulls (type x facing x player x load
 * state), unit + tower turrets, buildings (type x player x state x frame) and
 * the sidebar icons.
 */
export function auditSprites(): SpriteAuditEntry[] {
  const out: SpriteAuditEntry[] = [];

  // C2: terrain is per-era now, so every palette is audited and the active one
  // is restored afterwards (the audit must not leave the world in 1917).
  const paletteBefore = terrainPaletteKey();
  for (const key of TERRAIN_PALETTE_KEYS) {
    setTerrainPalette(key);
    for (let t = 0; t < TERRAIN_COUNT; t++) {
      for (let v = 0; v < TERRAIN_VARIANTS; v++) {
        out.push(auditEntry(`terrain|${key}|${t}|${v}`, getTerrainSprite(t as Terrain, v)));
      }
    }
  }
  setTerrainPalette(paletteBefore);

  for (const type of UNIT_TYPE_IDS) {
    const def = UNIT_TYPES[type];
    const loads = type === 'harvester' ? [false, true] : [false];
    for (const player of [0, 1]) {
      for (const load of loads) {
        for (let d = 0; d < FACINGS; d++) {
          out.push(
            auditEntry(
              `unit|${type}|${player}|${d}|${load ? 'loaded' : 'empty'}`,
              getUnitSprite(type, player, d, load),
            ),
          );
        }
      }
      if (def.turret) {
        for (let d = 0; d < FACINGS; d++) {
          const turret = getUnitTurret(type, player, d);
          if (turret) out.push(auditEntry(`turret|${type}|${player}|${d}`, turret));
        }
      }
    }
  }

  // C2: every era's emplacement has its own gun, derived from the type table's
  // own `turret` flag rather than a hand-kept list.
  for (const type of BUILDING_TYPE_IDS) {
    if (!BUILDING_TYPES[type].turret) continue;
    for (const player of [0, 1]) {
      for (let d = 0; d < FACINGS; d++) {
        out.push(auditEntry(`turret|${type}|${player}|${d}`, getTowerTurret(player, d, type)));
      }
    }
  }

  // V2: the aircraft rotor disc is facing-independent, so it is cached per
  // (player, frame) rather than per facing. C2 adds the propeller disc a prop
  // aircraft (the 1943 dive bomber) wears instead.
  for (const player of [0, 1]) {
    for (let f = 0; f < ROTOR_FRAMES; f++) {
      out.push(auditEntry(`rotor|${player}|${f}`, getRotorSprite(player, f)));
    }
    for (let f = 0; f < PROP_FRAMES; f++) {
      out.push(auditEntry(`prop|${player}|${f}`, getPropSprite(player, f)));
    }
  }

  for (const type of BUILDING_TYPE_IDS) {
    for (const player of [0, 1]) {
      for (let f = 0; f < buildingFrameCount(type); f++) {
        out.push(
          auditEntry(`building|${type}|${player}|ready|${f}`, getBuildingSprite(type, player, 'ready', f)),
        );
      }
      out.push(
        auditEntry(
          `building|${type}|${player}|constructing|0`,
          getBuildingSprite(type, player, 'constructing', 0),
        ),
      );
    }
  }

  for (const type of BUILDING_TYPE_IDS) {
    out.push(auditEntry(`icon|${type}`, getBuildingIcon(type)));
  }
  for (const type of UNIT_TYPE_IDS) {
    out.push(auditEntry(`icon|${type}`, getUnitIcon(type)));
  }

  for (let f = 0; f < EXPLOSION_FRAMES; f++) {
    for (const size of [8, 20, 44]) {
      out.push(auditEntry(`fx|explosion|${f}|${size}`, getExplosionSprite(f, size)));
    }
  }
  for (const size of [6, 9]) {
    out.push(auditEntry(`fx|muzzle|${size}`, getMuzzleFlash(size)));
  }

  // C2 projectile / impact art.
  for (const style of ['laser', 'lance'] as const) {
    for (let f = 0; f < FLARE_FRAMES; f++) {
      out.push(auditEntry(`fx|beamFlare|${style}|${f}`, getBeamFlare(style, f)));
    }
  }
  for (const size of [2, 3, 4]) {
    out.push(auditEntry(`fx|plasmaBolt|${size}`, getPlasmaBolt(size)));
  }
  for (let f = 0; f < FLAK_FRAMES; f++) {
    out.push(auditEntry(`fx|flakPuff|${f}`, getFlakPuff(f)));
  }
  for (let f = 0; f < SHOCKWAVE_FRAMES; f++) {
    for (const size of [26, 40]) {
      out.push(auditEntry(`fx|shockwave|${f}|${size}`, getShockwave(f, size)));
    }
  }
  for (let f = 0; f < BOMB_FRAMES; f++) {
    out.push(auditEntry(`fx|bomb|${f}`, getBombSprite(f)));
  }

  return out;
}
