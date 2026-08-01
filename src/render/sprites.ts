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

const C = {
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
} as const;

// ---------------------------------------------------------------------------
// Terrain tiles
// ---------------------------------------------------------------------------

function drawGrass(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.fillStyle = C.grassBase;
  ctx.fillRect(0, 0, TILE, TILE);
  for (let i = 0; i < 22; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), C.grassLight);
  }
  for (let i = 0; i < 16; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), C.grassDark);
  }
  // A couple of scrub tufts.
  const tufts = rng.intRange(1, 3);
  for (let i = 0; i < tufts; i++) {
    const x = rng.intRange(1, PX_PER_TILE - 2);
    const y = rng.intRange(1, PX_PER_TILE - 3);
    blk(ctx, x, y, C.grassTuft);
    blk(ctx, x, y + 1, C.grassTuft);
    blk(ctx, x + 1, y + 1, C.grassDark);
  }
}

function drawSand(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.fillStyle = C.sandBase;
  ctx.fillRect(0, 0, TILE, TILE);
  for (let i = 0; i < 20; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), C.sandLight);
  }
  for (let i = 0; i < 14; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), C.sandDark);
  }
  // Wind ripples.
  const ripples = rng.intRange(1, 2);
  for (let i = 0; i < ripples; i++) {
    const y = rng.intRange(1, PX_PER_TILE - 2);
    const x = rng.intRange(0, PX_PER_TILE - 4);
    blk(ctx, x, y, C.sandRipple, 3, 1);
    blk(ctx, x + 1, y + 1, C.sandDark, 2, 1);
  }
}

function drawRock(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.fillStyle = C.rockGround;
  ctx.fillRect(0, 0, TILE, TILE);
  for (let i = 0; i < 12; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), C.rockShadow);
  }
  const boulders = rng.intRange(3, 5);
  for (let i = 0; i < boulders; i++) {
    const w = rng.intRange(3, 5);
    const h = rng.intRange(2, 4);
    const x = rng.intRange(0, PX_PER_TILE - w);
    const y = rng.intRange(0, PX_PER_TILE - h);
    blk(ctx, x, y + h, C.rockShadow, w, 1); // ground shadow
    blk(ctx, x, y, C.rockBody, w, h);
    blk(ctx, x, y, C.rockLight, w - 1, 1); // lit top
    blk(ctx, x + w - 1, y + 1, C.rockShadow, 1, h - 1); // right face
  }
}

function drawCliff(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.fillStyle = C.cliffFace;
  ctx.fillRect(0, 0, TILE, TILE);
  // Blocky plateau top with a lit rim and a heavy drop shadow.
  blk(ctx, 0, 0, C.cliffTop, PX_PER_TILE, PX_PER_TILE - 2);
  blk(ctx, 0, 0, C.cliffLight, PX_PER_TILE, 1);
  blk(ctx, 0, PX_PER_TILE - 2, C.cliffFace, PX_PER_TILE, 1);
  blk(ctx, 0, PX_PER_TILE - 1, C.cliffShadow, PX_PER_TILE, 1);
  // Fissures.
  const cracks = rng.intRange(2, 4);
  for (let i = 0; i < cracks; i++) {
    const x = rng.intRange(1, PX_PER_TILE - 2);
    const y = rng.intRange(1, PX_PER_TILE - 4);
    const len = rng.intRange(2, 4);
    blk(ctx, x, y, C.cliffShadow, 1, len);
    blk(ctx, x + 1, y, C.cliffLight, 1, 1);
  }
}

function drawCrystal(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.fillStyle = C.crystalGround;
  ctx.fillRect(0, 0, TILE, TILE);
  for (let i = 0; i < 10; i++) {
    blk(ctx, rng.int(PX_PER_TILE), rng.int(PX_PER_TILE), C.crystalDark);
  }

  // Soft green glow behind the shards.
  const glow = ctx.createRadialGradient(TILE / 2, TILE / 2, 1, TILE / 2, TILE / 2, TILE * 0.7);
  glow.addColorStop(0, C.crystalGlow);
  glow.addColorStop(1, 'rgba(90, 240, 130, 0)');
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
      blk(ctx, rx, y + row, C.crystalBody, w, 1);
    }
    blk(ctx, x, y, C.crystalHot); // tip
    blk(ctx, x, y + 1, C.crystalLight);
    blk(ctx, x - 1, y + h - 1, C.crystalDark);
    blk(ctx, x + 1, y + h - 1, C.crystalDark);
  }
}

const TERRAIN_DRAWERS: Record<number, (ctx: CanvasRenderingContext2D, rng: Rng) => void> = {
  [Terrain.Grass]: drawGrass,
  [Terrain.Sand]: drawSand,
  [Terrain.Rock]: drawRock,
  [Terrain.Cliff]: drawCliff,
  [Terrain.Crystal]: drawCrystal,
};

// terrainIndex * TERRAIN_VARIANTS + variant
let terrainSprites: Canvas[] = [];

/** Build (or rebuild) every cached sprite. Safe to call once at boot. */
export function initSprites(seed = SPRITE_SEED): void {
  terrainSprites = [];
  for (let t = 0; t < TERRAIN_COUNT; t++) {
    for (let v = 0; v < TERRAIN_VARIANTS; v++) {
      const { canvas, ctx } = makeCanvas(TILE, TILE);
      const rng = makeRng((seed + t * 977 + v * 31) >>> 0);
      const draw = TERRAIN_DRAWERS[t];
      if (draw) draw(ctx, rng);
      terrainSprites.push(canvas);
    }
  }
  unitCache.clear();
  buildingCache.clear();
  iconCache.clear();
  fxCache.clear();
}

export function getTerrainSprite(terrain: Terrain, variant: number): Canvas {
  if (terrainSprites.length === 0) initSprites();
  const t = terrain % TERRAIN_COUNT;
  const v = variant % TERRAIN_VARIANTS;
  return terrainSprites[t * TERRAIN_VARIANTS + v] as Canvas;
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
    default:
      return null;
  }
}

function towerTurretShapes(sc: Scheme): Shape[] {
  return [
    S(-3, -2, 6, 4, sc.hull),
    S(-3, -2, 6, 1, sc.hullLight),
    S(-3, -2, 1, 4, sc.accent),
    S(1, -3, 2, 6, sc.hullDark), // gun shield
    S(3, -1, 5, 2, sc.barrel),
    S(8, -1, 1, 2, MUZZLE_DARK),
  ];
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

/** Guard-tower gun, composited over the tower base at `turretFacing`. */
export function getTowerTurret(player: number, dir: number): Canvas {
  const p = player === 1 ? 1 : 0;
  const d = ((dir % FACINGS) + FACINGS) % FACINGS;
  const key = `t|guardTower|${p}|${d}`;
  const cached = unitCache.get(key);
  if (cached) return cached;
  const sc = schemeFor(p);
  const canvas = rasterizeBody(towerTurretShapes(sc), (d / FACINGS) * Math.PI * 2, sc.outline);
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

  for (let t = 0; t < TERRAIN_COUNT; t++) {
    for (let v = 0; v < TERRAIN_VARIANTS; v++) {
      out.push(auditEntry(`terrain|${t}|${v}`, getTerrainSprite(t as Terrain, v)));
    }
  }

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

  for (const player of [0, 1]) {
    for (let d = 0; d < FACINGS; d++) {
      out.push(auditEntry(`turret|guardTower|${player}|${d}`, getTowerTurret(player, d)));
    }
  }

  // V2: the aircraft rotor disc is facing-independent, so it is cached per
  // (player, frame) rather than per facing.
  for (const player of [0, 1]) {
    for (let f = 0; f < ROTOR_FRAMES; f++) {
      out.push(auditEntry(`rotor|${player}|${f}`, getRotorSprite(player, f)));
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

  return out;
}
