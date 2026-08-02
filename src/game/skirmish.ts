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
import { BUILDING_TYPES, type BuildingTypeId } from './rules';
import {
  createBuilding,
  createUnit,
  markMapRectDirty,
  postMessage,
  type Building,
  type GameState,
  type TilePos,
} from './state';
import {
  AI_DIFFICULTY,
  DEFAULT_AI_DIFFICULTY,
  NO_AI_SCALING,
  createAiState,
  findPlacementTile,
  type AiDifficulty,
  type AiScaling,
  type AiState,
} from './systems/ai';
import { recomputeEconomy, spawnTileFor } from './systems/production';

export interface SkirmishOptions {
  /** AI difficulty. Defaults to `DEFAULT_AI_DIFFICULTY` ('normal'). */
  difficulty?: AiDifficulty;
  /** Start with the map shrouded (default true). */
  fog?: boolean;
  /**
   * V3 (conquest campaign): extra opening credits for the AI, on top of the
   * difficulty's own `creditBonus`. Omitted / 0 in every skirmish.
   */
  aiCreditBonus?: number;
  /**
   * V3: pressure multipliers threaded into the AI's difficulty tuple. Omitted
   * means `NO_AI_SCALING`, which makes `aiTuning` an identity.
   */
  aiScaling?: AiScaling;
  /**
   * V3: structures the AI already has standing when the battle opens, beyond
   * its ConYard. Placed with exactly the validation the human's placement ghost
   * uses (`canPlaceAt` through the AI's own ring search), so an extra can never
   * overlap, bury a unit or sit on unbuildable ground; an extra with nowhere
   * legal to go is simply skipped.
   */
  aiPrebuilt?: readonly BuildingTypeId[];
}

/** Tile the free scout spawns on: south-east of the ConYard, on open ground. */
function scoutTile(state: GameState, start: TilePos): TilePos {
  const tx = clamp(start.tx + 1, 0, MAP_W - 1);
  const ty = clamp(start.ty + 3, 0, MAP_H - 1);
  const open = findNearestPassable(state.map, tx, ty, 6);
  return open ?? { tx, ty };
}

/**
 * V3: stand an extra AI structure up before the first tick.
 *
 * Deliberately **not** `placeStructure`: there is no queue item to consume and
 * these were never *built* by the player, so they are issued exactly the way the
 * opening ConYard is (no `buildingsBuilt` / `unitsProduced` stat, no EVA line).
 * The tile still comes from the AI's own `findPlacementTile`, i.e. the same
 * `canPlaceAt` validation everything else on the map passes.
 */
function placePrebuilt(state: GameState, ai: AiState, type: BuildingTypeId): Building | null {
  const tile = findPlacementTile(state, ai, type);
  if (!tile) return null;
  const b = createBuilding(state, type, tile.tx, tile.ty, PLAYER_AI);
  markMapRectDirty(state, b.tx, b.ty, b.w, b.h);
  // A Refinery's free Harvester is part of the structure, not a production
  // event: without it a pre-placed refinery is a building that earns nothing.
  const free = BUILDING_TYPES[type].freeUnit;
  if (free) {
    const spot = spawnTileFor(state, b);
    if (spot) createUnit(state, free, spot.tx, spot.ty, PLAYER_AI);
  }
  return b;
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

  const extraCredits = Number.isFinite(opts.aiCreditBonus) ? (opts.aiCreditBonus as number) : 0;
  state.players[PLAYER_HUMAN].credits = START_CREDITS;
  state.players[PLAYER_AI].credits =
    START_CREDITS + AI_DIFFICULTY[difficulty].creditBonus + Math.max(0, extraCredits);

  // The AI's bookkeeping is derived from the base that was just placed.
  state.ai = createAiState(state, difficulty, opts.aiScaling ?? NO_AI_SCALING);

  // V3: pre-built defences / economy for a deep campaign territory. After the
  // AI state exists (the placement anchors come off it) and before the economy
  // is booked, so power and storage already count them on tick 0.
  if (opts.aiPrebuilt) {
    for (const type of opts.aiPrebuilt) placePrebuilt(state, state.ai, type);
  }

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
