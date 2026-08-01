/**
 * In-world HUD (post-release): the objectives readout and the help overlay.
 *
 * Both are **render-side only**. Nothing here is ever read by a system, nothing
 * here writes to `GameState`, and the two keys it owns ('O' and 'H'/'F1') are
 * stripped out of the input snapshot before `Sidebar.update` and `updateOrders`
 * ever see them, so the sim stays bit-identical whether or not the player opens
 * anything. The only state that outlives a mission is the two localStorage
 * preferences below, persisted exactly like the mute flag in `audio/sfx.ts`
 * (try/catch on both read and write, so private browsing never throws).
 *
 * Input precedence: `Hud.update()` runs *before* the sidebar, i.e. it is the
 * outermost ring of the existing "sidebar first refusal, then orders" routing.
 * While the overlay is open by choice it swallows every pointer event (clicks,
 * finished drag boxes and the live drag), so no box-select or minimap scrub can
 * leak underneath it. Keyboard is deliberately left alive: the overlay pauses
 * nothing, and the mission keeps running behind it.
 */

import type { StorageLike } from '../audio/sfx';
import type { Camera } from '../engine/camera';
import type { InputSnapshot } from '../engine/input';
import { PLAYER_AI, PLAYER_HUMAN } from '../game/constants';
import type { GameState } from '../game/state';
import { drawPixelText, measurePixelText } from './sprites';

// ---------------------------------------------------------------------------
// Preferences (same shape as MUTE_KEY in audio/sfx.ts)
// ---------------------------------------------------------------------------

/** '1' = the objectives panel is collapsed. */
export const OBJECTIVES_KEY = 'crystal-dawn.objectives';
/** '1' = the player has already been shown the controls once. */
export const HELP_SEEN_KEY = 'crystal-dawn.helpSeen';

/** `localStorage` when it exists and is reachable, else null. */
export function defaultHudStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

export function loadFlag(storage: StorageLike | null, key: string, fallback = false): boolean {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

export function saveFlag(storage: StorageLike | null, key: string, on: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(key, on ? '1' : '0');
  } catch {
    // Private browsing / quota. The preference still holds for this session.
  }
}

// ---------------------------------------------------------------------------
// Objectives readout
// ---------------------------------------------------------------------------

export const OBJECTIVE_LINE = 'OBJECTIVE: DESTROY ALL ORDER STRUCTURES';
export const OBJECTIVES_COLLAPSED_LINE = '[O] OBJECTIVES';
/** What the counter reads before a Comm Center is up (or while power is out). */
export const UNKNOWN_COUNT = 'UNKNOWN';

/** Living Order structures, including ones under construction or being sold. */
export function enemyStructureCount(state: Pick<GameState, 'buildings'>): number {
  let n = 0;
  for (const b of state.buildings) {
    if (b.dead || b.player !== PLAYER_AI) continue;
    n++;
  }
  return n;
}

/**
 * Headline. Once the mission is decided this matches the result curtain's
 * wording exactly, so the two never disagree.
 */
export function objectiveHeadline(state: Pick<GameState, 'result'>): string {
  if (state.result === 'won') return 'MISSION ACCOMPLISHED';
  if (state.result === 'lost') return 'MISSION FAILED';
  return OBJECTIVE_LINE;
}

/**
 * Counter line. The number is radar intelligence: without `players[0].radar`
 * (a standing, powered Comm Center) the player is told only that it is unknown,
 * which is the reason the briefing tells them to build one.
 */
export function objectiveCounter(
  state: Pick<GameState, 'buildings' | 'players'>,
): string {
  const known = state.players[PLAYER_HUMAN].radar;
  return `ENEMY STRUCTURES: ${known ? enemyStructureCount(state) : UNKNOWN_COUNT}`;
}

// ---------------------------------------------------------------------------
// Help overlay
// ---------------------------------------------------------------------------

export type HelpRow = readonly [keys: string, what: string];

export const HELP_TITLE = 'FIELD MANUAL';
export const HELP_FOOTER = 'PRESS [H] [F1] [ESC] OR CLICK TO CLOSE';

/** Two columns of bindings, drawn side by side. */
export const HELP_COLUMNS: readonly (readonly HelpRow[])[] = [
  [
    ['LEFT DRAG', 'BOX SELECT UNITS'],
    ['LEFT CLICK', 'SELECT ONE'],
    ['RIGHT CLICK', 'MOVE / ATTACK'],
    ['SHIFT + ORDER', 'QUEUE ORDERS'],
    ['A + CLICK', 'ATTACK MOVE'],
    ['CTRL + 1..9', 'SET CONTROL GROUP'],
    ['1..9', 'RECALL GROUP'],
    ['S', 'STOP / SELL STRUCTURE'],
    ['Z / X / C', 'STANCE EXPLORE/DEF/OFF'],
  ],
  [
    ['ARROWS / EDGE', 'PAN CAMERA'],
    ['MINIMAP CLICK', 'JUMP CAMERA (RADAR)'],
    ['MINIMAP DRAG', 'SCRUB CAMERA (RADAR)'],
    ['O', 'TOGGLE OBJECTIVES'],
    ['H / F1', 'THIS SCREEN'],
    ['M', 'MUTE AUDIO'],
    ['F', 'DEBUG OVERLAY'],
    ['GUNSHIPS', 'FLY ANYWHERE, REARM AT PAD'],
    ['ENGINEERS', 'RIGHT CLICK ENEMY BUILDING'],
    ['R', 'RESTART (AFTER DEFEAT)'],
  ],
];

/** Ticks the one-time hint stays up on its own (20 Hz -> 5 seconds). */
export const HELP_HINT_TICKS = 100;

const COL = {
  panel: 'rgba(9, 12, 7, 0.86)',
  overlay: 'rgba(4, 6, 3, 0.80)',
  edge: '#3c4630',
  gold: '#e0b53c',
  text: '#c8d69a',
  dim: '#6f7a52',
  bright: '#e6f2b8',
  green: '#8dff6a',
  red: '#ff5a48',
} as const;

export class Hud {
  private readonly camera: Camera;
  private readonly storage: StorageLike | null;

  /** Is the controls overlay on screen? */
  helpVisible = false;
  /** True while it is up as the one-time hint rather than by a keypress. */
  helpAuto = false;
  /** Objectives readout collapsed to a single tab (persisted). */
  objectivesCollapsed: boolean;

  private hintTicks = 0;
  /** Render-rate counter, for blinking. Never the sim clock. */
  private frame = 0;

  constructor(camera: Camera, storage: StorageLike | null = defaultHudStorage()) {
    this.camera = camera;
    this.storage = storage;
    this.objectivesCollapsed = loadFlag(storage, OBJECTIVES_KEY, false);
  }

  // --- state ---------------------------------------------------------------

  setHelp(on: boolean): boolean {
    this.helpVisible = on;
    this.helpAuto = false;
    this.hintTicks = 0;
    return this.helpVisible;
  }

  toggleHelp(): boolean {
    return this.setHelp(!this.helpVisible);
  }

  /** `true` = panel expanded. Persisted immediately. */
  setObjectives(open: boolean): boolean {
    this.objectivesCollapsed = !open;
    saveFlag(this.storage, OBJECTIVES_KEY, this.objectivesCollapsed);
    return !this.objectivesCollapsed;
  }

  toggleObjectives(): boolean {
    return this.setObjectives(this.objectivesCollapsed);
  }

  /**
   * A mission just started (deploy from the briefing, or any restart). Closes a
   * hand-opened overlay, and the very first time ever — tracked in
   * localStorage — shows the controls as a hint.
   *
   * The hint is deliberately the *non-modal* variant: it swallows nothing, and
   * the first input of any kind dismisses it (5 s cap if the player just sits
   * there). Swallowing that first click would eat a real order, which is
   * exactly the annoyance this is supposed to avoid.
   */
  onMissionStart(): void {
    this.helpVisible = false;
    this.helpAuto = false;
    this.hintTicks = 0;
    if (loadFlag(this.storage, HELP_SEEN_KEY, false)) return;
    saveFlag(this.storage, HELP_SEEN_KEY, true);
    this.helpVisible = true;
    this.helpAuto = true;
  }

  // --- tick ----------------------------------------------------------------

  /**
   * Consume HUD input. Returns the snapshot the rest of the tick should see:
   * the keys this owns are always stripped, and while the overlay is open by
   * choice every pointer event is stripped too.
   */
  update(snap: InputSnapshot): InputSnapshot {
    const consumed: string[] = [];
    const toggle = snap.pressed.has('KeyH') || snap.pressed.has('F1');
    if (snap.pressed.has('KeyH')) consumed.push('KeyH');
    if (snap.pressed.has('F1')) consumed.push('F1');
    if (snap.pressed.has('KeyO')) {
      consumed.push('KeyO');
      this.toggleObjectives();
    }

    let swallowPointer = false;

    if (this.helpVisible && this.helpAuto) {
      this.hintTicks++;
      const anyInput =
        snap.pressed.size > 0 ||
        snap.clicks.length > 0 ||
        snap.dragBoxes.length > 0 ||
        snap.drag !== null;
      if (anyInput || this.hintTicks >= HELP_HINT_TICKS) {
        this.helpVisible = false;
        this.helpAuto = false;
      }
    } else if (this.helpVisible) {
      swallowPointer = true;
      if (snap.pressed.has('Escape')) {
        consumed.push('Escape');
        this.helpVisible = false;
      } else if (toggle || snap.clicks.length > 0 || snap.dragBoxes.length > 0) {
        this.helpVisible = false;
      }
    } else if (toggle) {
      this.helpVisible = true;
      this.helpAuto = false;
      this.hintTicks = 0;
    }

    if (consumed.length === 0 && !swallowPointer) return snap;

    let pressed: ReadonlySet<string> = snap.pressed;
    if (consumed.length > 0) {
      const next = new Set(snap.pressed);
      for (const code of consumed) next.delete(code);
      pressed = next;
    }
    return {
      ...snap,
      pressed,
      clicks: swallowPointer ? [] : snap.clicks,
      dragBoxes: swallowPointer ? [] : snap.dragBoxes,
      drag: swallowPointer ? null : snap.drag,
    };
  }

  // --- draw: objectives ----------------------------------------------------

  /**
   * Small readout in the top-left of the world view (never the sidebar). Drawn
   * under the result curtain, so when the mission is decided it dims along with
   * everything else instead of fighting the headline.
   */
  drawObjectives(ctx: CanvasRenderingContext2D, state: GameState): void {
    this.frame++;
    const viewW = this.camera.viewW;
    const scale = viewW >= 560 ? 2 : 1;
    const padX = 6 * scale;
    const padY = 4 * scale;
    const x = 10;
    const y = 10;

    if (this.objectivesCollapsed) {
      const w = measurePixelText(OBJECTIVES_COLLAPSED_LINE, scale) + padX * 2;
      const h = 7 * scale + padY * 2;
      this.plate(ctx, x, y, w, h, COL.edge);
      drawPixelText(ctx, OBJECTIVES_COLLAPSED_LINE, x + padX, y + padY, scale, COL.dim);
      return;
    }

    const head = objectiveHeadline(state);
    const counter = objectiveCounter(state);
    const w =
      Math.max(measurePixelText(head, scale), measurePixelText(counter, scale)) + padX * 2;
    const h = 7 * scale * 2 + 4 * scale + padY * 2;
    const decided = state.result !== 'playing';
    const accent = decided ? (state.result === 'won' ? COL.green : COL.red) : COL.gold;

    this.plate(ctx, x, y, w, h, accent);
    drawPixelText(ctx, head, x + padX, y + padY, scale, decided ? accent : COL.bright);
    drawPixelText(
      ctx,
      counter,
      x + padX,
      y + padY + 7 * scale + 4 * scale,
      scale,
      state.players[PLAYER_HUMAN].radar ? COL.text : COL.dim,
    );
  }

  /** Semi-transparent backing plate with a hard edge and a lit left rail. */
  private plate(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    accent: string,
  ): void {
    ctx.fillStyle = COL.panel;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COL.edge;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, 2, h);
  }

  // --- draw: help ----------------------------------------------------------

  /**
   * Controls overlay, centred on the world view. Drawn last of all — over the
   * sidebar and over the result curtain — because it is the one thing that must
   * stay readable whatever else is on screen.
   */
  drawHelp(ctx: CanvasRenderingContext2D): void {
    if (!this.helpVisible) return;
    const cam = this.camera;
    const cw = cam.canvasW;
    const ch = cam.canvasH;

    ctx.fillStyle = COL.overlay;
    ctx.fillRect(0, 0, cw, ch);

    const keyW = 108;
    const gap = 24;
    const colW = 300;
    const headH = 46;
    const footH = 30;

    // Two columns when there is room for both; a narrow window gets one tall
    // column instead of overlapping text.
    const twoCol = cw - 24 - 48 - gap >= colW * 2;
    const columns: readonly (readonly HelpRow[])[] = twoCol
      ? HELP_COLUMNS
      : [HELP_COLUMNS.flat()];
    const rows = Math.max(...columns.map((c) => c.length));

    const boxW = Math.min(cw - 24, colW * columns.length + gap * (columns.length - 1) + 48);
    const boxH = Math.min(ch - 24, headH + rows * 19 + footH);
    const rowH = Math.min(19, Math.max(9, (boxH - headH - footH) / Math.max(1, rows)));
    const bx = Math.round(Math.max(12, (cam.viewW - boxW) / 2));
    const by = Math.round(Math.max(12, (ch - boxH) / 2));

    ctx.fillStyle = COL.panel;
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = COL.edge;
    ctx.lineWidth = 2;
    ctx.strokeRect(bx + 1, by + 1, boxW - 2, boxH - 2);
    ctx.fillStyle = COL.gold;
    ctx.fillRect(bx + 1, by + 1, boxW - 2, 2);

    const titleW = measurePixelText(HELP_TITLE, 3);
    drawPixelText(ctx, HELP_TITLE, Math.round(bx + (boxW - titleW) / 2), by + 14, 3, COL.gold);
    ctx.fillStyle = COL.edge;
    ctx.fillRect(bx + 16, by + headH - 10, boxW - 32, 1);

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const usableW = boxW - 48;
    const eachW = Math.min(colW, (usableW - gap * (columns.length - 1)) / columns.length);
    for (let c = 0; c < columns.length; c++) {
      const column = columns[c] as readonly HelpRow[];
      const cx = bx + 24 + c * (eachW + gap);
      for (let r = 0; r < column.length; r++) {
        const row = column[r] as HelpRow;
        const ry = by + headH + r * rowH;
        ctx.font = 'bold 11px "Courier New", monospace';
        ctx.fillStyle = COL.gold;
        ctx.fillText(row[0], cx, ry);
        ctx.font = '11px "Courier New", monospace';
        ctx.fillStyle = COL.text;
        ctx.fillText(row[1], cx + keyW, ry);
      }
    }

    // Blinking footer, off the render counter (the sim is not paused here).
    if (Math.floor(this.frame / 20) % 2 === 0) {
      ctx.font = '11px "Courier New", monospace';
      ctx.fillStyle = COL.bright;
      ctx.textAlign = 'center';
      ctx.fillText(HELP_FOOTER, Math.round(bx + boxW / 2), by + boxH - 20);
      ctx.textAlign = 'left';
    }
  }
}
