/**
 * Seeded PRNG (mulberry32).
 *
 * All gameplay-affecting randomness MUST come from one of these instances —
 * never `Math.random()` in sim code. The generator is a pure function of its
 * 32-bit state, so a run can be reproduced (or resumed) from `getState()`.
 */

export interface Rng {
  /** The seed this generator was created with. */
  readonly seed: number;
  /** Next float in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Integer in [min, max] (inclusive both ends). */
  intRange(min: number, max: number): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** True with probability p (0..1). */
  chance(p: number): boolean;
  /** Random element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** In-place Fisher-Yates shuffle; returns the same array. */
  shuffle<T>(items: T[]): T[];
  /** A new independent generator derived from this one's stream. */
  fork(): Rng;
  /** Current internal state (for save/replay). */
  getState(): number;
  /** Restore a previously captured state. */
  setState(state: number): void;
}

/** Factory: create an independent seeded generator. */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0;

  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    seed: seed >>> 0,
    next,
    int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
    intRange: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    range: (min: number, max: number) => min + next() * (max - min),
    chance: (p: number) => next() < p,
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)] as T;
    },
    shuffle<T>(items: T[]): T[] {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = items[i] as T;
        items[i] = items[j] as T;
        items[j] = tmp;
      }
      return items;
    },
    fork: () => makeRng((next() * 4294967296) >>> 0),
    getState: () => s,
    setState: (state: number) => {
      s = state >>> 0;
    },
  };

  return rng;
}

/**
 * Historical default seed for the skirmish sim.
 *
 * V2 (map variety) moved seed selection to the title screen — `main.ts` builds
 * every mission from the seed the title resolved (a curated map, or a fresh
 * roll for RANDOM), so nothing reads this at boot any more. It is kept as the
 * canonical *regression* seed: every headless baseline in SPEC.md (the AI's
 * 20-minute economy, the wave clock, the tank duel) is measured on 1337.
 */
export const GAME_SEED = 1337;

/** Shared game RNG instance. Systems without their own stream use this. */
export const rng: Rng = makeRng(GAME_SEED);

export default rng;
