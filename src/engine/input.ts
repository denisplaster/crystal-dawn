/**
 * Input: mouse position/buttons, drag tracking, keyboard state, edge scrolling.
 *
 * Systems consume input through a per-tick `snapshot(camera)` — edge-triggered
 * things (clicks, completed drag boxes, key presses, wheel) accumulate between
 * ticks and are cleared by `endTick()`. Live (level-triggered) state is also
 * readable directly for render-rate needs like drawing the selection box.
 *
 * Right-click never opens the browser context menu on the canvas.
 */

import {
  EDGE_SCROLL_MARGIN,
  PAN_SPEED,
  PAN_SPEED_FAST,
  worldToTile,
} from '../game/constants';
import type { Camera } from './camera';

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 5;

export type MouseButton = 0 | 1 | 2; // left, middle, right

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface PointerInfo extends Modifiers {
  /** Screen (canvas) pixels. */
  x: number;
  y: number;
  /** World pixels. */
  worldX: number;
  worldY: number;
  tx: number;
  ty: number;
  /** Pointer is over the world view (not the sidebar). */
  inView: boolean;
  inSidebar: boolean;
}

export interface ClickEvent extends PointerInfo {
  button: MouseButton;
}

export interface DragBoxEvent extends Modifiers {
  button: MouseButton;
  /** Screen-space rect (normalised so x0 <= x1). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** World-space rect. */
  wx0: number;
  wy0: number;
  wx1: number;
  wy1: number;
}

export interface LiveDrag {
  active: boolean;
  button: MouseButton;
  startX: number;
  startY: number;
  x: number;
  y: number;
}

export interface InputSnapshot {
  pointer: PointerInfo;
  /** Currently held mouse buttons. */
  buttons: { left: boolean; middle: boolean; right: boolean };
  /** In-progress drag, or null. */
  drag: LiveDrag | null;
  /** Keys held (KeyboardEvent.code). */
  keys: ReadonlySet<string>;
  /** Keys that went down since the last tick. */
  pressed: ReadonlySet<string>;
  /** Keys that came up since the last tick. */
  released: ReadonlySet<string>;
  /** Completed clicks (press+release without dragging) since the last tick. */
  clicks: readonly ClickEvent[];
  /** Completed drag boxes since the last tick. */
  dragBoxes: readonly DragBoxEvent[];
  /** Accumulated wheel delta since the last tick. */
  wheel: number;
  /** Camera pan requested this tick, in world px (edge scroll + arrow keys). */
  pan: { x: number; y: number };
}

export class Input {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: Camera;

  // live state
  private px = 0;
  private py = 0;
  private pointerInside = false;
  private readonly held = new Set<MouseButton>();
  private readonly keys = new Set<string>();
  private mods: Modifiers = { shift: false, ctrl: false, alt: false };
  private dragState: LiveDrag | null = null;

  // edge-triggered, cleared in endTick()
  private pressedKeys = new Set<string>();
  private releasedKeys = new Set<string>();
  private clicks: ClickEvent[] = [];
  private dragBoxes: DragBoxEvent[] = [];
  private wheelDelta = 0;

  /** Set false to ignore edge scrolling (e.g. while a modal is open). */
  edgeScrollEnabled = true;

  constructor(canvas: HTMLCanvasElement, camera: Camera) {
    this.canvas = canvas;
    this.camera = camera;
    this.attach();
  }

  // --- live accessors (render-rate) ---------------------------------------

  get mouseX(): number {
    return this.px;
  }

  get mouseY(): number {
    return this.py;
  }

  get liveDrag(): LiveDrag | null {
    return this.dragState && this.dragState.active ? this.dragState : null;
  }

  isKeyDown(code: string): boolean {
    return this.keys.has(code);
  }

  isButtonDown(button: MouseButton): boolean {
    return this.held.has(button);
  }

  // --- per-tick API --------------------------------------------------------

  snapshot(): InputSnapshot {
    return {
      pointer: this.pointerInfo(this.px, this.py),
      buttons: {
        left: this.held.has(0),
        middle: this.held.has(1),
        right: this.held.has(2),
      },
      drag: this.dragState && this.dragState.active ? { ...this.dragState } : null,
      keys: this.keys,
      pressed: this.pressedKeys,
      released: this.releasedKeys,
      clicks: this.clicks,
      dragBoxes: this.dragBoxes,
      wheel: this.wheelDelta,
      pan: this.panVector(),
    };
  }

  /** Clear edge-triggered state. Call once at the end of every logic tick. */
  endTick(): void {
    if (this.pressedKeys.size) this.pressedKeys = new Set();
    if (this.releasedKeys.size) this.releasedKeys = new Set();
    if (this.clicks.length) this.clicks = [];
    if (this.dragBoxes.length) this.dragBoxes = [];
    this.wheelDelta = 0;
  }

  /** Camera pan for this tick from arrow keys + screen-edge zones. */
  private panVector(): { x: number; y: number } {
    const camera = this.camera;
    let dx = 0;
    let dy = 0;

    if (this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('ArrowRight')) dx += 1;
    if (this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('ArrowDown')) dy += 1;

    if (this.edgeScrollEnabled && this.pointerInside) {
      const x = this.px;
      const y = this.py;
      // The right-hand edge zone sits at the inner edge of the sidebar.
      if (y >= 0 && y < camera.viewH) {
        if (x >= 0 && x < EDGE_SCROLL_MARGIN) dx -= 1;
        else if (x >= camera.viewW - EDGE_SCROLL_MARGIN && x < camera.viewW) dx += 1;
      }
      if (x >= 0 && x < camera.viewW) {
        if (y >= 0 && y < EDGE_SCROLL_MARGIN) dy -= 1;
        else if (y >= camera.viewH - EDGE_SCROLL_MARGIN && y < camera.viewH) dy += 1;
      }
    }

    if (dx === 0 && dy === 0) return { x: 0, y: 0 };

    const speed = this.mods.shift ? PAN_SPEED_FAST : PAN_SPEED;
    // Normalise diagonals so corner scrolling isn't faster.
    const len = Math.hypot(dx, dy) || 1;
    return { x: (dx / len) * speed, y: (dy / len) * speed };
  }

  private pointerInfo(x: number, y: number): PointerInfo {
    const camera = this.camera;
    const inView = camera.isInView(x, y);
    const worldX = camera.screenToWorldX(x);
    const worldY = camera.screenToWorldY(y);
    return {
      x,
      y,
      worldX,
      worldY,
      tx: worldToTile(worldX),
      ty: worldToTile(worldY),
      inView,
      inSidebar: camera.isInSidebar(x, y),
      shift: this.mods.shift,
      ctrl: this.mods.ctrl,
      alt: this.mods.alt,
    };
  }

  // --- DOM wiring ----------------------------------------------------------

  private attach(): void {
    const canvas = this.canvas;

    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('mouseenter', this.onMouseEnter);
    canvas.addEventListener('mouseleave', this.onMouseLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    // Move/up on the window so drags that leave the canvas still resolve.
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    const canvas = this.canvas;
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    canvas.removeEventListener('mousedown', this.onMouseDown);
    canvas.removeEventListener('mouseenter', this.onMouseEnter);
    canvas.removeEventListener('mouseleave', this.onMouseLeave);
    canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private onContextMenu = (e: Event): void => {
    // Right-click is a game order; never show the browser menu over the canvas.
    e.preventDefault();
  };

  private updateMods(e: MouseEvent | KeyboardEvent): void {
    this.mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
  }

  private setPointerFromEvent(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.px = e.clientX - rect.left;
    this.py = e.clientY - rect.top;
  }

  private onMouseEnter = (): void => {
    this.pointerInside = true;
  };

  private onMouseLeave = (): void => {
    this.pointerInside = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    this.updateMods(e);
    this.setPointerFromEvent(e);
    const rect = this.canvas.getBoundingClientRect();
    this.pointerInside =
      e.clientX >= rect.left &&
      e.clientX < rect.right &&
      e.clientY >= rect.top &&
      e.clientY < rect.bottom;

    const drag = this.dragState;
    if (drag) {
      drag.x = this.px;
      drag.y = this.py;
      if (
        !drag.active &&
        Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= DRAG_THRESHOLD
      ) {
        drag.active = true;
      }
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button > 2) return;
    e.preventDefault();
    this.updateMods(e);
    this.setPointerFromEvent(e);
    const button = e.button as MouseButton;
    this.held.add(button);
    if (!this.dragState) {
      this.dragState = {
        active: false,
        button,
        startX: this.px,
        startY: this.py,
        x: this.px,
        y: this.py,
      };
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button > 2) return;
    this.updateMods(e);
    this.setPointerFromEvent(e);
    const button = e.button as MouseButton;
    this.held.delete(button);

    const drag = this.dragState;
    if (drag && drag.button === button) {
      this.dragState = null;
      if (drag.active) {
        this.dragBoxes.push(this.makeDragBox(drag));
      } else {
        this.clicks.push({ ...this.pointerInfo(this.px, this.py), button });
      }
    }
  };

  private makeDragBox(drag: LiveDrag): DragBoxEvent {
    const camera = this.camera;
    const x0 = Math.min(drag.startX, drag.x);
    const x1 = Math.max(drag.startX, drag.x);
    const y0 = Math.min(drag.startY, drag.y);
    const y1 = Math.max(drag.startY, drag.y);
    return {
      button: drag.button,
      x0,
      y0,
      x1,
      y1,
      wx0: camera.screenToWorldX(x0),
      wy0: camera.screenToWorldY(y0),
      wx1: camera.screenToWorldX(x1),
      wy1: camera.screenToWorldY(y1),
      shift: this.mods.shift,
      ctrl: this.mods.ctrl,
      alt: this.mods.alt,
    };
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.wheelDelta += e.deltaY;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    this.updateMods(e);
    if (
      e.code.startsWith('Arrow') ||
      e.code === 'Space' ||
      (e.code === 'Tab' && !e.ctrlKey && !e.metaKey)
    ) {
      e.preventDefault();
    }
    if (e.repeat) return;
    this.keys.add(e.code);
    this.pressedKeys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.updateMods(e);
    this.keys.delete(e.code);
    this.releasedKeys.add(e.code);
  };

  private onBlur = (): void => {
    // Never leave keys/buttons stuck down when focus is lost mid-drag.
    for (const code of this.keys) this.releasedKeys.add(code);
    this.keys.clear();
    this.held.clear();
    this.dragState = null;
    this.pointerInside = false;
    this.mods = { shift: false, ctrl: false, alt: false };
  };
}
