import * as THREE from 'three';

import { Engine, WebGL2UnsupportedError } from './core/Engine';
import type { System } from './core/Engine';
import type { ProfilerMetrics } from './core/Profiler';

import { TerrainGen } from './world/TerrainGen';
import { SpatialHash } from './world/SpatialHash';
import type { AABB } from './world/SpatialHash';

import { createInputState } from './player/InputState';
import { PlayerStats } from './player/PlayerStats';
import { PlayerController } from './player/PlayerController';
import type { PlayerState } from './player/PlayerController';
import { CameraRig } from './player/CameraRig';
import { BlockyAvatar } from './player/PlayerAvatar';
import type { AvatarState } from './player/PlayerAvatar';

import { KeyboardInput } from './input/KeyboardInput';
import { TouchControls } from './ui/TouchControls';
import { HUD } from './ui/HUD';

import './styles/game-ui.css';

/**
 * Phase 1 bootstrap (CLAUDE.md §12): one terrain chunk, a blocky procedural
 * player that walks/sprints/dashes under thumb control, and a collision-aware
 * third-person camera.
 *
 * Not here yet, on purpose: chunk streaming, LOD, prop scattering, day/night,
 * water (Phase 2), combat and enemies (Phase 3), skills (Phase 4).
 */

const VERSION = '0.2.0-phase1';

const TERRAIN_SEED = 1337;
/** Deterministic test obstacles so §7's prop push-out is verifiable before PropScatter exists. */
const OBSTACLE_COUNT = 24;

// ---------------------------------------------------------------------------
// Test obstacles — Phase 2's PropScatter replaces this wholesale
// ---------------------------------------------------------------------------

const obstacleMatrix = new THREE.Matrix4();
const obstacleQuat = new THREE.Quaternion();
const obstacleScale = new THREE.Vector3();
const obstaclePos = new THREE.Vector3();
const obstacleBox: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

/**
 * A single InstancedMesh of boxes (§3: one instanced mesh per prop type), each
 * registered in the spatial hash. Deterministic from a seeded LCG so the layout
 * is identical across reloads — the playtest warps to fixed coordinates.
 */
function buildObstacles(terrain: TerrainGen, props: SpatialHash): THREE.InstancedMesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshLambertMaterial({ color: 0x6b7a52, flatShading: true });
  const mesh = new THREE.InstancedMesh(geometry, material, OBSTACLE_COUNT);
  mesh.name = 'obstacles';
  mesh.frustumCulled = true;

  let seed = 0x9e3779b9;
  const rand = (): number => {
    // LCG — deterministic, no allocation, good enough for scattering.
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const span = terrain.size * 0.42;
  for (let i = 0; i < OBSTACLE_COUNT; i++) {
    // Keep a clear ring around spawn so the player never wakes up inside a rock.
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      x = (rand() * 2 - 1) * span;
      z = (rand() * 2 - 1) * span;
      if (x * x + z * z > 25) break;
    }

    const width = 0.9 + rand() * 1.8;
    const depth = 0.9 + rand() * 1.8;
    const height = 0.7 + rand() * 2.4;
    const groundY = terrain.heightAt(x, z);

    obstaclePos.set(x, groundY + height * 0.5, z);
    obstacleScale.set(width, height, depth);
    obstacleQuat.identity();
    obstacleMatrix.compose(obstaclePos, obstacleQuat, obstacleScale);
    mesh.setMatrixAt(i, obstacleMatrix);

    // Axis-aligned only — §7's collision is capsule-vs-AABB, so unrotated boxes
    // keep the test content honest about what the collision code actually handles.
    obstacleBox.minX = x - width * 0.5;
    obstacleBox.maxX = x + width * 0.5;
    obstacleBox.minY = groundY;
    obstacleBox.maxY = groundY + height;
    obstacleBox.minZ = z - depth * 0.5;
    obstacleBox.maxZ = z + depth * 0.5;
    props.insert(obstacleBox);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Systems owned by the bootstrap
// ---------------------------------------------------------------------------

/**
 * Feeds the camera's yaw to the player, because movement is camera-relative (§6)
 * while the camera follows the player. Running this first means the player uses
 * last tick's yaw — one 16.7 ms tick of lag, which is imperceptible, and it
 * avoids a circular dependency between the two systems.
 */
class CameraLinkSystem implements System {
  readonly name = 'cameraLink';
  private readonly player: PlayerController;
  private readonly rig: CameraRig;

  constructor(player: PlayerController, rig: CameraRig) {
    this.player = player;
    this.rig = rig;
  }

  update(): void {
    this.player.cameraYaw = this.rig.yaw;
  }

  reset(): void {
    this.player.cameraYaw = 0;
  }
}

/**
 * Scripted input override for automated tests. It runs AFTER the device input
 * producers and re-applies only the fields a test explicitly set, so keyboard
 * and touch cannot fight the script — and so a test that overrides nothing
 * still sees real pointer input (which is how the multi-touch check works).
 *
 * NaN means "not overridden"; the boolean tri-state uses -1 for unset.
 */
class InputOverrideSystem implements System {
  readonly name = 'inputOverride';
  moveX = Number.NaN;
  moveY = Number.NaN;
  sprint = -1;
  private readonly input: ReturnType<typeof createInputState>;

  constructor(input: ReturnType<typeof createInputState>) {
    this.input = input;
  }

  update(): void {
    const input = this.input;
    if (!Number.isNaN(this.moveX)) input.moveX = this.moveX;
    if (!Number.isNaN(this.moveY)) input.moveY = this.moveY;
    if (this.sprint >= 0) input.sprint = this.sprint === 1;
  }

  reset(): void {
    this.moveX = Number.NaN;
    this.moveY = Number.NaN;
    this.sprint = -1;
  }
}

/** Drives the avatar from interpolated player state. Allocation-free per frame. */
class AvatarSystem implements System {
  readonly name = 'avatar';
  private readonly avatar: BlockyAvatar;
  private readonly player: PlayerController;
  private readonly state: AvatarState;

  constructor(avatar: BlockyAvatar, player: PlayerController) {
    this.avatar = avatar;
    this.player = player;
    this.state = {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      speed: 0,
      grounded: true,
      state: player.state,
    };
  }

  update(): void {
    /* nothing to simulate — the avatar is presentation only */
  }

  render(alpha: number): void {
    const player = this.player;
    const previous = player.prevPosition;
    const current = player.position;
    const state = this.state;
    state.x = previous.x + (current.x - previous.x) * alpha;
    state.y = previous.y + (current.y - previous.y) * alpha;
    state.z = previous.z + (current.z - previous.z) * alpha;
    state.yaw = player.yaw;
    state.speed = player.speed;
    state.grounded = player.grounded;
    state.state = player.state;
    this.avatar.apply(state, alpha);
  }

  reset(): void {
    this.avatar.reset();
  }

  dispose(): void {
    this.avatar.dispose();
  }
}

// ---------------------------------------------------------------------------
// Debug hook (consumed by tools/smoke.mjs and tools/playtest.mjs)
// ---------------------------------------------------------------------------

interface DebugPlayer {
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: PlayerState;
  speed: number;
  grounded: boolean;
  dashCooldownLeft: number;
  invulnerable: boolean;
}

interface DebugCamera {
  x: number;
  y: number;
  z: number;
  fov: number;
  yaw: number;
  pitch: number;
}

interface ArcanumDebug {
  metrics(): ProfilerMetrics;
  frameCount(): number;
  tickCount(): number;
  elapsed(): number;
  toggleDebug(): boolean;
  setPixelRatio(index: number): number;
  setInput(partial: Record<string, number | boolean>): void;
  clearInput(): void;
  press(button: string): void;
  player(): DebugPlayer;
  camera(): DebugCamera;
  terrainHeightAt(x: number, z: number): number;
  warp(x: number, z: number): void;
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
  const uiRootElement = document.getElementById('ui-root');
  const uiRoot = uiRootElement instanceof HTMLElement ? uiRootElement : document.body;

  if (!(canvas instanceof HTMLCanvasElement)) {
    fail('Canvas element #game-canvas is missing from the page.');
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const debugVisible = params.get('debug') !== '0';

  let engine: Engine;
  try {
    engine = new Engine({ canvas, uiRoot, debug: debugVisible });
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

  // --- world ---------------------------------------------------------------
  const terrain = new TerrainGen({ seed: TERRAIN_SEED });
  const props = new SpatialHash(5);
  const obstacles = buildObstacles(terrain, props);

  engine.scene.add(terrain.mesh, obstacles);

  // Dense exponential fog is what lets the far plane sit at 180 units (§3).
  // SkyDayNight replaces these constants in Phase 2.
  engine.scene.fog = new THREE.FogExp2(0x9fc4d8, 0.012);
  engine.scene.background = new THREE.Color(0x9fc4d8);

  const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x4a5340, 1.0);
  const sun = new THREE.DirectionalLight(0xfff3d8, 1.45);
  sun.position.set(14, 22, 9);
  engine.scene.add(hemi, sun);

  // --- player --------------------------------------------------------------
  const input = createInputState();
  const stats = new PlayerStats();
  const player = new PlayerController({ terrain, props, input, stats, spawnX: 0, spawnZ: 0 });

  const avatar = new BlockyAvatar();
  engine.scene.add(avatar.root);

  const cameraRig = new CameraRig({
    camera: engine.camera,
    target: player,
    terrain,
    props,
    input,
  });

  // --- input + UI ----------------------------------------------------------
  const keyboard = new KeyboardInput(input);
  const override = new InputOverrideSystem(input);
  const touch = new TouchControls({ mount: uiRoot, input, stats, player });
  const hud = new HUD({ mount: uiRoot, stats });

  touch.setSensitivity(0.005);
  cameraRig.setSensitivity(touch.sensitivity);
  cameraRig.setInvertY(touch.invertY);

  // Order matters: link (camera yaw -> player) → device input → scripted
  // override → stats → player → camera → avatar → HUD.
  engine.addSystem(new CameraLinkSystem(player, cameraRig));
  engine.addSystem(keyboard);
  engine.addSystem(touch);
  engine.addSystem(override);
  engine.addSystem(stats);
  engine.addSystem(player);
  engine.addSystem(cameraRig);
  engine.addSystem(new AvatarSystem(avatar, player));
  engine.addSystem(hud);

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

  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'p' || event.key === 'P') toggleDebug();
  });

  canvas.addEventListener('webglcontextlost', (event: Event) => {
    event.preventDefault();
    if (boot !== null) boot.classList.remove('is-gone');
    fail('Graphics context was lost. Reload the page to continue.');
  });

  engine.start();

  // --- debug hook ---------------------------------------------------------
  const debug: ArcanumDebug = {
    metrics: () => {
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
      engine.resolution.setEnabled(false);
      const applied = engine.resolution.setIndex(index);
      engine.resize();
      return applied;
    },

    setInput: (partial: Record<string, number | boolean>) => {
      const moveX = partial['moveX'];
      const moveY = partial['moveY'];
      const sprint = partial['sprint'];
      const lookDX = partial['lookDX'];
      const lookDY = partial['lookDY'];
      if (typeof moveX === 'number') override.moveX = moveX;
      if (typeof moveY === 'number') override.moveY = moveY;
      if (typeof sprint === 'boolean') override.sprint = sprint ? 1 : 0;
      // Look deltas are consumed once per tick by the rig, so they are additive
      // rather than sticky — overriding them would freeze the camera.
      if (typeof lookDX === 'number') input.lookDX += lookDX;
      if (typeof lookDY === 'number') input.lookDY += lookDY;
    },
    clearInput: () => {
      override.reset();
      input.moveX = 0;
      input.moveY = 0;
      input.sprint = false;
    },
    press: (button: string) => {
      const now = performance.now();
      if (button === 'dash') input.dashQueuedAt = now;
      else if (button === 'attack') input.attackQueuedAt = now;
      else {
        const slot = Number.parseInt(button, 10);
        if (slot >= 0 && slot <= 3) input.skillQueuedAt[slot] = now;
      }
    },

    player: () => ({
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      yaw: player.yaw,
      state: player.state,
      speed: player.speed,
      grounded: player.grounded,
      dashCooldownLeft: player.dashCooldownLeft,
      invulnerable: player.invulnerable,
    }),
    camera: () => ({
      x: engine.camera.position.x,
      y: engine.camera.position.y,
      z: engine.camera.position.z,
      fov: engine.camera.fov,
      yaw: cameraRig.yaw,
      pitch: cameraRig.pitch,
    }),
    terrainHeightAt: (x: number, z: number) => terrain.heightAt(x, z),
    warp: (x: number, z: number) => {
      player.position.set(x, terrain.heightAt(x, z), z);
      player.prevPosition.copy(player.position);
      player.velocity.set(0, 0, 0);
    },

    version: VERSION,
  };
  (globalThis as DebugGlobal).__ARCANUM_DEBUG__ = debug;

  const waitForFirstFrames = (): void => {
    if (engine.frameCount >= 2) {
      if (boot !== null) boot.classList.add('is-gone');
      return;
    }
    window.requestAnimationFrame(waitForFirstFrames);
  };
  window.requestAnimationFrame(waitForFirstFrames);

  if (import.meta.env.DEV) {
    console.info('[arcanum] phase 1 online —', VERSION);
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
