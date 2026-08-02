/**
 * Title screen (Phase 6).
 *
 * A two-state machine — 'title' -> 'playing' — driven entirely from `main.ts`.
 * While the phase is 'title' the tick returns before any system runs, so the
 * simulation is genuinely frozen (state.tick never advances) rather than being
 * ticked and hidden. Everything animated here is driven by a render-side frame
 * counter, so the backdrop still breathes while the sim is stopped.
 *
 * The art is procedural like the rest of the game: the composited terrain
 * layer, darkened and slowly drifting, under a chunky bitmap logotype.
 */

import type { InputSnapshot } from '../engine/input';
import type { AiDifficulty } from '../game/systems/ai';
import { drawPixelText, measurePixelText } from './sprites';

export type AppPhase = 'title' | 'campaign' | 'chrono' | 'briefing' | 'playing';

// ---------------------------------------------------------------------------
// Map selection (V2)
// ---------------------------------------------------------------------------

export type MapChoice = 'alpha' | 'bravo' | 'charlie' | 'delta' | 'random';

export interface MapDef {
  id: MapChoice;
  label: string;
  /** Curated seed, or 0 for RANDOM (rolled fresh at deploy). */
  seed: number;
}

/**
 * The four curated maps, plus RANDOM.
 *
 * The seeds were picked by generating several hundred maps headlessly and
 * choosing four that are valid (both start areas clear + reachable, six crystal
 * fields, a start-to-start path) *and* measurably different: rock/cliff cover
 * runs 10.7% -> 23.5% of the map across them, no two of them agree on more than
 * 53% of their tiles, and no two place their crystal fields within a mean 5.5
 * tiles of each other. See SPEC "V2: engineer capture & map variety".
 */
export const MAPS: readonly MapDef[] = [
  { id: 'alpha', label: 'ALPHA', seed: 355 },
  { id: 'bravo', label: 'BRAVO', seed: 187 },
  { id: 'charlie', label: 'CHARLIE', seed: 84 },
  { id: 'delta', label: 'DELTA', seed: 245 },
  { id: 'random', label: 'RANDOM', seed: 0 },
];

export const DEFAULT_MAP: MapChoice = 'alpha';

export function mapDef(id: MapChoice): MapDef {
  return (MAPS.find((m) => m.id === id) ?? MAPS[0]) as MapDef;
}

export function isMapChoice(v: string): v is MapChoice {
  return MAPS.some((m) => m.id === v);
}

/**
 * The sim's ONE sanctioned source of non-seeded entropy, and it lives here
 * deliberately: this is render-side title input handling, it runs before any
 * `GameState` exists, and its whole output is a *seed*. Everything downstream —
 * map generation, the AI, every system — is a pure function of that number, so
 * the simulation stays exactly as deterministic as it was. Nothing in
 * `src/game` may call this.
 */
export function rollMapSeed(): number {
  return (
    (Math.floor(Math.random() * 0xffffffff) ^ (Date.now() & 0xffffffff)) >>> 0
  );
}

/** Resolve a map choice to a concrete seed (rolling a fresh one for RANDOM). */
export function seedFor(id: MapChoice): number {
  const def = mapDef(id);
  return def.id === 'random' ? rollMapSeed() : def.seed;
}

/** Subtle sector tag for a seed, e.g. 0x7f3a -> "7F3A". Used by the briefing. */
export function sectorCode(seed: number): string {
  return (seed >>> 0).toString(16).toUpperCase().padStart(4, '0').slice(-4);
}

export type TitleAction =
  | { kind: 'difficulty'; level: AiDifficulty }
  /** Map row: the choice plus the seed it resolved to *now*. */
  | { kind: 'map'; map: MapChoice; seed: number }
  /** V3: leave the skirmish flow for the conquest campaign map. */
  | { kind: 'campaign' }
  /** C3: leave the skirmish flow for the chrono campaign's timeline map. */
  | { kind: 'chrono' }
  /** Deploy. Carries the seed the mission must be built from. */
  | { kind: 'start'; map: MapChoice; seed: number };

/** What the briefing screen can ask for (see `render/briefing.ts`). */
export type BriefingAction =
  /** First click/Enter while typing: dump the rest of the text immediately. */
  | { kind: 'reveal' }
  /** Click/Enter on fully-revealed text: commence the operation. */
  | { kind: 'start' };

/**
 * V3: what the conquest map can ask for (see `render/campaign.ts`). Declared
 * here beside `BriefingAction` for the same reason that one is: `nextPhase` is
 * the phase machine and it has to see every action kind that can move it.
 */
export type CampaignAction =
  /** Confirmed on the invade plate: fight for this territory. */
  | { kind: 'invade'; territory: string }
  /** Opened (or dismissed, with null) the invade plate. Self-transition. */
  | { kind: 'select'; territory: string | null }
  /** RESET CAMPAIGN, past its second confirmation. Self-transition. */
  | { kind: 'reset' }
  /** Back to the main menu. */
  | { kind: 'title' };

/**
 * C3: what the chrono timeline can ask for (see `render/chrono.ts`). Declared
 * here beside `CampaignAction` for the same reason that one is: `nextPhase` is
 * the phase machine and it has to see every action kind that can move it. The
 * two campaigns deliberately do **not** share an action type — `enter` and
 * `invade` are different verbs into different modes, and keeping them apart is
 * what makes `nextPhase` exhaustive without a mode flag.
 */
export type ChronoAction =
  /** Confirmed on the insertion plate: travel to this moment and fight it. */
  | { kind: 'enter'; moment: string }
  /** Opened (or dismissed, with null) the insertion plate. Self-transition. */
  | { kind: 'select'; moment: string | null }
  /** RESET TIMELINE, past its second confirmation. Self-transition. */
  | { kind: 'reset' }
  /** Back to the main menu. */
  | { kind: 'title' };

export type PhaseAction = TitleAction | BriefingAction | CampaignAction | ChronoAction;

/**
 * The whole phase machine. Pure, so it can be exercised headlessly.
 *
 * ```
 * title --start----> briefing --start--> playing      (skirmish)
 * title --campaign-> campaign --invade-> briefing --start--> playing
 * title --chrono---> chrono   --enter--> briefing --start--> playing
 * ```
 *
 * Every other action (picking a difficulty, skipping the typewriter, opening a
 * plate, wiping a save) leaves the phase where it is, and 'playing' is terminal
 * — leaving a mission is `restart()` or a jump back to one of the two campaign
 * maps from the debriefing, not a phase *action*. The two campaign phases are
 * siblings and neither can reach the other: the only way across is the title.
 */
export function nextPhase(phase: AppPhase, action: PhaseAction | null): AppPhase {
  if (action === null) return phase;
  if (phase === 'title') {
    if (action.kind === 'campaign') return 'campaign';
    if (action.kind === 'chrono') return 'chrono';
    return action.kind === 'start' ? 'briefing' : 'title';
  }
  if (phase === 'campaign') {
    if (action.kind === 'invade') return 'briefing';
    return action.kind === 'title' ? 'title' : 'campaign';
  }
  if (phase === 'chrono') {
    if (action.kind === 'enter') return 'briefing';
    return action.kind === 'title' ? 'title' : 'chrono';
  }
  if (phase === 'briefing') return action.kind === 'start' ? 'playing' : 'briefing';
  return phase;
}

export const DIFFICULTIES: readonly AiDifficulty[] = ['easy', 'normal', 'hard'];

export type TitleTarget = AiDifficulty | MapChoice | 'start' | 'campaign' | 'chrono';

export type TitleRow = 'difficulty' | 'map' | 'start' | 'campaign' | 'chrono';

interface Button {
  id: TitleTarget;
  row: TitleRow;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const COL = {
  ink: '#0b0d07',
  logo: '#e0b53c',
  logoShadow: '#5a4310',
  logoEdge: '#fff0b8',
  text: '#c8d69a',
  dim: '#6f7a52',
  bright: '#e6f2b8',
  panel: 'rgba(12, 15, 9, 0.82)',
  edge: '#3c4630',
  on: '#8dff6a',
  /** C3: the chrono plate reads teal, so the two campaigns are never confused. */
  chrono: '#4fd6e8',
  chronoEdge: '#c9f6ff',
} as const;

/** Vertical geometry of the menu block, shared by layout and drawing. */
const DIFF_H = 34;
const MAP_BTN_H = 26;
/** Gap between the difficulty row and the SELECT SECTOR label. */
const ROW_GAP = 28;
/** Gap between the map row and the deploy button. */
const START_GAP = 28;
const START_H = 42;
/**
 * V3: the conquest-campaign entry sits *below* the skirmish block, past the
 * sector tag, rather than being folded into it — the skirmish flow
 * (difficulty -> sector -> deploy) reads exactly as it did, and the second mode
 * is an alternative offered underneath it rather than a mode switch the player
 * has to make first.
 */
const CAMPAIGN_GAP = 22;
const CAMPAIGN_H = 28;
/**
 * C3: the chrono campaign is a *second* plate stacked directly under the
 * conquest one, close enough that the two read as one "campaigns" block rather
 * than as two unrelated offers. The skirmish block above them is unchanged in
 * order, geometry and behaviour; only `menuTop`'s reserved height moved.
 */
const CHRONO_GAP = 6;
const CHRONO_H = 28;
/**
 * Slack kept below the last plate so the footer hint (drawn at h - 18) can
 * never be crowded on a short window. 640x480 is the binding case.
 */
const MENU_FOOT = 40;

export class TitleScreen {
  difficulty: AiDifficulty = 'normal';
  /** Selected map. RANDOM re-rolls its seed on every deploy. */
  map: MapChoice = DEFAULT_MAP;
  /**
   * Seed the currently selected map resolved to. For a curated map this is the
   * map's own seed; for RANDOM it is the last roll, refreshed at deploy so two
   * consecutive RANDOM missions are two different maps.
   */
  seed: number = mapDef(DEFAULT_MAP).seed;
  /** Render-rate counter — never the sim clock. */
  private frame = 0;
  private hover: TitleTarget | null = null;

  // --- layout -------------------------------------------------------------

  /** Logo scale in device px per font pixel. "CRYSTAL" is the widest line. */
  private logoScale(w: number): number {
    return Math.max(3, Math.min(18, Math.floor((w * 0.62) / measurePixelText('CRYSTAL', 1))));
  }

  private menuTop(w: number, h: number): number {
    const scale = this.logoScale(w);
    // The block is DIFF_H + ROW_GAP + MAP_BTN_H + START_GAP + START_H tall, plus
    // the campaign row under it and the label above it; keep all of it on
    // screen on short windows.
    const block =
      DIFF_H +
      ROW_GAP +
      MAP_BTN_H +
      START_GAP +
      START_H +
      CAMPAIGN_GAP +
      CAMPAIGN_H +
      CHRONO_GAP +
      CHRONO_H +
      MENU_FOOT;
    // Never let the SELECT DIFFICULTY caption climb into the subtitle: the menu
    // starts below the logo block (drawLogo: top h*0.16, subtitle at +scale*18,
    // glyphs 8 rows tall at scale/4). On very short windows the on-screen clamp
    // still wins and the captions may kiss the subtitle rather than run off.
    const subBottom =
      Math.round(h * 0.16) + scale * 18 + Math.max(1, Math.floor(scale / 4)) * 8;
    return Math.max(
      70,
      Math.min(h - block, Math.max(subBottom + 30, Math.round(h * 0.26) + scale * 16)),
    );
  }

  buttons(w: number, h: number): Button[] {
    const bw = Math.max(88, Math.min(150, Math.floor(w / 7)));
    const gap = 12;
    const total = bw * 3 + gap * 2;
    const x0 = Math.round((w - total) / 2);
    const y = this.menuTop(w, h);
    const out: Button[] = DIFFICULTIES.map((level, i) => ({
      id: level,
      row: 'difficulty' as TitleRow,
      label: level.toUpperCase(),
      x: x0 + i * (bw + gap),
      y,
      w: bw,
      h: DIFF_H,
    }));

    // Map row: five buttons across exactly the same span as the difficulty row,
    // so the two read as one panel however wide the window is.
    const mapY = y + DIFF_H + ROW_GAP;
    const mgap = 6;
    const mw = Math.floor((total - mgap * (MAPS.length - 1)) / MAPS.length);
    const mtotal = mw * MAPS.length + mgap * (MAPS.length - 1);
    const mx0 = Math.round((w - mtotal) / 2);
    MAPS.forEach((m, i) => {
      out.push({
        id: m.id,
        row: 'map',
        label: m.label,
        x: mx0 + i * (mw + mgap),
        y: mapY,
        w: mw,
        h: MAP_BTN_H,
      });
    });

    const sw = Math.min(total, Math.max(200, bw * 2));
    const startY = mapY + MAP_BTN_H + START_GAP;
    out.push({
      id: 'start',
      row: 'start',
      label: 'CLICK TO DEPLOY',
      x: Math.round((w - sw) / 2),
      y: startY,
      w: sw,
      h: START_H,
    });
    const campaignY = startY + START_H + CAMPAIGN_GAP;
    out.push({
      id: 'campaign',
      row: 'campaign',
      label: '[C] CONQUEST CAMPAIGN',
      x: Math.round((w - sw) / 2),
      y: campaignY,
      w: sw,
      h: CAMPAIGN_H,
    });
    out.push({
      id: 'chrono',
      row: 'chrono',
      label: '[X] CHRONO CAMPAIGN',
      x: Math.round((w - sw) / 2),
      y: campaignY + CAMPAIGN_H + CHRONO_GAP,
      w: sw,
      h: CHRONO_H,
    });
    return out;
  }

  hitTest(w: number, h: number, x: number, y: number): TitleTarget | null {
    for (const b of this.buttons(w, h)) {
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return b.id;
    }
    return null;
  }

  /** Pick a map, resolving (and remembering) the seed it means right now. */
  selectMap(id: MapChoice): TitleAction {
    this.map = id;
    this.seed = seedFor(id);
    return { kind: 'map', map: id, seed: this.seed };
  }

  /**
   * Deploy. RANDOM re-rolls here, so every mission started from the title on
   * RANDOM is a *different* map — while a curated map always resolves to its
   * own fixed seed, and `restart()` (R after defeat) replays whatever this
   * returned rather than rolling again.
   */
  deploy(): TitleAction {
    this.seed = seedFor(this.map);
    return { kind: 'start', map: this.map, seed: this.seed };
  }

  /**
   * Resolve a click. Anything outside the buttons also deploys — the screen
   * says "click to deploy" and it should mean it.
   */
  handleClick(w: number, h: number, x: number, y: number): TitleAction {
    const hit = this.hitTest(w, h, x, y);
    if (hit === 'campaign') return { kind: 'campaign' };
    if (hit === 'chrono') return { kind: 'chrono' };
    if (hit !== null && hit !== 'start') {
      if (isMapChoice(hit)) return this.selectMap(hit);
      this.difficulty = hit as AiDifficulty;
      return { kind: 'difficulty', level: this.difficulty };
    }
    return this.deploy();
  }

  // --- tick ---------------------------------------------------------------

  /**
   * Consume a tick's input. Returns the action taken, or null. Keys: 1/2/3 pick
   * a difficulty, Enter/Space deploy. The map row is pointer-only.
   */
  update(snap: InputSnapshot, w: number, h: number): TitleAction | null {
    this.hover = this.hitTest(w, h, snap.pointer.x, snap.pointer.y);

    for (let i = 0; i < DIFFICULTIES.length; i++) {
      if (snap.pressed.has(`Digit${i + 1}`)) {
        const level = DIFFICULTIES[i] as AiDifficulty;
        this.difficulty = level;
        return { kind: 'difficulty', level };
      }
    }
    // V3: C opens the conquest campaign. Checked before Enter/Space so the
    // deploy keys keep meaning "deploy the skirmish", unchanged.
    if (snap.pressed.has('KeyC')) return { kind: 'campaign' };
    // C3: X opens the chrono campaign. Same placement rule as C — before the
    // deploy keys, so Enter/Space still mean "deploy the skirmish", unchanged.
    if (snap.pressed.has('KeyX')) return { kind: 'chrono' };
    if (snap.pressed.has('Enter') || snap.pressed.has('Space')) return this.deploy();

    for (const click of snap.clicks) {
      if (click.button !== 0) continue;
      return this.handleClick(w, h, click.x, click.y);
    }
    return null;
  }

  // --- draw ---------------------------------------------------------------

  draw(
    ctx: CanvasRenderingContext2D,
    terrain: HTMLCanvasElement | null,
    w: number,
    h: number,
  ): void {
    this.frame++;

    this.drawBackdrop(ctx, terrain, w, h);
    this.drawLogo(ctx, w, h);
    this.drawMenu(ctx, w, h);

    ctx.fillStyle = COL.dim;
    ctx.font = '10px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(
      '1/2/3 DIFFICULTY   CLICK SECTOR   ENTER DEPLOY   C CONQUEST   X CHRONO   M MUTE',
      Math.round(w / 2),
      h - 18,
    );
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  /** Slowly drifting slice of the real map, pushed way down in value. */
  private drawBackdrop(
    ctx: CanvasRenderingContext2D,
    terrain: HTMLCanvasElement | null,
    w: number,
    h: number,
  ): void {
    ctx.fillStyle = COL.ink;
    ctx.fillRect(0, 0, w, h);
    if (terrain && terrain.width > 0) {
      const drift = this.frame * 0.12;
      const maxX = Math.max(0, terrain.width - w);
      const maxY = Math.max(0, terrain.height - h);
      const sx = maxX > 0 ? (drift % maxX | 0) : 0;
      const sy = maxY > 0 ? ((drift * 0.6) % maxY | 0) : 0;
      const sw = Math.min(w, terrain.width - sx);
      const sh = Math.min(h, terrain.height - sy);
      if (sw > 0 && sh > 0) ctx.drawImage(terrain, sx, sy, sw, sh, 0, 0, sw, sh);
      ctx.fillStyle = 'rgba(6, 8, 4, 0.72)';
      ctx.fillRect(0, 0, w, h);
    }

    // Scanlines: cheap CRT flavour, and it hides the terrain tiling.
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 2);

    // Vignette rails top and bottom.
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, w, 4);
    ctx.fillRect(0, h - 4, w, 4);
  }

  private drawLogo(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const scale = this.logoScale(w);
    const top = Math.round(h * 0.16);
    const lines: [string, number][] = [
      ['CRYSTAL', top],
      ['DAWN', top + scale * 9],
    ];
    for (const [text, y] of lines) {
      const tw = measurePixelText(text, scale);
      const x = Math.round((w - tw) / 2);
      drawPixelText(ctx, text, x + scale, y + scale, scale, COL.logoShadow);
      drawPixelText(ctx, text, x, y, scale, COL.logo);
      // One-pixel top highlight, drawn by clipping the glyph to its first row.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, tw, scale);
      ctx.clip();
      drawPixelText(ctx, text, x, y, scale, COL.logoEdge);
      ctx.restore();
    }

    const sub = 'TIBERIAN-STYLE SKIRMISH';
    const ss = Math.max(1, Math.floor(scale / 4));
    const sw = measurePixelText(sub, ss);
    drawPixelText(ctx, sub, Math.round((w - sw) / 2), top + scale * 18, ss, COL.text);
  }

  private drawMenu(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const buttons = this.buttons(w, h);
    const ls = 2;

    const caption = (text: string, y: number): void => {
      drawPixelText(
        ctx,
        text,
        Math.round((w - measurePixelText(text, ls)) / 2),
        y,
        ls,
        COL.dim,
      );
    };
    caption('SELECT DIFFICULTY', this.menuTop(w, h) - 22);
    const mapRow = buttons.find((b) => b.row === 'map');
    if (mapRow) caption('SELECT SECTOR', mapRow.y - 20);

    for (const b of buttons) {
      const isStart = b.row === 'start';
      const isCampaign = b.row === 'campaign';
      const isChrono = b.row === 'chrono';
      const active =
        (b.row === 'difficulty' && b.id === this.difficulty) ||
        (b.row === 'map' && b.id === this.map);
      const hot = this.hover === b.id;
      const blink = isStart && Math.floor(this.frame / 22) % 2 === 0;

      ctx.fillStyle = active || (isStart && blink) ? 'rgba(60, 74, 38, 0.9)' : COL.panel;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = active
        ? COL.on
        : hot
          ? COL.bright
          : isCampaign
            ? COL.logo
            : isChrono
              ? COL.chrono
              : COL.edge;
      ctx.lineWidth = active || hot ? 2 : 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);

      // The map and campaign rows carry longer labels in narrower plates, so
      // they drop to a smaller face rather than overflowing.
      const scale =
        b.row === 'map' || isCampaign || isChrono
          ? measurePixelText(b.label, 2) + 8 <= b.w
            ? 2
            : 1
          : 2;
      const tw = measurePixelText(b.label, scale);
      const color = active
        ? COL.on
        : isCampaign
          ? hot
            ? COL.logoEdge
            : COL.logo
          : isChrono
            ? hot
              ? COL.chronoEdge
              : COL.chrono
            : isStart
              ? blink
                ? COL.bright
                : COL.text
              : hot
                ? COL.bright
                : COL.text;
      drawPixelText(
        ctx,
        b.label,
        Math.round(b.x + (b.w - tw) / 2),
        Math.round(b.y + (b.h - scale * 7) / 2),
        scale,
        color,
      );
    }

    // The chosen map's sector code, so the seed is visible before deploying.
    const start = buttons.find((b) => b.row === 'start');
    if (start) {
      const tag = `SECTOR ${sectorCode(this.seed)}`;
      drawPixelText(
        ctx,
        tag,
        Math.round((w - measurePixelText(tag, 1)) / 2),
        start.y + start.h + 10,
        1,
        COL.dim,
      );
    }
  }
}
