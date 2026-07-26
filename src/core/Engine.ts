import * as THREE from 'three';

import { DynamicResolution } from './DynamicResolution';
import { EventBus } from './EventBus';
import type { GameEventMap } from './EventBus';
import { Loop } from './Loop';
import { Profiler } from './Profiler';

/** Every subsystem follows this shape (§4.4). `render` and `dispose` are opt-in. */
export interface System {
  readonly name: string;
  update(dt: number): void;
  reset(): void;
  /** Optional visual interpolation before render. */
  render?(alpha: number): void;
  dispose?(): void;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  uiRoot?: HTMLElement;
  debug?: boolean;
  antialias?: boolean;
  farPlane?: number;
  fov?: number;
}

export class WebGL2UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebGL2UnsupportedError';
  }
}

const DEFAULT_FOV = 65; // §7
const DEFAULT_FAR = 180; // §3 — dense FogExp2 is what hides this plane
const NEAR_PLANE = 0.1;
/** Only visible where nothing writes the background; main.ts owns sky colour. */
const CLEAR_COLOR = 0x0a0d14;
const MS_PER_SECOND = 1000;

/**
 * three.js dropped the WebGL 1 renderer in r163, so CLAUDE.md §2's "fallback
 * WebGL 1" cannot be honoured with the mandated stack: the honest degradation is
 * a readable message instead of a black canvas.
 */
const NO_WEBGL2_MESSAGE =
  'WebGL 2 is required and this browser did not provide it. ' +
  'Update to a recent Chrome/Safari and make sure hardware acceleration is enabled. ' +
  'There is no WebGL 1 fallback: three.js removed its WebGL 1 renderer in r163.';

/**
 * WebGL 2 probe on a throwaway 1x1 canvas — asking the real canvas for a context
 * would bind one with the wrong attributes and make WebGLRenderer fail later.
 */
function hasWebGL2(): boolean {
  let gl: WebGL2RenderingContext | null = null;
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    gl = probe.getContext('webgl2');
  } catch {
    return false;
  }
  if (gl === null) return false;
  // Browsers cap live GL contexts (~16); release the probe's immediately.
  const lose = gl.getExtension('WEBGL_lose_context');
  if (lose !== null) lose.loseContext();
  return true;
}

/**
 * Engine owns the renderer, scene, camera, loop, bus, profiler, dynamic resolution
 * and the system list — and nothing else (§4.4: the only global-ish singleton).
 * It has zero gameplay knowledge: no cube, no player, no terrain.
 *
 * Frame path is allocation-free (§3: 0 byte/frame). The three loop callbacks are
 * pre-bound instance fields, event payloads are reused scratch objects, system
 * iteration is a plain indexed for-loop, and resize storms collapse into a boolean.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly bus: EventBus;
  readonly profiler: Profiler;
  readonly resolution: DynamicResolution;
  readonly loop: Loop;

  private readonly canvas: HTMLCanvasElement;

  /** Tombstoned in place (`undefined`) when a system is removed mid-iteration. */
  private readonly systems: (System | undefined)[] = [];
  private readonly pendingAdd: (System | undefined)[] = [];
  private iterDepth = 0;
  private tombstones = 0;

  private simElapsed = 0;
  private ticksThisFrame = 0;
  private cpuTickMs = 0;
  private cpuMs = 0;

  private resizeDirty = true;
  private inResize = false;
  private disposed = false;

  /** Reused payloads — handlers must not retain them (see EventBus). */
  private readonly resizePayload: GameEventMap['engine:resize'] = {
    width: 0,
    height: 0,
    pixelRatio: 1,
  };
  private readonly qualityPayload: GameEventMap['engine:quality'] = {
    pixelRatio: 1,
    direction: 0,
  };
  private readonly startedPayload: GameEventMap['engine:started'] = { webgl2: true };

  constructor(options: EngineOptions) {
    if (!hasWebGL2()) throw new WebGL2UnsupportedError(NO_WEBGL2_MESSAGE);

    this.canvas = options.canvas;
    this.bus = new EventBus();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: options.canvas,
        antialias: options.antialias ?? false, // MSAA is not free on mobile
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
        depth: true,
        preserveDrawingBuffer: false,
        failIfMajorPerformanceCaveat: false,
      });
    } catch (cause) {
      throw new WebGL2UnsupportedError(NO_WEBGL2_MESSAGE + ' (' + String(cause) + ')');
    }
    this.renderer = renderer;

    renderer.setClearColor(CLEAR_COLOR, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping costs fragment work for no Phase 0 benefit (§3).
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      options.fov ?? DEFAULT_FOV,
      1,
      NEAR_PLANE,
      options.farPlane ?? DEFAULT_FAR,
    );
    // Neutral third-person framing (§7) so a bare Engine renders something sane;
    // gameplay code overwrites it.
    this.camera.position.set(0, 1.6, 6);
    this.camera.lookAt(0, 1, 0);

    this.profiler = new Profiler(renderer, {
      mount: options.uiRoot ?? document.body,
      visible: options.debug ?? true,
    });

    // DynamicResolution is the only owner of renderer.setPixelRatio (§3).
    this.resolution = new DynamicResolution(renderer);
    this.resolution.onChange = this.onQualityChange;

    this.loop = new Loop({
      update: this.tickSystems,
      render: this.renderFrame,
      onFrameEnd: this.endFrame,
      bus: this.bus,
    });

    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('orientationchange', this.onViewportChange);

    this.resize();
  }

  addSystem(system: System): void {
    if (this.disposed) {
      console.warn('Engine: addSystem after dispose():', system.name);
      return;
    }
    if (this.systems.indexOf(system) >= 0 || this.pendingAdd.indexOf(system) >= 0) {
      console.warn('Engine: system already registered:', system.name);
      return;
    }
    // Deferred while a tick/render pass is walking the list, so adding from
    // inside update() cannot reallocate the array under the iterator.
    if (this.iterDepth > 0) this.pendingAdd.push(system);
    else this.systems.push(system);
  }

  removeSystem(system: System): void {
    const pending = this.pendingAdd;
    const queued = pending.indexOf(system);
    if (queued >= 0) {
      // Never added yet: drop it from the queue, order preserved, no allocation.
      const last = pending.length - 1;
      for (let i = queued; i < last; i++) pending[i] = pending[i + 1];
      pending.length = last;
      return;
    }

    const systems = this.systems;
    const index = systems.indexOf(system);
    if (index < 0) return;

    if (this.iterDepth > 0) {
      systems[index] = undefined;
      this.tombstones++;
      return;
    }
    const last = systems.length - 1;
    for (let i = index; i < last; i++) systems[i] = systems[i + 1];
    systems.length = last;
  }

  getSystem(name: string): System | undefined {
    const systems = this.systems;
    for (let i = 0; i < systems.length; i++) {
      const system = systems[i];
      if (system !== undefined && system.name === name) return system;
    }
    const pending = this.pendingAdd;
    for (let i = 0; i < pending.length; i++) {
      const system = pending[i];
      if (system !== undefined && system.name === name) return system;
    }
    return undefined;
  }

  start(): void {
    if (this.disposed) return;
    this.resize();
    this.startedPayload.webgl2 = true;
    this.bus.emit('engine:started', this.startedPayload);
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  reset(): void {
    const systems = this.systems;
    this.iterDepth++;
    for (let i = 0; i < systems.length; i++) {
      const system = systems[i];
      if (system === undefined) continue;
      system.reset();
    }
    this.iterDepth--;
    if (this.iterDepth === 0) this.flushSystems();

    this.loop.reset();
    this.profiler.reset();
    this.resolution.reset();

    this.simElapsed = 0;
    this.ticksThisFrame = 0;
    this.cpuTickMs = 0;
    this.cpuMs = 0;
    this.resizeDirty = true;
  }

  /**
   * Reads the container size and reapplies it. CSS sizing stays in the stylesheet
   * (`setSize(w, h, false)`), and the drawing-buffer scale comes from
   * DynamicResolution — this method never picks a pixel ratio of its own.
   */
  resize(): void {
    if (this.inResize) {
      // Re-entered from resolution.onChange; let the next frame settle it.
      this.resizeDirty = true;
      return;
    }
    this.inResize = true;
    this.resizeDirty = false;

    const parent = this.canvas.parentElement;
    let width = 0;
    let height = 0;
    if (parent !== null) {
      width = parent.clientWidth;
      height = parent.clientHeight;
    }
    if (width < 1) width = window.innerWidth;
    if (height < 1) height = window.innerHeight;
    if (width < 1) width = 1;
    if (height < 1) height = 1;

    // devicePixelRatio moves with browser zoom and monitor swaps, and the ladder
    // is clamped by it — re-clamp before sizing so the buffer is right first try.
    this.resolution.clampToDevice();

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    const payload = this.resizePayload;
    payload.width = width;
    payload.height = height;
    payload.pixelRatio = this.resolution.pixelRatio;
    // Emitted inside the guard: a handler that calls resize() again is deferred to
    // the next frame instead of recursing.
    this.bus.emit('engine:resize', payload);

    this.inResize = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('orientationchange', this.onViewportChange);
    this.resolution.onChange = undefined;

    this.loop.dispose();

    const systems = this.systems;
    this.iterDepth++;
    for (let i = 0; i < systems.length; i++) {
      const system = systems[i];
      if (system === undefined) continue;
      const dispose = system.dispose;
      if (dispose !== undefined) dispose.call(system);
    }
    this.iterDepth--;
    systems.length = 0;
    this.pendingAdd.length = 0;
    this.tombstones = 0;

    this.profiler.dispose();
    this.scene.clear();
    this.bus.reset();
    this.renderer.dispose();
  }

  /** Simulated seconds: fixed ticks x dt, never wall time. */
  get elapsed(): number {
    return this.simElapsed;
  }

  get frameCount(): number {
    return this.loop.frameCount;
  }

  /** Compacts tombstones and appends deferred systems. Called at depth 0 only. */
  private flushSystems(): void {
    const systems = this.systems;
    if (this.tombstones > 0) {
      let write = 0;
      for (let i = 0; i < systems.length; i++) {
        const system = systems[i];
        if (system === undefined) continue;
        systems[write] = system;
        write++;
      }
      systems.length = write;
      this.tombstones = 0;
    }
    const pending = this.pendingAdd;
    if (pending.length > 0) {
      for (let i = 0; i < pending.length; i++) {
        const system = pending[i];
        if (system === undefined) continue;
        systems.push(system);
      }
      pending.length = 0;
    }
  }

  /**
   * resize/orientationchange only raise a flag; the work happens once at the next
   * frame start. iOS also reports stale layout during orientationchange, so
   * deferring by a frame measures the size the browser actually settled on.
   */
  private readonly onViewportChange = (): void => {
    this.resizeDirty = true;
  };

  private readonly onQualityChange = (pixelRatio: number, direction: -1 | 1): void => {
    const payload = this.qualityPayload;
    payload.pixelRatio = pixelRatio;
    payload.direction = direction;
    this.bus.emit('engine:quality', payload);
    // The drawing buffer changed size even though the CSS size did not.
    this.resize();
  };

  private readonly tickSystems = (dt: number): void => {
    const started = performance.now();

    const systems = this.systems;
    this.iterDepth++;
    for (let i = 0; i < systems.length; i++) {
      const system = systems[i];
      if (system === undefined) continue;
      system.update(dt);
    }
    this.iterDepth--;
    if (this.iterDepth === 0) this.flushSystems();

    this.simElapsed += dt;
    this.ticksThisFrame++;
    this.cpuTickMs += performance.now() - started;
  };

  /** `frameMs` is intentionally not taken: unused parameters are a compile error. */
  private readonly renderFrame = (alpha: number): void => {
    const started = performance.now();

    if (this.resizeDirty) this.resize();

    const systems = this.systems;
    this.iterDepth++;
    for (let i = 0; i < systems.length; i++) {
      const system = systems[i];
      if (system === undefined) continue;
      const render = system.render;
      if (render === undefined) continue;
      render.call(system, alpha);
    }
    this.iterDepth--;
    if (this.iterDepth === 0) this.flushSystems();

    this.renderer.render(this.scene, this.camera);

    this.cpuMs = this.cpuTickMs + (performance.now() - started);
    this.cpuTickMs = 0;
  };

  private readonly endFrame = (frameMs: number): void => {
    // profiler.sample() must run here: three clears renderer.info.render on the
    // next render() call, so this is the only window where the counters are real.
    this.profiler.sample(frameMs, this.cpuMs, this.ticksThisFrame);
    this.resolution.sample(frameMs);
    this.profiler.update(frameMs / MS_PER_SECOND);
    this.ticksThisFrame = 0;
  };
}
