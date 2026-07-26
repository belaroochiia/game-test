import * as THREE from 'three';

export interface ProfilerMetrics {
  fps: number;          // smoothed
  frameMs: number;      // smoothed
  frameMsMax: number;   // worst frame in the current window
  cpuMs: number;        // smoothed update+render CPU time
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  heapMb: number;       // -1 when unavailable
  pixelRatio: number;
  drawWidth: number;
  drawHeight: number;
  ticks: number;        // fixed ticks in the last second
}

export interface ProfilerOptions {
  mount?: HTMLElement;
  visible?: boolean;
  refreshMs?: number;
  budget?: { frameMs?: number; drawCalls?: number; triangles?: number };
}

/**
 * Chrome-only heap counters. Declared as a narrow local shape so the feature
 * detection needs exactly one cast and no `any` reaches the public API.
 */
interface MemoryInfo {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface PerformanceWithMemory extends Performance {
  readonly memory?: MemoryInfo;
}

/**
 * Every DOM handle the overlay ever needs, built once in the constructor and
 * boxed in one object: the refresh path then costs a single undefined check and
 * `dispose()` drops all references with a single assignment.
 */
interface ProfilerDom {
  readonly root: HTMLDivElement;
  readonly fps: Text;
  readonly frame: Text;
  readonly cpu: Text;
  readonly draws: Text;
  readonly tris: Text;
  readonly prog: Text;
  readonly geo: Text;
  readonly heap: Text;
  readonly res: Text;
  readonly ticks: Text;
  // Only the four budgeted rows need their element kept for class toggling.
  readonly frameRow: HTMLDivElement;
  readonly drawsRow: HTMLDivElement;
  readonly trisRow: HTMLDivElement;
  readonly heapRow: HTMLDivElement;
}

const DEFAULT_REFRESH_MS = 250;
const MIN_REFRESH_MS = 16;

/** EMA factor per rendered frame (~10 frame time constant): a single hitch must not move the readout. */
const SMOOTHING = 0.1;

/**
 * §3 budgets. frameMs has two: 60 FPS target (warn) and the 30 FPS absolute floor (over).
 *
 * The warn threshold is 17.5 ms, not the literal 16.6 ms from §3: a healthy vsync-locked
 * 60 Hz device averages 16.67 ms, so gating at 16.6 would paint the row amber forever and
 * train us to ignore it. 17.5 ms still flags anything that has actually dropped a frame.
 */
const BUDGET_FRAME_MS = 17.5;
const BUDGET_FRAME_MS_FLOOR = 33;
const BUDGET_DRAW_CALLS = 110;
const BUDGET_TRIANGLES = 150_000;
const BUDGET_HEAP_MB = 280;
/** A metric is "within 10 % of budget" from this fraction upwards. */
const WARN_FRACTION = 0.9;

const BYTES_PER_MB = 1024 * 1024;
const TICK_WINDOW_MS = 1000;

const STATE_DIRTY = -1;
const STATE_NONE = 0;
const STATE_WARN = 1;
const STATE_OVER = 2;

/** Shared scratch for renderer.getDrawingBufferSize — never escapes this module. */
const SIZE = new THREE.Vector2();

function fmt1(value: number): string {
  return value.toFixed(1);
}

function fmtInt(value: number): string {
  return value.toFixed(0);
}

/** k / M suffix above 10 000 / 1 000 000 so the row width stays stable. */
function fmtCount(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + 'M';
  if (value >= 10_000) return (value / 1000).toFixed(1) + 'k';
  return value.toFixed(0);
}

/** Skip the DOM write when the text is unchanged (stable rows like RES/PROG). */
function setText(node: Text, text: string): void {
  if (node.nodeValue !== text) node.nodeValue = text;
}

function budgetState(value: number, warnAt: number, overAt: number): number {
  if (value > overAt) return STATE_OVER;
  if (value >= warnAt) return STATE_WARN;
  return STATE_NONE;
}

/** Touch classList only on an actual transition — avoids needless style invalidation. */
function applyState(row: HTMLDivElement, previous: number, next: number): number {
  if (previous === next) return next;
  const list = row.classList;
  list.toggle('is-warn', next === STATE_WARN);
  list.toggle('is-over', next === STATE_OVER);
  return next;
}

function makeRow(root: HTMLElement, metric: string, label: string, value: Text): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'profiler__row';
  row.setAttribute('data-metric', metric);
  const key = document.createElement('span');
  key.className = 'profiler__key';
  key.appendChild(document.createTextNode(label));
  const val = document.createElement('span');
  val.className = 'profiler__val';
  val.appendChild(value);
  row.appendChild(key);
  row.appendChild(val);
  root.appendChild(row);
  return row;
}

/**
 * Debug overlay + metric collection (§4, Phase 0 acceptance criterion).
 *
 * Split of duties: `sample()` runs every rendered frame and only does number
 * work (allocation-free, 0 byte/frame per §3); every string and DOM write lives
 * in the `update()` refresh, throttled to `refreshMs` (4x/s by default).
 */
export class Profiler {
  private readonly renderer: THREE.WebGLRenderer;
  private dom: ProfilerDom | undefined;
  private readonly m: ProfilerMetrics;

  /** Undefined when the browser exposes no heap counters (Safari, Firefox). */
  private readonly memory: MemoryInfo | undefined;

  private readonly refreshMs: number;
  private readonly warnFrameMs: number;
  private readonly overFrameMs: number;
  private readonly warnDrawCalls: number;
  private readonly overDrawCalls: number;
  private readonly warnTriangles: number;
  private readonly overTriangles: number;

  private visibleFlag: boolean;
  private refreshAcc = 0;

  private warm = false;
  private emaFrameMs = 0;
  private emaCpuMs = 0;
  private windowMaxMs = 0;
  private tickBucket = 0;
  private tickBucketMs = 0;

  private stateFrame = STATE_DIRTY;
  private stateDraws = STATE_DIRTY;
  private stateTris = STATE_DIRTY;
  private stateHeap = STATE_DIRTY;

  constructor(renderer: THREE.WebGLRenderer, options?: ProfilerOptions) {
    this.renderer = renderer;

    const refresh = options?.refreshMs ?? DEFAULT_REFRESH_MS;
    this.refreshMs = Number.isFinite(refresh) ? Math.max(MIN_REFRESH_MS, refresh) : DEFAULT_REFRESH_MS;

    const frameBudget = options?.budget?.frameMs ?? BUDGET_FRAME_MS;
    const drawBudget = options?.budget?.drawCalls ?? BUDGET_DRAW_CALLS;
    const triBudget = options?.budget?.triangles ?? BUDGET_TRIANGLES;
    this.warnFrameMs = frameBudget;
    this.overFrameMs = Math.max(BUDGET_FRAME_MS_FLOOR, frameBudget);
    this.warnDrawCalls = drawBudget * WARN_FRACTION;
    this.overDrawCalls = drawBudget;
    this.warnTriangles = triBudget * WARN_FRACTION;
    this.overTriangles = triBudget;

    // Feature-detect the heap counters once; never probe per frame.
    const perf = performance as PerformanceWithMemory;
    const mem = perf.memory;
    this.memory = typeof mem?.usedJSHeapSize === 'number' ? mem : undefined;

    this.m = {
      fps: 0,
      frameMs: 0,
      frameMsMax: 0,
      cpuMs: 0,
      drawCalls: 0,
      triangles: 0,
      programs: 0,
      geometries: 0,
      textures: 0,
      heapMb: -1,
      pixelRatio: renderer.getPixelRatio(),
      drawWidth: 0,
      drawHeight: 0,
      ticks: 0,
    };

    const root = document.createElement('div');
    root.id = 'profiler';
    root.className = 'profiler';
    root.setAttribute('role', 'status');
    // Live region off: the values change 4x/s and must never be announced.
    root.setAttribute('aria-live', 'off');

    const fps = document.createTextNode('-');
    const frame = document.createTextNode('-');
    const cpu = document.createTextNode('-');
    const draws = document.createTextNode('-');
    const tris = document.createTextNode('-');
    const prog = document.createTextNode('-');
    const geo = document.createTextNode('-');
    const heap = document.createTextNode('-');
    const res = document.createTextNode('-');
    const ticks = document.createTextNode('-');

    makeRow(root, 'fps', 'FPS', fps);
    const frameRow = makeRow(root, 'frame', 'FRAME', frame);
    makeRow(root, 'cpu', 'CPU', cpu);
    const drawsRow = makeRow(root, 'draws', 'DRAWS', draws);
    const trisRow = makeRow(root, 'tris', 'TRIS', tris);
    makeRow(root, 'prog', 'PROG', prog);
    makeRow(root, 'geo', 'GEO/TEX', geo);
    const heapRow = makeRow(root, 'heap', 'HEAP', heap);
    makeRow(root, 'res', 'RES', res);
    makeRow(root, 'ticks', 'TICK', ticks);

    this.dom = {
      root,
      fps,
      frame,
      cpu,
      draws,
      tris,
      prog,
      geo,
      heap,
      res,
      ticks,
      frameRow,
      drawsRow,
      trisRow,
      heapRow,
    };

    this.visibleFlag = options?.visible ?? true;
    root.style.display = this.visibleFlag ? '' : 'none';
    (options?.mount ?? document.body).appendChild(root);
  }

  /**
   * One rendered frame. Allocation-free: numbers only, no strings, no objects.
   *
   * Ordering dependency: three.js clears `renderer.info.render` at the START of
   * every `renderer.render()` call while `info.autoReset` is true (the default),
   * so the counters below are only meaningful between render() and the next
   * frame. The Engine calls this immediately after render() for that reason —
   * moving the call earlier reports zeros, and reading these fields from
   * `update()` instead would report a stale frame.
   */
  sample(frameMs: number, cpuMs: number, ticks: number): void {
    const m = this.m;
    const info = this.renderer.info;
    const render = info.render;

    m.drawCalls = render.calls;
    m.triangles = render.triangles;
    m.programs = info.programs?.length ?? 0;
    m.geometries = info.memory.geometries;
    m.textures = info.memory.textures;

    const dtMs = frameMs > 0 ? frameMs : 0;
    if (dtMs > 0) {
      if (this.warm) {
        this.emaFrameMs += (dtMs - this.emaFrameMs) * SMOOTHING;
        this.emaCpuMs += (cpuMs - this.emaCpuMs) * SMOOTHING;
      } else {
        // Seed from the first real frame: ramping from 0 would report absurd FPS.
        this.emaFrameMs = dtMs;
        this.emaCpuMs = cpuMs;
        this.warm = true;
      }
      m.frameMs = this.emaFrameMs;
      m.cpuMs = this.emaCpuMs;
      m.fps = this.emaFrameMs > 0 ? 1000 / this.emaFrameMs : 0;
      if (dtMs > this.windowMaxMs) this.windowMaxMs = dtMs;
    }

    // Tick rate as a 1 s bucket, normalised so a partial bucket still reads /s.
    this.tickBucket += ticks;
    this.tickBucketMs += dtMs;
    if (this.tickBucketMs >= TICK_WINDOW_MS) {
      m.ticks = Math.round((this.tickBucket * TICK_WINDOW_MS) / this.tickBucketMs);
      this.tickBucket = 0;
      this.tickBucketMs = 0;
    }
  }

  /** System convention. Owns the throttled publish + DOM refresh. */
  update(dt: number): void {
    this.refreshAcc += dt * 1000;
    if (this.refreshAcc < this.refreshMs) return;
    // Reset instead of subtracting: after a long stall we want one refresh, not a burst.
    this.refreshAcc = 0;

    this.publish();
    // Metrics stay live for automated tests even while hidden; strings do not.
    if (!this.visibleFlag) return;
    const dom = this.dom;
    if (dom === undefined) return;
    this.refreshDom(dom);
  }

  reset(): void {
    const m = this.m;
    m.fps = 0;
    m.frameMs = 0;
    m.frameMsMax = 0;
    m.cpuMs = 0;
    m.drawCalls = 0;
    m.triangles = 0;
    m.programs = 0;
    m.geometries = 0;
    m.textures = 0;
    m.heapMb = -1;
    m.pixelRatio = this.renderer.getPixelRatio();
    m.drawWidth = 0;
    m.drawHeight = 0;
    m.ticks = 0;

    this.warm = false;
    this.emaFrameMs = 0;
    this.emaCpuMs = 0;
    this.windowMaxMs = 0;
    this.tickBucket = 0;
    this.tickBucketMs = 0;

    this.stateFrame = STATE_DIRTY;
    this.stateDraws = STATE_DIRTY;
    this.stateTris = STATE_DIRTY;
    this.stateHeap = STATE_DIRTY;
    // Refresh on the very next update() so the overlay never shows stale values.
    this.refreshAcc = this.refreshMs;
  }

  setVisible(visible: boolean): void {
    this.visibleFlag = visible;
    const dom = this.dom;
    if (dom === undefined) return;
    dom.root.style.display = visible ? '' : 'none';
    if (visible) this.refreshAcc = this.refreshMs;
  }

  toggle(): boolean {
    this.setVisible(!this.visibleFlag);
    return this.visibleFlag;
  }

  get visible(): boolean {
    return this.visibleFlag;
  }

  /**
   * The live internal object, not a copy — reading it is allocation-free.
   * Callers must NOT mutate it, and must copy field by field if they need a
   * snapshot that survives the next frame.
   */
  get metrics(): Readonly<ProfilerMetrics> {
    return this.m;
  }

  get fps(): number {
    return this.m.fps;
  }

  dispose(): void {
    const dom = this.dom;
    if (dom === undefined) return;
    dom.root.remove();
    this.dom = undefined;
  }

  /** Close the measurement window and pull the values that are cheap at 4x/s. */
  private publish(): void {
    const m = this.m;
    m.frameMsMax = this.windowMaxMs;
    this.windowMaxMs = 0;

    const memory = this.memory;
    if (memory !== undefined) m.heapMb = memory.usedJSHeapSize / BYTES_PER_MB;

    const renderer = this.renderer;
    m.pixelRatio = renderer.getPixelRatio();
    const size = renderer.getDrawingBufferSize(SIZE);
    m.drawWidth = size.x;
    m.drawHeight = size.y;
  }

  private refreshDom(dom: ProfilerDom): void {
    const m = this.m;
    setText(dom.fps, fmt1(m.fps));
    setText(dom.frame, fmt1(m.frameMs) + ' / ' + fmt1(m.frameMsMax) + ' ms');
    setText(dom.cpu, fmt1(m.cpuMs) + ' ms');
    setText(dom.draws, fmtInt(m.drawCalls));
    setText(dom.tris, fmtCount(m.triangles));
    setText(dom.prog, fmtInt(m.programs));
    setText(dom.geo, fmtInt(m.geometries) + ' / ' + fmtInt(m.textures));
    setText(dom.heap, m.heapMb < 0 ? 'n/a' : fmtInt(m.heapMb) + ' MB');
    setText(dom.res, fmtInt(m.drawWidth) + 'x' + fmtInt(m.drawHeight) + ' @' + m.pixelRatio.toFixed(2));
    setText(dom.ticks, fmtInt(m.ticks) + ' /s');

    // Colour on the smoothed frame time; the max column is too spiky to gate on.
    this.stateFrame = applyState(
      dom.frameRow,
      this.stateFrame,
      budgetState(m.frameMs, this.warnFrameMs, this.overFrameMs),
    );
    this.stateDraws = applyState(
      dom.drawsRow,
      this.stateDraws,
      budgetState(m.drawCalls, this.warnDrawCalls, this.overDrawCalls),
    );
    this.stateTris = applyState(
      dom.trisRow,
      this.stateTris,
      budgetState(m.triangles, this.warnTriangles, this.overTriangles),
    );
    this.stateHeap = applyState(
      dom.heapRow,
      this.stateHeap,
      m.heapMb < 0 ? STATE_NONE : budgetState(m.heapMb, BUDGET_HEAP_MB * WARN_FRACTION, BUDGET_HEAP_MB),
    );
  }
}
