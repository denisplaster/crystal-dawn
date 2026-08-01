/**
 * Camera: world <-> screen transforms, panning, clamped to map bounds.
 *
 * The canvas fills the viewport; the right-hand SIDEBAR_W pixels are reserved
 * for the UI, so the *view* (world drawing area) is narrower than the canvas.
 */

import { clamp, SIDEBAR_W, TILE, WORLD_H, WORLD_W } from '../game/constants';

export class Camera {
  /** World-space position of the top-left corner of the view. */
  x = 0;
  y = 0;

  /** Full canvas size in CSS pixels. */
  canvasW = 0;
  canvasH = 0;

  /** World drawing area (canvas minus the reserved sidebar). */
  viewW = 0;
  viewH = 0;

  /** Device pixel ratio the canvas backing store is sized for. */
  dpr = 1;

  private readonly onResizeCallbacks: Array<(cam: Camera) => void> = [];

  constructor(canvasW: number, canvasH: number) {
    this.resize(canvasW, canvasH);
  }

  /** Called by main on window resize / boot. */
  resize(canvasW: number, canvasH: number, dpr = 1): void {
    this.canvasW = Math.max(1, Math.floor(canvasW));
    this.canvasH = Math.max(1, Math.floor(canvasH));
    this.dpr = dpr;
    this.viewW = Math.max(1, this.canvasW - SIDEBAR_W);
    this.viewH = this.canvasH;
    this.clampToBounds();
    for (const cb of this.onResizeCallbacks) cb(this);
  }

  onResize(cb: (cam: Camera) => void): void {
    this.onResizeCallbacks.push(cb);
  }

  /** Max scroll offsets; 0 when the map is smaller than the view. */
  get maxX(): number {
    return Math.max(0, WORLD_W - this.viewW);
  }

  get maxY(): number {
    return Math.max(0, WORLD_H - this.viewH);
  }

  clampToBounds(): void {
    this.x = clamp(this.x, 0, this.maxX);
    this.y = clamp(this.y, 0, this.maxY);
  }

  /** Scroll by a world-space delta, clamped to the map. */
  pan(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.x += dx;
    this.y += dy;
    this.clampToBounds();
  }

  /** Put a world point in the middle of the view. */
  centerOn(worldX: number, worldY: number): void {
    this.x = worldX - this.viewW / 2;
    this.y = worldY - this.viewH / 2;
    this.clampToBounds();
  }

  centerOnTile(tx: number, ty: number): void {
    this.centerOn(tx * TILE + TILE / 2, ty * TILE + TILE / 2);
  }

  // --- transforms ---------------------------------------------------------

  worldToScreenX(worldX: number): number {
    return worldX - this.x;
  }

  worldToScreenY(worldY: number): number {
    return worldY - this.y;
  }

  screenToWorldX(screenX: number): number {
    return screenX + this.x;
  }

  screenToWorldY(screenY: number): number {
    return screenY + this.y;
  }

  /** True if the screen point is inside the world view (not the sidebar). */
  isInView(screenX: number, screenY: number): boolean {
    return screenX >= 0 && screenY >= 0 && screenX < this.viewW && screenY < this.viewH;
  }

  /** True if the sidebar owns this screen point. */
  isInSidebar(screenX: number, screenY: number): boolean {
    return screenX >= this.viewW && screenX < this.canvasW;
  }

  /** Axis-aligned world rect currently visible, in tiles (inclusive bounds). */
  visibleTileBounds(): { tx0: number; ty0: number; tx1: number; ty1: number } {
    const tx0 = Math.max(0, Math.floor(this.x / TILE));
    const ty0 = Math.max(0, Math.floor(this.y / TILE));
    const tx1 = Math.min(WORLD_W / TILE - 1, Math.floor((this.x + this.viewW) / TILE));
    const ty1 = Math.min(WORLD_H / TILE - 1, Math.floor((this.y + this.viewH) / TILE));
    return { tx0, ty0, tx1, ty1 };
  }

  /** Is this world-space circle at least partly on screen? */
  isVisible(worldX: number, worldY: number, radius = 0): boolean {
    return (
      worldX + radius >= this.x &&
      worldY + radius >= this.y &&
      worldX - radius <= this.x + this.viewW &&
      worldY - radius <= this.y + this.viewH
    );
  }
}
