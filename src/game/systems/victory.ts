/**
 * Victory / defeat.
 *
 * Runs last in the tick, after `removeDead`, so it only ever looks at living
 * entities.
 *
 * A player is defeated when they have **no production structure** (nothing with
 * `productionStructure` in `BUILDING_TYPES` — ConYard, Barracks, War Factory)
 * AND they cannot come back from it:
 *
 *   - they have no units left at all, or
 *   - they have no refinery and less money than the cheapest production
 *     structure, so no income and nothing to spend.
 *
 * The second clause is what stops a player being declared dead mid-fight: an
 * army in the field, or a refinery still pumping credits, keeps them alive even
 * with every factory razed. v1 has no MCV, so "restore production" can only
 * mean "buy a Barracks", which is exactly the credit test above.
 */

import { PLAYER_AI, PLAYER_HUMAN } from '../constants';
import { BUILDING_TYPES, BUILDING_TYPE_IDS } from '../rules';
import { postMessage, type GameState, type PlayerState } from '../state';

/** Cheapest structure that would restore production capability (Barracks, 400). */
export const CHEAPEST_PRODUCTION = BUILDING_TYPE_IDS.reduce((min, id) => {
  const def = BUILDING_TYPES[id];
  if (!def.productionStructure || id === 'conyard') return min;
  return Math.min(min, def.cost);
}, Infinity);

/**
 * Living, finished structures that count as production capability.
 *
 * A structure that is being **sold** still counts: it is standing, the sale can
 * still be out-raced by whatever the refund bought, and the player should not be
 * declared dead 1.5 seconds early. Once it actually dies the ordinary rule
 * applies on the very next tick — selling your last factory still loses the
 * game, just not before the building is gone.
 */
export function productionStructureCount(state: GameState, player: number): number {
  let n = 0;
  for (const b of state.buildings) {
    if (b.dead || b.player !== player) continue;
    if (b.status === 'constructing') continue;
    if (!BUILDING_TYPES[b.type].productionStructure) continue;
    n++;
  }
  return n;
}

function unitCount(state: GameState, player: number): number {
  let n = 0;
  for (const u of state.units) {
    if (!u.dead && u.player === player) n++;
  }
  return n;
}

function hasRefinery(state: GameState, player: number): boolean {
  for (const b of state.buildings) {
    if (b.dead || b.player !== player || b.type !== 'refinery') continue;
    // 'selling' counts as standing here too, for the same reason.
    if (b.status === 'constructing') continue;
    return true;
  }
  return false;
}

/** The rule, in one place, so tests and the AI can ask the same question. */
export function isDefeated(state: GameState, p: PlayerState): boolean {
  if (productionStructureCount(state, p.id) > 0) return false;
  if (unitCount(state, p.id) === 0) return true;
  return !hasRefinery(state, p.id) && p.credits < CHEAPEST_PRODUCTION;
}

/**
 * Evaluate both players and settle the game. Idempotent: once `state.result`
 * leaves `'playing'` it never changes again.
 */
export function updateVictory(state: GameState): void {
  if (state.result !== 'playing') return;
  // An empty world is a world that has not been set up yet, not a loss.
  if (state.units.length === 0 && state.buildings.length === 0) return;

  for (const p of state.players) {
    if (p.defeated) continue;
    if (isDefeated(state, p)) p.defeated = true;
  }

  const human = state.players[PLAYER_HUMAN];
  const ai = state.players[PLAYER_AI];

  if (human.defeated) {
    state.result = 'lost';
    postMessage(state, 'Mission failed.', 'alert');
    return;
  }
  if (ai.defeated) {
    state.result = 'won';
    postMessage(state, 'Mission accomplished.', 'info');
  }
}
