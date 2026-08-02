/**
 * Post-match debriefing (post-release).
 *
 * Replaces the Phase 5 flat result curtain with a C&C-style score screen: the
 * headline, the mission's identity (map / sector / difficulty / elapsed time),
 * a two-column YOU-vs-ORDER stat table that counts itself up over ~1.5s, and
 * the two ways out (R or click to replay the same sector, T back to the title).
 *
 * Discipline, exactly like `render/title.ts` and `render/briefing.ts`:
 *
 *   - **render-side only.** It reads `state.stats` and `state.result` and never
 *     writes a byte of `GameState`. The counters themselves are maintained by
 *     the systems inside `tick()` (see `game/state.ts`, `PlayerStats`).
 *   - **its own frame counter.** The count-up runs off `this.frame`, not
 *     `state.tick`, for the same reason the briefing typewriter does: the sim
 *     keeps ticking under the panel and its clock is not a display clock.
 *     `reset()` is called from `main.ts`'s `restart()` alongside the other
 *     render-side caches.
 */

import { TICK_MS } from '../game/constants';
import type { GameResult, GameState, PlayerStats } from '../game/state';
import { drawPixelText, measurePixelText } from './sprites';
import { sectorCode } from './title';

// --- tunables ---------------------------------------------------------------

/** Frames the count-up takes (~1.5s at 60fps). Render frames, never ticks. */
export const COUNT_FRAMES = 90;
/** How many audible ticks the count-up emits on its way up. */
export const BEEP_STEPS = 8;

export const RESTART_PROMPT = 'PRESS R OR CLICK TO RESTART - SAME SECTOR';
export const TITLE_PROMPT = 'T - RETURN TO COMMAND';

/**
 * V3: the same panel, different way out. In the conquest campaign a decided
 * mission returns to the territory map rather than replaying itself, so the
 * headline prompt says what the click actually does; R still replays the same
 * territory immediately and T still goes to the title.
 */
export const CAMPAIGN_WON_PROMPT = 'TERRITORY SECURED - CLICK TO CONTINUE';
export const CAMPAIGN_LOST_PROMPT = 'ASSAULT REPULSED - CLICK TO WITHDRAW';
/** After a loss the fight can be taken again; after a win there is nothing to retry. */
export const CAMPAIGN_RETRY_PROMPT = 'R - RETRY THIS TERRITORY   T - COMMAND';
export const CAMPAIGN_ADVANCE_PROMPT = 'T - RETURN TO COMMAND';

/**
 * C3: the same idea again for the chrono campaign. A won moment is *secured*
 * and the click takes you back to the timeline; a lost one is an insertion that
 * failed, and R travels to the same moment again.
 */
export const CHRONO_WON_PROMPT = 'MOMENT SECURED - CLICK TO CONTINUE';
export const CHRONO_LOST_PROMPT = 'INSERTION FAILED - CLICK TO WITHDRAW';
export const CHRONO_RETRY_PROMPT = 'R - RETRY THIS MOMENT   T - COMMAND';
export const CHRONO_ADVANCE_PROMPT = 'T - RETURN TO COMMAND';

const COL = {
  wash: 'rgba(4, 6, 3, 0.78)',
  panel: 'rgba(9, 12, 7, 0.94)',
  edge: '#3c4630',
  won: '#8dff6a',
  lost: '#ff5a48',
  wonShadow: '#1d4a12',
  lostShadow: '#5a1a12',
  head: '#e0b53c',
  label: '#c8d69a',
  dim: '#6f7a52',
  bright: '#e6f2b8',
  you: '#e0b53c',
  order: '#c8402c',
} as const;

// --- content ----------------------------------------------------------------

export interface DebriefRow {
  label: string;
  you: number;
  order: number;
}

/** Mission clock as MM:SS, from the sim's tick count at `TICK_MS`. */
export function missionTime(tick: number): string {
  const secs = Math.max(0, Math.floor((tick * TICK_MS) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

/**
 * The table. `STRUCTURES SOLD` only appears when the human actually sold
 * something — it is an emergency move, not a headline stat, and an all-zero row
 * is noise. When it does appear it shows both columns (the AI sells too, in its
 * critical-rebuild path).
 */
export function debriefRows(stats: readonly [PlayerStats, PlayerStats]): DebriefRow[] {
  const [you, order] = stats;
  const rows: DebriefRow[] = [
    { label: 'UNITS BUILT', you: you.unitsProduced, order: order.unitsProduced },
    { label: 'UNITS LOST', you: you.unitsLost, order: order.unitsLost },
    { label: 'ENEMIES DESTROYED', you: you.unitsKilled, order: order.unitsKilled },
    { label: 'STRUCTURES BUILT', you: you.buildingsBuilt, order: order.buildingsBuilt },
    { label: 'STRUCTURES LOST', you: you.buildingsLost, order: order.buildingsLost },
    { label: 'STRUCTURES RAZED', you: you.buildingsRazed, order: order.buildingsRazed },
    {
      label: 'STRUCTURES CAPTURED',
      you: you.buildingsCaptured,
      order: order.buildingsCaptured,
    },
  ];
  if (you.buildingsSold > 0) {
    rows.push({ label: 'STRUCTURES SOLD', you: you.buildingsSold, order: order.buildingsSold });
  }
  rows.push({
    label: 'CREDITS HARVESTED',
    you: you.creditsHarvested,
    order: order.creditsHarvested,
  });
  return rows;
}

export function headlineFor(result: GameResult): string {
  return result === 'won' ? 'MISSION ACCOMPLISHED' : 'MISSION FAILED';
}

/** `MAP ALPHA - SECTOR 0163   NORMAL   TIME 11:06`. */
export function missionLine(info: DebriefInfo, tick: number): string {
  return (
    `${info.kind ?? 'MAP'} ${info.mapLabel} - SECTOR ${sectorCode(info.seed)}   ` +
    `${info.difficulty.toUpperCase()}   TIME ${missionTime(tick)}`
  );
}

export interface DebriefInfo {
  mapLabel: string;
  seed: number;
  difficulty: string;
  /**
   * V3: the word before the label. 'MAP' (the default, and every skirmish) or
   * 'TERRITORY' for a conquest battle.
   */
  kind?: string;
  /** V3: set for a conquest battle. Its presence is what swaps the prompts. */
  campaign?: boolean;
  /** C3: set for a chrono battle. Mutually exclusive with `campaign`. */
  chrono?: boolean;
}

/**
 * The two lines at the foot of the panel. Pure, and the only place the wording
 * is decided — `debriefLayout` sizes the panel from exactly what `draw` writes.
 * A skirmish gets byte-identical strings (and therefore byte-identical
 * geometry) whatever the two campaign flags do.
 */
export function debriefPrompts(info: DebriefInfo, result: GameResult): [string, string] {
  if (info.chrono) {
    return result === 'won'
      ? [CHRONO_WON_PROMPT, CHRONO_ADVANCE_PROMPT]
      : [CHRONO_LOST_PROMPT, CHRONO_RETRY_PROMPT];
  }
  if (!info.campaign) return [RESTART_PROMPT, TITLE_PROMPT];
  return result === 'won'
    ? [CAMPAIGN_WON_PROMPT, CAMPAIGN_ADVANCE_PROMPT]
    : [CAMPAIGN_LOST_PROMPT, CAMPAIGN_RETRY_PROMPT];
}

// --- layout -----------------------------------------------------------------

export interface DebriefLayout {
  scale: number;
  headScale: number;
  infoScale: number;
  promptScale: number;
  panelX: number;
  panelY: number;
  panelW: number;
  panelH: number;
  titleY: number;
  infoY: number;
  ruleY: number;
  headerY: number;
  firstRowY: number;
  rowH: number;
  labelX: number;
  /** Right edges of the two number columns. */
  col1R: number;
  col2R: number;
  numW: number;
  footY: number;
  foot2Y: number;
  rows: DebriefRow[];
  /** The two foot prompts this panel was sized for (see `debriefPrompts`). */
  prompts: [string, string];
}

/** Widest rendered value in a column set, in font pixels at scale 1. */
function widestNumber(rows: readonly DebriefRow[]): number {
  let n = measurePixelText('ORDER', 1);
  for (const r of rows) {
    n = Math.max(n, measurePixelText(String(r.you), 1), measurePixelText(String(r.order), 1));
  }
  return n;
}

/**
 * Geometry for a window. Pure, so the headless render smoke can assert that
 * nothing overlaps and nothing goes negative at any size.
 */
export function debriefLayout(
  w: number,
  h: number,
  rows: DebriefRow[],
  info: DebriefInfo,
  result: GameResult,
  tick: number,
): DebriefLayout {
  const title = headlineFor(result);
  const line = missionLine(info, tick);
  const prompts = debriefPrompts(info, result);
  const num1 = widestNumber(rows);
  let label1 = 0;
  for (const r of rows) label1 = Math.max(label1, measurePixelText(r.label, 1));

  // Try the chunkiest scale that fits both axes, then fall back.
  // The headline, the mission line and the two prompts each get the biggest
  // scale *they* fit at, capped by the table's — so a narrow window shrinks the
  // 41-character restart prompt rather than the numbers the screen is about.
  const fit = (text: string, cap: number): number =>
    Math.max(1, Math.min(cap, Math.floor((w - 32) / Math.max(1, measurePixelText(text, 1)))));

  let scale = 1;
  let headScale = 1;
  let infoScale = 1;
  let promptScale = 1;
  let contentW = 0;
  let contentH = 0;
  for (let s = 3; s >= 1; s--) {
    const hs = fit(title, s * 2);
    const is = fit(line, Math.max(1, s - 1));
    const ps = Math.min(fit(prompts[0], s), fit(prompts[1], s));
    const colGap = s * 8;
    const tableW = label1 * s + colGap + num1 * s + colGap + num1 * s;
    const cw = Math.max(
      tableW,
      measurePixelText(title, hs),
      measurePixelText(line, is),
      measurePixelText(prompts[0], ps),
      measurePixelText(prompts[1], ps),
    );
    const ch =
      hs * 10 + is * 11 + s * 8 + s * 11 + rows.length * s * 9 + s * 8 + ps * 11 + ps * 9;
    if (s === 1 || (cw <= w - 32 && ch <= h - 32)) {
      scale = s;
      headScale = hs;
      infoScale = is;
      promptScale = ps;
      contentW = cw;
      contentH = ch;
      break;
    }
  }

  const padX = 10 * scale;
  const padY = 8 * scale;
  const panelW = Math.max(1, Math.min(w - 12, contentW + padX * 2));
  const panelH = Math.max(1, Math.min(h - 12, contentH + padY * 2));
  const panelX = Math.round((w - panelW) / 2);
  const panelY = Math.round(Math.max(6, (h - panelH) / 2));

  // The table is centred as a *block* rather than spanning the panel: the
  // headline sets the panel width, and stretching the two number columns out to
  // the far edge would leave a lake of dead space between a label and its
  // figure. Labels are left-aligned inside the block, numbers right-aligned in
  // their column.
  const colGap = scale * 8;
  const numW = num1 * scale;
  const labelW = label1 * scale;
  const tableW = labelW + colGap + numW + colGap + numW;
  const x0 = Math.max(panelX + padX, panelX + Math.round((panelW - tableW) / 2));
  const col1R = x0 + labelW + colGap + numW;
  const col2R = col1R + colGap + numW;

  const titleY = panelY + padY;
  const infoY = titleY + headScale * 10;
  const ruleY = infoY + infoScale * 11;
  const headerY = ruleY + scale * 8;
  const firstRowY = headerY + scale * 11;
  const rowH = scale * 9;
  const footY = firstRowY + rows.length * rowH + scale * 8;
  const foot2Y = footY + promptScale * 11;

  return {
    scale,
    headScale,
    infoScale,
    promptScale,
    panelX,
    panelY,
    panelW,
    panelH,
    titleY,
    infoY,
    ruleY,
    headerY,
    firstRowY,
    rowH,
    labelX: x0,
    col1R,
    col2R,
    numW,
    footY,
    foot2Y,
    rows,
    prompts,
  };
}

/**
 * Eased count-up fraction. Ease-out so the numbers snap most of the way up
 * quickly and settle, which is what makes a C&C tally feel mechanical rather
 * than linear. Exactly 1 at the end, so the final figures are the real ones.
 */
export function countProgress(frame: number): number {
  const t = Math.max(0, Math.min(1, frame / COUNT_FRAMES));
  return 1 - (1 - t) * (1 - t);
}

// --- screen -----------------------------------------------------------------

export class DebriefScreen {
  /** Render-rate counter — never the sim clock. */
  private frame = 0;
  /** Audible ticks already handed to the audio consumer. */
  private beeps = 0;

  /** Rewind for a fresh mission (called from `restart()`). */
  reset(): void {
    this.frame = 0;
    this.beeps = 0;
  }

  /** 0..1 count-up progress this frame. */
  get progress(): number {
    return countProgress(this.frame);
  }

  get complete(): boolean {
    return this.frame >= COUNT_FRAMES;
  }

  /**
   * Has the tally crossed another audible step since the last call? `main.ts`
   * polls this from `render()` and plays the existing click sting, so nothing
   * here imports the audio module (the sidebar/EVA contract, unchanged).
   */
  takeBeep(): boolean {
    const wanted = Math.min(BEEP_STEPS, Math.floor(this.progress * BEEP_STEPS));
    if (this.beeps >= wanted) return false;
    this.beeps++;
    return true;
  }

  /** Value shown for a counter this frame. */
  private shown(value: number): number {
    return Math.round(value * this.progress);
  }

  draw(ctx: CanvasRenderingContext2D, state: GameState, info: DebriefInfo, w: number, h: number): void {
    if (state.result === 'playing') return;
    this.frame++;

    const won = state.result === 'won';
    const rows = debriefRows(state.stats);
    const l = debriefLayout(w, h, rows, info, state.result, state.tick);

    // Wash the battlefield down, then scanline it: the same CRT treatment the
    // title and briefing use, so the three screens read as one system.
    ctx.fillStyle = COL.wash;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 2);

    ctx.fillStyle = COL.panel;
    ctx.fillRect(l.panelX, l.panelY, l.panelW, l.panelH);
    ctx.strokeStyle = COL.edge;
    ctx.lineWidth = 2;
    ctx.strokeRect(l.panelX + 1, l.panelY + 1, Math.max(0, l.panelW - 2), Math.max(0, l.panelH - 2));
    ctx.fillStyle = won ? COL.won : COL.lost;
    ctx.fillRect(l.panelX + 1, l.panelY + 1, Math.max(0, l.panelW - 2), 2);

    // Headline, centred, with the blocky drop shadow the old curtain had.
    const title = headlineFor(state.result);
    const titleW = measurePixelText(title, l.headScale);
    const titleX = Math.round(l.panelX + (l.panelW - titleW) / 2);
    drawPixelText(ctx, title, titleX + l.headScale, l.titleY + l.headScale, l.headScale, won ? COL.wonShadow : COL.lostShadow);
    drawPixelText(ctx, title, titleX, l.titleY, l.headScale, won ? COL.won : COL.lost);

    // Mission identity: map, sector, difficulty, elapsed time.
    const line = missionLine(info, state.tick);
    const lineW = measurePixelText(line, l.infoScale);
    drawPixelText(
      ctx,
      line,
      Math.round(l.panelX + (l.panelW - lineW) / 2),
      l.infoY,
      l.infoScale,
      COL.dim,
    );

    const ruleX = l.panelX + l.scale * 10;
    const ruleW = Math.max(0, l.panelW - l.scale * 20);
    ctx.fillStyle = COL.edge;
    ctx.fillRect(ruleX, l.ruleY, ruleW, Math.max(1, l.scale));

    // Column headers.
    const right = (text: string, r: number, y: number, color: string, scale: number): void => {
      drawPixelText(ctx, text, r - measurePixelText(text, scale), y, scale, color);
    };
    right('YOU', l.col1R, l.headerY, COL.you, l.scale);
    right('ORDER', l.col2R, l.headerY, COL.order, l.scale);

    // The table, counting up.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as DebriefRow;
      const y = l.firstRowY + i * l.rowH;
      drawPixelText(ctx, row.label, l.labelX, y, l.scale, COL.label);
      right(String(this.shown(row.you)), l.col1R, y, COL.bright, l.scale);
      right(String(this.shown(row.order)), l.col2R, y, COL.dim, l.scale);
    }

    ctx.fillStyle = COL.edge;
    ctx.fillRect(ruleX, l.footY - l.scale * 5, ruleW, Math.max(1, l.scale));

    // Prompts: the restart line blinks once the tally has finished, so the
    // player's eye lands on the numbers first.
    const blink = !this.complete || Math.floor(this.frame / 20) % 2 === 0;
    if (blink) {
      const pw = measurePixelText(l.prompts[0], l.promptScale);
      drawPixelText(
        ctx,
        l.prompts[0],
        Math.round(l.panelX + (l.panelW - pw) / 2),
        l.footY,
        l.promptScale,
        COL.bright,
      );
    }
    const tw = measurePixelText(l.prompts[1], l.promptScale);
    drawPixelText(
      ctx,
      l.prompts[1],
      Math.round(l.panelX + (l.panelW - tw) / 2),
      l.foot2Y,
      l.promptScale,
      COL.head,
    );
  }
}
