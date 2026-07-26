import * as THREE from 'three';

import type { System } from '../core/Engine';

/**
 * §9's floating damage numbers: "pooled DOM element, bukan sprite baru".
 *
 * House DOM discipline (see Profiler/HUD): the 24 elements are built exactly
 * once in the constructor, values are written through cached `Text` nodes, and
 * movement is `transform: translate3d` only — `top`/`left` would invalidate
 * layout on every hit (§13). Coordinates are rounded to whole CSS pixels and
 * opacity is quantised, and every style write is skipped when the value it
 * represents did not change, so a clamped or parked number costs nothing.
 *
 * Split of duties per the Phase 3 contract: `update(dt)` only ages entries (no
 * DOM), `render()` does projection and all DOM writes, `spawn()` is event-rate
 * (per hit, never per frame) so its small strings are off the frame budget.
 */

export interface DamageNumbersOptions {
  mount: HTMLElement;
  camera: THREE.PerspectiveCamera;
}

const POOL_SIZE = 24;
const LIFE_SECONDS = 0.7;
const RISE_PX = 40;
/** Fraction of life after which the fade begins (opaque until then). */
const FADE_START = 0.5;
/** Opacity quantisation steps — 12 is invisible banding over 0.35 s. */
const OPACITY_STEPS = 12;
/** §contract: clamp to the viewport ±10 % so numbers do not pile at the edges. */
const VIEW_MARGIN = 0.1;
/** Points closer than this to the camera plane (or behind it) are hidden. */
const BEHIND_EPSILON = 0.05;

/** Sentinel bucket meaning "no transform written yet / parked offscreen". */
const KEY_NONE = 0x7fffffff;
/** Transform-only hide for behind-camera/dead: no display toggle, no layout. */
const PARK_TRANSFORM = 'translate3d(-4096px,-4096px,0)';

/** className per (crit, heavy) — precomputed so spawn never builds strings. */
const LIVE_CLASS = [
  'dmg is-live',
  'dmg dmg--crit is-live',
  'dmg dmg--heavy is-live',
  'dmg dmg--crit dmg--heavy is-live',
] as const;
const IDLE_CLASS = 'dmg';
const CLASS_NONE = -1;

/** Quantised opacity strings, built once — the frame loop never calls toFixed. */
const OPACITY_TEXT: readonly string[] = (() => {
  const list: string[] = [];
  for (let i = 0; i <= OPACITY_STEPS; i++) list.push((i / OPACITY_STEPS).toFixed(3));
  return list;
})();

const STYLE_ID = 'dmg-style';
/**
 * Injected once (integrator's CSS files are off-limits). `translate:-50% -50%`
 * is the independent CSS translate property: it composes with the JS-driven
 * `transform`, so centring never appears in the per-frame string.
 */
const CSS =
  '.dmg-layer{position:absolute;inset:0;overflow:hidden;contain:layout paint;' +
  'pointer-events:none;z-index:15;}\n' +
  '.dmg{position:absolute;left:0;top:0;translate:-50% -50%;opacity:0;' +
  "font:800 16px/1.1 'Segoe UI',system-ui,-apple-system,sans-serif;" +
  'font-variant-numeric:tabular-nums;letter-spacing:.02em;white-space:nowrap;' +
  'color:#f5f2e9;text-shadow:0 1px 0 rgba(0,0,0,.85),0 0 6px rgba(0,0,0,.55);' +
  'will-change:transform,opacity;}\n' +
  '.dmg--heavy{font-size:21px;color:#ffb45e;}\n' +
  '.dmg--crit{font-size:25px;color:#ffe36b;' +
  'text-shadow:0 1px 0 rgba(0,0,0,.9),0 0 10px rgba(255,170,40,.45);}\n';

interface NumberEntry {
  readonly el: HTMLDivElement;
  readonly text: Text;
  /** Fixed per-slot x offset so simultaneous hits at one point fan out. */
  readonly jitterX: number;
  live: boolean;
  /** Still has live styling in the DOM; render() clears it after death. */
  shown: boolean;
  age: number;
  /** Spawn order for §13's cap behaviour: exhausted pool recycles the oldest. */
  seq: number;
  wx: number;
  wy: number;
  wz: number;
  /** Last written state, so unchanged frames skip the style write. */
  keyX: number;
  keyY: number;
  opacityStep: number;
  shownValue: number;
  classIndex: number;
}

// Module-scope projection scratch (§13: no allocation in the frame path).
const worldPoint = new THREE.Vector3();

/** Ease-out on the rise: fast pop off the hit point, drifting to a stop. */
function riseEase(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv;
}

export class DamageNumbers implements System {
  readonly name = 'damageNumbers';

  private readonly camera: THREE.PerspectiveCamera;
  private layer: HTMLDivElement | undefined;
  private readonly entries: NumberEntry[] = [];

  private liveCount = 0;
  private shownCount = 0;
  private nextSeq = 1;

  constructor(options: DamageNumbersOptions) {
    this.camera = options.camera;

    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.appendChild(document.createTextNode(CSS));
      document.head.appendChild(style);
    }

    const layer = document.createElement('div');
    layer.className = 'dmg-layer';
    // Inline, so `.ui-root > *`'s pointer-events opt-in can never outrank it.
    layer.style.pointerEvents = 'none';

    for (let i = 0; i < POOL_SIZE; i++) {
      const el = document.createElement('div');
      el.className = IDLE_CLASS;
      const text = document.createTextNode('');
      el.appendChild(text);
      layer.appendChild(el);
      this.entries.push({
        el,
        text,
        // Deterministic -16..16 px spread; no RNG, no allocation at spawn time.
        jitterX: (((i * 5) % 9) - 4) * 4,
        live: false,
        shown: false,
        age: 0,
        seq: 0,
        wx: 0,
        wy: 0,
        wz: 0,
        keyX: KEY_NONE,
        keyY: KEY_NONE,
        opacityStep: -1,
        shownValue: -1,
        classIndex: CLASS_NONE,
      });
    }

    options.mount.appendChild(layer);
    this.layer = layer;
  }

  /**
   * Spawn at a world position. Event-rate (per landed hit). Reuses a free pool
   * slot, or — pool exhausted — recycles the oldest live number mid-flight
   * rather than allocating (§13).
   */
  spawn(x: number, y: number, z: number, amount: number, crit: boolean, heavy: boolean): void {
    if (this.layer === undefined) return;

    const entries = this.entries;
    let slot: NumberEntry | undefined;
    let oldest: NumberEntry | undefined;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === undefined) continue;
      if (!entry.live) {
        slot = entry;
        break;
      }
      if (oldest === undefined || entry.seq < oldest.seq) oldest = entry;
    }
    if (slot === undefined) slot = oldest;
    if (slot === undefined) return;

    if (!slot.live) this.liveCount++;
    if (!slot.shown) this.shownCount++;
    slot.live = true;
    slot.shown = true;
    slot.age = 0;
    slot.seq = this.nextSeq++;
    slot.wx = x;
    slot.wy = y;
    slot.wz = z;
    // Force the first render() to write transform and opacity.
    slot.keyX = KEY_NONE;
    slot.keyY = KEY_NONE;
    slot.opacityStep = -1;

    // Rounded for display; a real hit never reads as "0".
    let value = Math.round(amount);
    if (value < 1 && amount > 0) value = 1;
    if (value !== slot.shownValue) {
      slot.shownValue = value;
      slot.text.nodeValue = String(value);
    }

    const classIndex = (crit ? 1 : 0) + (heavy ? 2 : 0);
    if (classIndex !== slot.classIndex) {
      slot.classIndex = classIndex;
      slot.el.className = LIVE_CLASS[classIndex] ?? IDLE_CLASS;
    }
  }

  /** Ages entries only — the contract forbids DOM work here. */
  update(dt: number): void {
    if (this.liveCount === 0) return;
    const entries = this.entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === undefined || !entry.live) continue;
      entry.age += dt;
      if (entry.age >= LIFE_SECONDS) {
        entry.live = false;
        this.liveCount--;
      }
    }
  }

  /** Projection + throttled style writes. `alpha` is not needed: hit points are
   *  fixed in the world, so there is nothing to interpolate. */
  render(): void {
    if (this.liveCount === 0 && this.shownCount === 0) return;
    const layer = this.layer;
    if (layer === undefined) return;

    const camera = this.camera;
    // The renderer refreshes these AFTER the system render pass; without this
    // the projection lags the camera by a frame and numbers swim on fast pans.
    // Both calls are in-place matrix maths — no allocation.
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    // `?? 0` only satisfies noUncheckedIndexedAccess — a Matrix4 always has 16.
    const m = camera.matrixWorld.elements;
    const camX = m[12] ?? 0;
    const camY = m[13] ?? 0;
    const camZ = m[14] ?? 0;
    // Camera forward = -Z basis column; orthonormal, so already unit length.
    const fwdX = -(m[8] ?? 0);
    const fwdY = -(m[9] ?? 0);
    const fwdZ = -(m[10] ?? 0);

    const width = window.innerWidth;
    const height = window.innerHeight;
    const minX = -width * VIEW_MARGIN;
    const maxX = width * (1 + VIEW_MARGIN);
    const minY = -height * VIEW_MARGIN;
    const maxY = height * (1 + VIEW_MARGIN);

    const entries = this.entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === undefined) continue;

      if (!entry.live) {
        if (entry.shown) this.hide(entry);
        continue;
      }

      // Behind-camera dot test — project() folds back-projections into view.
      const behind =
        (entry.wx - camX) * fwdX + (entry.wy - camY) * fwdY + (entry.wz - camZ) * fwdZ;
      if (behind <= BEHIND_EPSILON) {
        this.park(entry);
        continue;
      }

      worldPoint.set(entry.wx, entry.wy, entry.wz).project(camera);
      const t = entry.age / LIFE_SECONDS;
      let sx = (worldPoint.x * 0.5 + 0.5) * width + entry.jitterX;
      let sy = (0.5 - worldPoint.y * 0.5) * height - RISE_PX * riseEase(t);
      if (sx < minX) sx = minX;
      else if (sx > maxX) sx = maxX;
      if (sy < minY) sy = minY;
      else if (sy > maxY) sy = maxY;

      // Whole-pixel buckets: unchanged frames build no string and touch no style.
      const keyX = Math.round(sx);
      const keyY = Math.round(sy);
      if (keyX !== entry.keyX || keyY !== entry.keyY) {
        entry.keyX = keyX;
        entry.keyY = keyY;
        entry.el.style.transform = 'translate3d(' + keyX + 'px,' + keyY + 'px,0)';
      }

      let opacity = t <= FADE_START ? 1 : (1 - t) / (1 - FADE_START);
      if (opacity < 0) opacity = 0;
      const step = Math.round(opacity * OPACITY_STEPS);
      if (step !== entry.opacityStep) {
        entry.opacityStep = step;
        const text = OPACITY_TEXT[step];
        if (text !== undefined) entry.el.style.opacity = text;
      }
    }
  }

  reset(): void {
    const entries = this.entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === undefined) continue;
      entry.live = false;
      if (entry.shown) this.hide(entry);
      entry.age = 0;
      entry.seq = 0;
    }
    this.liveCount = 0;
    this.shownCount = 0;
    this.nextSeq = 1;
  }

  dispose(): void {
    const layer = this.layer;
    if (layer === undefined) return;
    layer.remove();
    this.layer = undefined;
    this.entries.length = 0;
    this.liveCount = 0;
    this.shownCount = 0;
    // The <style> tag stays: it is shared, static, and idempotent by id.
  }

  /** Live entries currently in flight — for tests and the profiler overlay. */
  get activeCount(): number {
    return this.liveCount;
  }

  /** Transform-only offscreen park: hidden without display/layout churn. */
  private park(entry: NumberEntry): void {
    if (entry.keyX === KEY_NONE && entry.keyY === KEY_NONE) return;
    entry.keyX = KEY_NONE;
    entry.keyY = KEY_NONE;
    entry.el.style.transform = PARK_TRANSFORM;
  }

  private hide(entry: NumberEntry): void {
    entry.shown = false;
    this.shownCount--;
    this.park(entry);
    if (entry.opacityStep !== 0) {
      entry.opacityStep = 0;
      const text = OPACITY_TEXT[0];
      if (text !== undefined) entry.el.style.opacity = text;
    }
    if (entry.classIndex !== CLASS_NONE) {
      entry.classIndex = CLASS_NONE;
      entry.el.className = IDLE_CLASS;
    }
  }
}
