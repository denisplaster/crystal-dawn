/**
 * Crystal Dawn — boot.
 *
 * Creates the canvas, the GameState, the engine services and the fixed-timestep
 * loop, then exposes `window.__game` for debugging/testing.
 *
 * Phase 1 has no gameplay systems yet; the tick only advances the clock and
 * services camera input. Later phases insert their systems into `tick()`.
 */

import { Camera } from './engine/camera';
import { Input } from './engine/input';
import { GameLoop } from './engine/loop';
import { MAP_H, MAP_W, PLAYER_HUMAN, type PlayerId } from './game/constants';
import {
  isBuildingType,
  isUnitType,
  type BuildingTypeId,
  type UnitTypeId,
} from './game/rules';
import { humanStartTile, initSkirmish } from './game/skirmish';
import {
  createBuilding,
  createGameState,
  createUnit,
  isUnitStance,
  postMessage,
  stanceOf,
  type GameResult,
  type GameState,
  type OrderKind,
  type UnitStance,
} from './game/state';
import {
  aiDifficulty,
  aiReport,
  isAiDifficulty,
  updateAi,
  type AiDifficulty,
  type AiReport,
} from './game/systems/ai';
import { airReport, updateAir, type AircraftReport } from './game/systems/air';
import {
  captureByIds,
  captureReport,
  updateCapture,
  type CaptureReport,
} from './game/systems/capture';
import { damageEntity, findCombatant, removeDead, updateCombat } from './game/systems/combat';
import { fogAt, updateFog } from './game/systems/fog';
import { onDangerHold, updateHarvest } from './game/systems/harvest';
import { updateMovement } from './game/systems/movement';
import {
  attackTargetById,
  orderUnitsById,
  setStanceByIds,
  updateOrders,
} from './game/systems/orders';
import {
  enqueue,
  placeStructure,
  sellBuildingById,
  updateProduction,
} from './game/systems/production';
import { updateVictory } from './game/systems/victory';
import { Sfx, SFX_NAMES, type SfxName } from './audio/sfx';
import { Renderer } from './render/renderer';
import { auditSprites, initSprites, type SpriteAuditEntry } from './render/sprites';
import { BRIEFING_CHARS, BriefingScreen } from './render/briefing';
import { Hud } from './render/hud';
import {
  DEFAULT_MAP,
  TitleScreen,
  isMapChoice,
  mapDef,
  nextPhase,
  seedFor,
  type AppPhase,
  type MapChoice,
} from './render/title';
import { Sidebar } from './render/ui';

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const app = document.getElementById('app');
if (!app) throw new Error('#app container missing from index.html');
app.textContent = '';

const canvas = document.createElement('canvas');
canvas.id = 'game';
canvas.tabIndex = 0; // focusable, so key events land here
app.appendChild(canvas);

function sizeCanvas(camera: Camera): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  camera.resize(w, h, dpr);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initSprites();

const camera = new Camera(window.innerWidth, window.innerHeight);
sizeCanvas(camera);

const input = new Input(canvas, camera);
const renderer = new Renderer(canvas, camera);
const sidebar = new Sidebar(camera);
renderer.sidebarDraw = (ctx, gs, hud) => sidebar.draw(ctx, gs, hud);

/**
 * Audio is a pure consumer of GameState (see audio/sfx.ts). The AudioContext
 * cannot exist until the player interacts with the page, so the first click or
 * keypress anywhere unlocks it; until then every sound is a silent no-op.
 */
const sfx = new Sfx();
sfx.attachUnlock(window);
sidebar.audioStatus = () => ({ muted: sfx.muted, ready: sfx.ready });

/**
 * Title -> briefing -> mission. The sim does not tick while the phase is
 * anything other than 'playing': both pre-mission screens animate off their own
 * render-side frame counters.
 */
const title = new TitleScreen();
const briefing = new BriefingScreen();
let phase: AppPhase = 'title';
renderer.titleDraw = (ctx, terrain, w, h) =>
  phase === 'briefing' ? briefing.draw(ctx, terrain, w, h) : title.draw(ctx, terrain, w, h);

/**
 * In-world HUD: objectives readout + controls overlay. Render-side only; its
 * `update()` is the outermost ring of input routing (see render/hud.ts).
 */
const hud = new Hud(camera);
renderer.hudDraw = (ctx, gs) => hud.drawObjectives(ctx, gs);
renderer.overlayDraw = (ctx) => hud.drawHelp(ctx);

/** EVA's opening line, queued through the ordinary message stream. */
const MISSION_OBJECTIVE_LINE = 'Objective: destroy all enemy structures.';

window.addEventListener('resize', () => sizeCanvas(camera));

/** Difficulty the next `restart()` will use. */
let difficulty: AiDifficulty = 'normal';

/**
 * V2 — map selection. `mapChoice` is what the title row shows; `mapSeed` is the
 * number the *mission* is built from. They come apart for RANDOM: the title
 * rolls a fresh seed at each deploy (render-side entropy, the one sanctioned
 * exception, documented in `render/title.ts`) and hands it over in the action,
 * and `restart()` then replays *that* seed rather than rolling again — so R
 * after a defeat is the same map, and returning to the title is how you change
 * it.
 */
let mapChoice: MapChoice = DEFAULT_MAP;
let mapSeed: number = mapDef(DEFAULT_MAP).seed;

/** Adopt a seed the title resolved, and tag the briefing header with it. */
function setMission(choice: MapChoice, seed: number): void {
  mapChoice = choice;
  mapSeed = seed >>> 0;
  briefing.setMission(mapDef(choice).label, mapSeed);
}

/**
 * Build a brand-new skirmish. `state` is reassigned wholesale, so nothing
 * survives a restart: fresh map, entities, fog, credits, AI plan and result.
 */
function newGame(): GameState {
  const gs = createGameState(mapSeed);
  initSkirmish(gs, { difficulty });
  return gs;
}

let state = newGame();
renderer.buildTerrain(state.map);
camera.centerOnTile(humanStartTile(state).tx, humanStartTile(state).ty);

/**
 * EVA's objective line is posted from inside the *first tick* of the mission,
 * never straight after `restart()`. A message posted while `state.tick` is
 * still 0 would be re-consumed by every render frame until the clock moved
 * (`Sfx.consume` watermarks on `state.tick`), and EVA would say it two or three
 * times.
 */
let objectiveLinePending = false;

/**
 * Full reset without reloading the page: new state, new terrain cache, fresh
 * shroud, camera back on the human base.
 */
function restart(level?: AiDifficulty): GameState {
  if (level) difficulty = level;
  state = newGame();
  api.state = state;
  renderer.buildTerrain(state.map);
  renderer.invalidateFog();
  // Sidebar.reset() also drops the radar's downsampled terrain + shroud, which
  // are keyed on the old map / the old fog version numbering.
  sidebar.reset();
  // The audio consumer watermarks on state.tick, which restarts at 0.
  sfx.resetStream();
  // Render-side HUD carry-over: close a hand-opened overlay, re-arm the
  // first-mission hint check. The collapsed/seen preferences are persisted and
  // deliberately survive.
  hud.onMissionStart();
  objectiveLinePending = true;
  camera.centerOnTile(humanStartTile(state).tx, humanStartTile(state).ty);
  return state;
}

/** Leave the briefing for a fresh mission. */
function startMission(): void {
  restart(difficulty);
  phase = 'playing';
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

function tick(): void {
  const raw = input.snapshot();

  // Mute works everywhere, including on the title screen.
  if (raw.pressed.has('KeyM')) sfx.toggleMute();

  // Title screen: no system runs and `state.tick` never advances, so the
  // simulation is frozen rather than ticked-and-hidden. The loop keeps calling
  // render(), which animates off its own frame counter.
  if (phase === 'title') {
    const action = title.update(raw, camera.canvasW, camera.canvasH);
    if (action) {
      sfx.play('click');
      if (action.kind === 'difficulty') {
        difficulty = action.level;
      } else {
        // Both 'map' (row click) and 'start' (deploy) carry a resolved seed —
        // for RANDOM, a freshly rolled one. The mission is built at the
        // briefing's deploy, so stashing it here is all the plumbing needed.
        setMission(action.map, action.seed);
        if (action.kind === 'start') briefing.reset();
      }
    }
    phase = nextPhase(phase, action);
    input.endTick();
    return;
  }

  // Mission briefing: same deal — frozen sim, render-side typewriter. The first
  // click/Enter completes the text, the second deploys. Everything the briefing
  // sees is consumed here, so nothing leaks into the mission.
  if (phase === 'briefing') {
    const action = briefing.update(raw);
    if (action) {
      sfx.play('click');
      if (action.kind === 'start') startMission();
    }
    phase = nextPhase(phase, action);
    input.endTick();
    return;
  }

  // Camera control (edge scroll + arrow keys).
  camera.pan(raw.pan.x, raw.pan.y);

  // Debug overlay toggle.
  if (raw.pressed.has('KeyF')) renderer.debugOverlay = !renderer.debugOverlay;

  // EVA's opening line, posted inside the mission's first tick (see above).
  if (objectiveLinePending) {
    objectiveLinePending = false;
    postMessage(state, MISSION_OBJECTIVE_LINE, 'info');
  }

  // The HUD gets first refusal on input, ahead of the sidebar: while the help
  // overlay is open it swallows every pointer event so nothing box-selects,
  // scrubs the radar or restarts underneath it.
  const hudSnap = hud.update(raw);

  if (state.result === 'playing') {
    // The sidebar gets second refusal (its own strip + placement mode) and
    // hands back a snapshot with the events it consumed removed.
    const snap = sidebar.update(state, hudSnap);
    updateOrders(state, snap);
  } else {
    // Mission decided: the curtain is up, orders are ignored, and the only
    // input that means anything is "play again".
    const clicked = hudSnap.clicks.some((c) => c.button === 0);
    if (hudSnap.pressed.has('KeyR') || clicked) {
      restart();
      input.endTick();
      return;
    }
  }

  // --- gameplay systems run here, in a fixed order ---
  // orders -> movement -> harvest -> air -> production -> combat (incl.
  // projectiles) -> fog -> dead cleanup -> ai -> victory
  updateMovement(state);
  updateHarvest(state);
  // V2: aircraft ammo/rearm sits next to the harvest cycle for the same reason
  // — both read "the unit arrived this tick" straight out of movement.
  updateAir(state);
  // V2: engineer capture, for the same reason again — "did the engineer reach
  // the door this tick". It runs before production so the power/storage books a
  // captured structure moves are settled in the same tick it changes hands.
  updateCapture(state);
  updateProduction(state);
  updateCombat(state);
  updateFog(state);
  removeDead(state);
  updateAi(state);
  updateVictory(state);

  // Drain the sim's terrain-repaint queue into the two render-side caches that
  // downsample the map (world terrain layer + radar pane).
  if (state.dirtyTiles.length > 0) {
    for (const idx of state.dirtyTiles) {
      const tx = idx % MAP_W;
      const ty = Math.floor(idx / MAP_W);
      renderer.markTileDirty(tx, ty);
      sidebar.markTileDirty(tx, ty);
    }
    state.dirtyTiles.length = 0;
  }

  state.tick++;
  input.endTick();
}

function render(alpha: number): void {
  if (phase !== 'playing') {
    // Title and briefing both own the whole canvas; `titleDraw` dispatches.
    renderer.renderTitle(state);
    return;
  }
  renderer.render(state, alpha, {
    fps: loop.fps,
    speed: loop.speed,
    drag: input.liveDrag,
    pointerX: input.mouseX,
    pointerY: input.mouseY,
  });
  // Sound is produced here, never in the tick: the sim must not depend on it.
  sfx.consume(state, { x: camera.x, y: camera.y, w: camera.viewW, h: camera.viewH });
}

const loop = new GameLoop({ tick, render });
loop.start();

// ---------------------------------------------------------------------------
// Debug hook
// ---------------------------------------------------------------------------

export interface GameApi {
  state: GameState;
  camera: Camera;
  renderer: Renderer;
  loop: GameLoop;
  input: Input;
  /** Create a unit or structure by type id. Returns the entity id, or -1. */
  spawn(type: string, tx: number, ty: number, player?: number): number;
  /** Add credits to a player (default: human). Returns the new balance. */
  give(credits: number, player?: number): number;
  /** Reveal the whole map (fog off). Pass false to re-enable fog. */
  reveal(on?: boolean): void;
  /** Set the sim speed multiplier. 0 pauses. Returns the applied value. */
  speed(mult: number): number;
  /** Replace the current selection. Returns the new selection. */
  select(ids: number[] | number): number[];
  /**
   * Issue an order programmatically (testing). `tx`/`ty` are tile coords by
   * default; pass `{ world: true }` for world pixels, `{ queued: true }` to
   * append instead of replace. Returns how many units took the order.
   */
  order(
    ids: number[] | number,
    kind: OrderKind,
    tx: number,
    ty: number,
    opts?: { world?: boolean; queued?: boolean },
  ): number;
  /**
   * Order units to attack an entity (testing / AI harnesses). Unarmed units
   * are sent to the target's position instead. Returns how many took it.
   */
  attack(ids: number[] | number, targetId: number, queued?: boolean): number;
  /**
   * Apply raw damage to an entity id, bypassing armor (test helper). Returns
   * the remaining hp, or -1 when the id is unknown. `sourceId` names the
   * attacker, which is what an explore-stance unit runs away from.
   */
  damage(id: number, amount: number, sourceId?: number): number;
  /**
   * Set the engagement stance of units by id. Harvesters are skipped (their
   * self-preservation is hardwired, not a stance). Returns how many changed.
   */
  stance(ids: number[] | number, mode: string): number;
  /** Human-perspective fog state of a tile. */
  fogAt(tx: number, ty: number): { explored: boolean; visible: boolean };
  /** Enqueue a structure/unit for a player (default: human). */
  queue(type: string, player?: number): boolean;
  /** Place the human's completed structure at a tile. */
  placeReady(tx: number, ty: number): number;
  /**
   * Sell a structure (default: the single selected one). Returns the credits
   * refunded, or -1 when nothing sellable was addressed. In game the binding is
   * 'S' with exactly one own finished structure selected.
   */
  sell(id?: number, player?: number): number;
  /** Harvester states + credits, for economy testing. */
  harvestInfo(player?: number): {
    credits: number;
    storage: number;
    power: { produced: number; drain: number; low: boolean };
    crystalLeft: number;
    harvesters: {
      id: number;
      state: string;
      cargo: number;
      tile: { tx: number; ty: number } | null;
      refineryId: number | null;
      /** Effective stance. Always 'offensive' — harvesters take no stance. */
      stance: UnitStance;
      /** True while the harvester is sitting out a danger hold. */
      holding: boolean;
      /** Ticks of danger hold left (0 when it is working). */
      holdTicks: number;
      /** Tile it was last attacked on / pulled off, avoided when it resumes. */
      dangerTile: { tx: number; ty: number } | null;
    }[];
  };
  /**
   * V2: every aircraft a player owns, with its pod state — rounds left, the pad
   * it has claimed, whether it is docked and how many ticks of rearm are left.
   * This is the ammo readout for headless harnesses and for the console.
   */
  airInfo(player?: number): AircraftReport[];
  /**
   * V2: order engineers to capture an enemy structure — the debug-hook form of
   * right-clicking it with them selected. Units that cannot capture are ignored.
   * Returns how many took the order.
   */
  capture(engineerIds: number[] | number, buildingId: number): number;
  /** V2: every capture-capable unit and what it is walking in on. */
  captureInfo(player?: number): CaptureReport[];
  /** V2: the seed the current mission's map was generated from. */
  mapSeed(): number;
  /**
   * V2: map selection for the *next* mission. No argument reads the current
   * choice; pass 'alpha'|'bravo'|'charlie'|'delta'|'random' to change it (which
   * resolves a seed immediately — a fresh one for 'random'). `restart()` then
   * replays that seed.
   */
  map(choice?: string): { map: MapChoice; seed: number };
  /**
   * Enemy-AI difficulty. Called with no argument it reads the current level;
   * pass 'easy' | 'normal' | 'hard' to switch it mid-game.
   */
  ai(level?: string): AiDifficulty;
  /** Snapshot of what the AI is doing right now (build, army, wave clock). */
  aiInfo(): AiReport;
  /** Current mission result. */
  result(): GameResult;
  /**
   * Full restart without a page reload: fresh state, map cache, fog and AI.
   * Optionally switches difficulty for the new game.
   */
  restart(level?: string): GameState;
  /**
   * Force every sprite the factory can produce and report its dimensions and
   * opaque pixel count. Any entry under ~20 opaque px is a blank sprite.
   */
  spriteAudit(): SpriteAuditEntry[];
  /**
   * Audio test hook. With no argument it lists the catalogue; with a name it
   * plays that sound and reports whether it actually reached the mixer.
   */
  sfx(name?: string): readonly string[] | boolean;
  /** Mute state. Pass a boolean to set it, or nothing to read it. */
  mute(on?: boolean): boolean;
  /**
   * Current app phase. With an argument it jumps: 'briefing' rewinds the
   * typewriter and shows the briefing, 'playing' starts a fresh mission (the
   * same path the briefing's deploy takes), 'title' returns to the menu.
   */
  phase(next?: AppPhase): AppPhase;
  /**
   * Controls overlay. No argument reads it; a boolean shows/hides it. Read-only
   * on the sim — this is the 'H' / F1 binding.
   */
  help(show?: boolean): boolean;
  /**
   * Objectives readout. No argument reads whether it is expanded; a boolean
   * expands (true) or collapses (false) it, persisting the preference. This is
   * the 'O' binding.
   */
  objectives(show?: boolean): boolean;
  /** Briefing typewriter state, for headless checks. */
  briefing(): { revealed: number; total: number; complete: boolean };
}

const api: GameApi = {
  state,
  camera,
  renderer,
  loop,
  input,

  spawn(type: string, tx: number, ty: number, player = PLAYER_HUMAN): number {
    const p = (player === 1 ? 1 : 0) as PlayerId;
    const x = Math.max(0, Math.min(MAP_W - 1, Math.floor(tx)));
    const y = Math.max(0, Math.min(MAP_H - 1, Math.floor(ty)));
    if (isUnitType(type)) {
      return createUnit(state, type, x, y, p).id;
    }
    if (isBuildingType(type)) {
      const b = createBuilding(state, type, x, y, p);
      renderer.markRectDirty(b.tx, b.ty, b.w, b.h);
      return b.id;
    }
    console.warn(`[__game.spawn] unknown type "${type}"`);
    return -1;
  },

  give(credits: number, player = PLAYER_HUMAN): number {
    const p = state.players[player === 1 ? 1 : 0];
    const amount = Number.isFinite(credits) ? credits : 0;
    p.credits = Math.max(0, p.credits + amount);
    return p.credits;
  },

  reveal(on = true): void {
    const fill = on ? 1 : 0;
    state.fog.explored.fill(fill);
    state.fog.visible.fill(fill);
    state.fog.enabled = !on;
    // Bump the version so the renderer drops its cached shroud bitmap.
    state.fog.version++;
  },

  speed(mult: number): number {
    const m = Number.isFinite(mult) ? mult : 1;
    loop.setSpeed(m);
    return loop.speed;
  },

  select(ids: number[] | number): number[] {
    const list = Array.isArray(ids) ? ids : [ids];
    state.selection = list.filter((id) => Number.isFinite(id));
    return state.selection;
  },

  order(ids, kind, tx, ty, opts = {}): number {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => Number.isFinite(id));
    return orderUnitsById(state, list, kind, tx, ty, opts);
  },

  attack(ids: number[] | number, targetId: number, queued = false): number {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => Number.isFinite(id));
    return attackTargetById(state, list, targetId, queued);
  },

  damage(id: number, amount: number, sourceId?: number): number {
    const e = findCombatant(state, id);
    if (!e) return -1;
    damageEntity(state, e, Number.isFinite(amount) ? amount : 0, sourceId);
    return e.hp;
  },

  stance(ids: number[] | number, mode: string): number {
    if (!isUnitStance(mode)) {
      console.warn(`[__game.stance] unknown stance "${mode}" (explore|defensive|offensive)`);
      return 0;
    }
    const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => Number.isFinite(id));
    return setStanceByIds(state, list, mode as UnitStance);
  },

  fogAt(tx: number, ty: number) {
    return fogAt(state, Math.floor(tx), Math.floor(ty));
  },

  queue(type: string, player = PLAYER_HUMAN): boolean {
    const p = (player === 1 ? 1 : 0) as PlayerId;
    if (isBuildingType(type)) return enqueue(state, p, type as BuildingTypeId);
    if (isUnitType(type)) return enqueue(state, p, type as UnitTypeId);
    console.warn(`[__game.queue] unknown type "${type}"`);
    return false;
  },

  placeReady(tx: number, ty: number): number {
    const b = placeStructure(state, PLAYER_HUMAN, Math.floor(tx), Math.floor(ty));
    return b ? b.id : -1;
  },

  sell(id?: number, player = PLAYER_HUMAN): number {
    const p = (player === 1 ? 1 : 0) as PlayerId;
    const target = id ?? (state.selection.length === 1 ? state.selection[0] : undefined);
    if (target === undefined) return -1;
    return sellBuildingById(state, p, target);
  },

  harvestInfo(player = PLAYER_HUMAN) {
    const p = state.players[player === 1 ? 1 : 0];
    let crystalLeft = 0;
    for (let i = 0; i < state.map.crystal.length; i++) {
      crystalLeft += state.map.crystal[i] as number;
    }
    return {
      credits: p.credits,
      storage: p.storage,
      power: { produced: p.powerProduced, drain: p.powerDrain, low: p.lowPower },
      crystalLeft,
      harvesters: state.units
        .filter((u) => !u.dead && u.player === p.id && u.type === 'harvester')
        .map((u) => ({
          id: u.id,
          state: u.harvestState ?? 'none',
          cargo: u.cargo ?? 0,
          tile: u.harvestTile ? { tx: u.harvestTile.tx, ty: u.harvestTile.ty } : null,
          refineryId: u.refineryId ?? null,
          stance: stanceOf(u),
          holding: onDangerHold(state, u),
          holdTicks: Math.max(0, (u.dangerHoldUntil ?? 0) - state.tick),
          dangerTile: u.dangerTile ? { tx: u.dangerTile.tx, ty: u.dangerTile.ty } : null,
        })),
    };
  },

  airInfo(player = PLAYER_HUMAN): AircraftReport[] {
    return airReport(state, player === 1 ? 1 : 0);
  },

  capture(engineerIds: number[] | number, buildingId: number): number {
    const list = (Array.isArray(engineerIds) ? engineerIds : [engineerIds]).filter((id) =>
      Number.isFinite(id),
    );
    return captureByIds(state, list, buildingId);
  },

  captureInfo(player?: number): CaptureReport[] {
    return captureReport(state, player === undefined ? undefined : player === 1 ? 1 : 0);
  },

  mapSeed(): number {
    return state.map.seed;
  },

  map(choice?: string): { map: MapChoice; seed: number } {
    if (choice !== undefined) {
      if (!isMapChoice(choice)) {
        console.warn(`[__game.map] unknown map "${choice}" (${'alpha|bravo|charlie|delta|random'})`);
      } else {
        title.map = choice;
        title.seed = seedFor(choice);
        setMission(choice, title.seed);
      }
    }
    return { map: mapChoice, seed: mapSeed };
  },

  ai(level?: string): AiDifficulty {
    if (level !== undefined) {
      if (!isAiDifficulty(level)) {
        console.warn(`[__game.ai] unknown difficulty "${level}" (easy|normal|hard)`);
        return aiDifficulty(state);
      }
      difficulty = level;
      return aiDifficulty(state, level);
    }
    return aiDifficulty(state);
  },

  aiInfo(): AiReport {
    return aiReport(state);
  },

  result(): GameResult {
    return state.result;
  },

  restart(level?: string): GameState {
    return restart(level !== undefined && isAiDifficulty(level) ? level : undefined);
  },

  spriteAudit(): SpriteAuditEntry[] {
    return auditSprites();
  },

  sfx(name?: string): readonly string[] | boolean {
    if (name === undefined) return SFX_NAMES;
    sfx.resume();
    return sfx.play(name as SfxName);
  },

  mute(on?: boolean): boolean {
    return on === undefined ? sfx.muted : sfx.setMuted(on);
  },

  phase(next?: AppPhase): AppPhase {
    if (next === 'playing' && phase !== 'playing') {
      startMission();
    } else if (next === 'briefing' && phase !== 'briefing') {
      briefing.reset();
      phase = 'briefing';
    } else if (next === 'title') {
      phase = 'title';
    }
    return phase;
  },

  help(show?: boolean): boolean {
    return show === undefined ? hud.helpVisible : hud.setHelp(show);
  },

  objectives(show?: boolean): boolean {
    return show === undefined ? !hud.objectivesCollapsed : hud.setObjectives(show);
  },

  briefing(): { revealed: number; total: number; complete: boolean } {
    return {
      revealed: briefing.revealed,
      total: BRIEFING_CHARS,
      complete: briefing.complete,
    };
  },
};

declare global {
  interface Window {
    __game: GameApi;
  }
}

window.__game = api;
canvas.focus();
