/**
 * Fixed-timestep game loop.
 *
 * Logic runs at exactly 20 Hz (TICK_MS = 50) via an accumulator; rendering runs
 * on requestAnimationFrame and receives an interpolation alpha in [0, 1)
 * describing how far the display is between the last tick and the next one.
 *
 * Gameplay must only advance inside `tick()` — never in `render()`.
 */

import { TICK_MS } from '../game/constants';

export interface LoopCallbacks {
  /** One logic step. Called 0..MAX_STEPS times per frame. */
  tick: () => void;
  /** Draw. `alpha` is the interpolation factor toward the next tick. */
  render: (alpha: number) => void;
}

/** Never simulate more than this many ticks in one frame (spiral-of-death guard). */
const MAX_STEPS_PER_FRAME = 5;
/** Clamp huge frame deltas (tab was backgrounded). */
const MAX_FRAME_MS = 250;

export class GameLoop {
  private readonly cb: LoopCallbacks;
  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0;
  private speedMult = 1;
  private running = false;

  // Rolling frame-rate stats, for the debug overlay.
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fpsValue = 0;
  /** Ticks simulated since start (mirrors GameState.tick when unpaused). */
  ticksRun = 0;

  constructor(cb: LoopCallbacks) {
    this.cb = cb;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Simulation speed multiplier. 0 pauses logic (rendering continues). */
  setSpeed(mult: number): void {
    this.speedMult = Math.max(0, Math.min(16, mult));
    this.accumulator = 0;
  }

  get speed(): number {
    return this.speedMult;
  }

  get fps(): number {
    return this.fpsValue;
  }

  /** Run exactly one logic tick regardless of speed (debug stepping). */
  step(count = 1): void {
    for (let i = 0; i < count; i++) {
      this.cb.tick();
      this.ticksRun++;
    }
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    let delta = now - this.lastTime;
    this.lastTime = now;
    if (delta > MAX_FRAME_MS) delta = MAX_FRAME_MS;
    if (delta < 0) delta = 0;

    this.fpsAccum += delta;
    this.fpsFrames++;
    if (this.fpsAccum >= 500) {
      this.fpsValue = Math.round((this.fpsFrames * 1000) / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    this.accumulator += delta * this.speedMult;

    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.cb.tick();
      this.ticksRun++;
      this.accumulator -= TICK_MS;
      steps++;
    }
    // Drop any backlog we could not work through this frame.
    if (this.accumulator > TICK_MS) this.accumulator = this.accumulator % TICK_MS;

    const alpha = this.speedMult === 0 ? 0 : this.accumulator / TICK_MS;
    this.cb.render(alpha);
  };
}
