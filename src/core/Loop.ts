import type { EventBus } from './EventBus';

/** Logic runs at a fixed rate so simulation is deterministic and frame-rate independent (§4.2). */
export const FIXED_HZ = 30;
export const FIXED_DT = 1 / FIXED_HZ;

const DEFAULT_MAX_SUB_STEPS = 5;

export interface LoopOptions {
  /** Fixed-step logic tick. Called 0..maxSubSteps times per rendered frame. */
  update: (dt: number) => void;
  /** Render with interpolation factor alpha in [0,1) between the last two ticks. */
  render: (alpha: number, frameMs: number) => void;
  /** Called once per rendered frame after render(), with the measured frame time. */
  onFrameEnd?: (frameMs: number) => void;
  fixedDt?: number;
  maxSubSteps?: number;
  bus?: EventBus;
}

/**
 * Fixed-timestep accumulator loop: logic at `fixedDt`, rendering uncapped with
 * interpolation. Allocation-free per frame — the rAF callback and the stall payload
 * are created once per instance (§3: 0 byte/frame).
 */
export class Loop {
  private readonly updateFn: (dt: number) => void;
  private readonly renderFn: (alpha: number, frameMs: number) => void;
  private readonly frameEndFn: ((frameMs: number) => void) | undefined;
  private readonly bus: EventBus | undefined;
  private readonly fixedDt: number;
  private readonly maxSubSteps: number;
  /** Largest simulated slice per frame; excess wall time is discarded (anti spiral-of-death). */
  private readonly maxDelta: number;

  private rafId = 0;
  private isRunning = false;
  private lastMs = 0;
  private acc = 0;
  private alphaValue = 0;
  private ticks = 0;
  private frames = 0;
  /** Re-anchor the clock on the next frame: start, resume from hidden, or reset. */
  private resync = true;

  /** Reused payload — handlers must not retain it. */
  private readonly stallPayload = { frameMs: 0, droppedSteps: 0 };

  constructor(options: LoopOptions) {
    this.updateFn = options.update;
    this.renderFn = options.render;
    this.frameEndFn = options.onFrameEnd;
    this.bus = options.bus;

    const dt = options.fixedDt ?? FIXED_DT;
    this.fixedDt = dt > 0 ? dt : FIXED_DT;
    const steps = options.maxSubSteps ?? DEFAULT_MAX_SUB_STEPS;
    this.maxSubSteps = steps >= 1 ? Math.floor(steps) : 1;
    this.maxDelta = this.maxSubSteps * this.fixedDt;

    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    // Delta 0 / zero ticks on the first frame, so mount time is never simulated.
    this.resync = true;
    if (document.hidden) return;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.isRunning = false;
    this.cancel();
    this.resync = true;
  }

  /** Clears accumulator + counters, keeps running state. */
  reset(): void {
    this.acc = 0;
    this.alphaValue = 0;
    this.ticks = 0;
    this.frames = 0;
    this.resync = true;
  }

  dispose(): void {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  get running(): boolean {
    return this.isRunning;
  }

  get alpha(): number {
    return this.alphaValue;
  }

  get tickCount(): number {
    return this.ticks;
  }

  get frameCount(): number {
    return this.frames;
  }

  get accumulator(): number {
    return this.acc;
  }

  private cancel(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /**
   * Pre-bound instance field: one closure per Loop, never per frame.
   * `stop()` inside update/render cancels the frame scheduled below, so the loop
   * halts at the next frame boundary.
   */
  private readonly frame = (nowMs: number): void => {
    this.rafId = requestAnimationFrame(this.frame);

    if (this.resync) {
      this.resync = false;
      this.lastMs = nowMs;
      this.acc = 0;
      this.alphaValue = 0;
    }

    let frameMs = nowMs - this.lastMs;
    this.lastMs = nowMs;
    if (frameMs < 0) frameMs = 0;

    const delta = frameMs * 0.001;
    let dropped = 0;
    let step = delta;
    if (delta > this.maxDelta) {
      // Refuse to catch up: count the whole fixed steps of wall time we throw away.
      dropped = Math.ceil((delta - this.maxDelta) / this.fixedDt);
      step = this.maxDelta;
    }

    this.acc += step;
    let sub = 0;
    while (this.acc >= this.fixedDt && sub < this.maxSubSteps) {
      this.updateFn(this.fixedDt);
      this.acc -= this.fixedDt;
      this.ticks++;
      sub++;
    }
    if (this.acc >= this.fixedDt) {
      // Unreachable given the delta clamp; keeps alpha inside [0,1) if fixedDt changes.
      const extra = Math.floor(this.acc / this.fixedDt);
      dropped += extra;
      this.acc -= extra * this.fixedDt;
    }

    this.alphaValue = this.acc / this.fixedDt;
    this.frames++;

    if (dropped > 0 && this.bus !== undefined) {
      this.stallPayload.frameMs = frameMs;
      this.stallPayload.droppedSteps = dropped;
      this.bus.emit('loop:stall', this.stallPayload);
    }

    this.renderFn(this.alphaValue, frameMs);
    if (this.frameEndFn !== undefined) this.frameEndFn(frameMs);
  };

  /**
   * Hidden tabs get no rAF (and §11 mutes audio on the same signal). On resume the
   * accumulator is zeroed and the clock re-anchored so the game does not fast-forward.
   */
  private readonly onVisibilityChange = (): void => {
    if (!this.isRunning) return;
    if (document.hidden) {
      this.cancel();
      this.resync = true;
      return;
    }
    this.resync = true;
    if (this.rafId === 0) this.rafId = requestAnimationFrame(this.frame);
  };
}
