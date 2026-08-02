/**
 * Renderer.
 *
 * Terrain is composited once into a full-map offscreen canvas (96*24 = 2304px
 * square) and blitted per frame with a single drawImage. Tiles are only
 * re-drawn when something marks them dirty (crystal depletion in Phase 3).
 *
 * The right-hand SIDEBAR_W strip is reserved UI space; Phase 6 fills it in.
 */

import type { Camera } from '../engine/camera';
import type { LiveDrag } from '../engine/input';
import {
  MAP_H,
  MAP_W,
  PLAYER_HUMAN,
  SELL_TIME,
  SIDEBAR_W,
  TILE,
  WORLD_H,
  WORLD_W,
  clamp,
  tileIndex,
} from '../game/constants';
import { BUILDING_TYPES, UNIT_TYPES } from '../game/rules';
import {
  stanceOf,
  type Effect,
  type GameState,
  type MapData,
  type Projectile,
  type Unit,
  type UnitStance,
} from '../game/state';
import { BEAM_LIFE } from '../game/systems/combat';
import { isEntityVisibleToHuman, isTileVisible } from '../game/systems/fog';
import {
  EXPLOSION_FRAMES,
  FLAK_FRAMES,
  FLARE_FRAMES,
  PROP_FRAMES,
  ROTOR_FRAMES,
  SHOCKWAVE_FRAMES,
  airChromeFor,
  beamInk,
  drawPixelText,
  facingIndex,
  getBeamFlare,
  getBombSprite,
  getBuildingSprite,
  getExplosionSprite,
  getFlakPuff,
  getMuzzleFlash,
  getPlasmaBolt,
  getPropSprite,
  getRotorSprite,
  getTerrainSprite,
  getTowerTurret,
  getShockwave,
  getUnitSprite,
  getUnitTurret,
  type BeamStyle,
} from './sprites';

export interface HudInfo {
  fps: number;
  speed: number;
  /** In-progress selection box, if any. */
  drag?: LiveDrag | null;
  /** Pointer position in screen px. */
  pointerX?: number;
  pointerY?: number;
}

/** Shroud tint over explored-but-unseen ground (alpha 0..255). */
const FOG_EXPLORED_ALPHA = 115; // ~45%

const HEALTH_BAR_H = 3;

/**
 * V2: how far down-right an aircraft's ground shadow sits. This is the only cue
 * that says "this thing is above the battlefield", so it is deliberately a
 * whole 6px — a quarter of a tile — rather than a subtle one. A docked aircraft
 * drops it to `AIR_SHADOW_DOCKED`, which reads as "wheels down".
 */
const AIR_SHADOW_OFFSET = 6;
const AIR_SHADOW_DOCKED = 2;

/**
 * C2: a render-side impact effect, spawned when a round the sim does not tag on
 * detonation disappears from `state.projectiles`.
 *
 * Why this exists: `Effect` carries no weapon id on an explosion, so the flak
 * airburst and the dive bomber's heavier blast cannot be told apart from any
 * other splash by the effect alone — and adding a field to `Effect` would be a
 * sim change. Instead the renderer watches the two weapons that want their own
 * look, remembers each round's committed impact point (`Projectile.target`), and
 * emits its own effect when the round leaves the array. It is purely additive:
 * the sim's own explosion still plays underneath, so a missed round degrades to
 * exactly the pre-C2 picture.
 */
interface ImpactFx {
  kind: 'flak' | 'bomb';
  x: number;
  y: number;
  startTick: number;
  life: number;
}

/** Weapons the impact tracker watches. Anything else is left to `Effect`. */
const TRACKED_IMPACTS: Record<string, ImpactFx['kind']> = {
  flakBurst: 'flak',
  bombRun: 'bomb',
};

const IMPACT_LIFE: Record<ImpactFx['kind'], number> = { flak: 10, bomb: 14 };
/** Hard cap, mirroring the sim's own 192-effect cap. */
const MAX_IMPACT_FX = 96;

const SIDEBAR_BG = '#14170f';
const SIDEBAR_EDGE = '#2e3423';
const SIDEBAR_TEXT = '#c8d69a';
const SIDEBAR_DIM = '#6f7a52';

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly camera: Camera;

  /** Pre-composited terrain for the whole map. */
  private readonly terrainCanvas: HTMLCanvasElement;
  private readonly terrainCtx: CanvasRenderingContext2D;
  /** Flat tile indices awaiting a redraw. */
  private readonly dirtyTiles = new Set<number>();
  private terrainBuilt = false;

  /**
   * Fog layer: one pixel per tile, blitted up by TILE with smoothing off so it
   * reads as hard-edged shroud. Rebuilt only when `state.fog.version` moves.
   */
  private readonly fogCanvas: HTMLCanvasElement;
  private readonly fogCtx: CanvasRenderingContext2D;
  private readonly fogImage: ImageData;
  private fogVersion = -1;

  /** F toggles the tile grid + passability overlay. */
  debugOverlay = false;

  /** C2: render-side impact effects + the projectile bookkeeping that feeds them. */
  private readonly impactFx: ImpactFx[] = [];
  private readonly trackedRounds = new Map<number, { x: number; y: number; kind: ImpactFx['kind'] }>();
  /** The tick the tracker last diffed, so it runs once per tick, not per frame. */
  private trackedTick = -1;

  /**
   * Phase 3: `render/ui.ts` owns the sidebar strip. When this hook is set the
   * renderer hands the whole strip over to it instead of drawing the Phase 1
   * placeholder.
   */
  sidebarDraw: ((ctx: CanvasRenderingContext2D, state: GameState, hud: HudInfo) => void) | null =
    null;

  /**
   * Post-release: the in-world HUD (`render/hud.ts` draws the objectives
   * readout here). Called after the sidebar but *before* the result curtain, so
   * a decided mission dims it along with everything else.
   */
  hudDraw: ((ctx: CanvasRenderingContext2D, state: GameState) => void) | null = null;

  /**
   * Post-release: modal overlays (the help screen). Called last of all, over
   * the sidebar and over the result curtain.
   */
  overlayDraw: ((ctx: CanvasRenderingContext2D, state: GameState) => void) | null = null;

  /**
   * Post-release: the post-match debriefing panel (`render/debrief.ts`), which
   * replaced the Phase 5 flat curtain. Called for a decided mission only, in the
   * curtain's old slot — after the sidebar and the objectives readout, before
   * the modal overlay — so it dims everything under it and the help screen still
   * sits on top. Another additive hook, exactly like `sidebarDraw` / `hudDraw`.
   */
  resultDraw:
    | ((ctx: CanvasRenderingContext2D, state: GameState, w: number, h: number) => void)
    | null = null;

  constructor(canvas: HTMLCanvasElement, camera: Camera) {
    this.camera = camera;
    this.ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
    this.ctx.imageSmoothingEnabled = false;

    const terrainCanvas = document.createElement('canvas');
    terrainCanvas.width = WORLD_W;
    terrainCanvas.height = WORLD_H;
    this.terrainCanvas = terrainCanvas;
    this.terrainCtx = terrainCanvas.getContext('2d', {
      alpha: false,
    }) as CanvasRenderingContext2D;
    this.terrainCtx.imageSmoothingEnabled = false;

    const fogCanvas = document.createElement('canvas');
    fogCanvas.width = MAP_W;
    fogCanvas.height = MAP_H;
    this.fogCanvas = fogCanvas;
    this.fogCtx = fogCanvas.getContext('2d') as CanvasRenderingContext2D;
    this.fogImage = this.fogCtx.createImageData(MAP_W, MAP_H);
  }

  // --- terrain cache ------------------------------------------------------

  /** Full re-composite of the terrain layer. */
  buildTerrain(map: MapData): void {
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        this.drawTerrainTile(map, tx, ty);
      }
    }
    this.dirtyTiles.clear();
    this.terrainBuilt = true;
  }

  /** Mark a single tile for redraw (e.g. after crystal depletion). */
  markTileDirty(tx: number, ty: number): void {
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return;
    this.dirtyTiles.add(tileIndex(tx, ty));
  }

  /** Mark a rectangular tile region dirty. */
  markRectDirty(tx: number, ty: number, w: number, h: number): void {
    for (let y = ty; y < ty + h; y++) {
      for (let x = tx; x < tx + w; x++) this.markTileDirty(x, y);
    }
  }

  /** Force a full terrain rebuild on the next frame. */
  markAllDirty(): void {
    this.terrainBuilt = false;
  }

  private drawTerrainTile(map: MapData, tx: number, ty: number): void {
    const i = tileIndex(tx, ty);
    const sprite = getTerrainSprite(map.terrain[i] as number, map.variant[i] as number);
    this.terrainCtx.drawImage(sprite, tx * TILE, ty * TILE);
  }

  private flushDirty(map: MapData): void {
    if (!this.terrainBuilt) {
      this.buildTerrain(map);
      return;
    }
    if (this.dirtyTiles.size === 0) return;
    for (const idx of this.dirtyTiles) {
      const tx = idx % MAP_W;
      const ty = (idx - tx) / MAP_W;
      this.drawTerrainTile(map, tx, ty);
    }
    this.dirtyTiles.clear();
  }

  // --- frame --------------------------------------------------------------

  render(state: GameState, alpha: number, hud: HudInfo): void {
    const cam = this.camera;
    const ctx = this.ctx;

    this.flushDirty(state.map);

    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cam.canvasW, cam.canvasH);

    // Clip world drawing to the view (never bleed under the sidebar).
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cam.viewW, cam.viewH);
    ctx.clip();

    const camX = Math.round(cam.x);
    const camY = Math.round(cam.y);
    this.trackImpacts(state);
    this.drawTerrain(camX, camY);
    this.drawBuildings(state, camX, camY);
    this.drawUnits(state, alpha, camX, camY);
    this.drawProjectiles(state, alpha, camX, camY);
    this.drawEffects(state, alpha, camX, camY);
    this.drawImpactFx(state, alpha, camX, camY);
    this.drawFog(state, camX, camY);
    this.drawPlacementGhost(state, camX, camY);
    if (this.debugOverlay) this.drawDebugOverlay(state, camX, camY);
    if (hud.drag) this.drawSelectionBox(hud.drag);

    ctx.restore();

    this.drawSidebar(state, hud);
    if (this.hudDraw) this.hudDraw(ctx, state);
    this.drawResultOverlay(state);
    if (this.overlayDraw) this.overlayDraw(ctx, state);
  }

  /**
   * Mission result. Phase 5 drew a flat curtain here; post-release it is the
   * full debriefing panel, owned by `render/debrief.ts` and installed through
   * `resultDraw` (the renderer knows nothing about the map name, the difficulty
   * or the stat table — `main.ts` closes over those, exactly as it does for the
   * sidebar and the HUD).
   *
   * The sim keeps ticking underneath; the tick just stops accepting orders and
   * listens for R / a click (restart) or T (back to the title).
   */
  private drawResultOverlay(state: GameState): void {
    if (state.result === 'playing') return;
    if (!this.resultDraw) return;
    const cam = this.camera;
    this.resultDraw(this.ctx, state, cam.canvasW, cam.canvasH);
  }

  /**
   * Drop the cached shroud bitmap. Needed after a restart, where the new
   * state's `fog.version` may collide with the version already cached.
   */
  invalidateFog(): void {
    this.fogVersion = -1;
  }

  /**
   * C2: drop the render-side impact effects and the rounds being watched for
   * them. Called from `restart()` alongside `buildTerrain` / `invalidateFog`,
   * because both are keyed on `state.tick` and on entity ids, and a new mission
   * restarts both numberings.
   */
  resetFx(): void {
    this.impactFx.length = 0;
    this.trackedRounds.clear();
    this.trackedTick = -1;
  }

  /**
   * Phase 6: the title screen owns the entire canvas. `renderTitle` prepares
   * the surface (and keeps the terrain cache warm so the backdrop is ready the
   * instant the mission starts), then hands ctx + the composited terrain layer
   * to whatever `titleDraw` is set to.
   */
  titleDraw:
    | ((ctx: CanvasRenderingContext2D, terrain: HTMLCanvasElement, w: number, h: number) => void)
    | null = null;

  renderTitle(state: GameState): void {
    const ctx = this.ctx;
    const cam = this.camera;
    this.flushDirty(state.map);
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cam.canvasW, cam.canvasH);
    if (this.titleDraw) this.titleDraw(ctx, this.terrainCanvas, cam.canvasW, cam.canvasH);
  }

  private drawTerrain(camX: number, camY: number): void {
    const cam = this.camera;
    const sw = Math.min(cam.viewW, WORLD_W - camX);
    const sh = Math.min(cam.viewH, WORLD_H - camY);
    if (sw <= 0 || sh <= 0) return;
    this.ctx.drawImage(this.terrainCanvas, camX, camY, sw, sh, 0, 0, sw, sh);
  }

  /**
   * Which cached art frame a structure shows this instant. Power plants pulse
   * their reactor glow, comm centres sweep the dish, and silos show their
   * owner's stored credits as a fill level. Everything else is single-frame.
   */
  private buildingFrame(state: GameState, b: (typeof state.buildings)[number]): number {
    switch (b.type) {
      case 'powerPlant':
        return Math.floor(state.tick / 10) % 2;
      case 'commCenter':
        return Math.floor(state.tick / 6) % 4;
      case 'silo': {
        const p = state.players[b.player];
        const frac = p.storage > 0 ? p.credits / p.storage : 0;
        return Math.max(0, Math.min(3, Math.floor(frac * 4)));
      }
      // C2: the Laser Tower's frames are a power state, not an animation. A
      // tower whose owner is in deficit goes dark — which is the visible half of
      // the Phase 4 rule that `weaponOf` returns null for a defence under
      // `lowPower`, and until now nothing on screen said so.
      case 'lasertower':
        return state.players[b.player].lowPower ? 0 : 1;
      default:
        return 0;
    }
  }

  private drawBuildings(state: GameState, camX: number, camY: number): void {
    const ctx = this.ctx;
    const selected = state.selection;
    for (const b of state.buildings) {
      if (b.dead) continue;
      if (!isEntityVisibleToHuman(state, b)) continue;
      const def = BUILDING_TYPES[b.type];
      const wpx = def.w * TILE;
      const hpx = def.h * TILE;
      const sx = b.tx * TILE - camX;
      const sy = b.ty * TILE - camY;
      if (sx + wpx < 0 || sy + hpx < 0 || sx > this.camera.viewW || sy > this.camera.viewH) {
        continue;
      }
      const frame = this.buildingFrame(state, b);
      const building = b.status === 'constructing';
      if (b.status === 'selling') {
        // Sold: the structure is being dismantled. It sinks into its own
        // footprint and fades out over SELL_TIME, then dies (no explosion).
        const left = Math.max(0, (b.sellAt ?? state.tick) - state.tick);
        const t = Math.max(0, Math.min(1, left / SELL_TIME));
        const sprite = getBuildingSprite(b.type, b.player, 'ready', frame);
        const scale = 0.35 + 0.65 * t;
        const dw = Math.max(1, Math.round(sprite.width * scale));
        const dh = Math.max(1, Math.round(sprite.height * scale));
        ctx.globalAlpha = 0.25 + 0.75 * t;
        ctx.drawImage(
          sprite,
          Math.round(sx + (wpx - dw) / 2),
          Math.round(sy + hpx - dh),
          dw,
          dh,
        );
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.drawImage(
        getBuildingSprite(b.type, b.player, building ? 'constructing' : 'ready', frame),
        sx,
        sy,
      );
      if (building) {
        // Cross-fade the finished structure in over the scaffold.
        ctx.globalAlpha = Math.max(0, Math.min(1, b.buildProgress));
        ctx.drawImage(getBuildingSprite(b.type, b.player, 'ready', frame), sx, sy);
        ctx.globalAlpha = 1;
      } else if (def.turret) {
        // Defensive structures composite their gun at `turretFacing`. C2 gives
        // each era's emplacement its own weapon (C1 shipped them all wearing the
        // 1991 autocannon); the type is the only new argument.
        const turret = getTowerTurret(b.player, facingIndex(b.turretFacing ?? 0), b.type);
        ctx.drawImage(
          turret,
          Math.round(sx + wpx / 2 - turret.width / 2),
          Math.round(sy + hpx / 2 - turret.height / 2 - 2),
        );
      }

      const isSelected = selected.includes(b.id);
      if (isSelected) this.drawSelectionBrackets(sx, sy, wpx, hpx);
      if (isSelected || b.hp < b.maxHp) {
        this.drawHealthBar(sx + 2, sy - 5, wpx - 4, b.hp / b.maxHp);
      }
    }
  }

  /**
   * Units, in two passes: everything on the ground first, then everything in
   * the air. Aircraft therefore composite over ground units *and* over the
   * structures drawn before them, which — together with the offset shadow — is
   * what makes altitude read.
   */
  private drawUnits(state: GameState, alpha: number, camX: number, camY: number): void {
    const air: Unit[] = [];
    for (const u of state.units) {
      if (u.dead) continue;
      if (!isEntityVisibleToHuman(state, u)) continue;
      if (UNIT_TYPES[u.type].isAir) {
        air.push(u);
        continue;
      }
      this.drawUnit(state, u, alpha, camX, camY);
    }
    for (const u of air) this.drawUnit(state, u, alpha, camX, camY);
  }

  private drawUnit(
    state: GameState,
    u: Unit,
    alpha: number,
    camX: number,
    camY: number,
  ): void {
    const ctx = this.ctx;
    const def = UNIT_TYPES[u.type];
    // Interpolate between ticks using the velocity carried on the unit.
    const wx = u.pos.x + u.vel.x * alpha;
    const wy = u.pos.y + u.vel.y * alpha;
    const sx = Math.round(wx - camX);
    const sy = Math.round(wy - camY);
    const r = def.radius + 8;
    if (sx + r < 0 || sy + r < 0 || sx - r > this.camera.viewW || sy - r > this.camera.viewH) {
      return;
    }

    // Hull follows `facing`; a turreted type composites its turret on top at
    // the independently-tracked `turretFacing`.
    const hull = getUnitSprite(u.type, u.player, facingIndex(u.facing), (u.cargo ?? 0) > 0);

    if (def.isAir) {
      // Ground shadow first, offset down-right from the airframe.
      const off = u.docked ? AIR_SHADOW_DOCKED : AIR_SHADOW_OFFSET;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
      ctx.beginPath();
      ctx.ellipse(sx + off, sy + off, def.radius * 0.85, def.radius * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.drawImage(hull, Math.round(sx - hull.width / 2), Math.round(sy - hull.height / 2));

    if (def.turret) {
      const turret = getUnitTurret(u.type, u.player, facingIndex(u.turretFacing ?? u.facing));
      if (turret) {
        ctx.drawImage(
          turret,
          Math.round(sx - turret.width / 2),
          Math.round(sy - turret.height / 2),
        );
      }
    }

    if (def.isAir) {
      // What spins over the airframe is era art, not a property of flight: V2
      // keyed the helicopter rotor on `isAir`, which put a rotor disc over a
      // 1943 prop bomber and over a 2077 drone with no moving parts at all.
      // It still spins with the sim clock while airborne and idles on a single
      // frame while docked, which (with the tight shadow) reads as "on the pad".
      const chrome = airChromeFor(u.type);
      if (chrome === 'rotor') {
        const frame = u.docked ? 0 : Math.floor(state.tick) % ROTOR_FRAMES;
        const rotor = getRotorSprite(u.player, frame);
        ctx.globalAlpha = u.docked ? 0.55 : 0.8;
        ctx.drawImage(rotor, Math.round(sx - rotor.width / 2), Math.round(sy - rotor.height / 2));
        ctx.globalAlpha = 1;
      } else if (chrome === 'prop') {
        // A propeller lives at the nose, so the disc is offset along the hull's
        // facing rather than centred on it.
        const frame = u.docked ? 0 : Math.floor(state.tick) % PROP_FRAMES;
        const prop = getPropSprite(u.player, frame);
        const nose = def.radius * 0.78;
        const px = sx + Math.cos(u.facing) * nose;
        const py = sy + Math.sin(u.facing) * nose;
        ctx.globalAlpha = u.docked ? 0.5 : 0.85;
        ctx.drawImage(prop, Math.round(px - prop.width / 2), Math.round(py - prop.height / 2));
        ctx.globalAlpha = 1;
      }
    }

    const size = def.radius * 2 + 4;
    const selected = state.selection;
    const isSelected = selected.includes(u.id);
    if (isSelected) {
      this.drawSelectionBrackets(sx - size / 2 - 2, sy - size / 2 - 2, size + 4, size + 4);
    }
    if (isSelected || u.hp < u.maxHp) {
      this.drawHealthBar(sx - size / 2, sy - size / 2 - 6, size, u.hp / u.maxHp);
    }
    // V2: ammo pips under the health bar, for a selected aircraft.
    if (isSelected && def.ammo > 0) {
      this.drawAmmoPips(sx - size / 2, sy - size / 2 - 11, size, u.ammo ?? def.ammo, def.ammo);
    }
    // V2: rearm clock on a docked aircraft — shown whether or not it is
    // selected, so a player can see the pad is busy at a glance.
    if (u.docked && def.rearmTime > 0) {
      const left = Math.max(0, (u.rearmAt ?? state.tick) - state.tick);
      this.drawRearmBar(sx - size / 2, sy + size / 2 + 3, size, 1 - left / def.rearmTime);
    }
    // Stance tag, next to the health bar. Always on for a selected unit, and
    // always on for a unit that is NOT on the default offensive stance, so a
    // scout left on explore is visible at a glance without selecting it.
    if (u.player === PLAYER_HUMAN) {
      const stance = stanceOf(u);
      if (isSelected || stance !== 'offensive') {
        this.drawStanceTag(sx + size / 2 + 3, sy - size / 2 - 8, stance);
      }
    }
  }

  /**
   * One pip per round in the pod, sitting just above the health bar. Spent
   * rounds stay as dark sockets so the magazine size is always readable.
   */
  private drawAmmoPips(x: number, y: number, w: number, ammo: number, max: number): void {
    if (max <= 0) return;
    const ctx = this.ctx;
    const width = Math.max(8, Math.round(w));
    const px = Math.round(x);
    const py = Math.round(y);
    const gap = 1;
    const pipW = Math.max(1, Math.floor((width - gap * (max - 1)) / max));
    const span = pipW * max + gap * (max - 1);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(px - 1, py - 1, span + 2, 4);
    for (let i = 0; i < max; i++) {
      ctx.fillStyle = i < ammo ? '#e0b53c' : '#4a4326';
      ctx.fillRect(px + i * (pipW + gap), py, pipW, 2);
    }
  }

  /** Gold progress bar under a docked aircraft while its pod refills. */
  private drawRearmBar(x: number, y: number, w: number, frac: number): void {
    const ctx = this.ctx;
    const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const width = Math.max(8, Math.round(w));
    const px = Math.round(x);
    const py = Math.round(y);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(px - 1, py - 1, width + 2, 4);
    ctx.fillStyle = '#2a2f1e';
    ctx.fillRect(px, py, width, 2);
    ctx.fillStyle = '#e0b53c';
    ctx.fillRect(px, py, Math.round(width * f), 2);
  }

  /**
   * One 5x7 letter on a dark plate: E(xplore) / D(efensive) / O(ffensive).
   * A letter beats a chevron here — it is legible at a 24px tile on both house
   * schemes, and the plate keeps it readable over any terrain.
   */
  private drawStanceTag(x: number, y: number, stance: UnitStance): void {
    const ctx = this.ctx;
    const letter = stance === 'explore' ? 'E' : stance === 'defensive' ? 'D' : 'O';
    const color =
      stance === 'explore' ? '#6ec6ff' : stance === 'defensive' ? '#e8c33c' : '#ff8a5a';
    const px = Math.round(x);
    const py = Math.round(y);
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(px - 1, py - 1, 7, 9);
    drawPixelText(ctx, letter, px, py, 1, color);
  }

  // --- combat layers ------------------------------------------------------

  /**
   * Health bar: green above 60%, yellow above 30%, red below. Drawn for every
   * damaged entity and always for the current selection.
   */
  private drawHealthBar(x: number, y: number, w: number, frac: number): void {
    const ctx = this.ctx;
    const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const width = Math.max(8, Math.round(w));
    const px = Math.round(x);
    const py = Math.round(y);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(px - 1, py - 1, width + 2, HEALTH_BAR_H + 2);
    ctx.fillStyle = '#2a2f1e';
    ctx.fillRect(px, py, width, HEALTH_BAR_H);
    ctx.fillStyle = f > 0.6 ? '#5fd06a' : f > 0.3 ? '#e8c33c' : '#d0432c';
    ctx.fillRect(px, py, Math.round(width * f), HEALTH_BAR_H);
  }

  /**
   * Projectiles. Bullets are near-hitscan, so they draw as a bright tracer
   * streak from last tick's position; rockets get a smoke trail and a flame;
   * artillery shells lift off the ground on `arc` and drop a shadow on it.
   */
  private drawProjectiles(state: GameState, alpha: number, camX: number, camY: number): void {
    const ctx = this.ctx;
    for (const p of state.projectiles as Projectile[]) {
      if (p.dead) continue;
      const wx = p.prev.x + (p.pos.x - p.prev.x) * alpha;
      const wy = p.prev.y + (p.pos.y - p.prev.y) * alpha;
      const sx = wx - camX;
      const sy = wy - camY;
      if (sx < -32 || sy < -64 || sx > this.camera.viewW + 32 || sy > this.camera.viewH + 32) {
        continue;
      }
      if (!isTileVisible(state, Math.floor(wx / TILE), Math.floor(wy / TILE))) continue;

      // C2: energy rounds are their own thing — a glowing bolt with a soft
      // trail rather than a tracer streak. Keyed on the *warhead*, so plasma
      // bolts, pulse-cannon shells and drone bolts all read as one weapon
      // family without the renderer knowing a single unit type name.
      if (p.warhead === 'plasma' || p.warhead === 'railSlug') {
        const rail = p.warhead === 'railSlug';
        const size = p.damage >= 30 ? 4 : p.damage >= 18 ? 3 : 2;
        const bolt = getPlasmaBolt(size, rail ? 'rail' : 'plasma');
        ctx.strokeStyle = rail ? 'rgba(200, 190, 255, 0.45)' : 'rgba(90, 240, 200, 0.40)';
        ctx.lineWidth = rail ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(p.prev.x - camX, p.prev.y - camY);
        ctx.lineTo(sx, sy);
        ctx.stroke();
        ctx.drawImage(bolt, Math.round(sx - bolt.width / 2), Math.round(sy - bolt.height / 2));
        continue;
      }

      if (p.kind === 'bullet') {
        // 1943 flak is a dark shell with a burning tracer element, not a
        // machine-gun streak; the airburst itself comes from `impactFx`.
        const flak = p.weapon === 'flakBurst';
        ctx.strokeStyle = flak ? 'rgba(255, 190, 120, 0.75)' : 'rgba(255, 238, 170, 0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.prev.x - camX, p.prev.y - camY);
        ctx.lineTo(sx, sy);
        ctx.stroke();
        if (flak) {
          ctx.fillStyle = '#2b2c22';
          ctx.fillRect(Math.round(sx) - 2, Math.round(sy) - 1, 3, 2);
          ctx.fillStyle = '#ffd75e';
          ctx.fillRect(Math.round(sx) + 1, Math.round(sy) - 1, 1, 2);
        } else {
          ctx.fillStyle = '#fff6d0';
          ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 1, 2, 2);
        }
        continue;
      }

      // A beam is a line from the muzzle (`prev`) to the impact (`pos`), already
      // resolved by the sim on the tick it was fired; `life` is the four ticks
      // it lingers for. C2 draws it as a real laser: a wide soft bloom, a
      // saturated mid stroke and a white-hot core, plus a collapsing flare at
      // the impact and a spark back at the muzzle. Colour follows the weapon —
      // the 2077 tower cuts teal, the phase lance is violet and much heavier.
      if (p.kind === 'beam') {
        const life = Math.max(1, BEAM_LIFE);
        const fade = clamp((p.life ?? 0) / life, 0, 1);
        const style: BeamStyle = p.weapon === 'beamLance' ? 'lance' : 'laser';
        const ink = beamInk(style);
        const heavy = style === 'lance';
        const x0 = p.prev.x - camX;
        const y0 = p.prev.y - camY;
        const x1 = p.pos.x - camX;
        const y1 = p.pos.y - camY;
        const stroke = (color: string, width: number): void => {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        };
        ctx.globalAlpha = 0.35 + 0.65 * fade;
        stroke(ink.glow, heavy ? 10 : 7);
        stroke(ink.glow, heavy ? 6 : 4);
        stroke(ink.mid, heavy ? 4 : 2.5);
        stroke(ink.core, heavy ? 2 : 1);
        ctx.globalAlpha = 1;

        const frame = Math.min(FLARE_FRAMES - 1, Math.floor((1 - fade) * FLARE_FRAMES));
        const flare = getBeamFlare(style, frame);
        ctx.globalAlpha = fade;
        ctx.drawImage(flare, Math.round(x1 - flare.width / 2), Math.round(y1 - flare.height / 2));
        const spark = getBeamFlare(style, Math.min(FLARE_FRAMES - 1, frame + 1));
        ctx.globalAlpha = fade * 0.7;
        ctx.drawImage(spark, Math.round(x0 - spark.width / 2), Math.round(y0 - spark.height / 2));
        ctx.globalAlpha = 1;
        continue;
      }

      if (p.kind === 'rocket') {
        const dir = Math.atan2(p.vel.y, p.vel.x);
        ctx.strokeStyle = 'rgba(190, 190, 180, 0.45)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx - Math.cos(dir) * 14, sy - Math.sin(dir) * 14);
        ctx.lineTo(sx, sy);
        ctx.stroke();
        ctx.fillStyle = '#f28a2b';
        ctx.fillRect(Math.round(sx - Math.cos(dir) * 4) - 1, Math.round(sy - Math.sin(dir) * 4) - 1, 3, 3);
        ctx.fillStyle = '#d8d8c8';
        ctx.fillRect(Math.round(sx) - 2, Math.round(sy) - 2, 4, 4);
        continue;
      }

      // shell / arc
      const lift = p.arc ?? 0;
      if (lift > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.beginPath();
        ctx.ellipse(sx, sy, 4, 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // C2: a dive bomber's stick is a bomb, not a howitzer shell — it tumbles
      // nose-over-tail all the way down and lands with a shockwave.
      if (p.weapon === 'bombRun') {
        const bomb = getBombSprite(Math.floor(state.tick / 2 + p.id));
        ctx.drawImage(
          bomb,
          Math.round(sx - bomb.width / 2),
          Math.round(sy - lift - bomb.height / 2),
        );
        continue;
      }
      ctx.fillStyle = '#2b2c22';
      ctx.fillRect(Math.round(sx) - 2, Math.round(sy - lift) - 2, 4, 4);
      ctx.fillStyle = '#b9bda2';
      ctx.fillRect(Math.round(sx) - 1, Math.round(sy - lift) - 2, 2, 2);
    }
  }

  /**
   * Diff `state.projectiles` once per tick and emit a render-side effect for a
   * watched round that has left the array (i.e. detonated or fizzled). The
   * impact point is the round's own committed `target`, not its last drawn
   * position, so the burst lands where the shot landed rather than a tick short.
   */
  private trackImpacts(state: GameState): void {
    if (state.tick === this.trackedTick) return;
    this.trackedTick = state.tick;

    const live = new Set<number>();
    for (const p of state.projectiles as Projectile[]) {
      if (p.dead) continue;
      const kind = p.weapon ? TRACKED_IMPACTS[p.weapon] : undefined;
      if (!kind) continue;
      live.add(p.id);
      const rec = this.trackedRounds.get(p.id);
      if (rec) {
        rec.x = p.target.x;
        rec.y = p.target.y;
      } else {
        this.trackedRounds.set(p.id, { x: p.target.x, y: p.target.y, kind });
      }
    }

    for (const [id, rec] of this.trackedRounds) {
      if (live.has(id)) continue;
      this.trackedRounds.delete(id);
      if (this.impactFx.length >= MAX_IMPACT_FX) continue;
      this.impactFx.push({
        kind: rec.kind,
        x: rec.x,
        y: rec.y,
        startTick: state.tick,
        life: IMPACT_LIFE[rec.kind],
      });
    }

    // Age the list here rather than in draw, so it stays bounded even when the
    // page is not painting (a backgrounded tab still ticks).
    for (let i = this.impactFx.length - 1; i >= 0; i--) {
      const fx = this.impactFx[i] as ImpactFx;
      if (state.tick - fx.startTick > fx.life) this.impactFx.splice(i, 1);
    }
  }

  /**
   * The C2 impact layer: flak airbursts and bomb shockwaves, drawn *over* the
   * sim's own explosion effects so the two composite into one heavier blast.
   * Fog-gated exactly like `drawEffects` — you do not see what you cannot see.
   */
  private drawImpactFx(state: GameState, alpha: number, camX: number, camY: number): void {
    if (this.impactFx.length === 0) return;
    const ctx = this.ctx;
    const now = state.tick + alpha;
    for (const fx of this.impactFx) {
      const age = now - fx.startTick;
      if (age < 0 || age > fx.life) continue;
      const sx = fx.x - camX;
      const sy = fx.y - camY;
      if (sx < -64 || sy < -64 || sx > this.camera.viewW + 64 || sy > this.camera.viewH + 64) {
        continue;
      }
      if (!isTileVisible(state, Math.floor(fx.x / TILE), Math.floor(fx.y / TILE))) continue;

      const t = Math.max(0, Math.min(0.999, age / fx.life));
      if (fx.kind === 'flak') {
        const sprite = getFlakPuff(Math.floor(t * FLAK_FRAMES));
        ctx.drawImage(
          sprite,
          Math.round(sx - sprite.width / 2),
          Math.round(sy - sprite.height / 2),
        );
        continue;
      }
      // A 50px-splash bomb: the ordinary explosion plus an expanding ring.
      const sprite = getShockwave(Math.floor(t * SHOCKWAVE_FRAMES), 40);
      ctx.drawImage(sprite, Math.round(sx - sprite.width / 2), Math.round(sy - sprite.height / 2));
    }
  }

  /** Muzzle flashes and explosion animations, aged off `state.tick`. */
  private drawEffects(state: GameState, alpha: number, camX: number, camY: number): void {
    const ctx = this.ctx;
    const now = state.tick + alpha;
    for (const fx of state.effects as Effect[]) {
      const age = now - fx.startTick;
      if (age < 0 || age > fx.life) continue;
      const sx = fx.x - camX;
      const sy = fx.y - camY;
      if (sx < -64 || sy < -64 || sx > this.camera.viewW + 64 || sy > this.camera.viewH + 64) {
        continue;
      }
      if (!isTileVisible(state, Math.floor(fx.x / TILE), Math.floor(fx.y / TILE))) continue;

      if (fx.kind === 'muzzle') {
        const sprite = getMuzzleFlash(fx.size);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(fx.facing ?? 0);
        ctx.globalAlpha = 1 - age / fx.life;
        ctx.drawImage(sprite, 0, -sprite.height / 2);
        ctx.restore();
        ctx.globalAlpha = 1;
        continue;
      }

      const frame = Math.min(EXPLOSION_FRAMES - 1, Math.floor((age / fx.life) * EXPLOSION_FRAMES));
      const sprite = getExplosionSprite(frame, fx.size);
      ctx.drawImage(sprite, Math.round(sx - sprite.width / 2), Math.round(sy - sprite.height / 2));
    }
  }

  /**
   * Fog layer. The 96x96 shroud bitmap is rebuilt only when the fog system
   * reports a change, then blitted scaled (smoothing off) over the world.
   */
  private drawFog(state: GameState, camX: number, camY: number): void {
    if (!state.fog.enabled) return;
    if (this.fogVersion !== state.fog.version) {
      this.rebuildFog(state);
      this.fogVersion = state.fog.version;
    }
    const cam = this.camera;
    const tx0 = Math.max(0, Math.floor(camX / TILE));
    const ty0 = Math.max(0, Math.floor(camY / TILE));
    const tx1 = Math.min(MAP_W, Math.ceil((camX + cam.viewW) / TILE));
    const ty1 = Math.min(MAP_H, Math.ceil((camY + cam.viewH) / TILE));
    const tw = tx1 - tx0;
    const th = ty1 - ty0;
    if (tw <= 0 || th <= 0) return;
    this.ctx.drawImage(
      this.fogCanvas,
      tx0,
      ty0,
      tw,
      th,
      tx0 * TILE - camX,
      ty0 * TILE - camY,
      tw * TILE,
      th * TILE,
    );
  }

  private rebuildFog(state: GameState): void {
    const { explored, visible } = state.fog;
    const data = this.fogImage.data;
    for (let i = 0, o = 0; i < explored.length; i++, o += 4) {
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = visible[i] === 1 ? 0 : explored[i] === 1 ? FOG_EXPLORED_ALPHA : 255;
    }
    this.fogCtx.putImageData(this.fogImage, 0, 0);
  }

  /**
   * Structure placement ghost (Phase 3). Validity is decided in the tick by the
   * sidebar/production system and carried on `state.ui.placement.valid`, so the
   * renderer only picks a colour.
   */
  private drawPlacementGhost(state: GameState, camX: number, camY: number): void {
    const ghost = state.ui.placement;
    if (!ghost) return;
    const def = BUILDING_TYPES[ghost.type];
    const ctx = this.ctx;
    const x = ghost.tx * TILE - camX;
    const y = ghost.ty * TILE - camY;
    const w = def.w * TILE;
    const h = def.h * TILE;

    ctx.fillStyle = ghost.valid ? 'rgba(95, 208, 106, 0.30)' : 'rgba(200, 64, 44, 0.30)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = ghost.valid ? '#8dff6a' : '#ff6a5a';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

    // Per-tile grid so the footprint reads at a glance.
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < def.w; i++) {
      ctx.moveTo(x + i * TILE + 0.5, y);
      ctx.lineTo(x + i * TILE + 0.5, y + h);
    }
    for (let i = 1; i < def.h; i++) {
      ctx.moveTo(x, y + i * TILE + 0.5);
      ctx.lineTo(x + w, y + i * TILE + 0.5);
    }
    ctx.stroke();
  }

  private drawSelectionBrackets(x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    const len = Math.max(4, Math.min(8, Math.floor(Math.min(w, h) / 3)));
    ctx.strokeStyle = '#8dff6a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Four corner brackets, C&C style.
    ctx.moveTo(x + 0.5, y + len);
    ctx.lineTo(x + 0.5, y + 0.5);
    ctx.lineTo(x + len, y + 0.5);
    ctx.moveTo(x + w - len, y + 0.5);
    ctx.lineTo(x + w - 0.5, y + 0.5);
    ctx.lineTo(x + w - 0.5, y + len);
    ctx.moveTo(x + 0.5, y + h - len);
    ctx.lineTo(x + 0.5, y + h - 0.5);
    ctx.lineTo(x + len, y + h - 0.5);
    ctx.moveTo(x + w - len, y + h - 0.5);
    ctx.lineTo(x + w - 0.5, y + h - 0.5);
    ctx.lineTo(x + w - 0.5, y + h - len);
    ctx.stroke();
  }

  private drawSelectionBox(drag: LiveDrag): void {
    const ctx = this.ctx;
    const x = Math.min(drag.startX, drag.x);
    const y = Math.min(drag.startY, drag.y);
    const w = Math.abs(drag.x - drag.startX);
    const h = Math.abs(drag.y - drag.startY);
    ctx.strokeStyle = '#8dff6a';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    ctx.fillStyle = 'rgba(141,255,106,0.08)';
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  // --- debug overlay ------------------------------------------------------

  private drawDebugOverlay(state: GameState, camX: number, camY: number): void {
    const ctx = this.ctx;
    const map = state.map;
    const { tx0, ty0, tx1, ty1 } = this.camera.visibleTileBounds();

    // Impassable tint.
    ctx.fillStyle = 'rgba(220, 60, 60, 0.28)';
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = tileIndex(tx, ty);
        if (map.passable[i] === 1 && map.occupied[i] === 0) continue;
        ctx.fillRect(tx * TILE - camX, ty * TILE - camY, TILE, TILE);
      }
    }

    // Buildable tint (subtle blue) on clear ground.
    ctx.fillStyle = 'rgba(70, 140, 240, 0.12)';
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (map.buildable[tileIndex(tx, ty)] !== 1) continue;
        ctx.fillRect(tx * TILE - camX, ty * TILE - camY, TILE, TILE);
      }
    }

    // Tile grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let tx = tx0; tx <= tx1 + 1; tx++) {
      const x = Math.round(tx * TILE - camX) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.camera.viewH);
    }
    for (let ty = ty0; ty <= ty1 + 1; ty++) {
      const y = Math.round(ty * TILE - camY) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(this.camera.viewW, y);
    }
    ctx.stroke();

    // Start positions.
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    for (const s of map.startTiles) {
      ctx.strokeRect(s.tx * TILE - camX - 6 * TILE, s.ty * TILE - camY - 6 * TILE, 13 * TILE, 13 * TILE);
    }
  }

  // --- sidebar ------------------------------------------------------------

  private drawSidebar(state: GameState, hud: HudInfo): void {
    const ctx = this.ctx;
    const cam = this.camera;
    if (this.sidebarDraw) {
      this.sidebarDraw(ctx, state, hud);
      return;
    }
    const x = cam.viewW;
    const w = Math.min(SIDEBAR_W, cam.canvasW - x);
    if (w <= 0) return;

    ctx.fillStyle = SIDEBAR_BG;
    ctx.fillRect(x, 0, w, cam.canvasH);
    ctx.fillStyle = SIDEBAR_EDGE;
    ctx.fillRect(x, 0, 2, cam.canvasH);

    ctx.textBaseline = 'top';
    ctx.fillStyle = SIDEBAR_TEXT;
    ctx.font = 'bold 15px "Courier New", monospace';
    ctx.fillText('CRYSTAL', x + 14, 16);
    ctx.fillText('DAWN', x + 14, 34);

    ctx.fillStyle = SIDEBAR_EDGE;
    ctx.fillRect(x + 12, 58, w - 24, 2);

    const p = state.players[0];
    ctx.font = '11px "Courier New", monospace';
    ctx.fillStyle = SIDEBAR_TEXT;
    ctx.fillText(`CREDITS ${Math.floor(p.credits)}`, x + 14, 70);
    ctx.fillStyle = SIDEBAR_DIM;
    ctx.fillText(`POWER   ${p.powerProduced}/${p.powerDrain}`, x + 14, 86);

    // Placeholder build-tab area (Phase 3/6 fills this in).
    ctx.fillStyle = '#1b2015';
    ctx.fillRect(x + 12, 108, w - 24, cam.canvasH - 190);
    ctx.strokeStyle = SIDEBAR_EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 12.5, 108.5, w - 25, cam.canvasH - 191);
    ctx.fillStyle = SIDEBAR_DIM;
    ctx.fillText('SIDEBAR', x + 22, 120);
    ctx.fillText('PHASE 3/6', x + 22, 134);

    // Debug readout.
    const bottom = cam.canvasH - 72;
    ctx.fillStyle = SIDEBAR_DIM;
    ctx.fillText(`TICK  ${state.tick}`, x + 14, bottom);
    ctx.fillText(`FPS   ${hud.fps}`, x + 14, bottom + 14);
    ctx.fillText(`SPEED ${hud.speed.toFixed(2)}x`, x + 14, bottom + 28);
    ctx.fillText(`F: DEBUG ${this.debugOverlay ? 'ON' : 'OFF'}`, x + 14, bottom + 42);
  }
}
