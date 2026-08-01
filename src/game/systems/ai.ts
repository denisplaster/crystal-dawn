/**
 * AI — the skirmish opponent for player 1 ("The Order").
 *
 * Scripted but reactive, in the spirit of the classic games: a fixed opening
 * build order that self-heals into a rebuild list, continuous unit production
 * once the production structures are up, and timed attack waves that grow.
 *
 * Design constraints (Phase 4 handoff):
 *   - The AI has **perfect information**. `state.fog` belongs to the human
 *     player only and is never read here.
 *   - Everything goes through the ordinary order machinery: `issueGroundOrder`
 *     for waves and defence (formation spread + engage/resume come free with
 *     `attackMove`), `issueAttackOrder` for focused strikes, `stopUnits` to
 *     break off. No unit is ever steered directly.
 *   - Structures are queued with the same `enqueue`/`placeStructure` calls the
 *     sidebar uses, and validated with the same `canPlaceAt` — the AI simply
 *     skips the UI.
 *   - Decisions run once every `AI_INTERVAL` ticks (staggered off a fixed
 *     phase), so the per-tick cost is ~1/10th of what the code below suggests.
 *     Unit micro is left entirely to combat/movement.
 *   - No `Math.random`: every choice comes from `state.rng`.
 *
 * All mutable AI bookkeeping lives on `GameState.ai`, so a restart (a fresh
 * `createGameState`) wipes it with everything else.
 */

import {
  MAP_H,
  MAP_W,
  PLAYER_AI,
  PLAYER_HUMAN,
  SELL_REFUND,
  TILE,
  clamp,
  secondsToTicks,
  tileCenter,
  worldToTile,
} from '../constants';
import { isPassable } from '../map';
import { findNearestPassable } from '../pathfinding';
import {
  BUILDING_TYPES,
  UNIT_TYPES,
  type BuildingTypeId,
  type UnitTypeId,
} from '../rules';
import type { Building, GameState, PlayerState, TilePos, Unit } from '../state';
import { distanceToEntity, issueAttackOrder } from './combat';
import { issueGroundOrder, stopUnits } from './orders';
import {
  MAX_UNIT_QUEUE,
  canBuild,
  canPlaceAt,
  cancelQueueItem,
  enqueue,
  hasBuilding,
  placeStructure,
  sellBuilding,
} from './production';

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

export type AiDifficulty = 'easy' | 'normal' | 'hard';

export interface AiDifficultyDef {
  id: AiDifficulty;
  name: string;
  /** Credits handed to the AI on top of `START_CREDITS` at skirmish setup. */
  creditBonus: number;
  /** Tick the first wave may launch. */
  firstWave: number;
  /** Ticks between waves; jittered between the two by `state.rng`. */
  intervalMin: number;
  intervalMax: number;
  /** Units the first wave asks for (plus 0..2 of rng jitter). */
  waveStart: number;
  /** Units added to the ask after every wave. */
  waveGrowth: number;
  /** Largest wave the AI will ever assemble. */
  waveCap: number;
  /** Combat units alive + queued before unit production pauses. */
  armyCap: number;
}

export const AI_DIFFICULTY: Record<AiDifficulty, AiDifficultyDef> = {
  easy: {
    id: 'easy',
    name: 'Easy',
    creditBonus: 0,
    firstWave: secondsToTicks(330),
    intervalMin: secondsToTicks(240),
    intervalMax: secondsToTicks(300),
    waveStart: 4,
    waveGrowth: 1,
    waveCap: 10,
    armyCap: 20,
  },
  normal: {
    id: 'normal',
    name: 'Normal',
    creditBonus: 1500,
    firstWave: secondsToTicks(240),
    intervalMin: secondsToTicks(150),
    intervalMax: secondsToTicks(210),
    waveStart: 5,
    waveGrowth: 2,
    waveCap: 16,
    armyCap: 34,
  },
  hard: {
    id: 'hard',
    name: 'Hard',
    creditBonus: 4000,
    firstWave: secondsToTicks(180),
    intervalMin: secondsToTicks(110),
    intervalMax: secondsToTicks(150),
    waveStart: 7,
    waveGrowth: 3,
    waveCap: 20,
    armyCap: 48,
  },
};

export const AI_DIFFICULTY_IDS: readonly AiDifficulty[] = ['easy', 'normal', 'hard'];

export const DEFAULT_AI_DIFFICULTY: AiDifficulty = 'normal';

export function isAiDifficulty(v: string): v is AiDifficulty {
  return v === 'easy' || v === 'normal' || v === 'hard';
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Decisions run on ticks where `tick % AI_INTERVAL === AI_PHASE`. */
export const AI_INTERVAL = 10;
const AI_PHASE = 3;

/** Human units this close (tiles) to the AI ConYard trigger the defence. */
const DEFEND_RADIUS = 10;
/** Hysteresis: the defence stands down once the base is clear out to here. */
const DEFEND_CLEAR_RADIUS = 13;

/** Tiles from the base centre the staging point sits, toward the human. */
const STAGING_OFFSET = 6;
/** A rallying unit inside this many tiles of the staging point is "there". */
const STAGING_SLACK = 4;

/** Wait at most this long past `nextWaveTick` for the full wave to assemble. */
const WAVE_GRACE = secondsToTicks(75);
/** Never launch with fewer than this many units. */
const MIN_WAVE = 3;
/** Attackers within this many tiles of the wave target focus-fire it. */
const FOCUS_RANGE = TILE * 8;

/** Rings searched outward from the placement anchor. */
const PLACE_MAX_RADIUS = 18;
/** Consecutive failed placements before the ready structure is refunded. */
const PLACE_FAIL_LIMIT = 24;

/** Home field this far below its starting crystal counts as "depleted". */
const FIELD_DEPLETED = 0.35;

/**
 * Structures the AI will not let itself run out of, in build order.
 *
 * `only` (V2) gates an entry on difficulty: the helipad is an easy-mode-free
 * extra, so an easy AI never fields aircraft and the opening it plays is
 * bit-identical to the pre-V2 one.
 */
const BUILD_PLAN: readonly {
  type: BuildingTypeId;
  count: number;
  only?: readonly AiDifficulty[];
}[] = [
  { type: 'powerPlant', count: 1 },
  { type: 'refinery', count: 1 },
  { type: 'barracks', count: 1 },
  { type: 'powerPlant', count: 2 },
  { type: 'warFactory', count: 1 },
  { type: 'helipad', count: 1, only: ['normal', 'hard'] },
  { type: 'guardTower', count: 2 },
  { type: 'commCenter', count: 1 },
];

/** Wave number from which the AI folds aircraft into its attacks (wave 3). */
const AIR_FROM_WAVE = 3;
/** Aircraft the AI keeps in the field, by difficulty. */
const AIR_WANTED: Readonly<Record<AiDifficulty, number>> = { easy: 0, normal: 1, hard: 2 };

/** Losing one of these is an emergency: units wait, the rebuild goes first. */
const CRITICAL: ReadonlySet<BuildingTypeId> = new Set<BuildingTypeId>([
  'refinery',
  'barracks',
  'warFactory',
]);

const MAX_POWER_PLANTS = 6;
const MAX_SILOS = 4;
const MAX_TOWERS = 4;
const MAX_REFINERIES = 2;
const MAX_HARVESTERS = 3;
/**
 * Phase 7 late-game sink. Once the army is capped the AI has nothing to buy and
 * simply pins at its storage ceiling. When it is pinned (credits above this
 * fraction of storage) it spends the surplus: first the last two guard towers,
 * then up to `LATE_EXTRA_SILOS` more silos, which raises the ceiling it is
 * pinned against. On 'hard' it also asks for a bigger wave.
 */
const PIN_FRACTION = 0.8;
const LATE_EXTRA_SILOS = 3;
/** Extra units a pinned 'hard' AI adds to its wave ask, once per wave. */
const PIN_WAVE_BONUS = 2;
/**
 * Structures the AI is willing to sell to fund an emergency rebuild, cheapest
 * loss first. The ConYard and the production structures (barracks / war
 * factory) are never on this list; power plants only qualify while a spare one
 * exists and the base stays out of deficit (see `emergencySell`).
 */
const SELLABLE_FOR_CASH: readonly BuildingTypeId[] = [
  'silo',
  'sandbag',
  'guardTower',
  'commCenter',
  'powerPlant',
];
/** Infantry share of the army above which the AI only buys vehicles. */
const INFANTRY_SHARE = 0.55;
/** Fraction of a unit's price the AI wants banked before committing to it. */
const COMMIT_FRACTION = 0.65;
/** Ticks the AI will save toward one unit choice before re-rolling it. */
const WANT_TIMEOUT = secondsToTicks(45);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface AiState {
  difficulty: AiDifficulty;
  /** Tile the next wave gathers on (between the AI base and the human). */
  staging: TilePos;
  /** Earliest tick the next wave may launch. */
  nextWaveTick: number;
  /** Waves launched so far. */
  waveNumber: number;
  /** Units the next wave wants. */
  waveSize: number;
  /** Unit ids currently on the offensive. */
  attackers: number[];
  /** Unit ids pulled back to defend the base. */
  defenders: number[];
  /** Where the defence was last sent, or null when not defending. */
  defendTile: TilePos | null;
  /** Ground target of the current wave. */
  targetTile: TilePos | null;
  /** Entity id of the current wave's preferred target, if it has one. */
  targetId: number | null;
  /** Flat tile indices of the crystal field next to the AI start. */
  homeField: number[];
  /** Crystal in `homeField` when the skirmish started. */
  homeFieldStart: number;
  /** Consecutive ticks a completed structure could not be placed. */
  placeFails: number;
  /** Unit the AI has settled on and is saving up for, if any. */
  wantUnit: UnitTypeId | null;
  /** Tick `wantUnit` was chosen (the choice is re-rolled if it stalls). */
  wantSince: number;
  /** Last wave number the late-game credit pin bumped `waveSize` on. */
  pinBumpWave: number;
}

/**
 * Fresh AI bookkeeping. Call after the starting base exists — the staging
 * point and the home crystal field are derived from the map + the base.
 */
export function createAiState(
  state: GameState,
  difficulty: AiDifficulty = DEFAULT_AI_DIFFICULTY,
): AiState {
  const def = AI_DIFFICULTY[difficulty];
  const field = homeFieldOf(state);
  let total = 0;
  for (const idx of field) total += state.map.crystal[idx] as number;

  return {
    difficulty,
    staging: stagingTile(state),
    nextWaveTick: def.firstWave,
    waveNumber: 0,
    waveSize: def.waveStart + state.rng.int(3),
    attackers: [],
    defenders: [],
    defendTile: null,
    targetTile: null,
    targetId: null,
    homeField: field,
    homeFieldStart: Math.max(1, total),
    placeFails: 0,
    wantUnit: null,
    wantSince: 0,
    pinBumpWave: -1,
  };
}

/** Read (and optionally change) the difficulty of the running skirmish. */
export function aiDifficulty(state: GameState, level?: AiDifficulty): AiDifficulty {
  const ai = state.ai;
  if (!ai) return DEFAULT_AI_DIFFICULTY;
  if (level && level !== ai.difficulty) {
    const def = AI_DIFFICULTY[level];
    ai.difficulty = level;
    // Re-scale the schedule so the change takes effect from here on.
    ai.waveSize = clamp(ai.waveSize, def.waveStart, def.waveCap);
    ai.nextWaveTick = Math.min(
      ai.nextWaveTick,
      state.tick + def.intervalMax,
    );
  }
  return ai.difficulty;
}

// ---------------------------------------------------------------------------
// Map / base helpers
// ---------------------------------------------------------------------------

function startTile(state: GameState, player: number): TilePos {
  const t = state.map.startTiles[player];
  return t ? { tx: t.tx, ty: t.ty } : { tx: Math.floor(MAP_W / 2), ty: Math.floor(MAP_H / 2) };
}

/** The AI's ConYard, or its first surviving structure. */
function baseBuilding(state: GameState): Building | undefined {
  let fallback: Building | undefined;
  for (const b of state.buildings) {
    if (b.dead || b.player !== PLAYER_AI) continue;
    if (b.type === 'conyard') return b;
    if (!fallback) fallback = b;
  }
  return fallback;
}

function centerTileOf(b: Building): TilePos {
  return { tx: b.tx + ((b.w - 1) >> 1), ty: b.ty + ((b.h - 1) >> 1) };
}

/** Centre of the AI base in tiles (falls back to the start position). */
function baseTile(state: GameState): TilePos {
  const b = baseBuilding(state);
  return b ? centerTileOf(b) : startTile(state, PLAYER_AI);
}

/** Unit-length vector from the AI base toward the human start. */
function towardHuman(state: GameState): { x: number; y: number } {
  const from = baseTile(state);
  const to = startTile(state, PLAYER_HUMAN);
  const dx = to.tx - from.tx;
  const dy = to.ty - from.ty;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** Passable tile `dist` tiles from the base along `dir`. */
function offsetTile(state: GameState, base: TilePos, dir: { x: number; y: number }, dist: number): TilePos {
  const tx = clamp(Math.round(base.tx + dir.x * dist), 1, MAP_W - 2);
  const ty = clamp(Math.round(base.ty + dir.y * dist), 1, MAP_H - 2);
  if (isPassable(state.map, tx, ty)) return { tx, ty };
  const alt = findNearestPassable(state.map, tx, ty, 8);
  return alt ? { tx: alt.tx, ty: alt.ty } : { tx, ty };
}

function stagingTile(state: GameState): TilePos {
  return offsetTile(state, baseTile(state), towardHuman(state), STAGING_OFFSET);
}

/** Flat tile indices of the crystal field the AI starts next to. */
function homeFieldOf(state: GameState): number[] {
  const start = startTile(state, PLAYER_AI);
  let best: number[] | null = null;
  let bestD = Infinity;
  for (const f of state.map.crystalFields) {
    // Prefer the field the generator tagged as the AI's, else the closest one.
    const d =
      (f.nearStart === PLAYER_AI ? 0 : 1000) +
      Math.hypot(f.tx - start.tx, f.ty - start.ty);
    if (d < bestD) {
      bestD = d;
      best = f.tiles;
    }
  }
  return best ? best.slice() : [];
}

function homeFieldLeft(state: GameState, ai: AiState): number {
  let total = 0;
  for (const idx of ai.homeField) total += state.map.crystal[idx] as number;
  return total;
}

// ---------------------------------------------------------------------------
// Roster helpers
// ---------------------------------------------------------------------------

function isCombatUnit(u: Unit): boolean {
  const def = UNIT_TYPES[u.type];
  return def.weapon !== null && def.kind !== 'harvester';
}

function countBuildings(state: GameState, type: BuildingTypeId): number {
  let n = 0;
  for (const b of state.buildings) {
    if (!b.dead && b.player === PLAYER_AI && b.type === type) n++;
  }
  return n;
}

function countUnits(state: GameState, type: UnitTypeId): number {
  let n = 0;
  for (const u of state.units) {
    if (!u.dead && u.player === PLAYER_AI && u.type === type) n++;
  }
  return n;
}

function countQueued(p: PlayerState, type: UnitTypeId): number {
  let n = 0;
  for (const it of p.queues.units.items) if (it.type === type) n++;
  return n;
}

function isIdle(u: Unit): boolean {
  // V2: an aircraft sitting on its pad rearming is *busy*, however empty its
  // order slot looks. Without this the rally/attack logic would scramble it
  // half-armed every decision.
  if (u.docked) return false;
  return u.order === undefined && (u.orderQueue === undefined || u.orderQueue.length === 0);
}

/** Combat units alive plus the ones still in the queue (the army-cap metric). */
function armySize(state: GameState, p: PlayerState): { army: number; infantry: number } {
  let army = 0;
  let infantry = 0;
  for (const u of state.units) {
    if (u.dead || u.player !== PLAYER_AI || !isCombatUnit(u)) continue;
    army++;
    if (UNIT_TYPES[u.type].kind === 'infantry') infantry++;
  }
  for (const it of p.queues.units.items) {
    const d = UNIT_TYPES[it.type as UnitTypeId];
    if (!d || d.weapon === null || d.kind === 'harvester') continue;
    army++;
    if (d.kind === 'infantry') infantry++;
  }
  return { army, infantry };
}

/** Credits parked against the storage ceiling with nothing left to buy. */
function creditsPinned(p: PlayerState): boolean {
  return p.credits > p.storage * PIN_FRACTION;
}

// ---------------------------------------------------------------------------
// Structure placement
// ---------------------------------------------------------------------------

/**
 * Where the ring search starts. Defences push out toward the human; the
 * refinery leans toward the crystal the harvester will work; everything else
 * packs around the ConYard.
 */
function placementAnchor(state: GameState, ai: AiState, type: BuildingTypeId): TilePos {
  const base = baseTile(state);
  if (type === 'guardTower' || type === 'sandbag') {
    return offsetTile(state, base, towardHuman(state), 5);
  }
  if (type === 'refinery' || type === 'silo') {
    // Toward the middle of the home field, but only a few tiles out — the
    // build radius will reject anything further anyway.
    if (ai.homeField.length > 0) {
      let sx = 0;
      let sy = 0;
      for (const idx of ai.homeField) {
        sx += idx % MAP_W;
        sy += Math.floor(idx / MAP_W);
      }
      const cx = sx / ai.homeField.length;
      const cy = sy / ai.homeField.length;
      const dx = cx - base.tx;
      const dy = cy - base.ty;
      const len = Math.hypot(dx, dy) || 1;
      return offsetTile(state, base, { x: dx / len, y: dy / len }, 4);
    }
  }
  return base;
}

/**
 * First valid top-left tile for `type`, searched in rings out from the anchor.
 * Uses exactly the validation the human's placement mode uses, so the AI plays
 * by the same rules (buildable terrain, no overlap, no burying units, inside
 * the build radius).
 */
export function findPlacementTile(
  state: GameState,
  ai: AiState,
  type: BuildingTypeId,
): TilePos | null {
  const def = BUILDING_TYPES[type];
  const anchor = placementAnchor(state, ai, type);
  const offX = (def.w - 1) >> 1;
  const offY = (def.h - 1) >> 1;

  const tryAt = (cx: number, cy: number): TilePos | null => {
    const tx = cx - offX;
    const ty = cy - offY;
    if (tx < 0 || ty < 0 || tx + def.w > MAP_W || ty + def.h > MAP_H) return null;
    return canPlaceAt(state, PLAYER_AI, type, tx, ty) ? { tx, ty } : null;
  };

  const hit = tryAt(anchor.tx, anchor.ty);
  if (hit) return hit;

  for (let r = 1; r <= PLACE_MAX_RADIUS; r++) {
    for (let oy = -r; oy <= r; oy++) {
      const edge = oy === -r || oy === r;
      for (let ox = -r; ox <= r; ox++) {
        if (!edge && ox !== -r && ox !== r) continue; // ring only
        const found = tryAt(anchor.tx + ox, anchor.ty + oy);
        if (found) return found;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build order
// ---------------------------------------------------------------------------

/** Does the AI want a second refinery / another harvester? */
function needsMoreEconomy(state: GameState, ai: AiState): boolean {
  if (ai.homeField.length > 0 && homeFieldLeft(state, ai) < ai.homeFieldStart * FIELD_DEPLETED) {
    return true;
  }
  // A harvester that has been alive a while and still cannot find crystal is
  // the harvest system telling us the field is done.
  for (const u of state.units) {
    if (u.dead || u.player !== PLAYER_AI || u.type !== 'harvester') continue;
    if (state.tick - (u.spawnTick ?? 0) < 400) continue;
    // Post-release: a harvester sitting out a danger hold is `seeking` with no
    // tile too, but it is hiding, not starved. Reading that as "the field is
    // done" would have the AI buy a refinery every time a harvester is shot at.
    if (state.tick < (u.dangerHoldUntil ?? 0)) continue;
    if (u.harvestState === 'seeking' && u.harvestTile === undefined) return true;
  }
  return false;
}

/** The structure the AI wants next, or null when it is content. */
function nextStructure(state: GameState, ai: AiState, p: PlayerState): BuildingTypeId | null {
  const want = (type: BuildingTypeId): boolean => canBuild(state, PLAYER_AI, type);

  // 1. Power first, always: a deficit halves every build in the base.
  const margin = p.powerProduced - p.powerDrain;
  if ((p.lowPower || margin < 25) && countBuildings(state, 'powerPlant') < MAX_POWER_PLANTS) {
    if (want('powerPlant')) return 'powerPlant';
  }

  // 2. The opening, which doubles as the rebuild list: any plan entry that has
  //    fallen below its target count is re-queued.
  for (const step of BUILD_PLAN) {
    if (step.only && !step.only.includes(ai.difficulty)) continue;
    if (countBuildings(state, step.type) >= step.count) continue;
    if (want(step.type)) return step.type;
  }

  // 3. Credits pinned against storage: bank them.
  if (p.credits >= p.storage - 200 && countBuildings(state, 'silo') < MAX_SILOS && want('silo')) {
    return 'silo';
  }

  // 4. The home field is running dry: expand.
  if (
    countBuildings(state, 'refinery') < MAX_REFINERIES &&
    p.credits >= 2600 &&
    needsMoreEconomy(state, ai) &&
    want('refinery')
  ) {
    return 'refinery';
  }

  // 5. Late-game: thicken the perimeter with spare cash.
  if (
    ai.waveNumber >= 3 &&
    countBuildings(state, 'guardTower') < MAX_TOWERS &&
    p.credits >= 1500 &&
    want('guardTower')
  ) {
    return 'guardTower';
  }

  // 6. Phase 7 — the late-game credit pin. Army capped and the bank full: the
  //    AI used to sit on 10000cr forever. Spend it on defence first, then on
  //    silos, which raise the ceiling so the next pin is further away.
  if (creditsPinned(p) && armySize(state, p).army >= AI_DIFFICULTY[ai.difficulty].armyCap) {
    if (countBuildings(state, 'guardTower') < MAX_TOWERS && want('guardTower')) {
      return 'guardTower';
    }
    if (countBuildings(state, 'silo') < MAX_SILOS + LATE_EXTRA_SILOS && want('silo')) {
      return 'silo';
    }
  }

  return null;
}

/**
 * Raise cash by dismantling something the AI can live without. Used only when a
 * critical structure (in practice: the refinery) is being rebuilt and there is
 * not enough money to finish it — the position where Phase 5 measured the AI
 * frozen at 4 credits for eight sim-minutes.
 *
 * Never sells the ConYard, a production structure or its last power plant, and
 * never puts itself into a power deficit (that would halve the very rebuild it
 * is paying for). Returns the credits raised.
 */
function emergencySell(state: GameState, p: PlayerState, need: number): number {
  /** Cheapest-loss-first candidate of this type, or undefined. */
  const pick = (type: BuildingTypeId): Building | undefined => {
    if (type === 'powerPlant') {
      // Only a spare plant, and only while the base stays out of deficit — a
      // deficit would halve the very rebuild this is paying for.
      if (countBuildings(state, 'powerPlant') <= 1) return undefined;
      if (p.powerProduced - BUILDING_TYPES.powerPlant.power < p.powerDrain) return undefined;
    }
    // Lowest id first: the oldest structure, which sits deepest inside the base
    // and is least likely to be a fresh forward defence.
    let victim: Building | undefined;
    for (const b of state.buildings) {
      if (b.dead || b.player !== PLAYER_AI || b.type !== type) continue;
      if (b.status !== 'ready') continue;
      if (!victim || b.id < victim.id) victim = b;
    }
    return victim;
  };

  // With no refinery standing the AI's income is exactly zero, so a sale that
  // does not fully cover the rebuild just loses the base for nothing. Only
  // commit when the whole shortfall can be raised. (With a refinery still
  // pumping, a partial sale plus income does finish the job.)
  if (countBuildings(state, 'refinery') === 0) {
    let raisable = 0;
    for (const type of SELLABLE_FOR_CASH) {
      if (!pick(type)) continue;
      for (const b of state.buildings) {
        if (b.dead || b.player !== PLAYER_AI || b.type !== type || b.status !== 'ready') continue;
        raisable += Math.floor(BUILDING_TYPES[type].cost * SELL_REFUND);
      }
    }
    if (p.credits + raisable < need) return 0;
  }

  let raised = 0;
  for (const type of SELLABLE_FOR_CASH) {
    while (p.credits < need) {
      const victim = pick(type);
      if (!victim) break;
      const got = sellBuilding(state, PLAYER_AI, victim);
      if (got < 0) break;
      raised += got;
    }
    if (p.credits >= need) break;
  }
  return raised;
}

/** True while the structure queue holds a rebuild of something essential. */
function criticalPending(p: PlayerState): boolean {
  const head = p.queues.structures.items[0];
  return head !== undefined && CRITICAL.has(head.type as BuildingTypeId);
}

function stepStructures(state: GameState, ai: AiState, p: PlayerState): void {
  const queue = p.queues.structures;
  const head = queue.items[0];

  if (head && head.ready) {
    const type = head.type as BuildingTypeId;
    const tile = findPlacementTile(state, ai, type);
    if (tile) {
      placeStructure(state, PLAYER_AI, tile.tx, tile.ty);
      ai.placeFails = 0;
    } else if (++ai.placeFails >= PLACE_FAIL_LIMIT) {
      // Nowhere left to put it (boxed in / base overrun): take the refund and
      // let the next decision pick something else.
      cancelQueueItem(state, PLAYER_AI, 'structures');
      ai.placeFails = 0;
    }
    return;
  }
  if (head) return; // still building

  const want = nextStructure(state, ai, p);
  if (want) enqueue(state, PLAYER_AI, want);
}

// ---------------------------------------------------------------------------
// Unit production
// ---------------------------------------------------------------------------

/**
 * Weighted roll for what the AI *wants* to build next, ignoring the bank
 * balance entirely. Affordability is handled by the caller, which saves up for
 * the choice — rolling against current credits instead would mean the cheapest
 * unlocked unit always crosses the affordability line first and the AI would
 * never field anything but minigunners and light tanks.
 *
 * The share rule is the other half of that: there is a single unit queue per
 * player, so 100cr minigunners roll out ~3x faster than armour and would eat
 * the whole army cap in the first few minutes if left unchecked.
 */
function rollWantedUnit(
  state: GameState,
  ai: AiState,
  army: number,
  infantry: number,
): UnitTypeId | null {
  const pool: UnitTypeId[] = [];
  const add = (type: UnitTypeId, weight: number): void => {
    if (weight <= 0) return;
    if (!canBuild(state, PLAYER_AI, type)) return;
    for (let i = 0; i < weight; i++) pool.push(type);
  };

  const hasWF = hasBuilding(state, PLAYER_AI, 'warFactory');
  const hasCC = hasBuilding(state, PLAYER_AI, 'commCenter');
  const infantryOk = !hasWF || army === 0 || infantry / army < INFANTRY_SHARE;

  add('minigunner', !hasWF ? 6 : infantryOk ? 2 : 0);
  add('rocketSoldier', !hasWF ? 3 : infantryOk ? 3 : 0);
  if (hasWF) {
    add('lightTank', hasCC ? 3 : 6);
    if (hasCC) {
      add('mediumTank', 5);
      // Artillery is a siege weapon: only worth it once the waves are big
      // enough to screen it.
      if (ai.waveNumber >= 2) add('artillery', 3);
    }
  }

  if (pool.length === 0) return null;
  return state.rng.pick(pool);
}

function stepUnits(state: GameState, ai: AiState, p: PlayerState): void {
  const queue = p.queues.units;
  // Keep the pipeline short so a harvester or a rebuild can jump the line.
  if (queue.items.length >= Math.min(2, MAX_UNIT_QUEUE)) return;

  const refineries = countBuildings(state, 'refinery');
  // Economy insurance. With no refinery the AI's income is *exactly* zero, so
  // spending its last credit while it is down to a single one is a way to lose
  // the game permanently: a sniped refinery could never be replaced. While it
  // has one and only one, it keeps the price of a spare banked. Structures are
  // deliberately not gated by this — only unit production is.
  const reserve = refineries === 1 ? BUILDING_TYPES.refinery.cost : 0;
  const spendable = p.credits - reserve;

  // --- harvesters first: no economy, no army ---
  if (refineries > 0 && hasBuilding(state, PLAYER_AI, 'warFactory')) {
    const have = countUnits(state, 'harvester') + countQueued(p, 'harvester');
    // One per refinery is the replacement floor; a spare is worth buying once
    // the bank can carry it or the home field is thinning out.
    let desired = refineries;
    if (p.credits >= 2500 || needsMoreEconomy(state, ai)) desired = refineries + 1;
    desired = Math.min(MAX_HARVESTERS, desired);
    if (have < desired && spendable >= UNIT_TYPES.harvester.cost) {
      if (enqueue(state, PLAYER_AI, 'harvester')) return;
    }
  }

  // --- an essential structure is being replaced: hold the war chest ---
  if (criticalPending(p)) {
    const head = p.queues.structures.items[0];
    const cost = head ? BUILDING_TYPES[head.type as BuildingTypeId].cost : 0;
    const owed = cost - (head ? head.spent : 0);
    // Units already in the queue keep drip-charging and would happily spend the
    // rebuild money out from under it — with a razed refinery that is fatal,
    // because there is no income to make it back. Take the refund instead.
    if (p.credits < owed) {
      for (let i = p.queues.units.items.length - 1; i >= 0; i--) {
        cancelQueueItem(state, PLAYER_AI, 'units', i);
      }
      ai.wantUnit = null;
      // Phase 7: the queue refund was not enough. Sell the base down — a silo
      // or a tower is worth far less than the refinery that pays for both.
      if (p.credits < owed) emergencySell(state, p, owed);
    }
    if (p.credits < cost * 2) return;
  }

  // --- V2: air wing ---
  // From wave 3 on, a normal AI keeps one gunship in the field and a hard one
  // keeps two. It is bought outside the weighted roll on purpose: the roll is a
  // *composition* model for the ground army, and letting aircraft into the pool
  // would have re-tuned every existing wave. Everything after this point — the
  // army cap, the rally group, wave assembly — treats the gunship as an
  // ordinary combat unit, so no wave logic changed.
  const airWanted = AIR_WANTED[ai.difficulty];
  if (
    airWanted > 0 &&
    ai.waveNumber >= AIR_FROM_WAVE - 1 &&
    canBuild(state, PLAYER_AI, 'gunship') &&
    countUnits(state, 'gunship') + countQueued(p, 'gunship') < airWanted &&
    spendable >= UNIT_TYPES.gunship.cost
  ) {
    if (enqueue(state, PLAYER_AI, 'gunship')) return;
  }

  // --- army cap ---
  const def = AI_DIFFICULTY[ai.difficulty];
  const { army, infantry } = armySize(state, p);
  if (army >= def.armyCap) {
    ai.wantUnit = null;
    // Phase 7: capped army + a full bank. A 'hard' AI turns the surplus into
    // pressure (bigger waves) instead of parking it; the structure side of the
    // sink lives in `nextStructure`.
    if (
      ai.difficulty === 'hard' &&
      creditsPinned(p) &&
      ai.waveNumber > ai.pinBumpWave &&
      ai.waveSize < def.waveCap
    ) {
      ai.waveSize = Math.min(def.waveCap, ai.waveSize + PIN_WAVE_BONUS);
      ai.pinBumpWave = ai.waveNumber;
    }
    return;
  }

  // Settle on a unit, then save for it. Re-roll when the choice went stale
  // (prereq structure lost) or when it has been unaffordable for too long.
  if (
    ai.wantUnit === null ||
    !canBuild(state, PLAYER_AI, ai.wantUnit) ||
    state.tick - ai.wantSince > WANT_TIMEOUT
  ) {
    ai.wantUnit = rollWantedUnit(state, ai, army, infantry);
    ai.wantSince = state.tick;
  }

  const type = ai.wantUnit;
  if (!type) return;
  // Production drip-charges, so — exactly like a human clicking the icon — the
  // AI may commit before it holds the full price and let the harvesters pay
  // off the rest. While the insurance is active it must pay cash instead:
  // drip-charging a unit it cannot fully afford would spend straight through
  // the reserve, which is the whole thing the reserve exists to prevent.
  const price = UNIT_TYPES[type].cost;
  if (spendable < (reserve > 0 ? price : price * COMMIT_FRACTION)) return;
  if (enqueue(state, PLAYER_AI, type)) ai.wantUnit = null;
}

// ---------------------------------------------------------------------------
// Army: rally, defend, attack
// ---------------------------------------------------------------------------

interface Roster {
  attackers: Unit[];
  defenders: Unit[];
  rally: Unit[];
}

function roster(state: GameState, ai: AiState): Roster {
  const attackSet = new Set(ai.attackers);
  const defendSet = new Set(ai.defenders);
  const attackers: Unit[] = [];
  const defenders: Unit[] = [];
  const rally: Unit[] = [];
  for (const u of state.units) {
    if (u.dead || u.player !== PLAYER_AI || !isCombatUnit(u)) continue;
    if (attackSet.has(u.id)) attackers.push(u);
    else if (defendSet.has(u.id)) defenders.push(u);
    else rally.push(u);
  }
  // Stable ordering keeps wave composition deterministic.
  attackers.sort((a, b) => a.id - b.id);
  defenders.sort((a, b) => a.id - b.id);
  rally.sort((a, b) => a.id - b.id);
  ai.attackers = attackers.map((u) => u.id);
  ai.defenders = defenders.map((u) => u.id);
  return { attackers, defenders, rally };
}

/** Nearest human unit within `radius` tiles of the AI base, or undefined. */
function findIntruder(state: GameState, base: TilePos, radius: number): Unit | undefined {
  const bx = tileCenter(base.tx);
  const by = tileCenter(base.ty);
  const reach = radius * TILE;
  let best: Unit | undefined;
  let bestD = Infinity;
  for (const u of state.units) {
    if (u.dead || u.player !== PLAYER_HUMAN) continue;
    const d = Math.hypot(u.pos.x - bx, u.pos.y - by);
    if (d > reach || d >= bestD) continue;
    bestD = d;
    best = u;
  }
  return best;
}

/** What the current wave is driving at: base first, then anything human. */
function waveTarget(state: GameState): { tile: TilePos; id: number | null } {
  const rank = (b: Building): number => {
    if (b.type === 'conyard') return 0;
    if (BUILDING_TYPES[b.type].productionStructure) return 1;
    if (b.type === 'refinery') return 2;
    return 3;
  };
  let best: Building | undefined;
  let bestRank = Infinity;
  for (const b of state.buildings) {
    if (b.dead || b.player !== PLAYER_HUMAN) continue;
    const r = rank(b);
    if (r < bestRank || (r === bestRank && best && b.id < best.id)) {
      bestRank = r;
      best = b;
    }
  }
  if (best) {
    const c = centerTileOf(best);
    return { tile: c, id: best.id };
  }
  // No structures left: go after the survivors.
  let unit: Unit | undefined;
  for (const u of state.units) {
    if (u.dead || u.player !== PLAYER_HUMAN) continue;
    if (!unit || u.id < unit.id) unit = u;
  }
  if (unit) {
    return { tile: { tx: worldToTile(unit.pos.x), ty: worldToTile(unit.pos.y) }, id: unit.id };
  }
  return { tile: startTile(state, PLAYER_HUMAN), id: null };
}

function stepDefense(state: GameState, ai: AiState, r: Roster): boolean {
  const base = baseTile(state);
  const intruder = findIntruder(state, base, DEFEND_RADIUS);

  if (!intruder) {
    if (ai.defendTile === null) return false;
    // Stand down once the neighbourhood is clear (wider radius = hysteresis).
    if (findIntruder(state, base, DEFEND_CLEAR_RADIUS)) return true;
    stopUnits(r.defenders);
    // They rejoin the rally group this very tick, so `stepRally` walks them
    // back to the staging point instead of leaving them parked in the base.
    r.rally = r.rally.concat(r.defenders);
    r.defenders = [];
    ai.defenders = [];
    ai.defendTile = null;
    return false;
  }

  const itx = worldToTile(intruder.pos.x);
  const ity = worldToTile(intruder.pos.y);

  // The rally group is the next wave; it is what defends. Top it up from the
  // units already out attacking, but never take more than half a wave back.
  const force = r.defenders.concat(r.rally);
  const want = Math.max(MIN_WAVE, Math.ceil(ai.waveSize / 2));
  if (force.length < want && r.attackers.length > 0) {
    const bx = tileCenter(base.tx);
    const by = tileCenter(base.ty);
    const recall = r.attackers
      .slice()
      .sort((a, b) => {
        const da = Math.hypot(a.pos.x - bx, a.pos.y - by);
        const db = Math.hypot(b.pos.x - bx, b.pos.y - by);
        return da === db ? a.id - b.id : da - db;
      })
      .slice(0, Math.min(want - force.length, Math.ceil(ai.waveSize / 2)));
    for (const u of recall) force.push(u);
    const recalled = new Set(recall.map((u) => u.id));
    ai.attackers = ai.attackers.filter((id) => !recalled.has(id));
  }

  if (force.length === 0) {
    ai.defendTile = { tx: itx, ty: ity };
    return true;
  }

  const moved =
    ai.defendTile === null ||
    Math.abs(ai.defendTile.tx - itx) + Math.abs(ai.defendTile.ty - ity) > 3;
  if (moved) {
    issueGroundOrder(state, force, 'attackMove', itx, ity);
    ai.defendTile = { tx: itx, ty: ity };
  }

  // Hand the roster over: whoever is defending must not also be rallied or
  // counted for the next wave in the same decision.
  const forceIds = new Set(force.map((u) => u.id));
  r.defenders = force;
  r.rally = r.rally.filter((u) => !forceIds.has(u.id));
  r.attackers = r.attackers.filter((u) => !forceIds.has(u.id));
  ai.defenders = force.map((u) => u.id);
  return true;
}

function stepRally(state: GameState, ai: AiState, r: Roster): void {
  if (r.rally.length === 0) return;
  const staging = ai.staging;
  const sx = tileCenter(staging.tx);
  const sy = tileCenter(staging.ty);
  const slack = STAGING_SLACK * TILE;
  const stragglers: Unit[] = [];
  for (const u of r.rally) {
    if (!isIdle(u)) continue;
    if (u.targetId !== undefined) continue; // busy shooting something
    if (Math.hypot(u.pos.x - sx, u.pos.y - sy) <= slack) continue;
    stragglers.push(u);
  }
  if (stragglers.length > 0) {
    issueGroundOrder(state, stragglers, 'move', staging.tx, staging.ty);
  }
}

function stepAttack(state: GameState, ai: AiState, r: Roster): void {
  const def = AI_DIFFICULTY[ai.difficulty];

  // --- keep the units already out there pointed at something ---
  if (r.attackers.length > 0) {
    const target = waveTarget(state);
    ai.targetTile = target.tile;
    ai.targetId = target.id;
    const idleAttackers = r.attackers.filter((u) => isIdle(u) && u.targetId === undefined);
    if (idleAttackers.length > 0) {
      const focus =
        target.id !== null
          ? state.buildings.find((b) => b.id === target.id && !b.dead) ??
            state.units.find((u) => u.id === target.id && !u.dead)
          : undefined;
      const close: Unit[] = [];
      const far: Unit[] = [];
      for (const u of idleAttackers) {
        if (focus && distanceToEntity(u.pos.x, u.pos.y, focus) <= FOCUS_RANGE) close.push(u);
        else far.push(u);
      }
      // In range of the objective: focused strike. Otherwise keep advancing.
      if (focus && close.length > 0) issueAttackOrder(state, close, focus.id);
      if (far.length > 0) {
        issueGroundOrder(state, far, 'attackMove', target.tile.tx, target.tile.ty);
      }
    }
  }

  // --- launch the next wave ---
  if (state.tick < ai.nextWaveTick) return;
  const late = state.tick >= ai.nextWaveTick + WAVE_GRACE;
  const ready = r.rally.length >= ai.waveSize || (late && r.rally.length >= MIN_WAVE);
  if (!ready) return;

  // V2: aircraft go to the front of the queue when the wave is picked. The
  // rally list is sorted by id, so a gunship — always the newest thing in the
  // base — was otherwise sliced off the end and sat out every wave it was built
  // for. Nothing else about the wave changed: the size, the clock, the target
  // and the ordering of the ground units are all as they were, and with no
  // aircraft in the rally this expression is exactly `r.rally` again.
  // A gunship that is docked (rearming) or empty stays home for the next one —
  // launching it with no rockets would just send it straight back to the pad.
  const readyAir: Unit[] = [];
  const groundRally: Unit[] = [];
  for (const u of r.rally) {
    if (UNIT_TYPES[u.type].isAir) {
      if (!u.docked && (u.ammo ?? UNIT_TYPES[u.type].ammo) > 0) readyAir.push(u);
    } else groundRally.push(u);
  }
  const group = readyAir.concat(groundRally).slice(0, Math.max(ai.waveSize, MIN_WAVE));
  const target = waveTarget(state);
  issueGroundOrder(state, group, 'attackMove', target.tile.tx, target.tile.ty);
  for (const u of group) ai.attackers.push(u.id);

  ai.waveNumber++;
  ai.targetTile = target.tile;
  ai.targetId = target.id;
  ai.waveSize = Math.min(def.waveCap, ai.waveSize + def.waveGrowth);
  ai.nextWaveTick = state.tick + state.rng.intRange(def.intervalMin, def.intervalMax);
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

/**
 * Enemy AI. Runs after `removeDead` so it never sees a corpse, and only on
 * every `AI_INTERVAL`-th tick.
 */
export function updateAi(state: GameState): void {
  if (state.result !== 'playing') return;
  const p = state.players[PLAYER_AI];
  if (!p.isAI || p.defeated) return;
  const ai = state.ai;
  if (!ai) return;
  if ((state.tick + AI_PHASE) % AI_INTERVAL !== 0) return;

  // The staging point follows the base if the ConYard is lost and rebuilt
  // elsewhere; recomputing it is cheap and keeps the rally sane.
  if (state.tick % (AI_INTERVAL * 40) === AI_PHASE) ai.staging = stagingTile(state);

  stepStructures(state, ai, p);
  stepUnits(state, ai, p);

  const r = roster(state, ai);
  const defending = stepDefense(state, ai, r);
  stepRally(state, ai, r);
  if (!defending) stepAttack(state, ai, r);
}

// ---------------------------------------------------------------------------
// Introspection (debug hook / harnesses)
// ---------------------------------------------------------------------------

export interface AiReport {
  difficulty: AiDifficulty;
  tick: number;
  credits: number;
  power: { produced: number; drain: number; low: boolean };
  buildings: Record<string, number>;
  units: Record<string, number>;
  wave: { number: number; size: number; nextTick: number; attackers: number; rally: number };
  defending: boolean;
  staging: TilePos;
  structureQueue: string | null;
  unitQueue: string[];
}

export function aiReport(state: GameState): AiReport {
  const p = state.players[PLAYER_AI];
  const ai = state.ai;
  const buildings: Record<string, number> = {};
  for (const b of state.buildings) {
    if (b.dead || b.player !== PLAYER_AI) continue;
    buildings[b.type] = (buildings[b.type] ?? 0) + 1;
  }
  const units: Record<string, number> = {};
  let rally = 0;
  const attackSet = new Set(ai?.attackers ?? []);
  const defendSet = new Set(ai?.defenders ?? []);
  for (const u of state.units) {
    if (u.dead || u.player !== PLAYER_AI) continue;
    units[u.type] = (units[u.type] ?? 0) + 1;
    if (isCombatUnit(u) && !attackSet.has(u.id) && !defendSet.has(u.id)) rally++;
  }
  const head = p.queues.structures.items[0];
  return {
    difficulty: ai?.difficulty ?? DEFAULT_AI_DIFFICULTY,
    tick: state.tick,
    credits: Math.floor(p.credits),
    power: { produced: p.powerProduced, drain: p.powerDrain, low: p.lowPower },
    buildings,
    units,
    wave: {
      number: ai?.waveNumber ?? 0,
      size: ai?.waveSize ?? 0,
      nextTick: ai?.nextWaveTick ?? 0,
      attackers: ai?.attackers.length ?? 0,
      rally,
    },
    defending: ai?.defendTile !== null && ai?.defendTile !== undefined,
    staging: ai?.staging ?? { tx: 0, ty: 0 },
    structureQueue: head ? `${head.type}${head.ready ? ' (ready)' : ''}` : null,
    unitQueue: p.queues.units.items.map((it) => it.type),
  };
}
