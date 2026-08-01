/**
 * Mission briefing (post-release).
 *
 * The screen between the title and the mission: a C&C-style battle-control
 * briefing on a dark CRT panel, typed out a few characters per rendered frame.
 *
 * Like the title screen this is *render-side only*. While `phase === 'briefing'`
 * `main.ts` returns from the tick before every system runs, so `state.tick`
 * never advances and the sim is genuinely frozen; the typewriter is driven by
 * this class's own frame counter, exactly like the title's drifting backdrop.
 *
 * Input contract (the tick returns immediately after calling `update`, so the
 * briefing swallows everything it sees — no click can leak into box-select):
 *   - click / Enter / Space while typing   -> `{ kind: 'reveal' }`, full text
 *   - click / Enter / Space when complete  -> `{ kind: 'start' }`, deploy
 */

import type { InputSnapshot } from '../engine/input';
import { drawPixelText, measurePixelText } from './sprites';
import { DEFAULT_MAP, mapDef, sectorCode, type BriefingAction } from './title';

/** `MAP ALPHA - SECTOR 0163`. Uppercase + `-` only: 5x7 bitmap font. */
export function missionTag(label: string, seed: number): string {
  return `MAP ${label} - SECTOR ${sectorCode(seed)}`;
}

/** How a line is drawn. Only `text` characters are typed out. */
export type BriefingLineKind = 'head' | 'sub' | 'rule' | 'gap' | 'label' | 'body' | 'bullet';

export interface BriefingLine {
  kind: BriefingLineKind;
  text: string;
}

const L = (kind: BriefingLineKind, text = ''): BriefingLine => ({ kind, text });

/**
 * The briefing copy. Uppercase and punctuation-limited on purpose: everything
 * here is drawn with the 5x7 bitmap font from `sprites.ts`.
 */
export const BRIEFING_LINES: readonly BriefingLine[] = [
  L('head', 'OPERATION CRYSTAL DAWN'),
  L('sub', 'BATTLE CONTROL BRIEFING'),
  L('rule'),
  L('label', 'SITUATION'),
  L('body', 'THE ORDER HAS FORTIFIED A BASE IN THE FAR CORNER OF'),
  L('body', 'THIS SECTOR. THEIR HARVESTERS ARE ALREADY STRIPPING'),
  L('body', 'THE CRYSTAL FIELDS, AND THEIR ARMOUR IS COMING.'),
  L('gap'),
  L('label', 'OBJECTIVE'),
  L('body', 'DESTROY ALL ORDER STRUCTURES.'),
  L('gap'),
  L('label', 'DEFEAT'),
  L('body', 'YOU ARE DEFEATED IF YOU LOSE ALL PRODUCTION'),
  L('body', 'STRUCTURES AND CANNOT REBUILD.'),
  L('gap'),
  L('label', 'FIELD DIRECTIVES'),
  L('bullet', 'HARVEST CRYSTAL TO FUND PRODUCTION'),
  L('bullet', 'KEEP POWER ABOVE DRAIN - CONSTRUCTION SLOWS AND'),
  L('body', '  RADAR AND TOWERS FAIL WHEN IT DIPS'),
  L('bullet', 'BUILD A COMM CENTER FOR RADAR'),
  L('bullet', 'HELIPADS ARM GUNSHIPS - 6 ROCKETS, THEN REARM'),
  L('bullet', 'ENGINEERS CAPTURE ENEMY STRUCTURES - RIGHT CLICK'),
  L('bullet', 'SET UNIT STANCE WITH [Z] [X] [C]'),
  L('bullet', 'PRESS [H] IN THE FIELD FOR CONTROLS'),
];

/** Total typewriter characters. Rules and blank lines cost nothing. */
export const BRIEFING_CHARS = BRIEFING_LINES.reduce((n, l) => n + l.text.length, 0);

/** Characters revealed per rendered frame (~180/s at 60 fps). */
export const CHARS_PER_FRAME = 3;

export const BRIEFING_PROMPT = 'CLICK TO COMMENCE OPERATION';

const COL = {
  ink: '#0b0d07',
  panel: 'rgba(9, 12, 7, 0.90)',
  edge: '#3c4630',
  head: '#e0b53c',
  headShadow: '#5a4310',
  label: '#8dff6a',
  text: '#c8d69a',
  dim: '#6f7a52',
  bright: '#e6f2b8',
  bullet: '#e0b53c',
} as const;

/** Vertical advance of a line, in device px, for a given font scale. */
function lineHeight(kind: BriefingLineKind, scale: number): number {
  switch (kind) {
    case 'head':
      return scale * 12;
    case 'sub':
      return scale * 11;
    case 'rule':
      return scale * 7;
    case 'gap':
      return scale * 5;
    case 'label':
      return scale * 11;
    default:
      return scale * 9;
  }
}

export class BriefingScreen {
  /** Render-rate counter — never the sim clock. */
  private frame = 0;
  /** Characters of `BRIEFING_LINES` typed so far. */
  revealed = 0;
  /**
   * V2: which map this mission is on, shown in the panel header. It is *not*
   * part of `BRIEFING_LINES`, so it costs no typewriter characters and
   * `BRIEFING_CHARS` is unaffected — it appears immediately, like the panel
   * chrome. `main.ts` sets it whenever the title resolves a seed.
   */
  mission = missionTag(mapDef(DEFAULT_MAP).label, mapDef(DEFAULT_MAP).seed);

  /** Header tag for a mission: `MAP ALPHA - SECTOR 0163`. */
  setMission(label: string, seed: number): void {
    this.mission = missionTag(label, seed);
  }

  /** Has the whole briefing been typed out? */
  get complete(): boolean {
    return this.revealed >= BRIEFING_CHARS;
  }

  /** Back to an empty screen (entering the briefing, or a phase jump). */
  reset(): void {
    this.frame = 0;
    this.revealed = 0;
  }

  /** Type `chars` more characters. Returns the new revealed count. */
  advance(chars: number = CHARS_PER_FRAME): number {
    this.revealed = Math.min(BRIEFING_CHARS, Math.max(0, this.revealed + chars));
    return this.revealed;
  }

  /** Dump the rest of the text immediately. */
  skip(): void {
    this.revealed = BRIEFING_CHARS;
  }

  // --- tick ---------------------------------------------------------------

  /**
   * Consume a tick's input. The first click/Enter completes the text, the
   * second commences the operation.
   */
  update(snap: InputSnapshot): BriefingAction | null {
    const key =
      snap.pressed.has('Enter') ||
      snap.pressed.has('NumpadEnter') ||
      snap.pressed.has('Space');
    const clicked = snap.clicks.some((c) => c.button === 0);
    if (!key && !clicked) return null;
    if (!this.complete) {
      this.skip();
      return { kind: 'reveal' };
    }
    return { kind: 'start' };
  }

  // --- draw ---------------------------------------------------------------

  /** Font scale that fits the widest line, with room for the panel padding. */
  scale(w: number): number {
    let widest = 0;
    for (const line of BRIEFING_LINES) {
      widest = Math.max(widest, measurePixelText(line.text, 1));
    }
    widest = Math.max(widest, measurePixelText(BRIEFING_PROMPT, 1));
    return Math.max(1, Math.min(3, Math.floor((w - 96) / Math.max(1, widest))));
  }

  draw(
    ctx: CanvasRenderingContext2D,
    terrain: HTMLCanvasElement | null,
    w: number,
    h: number,
  ): void {
    this.frame++;
    if (!this.complete) this.advance();

    this.drawBackdrop(ctx, terrain, w, h);

    const scale = this.scale(w);
    const padX = 10 * scale;
    const padY = 8 * scale;

    let contentW = 0;
    let contentH = 0;
    for (const line of BRIEFING_LINES) {
      contentW = Math.max(contentW, measurePixelText(line.text, scale));
      contentH += lineHeight(line.kind, scale);
    }
    contentW = Math.max(contentW, measurePixelText(BRIEFING_PROMPT, scale));
    const promptH = scale * 16;

    const panelW = Math.min(w - 16, contentW + padX * 2);
    const panelH = Math.min(h - 16, contentH + promptH + padY * 2);
    const px = Math.round((w - panelW) / 2);
    const py = Math.round(Math.max(8, (h - panelH) / 2));

    // Panel: CRT glass with a hard edge and a lit top rail.
    ctx.fillStyle = COL.panel;
    ctx.fillRect(px, py, panelW, panelH);
    ctx.strokeStyle = COL.edge;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, panelW - 2, panelH - 2);
    ctx.fillStyle = COL.head;
    ctx.fillRect(px + 1, py + 1, panelW - 2, 2);

    // Mission tag, right-aligned on the header line. Drawn before the
    // typewriter so it is on screen from the first frame.
    {
      const ts = Math.max(1, scale - 1);
      const tw = measurePixelText(this.mission, ts);
      drawPixelText(
        ctx,
        this.mission,
        Math.max(px + padX, px + panelW - padX - tw),
        py + padY,
        ts,
        COL.dim,
      );
    }

    // Typewriter: walk the lines spending the revealed-character budget.
    let budget = this.revealed;
    let y = py + padY;
    const x0 = px + padX;

    for (const line of BRIEFING_LINES) {
      const adv = lineHeight(line.kind, scale);
      if (line.kind === 'rule') {
        ctx.fillStyle = COL.edge;
        ctx.fillRect(x0, y + scale * 2, panelW - padX * 2, Math.max(1, scale));
        y += adv;
        continue;
      }
      if (line.kind === 'gap' || line.text.length === 0) {
        y += adv;
        continue;
      }
      if (budget <= 0) break;

      const shown = Math.min(line.text.length, budget);
      const text = line.text.slice(0, shown);
      budget -= line.text.length;

      let tx = x0;
      let color: string = COL.text;
      if (line.kind === 'head') {
        color = COL.head;
        drawPixelText(ctx, text, tx + scale, y + scale, scale, COL.headShadow);
      } else if (line.kind === 'sub') {
        color = COL.dim;
      } else if (line.kind === 'label') {
        color = COL.label;
      } else if (line.kind === 'bullet') {
        // Chunky square bullet, then the text indented past it.
        ctx.fillStyle = COL.bullet;
        ctx.fillRect(tx, y + scale * 2, scale * 3, scale * 3);
        tx += scale * 6;
      }
      drawPixelText(ctx, text, tx, y, scale, color);

      // Caret sitting on the character being typed.
      if (shown < line.text.length && Math.floor(this.frame / 6) % 2 === 0) {
        ctx.fillStyle = COL.bright;
        ctx.fillRect(tx + measurePixelText(text, scale) + scale, y, scale * 5, scale * 7);
      }
      y += adv;
    }

    // Prompt: only once the whole briefing is on screen, and blinking.
    if (this.complete && Math.floor(this.frame / 20) % 2 === 0) {
      const pw = measurePixelText(BRIEFING_PROMPT, scale);
      const pxT = Math.round(px + (panelW - pw) / 2);
      const pyT = py + panelH - padY - scale * 8;
      ctx.fillStyle = 'rgba(60, 74, 38, 0.9)';
      ctx.fillRect(pxT - scale * 4, pyT - scale * 2, pw + scale * 8, scale * 11);
      drawPixelText(ctx, BRIEFING_PROMPT, pxT, pyT, scale, COL.bright);
    }

    ctx.fillStyle = COL.dim;
    ctx.font = '10px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(
      this.complete ? 'CLICK OR ENTER TO DEPLOY   M MUTE' : 'CLICK OR ENTER TO SKIP TEXT',
      Math.round(w / 2),
      h - 14,
    );
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  /** Same drifting map slice as the title, pushed further down in value. */
  private drawBackdrop(
    ctx: CanvasRenderingContext2D,
    terrain: HTMLCanvasElement | null,
    w: number,
    h: number,
  ): void {
    ctx.fillStyle = COL.ink;
    ctx.fillRect(0, 0, w, h);
    if (terrain && terrain.width > 0) {
      const drift = this.frame * 0.05;
      const maxX = Math.max(0, terrain.width - w);
      const maxY = Math.max(0, terrain.height - h);
      const sx = maxX > 0 ? (drift % maxX | 0) : 0;
      const sy = maxY > 0 ? ((drift * 0.6) % maxY | 0) : 0;
      const sw = Math.min(w, terrain.width - sx);
      const sh = Math.min(h, terrain.height - sy);
      if (sw > 0 && sh > 0) ctx.drawImage(terrain, sx, sy, sw, sh, 0, 0, sw, sh);
      ctx.fillStyle = 'rgba(6, 8, 4, 0.84)';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, w, 4);
    ctx.fillRect(0, h - 4, w, 4);
  }
}
