/**
 * Chrono campaign map (C3) — the screen between the title and the briefing when
 * the second campaign is running.
 *
 * The conquest campaign draws a continent; this one draws **time**. A single
 * horizontal timeline flows left (1916) to right (2077), divided into four era
 * bands washed in that era's own C2 ground colour, with the thirteen moments
 * sitting on it as **chrono gates** — rings you travel through — joined by
 * temporal streams. The PRESENT DAY anchor is marked; secured moments burn
 * gold, open ones pulse, locked ones sit dark, and the ORIGIN MOMENT hangs off
 * the far end of the line as a sealed anomaly until enough of the timeline is
 * yours.
 *
 * Same discipline as `title.ts` / `briefing.ts` / `debrief.ts` / `campaign.ts`:
 *
 *   - **render-side only.** It reads a `ChronoState` and never a `GameState`;
 *     it mutates nothing but its own plate/confirm bookkeeping and its two draw
 *     caches, and it hands every decision back to `main.ts` as a
 *     `ChronoAction`.
 *   - **its own frame counter.** The pulse and the stream drift run off
 *     `this.frame`, never `state.tick` — while the phase is 'chrono' the sim is
 *     frozen exactly as it is on the title screen.
 *   - **layout is a pure function** (`chronoLayout`, `chronoBands`,
 *     `chronoLabels`, `momentAt`, `insertionLines`, `insertionLayout`), so the
 *     headless smoke can assert that nothing goes NaN or negative, that every
 *     gate hit-tests back to itself at any window size, and that no two labels
 *     ever overlap.
 */

import { makeRng } from '../engine/rng';
import type { InputSnapshot } from '../engine/input';
import {
  ANCHOR_MOMENT,
  MOMENTS,
  MOMENT_COUNT,
  ORIGIN_MOMENT,
  ORIGIN_REQUIREMENT,
  TIMELINE_SPACE,
  canEnter,
  enterable as enterableIds,
  isSecured,
  moment,
  originGated,
  originShortfall,
  recordFor,
  securedCount,
  type ChronoBattleConfig,
  type ChronoState,
  type Moment,
} from '../game/chrono';
import { ERAS, type EraId } from '../game/eras';
import { debriefRows, missionTime } from './debrief';
import { drawPixelText, measurePixelText } from './sprites';
import type { ChronoAction } from './title';

const COL = {
  ink: '#05070c',
  // The void the timeline runs through — colder and emptier than the conquest
  // map's ocean, because this is not a place.
  voidDeep: '#04060b',
  voidMid: '#070c16',
  voidLit: '#0b1422',
  spark: '#1b3a55',
  panel: 'rgba(7, 10, 16, 0.94)',
  plate: 'rgba(9, 12, 18, 0.96)',
  edge: '#30405a',
  head: '#4fd6e8',
  headShadow: '#12495a',
  text: '#bcd2e0',
  dim: '#65798c',
  bright: '#e6f6ff',
  on: '#8dff6a',
  // The spine and the streams.
  spine: 'rgba(120, 190, 220, 0.22)',
  stream: 'rgba(96, 150, 185, 0.35)',
  streamLit: 'rgba(224, 181, 60, 0.75)',
  // Gate states. Gold = yours, crimson = The Order's, violet = the anomaly.
  own: '#e0b53c',
  ownInk: '#f7e6ad',
  foe: '#6a1f15',
  foeInk: '#94818a',
  hot: '#e05238',
  hotInk: '#ffd6cb',
  sealed: '#8a5cd6',
  sealedInk: '#d9c4ff',
  danger: '#ff5a48',
} as const;

/**
 * Band wash per era, matching the C2 ground ramps (`trenchMud` brown-olive,
 * `steelWinter` pale grey, `siliconDesert` sand, `futureNeon` dark teal). The
 * real ramps live in `sprites.ts` as terrain colours; these are the map's
 * shorthand for them, so a band reads as the ground you will fight on.
 */
const BAND_WASH: Record<EraId, string> = {
  trench: '#4a3a22',
  steel: '#5c686c',
  silicon: '#6d5c39',
  future: '#1f3a4a',
};

/** Era bands, west (earliest) to east. Every moment sits inside its own band. */
export interface EraBand {
  era: EraId;
  /** Timeline-space x range. */
  x0: number;
  x1: number;
  /** `1943 - THE STEEL WINTER`. */
  title: string;
}

/** `THE STEEL WINTER, 1943` -> `1943 - THE STEEL WINTER`. */
export function eraBandTitle(era: EraId): string {
  const def = ERAS[era];
  const name = (def.label.split(',')[0] ?? def.label).trim();
  return `${def.year} - ${name}`;
}

export const BANDS: readonly EraBand[] = [
  { era: 'trench', x0: 0, x1: 22, title: eraBandTitle('trench') },
  { era: 'steel', x0: 22, x1: 45, title: eraBandTitle('steel') },
  { era: 'silicon', x0: 45, x1: 67, title: eraBandTitle('silicon') },
  // The future band is the widest because the ORIGIN MOMENT hangs off its far
  // end: the anomaly wears 2077's ground, so it belongs to this band.
  { era: 'future', x0: 67, x1: 100, title: eraBandTitle('future') },
];

export const CHRONO_TITLE = 'CHRONO CAMPAIGN';
export const CHRONO_HINT = 'CLICK AN OPEN CHRONO GATE TO INSERT   T MENU   M MUTE';
export const RESET_LABEL = 'RESET TIMELINE';
export const RESET_CONFIRM_LABEL = 'CONFIRM WIPE?';
export const COMPLETE_TITLE = 'TIMELINE SECURED';
export const COMPLETE_PROMPT = 'R - NEW TIMELINE';
export const COMPLETE_TITLE_PROMPT = 'T - RETURN TO COMMAND';
export const PLATE_LAUNCH = 'LAUNCH INSERTION';
export const PLATE_CANCEL = 'CANCEL';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChronoLayout {
  /** Body font scale in device px per font pixel. */
  scale: number;
  headScale: number;
  headY: number;
  progressY: number;
  /**
   * The rect the 0..100 x 0..100 timeline space is mapped into. Unlike the
   * conquest map it is deliberately **not** square: a timeline is wide.
   */
  mapX: number;
  mapY: number;
  mapW: number;
  mapH: number;
  /** Device px per timeline unit, per axis (they differ; see above). */
  ux: number;
  uy: number;
  /** Gate ring radius, device px. */
  nodeR: number;
  /** Band header baseline, and the scale it is drawn at. */
  bandY: number;
  bandScale: number;
  hintY: number;
  reset: Rect;
  back: Rect;
}

const PAD = 14;
/** Room reserved at the top of the map rect for the era band headers. */
const BAND_HEAD_H = 16;

/** Geometry for a window. Pure — the render smoke asserts on it directly. */
export function chronoLayout(w: number, h: number): ChronoLayout {
  const scale = w >= 1100 && h >= 720 ? 2 : 1;
  const headScale = w >= 900 ? 4 : w >= 620 ? 3 : 2;
  const bandScale = 1;

  const headY = PAD;
  const progressY = headY + headScale * 8 + 6;
  const top = progressY + scale * 9 + 8;

  const btnH = Math.max(18, scale * 11);
  const hintY = Math.max(top + 1, h - PAD - 10);
  const bottom = hintY - 10 - btnH - 6;

  const mapX = PAD;
  const mapW = Math.max(60, w - PAD * 2);
  const mapY = top;
  const mapH = Math.max(50, bottom - top);

  const ux = mapW / TIMELINE_SPACE;
  const uy = mapH / TIMELINE_SPACE;
  // Big enough to click at 640x480, small enough that thirteen of them never
  // crowd the line at 1920x1080.
  const nodeR = Math.max(6, Math.min(18, Math.round(Math.min(ux * 2.6, uy * 5))));

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
    mapW,
    mapH,
    ux,
    uy,
    nodeR,
    bandY: mapY + 2,
    bandScale,
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

/** Timeline space -> device px. */
export function sx(l: ChronoLayout, tx: number): number {
  return l.mapX + tx * l.ux;
}
export function sy(l: ChronoLayout, ty: number): number {
  return l.mapY + ty * l.uy;
}

/** Where a gate is drawn, device px. */
export function nodeCenter(l: ChronoLayout, m: Moment): { x: number; y: number } {
  return { x: sx(l, m.tx), y: sy(l, m.ty) };
}

/** The band rects, device px, in timeline order. */
export function chronoBands(l: ChronoLayout): (EraBand & Rect)[] {
  return BANDS.map((b) => ({
    ...b,
    x: sx(l, b.x0),
    y: l.mapY,
    w: (b.x1 - b.x0) * l.ux,
    h: l.mapH,
  }));
}

/**
 * The gate under a device-px point, or null. Circular hit test with a little
 * slack, nearest centre wins — a timeline has no faces to fall inside, so this
 * is proximity rather than containment.
 */
export function momentAt(l: ChronoLayout, x: number, y: number): string | null {
  if (l.ux <= 0 || l.uy <= 0) return null;
  const r = l.nodeR + 4;
  let best: string | null = null;
  let bestD = r * r;
  for (const m of MOMENTS) {
    const c = nodeCenter(l, m);
    const d = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
    if (d <= bestD) {
      bestD = d;
      best = m.id;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Temporal streams
// ---------------------------------------------------------------------------

/** A drawn stream between two gates, sampled in timeline space at load. */
export interface Stream {
  from: string;
  to: string;
  points: readonly (readonly [number, number])[];
}

const STREAM_STEPS = 14;

/**
 * A gentle cubic between two gates, bowing along the time axis so a stream
 * leaves a gate horizontally (time is the x axis; a stream that left vertically
 * would read as a wire rather than as a flow of time).
 */
function streamPoints(a: Moment, b: Moment): [number, number][] {
  const bow = (b.tx - a.tx) * 0.45;
  const c1: [number, number] = [a.tx + bow, a.ty];
  const c2: [number, number] = [b.tx - bow, b.ty];
  const out: [number, number][] = [];
  for (let i = 0; i <= STREAM_STEPS; i++) {
    const t = i / STREAM_STEPS;
    const u = 1 - t;
    const x =
      u * u * u * a.tx + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b.tx;
    const y =
      u * u * u * a.ty + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b.ty;
    out.push([x, y]);
  }
  return out;
}

/**
 * Every unlock edge, as a drawn stream. Built once at module load — the gates
 * never move, so neither do the streams.
 */
export const STREAMS: readonly Stream[] = (() => {
  const out: Stream[] = [];
  for (const m of MOMENTS) {
    for (const r of m.requires) {
      const from = moment(r);
      if (!from) continue;
      out.push({ from: r, to: m.id, points: streamPoints(from, m) });
    }
  }
  return out;
})();

function distToSegment(
  px: number,
  py: number,
  a: readonly [number, number],
  b: readonly [number, number],
  yScale: number,
): number {
  const dx = b[0] - a[0];
  const dy = (b[1] - a[1]) * yScale;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * yScale * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a[0] + t * dx), (py - a[1]) * yScale - t * dy);
}

/**
 * Anisotropy used when measuring "how close is that stream to this gate": the
 * map rect is roughly twice as wide as it is tall, so a y unit is worth about
 * half an x unit on screen.
 */
const Y_SQUASH = 0.55;
/** Clearance a stream must keep from a gate it does not touch, timeline units. */
const STREAM_CLEARANCE = 4;

/**
 * Proved once at module load, exactly like `assertTheater()`: every gate sits
 * inside its own era band, the bands tile the whole timeline without gaps or
 * overlaps, and no stream passes close enough to an unrelated gate to read as
 * connected to it. Thirteen nodes and fourteen streams — microseconds, and it
 * turns an authoring slip into a throw instead of a map that lies about what
 * unlocks what.
 */
function assertTimelineArt(): void {
  let cursor = 0;
  for (const b of BANDS) {
    if (b.x0 !== cursor) throw new Error(`chrono art: band ${b.era} does not abut its neighbour`);
    if (b.x1 <= b.x0) throw new Error(`chrono art: band ${b.era} is degenerate`);
    cursor = b.x1;
  }
  if (cursor !== TIMELINE_SPACE) throw new Error('chrono art: bands do not fill the timeline');

  for (const m of MOMENTS) {
    const band = BANDS.find((b) => m.tx >= b.x0 && m.tx <= b.x1);
    if (!band) throw new Error(`chrono art: ${m.id} is in no band`);
    if (band.era !== m.era) {
      throw new Error(`chrono art: ${m.id} (${m.era}) is drawn in the ${band.era} band`);
    }
  }

  for (const s of STREAMS) {
    for (const m of MOMENTS) {
      if (m.id === s.from || m.id === s.to) continue;
      for (let i = 0; i < s.points.length - 1; i++) {
        const d = distToSegment(
          m.tx,
          m.ty,
          s.points[i] as [number, number],
          s.points[i + 1] as [number, number],
          Y_SQUASH,
        );
        if (d < STREAM_CLEARANCE) {
          throw new Error(
            `chrono art: stream ${s.from}->${s.to} passes ${d.toFixed(2)} from ${m.id}`,
          );
        }
      }
    }
  }
}
assertTimelineArt();

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type GateState = 'anchor' | 'held' | 'open' | 'locked' | 'sealed';

/** What a gate is, right now. Pure; the ring, the label and the plate all read it. */
export function gateState(cs: ChronoState, id: string): GateState {
  if (isSecured(cs, id)) return id === ANCHOR_MOMENT ? 'anchor' : 'held';
  if (canEnter(cs, id)) return 'open';
  if (id === ORIGIN_MOMENT && originGated(cs)) return 'sealed';
  return 'locked';
}

/** The second line under a gate's name. */
export function gateTag(cs: ChronoState, id: string): string {
  const m = moment(id);
  if (!m) return '';
  const year = m.yearLabel;
  switch (gateState(cs, id)) {
    case 'anchor':
      return `${year} ANCHOR`;
    case 'held':
      return `${year} HELD`;
    case 'open': {
      const rec = recordFor(cs, id);
      return rec.fought > 0 ? `${year} - ${rec.fought} TRIED` : `${year} OPEN`;
    }
    case 'sealed':
      return `${year} - ${originShortfall(cs)} MORE`;
    default:
      return `${year} LOCKED`;
  }
}

/**
 * A resolved gate label. `rect` is the **whole block** — name, tag and battle
 * scars — already nudged clear of every other label *and* of the era band
 * headers, and clamped inside the map rect. Everything drawn is inside that
 * rect, which is what makes the collision pass mean something (the V3.1 lesson,
 * applied before it could bite).
 */
export interface LabelPlacement {
  id: string;
  name: string;
  tag: string | null;
  nameScale: number;
  rect: Rect;
  nameY: number;
  tagY: number;
  scarY: number | null;
  scars: number;
  /** The gate's own centre, device px. */
  anchorX: number;
  anchorY: number;
  /** True when the block had to leave the gate and needs a leader line. */
  leader: boolean;
}

/** Gap kept between two label blocks, device px. */
const LABEL_GAP = 3;
/** Line spacing inside a block, device px. */
const LABEL_LEAD = 2;

/**
 * Where every gate's name goes, at this window size and this campaign.
 *
 * **The rules, in order** (the same shape as the conquest map's, adapted from
 * "inside my region" to "beside my gate", because a node has no interior):
 *
 *  1. The band headers are reserved **first**, so a name can never land on
 *     `1943 - THE STEEL WINTER`.
 *  2. **One name scale for the whole map**, chosen so that no name is wider
 *     than the narrowest era band. Mixing 1x and 2x type across one map reads
 *     as a mistake rather than as a hierarchy.
 *  3. The tag is a second line only when it fits the same width budget.
 *  4. The reserved rect is the whole block, scars included.
 *  5. Blocks are placed in timeline order, first below the gate (or above it
 *     for the bottom lane, so a label never hangs off the line into the
 *     footer), then over a deterministic ring search, then over an exhaustive
 *     grid scan. Every candidate is clamped inside the map rect first, so a
 *     label can never leave the window.
 *  6. If the accepted block ends up far from its gate, `leader` is set and a
 *     thin line is drawn back to the ring.
 *
 * Pure, so the label collision harness can assert directly on the result across
 * window sizes and campaign states.
 */
export function chronoLabels(l: ChronoLayout, cs: ChronoState): LabelPlacement[] {
  const placed: Rect[] = [];
  const out: LabelPlacement[] = [];
  const x0 = l.mapX;
  const y0 = l.mapY;
  const x1 = l.mapX + l.mapW;
  const y1 = l.mapY + l.mapH;

  // 1. Reserve the band headers.
  for (const b of chronoBands(l)) {
    const tw = measurePixelText(b.title, l.bandScale);
    placed.push({
      x: Math.round(b.x + 4),
      y: Math.round(l.bandY),
      w: Math.min(tw, Math.max(4, b.w - 8)),
      h: l.bandScale * 7,
    });
  }

  // 2. One scale for every name: it must fit the narrowest band.
  const narrowest = BANDS.reduce((n, b) => Math.min(n, (b.x1 - b.x0) * l.ux), Infinity);
  const widestName = MOMENTS.reduce((n, m) => Math.max(n, measurePixelText(m.name, 1)), 0);
  const nameScale = l.scale > 1 && widestName * l.scale <= narrowest ? l.scale : 1;

  for (const m of MOMENTS) {
    const name = m.name;
    const nameW = measurePixelText(name, nameScale);
    const nameH = nameScale * 7;
    const tagText = gateTag(cs, m.id);
    const tagW = measurePixelText(tagText, 1);
    const tag = tagW <= Math.max(nameW, narrowest) ? tagText : null;

    const scars = Math.min(5, recordFor(cs, m.id).fought);
    const scarH = scars > 0 ? 5 : 0;

    const w = Math.max(nameW, tag ? tagW : 0);
    const h = nameH + (tag ? LABEL_LEAD + 7 : 0) + scarH;
    const c = nodeCenter(l, m);

    const fit = (px: number, py: number): Rect => ({
      x: Math.round(Math.max(x0 + 1, Math.min(x1 - w - 1, px))),
      y: Math.round(Math.max(y0 + 1, Math.min(y1 - h - 1, py))),
      w,
      h,
    });
    const free = (rect: Rect): boolean => !placed.some((p) => overlaps(rect, p, LABEL_GAP));

    // A gate in the lower half hangs its label above itself and one in the
    // upper half below, so labels always fall toward the middle of the rect.
    const below = m.ty < 50;
    const gap = l.nodeR + 5;
    let rect = fit(c.x - w / 2, below ? c.y + gap : c.y - gap - h);
    if (!free(rect)) {
      const other = fit(c.x - w / 2, below ? c.y - gap - h : c.y + gap);
      if (free(other)) rect = other;
      else {
        const step = Math.max(6, Math.round(l.nodeR));
        const maxR = Math.max(step * 3, Math.round(l.mapW * 0.5));
        let found = false;
        search: for (let rad = step; rad <= maxR; rad += step) {
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * Math.PI * 2;
            const cand = fit(c.x - w / 2 + Math.cos(a) * rad, c.y - h / 2 + Math.sin(a) * rad);
            if (free(cand)) {
              rect = cand;
              found = true;
              break search;
            }
          }
        }
        if (!found) {
          // Exhaustive fallback for a map rect barely taller than the type.
          const rowH = Math.max(2, h + LABEL_GAP);
          const colW = Math.max(3, Math.round(w / 4));
          pack: for (let gy = y0 + 1; gy <= y1 - h - 1; gy += rowH) {
            for (let gx = x0 + 1; gx <= x1 - w - 1; gx += colW) {
              const cand = fit(gx, gy);
              if (free(cand)) {
                rect = cand;
                break pack;
              }
            }
          }
        }
      }
    }
    placed.push(rect);

    const midX = rect.x + rect.w / 2;
    const midY = rect.y + rect.h / 2;
    const leader = Math.hypot(midX - c.x, midY - c.y) > l.nodeR + h + 8;

    out.push({
      id: m.id,
      name,
      tag,
      nameScale,
      rect,
      nameY: rect.y,
      tagY: rect.y + nameH + LABEL_LEAD,
      scarY: scars > 0 ? rect.y + h - 3 : null,
      scars,
      anchorX: c.x,
      anchorY: c.y,
      leader,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Insertion plate
// ---------------------------------------------------------------------------

export interface PlateLayout {
  panel: Rect;
  launch: Rect;
  cancel: Rect;
  scale: number;
  lines: string[];
}

/** The plate's copy. Pure, so the smoke can read the exact strings. */
export function insertionLines(
  cfg: ChronoBattleConfig,
  record: { fought: number },
): string[] {
  const lines = [
    `INSERT INTO ${cfg.name}`,
    `${cfg.yearLabel} - ${eraBandTitle(cfg.era).split(' - ')[1] ?? cfg.era.toUpperCase()}`,
    `GATE DEPTH ${cfg.depth} - ${cfg.difficulty.toUpperCase()} GARRISON`,
    `ESTIMATED RESISTANCE: ${cfg.resistance}`,
    `ORDER RESERVES: +${cfg.aiCreditBonus} CR`,
  ];
  if (cfg.aiPrebuilt.length > 0) lines.push('DEFENCES ALREADY STANDING');
  if (cfg.aiAnomaly) lines.push('THE ORDER FIELDS EVERY ERA AT ONCE');
  if (record.fought > 0) lines.push(`PREVIOUS ATTEMPTS: ${record.fought}`);
  return lines;
}

/** Geometry for the insertion plate at a window size. Pure. */
export function insertionLayout(
  w: number,
  h: number,
  lines: readonly string[],
): PlateLayout {
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
// Void sparks (deterministic, animated off the render frame counter)
// ---------------------------------------------------------------------------

interface Spark {
  x: number;
  y: number;
  w: number;
  speed: number;
  lit: boolean;
}

const SPARKS: readonly Spark[] = (() => {
  const rng = makeRng(0x0c47072);
  const out: Spark[] = [];
  for (let i = 0; i < 96; i++) {
    out.push({
      x: rng.next(),
      y: rng.next(),
      w: rng.range(0.01, 0.05),
      speed: rng.range(0.0004, 0.0018),
      lit: rng.chance(0.3),
    });
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export class ChronoScreen {
  /** Render-rate counter — never the sim clock. */
  private frame = 0;
  /** Moment the insertion plate is open for, or null. */
  selected: string | null = null;
  /** RESET TIMELINE is one click in; a second click wipes. */
  resetArmed = false;
  private hover: string | null = null;

  /**
   * Two draw caches, the same split the conquest map uses:
   *
   *  - `bandsLayer` is the timeline itself — era washes, the spine, the band
   *    headers and the unlit streams. It depends on the map rect's size alone,
   *    so it survives every click and every insertion.
   *  - `overlay` is the state layer — gate rings, labels, scars and the lit
   *    streams. It depends on the size *and* a signature of the campaign, so it
   *    is rebuilt when (and only when) the timeline moves.
   *
   * What is left per frame is the void, two `drawImage`s, the pulse on the open
   * gates and the hover ring.
   */
  private bandsLayer: HTMLCanvasElement | null = null;
  private bandsKey = '';
  private overlay: HTMLCanvasElement | null = null;
  private overlayKey = '';

  /**
   * Supplied by `main.ts`: the configuration a moment would be fought under
   * right now. Injected rather than imported so the screen stays a pure view.
   */
  configFor: (momentId: string) => ChronoBattleConfig;

  constructor(configFor: (momentId: string) => ChronoBattleConfig) {
    this.configFor = configFor;
  }

  /** Entering the timeline afresh: no stale plate, no half-armed reset. */
  reset(): void {
    this.selected = null;
    this.resetArmed = false;
  }

  /**
   * The insertion plate's geometry right now, or null when none is open.
   * Computed on demand rather than cached from `draw`, so a click never depends
   * on a frame having been rendered first (the V3 lesson).
   */
  plateFor(cs: ChronoState, w: number, h: number): PlateLayout | null {
    const id = this.selected;
    if (id === null || !canEnter(cs, id)) return null;
    const cfg = this.configFor(id);
    return insertionLayout(w, h, insertionLines(cfg, recordFor(cs, id)));
  }

  // --- tick ---------------------------------------------------------------

  /**
   * Consume a tick's input. `main.ts` returns from the tick immediately after
   * calling this, so the screen swallows everything it sees.
   */
  update(snap: InputSnapshot, cs: ChronoState, w: number, h: number): ChronoAction | null {
    const l = chronoLayout(w, h);
    this.hover = momentAt(l, snap.pointer.x, snap.pointer.y);

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
        return { kind: 'select', moment: null };
      }
      return { kind: 'title' };
    }
    if (snap.pressed.has('KeyT')) return { kind: 'title' };

    if (
      this.selected !== null &&
      (snap.pressed.has('Enter') || snap.pressed.has('NumpadEnter') || snap.pressed.has('Space'))
    ) {
      const id = this.selected;
      if (canEnter(cs, id)) {
        this.reset();
        return { kind: 'enter', moment: id };
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
    cs: ChronoState,
    w: number,
    h: number,
    x: number,
    y: number,
  ): ChronoAction | null {
    const l = chronoLayout(w, h);
    // The plate is modal over the map: while it is up, only its own controls
    // and "anywhere else = dismiss" mean anything.
    const plate = this.plateFor(cs, w, h);
    if (plate) {
      const id = this.selected as string;
      if (inRect(plate.launch, x, y)) {
        this.reset();
        return { kind: 'enter', moment: id };
      }
      this.reset();
      return { kind: 'select', moment: null };
    }

    if (inRect(l.back, x, y)) return { kind: 'title' };

    if (inRect(l.reset, x, y)) {
      if (this.resetArmed) {
        this.reset();
        return { kind: 'reset' };
      }
      this.resetArmed = true;
      return null;
    }
    // Any click that is not on the reset control disarms it.
    this.resetArmed = false;

    const hit = momentAt(l, x, y);
    if (hit !== null && canEnter(cs, hit)) {
      this.selected = hit;
      return { kind: 'select', moment: hit };
    }
    if (this.selected !== null) {
      this.selected = null;
      return { kind: 'select', moment: null };
    }
    return null;
  }

  // --- draw ---------------------------------------------------------------

  draw(
    ctx: CanvasRenderingContext2D,
    terrain: HTMLCanvasElement | null,
    w: number,
    h: number,
    cs: ChronoState,
  ): void {
    this.frame++;
    this.drawVoid(ctx, terrain, w, h);

    if (cs.result === 'victory') {
      this.drawComplete(ctx, w, h, cs);
      this.drawScanlines(ctx, w, h);
      return;
    }

    const l = chronoLayout(w, h);
    this.drawHeader(ctx, l, w, cs);
    this.drawTimeline(ctx, l, cs);
    this.drawControls(ctx, l, w, h);

    const plate = this.plateFor(cs, w, h);
    if (plate && this.selected !== null) {
      this.drawPlate(ctx, plate, this.configFor(this.selected));
    }

    this.drawScanlines(ctx, w, h);
  }

  /**
   * The void the gate looks into: three flat tones, the composited terrain
   * layer drifting *sideways* at 5% (time running past, rather than the
   * conquest map's sea floor) and a scatter of sparks.
   */
  private drawVoid(
    ctx: CanvasRenderingContext2D,
    terrain: HTMLCanvasElement | null,
    w: number,
    h: number,
  ): void {
    ctx.fillStyle = COL.voidDeep;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = COL.voidMid;
    ctx.fillRect(0, Math.round(h * 0.1), w, Math.round(h * 0.8));
    ctx.fillStyle = COL.voidLit;
    ctx.fillRect(0, Math.round(h * 0.3), w, Math.round(h * 0.4));

    if (terrain && terrain.width > 0) {
      const drift = this.frame * 0.9;
      const maxX = Math.max(0, terrain.width - w);
      const ox = maxX > 0 ? (drift % maxX | 0) : 0;
      const sw = Math.min(w, terrain.width - ox);
      const sh = Math.min(h, terrain.height);
      if (sw > 0 && sh > 0) {
        ctx.globalAlpha = 0.05;
        ctx.drawImage(terrain, ox, 0, sw, sh, 0, 0, sw, sh);
        ctx.globalAlpha = 1;
      }
    }

    const th = Math.max(1, Math.round(h * 0.003));
    for (const s of SPARKS) {
      const x = ((s.x + s.speed * this.frame) % 1) * w;
      ctx.fillStyle = s.lit ? COL.spark : COL.voidLit;
      ctx.fillRect(Math.round(x), Math.round(s.y * h), Math.max(2, Math.round(s.w * w)), th);
    }
  }

  /** The CRT treatment the other screens share. */
  private drawScanlines(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, w, 4);
    ctx.fillRect(0, Math.max(0, h - 4), w, 4);
  }

  private drawHeader(
    ctx: CanvasRenderingContext2D,
    l: ChronoLayout,
    w: number,
    cs: ChronoState,
  ): void {
    const tw = measurePixelText(CHRONO_TITLE, l.headScale);
    const x = Math.round((w - tw) / 2);
    drawPixelText(ctx, CHRONO_TITLE, x + l.headScale, l.headY + l.headScale, l.headScale, COL.headShadow);
    drawPixelText(ctx, CHRONO_TITLE, x, l.headY, l.headScale, COL.head);

    const line =
      `MOMENTS ${securedCount(cs)}/${MOMENT_COUNT}   BATTLES ${cs.battlesFought}   ` +
      `WON ${cs.battlesWon}   GATES ${enterableIds(cs).length}`;
    const lw = measurePixelText(line, l.scale);
    drawPixelText(ctx, line, Math.round((w - lw) / 2), l.progressY, l.scale, COL.dim);
  }

  // --- the timeline -------------------------------------------------------

  private trace(
    ctx: CanvasRenderingContext2D,
    l: ChronoLayout,
    pts: readonly (readonly [number, number])[],
  ): void {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as readonly [number, number];
      const x = sx(l, p[0]);
      const y = sy(l, p[1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  private drawTimeline(
    ctx: CanvasRenderingContext2D,
    l: ChronoLayout,
    cs: ChronoState,
  ): void {
    const bands = this.bandsCache(l);
    if (bands) ctx.drawImage(bands, l.mapX, l.mapY);
    const overlay = this.overlayLayer(l, cs);
    if (overlay) ctx.drawImage(overlay, l.mapX, l.mapY);
    this.drawLive(ctx, l, cs);
  }

  /** Era washes, the spine, the band headers and the unlit streams. */
  private bandsCache(l: ChronoLayout): HTMLCanvasElement | null {
    const key = `${Math.round(l.mapW)}x${Math.round(l.mapH)}|${l.nodeR}`;
    if (this.bandsLayer && this.bandsKey === key) return this.bandsLayer;
    const canvas = makeLayer(Math.max(1, Math.round(l.mapW)), Math.max(1, Math.round(l.mapH)));
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    const ll: ChronoLayout = { ...l, mapX: 0, mapY: 0, bandY: 2 };

    // Era bands: a wash, a brighter head strip and a divider.
    for (const b of chronoBands(ll)) {
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = BAND_WASH[b.era];
      ctx.fillRect(Math.round(b.x), 0, Math.round(b.w), Math.round(l.mapH));
      ctx.globalAlpha = 0.3;
      ctx.fillRect(Math.round(b.x), 0, Math.round(b.w), BAND_HEAD_H);
      ctx.globalAlpha = 1;
      if (b.x0 > 0) {
        ctx.fillStyle = 'rgba(140, 190, 220, 0.16)';
        ctx.fillRect(Math.round(b.x), 0, 1, Math.round(l.mapH));
      }
      drawPixelText(ctx, b.title, Math.round(b.x + 4), ll.bandY, ll.bandScale, COL.dim);
    }

    // The spine: the line time itself runs along, with a tick under each gate.
    const spineY = Math.round(sy(ll, 50));
    ctx.fillStyle = COL.spine;
    ctx.fillRect(0, spineY, Math.round(l.mapW), 1);
    for (const m of MOMENTS) {
      const c = nodeCenter(ll, m);
      ctx.fillRect(Math.round(c.x), spineY - 3, 1, 7);
    }

    // Streams, unlit. The lit pass is in the overlay (it depends on the state).
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = COL.stream;
    ctx.lineWidth = Math.max(1, Math.round(l.nodeR * 0.18));
    for (const s of STREAMS) {
      this.trace(ctx, ll, s.points);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';

    this.bandsLayer = canvas;
    this.bandsKey = key;
    return canvas;
  }

  /** Gate rings, lit streams, labels and scars. Rebuilt when the timeline moves. */
  private overlayLayer(l: ChronoLayout, cs: ChronoState): HTMLCanvasElement | null {
    const key =
      `${Math.round(l.mapW)}x${Math.round(l.mapH)}|${l.scale}|${l.nodeR}|` +
      `${cs.secured.slice().sort().join(',')}|` +
      `${MOMENTS.map((m) => recordFor(cs, m.id).fought).join('')}`;
    if (this.overlay && this.overlayKey === key) return this.overlay;
    const canvas = makeLayer(Math.max(1, Math.round(l.mapW)), Math.max(1, Math.round(l.mapH)));
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    const ll: ChronoLayout = { ...l, mapX: 0, mapY: 0, bandY: 2 };

    // A stream out of ground you hold is a route you can actually travel.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = COL.streamLit;
    ctx.lineWidth = Math.max(1, Math.round(l.nodeR * 0.22));
    for (const s of STREAMS) {
      if (!isSecured(cs, s.from)) continue;
      this.trace(ctx, ll, s.points);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';

    for (const m of MOMENTS) {
      const c = nodeCenter(ll, m);
      this.drawGate(ctx, c.x, c.y, l.nodeR, gateState(cs, m.id), m.origin === true);
    }

    for (const p of chronoLabels(ll, cs)) {
      const st = gateState(cs, p.id);
      const ink =
        st === 'anchor' || st === 'held'
          ? COL.ownInk
          : st === 'open'
            ? COL.hotInk
            : st === 'sealed'
              ? COL.sealedInk
              : COL.foeInk;
      const midX = p.rect.x + p.rect.w / 2;
      if (p.leader) {
        ctx.strokeStyle = ink;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(p.anchorX) + 0.5, Math.round(p.anchorY) + 0.5);
        ctx.lineTo(Math.round(midX) + 0.5, Math.round(p.rect.y + p.rect.h / 2) + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = 'rgba(4, 7, 12, 0.62)';
      ctx.fillRect(p.rect.x - 2, p.rect.y - 2, p.rect.w + 4, p.rect.h + 4);

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
          st === 'anchor' || st === 'held'
            ? COL.own
            : st === 'open'
              ? COL.bright
              : st === 'sealed'
                ? COL.sealed
                : COL.dim,
        );
      }
      if (p.scarY !== null) {
        ctx.fillStyle = st === 'held' || st === 'anchor' ? COL.own : COL.danger;
        const sx0 = Math.round(midX - (p.scars * 3 - 1) / 2);
        for (let i = 0; i < p.scars; i++) ctx.fillRect(sx0 + i * 3, p.scarY, 1, 3);
      }
    }

    this.overlay = canvas;
    this.overlayKey = key;
    return canvas;
  }

  /**
   * One chrono gate: a portal ring. Secured gates are gold and filled, open
   * ones crimson, locked ones dark, the sealed anomaly violet with a bar across
   * it. The anomaly also carries four spokes, so it is never mistaken for an
   * ordinary moment.
   */
  private drawGate(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    st: GateState,
    origin: boolean,
  ): void {
    const edge =
      st === 'anchor' || st === 'held'
        ? COL.own
        : st === 'open'
          ? COL.hot
          : st === 'sealed'
            ? COL.sealed
            : COL.foe;
    const outer = origin ? r * 1.25 : r;

    // Hub.
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, outer - 2), 0, Math.PI * 2);
    ctx.fillStyle =
      st === 'anchor' || st === 'held'
        ? 'rgba(228, 184, 62, 0.30)'
        : st === 'open'
          ? 'rgba(214, 74, 48, 0.28)'
          : st === 'sealed'
            ? 'rgba(138, 92, 214, 0.24)'
            : 'rgba(60, 24, 20, 0.34)';
    ctx.fill();

    // Ring.
    ctx.strokeStyle = edge;
    ctx.lineWidth = Math.max(1, Math.round(outer * 0.22));
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, outer - 1), 0, Math.PI * 2);
    ctx.stroke();

    // Inner ring — the gate's aperture.
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, outer * 0.5), 0, Math.PI * 2);
    ctx.stroke();

    if (origin) {
      ctx.lineWidth = Math.max(1, Math.round(outer * 0.14));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * outer * 0.55, cy + Math.sin(a) * outer * 0.55);
        ctx.lineTo(cx + Math.cos(a) * outer * 1.35, cy + Math.sin(a) * outer * 1.35);
        ctx.stroke();
      }
    }
    if (st === 'sealed') {
      // A bar across a sealed gate: it exists, and it is shut.
      ctx.lineWidth = Math.max(1, Math.round(outer * 0.2));
      ctx.beginPath();
      ctx.moveTo(cx - outer, cy);
      ctx.lineTo(cx + outer, cy);
      ctx.stroke();
    }
    if (st === 'anchor') {
      // The PRESENT pip: a solid core, so the player's own time is obvious.
      ctx.fillStyle = COL.ownInk;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, outer * 0.26), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** The live layer: the pulse on every open gate, plus the hover ring. */
  private drawLive(
    ctx: CanvasRenderingContext2D,
    l: ChronoLayout,
    cs: ChronoState,
  ): void {
    const pulse = 0.55 + 0.45 * Math.sin(this.frame * 0.09);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const m of MOMENTS) {
      if (!canEnter(cs, m.id)) continue;
      const c = nodeCenter(l, m);
      const r = (m.origin === true ? l.nodeR * 1.25 : l.nodeR) + 3 + pulse * 3;
      ctx.strokeStyle = COL.hotInk;
      ctx.lineWidth = Math.max(1, l.nodeR * 0.2);
      ctx.globalAlpha = 0.3 + 0.6 * pulse;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const focus = this.selected ?? this.hover;
    if (focus) {
      const m = moment(focus);
      if (m) {
        const c = nodeCenter(l, m);
        ctx.strokeStyle = this.selected === focus ? COL.bright : COL.text;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(c.x, c.y, l.nodeR + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
  }

  private drawControls(
    ctx: CanvasRenderingContext2D,
    l: ChronoLayout,
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
      this.resetArmed ? 'CLICK RESET AGAIN TO WIPE THE TIMELINE SAVE' : CHRONO_HINT,
      Math.round(w / 2),
      Math.min(h - 4, l.hintY + 8),
    );
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  private drawPlate(
    ctx: CanvasRenderingContext2D,
    plate: PlateLayout,
    cfg: ChronoBattleConfig,
  ): void {
    const { panel, scale } = plate;
    ctx.fillStyle = COL.plate;
    ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
    ctx.strokeStyle = COL.edge;
    ctx.lineWidth = 2;
    ctx.strokeRect(panel.x + 1, panel.y + 1, Math.max(0, panel.w - 2), Math.max(0, panel.h - 2));
    ctx.fillStyle = cfg.origin ? COL.sealed : cfg.threat >= 0.8 ? COL.danger : COL.head;
    ctx.fillRect(panel.x + 1, panel.y + 1, Math.max(0, panel.w - 2), 2);

    let y = panel.y + scale * 9;
    plate.lines.forEach((line, i) => {
      const color =
        i === 0
          ? COL.head
          : i === 1
            ? COL.dim
            : i === 3
              ? cfg.threat >= 0.6
                ? COL.danger
                : COL.text
              : line.startsWith('THE ORDER FIELDS')
                ? COL.sealedInk
                : COL.text;
      drawPixelText(ctx, line, panel.x + scale * 10, y, scale, color);
      y += scale * 9;
    });

    const button = (r: Rect, label: string, color: string, edge: string): void => {
      ctx.fillStyle = 'rgba(28, 52, 74, 0.85)';
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
   * Campaign complete. The conquest map reuses the debriefing's furniture for
   * CONTINENT SECURED; this reuses exactly the same furniture again — same
   * panel, rule, two-column YOU/ORDER table and literally `debriefRows()` — so
   * finishing the timeline reads as the same kind of screen.
   */
  private drawComplete(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    cs: ChronoState,
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
    const line = `${MOMENT_COUNT} MOMENTS   ${cs.battlesFought} BATTLES   TIME ${missionTime(cs.ticks)}`;
    const contentW = Math.max(
      tableW,
      measurePixelText(COMPLETE_TITLE, headScale),
      measurePixelText(line, scale),
      measurePixelText(COMPLETE_PROMPT, scale),
      measurePixelText(COMPLETE_TITLE_PROMPT, scale),
    );
    const contentH =
      headScale * 10 + scale * 11 + scale * 8 + scale * 11 + rows.length * scale * 9 + scale * 10 + scale * 20;

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
    right('YOU', col1R, headerY, COL.own);
    right('ORDER', col2R, headerY, COL.hot);

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

/** An offscreen layer, or null where there is no DOM to make one in. */
function makeLayer(w: number, h: number): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  } catch {
    return null;
  }
}

/** Re-exported so harnesses can read the gate that a count gate is waiting on. */
export { ORIGIN_REQUIREMENT };
