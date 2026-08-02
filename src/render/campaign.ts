/**
 * Conquest campaign map (V3, retheatred in V3.1) — the screen between the title
 * and the briefing.
 *
 * V3 drew thirteen rounded blobs floating on a dark backdrop with channels
 * between them and explicit "border links" between their centres. The player's
 * note was *"can you make it look like a world map instead of shapes"*, so
 * V3.1 draws a **stylised military theater map**: one continent on an animated
 * ocean, its thirteen territories tessellating the landmass exactly (see
 * `render/theater.ts` — every adjacency in `game/campaign.ts` is a real shared
 * border, and every shared border is an adjacency). Terrain-flavoured fills run
 * green in the west to broken rock in the east, tinted gold for ground you
 * hold and crimson for The Order's, with a pulse on the border you would cross
 * to invade. Click one, confirm on the invade plate, and the ordinary
 * briefing -> mission path takes over.
 *
 * Same discipline as `title.ts` / `briefing.ts` / `debrief.ts`:
 *
 *   - **render-side only.** It reads a `CampaignState` and never a `GameState`;
 *     it mutates nothing but its own plate/confirm bookkeeping and its two
 *     draw caches, and it hands every decision back to `main.ts` as a
 *     `CampaignAction`.
 *   - **its own frame counter.** The pulse and the sea shimmer run off
 *     `this.frame`, never `state.tick` — while the phase is 'campaign' the sim
 *     is frozen exactly as it is on the title screen.
 *   - **layout is a pure function** (`campaignLayout`, `campaignLabels`), so the
 *     headless smoke can assert that nothing goes NaN or negative, that every
 *     territory hit-tests back to itself at any window size, and that no two
 *     labels ever overlap.
 */

import { makeRng } from '../engine/rng';
import type { InputSnapshot } from '../engine/input';
import {
  HOME_TERRITORY,
  MAP_SPACE,
  STRONGHOLD_TERRITORY,
  TERRITORIES,
  TERRITORY_COUNT,
  attackable as attackableIds,
  canAttack,
  isOwned,
  ownedCount,
  recordFor,
  tierOf,
  type CampaignBattleConfig,
  type CampaignState,
} from '../game/campaign';
import { debriefRows, missionTime } from './debrief';
import { drawPixelText, measurePixelText } from './sprites';
import {
  BORDER_LINES,
  COASTLINE,
  REGIONS,
  regionAt,
  regionOf,
  sharedBorder,
  type Pt,
  type TheaterRegion,
} from './theater';
import type { CampaignAction } from './title';

export { pointInShape } from './theater';

const COL = {
  ink: '#0b0d07',
  // Sea. Three flat tones plus a shimmer speck, all dithered — no gradients, so
  // the ocean stays on the same chunky pixel budget as the rest of the art.
  seaDeep: '#050e13',
  sea: '#09181f',
  seaLit: '#0d2530',
  shimmer: '#1d4a5c',
  shelf: 'rgba(38, 108, 132, ',
  panel: 'rgba(9, 12, 7, 0.94)',
  plate: 'rgba(12, 15, 9, 0.96)',
  edge: '#3c4630',
  head: '#e0b53c',
  headShadow: '#5a4310',
  text: '#c8d69a',
  dim: '#6f7a52',
  bright: '#e6f2b8',
  on: '#8dff6a',
  // Land.
  coastInk: '#04070a',
  coastRim: '#6f6448',
  borderInk: 'rgba(12, 16, 10, 0.9)',
  borderLift: 'rgba(190, 200, 150, 0.16)',
  // States.
  ownFill: 'rgba(228, 184, 62, 0.30)',
  ownEdge: '#e0b53c',
  ownInk: '#f7e6ad',
  // Enemy ground is a *muted* crimson and invadable ground a brighter one, so
  // the front is legible before the pulse even starts.
  foeFill: 'rgba(88, 26, 20, 0.46)',
  foeEdge: '#6a1f15',
  foeInk: '#c0928a',
  hotFill: 'rgba(214, 74, 48, 0.36)',
  hotEdge: '#e05238',
  hotInk: '#ffd6cb',
  danger: '#ff5a48',
} as const;

/**
 * Terrain-flavoured base fill per tier: damp green at the landing, sun-bleached
 * scrub through the middle, broken dark rock at the stronghold. It matches the
 * SPEC's own "8.0% rock at home -> 18.6% at OBSIDIAN CROWN" terrain progression,
 * so the map says out loud what the battle maps make you feel.
 */
const TIER_LAND: readonly string[] = [
  '#3d5c26', // damp green — the landing
  '#4b5c2c', // scrub
  '#5d5d33', // dry grass
  '#6d5c39', // sand and gravel
  '#615340', // broken rock
  '#4a453b', // the stronghold's black stone
];

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

function overlaps(a: Rect, b: Rect, pad: number): boolean {
  return (
    a.x - pad < b.x + b.w &&
    b.x - pad < a.x + a.w &&
    a.y - pad < b.y + b.h &&
    b.y - pad < a.y + a.h
  );
}

/** Continent space -> device px. */
function sx(l: CampaignLayout, cx: number): number {
  return l.mapX + cx * l.unit;
}
function sy(l: CampaignLayout, cy: number): number {
  return l.mapY + cy * l.unit;
}

/** Territory under a device-px point, or null. */
export function territoryAt(l: CampaignLayout, x: number, y: number): string | null {
  if (l.unit <= 0) return null;
  const cx = (x - l.mapX) / l.unit;
  const cy = (y - l.mapY) / l.unit;
  if (cx < 0 || cy < 0 || cx > MAP_SPACE || cy > MAP_SPACE) return null;
  return regionAt(cx, cy);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Emblem carried above a label: the HQ pip, or the stronghold's keep. */
export type LabelBadge = 'hq' | 'keep' | null;

/**
 * A resolved territory label. `rect` is the **whole block** — badge, name, tag
 * and battle scars — already nudged clear of every other label and clamped
 * inside the map square. Everything drawn is inside that rect, which is what
 * makes the collision pass mean something (the first cut left the badge and the
 * scars outside it, and the stronghold's keep promptly landed on BLACKSPINE).
 */
export interface LabelPlacement {
  id: string;
  name: string;
  /** Second line (`HQ` / `HELD` / `TIER n - k TRIED`), or null when it did not fit. */
  tag: string | null;
  nameScale: number;
  rect: Rect;
  badge: LabelBadge;
  badgePx: number;
  /** Absolute device-px baselines inside `rect`. */
  badgeY: number;
  nameY: number;
  tagY: number;
  /** Battle-scar tick row, or null when this territory has never been fought for. */
  scarY: number | null;
  scars: number;
  /** The region's own anchor, device px. */
  anchorX: number;
  anchorY: number;
  /** True when the block had to leave its region and needs a leader line. */
  leader: boolean;
}

/** Gap kept between two label blocks, device px. */
const LABEL_GAP = 3;
/** Line spacing inside a block, device px. */
const LABEL_LEAD = 2;
/**
 * How far a name may overrun its region's bounding box before the whole map
 * steps down a font size. A little overrun is normal cartography (a name is
 * wider than the valley it sits in); 60% is where it starts covering the
 * neighbours.
 */
const NAME_FIT = 1.6;

function tagFor(cs: CampaignState, id: string): string {
  if (isOwned(cs, id)) {
    if (id === HOME_TERRITORY) return 'HQ';
    if (id === STRONGHOLD_TERRITORY) return 'CROWN HELD';
    return 'HELD';
  }
  const rec = recordFor(cs, id);
  return `TIER ${tierOf(id)}${rec.fought > 0 ? ` - ${rec.fought} TRIED` : ''}`;
}

/**
 * Where every territory's name goes, at this window size and this campaign.
 *
 * **The rules, in order:**
 *
 *  1. The anchor is the region's *pole of inaccessibility* — the interior point
 *     furthest from any border — so a name sits in the fat part of its region
 *     instead of on a centroid a concave outline can push against an edge.
 *  2. **One name scale for the whole map.** The layout's body scale is used only
 *     when *every* name fits inside `NAME_FIT` x its own region's bounding-box
 *     width at that scale; otherwise the whole map drops to scale 1. Mixing 1x
 *     and 2x bitmap type across one map reads as a mistake rather than as a
 *     hierarchy, so the map commits to a single size — scale 2 from about
 *     1440x900 up, scale 1 below (and always at 640x480).
 *  3. The **tier / state tag is a second line only when it fits the region** —
 *     no wider than the bbox and no taller than 55% of it. Cramped regions and
 *     small windows therefore go **name-only**, which is the documented drop.
 *  4. **The reserved rect is the whole block** — the HQ / stronghold badge above
 *     the name and the battle-scar ticks below it are inside it, not decoration
 *     hung off its edges, so the collision pass actually covers everything that
 *     gets drawn.
 *  5. Blocks are placed **largest region first** (so the big regions get their
 *     natural spot) at the anchor, then, if that collides with an already-placed
 *     block, over a deterministic ring search of candidate offsets, and finally
 *     over an exhaustive grid scan. Every candidate is clamped inside the map
 *     square before it is tested, so a label can never leave the window.
 *  6. If the accepted block no longer covers its anchor, `leader` is set and the
 *     screen draws a thin leader line from the anchor to the block.
 *
 * Pure, so the label collision harness can assert directly on the result across
 * window sizes and ownership states.
 */
export function campaignLabels(l: CampaignLayout, cs: CampaignState): LabelPlacement[] {
  const order = REGIONS.slice().sort((a, b) => b.area - a.area);
  const placed: Rect[] = [];
  const out: LabelPlacement[] = [];
  const sqX = l.mapX;
  const sqY = l.mapY;
  const sqW = l.mapSize;

  const nameOf = (id: string): string => TERRITORIES.find((x) => x.id === id)?.name ?? id;
  const nameScale =
    l.scale > 1 &&
    REGIONS.every(
      (r) => measurePixelText(nameOf(r.id), l.scale) <= (r.bx1 - r.bx0) * l.unit * NAME_FIT,
    )
      ? l.scale
      : 1;

  for (const r of order) {
    const t = TERRITORIES.find((x) => x.id === r.id);
    if (!t) continue;
    const bboxW = (r.bx1 - r.bx0) * l.unit;
    const bboxH = (r.by1 - r.by0) * l.unit;

    const nameW = measurePixelText(t.name, nameScale);
    const nameH = nameScale * 7;

    const tagText = tagFor(cs, r.id);
    const tagW = measurePixelText(tagText, 1);
    const textH2 = nameH + LABEL_LEAD + 7;
    const tag = tagW <= bboxW && textH2 <= bboxH * 0.55 ? tagText : null;

    const badge: LabelBadge =
      r.id === HOME_TERRITORY ? 'hq' : r.id === STRONGHOLD_TERRITORY ? 'keep' : null;
    const badgePx = Math.max(2, Math.round(l.unit * 0.55));
    const badgeH = badge ? badgePx * (badge === 'hq' ? 5 : 6) + LABEL_LEAD : 0;
    const scars = Math.min(5, recordFor(cs, r.id).fought);
    const scarH = scars > 0 ? 5 : 0;

    const w = Math.max(nameW, tag ? tagW : 0, badge ? badgePx * 7 : 0);
    const h = badgeH + (tag ? textH2 : nameH) + scarH;
    const ax = sx(l, r.ax);
    const ay = sy(l, r.ay);

    const fit = (px: number, py: number): Rect => ({
      x: Math.round(Math.max(sqX + 1, Math.min(sqX + sqW - w - 1, px))),
      y: Math.round(Math.max(sqY + 1, Math.min(sqY + sqW - h - 1, py))),
      w,
      h,
    });

    const free = (rect: Rect): boolean =>
      !placed.some((p) => overlaps(rect, p, LABEL_GAP));

    let rect = fit(ax - w / 2, ay - h / 2);
    if (!free(rect)) {
      // Ring search outward from the anchor — the nearest free spot wins, so a
      // nudged label stays associated with its own region.
      const step = Math.max(6, Math.round(l.unit * 2));
      const maxR = Math.max(step * 3, Math.round(sqW * 0.6));
      let found = false;
      search: for (let rad = step; rad <= maxR; rad += step) {
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          const cand = fit(ax - w / 2 + Math.cos(a) * rad, ay - h / 2 + Math.sin(a) * rad);
          if (free(cand)) {
            rect = cand;
            found = true;
            break search;
          }
        }
      }
      if (!found) {
        // Exhaustive fallback for a map square barely wider than the type
        // (well under the 640x480 floor, but a scan is cheap and it means the
        // "no two labels ever touch" guarantee holds at *every* size).
        const rowH = Math.max(2, h + LABEL_GAP);
        const colW = Math.max(3, Math.round(w / 4));
        pack: for (let gy = sqY + 1; gy <= sqY + sqW - h - 1; gy += rowH) {
          for (let gx = sqX + 1; gx <= sqX + sqW - w - 1; gx += colW) {
            const cand = fit(gx, gy);
            if (free(cand)) {
              rect = cand;
              break pack;
            }
          }
        }
      }
    }
    placed.push(rect);

    const cx = (rect.x + rect.w / 2 - l.mapX) / l.unit;
    const cy = (rect.y + rect.h / 2 - l.mapY) / l.unit;
    const leader = Math.hypot(rect.x + rect.w / 2 - ax, rect.y + rect.h / 2 - ay) > 2 &&
      regionAt(cx, cy) !== r.id;

    out.push({
      id: r.id,
      name: t.name,
      tag,
      nameScale,
      rect,
      badge,
      badgePx,
      badgeY: rect.y,
      nameY: rect.y + badgeH,
      tagY: rect.y + badgeH + nameH + LABEL_LEAD,
      scarY: scars > 0 ? rect.y + h - 3 : null,
      scars,
      anchorX: ax,
      anchorY: ay,
      leader,
    });
  }
  // Back to continent order, so the drawing order (and the harness output) is
  // the campaign's own west-to-east list rather than an area ranking.
  const byId = new Map(out.map((p) => [p.id, p]));
  return TERRITORIES.map((t) => byId.get(t.id) as LabelPlacement).filter(Boolean);
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
// Sea shimmer (deterministic, animated off the render frame counter)
// ---------------------------------------------------------------------------

interface Speck {
  x: number;
  y: number;
  w: number;
  speed: number;
  lit: boolean;
}

const SHIMMER: readonly Speck[] = (() => {
  const rng = makeRng(0x0cea11);
  const out: Speck[] = [];
  for (let i = 0; i < 84; i++) {
    out.push({
      x: rng.next(),
      y: rng.next(),
      w: rng.range(0.008, 0.032),
      speed: rng.range(0.00012, 0.00055),
      lit: rng.chance(0.35),
    });
  }
  return out;
})();

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
   * Two draw caches, both keyed on what they actually depend on:
   *
   *  - `land` is the continent itself — terrain fills, the dithered texture, the
   *    interior borders and the coastline. It only depends on the map square's
   *    size, so it survives every click and every conquest.
   *  - `overlay` is the state layer — ownership washes, firm borders, badges,
   *    battle scars and the resolved labels. It depends on the map size *and* a
   *    signature of the campaign, so it is rebuilt when (and only when) the
   *    front moves.
   *
   * What is left per frame is the sea, two `drawImage`s, the pulse on the
   * invadable borders and the hover outline — which is what keeps a 1920x1080
   * frame inside the budget even though the map is now a textured continent.
   */
  private land: HTMLCanvasElement | null = null;
  private landSize = -1;
  private overlay: HTMLCanvasElement | null = null;
  private overlayKey = '';

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
    this.drawSea(ctx, terrain, w, h);

    if (cs.result === 'victory') {
      this.drawComplete(ctx, w, h, cs);
      this.drawScanlines(ctx, w, h);
      return;
    }

    const l = campaignLayout(w, h);
    this.drawHeader(ctx, l, w, cs);
    this.drawContinent(ctx, l, cs);
    this.drawControls(ctx, l, w, h);

    const plate = this.plateFor(cs, w, h);
    if (plate && this.selected !== null) {
      this.drawPlate(ctx, plate, this.configFor(this.selected));
    }

    this.drawScanlines(ctx, w, h);
  }

  /**
   * Open water. Three flat tones under a slow drift of the composited terrain
   * layer (the game's own art, at 6% — it reads as sea floor, not as a map) and
   * a scatter of shimmer specks scrolling off the frame counter.
   */
  private drawSea(
    ctx: CanvasRenderingContext2D,
    terrain: HTMLCanvasElement | null,
    w: number,
    h: number,
  ): void {
    ctx.fillStyle = COL.seaDeep;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = COL.sea;
    ctx.fillRect(0, Math.round(h * 0.08), w, Math.round(h * 0.84));
    ctx.fillStyle = COL.seaLit;
    ctx.fillRect(Math.round(w * 0.06), Math.round(h * 0.2), Math.round(w * 0.88), Math.round(h * 0.6));

    if (terrain && terrain.width > 0) {
      const drift = this.frame * 0.06;
      const maxX = Math.max(0, terrain.width - w);
      const maxY = Math.max(0, terrain.height - h);
      const ox = maxX > 0 ? (drift % maxX | 0) : 0;
      const oy = maxY > 0 ? ((drift * 0.6) % maxY | 0) : 0;
      const sw = Math.min(w, terrain.width - ox);
      const sh = Math.min(h, terrain.height - oy);
      if (sw > 0 && sh > 0) {
        ctx.globalAlpha = 0.06;
        ctx.drawImage(terrain, ox, oy, sw, sh, 0, 0, sw, sh);
        ctx.globalAlpha = 1;
      }
    }

    const th = Math.max(1, Math.round(h * 0.004));
    for (const s of SHIMMER) {
      const x = ((s.x + s.speed * this.frame) % 1) * w;
      ctx.fillStyle = s.lit ? COL.shimmer : COL.seaLit;
      ctx.fillRect(Math.round(x), Math.round(s.y * h), Math.max(2, Math.round(s.w * w)), th);
    }
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

  // --- continent ----------------------------------------------------------

  /** Trace a continent-space polyline/ring into the current path. */
  private trace(
    ctx: CanvasRenderingContext2D,
    l: CampaignLayout,
    pts: readonly Pt[],
    close: boolean,
    ox = 0,
    oy = 0,
  ): void {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as Pt;
      const x = sx(l, p[0]) - ox;
      const y = sy(l, p[1]) - oy;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (close) ctx.closePath();
  }

  private drawContinent(
    ctx: CanvasRenderingContext2D,
    l: CampaignLayout,
    cs: CampaignState,
  ): void {
    // Continental shelf: three fading strokes around the coast, drawn *before*
    // the land so the inner half is covered and only the sea side glows.
    this.trace(ctx, l, COASTLINE, true);
    ctx.lineJoin = 'round';
    for (const [width, alpha] of [
      [Math.max(6, l.unit * 1.5), 0.1],
      [Math.max(4, l.unit * 0.9), 0.16],
      [Math.max(2, l.unit * 0.4), 0.26],
    ] as const) {
      ctx.strokeStyle = `${COL.shelf}${alpha})`;
      ctx.lineWidth = width;
      ctx.stroke();
    }
    ctx.lineJoin = 'miter';

    const land = this.landLayer(l);
    if (land) ctx.drawImage(land, l.mapX, l.mapY);
    const overlay = this.overlayLayer(l, cs);
    if (overlay) ctx.drawImage(overlay, l.mapX, l.mapY);

    this.drawFront(ctx, l, cs);
  }

  /** Terrain + texture + borders + coastline. Rebuilt only when the size changes. */
  private landLayer(l: CampaignLayout): HTMLCanvasElement | null {
    const size = Math.max(1, Math.round(l.mapSize));
    if (this.land && this.landSize === size) return this.land;
    const canvas = makeLayer(size);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    // Layer-local layout: same scale, origin at the layer's corner.
    const ll: CampaignLayout = { ...l, mapX: 0, mapY: 0, mapSize: size, unit: size / MAP_SPACE };

    ctx.save();
    this.trace(ctx, ll, COASTLINE, true);
    ctx.clip();

    for (const r of REGIONS) {
      ctx.fillStyle = TIER_LAND[Math.min(r.tier, TIER_LAND.length - 1)] as string;
      this.trace(ctx, ll, r.points, true);
      ctx.fill();
    }

    this.drawTexture(ctx, size);

    // A bleached rim just inside the coast — the beach.
    this.trace(ctx, ll, COASTLINE, true);
    ctx.strokeStyle = COL.coastRim;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(2, ll.unit * 0.7);
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    // Interior borders: a thin dark line with a 1px light lift on top, so a
    // border reads as a ridge rather than as a crack.
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, Math.round(ll.unit * 0.22));
    for (const line of BORDER_LINES) {
      this.trace(ctx, ll, line, false);
      ctx.strokeStyle = COL.borderInk;
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    for (const line of BORDER_LINES) {
      this.trace(ctx, ll, line, false, 0, 1);
      ctx.strokeStyle = COL.borderLift;
      ctx.stroke();
    }

    // The coastline itself, heavier than any interior border.
    this.trace(ctx, ll, COASTLINE, true);
    ctx.strokeStyle = COL.coastInk;
    ctx.lineWidth = Math.max(2, Math.round(ll.unit * 0.4));
    ctx.stroke();
    ctx.lineJoin = 'miter';

    this.land = canvas;
    this.landSize = size;
    return canvas;
  }

  /**
   * Dithered ground texture, clipped to the landmass by the caller. Chunky
   * blocks sized off the map so it stays pixel art at any window, and its
   * density ramps west -> east: green tufts in the west, rock speckle in the
   * east, matching the tier fills underneath.
   */
  private drawTexture(ctx: CanvasRenderingContext2D, size: number): void {
    const px = Math.max(3, Math.round(size / 180));
    const n = Math.ceil(size / px);
    const rng = makeRng(0x7ea7e2);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const xf = i / n;
        const roll = rng.next();
        let color: string | null = null;
        let wide = 1;
        if (roll < 0.11 + 0.1 * xf) color = 'rgba(0,0,0,0.24)';
        else if (roll < 0.19 + 0.1 * xf) color = 'rgba(255,255,255,0.055)';
        else if (roll < 0.22 + 0.07 * xf) {
          color = 'rgba(150,146,126,0.17)';
          wide = 2;
        } else if (roll < 0.27 - 0.05 * xf) color = 'rgba(120,160,80,0.14)';
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(i * px, j * px, px * wide, px);
      }
    }
  }

  /** Ownership washes, firm borders, badges, scars and labels. */
  private overlayLayer(l: CampaignLayout, cs: CampaignState): HTMLCanvasElement | null {
    const size = Math.max(1, Math.round(l.mapSize));
    const key = `${size}|${l.scale}|${cs.owned.slice().sort().join(',')}|${TERRITORIES.map(
      (t) => recordFor(cs, t.id).fought,
    ).join('')}`;
    if (this.overlay && this.overlayKey === key) return this.overlay;
    const canvas = makeLayer(size);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    const ll: CampaignLayout = { ...l, mapX: 0, mapY: 0, mapSize: size, unit: size / MAP_SPACE };

    for (const r of REGIONS) {
      const owned = isOwned(cs, r.id);
      const hot = canAttack(cs, r.id);
      this.trace(ctx, ll, r.points, true);
      ctx.fillStyle = owned ? COL.ownFill : hot ? COL.hotFill : COL.foeFill;
      ctx.fill();
      ctx.strokeStyle = owned ? COL.ownEdge : hot ? COL.hotEdge : COL.foeEdge;
      ctx.lineWidth = owned ? Math.max(2, Math.round(ll.unit * 0.28)) : 1;
      ctx.globalAlpha = owned ? 0.95 : 0.55;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const p of campaignLabels(ll, cs)) {
      const owned = isOwned(cs, p.id);
      const hot = canAttack(cs, p.id);
      const ink = owned ? COL.ownInk : hot ? COL.hotInk : COL.foeInk;
      const midX = p.rect.x + p.rect.w / 2;
      if (p.leader) {
        ctx.strokeStyle = owned ? COL.ownEdge : hot ? COL.hotEdge : COL.foeEdge;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(p.anchorX) + 0.5, Math.round(p.anchorY) + 0.5);
        ctx.lineTo(Math.round(midX) + 0.5, Math.round(p.rect.y + p.rect.h / 2) + 0.5);
        ctx.stroke();
      }
      // A dark plate behind the whole block, so it stays readable over texture.
      ctx.fillStyle = 'rgba(6, 9, 5, 0.55)';
      ctx.fillRect(p.rect.x - 2, p.rect.y - 2, p.rect.w + 4, p.rect.h + 4);

      // The badge rides at the top of the block — inside `rect`, so the
      // collision pass covers it.
      if (p.badge === 'hq') {
        drawHqBadge(ctx, midX, p.badgeY, p.badgePx, owned ? COL.head : ink);
      } else if (p.badge === 'keep') {
        drawKeepBadge(ctx, midX, p.badgeY, p.badgePx, owned ? COL.head : COL.danger);
      }

      drawPixelText(
        ctx,
        p.name,
        Math.round(midX - measurePixelText(p.name, p.nameScale) / 2),
        p.nameY,
        p.nameScale,
        ink,
      );
      if (p.tag) {
        drawPixelText(
          ctx,
          p.tag,
          Math.round(midX - measurePixelText(p.tag, 1) / 2),
          p.tagY,
          1,
          owned ? COL.head : hot ? COL.bright : COL.dim,
        );
      }
      // Battle scars: one tick per attempt, capped at five, along the foot.
      if (p.scarY !== null) {
        ctx.fillStyle = owned ? COL.head : COL.danger;
        const x0 = Math.round(midX - (p.scars * 3 - 1) / 2);
        for (let i = 0; i < p.scars; i++) ctx.fillRect(x0 + i * 3, p.scarY, 1, 3);
      }
    }

    this.overlay = canvas;
    this.overlayKey = key;
    return canvas;
  }

  /**
   * The live layer: the pulse on every border you could cross this turn, plus
   * the hover / selected outline. Drawn straight to the screen so it can animate
   * without touching a cache.
   */
  private drawFront(
    ctx: CanvasRenderingContext2D,
    l: CampaignLayout,
    cs: CampaignState,
  ): void {
    const pulse = 0.55 + 0.45 * Math.sin(this.frame * 0.09);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const r of REGIONS) {
      if (!canAttack(cs, r.id)) continue;
      // A subtle fill breath, so an invadable territory reads even when the
      // shared border is short.
      this.trace(ctx, l, r.points, true);
      ctx.globalAlpha = 0.06 + 0.09 * pulse;
      ctx.fillStyle = COL.hotEdge;
      ctx.fill();
      ctx.globalAlpha = 1;

      // The line you would actually cross: the border with your own ground.
      const t = TERRITORIES.find((x) => x.id === r.id);
      if (!t) continue;
      ctx.strokeStyle = COL.hotInk;
      ctx.lineWidth = Math.max(2, l.unit * 0.34);
      ctx.globalAlpha = 0.35 + 0.65 * pulse;
      for (const n of t.adjacent) {
        if (!isOwned(cs, n)) continue;
        for (const line of sharedBorder(r.id, n)) {
          this.trace(ctx, l, line, false);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    const focus = this.selected ?? this.hover;
    if (focus) {
      const r = regionOf(focus);
      if (r) {
        this.trace(ctx, l, r.points, true);
        ctx.strokeStyle = this.selected === focus ? COL.bright : COL.text;
        ctx.lineWidth = Math.max(2, l.unit * 0.3);
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
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

// ---------------------------------------------------------------------------
// Badges + layer plumbing
// ---------------------------------------------------------------------------

/** An offscreen layer, or null where there is no DOM to make one in. */
function makeLayer(size: number): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
  } catch {
    return null;
  }
}

/**
 * HQ: a command pip — HARROW LANDING's marker. `cx` is the block's centre and
 * `topY` its top edge, so the emblem occupies exactly the `px * 7` x `px * 5`
 * the label placement reserved for it.
 */
function drawHqBadge(
  ctx: CanvasRenderingContext2D,
  cx: number,
  topY: number,
  px: number,
  color: string,
): void {
  const x = Math.round(cx - px * 3.5);
  const y = Math.round(topY);
  ctx.fillStyle = color;
  ctx.fillRect(x + px * 3, y, px, px);
  ctx.fillRect(x + px, y + px, px * 5, px);
  ctx.fillRect(x + px * 2, y + px * 2, px, px);
  ctx.fillRect(x + px * 4, y + px * 2, px, px);
  ctx.fillRect(x + px, y + px * 4, px * 5, px);
}

/** Stronghold: a crenellated keep — OBSIDIAN CROWN's marker. `px * 7` x `px * 6`. */
function drawKeepBadge(
  ctx: CanvasRenderingContext2D,
  cx: number,
  topY: number,
  px: number,
  color: string,
): void {
  const x = Math.round(cx - px * 3.5);
  const y = Math.round(topY);
  ctx.fillStyle = color;
  ctx.fillRect(x + px, y, px, px);
  ctx.fillRect(x + px * 3, y, px, px);
  ctx.fillRect(x + px * 5, y, px, px);
  ctx.fillRect(x + px, y + px, px * 5, px * 4);
  ctx.fillStyle = 'rgba(6, 9, 5, 0.8)';
  ctx.fillRect(x + px * 3, y + px * 2, px, px * 3);
}

/** Re-exported so harnesses can walk the same regions the screen draws. */
export type { TheaterRegion };
