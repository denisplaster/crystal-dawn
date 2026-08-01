/**
 * Skirmish setup.
 *
 * Phase 1 pre-placed the starting bases inside `main.ts` as boot scaffolding
 * and flagged it for Phase 3/5 to take over; this is that takeover. Everything
 * needed to put a *fresh* `GameState` into a playable opening lives here, so a
 * restart is `createGameState()` + `initSkirmish()` and nothing else.
 *
 * Per SPEC "Balance data": each side starts with a pre-placed ConYard and one
 * free minigunner scout; the human starts on `START_CREDITS`, the AI on that
 * plus its difficulty's credit bonus.
 */

import {
  MAP_H,
  MAP_W,
  PLAYER_AI,
  PLAYER_HUMAN,
  START_CREDITS,
  clamp,
  type PlayerId,
} from './constants';
import { findNearestPassable } from './pathfinding';
import { createBuilding, createUnit, postMessage, type GameState, type TilePos } from './state';
import {
  AI_DIFFICULTY,
  DEFAULT_AI_DIFFICULTY,
  createAiState,
  type AiDifficulty,
} from './systems/ai';
import { recomputeEconomy } from './systems/production';

export interface SkirmishOptions {
  /** AI difficulty. Defaults to `DEFAULT_AI_DIFFICULTY` ('normal'). */
  difficulty?: AiDifficulty;
  /** Start with the map shrouded (default true). */
  fog?: boolean;
}

/** Tile the free scout spawns on: south-east of the ConYard, on open ground. */
function scoutTile(state: GameState, start: TilePos): TilePos {
  const tx = clamp(start.tx + 1, 0, MAP_W - 1);
  const ty = clamp(start.ty + 3, 0, MAP_H - 1);
  const open = findNearestPassable(state.map, tx, ty, 6);
  return open ?? { tx, ty };
}

/**
 * Put a fresh `GameState` into the opening position. Safe to call exactly once
 * per state (it creates entities; it does not clear existing ones).
 */
export function initSkirmish(state: GameState, opts: SkirmishOptions = {}): void {
  const difficulty = opts.difficulty ?? DEFAULT_AI_DIFFICULTY;

  state.map.startTiles.forEach((start, idx) => {
    const player = idx as PlayerId;
    // 3x3 ConYard centred on the start tile.
    createBuilding(state, 'conyard', start.tx - 1, start.ty - 1, player);
    const scout = scoutTile(state, start);
    createUnit(state, 'minigunner', scout.tx, scout.ty, player);
  });

  state.players[PLAYER_HUMAN].credits = START_CREDITS;
  state.players[PLAYER_AI].credits = START_CREDITS + AI_DIFFICULTY[difficulty].creditBonus;

  // The AI's bookkeeping is derived from the base that was just placed.
  state.ai = createAiState(state, difficulty);

  recomputeEconomy(state);
  state.result = 'playing';
  state.fog.enabled = opts.fog !== false;
  state.fog.version++;
  postMessage(state, 'Battle control online.');
}

/** Where the camera should sit at the start of a skirmish. */
export function humanStartTile(state: GameState): TilePos {
  const t = state.map.startTiles[PLAYER_HUMAN];
  return t ? { tx: t.tx, ty: t.ty } : { tx: Math.floor(MAP_W / 2), ty: Math.floor(MAP_H / 2) };
}
