import type * as THREE from 'three';

/** §3: start at min(devicePixelRatio, 1.5), fall toward 1.0 and below on weak devices. */
const DEFAULT_LADDER: readonly number[] = [1.5, 1.25, 1.0, 0.85, 0.75];
/** Frame-time EMA weight. Low enough that a single 40 ms hitch cannot move a decision. */
const EMA_WEIGHT = 0.1;
/** Frames slower than this are scheduler artefacts (tab throttle, breakpoint), not GPU load. */
const MAX_SAMPLE_MS = 250;

export interface DynamicResolutionOptions {
  /** Ratio ladder, high → low. Each entry is clamped by devicePixelRatio at runtime. */
  ladder?: readonly number[];
  startIndex?: number;
  downFps?: number;
  downSeconds?: number;
  upFps?: number;
  upSeconds?: number;
  cooldownSeconds?: number;
  enabled?: boolean;
}

function deviceRatio(): number {
  const dpr = window.devicePixelRatio;
  return dpr > 0 ? dpr : 1;
}

/**
 * Dynamic resolution scaling (§3). Judges an EMA of frame time, walks a ladder of pixel
 * ratios with hysteresis + cooldown, and only ever touches `renderer.setPixelRatio` —
 * the Engine owns `setSize`. Allocation-free in `sample()`.
 */
export class DynamicResolution {
  onChange: ((pixelRatio: number, direction: -1 | 1) => void) | undefined = undefined;

  private readonly renderer: THREE.WebGLRenderer;
  /** Author-supplied ladder (copied, so a caller cannot mutate it behind our back). */
  private readonly source: number[];
  /** `source` clamped by the current devicePixelRatio. Same length, rewritten in place. */
  private readonly effective: number[];
  private readonly startIdx: number;
  private readonly downFps: number;
  private readonly downSeconds: number;
  private readonly upFps: number;
  private readonly upSeconds: number;
  private readonly cooldownSeconds: number;

  private idx: number;
  private appliedRatio: number;
  private isEnabled: boolean;
  private emaMs = 0;
  private belowSec = 0;
  private aboveSec = 0;
  private cooldownLeft: number;

  constructor(renderer: THREE.WebGLRenderer, options?: DynamicResolutionOptions) {
    this.renderer = renderer;

    const ladder = options?.ladder;
    const src = ladder !== undefined && ladder.length > 0 ? ladder : DEFAULT_LADDER;
    this.source = src.slice();
    this.effective = src.slice();

    const start = Math.floor(options?.startIndex ?? 0);
    this.startIdx = start < 0 ? 0 : start > this.source.length - 1 ? this.source.length - 1 : start;
    this.downFps = options?.downFps ?? 45;
    this.downSeconds = options?.downSeconds ?? 2;
    this.upFps = options?.upFps ?? 57;
    this.upSeconds = options?.upSeconds ?? 6;
    this.cooldownSeconds = options?.cooldownSeconds ?? 1.5;
    this.isEnabled = options?.enabled ?? true;

    this.idx = this.startIdx;
    // Seed from the renderer so the first apply is skipped when it already matches.
    this.appliedRatio = renderer.getPixelRatio();
    // Settle before the first judgement, so a startup shader-compile hitch cannot downgrade.
    this.cooldownLeft = this.cooldownSeconds;
    this.clampToDevice();
  }

  /** Feed one measured frame time (ms). Allocation-free. */
  sample(frameMs: number): void {
    if (!this.isEnabled) return;
    if (!(frameMs > 0) || frameMs > MAX_SAMPLE_MS) return;

    this.emaMs = this.emaMs === 0 ? frameMs : this.emaMs + (frameMs - this.emaMs) * EMA_WEIGHT;

    const seconds = frameMs * 0.001;
    if (this.cooldownLeft > 0) {
      this.cooldownLeft -= seconds;
      this.belowSec = 0;
      this.aboveSec = 0;
      return;
    }

    const fps = 1000 / this.emaMs;
    if (fps < this.downFps) {
      this.belowSec += seconds;
      this.aboveSec = 0;
    } else if (fps > this.upFps) {
      this.aboveSec += seconds;
      this.belowSec = 0;
    } else {
      // Dead band: neither condition is sustained, so both timers restart.
      this.belowSec = 0;
      this.aboveSec = 0;
    }

    if (this.belowSec >= this.downSeconds) {
      this.step(-1);
    } else if (this.aboveSec >= this.upSeconds) {
      this.step(1);
    }
  }

  /** System convention (§4.4). All timing is driven by sample(); nothing to do here. */
  update(_dt: number): void {
    /* no-op */
  }

  reset(): void {
    this.emaMs = 0;
    this.belowSec = 0;
    this.aboveSec = 0;
    this.cooldownLeft = this.cooldownSeconds;
    this.idx = this.startIdx;
    this.applyIndex();
  }

  setEnabled(enabled: boolean): void {
    if (this.isEnabled === enabled) return;
    this.isEnabled = enabled;
    // Keep the ratio currently on screen; only stop judging it.
    this.emaMs = 0;
    this.belowSec = 0;
    this.aboveSec = 0;
    this.cooldownLeft = enabled ? this.cooldownSeconds : 0;
  }

  /** Recompute the effective ladder after a DPR change (monitor swap, browser zoom). */
  clampToDevice(): void {
    const dpr = deviceRatio();
    for (let i = 0; i < this.source.length; i++) {
      const v = this.source[i];
      if (v === undefined) continue;
      this.effective[i] = v < dpr ? v : dpr;
    }
    this.applyIndex();
  }

  /**
   * Force a ladder index (debug / quality settings). Returns the applied ratio.
   * Not in the Phase 0 contract — required by `__ARCANUM_DEBUG__.setPixelRatio(index)`.
   */
  setIndex(index: number): number {
    const last = this.effective.length - 1;
    const i = Math.floor(index);
    this.idx = i < 0 ? 0 : i > last ? last : i;
    this.belowSec = 0;
    this.aboveSec = 0;
    this.cooldownLeft = this.cooldownSeconds;
    this.applyIndex();
    return this.appliedRatio;
  }

  /** Currently applied ratio. */
  get pixelRatio(): number {
    return this.appliedRatio;
  }

  get index(): number {
    return this.idx;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  /** direction: -1 lower quality (higher ladder index), +1 higher quality. */
  private step(direction: -1 | 1): void {
    const delta = direction === 1 ? -1 : 1;
    const last = this.effective.length - 1;
    // Skip rungs the DPR clamp flattened onto the current ratio — they would be no-ops
    // that still burn a cooldown.
    let i = this.idx + delta;
    while (i >= 0 && i <= last) {
      const v = this.effective[i];
      if (v !== undefined && v !== this.appliedRatio) {
        this.idx = i;
        this.belowSec = 0;
        this.aboveSec = 0;
        this.cooldownLeft = this.cooldownSeconds;
        this.applyRatio(v);
        return;
      }
      i += delta;
    }
    // End of the ladder: stop re-testing every frame until the trend changes.
    this.belowSec = 0;
    this.aboveSec = 0;
    this.cooldownLeft = this.cooldownSeconds;
  }

  private applyIndex(): void {
    const v = this.effective[this.idx];
    if (v !== undefined) this.applyRatio(v);
  }

  /** setPixelRatio reallocates the drawing buffer, so only call it on a real change (§3). */
  private applyRatio(value: number): void {
    const previous = this.appliedRatio;
    if (value === previous) return;
    this.appliedRatio = value;
    this.renderer.setPixelRatio(value);
    const cb = this.onChange;
    if (cb !== undefined) cb(value, value < previous ? -1 : 1);
  }
}
