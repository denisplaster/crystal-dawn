/**
 * Theater map geometry (V3.1) — the planar subdivision the conquest map screen
 * is drawn from.
 *
 * V3 drew the thirteen territories as separate rounded blobs floating on a dark
 * backdrop, with explicit "border links" between their centres standing in for
 * adjacency. The player's note was blunt — *"can you make it look like a world
 * map instead of shapes"* — so V3.1 replaces the blobs with **one continent**:
 * a single landmass on an ocean whose thirteen regions tessellate it exactly.
 *
 * ## How the tessellation is guaranteed
 *
 * The map is authored as a **planar subdivision**, not as thirteen independent
 * outlines:
 *
 *   - `NODES` is a shared vertex table in the same 0..100 continent space
 *     `game/campaign.ts` uses.
 *   - `RINGS` gives each territory as an ordered loop of *node ids*. Every ring
 *     is wound the same way (clockwise on screen, y down).
 *   - An **edge** is an unordered node pair. Both territories that use an edge
 *     read the *same* stored polyline for it, so a border is drawn once and
 *     shared: no gaps, no overlaps, no hairline seams — by construction rather
 *     than by careful authoring.
 *   - Edges used by **two** faces are interior borders; edges used by **one**
 *     are the coastline. `assertTheater()` proves at module load that the
 *     interior edge set is **exactly** the adjacency graph in `campaign.ts`
 *     (26 edges, both directions), that no edge is used more than twice, and
 *     that the coastline is a single closed cycle.
 *
 * Straight node-to-node segments would read as a subdivided rectangle, so every
 * edge is roughened by **midpoint displacement seeded from the edge key** —
 * deterministic at module load, no entropy, and shared between the two faces,
 * which is what keeps the tessellation exact while the borders look organic.
 *
 * ## Why the geometry lives render-side
 *
 * `game/campaign.ts` is untouched: it is pure data + logic and the campaign
 * harnesses assert on it directly. A drawing's vertices are render data, so
 * they live here. The one link back is an assertion — every territory's
 * authored `cx`/`cy` anchor must fall inside its new region, so the west-to-east
 * arrangement the campaign was designed around cannot silently drift.
 */

import { makeRng } from '../engine/rng';
import { MAP_SPACE, TERRITORIES, tierOf } from '../game/campaign';

/** A point in the 0..100 continent space. */
export type Pt = readonly [number, number];

// ---------------------------------------------------------------------------
// The vertex table
// ---------------------------------------------------------------------------

/**
 * Six columns of land, west (home) to east (the stronghold).
 *
 * `l<n>*` nodes sit on the five interior column boundaries (L1 x=23, L2 x=40,
 * L3 x=57, L4 x=73, L5 x=87); `c*` nodes are coastline. The horizontal splits
 * inside neighbouring columns **interleave** down each boundary — e.g. on L3 the
 * order is salt|dry (31), cinder|vulture (38), dry|ironwash (65),
 * vulture|glass (72) — which is exactly what makes THE DRY MARCH border both
 * CINDER STEPPE and VULTURE GAP while SALT VERGE borders only CINDER STEPPE.
 * The brick-wall offset *is* the adjacency graph.
 */
const NODES: Record<string, Pt> = {
  // North coast, west to east: a headland at CINDER STEPPE, a bay biting into
  // SALT VERGE, and the coast receding again before the eastern cape.
  cnw1: [11, 30],
  cn1: [17, 22],
  l1n: [24, 17],
  cn2: [31, 13],
  l2n: [40, 11],
  cn3: [47, 17],
  l3n: [56, 9],
  cn4: [64, 6],
  l4n: [73, 13],
  cn5: [80, 11],
  l5n: [87, 21],
  // The eastern highland cape: OBSIDIAN CROWN's own coast, the furthest land
  // from HARROW LANDING on the whole continent.
  ce1: [93, 27],
  ce2: [98, 40],
  ce3: [99, 53],
  ce4: [97, 67],
  ce5: [92, 79],
  ce6: [89, 85],
  // South coast, east to west: a headland under GLASS BASIN, a bay in IRONWASH.
  l5s: [87, 88],
  cs5: [80, 93],
  l4s: [73, 91],
  cs4: [65, 96],
  l3s: [56, 92],
  cs3: [47, 85],
  l2s: [40, 90],
  cs2: [31, 87],
  l1s: [24, 83],
  cs1: [16, 81],
  // West coast — HARROW LANDING's beachhead, the only deep-water landing.
  csw1: [10, 74],
  cw2: [6, 64],
  cw1: [3, 50],
  cnw0: [6, 38],

  // Interior junctions, per column boundary (top to bottom). The x of each node
  // wanders a couple of units off its column so a boundary meanders like a
  // watershed instead of ruling a straight line down the map.
  l1b: [22, 48], // ashen | karst
  l2c1: [41, 29], // salt | dry
  l2b: [39, 45], // ashen | karst
  l2c2: [41, 63], // dry | ironwash
  l3c1: [59, 31], // salt | dry
  l3d1: [58, 38], // cinder | vulture
  l3c2: [55, 65], // dry | ironwash
  l3d2: [57, 72], // vulture | glass
  l4d1: [75, 31], // cinder | vulture
  l4e1: [74, 38], // rift | blackspine
  l4d2: [71, 63], // vulture | glass
  l4e2: [73, 70], // blackspine | ember
  l5e1: [88, 42], // rift | blackspine
  l5e2: [86, 71], // blackspine | ember
};
/**
 * Each territory as a clockwise loop of node ids. Consecutive pairs are edges;
 * an edge shared by two rings is a border, an edge used once is coast.
 */
const RINGS: Record<string, readonly string[]> = {
  harrow: ['cnw1', 'cn1', 'l1n', 'l1b', 'l1s', 'cs1', 'csw1', 'cw2', 'cw1', 'cnw0'],
  ashen: ['l1n', 'cn2', 'l2n', 'l2c1', 'l2b', 'l1b'],
  karst: ['l1b', 'l2b', 'l2c2', 'l2s', 'cs2', 'l1s'],
  salt: ['l2n', 'cn3', 'l3n', 'l3c1', 'l2c1'],
  dry: ['l2c1', 'l3c1', 'l3d1', 'l3c2', 'l2c2', 'l2b'],
  ironwash: ['l2c2', 'l3c2', 'l3d2', 'l3s', 'cs3', 'l2s'],
  cinder: ['l3n', 'cn4', 'l4n', 'l4d1', 'l3d1', 'l3c1'],
  vulture: ['l3d1', 'l4d1', 'l4e1', 'l4d2', 'l3d2', 'l3c2'],
  glass: ['l3d2', 'l4d2', 'l4e2', 'l4s', 'cs4', 'l3s'],
  rift: ['l4n', 'cn5', 'l5n', 'l5e1', 'l4e1', 'l4d1'],
  blackspine: ['l4e1', 'l5e1', 'l5e2', 'l4e2', 'l4d2'],
  ember: ['l4e2', 'l5e2', 'l5s', 'cs5', 'l4s'],
  crown: ['l5n', 'ce1', 'ce2', 'ce3', 'ce4', 'ce5', 'ce6', 'l5s', 'l5e2', 'l5e1'],
};

// ---------------------------------------------------------------------------
// Roughening
// ---------------------------------------------------------------------------

/** Subdivision passes per edge: 3 -> 8 segments. */
const ROUGH_DEPTH = 3;
/** Keep every generated vertex inside the drawable square. */
const CLAMP_LO = 0.4;
const CLAMP_HI = MAP_SPACE - 0.4;

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** FNV-1a over the edge key — the whole "seed" of the coastline. */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function clamp(v: number): number {
  return v < CLAMP_LO ? CLAMP_LO : v > CLAMP_HI ? CLAMP_HI : v;
}

/**
 * Midpoint-displace `a -> b` and return the **interior** points only (the
 * endpoints stay exactly on their shared nodes, so neighbouring edges always
 * meet). Seeded from the edge key, so the two faces sharing an edge compute the
 * identical polyline — and so do two runs of the program.
 */
function roughen(a: Pt, b: Pt, key: string, coast: boolean): Pt[] {
  const rng = makeRng(hashKey(key));
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let amp = Math.min(len * (coast ? 0.2 : 0.13), coast ? 3.4 : 2);
  let pts: [number, number][] = [
    [a[0], a[1]],
    [b[0], b[1]],
  ];
  for (let d = 0; d < ROUGH_DEPTH; d++) {
    const next: [number, number][] = [pts[0] as [number, number]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i] as [number, number];
      const q = pts[i + 1] as [number, number];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const l = Math.hypot(dx, dy) || 1;
      const off = (rng.next() * 2 - 1) * amp;
      next.push([
        clamp((p[0] + q[0]) / 2 + (-dy / l) * off),
        clamp((p[1] + q[1]) / 2 + (dx / l) * off),
      ]);
      next.push(q);
    }
    pts = next;
    amp *= 0.5;
  }
  return pts.slice(1, pts.length - 1);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface EdgeInfo {
  a: string;
  b: string;
  /** Territory ids using this edge (1 = coast, 2 = interior border). */
  faces: string[];
  /** Interior points, in `a -> b` order. */
  mid: Pt[];
}

const EDGES = new Map<string, EdgeInfo>();

for (const [id, ring] of Object.entries(RINGS)) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as string;
    const b = ring[(i + 1) % ring.length] as string;
    const key = edgeKey(a, b);
    const existing = EDGES.get(key);
    if (existing) {
      existing.faces.push(id);
      continue;
    }
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    EDGES.set(key, { a: lo, b: hi, faces: [id], mid: [] });
  }
}
// Roughening happens after the whole edge table exists, so an edge knows
// whether it is coastline (one face) before its amplitude is chosen.
for (const [key, e] of EDGES) {
  const pa = NODES[e.a];
  const pb = NODES[e.b];
  if (!pa || !pb) throw new Error(`theater: edge ${key} references an unknown node`);
  e.mid = roughen(pa, pb, key, e.faces.length === 1);
}

/** Full polyline for an edge, endpoints included, in `from -> to` order. */
function edgePoints(from: string, to: string): Pt[] {
  const e = EDGES.get(edgeKey(from, to));
  if (!e) throw new Error(`theater: no edge ${from}->${to}`);
  const a = NODES[from] as Pt;
  const b = NODES[to] as Pt;
  const mid = e.a === from ? e.mid : e.mid.slice().reverse();
  return [a, ...mid, b];
}

export interface TheaterRegion {
  id: string;
  /** Closed outline in continent space, clockwise, first point not repeated. */
  points: readonly Pt[];
  /** Shoelace area in continent units squared. */
  area: number;
  bx0: number;
  by0: number;
  bx1: number;
  by1: number;
  /**
   * Label anchor: the region's pole of inaccessibility (the interior point
   * furthest from any border), so a label sits in the fat part of a region
   * rather than on a centroid that a concave outline can push near an edge.
   */
  ax: number;
  ay: number;
  /** Distance from the anchor to the nearest border — how much room a label has. */
  inner: number;
  /** True when the region owns at least one coastline edge. */
  coastal: boolean;
  tier: number;
}

function ringPoints(ring: readonly string[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const from = ring[i] as string;
    const to = ring[(i + 1) % ring.length] as string;
    const seg = edgePoints(from, to);
    // Drop the last point of each segment: the next segment starts on it.
    for (let k = 0; k < seg.length - 1; k++) out.push(seg[k] as Pt);
  }
  return out;
}

function shoelace(pts: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Pt;
    const q = pts[(i + 1) % pts.length] as Pt;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

/** Ray-casting point-in-polygon, in continent space (so it is scale-free). */
export function pointInShape(shape: readonly Pt[], px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const a = shape[i] as Pt;
    const b = shape[j] as Pt;
    const [xi, yi] = a;
    const [xj, yj] = b;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function distToOutline(pts: readonly Pt[], px: number, py: number): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = distToSegment(px, py, pts[i] as Pt, pts[(i + 1) % pts.length] as Pt);
    if (d < best) best = d;
  }
  return best;
}

/** Coarse grid then two refinement passes — a cheap pole of inaccessibility. */
function poleOfInaccessibility(pts: readonly Pt[]): { x: number; y: number; r: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  let bx = (x0 + x1) / 2;
  let by = (y0 + y1) / 2;
  let br = -1;
  let lo = { x: x0, y: y0, x1, y1 };
  for (let pass = 0; pass < 3; pass++) {
    const steps = pass === 0 ? 22 : 7;
    const sx = (lo.x1 - lo.x) / steps;
    const sy = (lo.y1 - lo.y) / steps;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const px = lo.x + i * sx;
        const py = lo.y + j * sy;
        if (!pointInShape(pts, px, py)) continue;
        const r = distToOutline(pts, px, py);
        if (r > br) {
          br = r;
          bx = px;
          by = py;
        }
      }
    }
    lo = { x: bx - sx, y: by - sy, x1: bx + sx, y1: by + sy };
  }
  return { x: bx, y: by, r: Math.max(0, br) };
}

const REGION_MAP = new Map<string, TheaterRegion>();

for (const t of TERRITORIES) {
  const ring = RINGS[t.id];
  if (!ring) throw new Error(`theater: no ring authored for territory "${t.id}"`);
  const points = ringPoints(ring);
  const area = Math.abs(shoelace(points));
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const p of points) {
    if (p[0] < bx0) bx0 = p[0];
    if (p[1] < by0) by0 = p[1];
    if (p[0] > bx1) bx1 = p[0];
    if (p[1] > by1) by1 = p[1];
  }
  const pole = poleOfInaccessibility(points);
  const coastal = ring.some((n, i) => {
    const e = EDGES.get(edgeKey(n, ring[(i + 1) % ring.length] as string));
    return e !== undefined && e.faces.length === 1;
  });
  REGION_MAP.set(t.id, {
    id: t.id,
    points,
    area,
    bx0,
    by0,
    bx1,
    by1,
    ax: pole.x,
    ay: pole.y,
    inner: pole.r,
    coastal,
    tier: tierOf(t.id),
  });
}

/** Every region, in the campaign's own west-to-east territory order. */
export const REGIONS: readonly TheaterRegion[] = TERRITORIES.map(
  (t) => REGION_MAP.get(t.id) as TheaterRegion,
);

export function regionOf(id: string): TheaterRegion | undefined {
  return REGION_MAP.get(id);
}

// ---------------------------------------------------------------------------
// Derived: interior borders, shared borders, coastline
// ---------------------------------------------------------------------------

/** Every interior border polyline, for the thin dark border pass. */
export const BORDER_LINES: readonly (readonly Pt[])[] = (() => {
  const out: Pt[][] = [];
  for (const e of EDGES.values()) {
    if (e.faces.length === 2) out.push(edgePoints(e.a, e.b));
  }
  return out;
})();

function pairKey(a: string, b: string): string {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

const SHARED = new Map<string, Pt[][]>();
for (const e of EDGES.values()) {
  if (e.faces.length !== 2) continue;
  const key = pairKey(e.faces[0] as string, e.faces[1] as string);
  const list = SHARED.get(key);
  const line = edgePoints(e.a, e.b);
  if (list) list.push(line);
  else SHARED.set(key, [line]);
}

/** The drawn border between two territories, or empty when they do not touch. */
export function sharedBorder(a: string, b: string): readonly (readonly Pt[])[] {
  return SHARED.get(pairKey(a, b)) ?? [];
}

function polylineLength(line: readonly Pt[]): number {
  let n = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const p = line[i] as Pt;
    const q = line[i + 1] as Pt;
    n += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return n;
}

/** Total drawn border length between two territories, in continent units. */
export function sharedBorderLength(a: string, b: string): number {
  let n = 0;
  for (const line of sharedBorder(a, b)) n += polylineLength(line);
  return n;
}

/**
 * The whole landmass outline as one closed ring — the heavy coastline stroke,
 * the clip for the terrain texture, and the shape the sea shelf glows around.
 *
 * Built by chaining the *directed* boundary edges taken from the face rings, so
 * it comes out with the same winding as the regions and `assertTheater` can
 * prove it is a single cycle rather than several islands.
 */
export const COASTLINE: readonly Pt[] = (() => {
  const next = new Map<string, { to: string; pts: Pt[] }>();
  let count = 0;
  for (const [id, ring] of Object.entries(RINGS)) {
    void id;
    for (let i = 0; i < ring.length; i++) {
      const from = ring[i] as string;
      const to = ring[(i + 1) % ring.length] as string;
      const e = EDGES.get(edgeKey(from, to)) as EdgeInfo;
      if (e.faces.length !== 1) continue;
      if (next.has(from)) throw new Error(`theater: coastline forks at ${from}`);
      next.set(from, { to, pts: edgePoints(from, to) });
      count++;
    }
  }
  const start = next.keys().next().value as string | undefined;
  if (start === undefined) throw new Error('theater: no coastline');
  const ring: Pt[] = [];
  let node = start;
  let steps = 0;
  do {
    const step = next.get(node);
    if (!step) throw new Error(`theater: coastline breaks at ${node}`);
    for (let k = 0; k < step.pts.length - 1; k++) ring.push(step.pts[k] as Pt);
    node = step.to;
    steps++;
  } while (node !== start && steps <= count);
  if (node !== start || steps !== count) {
    throw new Error('theater: the coastline is not a single closed loop');
  }
  return ring;
})();

/** Total land area, continent units squared (the ocean is the rest of 100x100). */
export const LAND_AREA = REGIONS.reduce((n, r) => n + r.area, 0);

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** Minimum drawn border a graph edge must have, in continent units. */
const MIN_BORDER = 3;

/**
 * Proved once at module load. Thirteen faces and fifty-five edges — this is
 * microseconds, and it turns an authoring slip (a ring that skips a junction, a
 * split moved past its neighbour) into an immediate throw instead of a
 * territory you can never reach or a border that is not there.
 */
function assertTheater(): void {
  // 1. Nothing may use an edge more than twice, or the faces overlap.
  for (const [key, e] of EDGES) {
    if (e.faces.length > 2) {
      throw new Error(`theater: edge ${key} is used by ${e.faces.length} territories`);
    }
    if (e.faces.length === 2 && e.faces[0] === e.faces[1]) {
      throw new Error(`theater: edge ${key} is used twice by ${e.faces[0]}`);
    }
  }

  // 2. Geometric adjacency must be *exactly* the campaign graph.
  const geometric = new Set<string>();
  for (const e of EDGES.values()) {
    if (e.faces.length === 2) geometric.add(pairKey(e.faces[0] as string, e.faces[1] as string));
  }
  const logical = new Set<string>();
  for (const t of TERRITORIES) for (const n of t.adjacent) logical.add(pairKey(t.id, n));
  for (const key of logical) {
    if (!geometric.has(key)) throw new Error(`theater: graph edge ${key} has no shared border`);
  }
  for (const key of geometric) {
    if (!logical.has(key)) throw new Error(`theater: ${key} share a border but are not adjacent`);
  }

  // 3. Every border must be long enough to see and to pulse.
  for (const t of TERRITORIES) {
    for (const n of t.adjacent) {
      const len = sharedBorderLength(t.id, n);
      if (len < MIN_BORDER) {
        throw new Error(`theater: border ${t.id}~${n} is only ${len.toFixed(2)} units long`);
      }
    }
  }

  // 4. Rings must be non-degenerate and consistently wound.
  const sign = Math.sign(shoelace((REGIONS[0] as TheaterRegion).points));
  for (const r of REGIONS) {
    if (r.area <= 0) throw new Error(`theater: ${r.id} has no area`);
    if (Math.sign(shoelace(r.points)) !== sign) {
      throw new Error(`theater: ${r.id} is wound the other way`);
    }
    if (r.inner <= 0 || !pointInShape(r.points, r.ax, r.ay)) {
      throw new Error(`theater: ${r.id} has no interior label anchor`);
    }
  }

  // 5. The campaign's authored anchors must still land in their own region, so
  //    the west-to-east arrangement the scaling was designed around holds.
  for (const t of TERRITORIES) {
    const r = REGION_MAP.get(t.id) as TheaterRegion;
    if (!pointInShape(r.points, t.cx, t.cy)) {
      throw new Error(`theater: ${t.id}'s campaign anchor is outside its region`);
    }
  }

  // 6. COASTLINE's own construction throws on a fork or a break; this catches a
  //    coastline that closed early and left edges unused.
  if (COASTLINE.length < 3) throw new Error('theater: degenerate coastline');
}
assertTheater();

/** Territory containing a continent-space point, or null. */
export function regionAt(cx: number, cy: number): string | null {
  for (const r of REGIONS) {
    if (cx < r.bx0 || cx > r.bx1 || cy < r.by0 || cy > r.by1) continue;
    if (pointInShape(r.points, cx, cy)) return r.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Introspection (harnesses)
// ---------------------------------------------------------------------------

export interface TheaterReport {
  regions: { id: string; area: number; coastal: boolean; vertices: number }[];
  interiorEdges: number;
  coastEdges: number;
  coastVertices: number;
  landArea: number;
  borders: { pair: string; length: number }[];
}

export function theaterReport(): TheaterReport {
  const borders: { pair: string; length: number }[] = [];
  for (const t of TERRITORIES) {
    for (const n of t.adjacent) {
      if (n <= t.id) continue;
      borders.push({ pair: pairKey(t.id, n), length: sharedBorderLength(t.id, n) });
    }
  }
  let interior = 0;
  let coast = 0;
  for (const e of EDGES.values()) {
    if (e.faces.length === 2) interior++;
    else coast++;
  }
  return {
    regions: REGIONS.map((r) => ({
      id: r.id,
      area: r.area,
      coastal: r.coastal,
      vertices: r.points.length,
    })),
    interiorEdges: interior,
    coastEdges: coast,
    coastVertices: COASTLINE.length,
    landArea: LAND_AREA,
    borders,
  };
}
