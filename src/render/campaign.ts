/**
 * Conquest campaign map (V3) — the screen between the title and the briefing.
 *
 * A stylised pixel-art continent: thirteen territories drawn from the polygons
 * authored in `game/campaign.ts`, gold for ground you hold, crimson for The
 * Order's, with a pulsing outline on everything you can reach from your own
 * border. Click one, confirm on the invade plate, and the ordinary
 * briefing -> mission path takes over.
 *
 * Same discipline as `title.ts` / `briefing.ts` / `debrief.ts`:
 *
 *   - **render-side only.** It reads a `CampaignState` and never a `GameState`;
 *     it mutates nothing but its own plate/confirm bookkeeping, and it hands
 *     every decision back to `main.ts` as a `CampaignAction`.
 *   - **its own frame counter.** The pulse runs off `this.frame`, never
 *     `state.tick` — while the phase is 'campaign' the sim is frozen exactly as
 *     it is on the title screen.
 *   - **layout is a pure function** (`campaignLayout`), so the headless render
 *     smoke can assert that nothing goes NaN or negative and that every
 *     territory hit-tests back to itself at any window size.
 */

import type { InputSnapshot } from '../engine/input';
import {
  HOME_TERRITORY,
  MAP_SPACE,
  TERRITORIES,
  TERRITORY_COUNT,
  attackable as attackableIds,
  canAttack,
  isOwned,
  ownedCount,
  recordFor,
  territory,
  tierOf,
  type CampaignBattleConfig,
  type CampaignState,
  type Territory,
} from '../game/campaign';
import { debriefRows, missionTime } from './debrief';
import { drawPixelText, measurePixelText } from './sprites';
import type { CampaignAction } from './title';

const COL = {
  ink: '#0b0d07',
  sea: '#0a1013',
  panel: 'rgba(9, 12, 7, 0.94)',
  plate: 'rgba(12, 15, 9, 0.96)',
  edge: '#3c4630',
  link: '#39412c',
  head: '#e0b53c',
  headShadow: '#5a4310',
  text: '#c8d69a',
  dim: '#6f7a52',
  bright: '#e6f2b8',
  on: '#8dff6a',
  ownFill: 'rgba(224, 181, 60, 0.30)',
  ownEdge: '#e0b53c',
  ownInk: '#f4e0a0',
  foeFill: 'rgba(120, 38, 26, 0.42)',
  foeEdge: '#7a2318',
  foeInk: '#c08a80',
  hotFill: 'rgba(200, 64, 44, 0.46)',
  hotEdge: '#c8402c',
  hotInk: '#ffcfc4',
  danger: '#ff5a48',
} as const;

export const CAMPAIGN_TITLE = 'CONQUEST CAMPAIGN';
export const CAMPAIGN_HINT = 'CLICK A BORDERING TERRITORY TO INVADE   T MENU   M MUTE';
export const RESET_LABEL = 'RESET CAMPAIGN';
export const RESET_CONFIRM_LABEL = 'CONFIRM WIPE?';
export const COMPLETE_TITLE = 'CONTINENT SECURED';
export const COMPLETE_PROMPT = 'R - NEW CAMPAIGN';
export const COMPLETE_TITLE_PROMPT = 'T - RETURN TO COMMAND';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CampaignLayout {
  /** Body font scale in device px per font pixel. */
  scale: number;
  headScale: number;
  headY: number;
  progressY: number;
  /** The square the 0..100 continent space is mapped into. */
  mapX: number;
  mapY: number;
  mapSize: number;
  /** Device px per unit of continent space. */
  unit: number;
  hintY: number;
  reset: Rect;
  back: Rect;
}

const PAD = 14;

/** Geometry for a window. Pure — the render smoke asserts on it directly. */
export function campaignLayout(w: number, h: number): CampaignLayout {
  const scale = w >= 1100 && h >= 720 ? 2 : 1;
  const headScale = w >= 900 ? 4 : w >= 620 ? 3 : 2;

  const headY = PAD;
  const progressY = headY + headScale * 8 + 6;
  const top = progressY + scale * 9 + 8;

  const btnH = Math.max(18, scale * 11);
  const hintY = Math.max(top + 1, h - PAD - 10);
  const bottom = hintY - 10 - btnH - 6;

  const availH = Math.max(40, bottom - top);
  const availW = Math.max(40, w - PAD * 2);
  const mapSize = Math.max(40, Math.min(availW, availH));
  const mapX = Math.round((w - mapSize) / 2);
  const mapY = Math.round(top + Math.max(0, (availH - mapSize) / 2));

  const resetW = measurePixelText(RESET_LABEL, scale) + scale * 8;
  const backW = measurePixelText('T MENU', scale) + scale * 8;
  const btnY = Math.round(hintY - 10 - btnH);
  return {
    scale,
    headScale,
    headY,
    progressY,
    mapX,
    mapY,
    mapSize,
    unit: mapSize / MAP_SPACE,
    hintY,
    reset: { x: Math.round(w - PAD - resetW), y: btnY, w: resetW, h: btnH },
    back: { x: PAD, y: btnY, w: backW, h: btnH },
  };
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** Continent space -> device px. */
function toScreen(l: CampaignLayout, cx: number, cy: number): { x: number; y: number } {
  return { x: l.mapX + cx * l.unit, y: l.mapY + cy * l.unit };
}

/** Ray-casting point-in-polygon, in continent space (so it is scale-free). */
export function pointInShape(
  shape: readonly (readonly [number, number])[],
  px: number,
  py: number,
): boolean {
  let inside = false;
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const a = shape[i] as readonly [number, number];
    const b = shape[j] as readonly [number, number];
    const [xi, yi] = a;
    const [xj, yj] = b;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Territory under a device-px point, or null. */
export function territoryAt(
  l: CampaignLayout,
  x: number,
  y: number,
): string | null {
  if (l.unit <= 0) return null;
  const cx = (x - l.mapX) / l.unit;
  const cy = (y - l.mapY) / l.unit;
  if (cx < 0 || cy < 0 || cx > MAP_SPACE || cy > MAP_SPACE) return null;
  for (const t of TERRITORIES) {
    if (pointInShape(t.shape, cx, cy)) return t.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Invade plate
// ---------------------------------------------------------------------------

export interface PlateLayout {
  panel: Rect;
  launch: Rect;
  cancel: Rect;
  scale: number;
  lines: string[];
}

export const PLATE_LAUNCH = 'LAUNCH ASSAULT';
export const PLATE_CANCEL = 'CANCEL';

/** The plate's copy. Pure, so the smoke can read the exact strings. */
export function plateLines(cfg: CampaignBattleConfig, record: { fought: number }): string[] {
  const lines = [
    `INVADE ${cfg.name}`,
    `TIER ${cfg.tier} - ${cfg.difficulty.toUpperCase()} GARRISON`,
    `ESTIMATED RESISTANCE: ${cfg.resistance}`,
    `ORDER RESERVES: +${cfg.aiCreditBonus} CR`,
  ];
  if (cfg.aiPrebuilt.length > 0) lines.push('DEFENCES ALREADY STANDING');
  if (record.fought > 0) {
    lines.push(`PREVIOUS ATTEMPTS: ${record.fought}`);
  }
  return lines;
}

/** Geometry for the invade plate at a window size. Pure. */
export function plateLayout(w: number, h: number, lines: readonly string[]): PlateLayout {
  const scale = w >= 900 ? 2 : 1;
  let widest = measurePixelText(`${PLATE_LAUNCH}   ${PLATE_CANCEL}`, scale);
  for (const line of lines) widest = Math.max(widest, measurePixelText(line, scale));

  const padX = scale * 10;
  const padY = scale * 9;
  const btnH = scale * 12;
  const bodyH = lines.length * scale * 9 + scale * 6 + btnH;
  const panelW = Math.max(1, Math.min(w - 16, widest + padX * 2));
  const panelH = Math.max(1, Math.min(h - 16, bodyH + padY * 2));
  const panel: Rect = {
    x: Math.round((w - panelW) / 2),
    y: Math.round(Math.max(6, (h - panelH) / 2)),
    w: panelW,
    h: panelH,
  };

  const launchW = measurePixelText(PLATE_LAUNCH, scale) + scale * 8;
  const cancelW = measurePixelText(PLATE_CANCEL, scale) + scale * 8;
  const btnY = panel.y + panel.h - padY - btnH;
  return {
    panel,
    scale,
    lines: lines.slice(),
    launch: { x: panel.x + padX, y: btnY, w: launchW, h: btnH },
    cancel: {
      x: Math.max(panel.x + padX + launchW + scale * 4, panel.x + panel.w - padX - cancelW),
      y: btnY,
      w: cancelW,
      h: btnH,
    },
  };
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export class CampaignScreen {
  /** Render-rate counter — never the sim clock. */
  private frame = 0;
  /** Territory the invade plate is open for, or null. */
  selected: string | null = null;
  /** RESET CAMPAIGN is one click in; a second click wipes. */
  resetArmed = false;
  private hover: string | null = null;
  /**
   * Supplied by `main.ts`: the configuration a territory would be fought under
   * right now. Injected rather than imported so the screen stays a pure view —
   * it never has to know how the scaling is computed.
   */
  configFor: (territoryId: string) => CampaignBattleConfig;

  constructor(configFor: (territoryId: string) => CampaignBattleConfig) {
    this.configFor = configFor;
  }

  /** Entering the map afresh: no stale plate, no half-armed reset. */
  reset(): void {
    this.selected = null;
    this.resetArmed = false;
  }

  /**
   * The invade plate's geometry right now, or null when none is open.
   *
   * Computed on demand rather than cached from `draw`: input handling must not
   * depend on a frame having been rendered first (the headless harness clicks
   * without ever drawing, and a click can land before the first frame after a
   * resize).
   */
  plateFor(cs: CampaignState, w: number, h: number): PlateLayout | null {
    const id = this.selected;
    if (id === null || !canAttack(cs, id)) return null;
    const cfg = this.configFor(id);
    return plateLayout(w, h, plateLines(cfg, recordFor(cs, id)));
  }

  // --- tick ---------------------------------------------------------------

  /**
   * Consume a tick's input. `main.ts` returns from the tick immediately after
   * calling this, so the screen swallows everything it sees — no click can leak
   * into the mission underneath.
   */
  update(snap: InputSnapshot, cs: CampaignState, w: number, h: number): CampaignAction | null {
    const l = campaignLayout(w, h);
    this.hover = territoryAt(l, snap.pointer.x, snap.pointer.y);

    // The campaign-complete screen has its own two keys and swallows the map.
    if (cs.result === 'victory') {
      if (snap.pressed.has('KeyR')) {
        this.reset();
        return { kind: 'reset' };
      }
      if (snap.pressed.has('KeyT') || snap.pressed.has('Escape')) return { kind: 'title' };
      return null;
    }

    if (snap.pressed.has('Escape')) {
      if (this.selected !== null || this.resetArmed) {
        this.reset();
        return { kind: 'select', territory: null };
      }
      return { kind: 'title' };
    }
    if (snap.pressed.has('KeyT')) return { kind: 'title' };

    if (
      this.selected !== null &&
      (snap.pressed.has('Enter') || snap.pressed.has('NumpadEnter') || snap.pressed.has('Space'))
    ) {
      const id = this.selected;
      if (canAttack(cs, id)) {
        this.reset();
        return { kind: 'invade', territory: id };
      }
    }

    for (const click of snap.clicks) {
      if (click.button !== 0) continue;
      const action = this.handleClick(cs, w, h, click.x, click.y);
      if (action) return action;
    }
    return null;
  }

  /** Resolve one left click. Exposed so the render smoke can drive it. */
  handleClick(
    cs: CampaignState,
    w: number,
    h: number,
    x: number,
    y: number,
  ): CampaignAction | null {
    const l = campaignLayout(w, h);
    // The plate is modal over the map: while it is up, only its own controls
    // and "anywhere else = dismiss" mean anything.
    const plate = this.plateFor(cs, w, h);
    if (plate) {
      const id = this.selected as string;
      if (inRect(plate.launch, x, y)) {
        this.reset();
        return { kind: 'invade', territory: id };
      }
      this.reset();
      return { kind: 'select', territory: null };
    }

    if (inRect(l.back, x, y)) return { kind: 'title' };

    if (inRect(l.reset, x, y)) {
      // Double-confirm: the first click arms it, the second wipes the save.
      if (this.resetArmed) {
        this.reset();
        return { kind: 'reset' };
      }
      this.resetArmed = true;
      return null;
    }
    // Any click that is not on the reset control disarms it, so an armed wipe
    // can never survive to catch a later, unrelated click.
    this.resetArmed = false;

    const hit = territoryAt(l, x, y);
    if (hit !== null && canAttack(cs, hit)) {
      this.selected = hit;
      return { kind: 'select', territory: hit };
    }
    if (this.selected !== null) {
      this.selected = null;
      return { kind: 'select', territory: null };
    }
    return null;
  }

  // --- draw ---------------------------------------------------------------

  draw(
    ctx: CanvasRenderingContext2D,
    terrain: HTMLCanvasElement | null,
    w: number,
    h: number,
    cs: CampaignState,
  ): void {
    this.frame++;
    this.drawBackdrop(ctx, terrain, w, h);

    if (cs.result === 'victory') {
      this.drawComplete(ctx, w, h, cs);
      this.drawScanlines(ctx, w, h);
      return;
    }

    const l = campaignLayout(w, h);
    this.drawHeader(ctx, l, w, cs);
    this.drawLinks(ctx, l, cs);
    for (const t of TERRITORIES) this.drawTerritory(ctx, l, cs, t, w);
    this.drawControls(ctx, l, w, h);

    const plate = this.plateFor(cs, w, h);
    if (plate && this.selected !== null) {
      this.drawPlate(ctx, plate, this.configFor(this.selected));
    }

    this.drawScanlines(ctx, w, h);
  }

  private drawBackdrop(
    ctx: CanvasRenderingContext2D,
    terrain: HTMLCanvasElement | null,
    w: number,
    h: number,
  ): void {
    ctx.fillStyle = COL.ink;
    ctx.fillRect(0, 0, w, h);
    if (terrain && terrain.width > 0) {
      const drift = this.frame * 0.08;
      const maxX = Math.max(0, terrain.width - w);
      const maxY = Math.max(0, terrain.height - h);
      const sx = maxX > 0 ? (drift % maxX | 0) : 0;
      const sy = maxY > 0 ? ((drift * 0.6) % maxY | 0) : 0;
      const sw = Math.min(w, terrain.width - sx);
      const sh = Math.min(h, terrain.height - sy);
      if (sw > 0 && sh > 0) ctx.drawImage(terrain, sx, sy, sw, sh, 0, 0, sw, sh);
    }
    ctx.fillStyle = 'rgba(6, 10, 12, 0.86)';
    ctx.fillRect(0, 0, w, h);
  }

  /** The CRT treatment the other three screens share. */
  private drawScanlines(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, w, 4);
    ctx.fillRect(0, Math.max(0, h - 4), w, 4);
  }

  private drawHeader(
    ctx: CanvasRenderingContext2D,
    l: CampaignLayout,
    w: number,
    cs: CampaignState,
  ): void {
    const tw = measurePixelText(CAMPAIGN_TITLE, l.headScale);
    const x = Math.round((w - tw) / 2);
    drawPixelText(ctx, CAMPAIGN_TITLE, x + l.headScale, l.headY + l.headScale, l.headScale, COL.headShadow);
    drawPixelText(ctx, CAMPAIGN_TITLE, x, l.headY, l.headScale, COL.head);

    const held = ownedCount(cs);
    const line =
      `TERRITORIES ${held}/${TERRITORY_COUNT}   BATTLES ${cs.battlesFought}   ` +
      `WON ${cs.battlesWon}   FRONTS ${attackableIds(cs).length}`;
    const lw = measurePixelText(line, l.scale);
    drawPixelText(ctx, line, Math.round((w - lw) / 2), l.progressY, l.scale, COL.dim);
  }

  /**
   * Thin links between the centres of bordering territories. The blobs are
   * drawn with visible channels between them (they read as land, not as a
   * subdivided rectangle), so the graph is stated explicitly rather than being
   * inferred from which outlines happen to touch.
   */
  private drawLinks(ctx: CanvasRenderingContext2D, l: CampaignLayout, cs: CampaignState): void {
    ctx.lineWidth = Math.max(1, Math.round(l.unit * 0.35));
    for (const t of TERRITORIES) {
      for (const id of t.adjacent) {
        if (id <= t.id) continue; // each unordered pair once
        const other = territory(id);
        if (!other) continue;
        const a = toScreen(l, t.cx, t.cy);
        const b = toScreen(l, other.cx, other.cy);
        // A link the player can actually use (own -> enemy, or own -> own) is
        // lit; a link between two enemy territories is background.
        const live = isOwned(cs, t.id) || isOwned(cs, id);
        ctx.strokeStyle = live ? COL.edge : COL.link;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  private drawTerritory(
    ctx: CanvasRenderingContext2D,
    l: CampaignLayout,
    cs: CampaignState,
    t: Territory,
    w: number,
  ): void {
    const owned = isOwned(cs, t.id);
    const hot = canAttack(cs, t.id);
    const hovered = this.hover === t.id;
    const chosen = this.selected === t.id;

    ctx.beginPath();
    t.shape.forEach(([px, py], i) => {
      const p = toScreen(l, px, py);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fillStyle = owned ? COL.ownFill : hot ? COL.hotFill : COL.foeFill;
    ctx.fill();

    // Attackable territories pulse; everything else is a flat outline.
    const pulse = 0.55 + 0.45 * Math.sin(this.frame * 0.09);
    if (hot) {
      ctx.globalAlpha = chosen || hovered ? 1 : 0.45 + 0.55 * pulse;
      ctx.strokeStyle = chosen ? COL.bright : COL.hotEdge;
      ctx.lineWidth = chosen || hovered ? 3 : 2;
    } else {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = owned ? COL.ownEdge : COL.foeEdge;
      ctx.lineWidth = owned ? 2 : 1;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Label block: name, then the tier / battle tag under it. Both are centred
    // on the label anchor and then nudged back inside the window — the eastern
    // territories sit against the edge of the continent, and a long name there
    // (OBSIDIAN CROWN) would otherwise run off a narrow window.
    const ink = owned ? COL.ownInk : hot ? COL.hotInk : COL.foeInk;
    const nameScale = l.scale;
    const c = toScreen(l, t.cx, t.cy);
    const nameY = Math.round(c.y - nameScale * 8);
    const centred = (text: string, scale: number): number => {
      const tw = measurePixelText(text, scale);
      return Math.round(Math.max(2, Math.min(w - tw - 2, c.x - tw / 2)));
    };
    drawPixelText(ctx, t.name, centred(t.name, nameScale), nameY, nameScale, ink);

    const rec = recordFor(cs, t.id);
    const tag = owned
      ? t.id === HOME_TERRITORY
        ? 'HQ'
        : 'HELD'
      : `TIER ${tierOf(t.id)}${rec.fought > 0 ? ` - ${rec.fought} TRIED` : ''}`;
    drawPixelText(
      ctx,
      tag,
      centred(tag, 1),
      nameY + nameScale * 8 + 1,
      1,
      owned ? COL.head : hot ? COL.bright : COL.dim,
    );
  }

  private drawControls(
    ctx: CanvasRenderingContext2D,
    l: CampaignLayout,
    w: number,
    h: number,
  ): void {
    const button = (r: Rect, label: string, color: string, edge: string): void => {
      ctx.fillStyle = COL.panel;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
      const tw = measurePixelText(label, l.scale);
      drawPixelText(
        ctx,
        label,
        Math.round(r.x + (r.w - tw) / 2),
        Math.round(r.y + (r.h - l.scale * 7) / 2),
        l.scale,
        color,
      );
    };

    button(l.back, 'T MENU', COL.text, COL.edge);
    if (this.resetArmed) {
      button(l.reset, RESET_CONFIRM_LABEL, COL.danger, COL.danger);
    } else {
      button(l.reset, RESET_LABEL, COL.dim, COL.edge);
    }

    ctx.fillStyle = COL.dim;
    ctx.font = '10px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(
      this.resetArmed ? 'CLICK RESET AGAIN TO WIPE THE CAMPAIGN SAVE' : CAMPAIGN_HINT,
      Math.round(w / 2),
      Math.min(h - 4, l.hintY + 8),
    );
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  private drawPlate(
    ctx: CanvasRenderingContext2D,
    plate: PlateLayout,
    cfg: CampaignBattleConfig,
  ): void {
    const { panel, scale } = plate;
    ctx.fillStyle = COL.plate;
    ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
    ctx.strokeStyle = COL.edge;
    ctx.lineWidth = 2;
    ctx.strokeRect(panel.x + 1, panel.y + 1, Math.max(0, panel.w - 2), Math.max(0, panel.h - 2));
    ctx.fillStyle = cfg.threat >= 0.8 ? COL.danger : COL.head;
    ctx.fillRect(panel.x + 1, panel.y + 1, Math.max(0, panel.w - 2), 2);

    let y = panel.y + scale * 9;
    plate.lines.forEach((line, i) => {
      const color = i === 0 ? COL.head : i === 2 ? (cfg.threat >= 0.6 ? COL.danger : COL.text) : COL.text;
      drawPixelText(ctx, line, panel.x + scale * 10, y, scale, color);
      y += scale * 9;
    });

    const button = (r: Rect, label: string, color: string, edge: string): void => {
      ctx.fillStyle = 'rgba(60, 74, 38, 0.85)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
      const tw = measurePixelText(label, scale);
      drawPixelText(
        ctx,
        label,
        Math.round(r.x + (r.w - tw) / 2),
        Math.round(r.y + (r.h - scale * 7) / 2),
        scale,
        color,
      );
    };
    const blink = Math.floor(this.frame / 20) % 2 === 0;
    button(plate.launch, PLATE_LAUNCH, blink ? COL.bright : COL.on, COL.on);
    button(plate.cancel, PLATE_CANCEL, COL.text, COL.edge);
  }

  /**
   * Campaign complete. Deliberately the debriefing's own furniture — the same
   * panel, rule, two-column table and `debriefRows` content — so finishing the
   * continent reads as the same kind of screen as finishing a mission, one
   * scale up.
   */
  private drawComplete(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    cs: CampaignState,
  ): void {
    const rows = debriefRows(cs.totals);
    const scale = w >= 900 && h >= 640 ? 2 : 1;
    const headScale = Math.max(scale, w >= 900 ? 4 : 2);

    let labelW = 0;
    let numW = measurePixelText('ORDER', scale);
    for (const r of rows) {
      labelW = Math.max(labelW, measurePixelText(r.label, scale));
      numW = Math.max(
        numW,
        measurePixelText(String(r.you), scale),
        measurePixelText(String(r.order), scale),
      );
    }
    const gap = scale * 8;
    const tableW = labelW + gap + numW + gap + numW;
    const line = `${TERRITORY_COUNT} TERRITORIES   ${cs.battlesFought} BATTLES   TIME ${missionTime(cs.ticks)}`;
    const contentW = Math.max(
      tableW,
      measurePixelText(COMPLETE_TITLE, headScale),
      measurePixelText(line, scale),
      measurePixelText(COMPLETE_PROMPT, scale),
      measurePixelText(COMPLETE_TITLE_PROMPT, scale),
    );
    const contentH = headScale * 10 + scale * 11 + scale * 8 + scale * 11 + rows.length * scale * 9 + scale * 10 + scale * 20;

    const padX = scale * 10;
    const padY = scale * 8;
    const panelW = Math.max(1, Math.min(w - 12, contentW + padX * 2));
    const panelH = Math.max(1, Math.min(h - 12, contentH + padY * 2));
    const panelX = Math.round((w - panelW) / 2);
    const panelY = Math.round(Math.max(6, (h - panelH) / 2));

    ctx.fillStyle = COL.panel;
    ctx.fillRect(panelX, panelY, panelW, panelH);
    ctx.strokeStyle = COL.edge;
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX + 1, panelY + 1, Math.max(0, panelW - 2), Math.max(0, panelH - 2));
    ctx.fillStyle = COL.on;
    ctx.fillRect(panelX + 1, panelY + 1, Math.max(0, panelW - 2), 2);

    const titleW = measurePixelText(COMPLETE_TITLE, headScale);
    const titleX = Math.round(panelX + (panelW - titleW) / 2);
    const titleY = panelY + padY;
    drawPixelText(ctx, COMPLETE_TITLE, titleX + headScale, titleY + headScale, headScale, COL.headShadow);
    drawPixelText(ctx, COMPLETE_TITLE, titleX, titleY, headScale, COL.on);

    const infoY = titleY + headScale * 10;
    drawPixelText(
      ctx,
      line,
      Math.round(panelX + (panelW - measurePixelText(line, scale)) / 2),
      infoY,
      scale,
      COL.dim,
    );

    const ruleY = infoY + scale * 11;
    ctx.fillStyle = COL.edge;
    ctx.fillRect(panelX + scale * 10, ruleY, Math.max(0, panelW - scale * 20), Math.max(1, scale));

    const x0 = Math.max(panelX + padX, panelX + Math.round((panelW - tableW) / 2));
    const col1R = x0 + labelW + gap + numW;
    const col2R = col1R + gap + numW;
    const right = (text: string, r: number, y: number, color: string): void => {
      drawPixelText(ctx, text, r - measurePixelText(text, scale), y, scale, color);
    };
    const headerY = ruleY + scale * 8;
    right('YOU', col1R, headerY, COL.head);
    right('ORDER', col2R, headerY, COL.foeEdge);

    const firstRowY = headerY + scale * 11;
    rows.forEach((row, i) => {
      const y = firstRowY + i * scale * 9;
      drawPixelText(ctx, row.label, x0, y, scale, COL.text);
      right(String(row.you), col1R, y, COL.bright);
      right(String(row.order), col2R, y, COL.dim);
    });

    const footY = firstRowY + rows.length * scale * 9 + scale * 10;
    const centred = (text: string, y: number, color: string): void => {
      drawPixelText(
        ctx,
        text,
        Math.round(panelX + (panelW - measurePixelText(text, scale)) / 2),
        y,
        scale,
        color,
      );
    };
    if (Math.floor(this.frame / 20) % 2 === 0) centred(COMPLETE_PROMPT, footY, COL.bright);
    centred(COMPLETE_TITLE_PROMPT, footY + scale * 11, COL.head);
  }
}
