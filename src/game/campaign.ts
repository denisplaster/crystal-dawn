/**
 * Conquest campaign (V3) — the territory map behind the skirmish.
 *
 * Pick a country, take over land, and it gets harder the more you hold: a
 * thirteen-territory continent, a Risk-style adjacency rule ("you may attack
 * anything touching ground you already own"), and a battle configuration that
 * grows with both how deep the territory sits and how much of the map you have
 * already taken.
 *
 * **This file is pure data + logic.** It draws nothing (`render/campaign.ts`
 * does that), it never touches a `GameState`, and every function here is a pure
 * function of its arguments except the three that talk to `localStorage`, which
 * are guarded exactly like the mute / objectives preferences.
 *
 * The scaling it produces is *plain data*, resolved **before** `createGameState`
 * and handed to `initSkirmish` as ordinary options — so a campaign battle is as
 * deterministic as a skirmish, and replaying one seed with one configuration
 * replays the identical match.
 */

import { BUILDING_TYPES, type BuildingTypeId } from './rules';
import { createPlayerStats, type PlayerStats } from './state';
import type { SkirmishOptions } from './skirmish';
import { makeAiScaling, type AiDifficulty, type AiScaling } from './systems/ai';

// ---------------------------------------------------------------------------
// The continent
// ---------------------------------------------------------------------------

export interface Territory {
  id: string;
  /** Display name, uppercase-safe for the 5x7 bitmap font. */
  name: string;
  /**
   * Map seed the battle for this territory is fought on. All thirteen were
   * validated headlessly to the same bar as the V2 curated maps: both start
   * areas clear *and* buildable, six crystal fields, and a start-to-start A*
   * path (see SPEC "V3: conquest campaign"). They run from open ground in the
   * west to broken, rocky ground at the stronghold.
   */
  seed: number;
  /** Ids of the territories sharing a border. Symmetric; see `assertGraph`. */
  adjacent: readonly string[];
  /** Label anchor / link endpoint, in the 0..100 map space. */
  cx: number;
  cy: number;
  /** Region outline in the same 0..100 space. Clockwise, no self-intersections. */
  shape: readonly (readonly [number, number])[];
}

/**
 * Thirteen territories in six columns, west (home) to east (the stronghold).
 * The graph is planar: every edge joins either two vertical neighbours inside a
 * column or two territories in adjacent columns, and no two edges cross.
 */
export const TERRITORIES: readonly Territory[] = [
  {
    id: 'harrow',
    name: 'HARROW LANDING',
    seed: 1059,
    adjacent: ['ashen', 'karst'],
    cx: 13,
    cy: 50,
    shape: [
      [4, 38],
      [11, 29],
      [20, 32],
      [24, 44],
      [23, 58],
      [19, 70],
      [9, 71],
      [3, 59],
    ],
  },
  {
    id: 'ashen',
    name: 'ASHEN REACH',
    seed: 1326,
    adjacent: ['harrow', 'karst', 'salt', 'dry'],
    cx: 29,
    cy: 28,
    shape: [
      [21, 17],
      [30, 11],
      [38, 17],
      [39, 29],
      [34, 39],
      [25, 41],
      [20, 33],
    ],
  },
  {
    id: 'karst',
    name: 'KARST LINE',
    seed: 1317,
    adjacent: ['harrow', 'ashen', 'dry', 'ironwash'],
    cx: 29,
    cy: 69,
    shape: [
      [24, 57],
      [33, 53],
      [40, 61],
      [39, 74],
      [33, 84],
      [24, 85],
      [19, 74],
    ],
  },
  {
    id: 'salt',
    name: 'SALT VERGE',
    seed: 1171,
    adjacent: ['ashen', 'dry', 'cinder'],
    cx: 47,
    cy: 19,
    shape: [
      [40, 9],
      [50, 5],
      [57, 12],
      [56, 25],
      [47, 31],
      [40, 26],
    ],
  },
  {
    id: 'dry',
    name: 'THE DRY MARCH',
    seed: 1281,
    adjacent: ['ashen', 'karst', 'salt', 'ironwash', 'cinder', 'vulture'],
    cx: 47,
    cy: 50,
    shape: [
      [40, 40],
      [50, 36],
      [57, 44],
      [56, 57],
      [48, 63],
      [40, 59],
    ],
  },
  {
    id: 'ironwash',
    name: 'IRONWASH',
    seed: 1251,
    adjacent: ['karst', 'dry', 'vulture', 'glass'],
    cx: 47,
    cy: 79,
    shape: [
      [40, 70],
      [49, 66],
      [56, 73],
      [55, 86],
      [46, 91],
      [39, 84],
    ],
  },
  {
    id: 'cinder',
    name: 'CINDER STEPPE',
    seed: 1165,
    adjacent: ['salt', 'dry', 'vulture', 'rift'],
    cx: 65,
    cy: 23,
    shape: [
      [59, 12],
      [68, 8],
      [75, 16],
      [74, 29],
      [65, 34],
      [58, 27],
    ],
  },
  {
    id: 'vulture',
    name: 'VULTURE GAP',
    seed: 1359,
    adjacent: ['dry', 'ironwash', 'cinder', 'glass', 'rift', 'blackspine'],
    cx: 65,
    cy: 52,
    shape: [
      [59, 42],
      [68, 38],
      [75, 46],
      [74, 59],
      [65, 64],
      [58, 57],
    ],
  },
  {
    id: 'glass',
    name: 'GLASS BASIN',
    seed: 1321,
    adjacent: ['ironwash', 'vulture', 'blackspine', 'ember'],
    cx: 65,
    cy: 80,
    shape: [
      [58, 71],
      [67, 67],
      [75, 74],
      [73, 87],
      [64, 92],
      [57, 84],
    ],
  },
  {
    id: 'rift',
    name: 'RIFT COLLAR',
    seed: 1322,
    adjacent: ['cinder', 'vulture', 'blackspine', 'crown'],
    cx: 82,
    cy: 26,
    shape: [
      [77, 15],
      [86, 11],
      [92, 20],
      [90, 33],
      [81, 38],
      [75, 30],
    ],
  },
  {
    id: 'blackspine',
    name: 'BLACKSPINE',
    seed: 1117,
    adjacent: ['vulture', 'glass', 'rift', 'ember', 'crown'],
    cx: 82,
    cy: 54,
    shape: [
      [77, 44],
      [86, 40],
      [92, 48],
      [90, 61],
      [81, 66],
      [75, 58],
    ],
  },
  {
    id: 'ember',
    name: 'EMBER FLATS',
    seed: 1074,
    adjacent: ['glass', 'blackspine', 'crown'],
    cx: 81,
    cy: 82,
    shape: [
      [76, 72],
      [85, 69],
      [91, 77],
      [89, 89],
      [80, 93],
      [74, 85],
    ],
  },
  {
    id: 'crown',
    name: 'OBSIDIAN CROWN',
    seed: 1273,
    adjacent: ['rift', 'blackspine', 'ember'],
    // Label anchor sits in the strip's empty upper third: at mid-height it
    // shares a row with BLACKSPINE and the two labels collide once the window
    // is narrow enough for the edge clamp to push this one leftward.
    cx: 95,
    cy: 38,
    shape: [
      [90, 25],
      [97, 22],
      [100, 38],
      [100, 70],
      [96, 87],
      [89, 82],
      [87, 54],
    ],
  },
];

/** Where the player starts. Always owned; never attackable. */
export const HOME_TERRITORY = 'harrow';
/** The far-edge objective. Hardest fight in the campaign by construction. */
export const STRONGHOLD_TERRITORY = 'crown';
export const TERRITORY_COUNT = TERRITORIES.length;

/** The 0..100 space `Territory.shape` / `cx` / `cy` are authored in. */
export const MAP_SPACE = 100;

const BY_ID = new Map<string, Territory>(TERRITORIES.map((t) => [t.id, t]));

export function territory(id: string): Territory | undefined {
  return BY_ID.get(id);
}

export function isTerritoryId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Tier = graph distance from home, computed by BFS rather than hand-authored,
 * so the number the scaling reads can never drift from the map the player sees.
 * Home is 0, its neighbours 1, ... the stronghold 5.
 */
export const TERRITORY_TIERS: ReadonlyMap<string, number> = (() => {
  const tiers = new Map<string, number>([[HOME_TERRITORY, 0]]);
  let frontier = [HOME_TERRITORY];
  let depth = 0;
  while (frontier.length > 0) {
    depth++;
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of territory(id)?.adjacent ?? []) {
        if (tiers.has(n)) continue;
        tiers.set(n, depth);
        next.push(n);
      }
    }
    frontier = next;
  }
  return tiers;
})();

export function tierOf(id: string): number {
  return TERRITORY_TIERS.get(id) ?? 0;
}

/** Deepest tier on the continent (the stronghold's). */
export const MAX_TIER = TERRITORIES.reduce((m, t) => Math.max(m, tierOf(t.id)), 0);

/**
 * Structural invariants, asserted once at module load: symmetric adjacency, no
 * self-loops, no dangling ids, every territory reachable from home, unique
 * seeds, and the stronghold sitting at the deepest tier. Thirteen nodes — this
 * is microseconds, and it turns an authoring slip into an immediate throw
 * rather than an unreachable territory nobody notices for a month.
 */
function assertGraph(): void {
  for (const t of TERRITORIES) {
    for (const n of t.adjacent) {
      if (n === t.id) throw new Error(`campaign: ${t.id} is adjacent to itself`);
      const other = territory(n);
      if (!other) throw new Error(`campaign: ${t.id} -> unknown territory ${n}`);
      if (!other.adjacent.includes(t.id)) {
        throw new Error(`campaign: adjacency ${t.id} -> ${n} is not symmetric`);
      }
    }
  }
  if (TERRITORY_TIERS.size !== TERRITORY_COUNT) {
    throw new Error('campaign: some territories are unreachable from home');
  }
  if (new Set(TERRITORIES.map((t) => t.seed)).size !== TERRITORY_COUNT) {
    throw new Error('campaign: duplicate territory seeds');
  }
  if (tierOf(STRONGHOLD_TERRITORY) !== MAX_TIER) {
    throw new Error('campaign: the stronghold is not the deepest territory');
  }
}
assertGraph();

// ---------------------------------------------------------------------------
// Campaign state
// ---------------------------------------------------------------------------

export type CampaignResult = 'active' | 'victory';

export interface TerritoryRecord {
  /** Battles started for this territory (retries included). */
  fought: number;
  /** Battles won for it. 0 or 1 in v1 — owned land is never lost. */
  won: number;
}

export interface CampaignState {
  version: number;
  /** Territory ids the player holds. Always contains `HOME_TERRITORY`. */
  owned: string[];
  /** Territory the current battle is being fought for, or null. */
  current: string | null;
  records: Record<string, TerritoryRecord>;
  result: CampaignResult;
  battlesFought: number;
  battlesWon: number;
  /** Sim ticks summed across every campaign battle that reached a result. */
  ticks: number;
  /** Cumulative match counters, [you, order], for the campaign-complete screen. */
  totals: [PlayerStats, PlayerStats];
}

export const CAMPAIGN_SAVE_KEY = 'crystal-dawn.campaign';
export const CAMPAIGN_SAVE_VERSION = 1;

export function createCampaign(): CampaignState {
  return {
    version: CAMPAIGN_SAVE_VERSION,
    owned: [HOME_TERRITORY],
    current: null,
    records: {},
    result: 'active',
    battlesFought: 0,
    battlesWon: 0,
    ticks: 0,
    totals: [createPlayerStats(), createPlayerStats()],
  };
}

export function isOwned(cs: CampaignState, id: string): boolean {
  return cs.owned.includes(id);
}

export function ownedCount(cs: CampaignState): number {
  return cs.owned.length;
}

export function recordFor(cs: CampaignState, id: string): TerritoryRecord {
  return cs.records[id] ?? { fought: 0, won: 0 };
}

/**
 * The Risk rule: an enemy territory may be attacked when it shares a border
 * with land you already hold. Home is owned from the start, so the front is
 * never empty, and the set only ever grows (v1 never loses territory).
 */
export function canAttack(cs: CampaignState, id: string): boolean {
  if (cs.result === 'victory') return false;
  const t = territory(id);
  if (!t || isOwned(cs, id)) return false;
  return t.adjacent.some((n) => isOwned(cs, n));
}

/** Every attackable territory, in continent order. */
export function attackable(cs: CampaignState): string[] {
  return TERRITORIES.filter((t) => canAttack(cs, t.id)).map((t) => t.id);
}

/** Begin a battle for `id`. Returns false when the move is not legal. */
export function beginBattle(cs: CampaignState, id: string): boolean {
  if (!canAttack(cs, id)) return false;
  cs.current = id;
  const rec = recordFor(cs, id);
  cs.records[id] = { fought: rec.fought + 1, won: rec.won };
  cs.battlesFought++;
  return true;
}

/** What `resolveBattle` folds into the campaign totals. */
export interface BattleOutcome {
  won: boolean;
  /** Length of the battle in sim ticks. */
  ticks?: number;
  /** The battle's `GameState.stats`, summed into `totals`. */
  stats?: readonly [PlayerStats, PlayerStats];
}

function addStats(into: PlayerStats, from: PlayerStats): void {
  into.unitsProduced += from.unitsProduced;
  into.unitsLost += from.unitsLost;
  into.unitsKilled += from.unitsKilled;
  into.buildingsBuilt += from.buildingsBuilt;
  into.buildingsLost += from.buildingsLost;
  into.buildingsRazed += from.buildingsRazed;
  into.buildingsCaptured += from.buildingsCaptured;
  into.buildingsSold += from.buildingsSold;
  into.creditsHarvested += from.creditsHarvested;
  into.creditsSpent += from.creditsSpent;
}

/**
 * Settle a finished battle.
 *
 * Win: the territory changes hands and the campaign may end in victory.
 * **Loss: nothing changes at all** beyond the counters — the territory stays
 * enemy, the player keeps everything they held, and the same fight can be
 * retried immediately. Owned land is never lost in v1; that is a deliberate
 * simplification (the alternative, enemy counter-attacks on your own
 * territories, is a whole second mission type) and it is what makes the
 * campaign a ratchet rather than a grind.
 *
 * Idempotent per battle: it clears `current`, so calling it twice for one
 * battle is a no-op the second time.
 */
export function resolveBattle(cs: CampaignState, id: string, outcome: BattleOutcome): boolean {
  if (cs.current !== id) return false;
  cs.current = null;
  cs.ticks += Math.max(0, Math.floor(outcome.ticks ?? 0));
  if (outcome.stats) {
    addStats(cs.totals[0], outcome.stats[0]);
    addStats(cs.totals[1], outcome.stats[1]);
  }
  if (!outcome.won) return true;

  const rec = recordFor(cs, id);
  cs.records[id] = { fought: rec.fought, won: rec.won + 1 };
  cs.battlesWon++;
  if (!isOwned(cs, id)) cs.owned.push(id);
  if (cs.owned.length >= TERRITORY_COUNT) cs.result = 'victory';
  return true;
}

// ---------------------------------------------------------------------------
// Battle scaling
// ---------------------------------------------------------------------------

/**
 * Opening credits per territory already taken, and per tier of depth.
 * `conquered` is `ownedCount - 1` (home is free), so a first invasion adds
 * nothing for land and only the tier term.
 */
const CREDITS_PER_CONQUEST = 400;
const CREDITS_PER_TIER = 600;

/** Wave-size multiplier: +4% per conquest, +6% per tier past the first. */
const WAVE_SIZE_PER_CONQUEST = 0.04;
const WAVE_SIZE_PER_TIER = 0.06;

/** Wave *interval* multiplier: -2.5% per conquest, -4% per tier, floored. */
const INTERVAL_PER_CONQUEST = 0.025;
const INTERVAL_PER_TIER = 0.04;
const INTERVAL_FLOOR = 0.5;

/** Army-cap multiplier: +3% per conquest, +4% per tier. */
const ARMY_PER_CONQUEST = 0.03;
const ARMY_PER_TIER = 0.04;

/** Tier at which the AI stops being an easy opponent, and where it turns hard. */
const NORMAL_FROM_TIER = 3;
const HARD_FROM_TIER = 5;

/**
 * Pre-built AI structures by tier. Cumulative and non-decreasing, so a deeper
 * territory is never *less* fortified than a shallower one.
 *
 * The Power Plant is not decoration: guard towers go offline under `lowPower`
 * (Phase 4) and a deficit halves every build in the base, so a tower handed to
 * a ConYard-only opening would sit dark until the AI got round to building
 * power for it. With the plant in front, tier 3 opens at +90 power margin,
 * tier 4 at +80 and the stronghold at +40.
 */
const PREBUILT_BY_TIER: readonly (readonly BuildingTypeId[])[] = [
  [], // tier 0 (home — never fought)
  [], // tier 1
  [], // tier 2
  ['powerPlant', 'guardTower'], // tier 3
  ['powerPlant', 'guardTower', 'guardTower'], // tier 4
  ['powerPlant', 'refinery', 'guardTower', 'guardTower', 'guardTower'], // tier 5
];

export type ResistanceLabel =
  | 'LIGHT'
  | 'MODERATE'
  | 'HEAVY'
  | 'SEVERE'
  | 'OVERWHELMING';

/**
 * A battle configuration. It **is** a `SkirmishOptions`, so `main.ts` hands it
 * straight to `initSkirmish` with no translation step, plus the identity and
 * the presentation numbers the map screen needs.
 */
export interface CampaignBattleConfig extends SkirmishOptions {
  territory: string;
  name: string;
  seed: number;
  tier: number;
  /** Territories held when this battle was configured (home included). */
  ownedCount: number;
  /** `ownedCount - 1`: the term that makes it harder the more land you take. */
  conquered: number;
  difficulty: AiDifficulty;
  aiCreditBonus: number;
  aiScaling: AiScaling;
  aiPrebuilt: readonly BuildingTypeId[];
  /** 0..1 resistance rating, for the invade plate. */
  threat: number;
  resistance: ResistanceLabel;
}

export function resistanceOf(threat: number): ResistanceLabel {
  if (threat < 0.2) return 'LIGHT';
  if (threat < 0.4) return 'MODERATE';
  if (threat < 0.6) return 'HEAVY';
  if (threat < 0.8) return 'SEVERE';
  return 'OVERWHELMING';
}

/**
 * The whole difficulty curve, as one pure function of (land held, depth).
 *
 * Every term is non-decreasing in both inputs — more land and a deeper tier can
 * only ever add credits, wave size, army cap and pre-built defences, and can
 * only ever shorten the gap between waves — so the stronghold fought last is
 * the maximum configuration the campaign can produce, by construction rather
 * than by tuning.
 *
 * `state` is read, never written.
 */
export function campaignBattleConfig(
  cs: CampaignState,
  territoryId: string,
): CampaignBattleConfig {
  const t = territory(territoryId);
  if (!t) throw new Error(`campaignBattleConfig: unknown territory "${territoryId}"`);
  const tier = tierOf(territoryId);
  const owned = ownedCount(cs);
  const conquered = Math.max(0, owned - 1);
  const depth = Math.max(0, tier - 1);

  const difficulty: AiDifficulty =
    tier >= HARD_FROM_TIER ? 'hard' : tier >= NORMAL_FROM_TIER ? 'normal' : 'easy';

  const aiCreditBonus =
    conquered * CREDITS_PER_CONQUEST + tier * CREDITS_PER_TIER;

  const aiScaling = makeAiScaling({
    waveSize: 1 + conquered * WAVE_SIZE_PER_CONQUEST + depth * WAVE_SIZE_PER_TIER,
    waveInterval: Math.max(
      INTERVAL_FLOOR,
      1 - conquered * INTERVAL_PER_CONQUEST - depth * INTERVAL_PER_TIER,
    ),
    armyCap: 1 + conquered * ARMY_PER_CONQUEST + depth * ARMY_PER_TIER,
  });

  const aiPrebuilt =
    PREBUILT_BY_TIER[Math.min(tier, PREBUILT_BY_TIER.length - 1)] ?? [];

  // Depth dominates: a tier-5 fight reads as the hardest thing on the map even
  // on the run where you took it fourth.
  const maxConquests = Math.max(1, TERRITORY_COUNT - 2);
  const threat = Math.min(
    1,
    Math.max(0, (depth / Math.max(1, MAX_TIER - 1)) * 0.65 + (conquered / maxConquests) * 0.35),
  );

  return {
    territory: t.id,
    name: t.name,
    seed: t.seed,
    tier,
    ownedCount: owned,
    conquered,
    difficulty,
    aiCreditBonus,
    aiScaling,
    aiPrebuilt,
    threat,
    resistance: resistanceOf(threat),
    fog: true,
  };
}

/** Power the pre-built extras produce minus what they drain (sanity / UI). */
export function prebuiltPowerMargin(types: readonly BuildingTypeId[]): number {
  let margin = 0;
  for (const type of types) margin += BUILDING_TYPES[type].power;
  return margin;
}

/** One-line summary of a config's pre-built extras, e.g. "2 TOWERS, REFINERY". */
export function prebuiltSummary(types: readonly BuildingTypeId[]): string {
  const counts = new Map<BuildingTypeId, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  const parts: string[] = [];
  for (const [type, n] of counts) {
    // The Power Plant only exists to keep the towers lit; it is not a threat.
    if (type === 'powerPlant') continue;
    const label = type === 'guardTower' ? 'TOWER' : BUILDING_TYPES[type].name.toUpperCase();
    parts.push(n > 1 ? `${n} ${label}S` : label);
  }
  return parts.length > 0 ? parts.join(', ') : 'NONE';
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** The slice of `localStorage` this module uses. `Storage` satisfies it. */
export interface CampaignStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** `localStorage` when it exists and is reachable, else null. */
export function defaultCampaignStorage(): CampaignStorage | null {
  try {
    const ls = (globalThis as { localStorage?: CampaignStorage }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

export function serializeCampaign(cs: CampaignState): string {
  return JSON.stringify({
    version: CAMPAIGN_SAVE_VERSION,
    owned: cs.owned,
    current: cs.current,
    records: cs.records,
    result: cs.result,
    battlesFought: cs.battlesFought,
    battlesWon: cs.battlesWon,
    ticks: cs.ticks,
    totals: cs.totals,
  });
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readStats(raw: unknown): PlayerStats {
  const out = createPlayerStats();
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(out) as (keyof PlayerStats)[]) {
    out[key] = Math.max(0, Math.floor(num(src[key])));
  }
  return out;
}

/**
 * Parse a save. **Anything wrong with it is a fresh campaign**, never a throw
 * and never a half-restored one: bad JSON, a version that is not ours, unknown
 * territory ids, a missing home territory, or a "victory" that does not hold
 * all thirteen. `current` is deliberately dropped — a battle that was in
 * progress when the tab closed did not happen.
 */
export function deserializeCampaign(json: string | null): CampaignState {
  const fresh = createCampaign();
  if (!json) return fresh;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fresh;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fresh;
  const src = raw as Record<string, unknown>;
  if (num(src.version, -1) !== CAMPAIGN_SAVE_VERSION) return fresh;

  const owned: string[] = [HOME_TERRITORY];
  if (Array.isArray(src.owned)) {
    for (const id of src.owned) {
      if (typeof id !== 'string' || !isTerritoryId(id) || owned.includes(id)) continue;
      owned.push(id);
    }
  }

  const records: Record<string, TerritoryRecord> = {};
  if (src.records && typeof src.records === 'object' && !Array.isArray(src.records)) {
    for (const [id, rec] of Object.entries(src.records as Record<string, unknown>)) {
      if (!isTerritoryId(id) || !rec || typeof rec !== 'object') continue;
      const r = rec as Record<string, unknown>;
      records[id] = {
        fought: Math.max(0, Math.floor(num(r.fought))),
        won: Math.max(0, Math.floor(num(r.won))),
      };
    }
  }

  const totalsRaw = Array.isArray(src.totals) ? src.totals : [];
  const state: CampaignState = {
    version: CAMPAIGN_SAVE_VERSION,
    owned,
    current: null,
    records,
    result: owned.length >= TERRITORY_COUNT ? 'victory' : 'active',
    battlesFought: Math.max(0, Math.floor(num(src.battlesFought))),
    battlesWon: Math.max(0, Math.floor(num(src.battlesWon))),
    ticks: Math.max(0, Math.floor(num(src.ticks))),
    totals: [readStats(totalsRaw[0]), readStats(totalsRaw[1])],
  };
  return state;
}

/** Load the campaign, or a fresh one when there is nothing sane to load. */
export function loadCampaign(storage: CampaignStorage | null): CampaignState {
  if (!storage) return createCampaign();
  try {
    return deserializeCampaign(storage.getItem(CAMPAIGN_SAVE_KEY));
  } catch {
    // A storage that throws on read (private browsing, blocked cookies).
    return createCampaign();
  }
}

/** Persist. A storage that throws is a session-only campaign, never a crash. */
export function saveCampaign(storage: CampaignStorage | null, cs: CampaignState): void {
  if (!storage) return;
  try {
    storage.setItem(CAMPAIGN_SAVE_KEY, serializeCampaign(cs));
  } catch {
    // Quota / private browsing. The campaign still holds for this session.
  }
}

/** Wipe the save and hand back a fresh campaign. */
export function resetCampaign(storage: CampaignStorage | null): CampaignState {
  const fresh = createCampaign();
  if (storage) {
    try {
      if (storage.removeItem) storage.removeItem(CAMPAIGN_SAVE_KEY);
      else storage.setItem(CAMPAIGN_SAVE_KEY, serializeCampaign(fresh));
    } catch {
      // Same contract as saveCampaign.
    }
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Introspection (`__game.campaign()`)
// ---------------------------------------------------------------------------

export interface CampaignTerritoryReport {
  id: string;
  name: string;
  tier: number;
  seed: number;
  owned: boolean;
  attackable: boolean;
  fought: number;
  won: number;
  adjacent: readonly string[];
  difficulty: AiDifficulty;
  aiCreditBonus: number;
  aiScaling: AiScaling;
  aiPrebuilt: readonly BuildingTypeId[];
  threat: number;
  resistance: ResistanceLabel;
}

export interface CampaignReport {
  owned: string[];
  ownedCount: number;
  total: number;
  attackable: string[];
  current: string | null;
  result: CampaignResult;
  battlesFought: number;
  battlesWon: number;
  ticks: number;
  totals: [PlayerStats, PlayerStats];
  territories: CampaignTerritoryReport[];
}

export function campaignReport(cs: CampaignState): CampaignReport {
  return {
    owned: cs.owned.slice(),
    ownedCount: ownedCount(cs),
    total: TERRITORY_COUNT,
    attackable: attackable(cs),
    current: cs.current,
    result: cs.result,
    battlesFought: cs.battlesFought,
    battlesWon: cs.battlesWon,
    ticks: cs.ticks,
    totals: cs.totals,
    territories: TERRITORIES.map((t) => {
      const cfg = campaignBattleConfig(cs, t.id);
      const rec = recordFor(cs, t.id);
      return {
        id: t.id,
        name: t.name,
        tier: tierOf(t.id),
        seed: t.seed,
        owned: isOwned(cs, t.id),
        attackable: canAttack(cs, t.id),
        fought: rec.fought,
        won: rec.won,
        adjacent: t.adjacent,
        difficulty: cfg.difficulty,
        aiCreditBonus: cfg.aiCreditBonus,
        aiScaling: cfg.aiScaling,
        aiPrebuilt: cfg.aiPrebuilt,
        threat: cfg.threat,
        resistance: cfg.resistance,
      };
    }),
  };
}
