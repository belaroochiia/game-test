import * as THREE from 'three';

import { Engine, WebGL2UnsupportedError } from './core/Engine';
import type { System } from './core/Engine';
import type { ProfilerMetrics } from './core/Profiler';

/**
 * Phase 0 bootstrap (CLAUDE.md §12).
 *
 * Scope on purpose: a grey cube spinning at 60 FPS with a truthful debug overlay.
 * No terrain, no player, no touch input — those are Phase 1. The only reason this
 * file has any scene content at all is that the acceptance criterion needs
 * something to render and something to interpolate.
 */

const VERSION = '0.1.0-phase0';

// ---------------------------------------------------------------------------
// Phase 0 scene
// ---------------------------------------------------------------------------

/**
 * The one thing on screen. Logic runs at the fixed 30 Hz tick and only writes
 * plain numbers; the visual transform is written in render() using the loop's
 * interpolation alpha, so the cube looks smooth at any display refresh rate
 * without the simulation ever running faster than 30 Hz (§4.2).
 */
class SpinRigSystem implements System {
  readonly name = 'spinRig';

  private readonly mesh: THREE.Mesh;
  private readonly ground: THREE.Mesh;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly scene: THREE.Scene;

  private prevYaw = 0;
  private yaw = 0;
  private prevPitch = 0;
  private pitch = 0;
  private prevBob = 0;
  private bob = 0;
  private time = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // Flat shading + vertex-lit lambert: no textures, no specular pass (§5).
    const cubeGeo = new THREE.BoxGeometry(1.25, 1.25, 1.25);
    const cubeMat = new THREE.MeshLambertMaterial({ color: 0x9aa0ad, flatShading: true });
    this.mesh = new THREE.Mesh(cubeGeo, cubeMat);
    this.mesh.position.set(0, 1.05, 0);
    this.mesh.frustumCulled = true;

    // A floor so the rotation reads as 3D. 2 triangles, 1 draw call.
    const groundGeo = new THREE.PlaneGeometry(60, 60);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x2c3448, flatShading: true });
    this.ground = new THREE.Mesh(groundGeo, groundMat);
    this.ground.rotation.x = -Math.PI / 2;

    // §3: exactly one directional light, plus hemisphere fill. No point lights.
    this.hemi = new THREE.HemisphereLight(0x9dc0ff, 0x2a2f3a, 1.0);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 1.5);
    this.sun.position.set(12, 18, 8);

    scene.add(this.mesh, this.ground, this.hemi, this.sun);
  }

  update(dt: number): void {
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
    this.prevBob = this.bob;

    this.time += dt;
    this.yaw += dt * 0.9;
    this.pitch += dt * 0.35;
    this.bob = Math.sin(this.time * 1.6) * 0.18;
  }

  /** Allocation-free: only scalar writes into existing Euler/Vector3 objects. */
  render(alpha: number): void {
    const yaw = this.prevYaw + (this.yaw - this.prevYaw) * alpha;
    const pitch = this.prevPitch + (this.pitch - this.prevPitch) * alpha;
    const bob = this.prevBob + (this.bob - this.prevBob) * alpha;

    this.mesh.rotation.y = yaw;
    this.mesh.rotation.x = pitch;
    this.mesh.position.y = 1.05 + bob;
  }

  reset(): void {
    this.time = 0;
    this.yaw = 0;
    this.prevYaw = 0;
    this.pitch = 0;
    this.prevPitch = 0;
    this.bob = 0;
    this.prevBob = 0;
  }

  dispose(): void {
    this.scene.remove(this.mesh, this.ground, this.hemi, this.sun);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.hemi.dispose();
    this.sun.dispose();
  }
}

// ---------------------------------------------------------------------------
// Debug hook (consumed by tools/smoke.mjs)
// ---------------------------------------------------------------------------

interface ArcanumDebug {
  metrics(): ProfilerMetrics;
  frameCount(): number;
  tickCount(): number;
  elapsed(): number;
  toggleDebug(): boolean;
  /** Pins the renderer to a ladder index and disables adaptive scaling. */
  setPixelRatio(index: number): number;
  version: string;
}

type DebugGlobal = { __ARCANUM_DEBUG__?: ArcanumDebug };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const boot = document.getElementById('boot');
const bootMsg = document.getElementById('boot-msg');

function fail(message: string, detail?: unknown): void {
  if (boot !== null) boot.classList.add('is-error');
  if (bootMsg !== null) bootMsg.textContent = message;
  if (detail !== undefined) console.error('[arcanum]', message, detail);
  else console.error('[arcanum]', message);
}

function main(): void {
  const canvas = document.getElementById('game-canvas');
  const uiRoot = document.getElementById('ui-root');

  if (!(canvas instanceof HTMLCanvasElement)) {
    fail('Canvas element #game-canvas is missing from the page.');
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const debugVisible = params.get('debug') !== '0';

  let engine: Engine;
  try {
    engine = new Engine({
      canvas,
      uiRoot: uiRoot instanceof HTMLElement ? uiRoot : document.body,
      debug: debugVisible,
    });
  } catch (error) {
    if (error instanceof WebGL2UnsupportedError) {
      fail(
        'This device or browser does not support WebGL 2. Arcanum Drift needs WebGL 2 — try an up-to-date Chrome or Safari.',
        error,
      );
    } else {
      fail('Renderer failed to start. See the browser console for details.', error);
    }
    return;
  }

  // Exponential fog is what lets the far plane sit at ~180 units with no popping (§3).
  engine.scene.fog = new THREE.FogExp2(0x0a0d14, 0.01);
  engine.scene.background = new THREE.Color(0x0a0d14);

  // Static framing for Phase 0. CameraRig replaces this in Phase 1 (§7).
  engine.camera.position.set(4.4, 3.1, 5.6);
  engine.camera.lookAt(0, 0.9, 0);

  const spinRig = new SpinRigSystem(engine.scene);
  engine.addSystem(spinRig);

  // --- debug overlay toggle ------------------------------------------------
  const debugButton = document.getElementById('btn-debug');

  const syncDebugButton = (visible: boolean): void => {
    if (debugButton !== null) debugButton.setAttribute('aria-pressed', visible ? 'true' : 'false');
  };
  syncDebugButton(engine.profiler.visible);

  const toggleDebug = (): boolean => {
    const visible = engine.profiler.toggle();
    syncDebugButton(visible);
    engine.bus.emit('debug:toggle', { visible });
    return visible;
  };

  if (debugButton !== null) {
    debugButton.addEventListener('click', () => {
      toggleDebug();
    });
  }

  // Desktop convenience while developing; harmless on phones.
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'p' || event.key === 'P') toggleDebug();
  });

  // A lost context on mobile is common (backgrounding, GPU reset) and silently
  // freezes the game unless we say something.
  canvas.addEventListener('webglcontextlost', (event: Event) => {
    event.preventDefault();
    if (boot !== null) boot.classList.remove('is-gone');
    fail('Graphics context was lost. Reload the page to continue.');
  });

  engine.start();

  // --- debug hook ---------------------------------------------------------
  const debug: ArcanumDebug = {
    metrics: () => {
      // Profiler hands back a live internal object; copy it so callers (and
      // structured-clone across the CDP boundary) get a stable snapshot.
      const m = engine.profiler.metrics;
      return {
        fps: m.fps,
        frameMs: m.frameMs,
        frameMsMax: m.frameMsMax,
        cpuMs: m.cpuMs,
        drawCalls: m.drawCalls,
        triangles: m.triangles,
        programs: m.programs,
        geometries: m.geometries,
        textures: m.textures,
        heapMb: m.heapMb,
        pixelRatio: m.pixelRatio,
        drawWidth: m.drawWidth,
        drawHeight: m.drawHeight,
        ticks: m.ticks,
      };
    },
    frameCount: () => engine.frameCount,
    tickCount: () => engine.loop.tickCount,
    elapsed: () => engine.elapsed,
    toggleDebug,
    setPixelRatio: (index: number) => {
      // Pin the ladder so an adaptive step cannot fight the test that just set it.
      engine.resolution.setEnabled(false);
      const applied = engine.resolution.setIndex(index);
      engine.resize();
      return applied;
    },
    version: VERSION,
  };
  (globalThis as DebugGlobal).__ARCANUM_DEBUG__ = debug;

  // Hide the boot screen only once we know frames are actually landing.
  const waitForFirstFrames = (): void => {
    if (engine.frameCount >= 2) {
      if (boot !== null) boot.classList.add('is-gone');
      return;
    }
    window.requestAnimationFrame(waitForFirstFrames);
  };
  window.requestAnimationFrame(waitForFirstFrames);

  if (import.meta.env.DEV) {
    console.info('[arcanum] phase 0 online —', VERSION);
  }
}

// Block the browser gestures that survive CSS alone.
window.addEventListener('contextmenu', (event: MouseEvent) => event.preventDefault());
document.addEventListener(
  'gesturestart',
  (event: Event) => {
    event.preventDefault();
  },
  { passive: false },
);

main();
