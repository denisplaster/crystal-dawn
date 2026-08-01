/** Core tunables and shared identifiers. Pure constants + tile/world math only. */

/** Logic tick length in ms (20 Hz fixed timestep). */
export const TICK_MS = 50;
export const TICKS_PER_SECOND = 1000 / TICK_MS; // 20
/** Convert seconds -> whole ticks. */
export const secondsToTicks = (s: number): number => Math.round(s * TICKS_PER_SECOND);

/** Tile size in world pixels. */
export const TILE = 24;
export const MAP_W = 96;
export const MAP_H = 96;
export const WORLD_W = MAP_W * TILE;
export const WORLD_H = MAP_H * TILE;

/** Reserved width of the right-hand sidebar (Phase 6 fills it in). */
export const SIDEBAR_W = 200;

/** Camera panning. */
export const EDGE_SCROLL_MARGIN = 20;
export const PAN_SPEED = 14; // world px per tick (~280 px/s)
export const PAN_SPEED_FAST = 28; // with shift held

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export type PlayerId = 0 | 1;
export const PLAYER_HUMAN: PlayerId = 0;
export const PLAYER_AI: PlayerId = 1;
export const PLAYER_COUNT = 2;

export const FACTION_NAMES: readonly [string, string] = ['Coalition', 'The Order'];
/** Team colours (house colours), human first. */
export const PLAYER_COLORS: readonly [string, string] = ['#e0b53c', '#c8402c'];
export const PLAYER_COLORS_DARK: readonly [string, string] = ['#8a6b18', '#7a2318'];

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------

export const START_CREDITS = 5000;
/**
 * Base credit storage (ConYard). Silos add to this.
 *
 * Phase 7: 2000 -> 5000, so the 5000cr opening bank is never above the cap and
 * a fresh base banks its first harvester load instead of burning it. Silos are
 * still needed the moment a player wants to sit on real money (a refinery only
 * adds 1000, so ~8000 banked takes two of them).
 */
export const BASE_STORAGE = 5000;
export const SILO_STORAGE = 1500;
/** Credits a harvester hauls per full load. */
export const HARVESTER_CAPACITY = 700;
/**
 * Credits worth of crystal on a freshly generated crystal tile.
 *
 * Phase 7: 1500 -> 600 (~1 harvester load per tile instead of ~2). A generated
 * map held ~413k credits and a 20-minute game consumed under a quarter of it;
 * at 600 the home fields run down inside a normal game, which is what pushes
 * both sides onto the contested neutral fields.
 */
export const CRYSTAL_TILE_AMOUNT = 600;
/** Credits scooped out of a tile per harvest tick. */
export const HARVEST_RATE = 25;

/** Fraction of a structure's cost refunded when the owner sells it. */
export const SELL_REFUND = 0.5;
/** Ticks a sold structure spends dismantling itself before it dies (1.5s). */
export const SELL_TIME = secondsToTicks(1.5);

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

export enum Terrain {
  Grass = 0,
  Sand = 1,
  Rock = 2,
  Cliff = 3,
  Crystal = 4,
}

export const TERRAIN_COUNT = 5;
/** Distinct procedural variants baked per terrain type. */
export const TERRAIN_VARIANTS = 4;

export const TERRAIN_NAMES: readonly string[] = ['grass', 'sand', 'rock', 'cliff', 'crystal'];

/** Terrain that ground units can drive over. */
export const TERRAIN_PASSABLE: readonly boolean[] = [true, true, false, false, true];
/** Terrain that structures may be placed on. */
export const TERRAIN_BUILDABLE: readonly boolean[] = [true, true, false, false, false];
/** Per-terrain movement cost multiplier (1 = full speed). */
export const TERRAIN_COST: readonly number[] = [1, 1.15, Infinity, Infinity, 1.25];

// ---------------------------------------------------------------------------
// Tile <-> world helpers
// ---------------------------------------------------------------------------

/** Tile index -> world pixel of the tile's top-left corner. */
export const tileToWorld = (t: number): number => t * TILE;
/** Tile index -> world pixel of the tile centre. */
export const tileCenter = (t: number): number => t * TILE + TILE / 2;
/** World pixel -> tile index (unclamped). */
export const worldToTile = (px: number): number => Math.floor(px / TILE);
/** Flat index into the map grids. */
export const tileIndex = (tx: number, ty: number): number => ty * MAP_W + tx;
export const inBounds = (tx: number, ty: number): boolean =>
  tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Sim-wide caps (perf guardrails for later phases). */
export const MAX_UNITS_PER_PLAYER = 150;
