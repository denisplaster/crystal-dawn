/**
 * WebAudio SFX + EVA announcer.
 *
 * Everything is synthesised at runtime — no asset files, no dependencies. The
 * module is strictly a *consumer* of `GameState`: it reads `state.effects`,
 * `state.messages` and harvester cycle state from the render loop and never
 * writes to the sim. Nothing here may ever be required for the simulation to
 * advance, and the whole thing degrades to silence in a headless or
 * audio-less environment.
 *
 * Autoplay policy: the AudioContext is only created/resumed from a real user
 * gesture (`attachUnlock`). Until then every `play()` is a no-op.
 */

import { PLAYER_HUMAN, TILE, worldToTile } from '../game/constants';
import type { WeaponId } from '../game/rules';
import type { Effect, EvaMessage, GameState, HarvestState } from '../game/state';
import { isTileVisible } from '../game/systems/fog';

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const SFX_NAMES = [
  'machinegun',
  'rocket',
  'cannon',
  'explosionSmall',
  'explosionLarge',
  'deposit',
  'constructionComplete',
  'unitReady',
  'lowPower',
  'click',
] as const;

export type SfxName = (typeof SFX_NAMES)[number];

export function isSfxName(name: string): name is SfxName {
  return (SFX_NAMES as readonly string[]).includes(name);
}

/** Weapon -> firing sound. Pure; harnessable without an AudioContext. */
export function soundForMuzzle(weapon: WeaponId | undefined, size: number): SfxName {
  switch (weapon) {
    case 'machinegun':
    case 'towerGun':
      return 'machinegun';
    case 'rocketLauncher':
      return 'rocket';
    case 'lightCannon':
    case 'mediumCannon':
    case 'howitzer':
      return 'cannon';
    default:
      // Pre-Phase-6 effects carry no weapon id; fall back to the flash size.
      return size >= 9 ? 'cannon' : 'machinegun';
  }
}

/**
 * Blast radius -> boom. Unit deaths and small warheads land under 20px;
 * structure deaths (~43px) and HE splash (~21px) go large.
 */
export function soundForExplosion(size: number): SfxName {
  return size >= 20 ? 'explosionLarge' : 'explosionSmall';
}

/** EVA line -> sting. Well-known lines get their own sound, the rest go by kind. */
export function soundForMessage(m: EvaMessage): SfxName {
  if (m.text === 'Construction complete' || m.text.endsWith(' online')) {
    return 'constructionComplete';
  }
  if (m.text === 'Unit ready') return 'unitReady';
  if (m.text === 'Low power') return 'lowPower';
  if (m.kind === 'info') return 'unitReady';
  return 'lowPower';
}

// ---------------------------------------------------------------------------
// Mute persistence
// ---------------------------------------------------------------------------

export const MUTE_KEY = 'crystal-dawn.muted';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `localStorage` when it exists and is reachable, else null. */
export function defaultStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

export function loadMuted(storage: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveMuted(storage: StorageLike | null, muted: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // Private browsing / quota. Muting still works for this session.
  }
}

// ---------------------------------------------------------------------------
// EVA speech queue
// ---------------------------------------------------------------------------

export interface SpeechBackend {
  /** False when the environment has no usable speech synthesiser. */
  available(): boolean;
  /** Speak `text`; call `done` exactly once when it finishes or fails. */
  speak(text: string, done: () => void): void;
}

/** Drop a new line once more than this many are already queued. */
export const MAX_PENDING_SPEECH = 2;

/**
 * A deliberately lossy announcer queue: EVA should stay current, not read out a
 * backlog. Anything arriving while more than `maxPending` lines are in flight
 * is dropped on the floor.
 */
export class SpeechQueue {
  pending = 0;
  spoken = 0;
  dropped = 0;

  private readonly backend: SpeechBackend;
  private readonly maxPending: number;

  constructor(backend: SpeechBackend, maxPending = MAX_PENDING_SPEECH) {
    this.backend = backend;
    this.maxPending = maxPending;
  }

  say(text: string): boolean {
    if (text.length === 0 || !this.backend.available()) {
      this.dropped++;
      return false;
    }
    if (this.pending > this.maxPending) {
      this.dropped++;
      return false;
    }
    this.pending++;
    let settled = false;
    this.backend.speak(text, () => {
      if (settled) return;
      settled = true;
      this.pending = Math.max(0, this.pending - 1);
    });
    this.spoken++;
    return true;
  }

  /** Forget in-flight lines (restart, or a cancelled synthesiser). */
  reset(): void {
    this.pending = 0;
  }
}

/** speechSynthesis-backed announcer, tuned low and slow so it reads as a computer. */
function browserSpeech(): SpeechBackend {
  interface SpeechGlobals {
    speechSynthesis?: {
      speak(u: unknown): void;
      cancel(): void;
    };
    SpeechSynthesisUtterance?: new (text: string) => {
      rate: number;
      pitch: number;
      volume: number;
      onend: (() => void) | null;
      onerror: (() => void) | null;
    };
  }
  const g = globalThis as unknown as SpeechGlobals;
  return {
    available(): boolean {
      return typeof g.speechSynthesis !== 'undefined' && typeof g.SpeechSynthesisUtterance === 'function';
    },
    speak(text: string, done: () => void): void {
      try {
        const Utterance = g.SpeechSynthesisUtterance;
        const synth = g.speechSynthesis;
        if (!Utterance || !synth) {
          done();
          return;
        }
        const u = new Utterance(text);
        u.rate = 0.92;
        u.pitch = 0.4;
        u.volume = 0.85;
        u.onend = done;
        u.onerror = done;
        synth.speak(u);
      } catch {
        done();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Sfx
// ---------------------------------------------------------------------------

/** Per-frame voice budget so a big battle cannot swamp the mixer. */
const MAX_VOICES_PER_FRAME = 8;
const MAX_PER_SOUND_PER_FRAME = 3;

export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PlayOpts {
  /** Linear gain multiplier (1 = catalogue default). */
  gain?: number;
  /** Playback-rate-ish pitch multiplier. */
  rate?: number;
  /** Stereo pan, -1..1. Ignored where StereoPannerNode is missing. */
  pan?: number;
}

type Ctx = AudioContext;

export class Sfx {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private unlocked = false;
  private mutedFlag: boolean;
  private readonly storage: StorageLike | null;

  readonly speech: SpeechQueue;

  /** Highest sim tick already turned into sound. */
  private watermark = 0;
  /** Last seen harvest cycle state per harvester, for the deposit chime. */
  private harvestStates = new Map<number, HarvestState>();
  private frameVoices = 0;
  private frameCounts = new Map<SfxName, number>();

  constructor(storage: StorageLike | null = defaultStorage(), speech = new SpeechQueue(browserSpeech())) {
    this.storage = storage;
    this.mutedFlag = loadMuted(storage);
    this.speech = speech;
  }

  // --- lifecycle ----------------------------------------------------------

  /** True once an AudioContext exists and is running. */
  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  setMuted(muted: boolean): boolean {
    this.mutedFlag = muted;
    saveMuted(this.storage, muted);
    if (this.master && this.ctx) {
      this.master.gain.setValueAtTime(muted ? 0 : 1, this.ctx.currentTime);
    }
    if (muted) this.speech.reset();
    return this.mutedFlag;
  }

  toggleMute(): boolean {
    return this.setMuted(!this.mutedFlag);
  }

  /**
   * Wire the one-shot autoplay unlock. Browsers refuse to start an
   * AudioContext outside a user gesture, so the first click or keypress
   * anywhere creates (or resumes) it.
   */
  attachUnlock(target: { addEventListener(type: string, cb: () => void, opts?: unknown): void }): void {
    const unlock = (): void => {
      this.resume();
    };
    target.addEventListener('pointerdown', unlock);
    target.addEventListener('keydown', unlock);
    target.addEventListener('mousedown', unlock);
  }

  /** Create the context if possible and resume it. Safe to call repeatedly. */
  resume(): boolean {
    if (this.ctx && this.ctx.state === 'running') return true;
    if (!this.ctx) {
      const g = globalThis as {
        AudioContext?: new () => Ctx;
        webkitAudioContext?: new () => Ctx;
      };
      const Ctor = g.AudioContext ?? g.webkitAudioContext;
      if (!Ctor) return false;
      try {
        this.ctx = new Ctor();
      } catch {
        this.ctx = null;
        return false;
      }
      const master = this.ctx.createGain();
      master.gain.value = this.mutedFlag ? 0 : 1;
      master.connect(this.ctx.destination);
      this.master = master;
      this.noise = this.makeNoise(this.ctx);
    }
    try {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      return false;
    }
    this.unlocked = true;
    return true;
  }

  /** Forget stream position + per-entity tracking. Called on restart. */
  resetStream(): void {
    this.watermark = 0;
    this.harvestStates.clear();
    this.speech.reset();
  }

  // --- synthesis ----------------------------------------------------------

  /** One second of white noise, built once per context and reused by every voice. */
  private makeNoise(ctx: Ctx): AudioBuffer {
    const len = Math.floor(ctx.sampleRate);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Math.random is fine here: audio lives entirely outside the simulation.
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Route a voice through an optional panner into the master bus. */
  private sink(pan: number | undefined): AudioNode {
    const ctx = this.ctx as Ctx;
    const master = this.master as GainNode;
    if (pan === undefined || pan === 0 || typeof ctx.createStereoPanner !== 'function') {
      return master;
    }
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(master);
    return panner;
  }

  private noiseBurst(
    dest: AudioNode,
    at: number,
    dur: number,
    peak: number,
    filter: { type: BiquadFilterType; from: number; to: number; q?: number },
  ): void {
    const ctx = this.ctx as Ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const biq = ctx.createBiquadFilter();
    biq.type = filter.type;
    biq.frequency.setValueAtTime(filter.from, at);
    biq.frequency.exponentialRampToValueAtTime(Math.max(20, filter.to), at + dur);
    if (filter.q !== undefined) biq.Q.value = filter.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + Math.min(0.012, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(biq);
    biq.connect(g);
    g.connect(dest);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  private tone(
    dest: AudioNode,
    at: number,
    dur: number,
    peak: number,
    type: OscillatorType,
    from: number,
    to = from,
  ): void {
    const ctx = this.ctx as Ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, from), at);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + Math.min(0.02, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g);
    g.connect(dest);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  /**
   * Fire a catalogue sound. Returns false when audio is unavailable, muted or
   * the name is unknown — never throws.
   */
  play(name: SfxName | string, opts: PlayOpts = {}): boolean {
    if (this.mutedFlag || !this.unlocked || !this.ctx || !this.master) return false;
    if (!isSfxName(name)) return false;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.001;
    const vol = opts.gain ?? 1;
    const r = opts.rate ?? 1;
    const dest = this.sink(opts.pan);

    switch (name) {
      case 'machinegun': {
        // Four dry cracks, ~40ms apart.
        for (let i = 0; i < 4; i++) {
          const at = t + i * 0.042;
          this.noiseBurst(dest, at, 0.05, 0.28 * vol, {
            type: 'bandpass',
            from: 1900 * r,
            to: 900 * r,
            q: 1.4,
          });
          this.tone(dest, at, 0.035, 0.1 * vol, 'square', 320 * r, 160 * r);
        }
        break;
      }
      case 'rocket': {
        this.noiseBurst(dest, t, 0.5 / r, 0.3 * vol, {
          type: 'bandpass',
          from: 420 * r,
          to: 2600 * r,
          q: 0.9,
        });
        this.tone(dest, t, 0.42 / r, 0.12 * vol, 'sawtooth', 160 * r, 520 * r);
        break;
      }
      case 'cannon': {
        this.tone(dest, t, 0.26 / r, 0.5 * vol, 'triangle', 110 * r, 42 * r);
        this.noiseBurst(dest, t, 0.16, 0.35 * vol, {
          type: 'lowpass',
          from: 2200 * r,
          to: 260 * r,
        });
        break;
      }
      case 'explosionSmall': {
        this.noiseBurst(dest, t, 0.34, 0.42 * vol, {
          type: 'lowpass',
          from: 1500 * r,
          to: 200 * r,
        });
        this.tone(dest, t, 0.3, 0.35 * vol, 'sine', 140 * r, 48 * r);
        break;
      }
      case 'explosionLarge': {
        this.noiseBurst(dest, t, 0.75, 0.55 * vol, {
          type: 'lowpass',
          from: 900 * r,
          to: 80 * r,
        });
        this.tone(dest, t, 0.7, 0.5 * vol, 'sine', 90 * r, 32 * r);
        this.noiseBurst(dest, t + 0.05, 0.35, 0.22 * vol, {
          type: 'bandpass',
          from: 500 * r,
          to: 120 * r,
          q: 0.7,
        });
        break;
      }
      case 'deposit': {
        // Two-note credit chime.
        this.tone(dest, t, 0.12, 0.2 * vol, 'triangle', 880 * r);
        this.tone(dest, t + 0.09, 0.2, 0.22 * vol, 'triangle', 1320 * r);
        this.tone(dest, t + 0.09, 0.2, 0.08 * vol, 'sine', 2640 * r);
        break;
      }
      case 'constructionComplete': {
        const notes = [392, 523, 784];
        notes.forEach((f, i) => {
          this.tone(dest, t + i * 0.1, 0.24, 0.2 * vol, 'square', f * r);
        });
        break;
      }
      case 'unitReady': {
        this.tone(dest, t, 0.08, 0.18 * vol, 'square', 1180 * r);
        this.tone(dest, t + 0.05, 0.09, 0.14 * vol, 'square', 1560 * r);
        break;
      }
      case 'lowPower': {
        this.tone(dest, t, 0.24, 0.2 * vol, 'sawtooth', 330 * r, 250 * r);
        this.tone(dest, t + 0.24, 0.3, 0.2 * vol, 'sawtooth', 250 * r, 180 * r);
        break;
      }
      case 'click': {
        this.noiseBurst(dest, t, 0.035, 0.16 * vol, {
          type: 'highpass',
          from: 2200 * r,
          to: 1600 * r,
        });
        this.tone(dest, t, 0.03, 0.1 * vol, 'square', 1900 * r);
        break;
      }
      default: {
        const never: never = name;
        void never;
        return false;
      }
    }
    return true;
  }

  // --- state consumption --------------------------------------------------

  private budget(name: SfxName): boolean {
    if (this.frameVoices >= MAX_VOICES_PER_FRAME) return false;
    const n = this.frameCounts.get(name) ?? 0;
    if (n >= MAX_PER_SOUND_PER_FRAME) return false;
    this.frameCounts.set(name, n + 1);
    this.frameVoices++;
    return true;
  }

  private panFor(x: number, view: ViewRect | undefined): number | undefined {
    if (!view || view.w <= 0) return undefined;
    return Math.max(-1, Math.min(1, ((x - (view.x + view.w / 2)) / (view.w / 2)) * 0.7));
  }

  /**
   * Turn everything that happened since the last call into sound. Called from
   * the render loop — the simulation neither knows nor cares that this exists.
   *
   * The watermark advances even while muted or locked, so unmuting never dumps
   * a backlog of stale battle noise.
   */
  consume(state: GameState, view?: ViewRect): void {
    const from = this.watermark;
    this.watermark = state.tick;
    const audible = !this.mutedFlag && this.unlocked && this.ctx !== null;

    this.frameVoices = 0;
    this.frameCounts.clear();

    if (audible) {
      for (const fx of state.effects as Effect[]) {
        if (fx.startTick < from) continue;
        const tx = worldToTile(fx.x);
        const ty = worldToTile(fx.y);
        if (!isTileVisible(state, tx, ty)) continue;
        const offView =
          view !== undefined &&
          (fx.x < view.x - TILE ||
            fx.y < view.y - TILE ||
            fx.x > view.x + view.w + TILE ||
            fx.y > view.y + view.h + TILE);
        const gain = offView ? 0.3 : 1;
        const pan = this.panFor(fx.x, view);
        if (fx.kind === 'muzzle') {
          const name = soundForMuzzle(fx.weapon, fx.size);
          if (this.budget(name)) this.play(name, { gain: gain * 0.5, pan });
        } else {
          const name = soundForExplosion(fx.size);
          if (this.budget(name)) {
            this.play(name, { gain: gain * 0.8, rate: name === 'explosionLarge' ? 0.9 : 1, pan });
          }
        }
      }
    }

    for (const m of state.messages as EvaMessage[]) {
      if (m.tick < from) continue;
      if (!audible) continue;
      const name = soundForMessage(m);
      if (this.budget(name)) {
        this.play(name, { gain: 0.9, rate: m.kind === 'alert' ? 0.78 : 1 });
      }
      this.speech.say(m.text);
    }

    this.consumeHarvesters(state, audible, view);
  }

  /**
   * The sim posts no event when a load lands, so the deposit chime is inferred
   * render-side from the harvester's cycle state leaving `unloading`.
   */
  private consumeHarvesters(state: GameState, audible: boolean, view: ViewRect | undefined): void {
    const seen = this.harvestStates;
    for (const u of state.units) {
      if (u.harvestState === undefined || u.player !== PLAYER_HUMAN) continue;
      const prev = seen.get(u.id);
      if (u.dead) {
        seen.delete(u.id);
        continue;
      }
      if (prev === 'unloading' && u.harvestState !== 'unloading') {
        if (audible && this.budget('deposit')) {
          this.play('deposit', { gain: 0.8, pan: this.panFor(u.pos.x, view) });
        }
      }
      seen.set(u.id, u.harvestState);
    }
  }
}
