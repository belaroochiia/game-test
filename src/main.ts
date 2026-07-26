import * as THREE from 'three';

import { Engine, WebGL2UnsupportedError } from './core/Engine';
import type { System } from './core/Engine';
import type { ProfilerMetrics } from './core/Profiler';

import { HeightField, SEA_LEVEL } from './world/HeightField';
import { BiomeTable, createBiomeSample } from './world/BiomeTable';
import { SpatialHash } from './world/SpatialHash';
import { ChunkManager } from './world/ChunkManager';
import { PropScatter } from './world/PropScatter';
import { SkyDayNight } from './world/SkyDayNight';
import { Water } from './world/Water';

import { createInputState } from './player/InputState';
import { PlayerStats } from './player/PlayerStats';
import { PlayerController } from './player/PlayerController';
import type { PlayerState } from './player/PlayerController';
import { CameraRig } from './player/CameraRig';
import { BlockyAvatar } from './player/PlayerAvatar';
import type { AvatarState } from './player/PlayerAvatar';

import skillsJson from './data/skills.json';
import fusionsJson from './data/fusions.json';
import loadoutJson from './data/loadout.json';
import { SkillRegistry, validateFusions } from './skills/SkillRegistry';
import { Grimoire } from './skills/Grimoire';
import { SkillRuntime } from './skills/SkillRuntime';
import { SkillVfx } from './skills/vfx/SkillVfx';
import { SoulOrbs, setOrbSeed } from './skills/SoulOrbs';
import { StatusEffects, setStatusSeed } from './combat/StatusEffects';
import type { StatusId } from './combat/StatusEffects';
import { GrimoireScreen } from './ui/GrimoireScreen';
import { Notifications } from './ui/Notifications';
import { consumeBufferedSkill } from './player/InputState';

import { TEAM } from './combat/CombatTypes';
import type { Combatant, DamagePacket } from './combat/CombatTypes';
import { Hitstop } from './combat/Hitstop';
import { HitboxSystem } from './combat/HitboxSystem';
import type { HitQuery } from './combat/HitboxSystem';
import { DamageSystem, setSeed as setDamageSeed } from './combat/DamageSystem';
import { TargetLock } from './combat/TargetLock';
import { EnemyBase } from './enemy/EnemyBase';
import { EnemyManager } from './enemy/EnemyManager';
import { DamageNumbers } from './ui/DamageNumbers';

import { KeyboardInput } from './input/KeyboardInput';
import { TouchControls } from './ui/TouchControls';
import { HUD } from './ui/HUD';

import './styles/game-ui.css';

/**
 * Phase 3 bootstrap (CLAUDE.md §12): combat. The streamed world of Phase 2 plus
 * the melee combo, hitstop, damage numbers, a slime camp with readable
 * telegraphs, soft target lock, and death/respawn on both sides.
 *
 * Not here yet, on purpose: skills (Phase 4), the full bestiary and spawn
 * budgets (Phase 5), progression and save (Phase 6).
 */

const VERSION = '0.5.0-phase4';

const WORLD_SEED = 1337;

/**
 * Water plane sizing, corrected from the Phase 2 contract's 700/24 default. At
 * 700 units across 24 segments the vertex spacing is 29 units, so the swell can
 * only resolve a ~175-unit wavelength and reads as a flat sheet. 320/48 gives
 * 6.67-unit spacing, and `setCenter` keeps the plane under the player so the
 * smaller sheet is never noticed.
 */
const WATER_SIZE = 320;
const WATER_SEGMENTS = 48;

// ---------------------------------------------------------------------------
// Systems owned by the bootstrap
// ---------------------------------------------------------------------------

/**
 * Feeds the camera's yaw to the player, because movement is camera-relative (§6)
 * while the camera follows the player. Running this first means the player uses
 * last tick's yaw — one 16.7 ms tick of lag, imperceptible, and it avoids a
 * circular dependency between the two systems.
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
 * Scripted input override for automated tests. Runs AFTER the device input
 * producers and re-applies only the fields a test explicitly set, so keyboard and
 * touch cannot fight the script — and so a test that overrides nothing still sees
 * real pointer input, which is how the touch checks work.
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
    this.state = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, grounded: true, state: player.state };
  }

  update(): void {
    /* presentation only */
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

/**
 * Keeps the water plane under the player and hands the terrain's blended biome
 * fog tint to the sky, so Whisperwood's blue mist (§5) shows up in the fog
 * without the sky and the fog disagreeing at the horizon.
 */
class WorldLinkSystem implements System {
  readonly name = 'worldLink';
  private readonly player: PlayerController;
  private readonly water: Water;
  private readonly chunks: ChunkManager;
  private readonly sky: SkyDayNight;

  constructor(player: PlayerController, water: Water, chunks: ChunkManager, sky: SkyDayNight) {
    this.player = player;
    this.water = water;
    this.chunks = chunks;
    this.sky = sky;
  }

  update(): void {
    const position = this.player.position;
    this.water.setCenter(position.x, position.z);
    this.sky.setBiomeFogTint(this.chunks.fogTint, this.chunks.fogTintWeight);
  }

  reset(): void {
    /* nothing of its own */
  }
}

/**
 * Consumes buffered skill presses (touch and keyboard both queue into
 * InputState) and hands them to the runtime — one consumer, so a press can
 * never double-cast.
 */
class SkillCastSystem implements System {
  readonly name = 'skillCast';
  private readonly input: ReturnType<typeof createInputState>;
  private readonly runtime: SkillRuntime;

  constructor(input: ReturnType<typeof createInputState>, runtime: SkillRuntime) {
    this.input = input;
    this.runtime = runtime;
  }

  update(): void {
    const now = performance.now();
    for (let slot = 0; slot < 4; slot++) {
      if (consumeBufferedSkill(this.input, slot, now)) {
        this.runtime.castSlot(slot);
      }
    }
  }

  reset(): void {
    /* stateless */
  }
}

/** Feeds §6.6's lock into the player's auto-aim each tick. */
class AimLinkSystem implements System {
  readonly name = 'aimLink';
  private readonly player: PlayerController;
  private readonly lock: TargetLock;

  constructor(player: PlayerController, lock: TargetLock) {
    this.player = player;
    this.lock = lock;
  }

  update(): void {
    this.player.aimYaw = this.lock.hasTarget ? this.lock.yawToTarget : Number.NaN;
  }

  reset(): void {
    this.player.aimYaw = Number.NaN;
  }
}

// ---------------------------------------------------------------------------
// Debug hook (consumed by smoke/playtest/worldtest/combattest)
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

interface DebugWorld {
  activeChunks: number;
  visibleChunks: number;
  queuedChunks: number;
  pooledGeometries: number;
  propInstances: number;
  colliders: number;
  seaLevel: number;
  worldSize: number;
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
  biomeAt(x: number, z: number): { weights: number[]; dominant: number };
  setDayPhase(phase: number): void;
  dayPhase(): number;
  world(): DebugWorld;
  enemies(): DebugEnemy[];
  combat(): DebugCombat;
  setDamageSeed(n: number): void;
  spawnSlimes(x: number, z: number, count: number, radius: number): void;
  killAllEnemies(): void;
  skills(): DebugSkillSlot[];
  grimoire(): DebugGrimoire;
  castSlot(slot: number): boolean;
  lastRefusal(): string;
  statusOf(enemyId: number): DebugStatus[];
  learnSkill(id: string): void;
  equipSkill(slot: number, id: string): void;
  setStatusSeed(n: number): void;
  setOrbSeed(n: number): void;
  fuse(a: string, b: string): string | null;
  orbs(): { count: number; nearby: boolean; absorbProgress: number };
  forceAbsorb(active: boolean): void;
  grimoireScreen(): { open: boolean };
  openGrimoire(): void;
  closeGrimoire(): void;
  version: string;
}

interface DebugSkillSlot {
  slot: number;
  id: string | null;
  cooldownLeft: number;
  cooldownFraction: number;
  manaCost: number;
}

interface DebugGrimoire {
  known: string[];
  equipped: (string | null)[];
  mastery: Record<string, { level: number; uses: number }>;
}

interface DebugStatus {
  id: number;
  remaining: number;
  stacks: number;
}

interface DebugEnemy {
  id: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  state: number;
  telegraphing: boolean;
  alive: boolean;
}

interface DebugCombat {
  hitstopActive: boolean;
  hitstopTicksLeft: number;
  comboStage: number;
  lockedTargetId: number;
  playerIFrames: number;
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
  const biomes = new BiomeTable(WORLD_SEED);
  const field = new HeightField({ seed: WORLD_SEED }, biomes);
  const props = new SpatialHash(5);

  // SkyDayNight mutates this instance in place rather than replacing it, so the
  // sky dome and the fog can never disagree at the horizon.
  const fog = new THREE.FogExp2(0x9fc4d8, 0.016);
  engine.scene.fog = fog;

  // §3: exactly one directional light plus a hemisphere fill. No point lights.
  const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x4a5340, 1.0);
  const sun = new THREE.DirectionalLight(0xfff3d8, 1.45);
  sun.position.set(14, 22, 9);
  engine.scene.add(hemi, sun);

  const sky = new SkyDayNight({ scene: engine.scene, sun, hemi, fog });
  engine.scene.add(sky.dome);

  const scatter = new PropScatter({ scene: engine.scene, field, biomes, props });
  for (let i = 0; i < scatter.meshes.length; i++) {
    const mesh = scatter.meshes[i];
    if (mesh !== undefined) engine.scene.add(mesh);
  }

  const water = new Water({ level: SEA_LEVEL, size: WATER_SIZE, segments: WATER_SEGMENTS });
  engine.scene.add(water.mesh);

  // --- player --------------------------------------------------------------
  // Built before the streamer, so ChunkManager can hold the player itself as its
  // target and read the live position every tick without a copy.
  const input = createInputState();
  const stats = new PlayerStats();
  const player = new PlayerController({ terrain: field, props, input, stats, spawnX: 0, spawnZ: 0 });

  const chunks = new ChunkManager({
    scene: engine.scene,
    field,
    biomes,
    camera: engine.camera,
    target: player,
    props: scatter,
  });

  // --- combat (Phase 3) ----------------------------------------------------
  const hitstop = new Hitstop();
  const hitbox = new HitboxSystem();
  const damage = new DamageSystem({ hitstop, bus: engine.bus });
  player.hitstopRef = hitstop;

  /**
   * The player's face in the combat system. PlayerController stays ignorant of
   * combat plumbing; this adapter is the whole coupling.
   */
  const playerCombatant: Combatant = {
    id: 1,
    position: player.position,
    radius: 0.4,
    height: 1.8,
    team: TEAM.Player,
    get alive() {
      return player.alive && stats.hp > 0;
    },
    takeDamage(packet: DamagePacket): number {
      return player.applyDamage(packet.amount, packet.knockX, packet.knockZ);
    },
  };
  hitbox.register(playerCombatant);

  const enemies = new EnemyManager({
    scene: engine.scene,
    field,
    player,
    hitbox,
    damage,
    hitstop,
  });
  // A small camp east of spawn: far enough that nothing aggros at boot (radius
  // 11), close enough that the first fight is under twenty seconds away.
  enemies.spawnSlimes(14, -6, 3, 3.5);

  enemies.freezeRef = {
    isFrozen: (c) => {
      const enemy = findEnemyById(c.id);
      return enemy !== undefined && status.has(enemy, 1 as StatusId);
    },
  };

  const targetLock = new TargetLock({
    scene: engine.scene,
    camera: engine.camera,
    player,
    enemies,
  });

  const damageNumbers = new DamageNumbers({ mount: uiRoot, camera: engine.camera });

  // --- the Grimoire stack (Phase 4) ---------------------------------------
  // Everything below is driven by skills.json; ids live ONLY in JSON (§4.1).
  const registry = new SkillRegistry(skillsJson);
  validateFusions(registry, fusionsJson);
  const grimoire = new Grimoire({
    registry,
    bus: engine.bus,
    startingLoadout: loadoutJson.startingLoadout,
  });
  const status = new StatusEffects({ damage, hitbox, bus: engine.bus });
  status.register(playerCombatant);
  const vfx = new SkillVfx({ scene: engine.scene });
  const runtime = new SkillRuntime({
    registry,
    grimoire,
    stats,
    player,
    playerCombatant,
    hitbox,
    damage,
    status,
    lock: targetLock,
    vfx,
    bus: engine.bus,
  });
  const orbs = new SoulOrbs({ scene: engine.scene, player, grimoire, registry, bus: engine.bus });
  const grimoireScreen = new GrimoireScreen({ mount: uiRoot, registry, grimoire, bus: engine.bus });
  const notifications = new Notifications({ mount: uiRoot, bus: engine.bus, registry, hitstop });

  /** Melee scaling (§9's statScaling term): agility carries the sword. */
  const meleeScaling = (): number => stats.agility * 0.35;

  const strikeQuery: HitQuery = { x: 0, y: 0, z: 0, radius: 0, team: TEAM.Player, sourceId: 1 };
  let strikeBase = 0;
  let strikeHeavy = false;
  let strikeKnockX = 0;
  let strikeKnockZ = 0;
  const onStrikeHit = (target: Combatant): void => {
    const armor = target instanceof EnemyBase ? target.def.armor : 0;
    damage.deal(
      target,
      strikeBase,
      meleeScaling(),
      armor,
      strikeHeavy,
      1,
      strikeKnockX,
      strikeKnockZ,
      target.position.x,
      target.position.y + target.height * 0.7,
      target.position.z,
    );
  };
  player.onStrike = (_stage, x, y, z, radius, base, heavy, knockX, knockZ) => {
    strikeQuery.x = x;
    strikeQuery.y = y;
    strikeQuery.z = z;
    strikeQuery.radius = radius;
    strikeBase = base;
    strikeHeavy = heavy;
    strikeKnockX = knockX;
    strikeKnockZ = knockZ;
    hitbox.overlapSphere(strikeQuery, onStrikeHit);
  };

  const avatar = new BlockyAvatar();
  engine.scene.add(avatar.root);

  const cameraRig = new CameraRig({
    camera: engine.camera,
    target: player,
    terrain: field,
    props,
    input,
  });

  const findEnemyById = (id: number): EnemyBase | undefined => {
    const all = enemies.enemies;
    for (let i = 0; i < all.length; i++) {
      const enemy = all[i];
      if (enemy !== undefined && enemy.id === id) return enemy;
    }
    return undefined;
  };

  // Damage fan-out: numbers always; trauma and haptics scale with weight, and
  // getting hit shakes harder than dealing (§7's trauma-based shake). DoT ticks
  // are silent: numbers show, but no trauma, no haptics (§8.5).
  const canBuzz = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  damage.onDamage((event) => {
    damageNumbers.spawn(
      event.packet.hitX,
      event.packet.hitY,
      event.packet.hitZ,
      event.applied,
      event.packet.crit,
      event.packet.heavy,
    );
    if (event.silent) return;
    if (event.target === playerCombatant) {
      cameraRig.addTrauma(0.4);
    } else {
      cameraRig.addTrauma(event.packet.heavy ? 0.28 : 0.1);
      if (canBuzz) navigator.vibrate(10); // §6.7
    }
    // §8.2.1: a kill may leave a soul orb. Status boards follow the corpse.
    if (event.killed && event.target !== playerCombatant) {
      orbs.maybeDrop(
        event.target.position.x,
        event.target.position.y + 0.6,
        event.target.position.z,
        0.5,
        event.target.id,
      );
    }
  });

  // Status boards for everything that fights. Enemies register as they spawn;
  // Phase 4's fixed camp registers here, and spawnSlimes via debug re-registers.
  const registerEnemyBoards = (): void => {
    const all = enemies.enemies;
    for (let i = 0; i < all.length; i++) {
      const enemy = all[i];
      if (enemy !== undefined) status.register(enemy);
    }
  };
  registerEnemyBoards();

  // Build the spawn neighbourhood before the first frame, behind the loading
  // screen — this is the one place a build burst is allowed (§12: no stutter).
  chunks.primeAround(player.position.x, player.position.z);
  player.reset();

  // --- input + UI ----------------------------------------------------------
  const keyboard = new KeyboardInput(input);
  const override = new InputOverrideSystem(input);
  const touch = new TouchControls({ mount: uiRoot, input, stats, player });
  const hud = new HUD({ mount: uiRoot, stats });

  touch.skillsRef = runtime;
  touch.orbsRef = orbs;

  touch.setSensitivity(0.005);
  cameraRig.setSensitivity(touch.sensitivity);
  cameraRig.setInvertY(touch.invertY);

  // Order: link → device input → scripted override → stats → player → streaming
  // → camera → avatar → world links → HUD. Streaming runs after the player moves
  // so it always windows on this tick's position.
  // Hitstop must tick first so gated systems see a fresh freeze state (§9).
  engine.addSystem(hitstop);
  engine.addSystem(new CameraLinkSystem(player, cameraRig));
  engine.addSystem(keyboard);
  engine.addSystem(touch);
  engine.addSystem(override);
  engine.addSystem(stats);
  engine.addSystem(player);
  engine.addSystem(enemies);
  engine.addSystem(hitbox);
  engine.addSystem(damage);
  engine.addSystem(status);
  engine.addSystem(new SkillCastSystem(input, runtime));
  engine.addSystem(runtime);
  engine.addSystem(orbs);
  engine.addSystem(targetLock);
  engine.addSystem(new AimLinkSystem(player, targetLock));
  engine.addSystem(chunks);
  engine.addSystem(scatterSystemFor(scatter));
  engine.addSystem(cameraRig);
  engine.addSystem(new AvatarSystem(avatar, player));
  engine.addSystem(water);
  engine.addSystem(sky);
  engine.addSystem(new WorldLinkSystem(player, water, chunks, sky));
  engine.addSystem(damageNumbers);
  engine.addSystem(notifications);
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

  // The HUD's book icon opens the Grimoire (Phase 4). It was aria-disabled
  // chrome until now; the screen exists, so it becomes live.
  const grimoireButton = uiRoot.querySelector('[data-action="grimoire"]');
  if (grimoireButton instanceof HTMLButtonElement) {
    grimoireButton.removeAttribute('aria-disabled');
    grimoireButton.addEventListener('click', () => {
      if (grimoireScreen.isOpen) grimoireScreen.close();
      else grimoireScreen.open();
    });
  }

  engine.start();

  // --- debug hook ---------------------------------------------------------
  const biomeScratch = createBiomeSample();

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
    terrainHeightAt: (x: number, z: number) => field.heightAt(x, z),
    warp: (x: number, z: number) => {
      player.position.set(x, field.heightAt(x, z), z);
      player.prevPosition.copy(player.position);
      player.velocity.set(0, 0, 0);
      // Streaming is incremental by design, so a teleport needs an explicit prime
      // or the player would stand over unbuilt chunks for several frames.
      chunks.primeAround(x, z);
    },

    biomeAt: (x: number, z: number) => {
      biomes.sample(x, z, biomeScratch);
      // A fresh array: this crosses the CDP boundary and must be serialisable.
      return { weights: biomeScratch.weights.slice(), dominant: biomeScratch.dominant };
    },
    setDayPhase: (phase: number) => {
      sky.setPhase(phase);
    },
    dayPhase: () => sky.phase,
    world: () => ({
      activeChunks: chunks.activeCount,
      visibleChunks: chunks.visibleCount,
      queuedChunks: chunks.queuedCount,
      pooledGeometries: chunks.pooledCount,
      propInstances: scatter.instanceCount,
      colliders: scatter.collidersRegistered,
      seaLevel: SEA_LEVEL,
      worldSize: field.worldSize,
    }),

    enemies: () => {
      // Fresh objects: this crosses the CDP boundary and must be serialisable.
      const list: DebugEnemy[] = [];
      const all = enemies.enemies;
      for (let i = 0; i < all.length; i++) {
        const enemy = all[i];
        if (enemy === undefined) continue;
        list.push({
          id: enemy.id,
          kind: enemy.def.kind,
          x: enemy.position.x,
          y: enemy.position.y,
          z: enemy.position.z,
          hp: enemy.hp,
          maxHp: enemy.def.maxHp,
          state: enemy.brain.state,
          telegraphing: enemy.brain.telegraphing,
          alive: enemy.alive,
        });
      }
      return list;
    },
    combat: () => ({
      hitstopActive: hitstop.active,
      hitstopTicksLeft: hitstop.ticksLeft,
      comboStage: player.comboStage,
      lockedTargetId: targetLock.target !== null ? targetLock.target.id : -1,
      playerIFrames: player.iframesLeft,
    }),
    setDamageSeed: (n: number) => {
      setDamageSeed(n);
    },
    spawnSlimes: (x: number, z: number, count: number, radius: number) => {
      enemies.spawnSlimes(x, z, count, radius);
    },
    killAllEnemies: () => {
      enemies.killAll();
    },

    skills: () => {
      const list: DebugSkillSlot[] = [];
      for (let slot = 0; slot < 4; slot++) {
        const def = runtime.skillAt(slot);
        list.push({
          slot,
          id: def !== null ? def.id : null,
          cooldownLeft: runtime.cooldownSeconds(slot),
          cooldownFraction: runtime.cooldownFraction(slot),
          manaCost: runtime.manaCost(slot),
        });
      }
      return list;
    },
    grimoire: () => {
      const known: string[] = [];
      const mastery: Record<string, { level: number; uses: number }> = {};
      const all = registry.all;
      for (let i = 0; i < all.length; i++) {
        const def = all[i];
        if (def === undefined || !grimoire.isKnown(def.id)) continue;
        known.push(def.id);
        const info = grimoire.mastery(def.id);
        mastery[def.id] = { level: info.level, uses: info.uses };
      }
      const equipped: (string | null)[] = [];
      for (let slot = 0; slot < 4; slot++) equipped.push(grimoire.equipped(slot));
      return { known, equipped, mastery };
    },
    castSlot: (slot: number) => runtime.castSlot(slot),
    lastRefusal: () => runtime.lastRefusal,
    statusOf: (enemyId: number) => {
      const enemy = findEnemyById(enemyId);
      const list: DebugStatus[] = [];
      if (enemy === undefined) return list;
      for (let id = 0; id < 6; id++) {
        const state = status.get(enemy, id as StatusId);
        if (state !== null && state.remaining > 0) {
          list.push({ id, remaining: state.remaining, stacks: state.stacks });
        }
      }
      return list;
    },
    learnSkill: (id: string) => {
      grimoire.learn(id, 'debug');
    },
    equipSkill: (slot: number, id: string) => {
      grimoire.equip(slot, id);
    },
    setStatusSeed: (n: number) => {
      setStatusSeed(n);
    },
    setOrbSeed: (n: number) => {
      setOrbSeed(n);
    },
    fuse: (a: string, b: string) => grimoire.fuse(a, b),
    orbs: () => ({
      count: orbs.liveOrbCount,
      nearby: orbs.nearbyOrb,
      absorbProgress: orbs.absorbProgress,
    }),
    forceAbsorb: (active: boolean) => {
      orbs.setAbsorbing(active);
    },
    grimoireScreen: () => ({ open: grimoireScreen.isOpen }),
    openGrimoire: () => {
      grimoireScreen.open();
    },
    closeGrimoire: () => {
      grimoireScreen.close();
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
    console.info('[arcanum] phase 2 online —', VERSION);
  }
}

/**
 * PropScatter is driven by ChunkManager's enter/leave callbacks rather than by a
 * per-frame update, so it is not a System. This adapter exists only so its
 * `reset()` participates in `engine.reset()`.
 */
function scatterSystemFor(scatter: PropScatter): System {
  return {
    name: 'props',
    update: () => {
      /* driven by ChunkManager */
    },
    reset: () => {
      scatter.clear();
    },
    dispose: () => {
      scatter.dispose();
    },
  };
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
