/**
 * Sidebar — the C&C-style build strip that owns the reserved SIDEBAR_W pixels.
 *
 * Two halves:
 *   `update()` runs inside the logic tick, BEFORE `orders`. It consumes clicks
 *     that belong to the sidebar or to structure-placement mode and hands back
 *     a snapshot with those events removed, so `orders.ts` never sees them.
 *   `draw()` runs at render rate and is purely cosmetic (the credit counter
 *     ticks toward the real value here; the sim value is never touched).
 *
 * Layout, top to bottom: title, credits, power meter, tabs, icon grid,
 * EVA ticker, debug readout.
 */

import type { Camera } from '../engine/camera';
import type { ClickEvent, InputSnapshot } from '../engine/input';
import { makeRng } from '../engine/rng';
import {
  MAP_H,
  MAP_W,
  PLAYER_HUMAN,
  SIDEBAR_W,
  TILE,
  Terrain,
  WORLD_H,
  WORLD_W,
  clamp,
  worldToTile,
} from '../game/constants';
import {
  BUILDING_TYPES,
  UNIT_TYPES,
  isBuildingType,
  type BuildingTypeId,
  type UnitTypeId,
} from '../game/rules';
import {
  postMessage,
  type EvaMessage,
  type GameState,
  type PlayerState,
  type ProductionItem,
  type UnitStance,
} from '../game/state';
import {
  BUILDABLE_STRUCTURES,
  BUILDABLE_UNITS,
  MAX_UNIT_QUEUE,
  canBuild,
  canPlaceAt,
  cancelQueueItem,
  enqueue,
  placeStructure,
  refundOf,
} from '../game/systems/production';
import {
  STANCE_LABEL,
  applyStanceToSelection,
  captureSelection,
  majorityStance,
  sellableSelection,
  stanceSelection,
} from '../game/systems/orders';
import { isEntityVisibleToHuman } from '../game/systems/fog';
import type { HudInfo } from './renderer';
import { drawPixelText, getBuildingIcon, getUnitIcon, measurePixelText } from './sprites';

type BuildTypeId = BuildingTypeId | UnitTypeId;

const PAD = 10;
const TAB_Y = 94;
const TAB_H = 20;
const GRID_Y = 120;
const CELL_H = 40;
const CELL_GAP = 4;
const COLS = 2;
/**
 * Height of the footer block below the build grid: the EVA panel, the controls
 * hint line and the debug readout. `EVA_PANEL_H` is the ticker box itself — the
 * post-release hint line took its 16px out of the gap under the box, so the
 * ticker keeps its Phase 6 size and only sits 16px higher.
 */
const EVA_H = 74;
const EVA_PANEL_H = 38;
const ICON_SIZE = 30;
/** Radar pane: as wide as the strip allows, capped so it stays square-ish. */
const MINIMAP_MAX = 184;
const MINIMAP_GAP = 6;

const COL = {
  bg: '#14170f',
  edge: '#2e3423',
  panel: '#1b2015',
  text: '#c8d69a',
  dim: '#6f7a52',
  bright: '#e6f2b8',
  gold: '#e0b53c',
  green: '#5fd06a',
  yellow: '#d8c452',
  red: '#c8402c',
  cell: '#242a1a',
  cellHot: '#333c25',
  cellEdge: '#3c4630',
} as const;

interface Cell {
  type: BuildTypeId;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Post-release stance row. Three segments across the top of the radar pane,
 * shown only while the human has units selected that can hold a stance — the
 * sell hint (bottom of the same pane) needs a *structure* selected, so the two
 * can never be on screen together and nothing in the strip has to reflow.
 */
const STANCE_ROW_H = 16;
const STANCE_BUTTONS: readonly (readonly [key: string, stance: UnitStance])[] = [
  ['Z', 'explore'],
  ['X', 'defensive'],
  ['C', 'offensive'],
];

interface StanceRowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Minimap / radar
// ---------------------------------------------------------------------------

/**
 * Is the human's radar up? Phase 5 precomputes this as `comm centre built AND
 * not in a power deficit`, so the radar pane only has to read the flag. When it
 * is false the pane shows static and refuses input.
 */
export function radarOnline(state: Pick<GameState, 'players'>): boolean {
  return state.players[PLAYER_HUMAN].radar;
}

export interface MinimapRect {
  x: number;
  y: number;
  size: number;
}

/** RGB per terrain type, matching the terrain art's base tones. */
const MINIMAP_TERRAIN: readonly (readonly [number, number, number])[] = [
  [66, 80, 46], // grass
  [150, 134, 91], // sand
  [107, 100, 83], // rock
  [74, 69, 56], // cliff
  [63, 191, 95], // crystal (full)
];
const MINIMAP_CRYSTAL_SPENT: readonly [number, number, number] = [36, 92, 52];
/** Shroud alpha over explored-but-unseen ground; matches the world renderer. */
const MINIMAP_FOG_ALPHA = 130;
/** Pre-baked frames of radar static, cycled while the radar is down. */
const NOISE_FRAMES = 4;

/**
 * Radar pane. Terrain is downsampled to one pixel per tile into an offscreen
 * 96x96 bitmap and only repainted where `dirtyTiles` says something changed;
 * the shroud gets its own bitmap keyed on `fog.version`. Both are blitted
 * scaled (smoothing off), so a frame costs two drawImages plus the entity dots.
 */
class Minimap {
  private readonly terrain: HTMLCanvasElement;
  private readonly terrainCtx: CanvasRenderingContext2D;
  private readonly terrainImage: ImageData;
  private terrainBuilt = false;
  private readonly dirty = new Set<number>();

  private readonly fog: HTMLCanvasElement;
  private readonly fogCtx: CanvasRenderingContext2D;
  private readonly fogImage: ImageData;
  private fogVersion = -1;

  private noise: HTMLCanvasElement[] | null = null;
  /** Render-rate frame counter; drives the static, never the sim. */
  private frame = 0;

  constructor() {
    const terrain = document.createElement('canvas');
    terrain.width = MAP_W;
    terrain.height = MAP_H;
    this.terrain = terrain;
    this.terrainCtx = terrain.getContext('2d') as CanvasRenderingContext2D;
    this.terrainImage = this.terrainCtx.createImageData(MAP_W, MAP_H);

    const fog = document.createElement('canvas');
    fog.width = MAP_W;
    fog.height = MAP_H;
    this.fog = fog;
    this.fogCtx = fog.getContext('2d') as CanvasRenderingContext2D;
    this.fogImage = this.fogCtx.createImageData(MAP_W, MAP_H);
  }

  /** Drop every cache. Called on restart (new map, new fog version numbering). */
  invalidate(): void {
    this.terrainBuilt = false;
    this.fogVersion = -1;
    this.dirty.clear();
  }

  markTileDirty(tx: number, ty: number): void {
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return;
    this.dirty.add(ty * MAP_W + tx);
  }

  private paintTile(map: GameState['map'], i: number): void {
    const t = map.terrain[i] as number;
    let rgb = MINIMAP_TERRAIN[t] ?? MINIMAP_TERRAIN[0];
    if (t === Terrain.Crystal && (map.crystal[i] as number) === 0) {
      rgb = MINIMAP_CRYSTAL_SPENT;
    }
    const o = i * 4;
    const d = this.terrainImage.data;
    d[o] = rgb?.[0] ?? 0;
    d[o + 1] = rgb?.[1] ?? 0;
    d[o + 2] = rgb?.[2] ?? 0;
    d[o + 3] = 255;
  }

  private syncTerrain(map: GameState['map']): void {
    if (!this.terrainBuilt) {
      for (let i = 0; i < MAP_W * MAP_H; i++) this.paintTile(map, i);
      this.terrainCtx.putImageData(this.terrainImage, 0, 0);
      this.terrainBuilt = true;
      this.dirty.clear();
      return;
    }
    if (this.dirty.size === 0) return;
    for (const i of this.dirty) this.paintTile(map, i);
    this.dirty.clear();
    this.terrainCtx.putImageData(this.terrainImage, 0, 0);
  }

  private syncFog(state: GameState): void {
    if (!state.fog.enabled) return;
    if (this.fogVersion === state.fog.version) return;
    const { explored, visible } = state.fog;
    const d = this.fogImage.data;
    for (let i = 0, o = 0; i < explored.length; i++, o += 4) {
      d[o] = 0;
      d[o + 1] = 0;
      d[o + 2] = 0;
      d[o + 3] = visible[i] === 1 ? 0 : explored[i] === 1 ? MINIMAP_FOG_ALPHA : 255;
    }
    this.fogCtx.putImageData(this.fogImage, 0, 0);
    this.fogVersion = state.fog.version;
  }

  private noiseFrames(): HTMLCanvasElement[] {
    if (this.noise) return this.noise;
    const frames: HTMLCanvasElement[] = [];
    for (let f = 0; f < NOISE_FRAMES; f++) {
      const c = document.createElement('canvas');
      c.width = MAP_W;
      c.height = MAP_H;
      const cx = c.getContext('2d') as CanvasRenderingContext2D;
      const img = cx.createImageData(MAP_W, MAP_H);
      const rng = makeRng((0x51574 + f * 7919) >>> 0);
      const d = img.data;
      for (let i = 0, o = 0; i < MAP_W * MAP_H; i++, o += 4) {
        const v = rng.next() < 0.5 ? rng.int(70) : 70 + rng.int(130);
        d[o] = v;
        d[o + 1] = v + 8;
        d[o + 2] = v;
        d[o + 3] = 255;
      }
      cx.putImageData(img, 0, 0);
      frames.push(c);
    }
    this.noise = frames;
    return frames;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    camera: Camera,
    rect: MinimapRect,
    online: boolean,
  ): void {
    this.frame++;
    const { x, y, size } = rect;

    // Bezel.
    ctx.fillStyle = COL.panel;
    ctx.fillRect(x - 2, y - 2, size + 4, size + 4);
    ctx.strokeStyle = COL.cellEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 1.5, y - 1.5, size + 3, size + 3);

    if (!online) {
      this.drawStatic(ctx, rect);
      return;
    }

    this.syncTerrain(state.map);
    this.syncFog(state);
    ctx.drawImage(this.terrain, 0, 0, MAP_W, MAP_H, x, y, size, size);
    if (state.fog.enabled) {
      ctx.drawImage(this.fog, 0, 0, MAP_W, MAP_H, x, y, size, size);
    }

    const s = size / WORLD_W;
    const dot = Math.max(2, Math.round(size / 96));

    for (const b of state.buildings) {
      if (b.dead) continue;
      if (!isEntityVisibleToHuman(state, b)) continue;
      ctx.fillStyle = state.players[b.player].color;
      ctx.fillRect(
        Math.round(x + b.tx * TILE * s),
        Math.round(y + b.ty * TILE * s),
        Math.max(dot + 1, Math.round(b.w * TILE * s)),
        Math.max(dot + 1, Math.round(b.h * TILE * s)),
      );
    }
    for (const u of state.units) {
      if (u.dead) continue;
      if (!isEntityVisibleToHuman(state, u)) continue;
      ctx.fillStyle = state.players[u.player].color;
      ctx.fillRect(
        Math.round(x + u.pos.x * s) - (dot >> 1),
        Math.round(y + u.pos.y * s) - (dot >> 1),
        dot,
        dot,
      );
    }

    // Viewport rectangle.
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(x + camera.x * s) + 0.5,
      Math.round(y + camera.y * s) + 0.5,
      Math.max(3, Math.round(camera.viewW * s)),
      Math.max(3, Math.round((camera.viewH * size) / WORLD_H)),
    );
  }

  private drawStatic(ctx: CanvasRenderingContext2D, rect: MinimapRect): void {
    const { x, y, size } = rect;
    const frames = this.noiseFrames();
    const f = frames[Math.floor(this.frame / 4) % frames.length] as HTMLCanvasElement;
    ctx.globalAlpha = 0.75;
    ctx.drawImage(f, 0, 0, MAP_W, MAP_H, x, y, size, size);
    ctx.globalAlpha = 1;

    const scale = Math.max(1, Math.floor(size / 60));
    const label = 'NO SIGNAL';
    const w = measurePixelText(label, scale);
    const tx = Math.round(x + (size - w) / 2);
    const ty = Math.round(y + size / 2 - scale * 3.5);
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(tx - 6, ty - 5, w + 12, scale * 7 + 10);
    drawPixelText(ctx, label, tx, ty, scale, '#c8402c');
  }
}

export class Sidebar {
  private readonly camera: Camera;
  /** Cosmetic, render-rate only: the counter that rolls toward `credits`. */
  private displayCredits = -1;
  private hover: BuildTypeId | null = null;
  private readonly minimap = new Minimap();

  /**
   * Phase 6: optional read-only probe into the audio mixer, for the speaker
   * indicator in the footer. The sidebar never drives audio.
   */
  audioStatus: (() => { muted: boolean; ready: boolean }) | null = null;

  constructor(camera: Camera) {
    this.camera = camera;
  }

  /**
   * Forget render-only carry-over (the rolling credit counter, hover, the
   * radar's downsampled map). Called on a Phase 5 restart so the new game does
   * not animate down from the old game's balance or show the old terrain.
   */
  reset(): void {
    this.displayCredits = -1;
    this.hover = null;
    this.minimap.invalidate();
  }

  /** Repaint one radar pixel. `main.ts` fans `state.dirtyTiles` out to this. */
  markTileDirty(tx: number, ty: number): void {
    this.minimap.markTileDirty(tx, ty);
  }

  // --- geometry ------------------------------------------------------------

  private get x0(): number {
    return this.camera.viewW;
  }

  private get width(): number {
    return Math.max(0, Math.min(SIDEBAR_W, this.camera.canvasW - this.camera.viewW));
  }

  private tabRects(): { structures: Cell | null; units: Cell | null } {
    const w = this.width;
    if (w <= 0) return { structures: null, units: null };
    const half = (w - PAD * 2 - CELL_GAP) / 2;
    return {
      structures: {
        type: 'powerPlant',
        x: this.x0 + PAD,
        y: TAB_Y,
        w: half,
        h: TAB_H,
      },
      units: {
        type: 'minigunner',
        x: this.x0 + PAD + half + CELL_GAP,
        y: TAB_Y,
        w: half,
        h: TAB_H,
      },
    };
  }

  /**
   * Radar pane geometry: a square sitting between the build grid and the EVA
   * ticker. Returns null when the window is too short to hold one.
   */
  minimapRect(): MinimapRect | null {
    const w = this.width;
    if (w <= 0) return null;
    const size = Math.min(MINIMAP_MAX, w - PAD * 2);
    const y = this.camera.canvasH - EVA_H - MINIMAP_GAP - size;
    if (size < 48 || y < GRID_Y + CELL_H) return null;
    return { x: this.x0 + PAD + Math.floor((w - PAD * 2 - size) / 2), y, size };
  }

  /**
   * Where the stance row sits: across the top of the radar pane, or just above
   * the EVA ticker when the window is too short to hold a radar. `null` when
   * nothing that can hold a stance is selected.
   */
  private stanceRowRect(state: GameState, map: MinimapRect | null): StanceRowRect | null {
    const w = this.width;
    if (w <= 0) return null;
    if (stanceSelection(state).length === 0) return null;
    return {
      x: this.x0 + PAD,
      y: map ? map.y : this.camera.canvasH - EVA_H - STANCE_ROW_H - 2,
      w: w - PAD * 2,
      h: STANCE_ROW_H,
    };
  }

  private static inRect(r: StanceRowRect, x: number, y: number): boolean {
    return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  }

  private static inMinimap(rect: MinimapRect, x: number, y: number): boolean {
    return x >= rect.x && x < rect.x + rect.size && y >= rect.y && y < rect.y + rect.size;
  }

  /** Jump the camera to the world point a radar pixel represents. */
  private cameraToMinimapPoint(rect: MinimapRect, x: number, y: number): void {
    const fx = clamp((x - rect.x) / rect.size, 0, 1);
    const fy = clamp((y - rect.y) / rect.size, 0, 1);
    this.camera.centerOn(fx * WORLD_W, fy * WORLD_H);
  }

  private cells(state: GameState): Cell[] {
    const w = this.width;
    if (w <= 0) return [];
    const list: readonly BuildTypeId[] =
      state.ui.buildTab === 'structures' ? BUILDABLE_STRUCTURES : BUILDABLE_UNITS;
    const cellW = (w - PAD * 2 - CELL_GAP * (COLS - 1)) / COLS;
    const map = this.minimapRect();
    const bottom = (map ? map.y - 4 : this.camera.canvasH - EVA_H) - 6;
    const out: Cell[] = [];
    for (let i = 0; i < list.length; i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const y = GRID_Y + row * (CELL_H + CELL_GAP);
      if (y + CELL_H > bottom) break;
      out.push({
        type: list[i] as BuildTypeId,
        x: this.x0 + PAD + col * (cellW + CELL_GAP),
        y,
        w: cellW,
        h: CELL_H,
      });
    }
    return out;
  }

  private static hit(cell: Cell, x: number, y: number): boolean {
    return x >= cell.x && x < cell.x + cell.w && y >= cell.y && y < cell.y + cell.h;
  }

  // --- tick ----------------------------------------------------------------

  /**
   * Consume sidebar / placement input. Returns the snapshot the rest of the
   * tick should see (clicks and keys handled here are stripped out).
   */
  update(state: GameState, snap: InputSnapshot): InputSnapshot {
    const player = state.players[PLAYER_HUMAN];
    const ui = state.ui;

    // Hover highlight (cosmetic, but cheap to resolve here).
    this.hover = null;
    if (snap.pointer.inSidebar) {
      for (const cell of this.cells(state)) {
        if (Sidebar.hit(cell, snap.pointer.x, snap.pointer.y)) {
          this.hover = cell.type;
          break;
        }
      }
    }

    // Radar drag-scroll. A drag that *started* on the pane keeps steering the
    // camera even after the pointer leaves it; a dark radar takes no input.
    const map = this.minimapRect();
    const stanceRow = this.stanceRowRect(state, map);
    if (
      map &&
      radarOnline(state) &&
      snap.drag &&
      snap.drag.button === 0 &&
      Sidebar.inMinimap(map, snap.drag.startX, snap.drag.startY) &&
      // A drag that began on the stance row is a mis-click, not a radar scrub.
      !(stanceRow && Sidebar.inRect(stanceRow, snap.drag.startX, snap.drag.startY))
    ) {
      this.cameraToMinimapPoint(map, snap.drag.x, snap.drag.y);
    }

    // A cancelled/placed item invalidates placement mode.
    if (ui.placement && player.queues.structures.pendingPlacement !== ui.placement.type) {
      ui.placement = null;
    }

    let pressed = snap.pressed;
    if (ui.placement && snap.pressed.has('Escape')) {
      ui.placement = null;
      const next = new Set(pressed);
      next.delete('Escape');
      pressed = next;
    }

    // Ghost follows the cursor, centred on the pointer tile.
    if (ui.placement && snap.pointer.inView) {
      const def = BUILDING_TYPES[ui.placement.type];
      const tx = clamp(
        snap.pointer.tx - Math.floor((def.w - 1) / 2),
        0,
        MAP_W - def.w,
      );
      const ty = clamp(
        snap.pointer.ty - Math.floor((def.h - 1) / 2),
        0,
        MAP_H - def.h,
      );
      ui.placement.tx = tx;
      ui.placement.ty = ty;
      ui.placement.valid = canPlaceAt(state, PLAYER_HUMAN, ui.placement.type, tx, ty);
    }

    const kept: ClickEvent[] = [];
    for (const click of snap.clicks) {
      if (click.inSidebar) {
        this.handleSidebarClick(state, click);
        continue;
      }
      if (ui.placement && click.inView) {
        if (click.button === 0) {
          const def = BUILDING_TYPES[ui.placement.type];
          const tx = clamp(click.tx - Math.floor((def.w - 1) / 2), 0, MAP_W - def.w);
          const ty = clamp(click.ty - Math.floor((def.h - 1) / 2), 0, MAP_H - def.h);
          const placed = placeStructure(state, PLAYER_HUMAN, tx, ty);
          if (!placed) postMessage(state, 'Cannot deploy here', 'warning');
          continue;
        }
        if (click.button === 2) {
          ui.placement = null;
          continue;
        }
      }
      kept.push(click);
    }

    // A drag that happened entirely inside the sidebar must not box-select.
    const keptDrags = snap.dragBoxes.filter((box) => box.x1 < this.x0);

    if (
      kept.length === snap.clicks.length &&
      keptDrags.length === snap.dragBoxes.length &&
      pressed === snap.pressed
    ) {
      return snap;
    }
    return { ...snap, clicks: kept, dragBoxes: keptDrags, pressed };
  }

  private handleSidebarClick(state: GameState, click: ClickEvent): void {
    const ui = state.ui;

    const map = this.minimapRect();

    // The stance row overlays the top of the radar, so it gets first refusal.
    const row = this.stanceRowRect(state, map);
    if (row && Sidebar.inRect(row, click.x, click.y)) {
      if (click.button === 0) {
        const i = clamp(
          Math.floor(((click.x - row.x) / row.w) * STANCE_BUTTONS.length),
          0,
          STANCE_BUTTONS.length - 1,
        );
        applyStanceToSelection(state, (STANCE_BUTTONS[i] as readonly [string, UnitStance])[1]);
      }
      return;
    }

    if (map && Sidebar.inMinimap(map, click.x, click.y)) {
      if (click.button === 0 && radarOnline(state)) {
        this.cameraToMinimapPoint(map, click.x, click.y);
      }
      return;
    }

    const tabs = this.tabRects();
    if (tabs.structures && Sidebar.hit(tabs.structures, click.x, click.y)) {
      ui.buildTab = 'structures';
      return;
    }
    if (tabs.units && Sidebar.hit(tabs.units, click.x, click.y)) {
      ui.buildTab = 'units';
      return;
    }

    for (const cell of this.cells(state)) {
      if (!Sidebar.hit(cell, click.x, click.y)) continue;
      const player = state.players[PLAYER_HUMAN];

      if (click.button === 2) {
        // Right click cancels the in-progress item of that queue.
        const tab = isBuildingType(cell.type) ? 'structures' : 'units';
        const head = player.queues[tab].items[0];
        if (head && head.type === cell.type) cancelQueueItem(state, PLAYER_HUMAN, tab);
        return;
      }
      if (click.button !== 0) return;

      if (isBuildingType(cell.type)) {
        if (player.queues.structures.pendingPlacement === cell.type) {
          // Second click on a READY structure: arm placement mode. The ghost
          // starts at the middle of the view so it is never off-screen before
          // the pointer first enters the world.
          const def = BUILDING_TYPES[cell.type];
          const cx = worldToTile(this.camera.x + this.camera.viewW / 2);
          const cy = worldToTile(this.camera.y + this.camera.viewH / 2);
          ui.placement = {
            type: cell.type,
            tx: clamp(cx - Math.floor((def.w - 1) / 2), 0, MAP_W - def.w),
            ty: clamp(cy - Math.floor((def.h - 1) / 2), 0, MAP_H - def.h),
            valid: false,
          };
          ui.placement.valid = canPlaceAt(
            state,
            PLAYER_HUMAN,
            cell.type,
            ui.placement.tx,
            ui.placement.ty,
          );
          return;
        }
        enqueue(state, PLAYER_HUMAN, cell.type);
        return;
      }
      enqueue(state, PLAYER_HUMAN, cell.type);
      return;
    }
  }

  // --- draw ----------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, state: GameState, hud: HudInfo): void {
    const w = this.width;
    if (w <= 0) return;
    const x = this.x0;
    const h = this.camera.canvasH;
    const p = state.players[PLAYER_HUMAN];

    ctx.fillStyle = COL.bg;
    ctx.fillRect(x, 0, w, h);
    ctx.fillStyle = COL.edge;
    ctx.fillRect(x, 0, 2, h);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // --- title ---
    ctx.fillStyle = COL.text;
    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.fillText('CRYSTAL DAWN', x + PAD, 12);
    ctx.fillStyle = COL.edge;
    ctx.fillRect(x + PAD, 30, w - PAD * 2, 1);

    this.drawCredits(ctx, x, w, p);
    this.drawPower(ctx, x, w, p);
    this.drawTabs(ctx, state);
    this.drawGrid(ctx, state);

    const map = this.minimapRect();
    if (map) this.minimap.draw(ctx, state, this.camera, map, radarOnline(state));

    this.drawStanceRow(ctx, state, map);
    this.drawSellHint(ctx, state, x, w, h, map);
    this.drawEva(ctx, state, x, w, h);
    this.drawHelpHint(ctx, x, w, h);

    ctx.fillStyle = COL.dim;
    ctx.font = '10px "Courier New", monospace';
    ctx.fillText(
      `T${state.tick}  ${hud.fps}FPS  ${hud.speed.toFixed(1)}x`,
      x + PAD,
      h - 14,
    );
    this.drawAudioIndicator(ctx, x, w, h);
  }

  /**
   * Post-release discoverability line, in the strip between the EVA ticker and
   * the debug/audio footer. The keys themselves live in `render/hud.ts`; this is
   * only the affordance, sitting next to the audio indicator so every
   * "there is a key for this" cue is in the same corner.
   */
  private drawHelpHint(
    ctx: CanvasRenderingContext2D,
    x: number,
    w: number,
    h: number,
  ): void {
    const y = h - EVA_H + EVA_PANEL_H + 4;
    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.fillStyle = COL.gold;
    ctx.fillText('[H] HELP', x + PAD, y);
    ctx.font = '10px "Courier New", monospace';
    ctx.fillStyle = COL.dim;
    ctx.textAlign = 'right';
    ctx.fillText('[O] OBJECTIVES', x + w - PAD, y);
    ctx.textAlign = 'left';
  }

  /** Speaker state in the footer. 'M' toggles it; the setting is persisted. */
  private drawAudioIndicator(
    ctx: CanvasRenderingContext2D,
    x: number,
    w: number,
    h: number,
  ): void {
    if (!this.audioStatus) return;
    const { muted, ready } = this.audioStatus();
    const gx = x + w - PAD - 22;
    const gy = h - 16;
    const on = ready && !muted;
    const color = muted ? COL.red : ready ? COL.green : COL.dim;

    // Chunky speaker glyph: cone + cabinet.
    ctx.fillStyle = color;
    ctx.fillRect(gx, gy + 3, 3, 4);
    ctx.fillRect(gx + 3, gy + 1, 2, 8);
    ctx.fillRect(gx + 5, gy - 1, 2, 12);
    if (on) {
      ctx.fillRect(gx + 9, gy + 3, 2, 4);
      ctx.fillRect(gx + 12, gy + 1, 2, 8);
    } else {
      // Cancellation slash.
      ctx.fillRect(gx + 9, gy + 1, 2, 2);
      ctx.fillRect(gx + 11, gy + 3, 2, 2);
      ctx.fillRect(gx + 9, gy + 5, 2, 2);
      ctx.fillRect(gx + 11, gy + 7, 2, 2);
    }
    ctx.font = '9px "Courier New", monospace';
    ctx.fillStyle = COL.dim;
    ctx.textAlign = 'right';
    ctx.fillText('M', gx - 4, h - 15);
    ctx.textAlign = 'left';
  }

  private drawCredits(
    ctx: CanvasRenderingContext2D,
    x: number,
    w: number,
    p: PlayerState,
  ): void {
    const target = Math.floor(p.credits);
    if (this.displayCredits < 0) this.displayCredits = target;
    const diff = target - this.displayCredits;
    if (diff !== 0) {
      const step = Math.max(1, Math.ceil(Math.abs(diff) / 10));
      this.displayCredits += diff > 0 ? Math.min(step, diff) : Math.max(-step, diff);
    }

    ctx.font = 'bold 18px "Courier New", monospace';
    ctx.fillStyle = COL.gold;
    ctx.textAlign = 'right';
    ctx.fillText(String(this.displayCredits), x + w - PAD, 38);
    ctx.textAlign = 'left';
    ctx.font = '9px "Courier New", monospace';
    ctx.fillStyle = COL.dim;
    ctx.fillText('CREDITS', x + PAD, 42);
    ctx.fillText(`MAX ${p.storage}`, x + PAD, 54);
  }

  private drawPower(
    ctx: CanvasRenderingContext2D,
    x: number,
    w: number,
    p: PlayerState,
  ): void {
    const barX = x + PAD;
    const barY = 68;
    const barW = w - PAD * 2;
    const barH = 8;
    const scale = Math.max(100, p.powerProduced, p.powerDrain);

    ctx.fillStyle = '#0d1008';
    ctx.fillRect(barX, barY, barW, barH);

    const producedW = Math.round((p.powerProduced / scale) * barW);
    ctx.fillStyle = '#2c4a26';
    ctx.fillRect(barX, barY, producedW, barH);

    const ratio = p.powerProduced === 0 ? (p.powerDrain > 0 ? 2 : 0) : p.powerDrain / p.powerProduced;
    const color = ratio > 1 ? COL.red : ratio > 0.85 ? COL.yellow : COL.green;
    const drainW = Math.round((Math.min(p.powerDrain, scale) / scale) * barW);
    ctx.fillStyle = color;
    ctx.fillRect(barX, barY, drainW, barH);

    ctx.strokeStyle = COL.cellEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);

    ctx.font = '9px "Courier New", monospace';
    ctx.fillStyle = p.lowPower ? COL.red : COL.dim;
    ctx.fillText(`PWR ${p.powerProduced}/${p.powerDrain}`, barX, barY + barH + 2);
    if (p.lowPower) {
      ctx.textAlign = 'right';
      ctx.fillText('LOW', x + w - PAD, barY + barH + 2);
      ctx.textAlign = 'left';
    }
  }

  private drawTabs(ctx: CanvasRenderingContext2D, state: GameState): void {
    const tabs = this.tabRects();
    const active = state.ui.buildTab;
    const draw = (cell: Cell | null, label: string, on: boolean): void => {
      if (!cell) return;
      ctx.fillStyle = on ? COL.cellHot : COL.panel;
      ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
      ctx.strokeStyle = on ? COL.text : COL.cellEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1);
      ctx.fillStyle = on ? COL.bright : COL.dim;
      ctx.font = 'bold 10px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(label, cell.x + cell.w / 2, cell.y + 6);
      ctx.textAlign = 'left';
    };
    draw(tabs.structures, 'BUILD', active === 'structures');
    draw(tabs.units, 'UNITS', active === 'units');
  }

  private drawGrid(ctx: CanvasRenderingContext2D, state: GameState): void {
    const p = state.players[PLAYER_HUMAN];
    const tab = state.ui.buildTab;
    const queue = p.queues[tab];
    const head: ProductionItem | undefined = queue.items[0];
    const queueFull =
      tab === 'structures' ? queue.items.length >= 1 : queue.items.length >= MAX_UNIT_QUEUE;

    for (const cell of this.cells(state)) {
      const bType: BuildingTypeId | null = isBuildingType(cell.type) ? cell.type : null;
      const uType: UnitTypeId | null = bType === null ? (cell.type as UnitTypeId) : null;
      const def = bType !== null ? BUILDING_TYPES[bType] : UNIT_TYPES[uType as UnitTypeId];
      const allowed = canBuild(state, PLAYER_HUMAN, cell.type);
      const active = head !== undefined && head.type === cell.type;
      const ready = bType !== null && queue.pendingPlacement === bType;
      const queuedCount = queue.items.filter((it) => it.type === cell.type).length;
      const enabled = allowed && (!queueFull || active);

      // Cell plate.
      ctx.fillStyle = this.hover === cell.type && enabled ? COL.cellHot : COL.cell;
      ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
      ctx.strokeStyle = active ? COL.gold : COL.cellEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1);

      // Icon.
      const icon =
        bType !== null
          ? getBuildingIcon(bType, ICON_SIZE)
          : getUnitIcon(uType as UnitTypeId, ICON_SIZE);
      const ix = cell.x + 4;
      const iy = cell.y + (cell.h - ICON_SIZE) / 2;
      ctx.globalAlpha = enabled ? 1 : 0.35;
      ctx.drawImage(icon, ix, iy);
      ctx.globalAlpha = 1;

      // Labels.
      const tx = ix + ICON_SIZE + 5;
      ctx.font = 'bold 10px "Courier New", monospace';
      ctx.fillStyle = enabled ? COL.text : COL.dim;
      ctx.fillText(def.short, tx, cell.y + 8);
      ctx.font = '9px "Courier New", monospace';
      ctx.fillStyle = enabled ? COL.gold : COL.dim;
      ctx.fillText(`$${def.cost}`, tx, cell.y + 22);

      // Queue count badge (units).
      if (queuedCount > 1) {
        ctx.fillStyle = COL.bright;
        ctx.font = 'bold 9px "Courier New", monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`x${queuedCount}`, cell.x + cell.w - 4, cell.y + 8);
        ctx.textAlign = 'left';
      }

      // Progress: vertical wipe over the whole cell.
      if (active && head && !head.ready) {
        const frac = clamp(head.progress / head.total, 0, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.62)';
        ctx.fillRect(cell.x + 1, cell.y + 1, cell.w - 2, (cell.h - 2) * (1 - frac));
        ctx.fillStyle = COL.gold;
        ctx.font = 'bold 9px "Courier New", monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.floor(frac * 100)}%`, cell.x + cell.w - 4, cell.y + cell.h - 12);
        ctx.textAlign = 'left';
      }

      // READY flash for a structure awaiting placement.
      if (ready) {
        const on = Math.floor(state.tick / 8) % 2 === 0;
        ctx.fillStyle = on ? 'rgba(224,181,60,0.30)' : 'rgba(0,0,0,0.35)';
        ctx.fillRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
        ctx.fillStyle = on ? COL.bright : COL.gold;
        ctx.font = 'bold 11px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('READY', cell.x + cell.w / 2, cell.y + cell.h / 2 - 6);
        ctx.textAlign = 'left';
      }

      // Placement armed marker.
      if (state.ui.placement && state.ui.placement.type === cell.type) {
        ctx.strokeStyle = COL.green;
        ctx.lineWidth = 2;
        ctx.strokeRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
        ctx.lineWidth = 1;
      }
    }
  }

  /**
   * Post-release stance row: `[Z] EXP | [X] DEF | [C] OFF`, drawn across the
   * top of the radar pane while units that can hold a stance are selected. The
   * segments are clickable and do exactly what the keys do.
   *
   * Highlighting on a mixed selection is **strict majority**: the stance most
   * of the selected units are on is lit, and a tie lights nothing — so the row
   * never claims a selection is uniform when it is not.
   */
  private drawStanceRow(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    map: MinimapRect | null,
  ): void {
    const row = this.stanceRowRect(state, map);
    if (!row) return;
    const active = majorityStance(stanceSelection(state));
    const segW = row.w / STANCE_BUTTONS.length;

    ctx.fillStyle = 'rgba(0,0,0,0.80)';
    ctx.fillRect(row.x, row.y, row.w, row.h);

    for (let i = 0; i < STANCE_BUTTONS.length; i++) {
      const [key, stance] = STANCE_BUTTONS[i] as readonly [string, UnitStance];
      const sx = row.x + i * segW;
      const on = active === stance;
      if (on) {
        ctx.fillStyle = 'rgba(224,181,60,0.28)';
        ctx.fillRect(sx + 1, row.y + 1, segW - 2, row.h - 2);
      }
      ctx.strokeStyle = on ? COL.gold : COL.cellEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, row.y + 0.5, segW - 1, row.h - 1);
      ctx.font = 'bold 9px "Courier New", monospace';
      ctx.fillStyle = on ? COL.bright : COL.dim;
      ctx.textAlign = 'center';
      ctx.fillText(`${key} ${STANCE_LABEL[stance]}`, sx + segW / 2, row.y + 4);
      ctx.textAlign = 'left';
    }
  }

  /**
   * Phase 7 sell affordance. Selling is a keystroke ('S' with exactly one own
   * finished structure selected), so the only UI it needs is a prompt telling
   * the player the key and the refund. It is drawn as a banner across the foot
   * of the radar pane (or just above the ticker when the window is too short
   * for a radar) so nothing in the strip has to reflow when it appears.
   */
  private drawSellHint(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    x: number,
    w: number,
    h: number,
    map: MinimapRect | null,
  ): void {
    // The two hints share one slot and can never both apply: selling needs a
    // *structure* selected, capturing needs engineers, and a structure
    // selection never contains units (Phase 7 note on `boxSelect`).
    const b = sellableSelection(state);
    let label: string | null = null;
    if (b) label = `[S] SELL ${BUILDING_TYPES[b.type].short} +$${refundOf(b.type)}`;
    else if (captureSelection(state).length > 0) label = '[RMB] CAPTURE ENEMY BUILDING';
    if (!label) return;

    const bx = x + PAD;
    const bw = w - PAD * 2;
    const by = map ? map.y + map.size - 16 : h - EVA_H - 18;

    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(bx, by, bw, 16);
    ctx.strokeStyle = COL.gold;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, 15);
    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.fillStyle = COL.gold;
    ctx.textAlign = 'center';
    ctx.fillText(label, bx + bw / 2, by + 4);
    ctx.textAlign = 'left';
  }

  private drawEva(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    x: number,
    w: number,
    h: number,
  ): void {
    const top = h - EVA_H;
    ctx.fillStyle = COL.panel;
    ctx.fillRect(x + PAD, top, w - PAD * 2, EVA_PANEL_H);
    ctx.strokeStyle = COL.cellEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + PAD + 0.5, top + 0.5, w - PAD * 2 - 1, EVA_PANEL_H - 1);

    const recent = state.messages.slice(-3);
    ctx.font = '9px "Courier New", monospace';
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i] as EvaMessage;
      const age = state.tick - m.tick;
      const alpha = clamp(1 - age / 400, 0.25, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle =
        m.kind === 'alert' ? COL.red : m.kind === 'warning' ? COL.yellow : COL.text;
      const text = m.text.length > 24 ? `${m.text.slice(0, 23)}…` : m.text;
      ctx.fillText(text, x + PAD + 4, top + 4 + i * 11);
      ctx.globalAlpha = 1;
    }
  }
}
