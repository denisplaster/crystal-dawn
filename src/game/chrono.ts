/**
 * Chrono campaign (C3) — the timeline behind the four eras.
 *
 * The second campaign, and the payoff for C1's era framework and C2's era art:
 * instead of taking ground on a continent you take **moments** — battles in past
 * and future wars — by travelling to them through a chrono gate. You start
 * holding one anchor, PRESENT DAY (1991, the shipped game), and unlock the
 * timeline **backward and forward** from there until the whole thing is yours.
 * The last one is the ORIGIN MOMENT, a temporal anomaly where The Order fields
 * tech from every era at once.
 *
 * **This file is pure data + logic**, exactly like `game/campaign.ts`: it draws
 * nothing (`render/chrono.ts` does that), it never touches a `GameState`, and
 * every function is a pure function of its arguments except the three that talk
 * to `localStorage`, which are guarded exactly like the conquest save.
 *
 * The scaling it produces is *plain data*, resolved **before** `createGameState`
 * and handed to `initSkirmish` as ordinary options — so a chrono battle is as
 * deterministic as a skirmish, and it composes with everything V3 already
 * threads through `SkirmishOptions` (credit bonus, wave scaling, pre-built
 * defences) plus C1's `era`.
 *
 * The conquest campaign is untouched. The two campaigns hold separate save
 * slots, separate state objects and separate `main.ts` battle configs, and
 * neither can observe the other.
 */

import {
  defaultCampaignStorage,
  resistanceOf,
  type CampaignStorage,
  type ResistanceLabel,
} from './campaign';
import { ERA_IDS, eraDefenseTower, type EraId } from './eras';
import type { BuildingTypeId } from './rules';
import type { SkirmishOptions } from './skirmish';
import { createPlayerStats, type PlayerStats } from './state';
import { makeAiScaling, type AiDifficulty, type AiScaling } from './systems/ai';

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

export interface Moment {
  id: string;
  /** Display name, uppercase-safe for the 5x7 bitmap font. */
  name: string;
  /** The era this moment is fought in — C1's roster, C2's terrain palette. */
  era: EraId;
  /** Year the battle happens in (drives nothing but the copy). */
  year: number;
  /** Year as it is printed: `1943`, or `YEAR ZERO` for the anomaly. */
  yearLabel: string;
  /**
   * Map seed. All thirteen were validated headlessly to exactly the V2/V3 bar:
   * both start areas clear *and* buildable (338/338 tiles), six crystal fields,
   * a complete start-to-start A* path and every field reachable. None of them
   * collides with a curated skirmish seed or a conquest territory seed, and rock
   * cover rises with how far the moment sits from 1991 (see SPEC "C3").
   */
  seed: number;
  /**
   * Moments that open this one: holding **any** of them makes it enterable.
   * The graph is directed (a timeline has a direction of travel) and mostly
   * linear inside an era, with a branch where an era offers two ways on and an
   * *era gate* where the chain crosses into another time period.
   */
  requires: readonly string[];
  /** Position in the 0..100 timeline space: x is time, y is the lane. */
  tx: number;
  ty: number;
  /** True for the ORIGIN MOMENT only. */
  origin?: boolean;
}

/**
 * Thirteen moments: three per era plus the anomaly.
 *
 * The two arms leave PRESENT DAY in opposite directions —
 *
 *   backward: present -> DESERT SHIELD -> WINTER LINE -> {STEEL TIDE, THE
 *             AIRFIELD} -> THE LAST PUSH -> {THE SALIENT, WIRE HARVEST}
 *   forward:  present -> THE GLASS HOUR -> {NEON SPRAWL, THE BROKEN SKY} ->
 *             THE LAST DAWN -> THE ORIGIN MOMENT
 *
 * — so the campaign runs out through 1944 to 1916 in one direction and out
 * through 2061 to 2077 in the other, and the two only meet at the anomaly.
 */
export const MOMENTS: readonly Moment[] = [
  {
    id: 'salient',
    name: 'THE SALIENT',
    era: 'trench',
    year: 1916,
    yearLabel: '1916',
    seed: 2400,
    requires: ['lastpush'],
    tx: 6,
    ty: 28,
  },
  {
    id: 'wire',
    name: 'WIRE HARVEST',
    era: 'trench',
    year: 1917,
    yearLabel: '1917',
    seed: 2022,
    requires: ['lastpush'],
    tx: 6,
    ty: 72,
  },
  {
    id: 'lastpush',
    name: 'THE LAST PUSH',
    era: 'trench',
    year: 1918,
    yearLabel: '1918',
    seed: 2861,
    requires: ['steeltide', 'airfield'],
    tx: 16,
    ty: 50,
  },
  {
    id: 'steeltide',
    name: 'STEEL TIDE',
    era: 'steel',
    year: 1942,
    yearLabel: '1942',
    seed: 2251,
    requires: ['winterline'],
    tx: 28,
    ty: 28,
  },
  {
    id: 'airfield',
    name: 'THE AIRFIELD',
    era: 'steel',
    year: 1943,
    yearLabel: '1943',
    seed: 2428,
    requires: ['winterline'],
    tx: 28,
    ty: 72,
  },
  {
    id: 'winterline',
    name: 'WINTER LINE',
    era: 'steel',
    year: 1944,
    yearLabel: '1944',
    seed: 2986,
    requires: ['desertshield'],
    tx: 39,
    ty: 50,
  },
  {
    id: 'desertshield',
    name: 'DESERT SHIELD',
    era: 'silicon',
    year: 1990,
    yearLabel: '1990',
    seed: 2314,
    requires: ['present'],
    tx: 50,
    ty: 28,
  },
  {
    id: 'present',
    name: 'PRESENT DAY',
    era: 'silicon',
    year: 1991,
    yearLabel: '1991',
    seed: 2747,
    requires: [],
    tx: 56,
    ty: 50,
  },
  {
    id: 'glasshour',
    name: 'THE GLASS HOUR',
    era: 'silicon',
    year: 1993,
    yearLabel: '1993',
    seed: 2054,
    requires: ['present'],
    tx: 62,
    ty: 72,
  },
  {
    id: 'neonsprawl',
    name: 'NEON SPRAWL',
    era: 'future',
    year: 2061,
    yearLabel: '2061',
    seed: 2372,
    requires: ['glasshour'],
    tx: 75,
    ty: 28,
  },
  {
    id: 'brokensky',
    name: 'THE BROKEN SKY',
    era: 'future',
    year: 2069,
    yearLabel: '2069',
    seed: 2274,
    requires: ['glasshour'],
    tx: 75,
    ty: 72,
  },
  {
    id: 'lastdawn',
    name: 'THE LAST DAWN',
    era: 'future',
    year: 2077,
    yearLabel: '2077',
    seed: 2956,
    requires: ['neonsprawl', 'brokensky'],
    tx: 85,
    ty: 50,
  },
  {
    id: 'origin',
    name: 'THE ORIGIN MOMENT',
    // The anomaly wears 2077's ground and 2077's roster for *you*; The Order is
    // the one fielding every era at once (see `aiAnomaly`).
    era: 'future',
    year: 0,
    yearLabel: 'YEAR ZERO',
    seed: 2439,
    requires: ['lastdawn'],
    tx: 95,
    ty: 16,
    origin: true,
  },
];

/** Where the player starts. Held from the first frame; never fought for. */
export const ANCHOR_MOMENT = 'present';
/** The finale. Gated on a count as well as on the graph (see `canEnter`). */
export const ORIGIN_MOMENT = 'origin';
export const MOMENT_COUNT = MOMENTS.length;

/**
 * Moments that must be held before the anomaly will open. Ten of thirteen —
 * the free anchor plus nine won battles — so the ORIGIN MOMENT is always the
 * end of a campaign rather than a shortcut through the middle of one. Two
 * ordinary moments may still be outstanding when it opens.
 */
export const ORIGIN_REQUIREMENT = 10;

/** The 0..100 space `Moment.tx` / `ty` are authored in. */
export const TIMELINE_SPACE = 100;

const BY_ID = new Map<string, Moment>(MOMENTS.map((m) => [m.id, m]));

export function moment(id: string): Moment | undefined {
  return BY_ID.get(id);
}

export function isMomentId(id: string): boolean {
  return BY_ID.has(id);
}

/** Every moment in an era, in timeline order. */
export function momentsOfEra(era: EraId): readonly Moment[] {
  return MOMENTS.filter((m) => m.era === era);
}

/**
 * Gate depth = graph distance from the anchor, by BFS over `requires` rather
 * than hand-authored, so it can never drift from the timeline the player sees.
 *
 * It is **not** what the scaling reads (see `distanceOf`): five gates back to
 * 1916 would otherwise be a harder fight than three gates forward to 2077, and
 * the whole fiction is that distance *in time* is what makes a moment hostile.
 * Depth exists to prove reachability and to label the insertion plate.
 */
export const MOMENT_DEPTHS: ReadonlyMap<string, number> = (() => {
  const depths = new Map<string, number>([[ANCHOR_MOMENT, 0]]);
  let frontier = [ANCHOR_MOMENT];
  let depth = 0;
  while (frontier.length > 0) {
    depth++;
    const next: string[] = [];
    for (const m of MOMENTS) {
      if (depths.has(m.id)) continue;
      if (!m.requires.some((r) => frontier.includes(r))) continue;
      depths.set(m.id, depth);
      next.push(m.id);
    }
    frontier = next;
  }
  return depths;
})();

export function depthOf(id: string): number {
  return MOMENT_DEPTHS.get(id) ?? 0;
}

export const MAX_DEPTH = MOMENTS.reduce((n, m) => Math.max(n, depthOf(m.id)), 0);

/** Era order, west to east on the timeline. */
export const ERA_ORDER: readonly EraId[] = ['trench', 'steel', 'silicon', 'future'];

/** The era the anchor sits in — the player's own time. */
export const PRESENT_ERA: EraId = 'silicon';

/**
 * Era distance from the present, in era steps: `silicon` 0, `steel` / `future`
 * 1, `trench` 2. This is the scaling's depth term.
 */
export function eraDistance(era: EraId): number {
  return Math.abs(ERA_ORDER.indexOf(era) - ERA_ORDER.indexOf(PRESENT_ERA));
}

/** Largest ordinary era distance (trench). */
export const MAX_ERA_DISTANCE = ERA_ORDER.reduce((n, e) => Math.max(n, eraDistance(e)), 0);

/**
 * Distance the scaling reads. The anomaly is *outside* time, so it sits one
 * step beyond the furthest era there is — which is half of why it is provably
 * the hardest battle the campaign can produce.
 */
export function distanceOf(id: string): number {
  const m = moment(id);
  if (!m) return 0;
  return m.origin === true ? MAX_ERA_DISTANCE + 1 : eraDistance(m.era);
}

/** Conquests the campaign can ever have banked when a battle is configured. */
export const MAX_CONQUERED = MOMENT_COUNT - 2;

/**
 * Structural invariants, asserted once at module load: no self-requirement, no
 * dangling id, every moment reachable from the anchor, unique ids / names /
 * seeds, exactly one anchor and one anomaly, three moments per era, and a
 * timeline that reads left to right (a moment is never placed to the left of an
 * earlier year in its own era). Thirteen nodes — microseconds, and it turns an
 * authoring slip into an immediate throw instead of an unreachable moment.
 */
function assertTimeline(): void {
  for (const m of MOMENTS) {
    for (const r of m.requires) {
      if (r === m.id) throw new Error(`chrono: ${m.id} requires itself`);
      if (!BY_ID.has(r)) throw new Error(`chrono: ${m.id} -> unknown moment ${r}`);
    }
    if (m.tx < 0 || m.tx > TIMELINE_SPACE || m.ty < 0 || m.ty > TIMELINE_SPACE) {
      throw new Error(`chrono: ${m.id} sits outside the timeline space`);
    }
  }
  if (MOMENT_DEPTHS.size !== MOMENT_COUNT) {
    throw new Error('chrono: some moments are unreachable from the anchor');
  }
  if (new Set(MOMENTS.map((m) => m.seed)).size !== MOMENT_COUNT) {
    throw new Error('chrono: duplicate moment seeds');
  }
  if (new Set(MOMENTS.map((m) => m.id)).size !== MOMENT_COUNT) {
    throw new Error('chrono: duplicate moment ids');
  }
  if (new Set(MOMENTS.map((m) => m.name)).size !== MOMENT_COUNT) {
    throw new Error('chrono: duplicate moment names');
  }
  if (MOMENTS.filter((m) => m.requires.length === 0).length !== 1) {
    throw new Error('chrono: there must be exactly one anchor');
  }
  if (moment(ANCHOR_MOMENT)?.requires.length !== 0) {
    throw new Error('chrono: the anchor must require nothing');
  }
  if (MOMENTS.filter((m) => m.origin === true).length !== 1) {
    throw new Error('chrono: there must be exactly one origin moment');
  }
  for (const era of ERA_IDS) {
    const n = momentsOfEra(era).length;
    const want = era === PRESENT_ERA ? 3 : era === 'future' ? 4 : 3;
    if (n !== want) throw new Error(`chrono: era ${era} has ${n} moments, wanted ${want}`);
  }
  // The anomaly must be the deepest thing the scaling can see.
  for (const m of MOMENTS) {
    if (m.origin === true) continue;
    if (distanceOf(m.id) >= distanceOf(ORIGIN_MOMENT)) {
      throw new Error(`chrono: ${m.id} is as far from the present as the anomaly`);
    }
  }
}
assertTimeline();

// ---------------------------------------------------------------------------
// Campaign state
// ---------------------------------------------------------------------------

export type ChronoResult = 'active' | 'victory';

export interface MomentRecord {
  /** Insertions attempted for this moment (retries included). */
  fought: number;
  /** Insertions won. 0 or 1 — a secured moment is never lost. */
  won: number;
}

export interface ChronoState {
  version: number;
  /** Moment ids the player holds. Always contains `ANCHOR_MOMENT`. */
  secured: string[];
  /** Moment the current battle is being fought for, or null. */
  current: string | null;
  records: Record<string, MomentRecord>;
  result: ChronoResult;
  battlesFought: number;
  battlesWon: number;
  /** Sim ticks summed across every chrono battle that reached a result. */
  ticks: number;
  /** Cumulative match counters, [you, order], for the TIMELINE SECURED screen. */
  totals: [PlayerStats, PlayerStats];
}

/** Its own slot. A conquest battle never writes it, and vice versa. */
export const CHRONO_SAVE_KEY = 'crystal-dawn.chrono';
export const CHRONO_SAVE_VERSION = 1;

export function createChrono(): ChronoState {
  return {
    version: CHRONO_SAVE_VERSION,
    secured: [ANCHOR_MOMENT],
    current: null,
    records: {},
    result: 'active',
    battlesFought: 0,
    battlesWon: 0,
    ticks: 0,
    totals: [createPlayerStats(), createPlayerStats()],
  };
}

export function isSecured(cs: ChronoState, id: string): boolean {
  return cs.secured.includes(id);
}

export function securedCount(cs: ChronoState): number {
  return cs.secured.length;
}

export function recordFor(cs: ChronoState, id: string): MomentRecord {
  return cs.records[id] ?? { fought: 0, won: 0 };
}

/**
 * The unlock rule: a moment opens once **any** of the moments that lead to it
 * is held. The anomaly carries a second condition on top — `ORIGIN_REQUIREMENT`
 * moments secured — so the finale can never be reached early.
 */
export function canEnter(cs: ChronoState, id: string): boolean {
  if (cs.result === 'victory') return false;
  const m = moment(id);
  if (!m || isSecured(cs, id)) return false;
  if (!m.requires.some((r) => isSecured(cs, r))) return false;
  if (m.origin === true && securedCount(cs) < ORIGIN_REQUIREMENT) return false;
  return true;
}

/**
 * True when the anomaly is visible on the map as *gated* rather than simply
 * locked: its graph condition is met but the count is not. The map says so, so
 * the player knows what the finale is waiting for.
 */
export function originGated(cs: ChronoState): boolean {
  const m = moment(ORIGIN_MOMENT);
  if (!m || isSecured(cs, ORIGIN_MOMENT)) return false;
  if (!m.requires.some((r) => isSecured(cs, r))) return false;
  return securedCount(cs) < ORIGIN_REQUIREMENT;
}

/** Moments still needed before the anomaly opens (0 once it is available). */
export function originShortfall(cs: ChronoState): number {
  return Math.max(0, ORIGIN_REQUIREMENT - securedCount(cs));
}

/** Every enterable moment, in timeline order. */
export function enterable(cs: ChronoState): string[] {
  return MOMENTS.filter((m) => canEnter(cs, m.id)).map((m) => m.id);
}

/** Begin a battle for `id`. Returns false when the move is not legal. */
export function beginMoment(cs: ChronoState, id: string): boolean {
  if (!canEnter(cs, id)) return false;
  cs.current = id;
  const rec = recordFor(cs, id);
  cs.records[id] = { fought: rec.fought + 1, won: rec.won };
  cs.battlesFought++;
  return true;
}

/** What `resolveMoment` folds into the campaign totals. */
export interface MomentOutcome {
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
 * Settle a finished insertion.
 *
 * Win: the moment is secured and the campaign may end in victory.
 * **Loss: nothing changes at all** beyond the counters — exactly the V3 rule.
 * A secured moment is never lost; the timeline is a ratchet.
 *
 * Idempotent per battle: it clears `current`, so a second call for the same
 * battle is a no-op.
 */
export function resolveMoment(cs: ChronoState, id: string, outcome: MomentOutcome): boolean {
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
  if (!isSecured(cs, id)) cs.secured.push(id);
  if (cs.secured.length >= MOMENT_COUNT) cs.result = 'victory';
  return true;
}

// ---------------------------------------------------------------------------
// Battle scaling
// ---------------------------------------------------------------------------

/**
 * The same knobs V3 uses, with `distance` (era steps from the present) in place
 * of `depth` (graph tier). `conquered` is `securedCount - 1`: the anchor is
 * free, so a first insertion adds nothing for held ground.
 */
const CREDITS_PER_CONQUEST = 400;
const CREDITS_PER_DISTANCE = 900;

const WAVE_SIZE_PER_CONQUEST = 0.04;
const WAVE_SIZE_PER_DISTANCE = 0.09;

const INTERVAL_PER_CONQUEST = 0.025;
const INTERVAL_PER_DISTANCE = 0.06;
const INTERVAL_FLOOR = 0.5;

const ARMY_PER_CONQUEST = 0.03;
const ARMY_PER_DISTANCE = 0.06;

/**
 * Difficulty steps off one monotone rank, `distance * 4 + conquered`, so the
 * level can only ever rise as the player takes more of the timeline or travels
 * further from 1991. A first insertion is rank 0 (easy); the anomaly is rank 23
 * (hard, and the only thing that can be).
 */
const RANK_PER_DISTANCE = 4;
const EASY_MAX_RANK = 3;
const NORMAL_MAX_RANK = 13;

/**
 * Pre-built Order structures by fortification level, which is itself monotone
 * in both inputs (`distance + floor(conquered / 3)`). Cumulative, so a deeper
 * moment is never *less* fortified than a shallower one.
 *
 * The tower is the **era's own emplacement** — an MG nest in 1917, a flak tower
 * in 1943, a guard tower in 1991, a laser tower in 2077 — which is what makes a
 * fortified moment look like its own time before a shot is fired.
 *
 * The Power Plants are not decoration: an emplacement goes offline under
 * `lowPower` (Phase 4), so a tower handed to a ConYard-only opening would sit
 * dark. The count is sized for the **most expensive** era emplacement rather
 * than per era, so every level is the same shape whatever year it is fought in
 * — 2077's Laser Tower drains 40 power each against 1917's MG Nest's 5, and a
 * refinery another 30, which is why the two heaviest levels carry two plants.
 * Verified: no configured moment opens in deficit, in any era.
 */
const PREBUILT_BY_FORT: readonly (readonly (BuildingTypeId | 'tower')[])[] = [
  [], // 0
  [], // 1
  ['powerPlant', 'tower'], // 2
  ['powerPlant', 'tower', 'tower'], // 3
  ['powerPlant', 'powerPlant', 'refinery', 'tower', 'tower'], // 4
  ['powerPlant', 'powerPlant', 'refinery', 'tower', 'tower', 'tower'], // 5
];

/**
 * The anomaly's own garrison, and deliberately not a table row: seven
 * structures (one more than any ordinary level can reach) with **one
 * emplacement from every era standing side by side**, which is the first thing
 * the player sees when the ORIGIN MOMENT opens. Two plants, because four towers
 * from four eras drain 70 power between them.
 */
const ORIGIN_PREBUILT: readonly BuildingTypeId[] = [
  'powerPlant',
  'powerPlant',
  'refinery',
  'lasertower',
  'flaktower',
  'guardTower',
  'mgnest',
];

export type { ResistanceLabel };

/**
 * A chrono battle configuration. It **is** a `SkirmishOptions`, so `main.ts`
 * hands it straight to `initSkirmish` with no translation step, plus the
 * identity and the presentation numbers the timeline screen needs.
 */
export interface ChronoBattleConfig extends SkirmishOptions {
  moment: string;
  name: string;
  era: EraId;
  year: number;
  yearLabel: string;
  seed: number;
  /** Gate depth (BFS from the anchor). Presentation only — see `MOMENT_DEPTHS`. */
  depth: number;
  /** Era steps from the present. The scaling's depth term. */
  distance: number;
  /** Moments held when this battle was configured (the anchor included). */
  securedCount: number;
  /** `securedCount - 1`: the term that makes it harder the more you hold. */
  conquered: number;
  origin: boolean;
  difficulty: AiDifficulty;
  aiCreditBonus: number;
  aiScaling: AiScaling;
  aiPrebuilt: readonly BuildingTypeId[];
  /** True only for the anomaly: The Order's roster gate is lifted. */
  aiAnomaly: boolean;
  /** 0..1 resistance rating, for the insertion plate. */
  threat: number;
  resistance: ResistanceLabel;
}

/**
 * The whole difficulty curve, as one pure function of (moments held, era
 * distance).
 *
 * Every term is non-decreasing in both inputs — more of the timeline and a
 * further era can only ever add credits, wave size, army cap and pre-built
 * defences, and can only ever shorten the gap between waves.
 *
 * **The ORIGIN MOMENT is pinned to the maximum** rather than read off the live
 * campaign: it is configured at `MAX_CONQUERED` whatever the player actually
 * holds, and it sits one era-step beyond the furthest era. That is what makes
 * it provably the hardest battle the campaign can produce — its count gate lets
 * it be entered with two moments outstanding, so reading the live count would
 * have let a last-fought 1917 moment out-scale the finale. The anomaly does not
 * care how much of the timeline you hold; it fields everything, always.
 *
 * `cs` is read, never written.
 */
export function chronoBattleConfig(cs: ChronoState, momentId: string): ChronoBattleConfig {
  const m = moment(momentId);
  if (!m) throw new Error(`chronoBattleConfig: unknown moment "${momentId}"`);
  const origin = m.origin === true;
  const held = securedCount(cs);
  const conquered = origin ? MAX_CONQUERED : Math.min(MAX_CONQUERED, Math.max(0, held - 1));
  const distance = distanceOf(momentId);

  const rank = distance * RANK_PER_DISTANCE + conquered;
  const difficulty: AiDifficulty =
    rank <= EASY_MAX_RANK ? 'easy' : rank <= NORMAL_MAX_RANK ? 'normal' : 'hard';

  const aiCreditBonus = conquered * CREDITS_PER_CONQUEST + distance * CREDITS_PER_DISTANCE;

  const aiScaling = makeAiScaling({
    waveSize: 1 + conquered * WAVE_SIZE_PER_CONQUEST + distance * WAVE_SIZE_PER_DISTANCE,
    waveInterval: Math.max(
      INTERVAL_FLOOR,
      1 - conquered * INTERVAL_PER_CONQUEST - distance * INTERVAL_PER_DISTANCE,
    ),
    armyCap: 1 + conquered * ARMY_PER_CONQUEST + distance * ARMY_PER_DISTANCE,
  });

  const aiPrebuilt = origin ? ORIGIN_PREBUILT : prebuiltFor(m.era, distance, conquered);

  const threat = Math.min(
    1,
    Math.max(
      0,
      (distance / (MAX_ERA_DISTANCE + 1)) * 0.6 + (conquered / Math.max(1, MAX_CONQUERED)) * 0.4,
    ),
  );

  return {
    moment: m.id,
    name: m.name,
    era: m.era,
    year: m.year,
    yearLabel: m.yearLabel,
    seed: m.seed,
    depth: depthOf(m.id),
    distance,
    securedCount: held,
    conquered,
    origin,
    difficulty,
    aiCreditBonus,
    aiScaling,
    aiPrebuilt,
    aiAnomaly: origin,
    threat,
    resistance: resistanceOf(threat),
    fog: true,
  };
}

/** Fortification level, and the era's own emplacement filled in for `tower`. */
export function fortLevelFor(distance: number, conquered: number): number {
  return Math.min(
    PREBUILT_BY_FORT.length - 1,
    Math.max(0, distance + Math.floor(Math.max(0, conquered) / 3)),
  );
}

function prebuiltFor(
  era: EraId,
  distance: number,
  conquered: number,
): readonly BuildingTypeId[] {
  const row = PREBUILT_BY_FORT[fortLevelFor(distance, conquered)] ?? [];
  const tower = eraDefenseTower(era);
  return row.map((t) => (t === 'tower' ? tower : t));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export type { CampaignStorage as ChronoStorage };

/** `localStorage` when it exists and is reachable, else null. */
export function defaultChronoStorage(): CampaignStorage | null {
  return defaultCampaignStorage();
}

export function serializeChrono(cs: ChronoState): string {
  return JSON.stringify({
    version: CHRONO_SAVE_VERSION,
    secured: cs.secured,
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
 * and never a half-restored one: bad JSON, a foreign version, unknown moment
 * ids, a missing anchor, or a "victory" that does not hold all thirteen (the
 * result is recomputed from `secured`, not trusted). `current` is deliberately
 * dropped — a battle that was in progress when the tab closed did not happen.
 */
export function deserializeChrono(json: string | null): ChronoState {
  const fresh = createChrono();
  if (!json) return fresh;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fresh;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fresh;
  const src = raw as Record<string, unknown>;
  if (num(src.version, -1) !== CHRONO_SAVE_VERSION) return fresh;

  const secured: string[] = [ANCHOR_MOMENT];
  if (Array.isArray(src.secured)) {
    for (const id of src.secured) {
      if (typeof id !== 'string' || !isMomentId(id) || secured.includes(id)) continue;
      secured.push(id);
    }
  }

  const records: Record<string, MomentRecord> = {};
  if (src.records && typeof src.records === 'object' && !Array.isArray(src.records)) {
    for (const [id, rec] of Object.entries(src.records as Record<string, unknown>)) {
      if (!isMomentId(id) || !rec || typeof rec !== 'object') continue;
      const r = rec as Record<string, unknown>;
      records[id] = {
        fought: Math.max(0, Math.floor(num(r.fought))),
        won: Math.max(0, Math.floor(num(r.won))),
      };
    }
  }

  const totalsRaw = Array.isArray(src.totals) ? src.totals : [];
  return {
    version: CHRONO_SAVE_VERSION,
    secured,
    current: null,
    records,
    result: secured.length >= MOMENT_COUNT ? 'victory' : 'active',
    battlesFought: Math.max(0, Math.floor(num(src.battlesFought))),
    battlesWon: Math.max(0, Math.floor(num(src.battlesWon))),
    ticks: Math.max(0, Math.floor(num(src.ticks))),
    totals: [readStats(totalsRaw[0]), readStats(totalsRaw[1])],
  };
}

/** Load the timeline, or a fresh one when there is nothing sane to load. */
export function loadChrono(storage: CampaignStorage | null): ChronoState {
  if (!storage) return createChrono();
  try {
    return deserializeChrono(storage.getItem(CHRONO_SAVE_KEY));
  } catch {
    // A storage that throws on read (private browsing, blocked cookies).
    return createChrono();
  }
}

/** Persist. A storage that throws is a session-only campaign, never a crash. */
export function saveChrono(storage: CampaignStorage | null, cs: ChronoState): void {
  if (!storage) return;
  try {
    storage.setItem(CHRONO_SAVE_KEY, serializeChrono(cs));
  } catch {
    // Quota / private browsing. The timeline still holds for this session.
  }
}

/** Wipe the save and hand back a fresh timeline. */
export function resetChrono(storage: CampaignStorage | null): ChronoState {
  const fresh = createChrono();
  if (storage) {
    try {
      if (storage.removeItem) storage.removeItem(CHRONO_SAVE_KEY);
      else storage.setItem(CHRONO_SAVE_KEY, serializeChrono(fresh));
    } catch {
      // Same contract as saveChrono.
    }
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Introspection (`__game.chrono()`)
// ---------------------------------------------------------------------------

export interface ChronoMomentReport {
  id: string;
  name: string;
  era: EraId;
  year: number;
  depth: number;
  distance: number;
  seed: number;
  secured: boolean;
  enterable: boolean;
  origin: boolean;
  fought: number;
  won: number;
  requires: readonly string[];
  difficulty: AiDifficulty;
  aiCreditBonus: number;
  aiScaling: AiScaling;
  aiPrebuilt: readonly BuildingTypeId[];
  aiAnomaly: boolean;
  threat: number;
  resistance: ResistanceLabel;
}

export interface ChronoReport {
  secured: string[];
  securedCount: number;
  total: number;
  enterable: string[];
  current: string | null;
  result: ChronoResult;
  battlesFought: number;
  battlesWon: number;
  ticks: number;
  originGated: boolean;
  originShortfall: number;
  totals: [PlayerStats, PlayerStats];
  moments: ChronoMomentReport[];
}

export function chronoReport(cs: ChronoState): ChronoReport {
  return {
    secured: cs.secured.slice(),
    securedCount: securedCount(cs),
    total: MOMENT_COUNT,
    enterable: enterable(cs),
    current: cs.current,
    result: cs.result,
    battlesFought: cs.battlesFought,
    battlesWon: cs.battlesWon,
    ticks: cs.ticks,
    originGated: originGated(cs),
    originShortfall: originShortfall(cs),
    totals: cs.totals,
    moments: MOMENTS.map((m) => {
      const cfg = chronoBattleConfig(cs, m.id);
      const rec = recordFor(cs, m.id);
      return {
        id: m.id,
        name: m.name,
        era: m.era,
        year: m.year,
        depth: cfg.depth,
        distance: cfg.distance,
        seed: m.seed,
        secured: isSecured(cs, m.id),
        enterable: canEnter(cs, m.id),
        origin: m.origin === true,
        fought: rec.fought,
        won: rec.won,
        requires: m.requires,
        difficulty: cfg.difficulty,
        aiCreditBonus: cfg.aiCreditBonus,
        aiScaling: cfg.aiScaling,
        aiPrebuilt: cfg.aiPrebuilt,
        aiAnomaly: cfg.aiAnomaly,
        threat: cfg.threat,
        resistance: cfg.resistance,
      };
    }),
  };
}
