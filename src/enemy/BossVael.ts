import * as THREE from 'three';

import type { Combatant, DamagePacket } from '../combat/CombatTypes';
import { TEAM } from '../combat/CombatTypes';
import type { DamageSystem } from '../combat/DamageSystem';
import type { HitboxSystem, HitQuery } from '../combat/HitboxSystem';
import type { ReactionEvent } from '../combat/StatusEffects';
import type { EventBus } from '../core/EventBus';
import type { PlayerController } from '../player/PlayerController';
import type { Grimoire } from '../skills/Grimoire';
import type { SkillRegistry } from '../skills/SkillRegistry';
import type { ElementId } from '../skills/SkillTypes';
import type { HeightSampler } from '../world/HeightField';
import { SPIRE_PLATEAU_RADIUS, SPIRE_PLATEAU_X, SPIRE_PLATEAU_Z } from '../world/HeightField';
import { AIBrain } from './AIBrain';
import type { EnemyProjectiles } from './ArchetypeEnemy';
import { EnemyBase } from './EnemyBase';
import type { EnemyDef } from './EnemyDefs';
import type { FreezeSource } from './EnemyManager';
import { EnemyVisual, createEnemyPose } from './EnemyVisual';
import type { EnemyPose } from './EnemyVisual';

/**
 * Archmage Vael — the Hollow Spire boss (§9), and the game's teacher of §8.5.
 *
 * §4.1 SCOPE NOTE, stated as the contract demands: §4.1's law covers SKILLS and
 * ENEMY KINDS — repeatable content classes. Vael is neither: he is ONE scripted
 * encounter, like a quest beat. Every number that shapes the fight therefore
 * lives in the constants block below, in this file, on purpose. The one §4.1
 * boundary that still applies is honored: the reward skill is found by its
 * `bossReward` marker in skills.json — no skill id appears here — and
 * 'archmage_vael' is not an enemies.json kind, so the kind-grep stays clean.
 *
 * The teaching mechanic (§9: "1 mekanik yang mengajarkan pemain sesuatu"):
 * from Phase 2 of the fight Vael raises a 3-layer void shield. While ANY layer
 * is up, plain damage lands at ×0.15 — the damage numbers themselves show the
 * futility. The ONLY thing that strips a layer is a §8.5 element reaction ON
 * VAEL (Shatter, Conflagration, Thermal Shock, Deep Freeze, Overload — any of
 * the five). Detection is exact, not heuristic: StatusEffects emits
 * 'combat:reaction' synchronously from reactionFor, immediately BEFORE the
 * triggering hit's deal, with the target's own position — so the handler
 * matches the event position against Vael's and, on a match, strips a layer
 * and arms a one-hit grace so the reaction's own hit lands UNDAMPENED. The
 * strip is the reward; the full-size number is the receipt. In Phase 3 the
 * shield refreshes exactly ONCE — the lesson is examined a second time, then
 * the fight lets you finish.
 *
 * Lifecycle: constructed by the bootstrap, adopted via EnemyManager.spawnBoss
 * — so hitstop gating, despawn hysteresis, status boards, TargetLock and the
 * interpolated render path all apply unchanged. The vestigial AIBrain the
 * base class owns is swapped for an inert VaelBrain (state pinned to Idle) so
 * this file's phase FSM is the only mind in the body.
 *
 * DORMANT = INVULNERABLE: takeDamage returns 0 until the player steps inside
 * TRIGGER_RADIUS of the arena heart. This also means the debug killAll() does
 * not kill a dormant Vael — the gate drives the fight through the scripted
 * path (warp in, engage, react, kill), which is the honest test anyway.
 *
 * HUD surface for the integrator's boss bar (the contract's boss() debug):
 *   hp / maxHp / phase / shieldLayers / fightActive
 * (EnemyBase.active already means §9's despawn hysteresis, so the "show the
 * bar" flag is named fightActive — map it to the debug surface's `active`.)
 */

// -----------------------------------------------------------------------------
// The fight, in constants (scripted content — see the §4.1 scope note above)
// -----------------------------------------------------------------------------

/** Arena heart = the HeightField plateau (agent A guarantees it; one source). */
const ARENA_X = SPIRE_PLATEAU_X;
const ARENA_Z = SPIRE_PLATEAU_Z;
/** Vael keeps his drift inside the plateau's dead-flat disc. */
const ARENA_KEEP_RADIUS = SPIRE_PLATEAU_RADIUS - 2;
/** Contract: player within 20 u of (0, 255) starts the fight. */
const TRIGGER_RADIUS = 20;
/** Player farther than this from the heart aborts the fight (full reset). */
const LEASH_RADIUS = 34;

/** §5 Hollow Spire palette: dark purple body, magenta accent. */
const VAEL_BODY_COLOR = 0x2b1846;
const VAEL_ACCENT_COLOR = 0xe14dff;
const SHIELD_COLOR = 0xb45cff;
const PILLAR_COLOR = 0x241238;

const P2_HP_FRACTION = 0.66;
const P3_HP_FRACTION = 0.33;
const SHIELD_LAYERS = 3;
/** The teaching number: plain damage lands at ×0.15 while any layer is up. */
const SHIELD_DAMAGE_MULT = 0.15;
/** P3's "faster telegraphs" — scaled, then clamped to §9's absolute floor. */
const P3_TELEGRAPH_SCALE = 0.72;
/** §9: every wind-up readable on a phone. NEVER undercut, any phase. */
const MIN_TELEGRAPH_SECONDS = 0.5;

/** Volley: ring pulse on the caster, then 3 fanned shots (shared pool). */
const VOLLEY_TELEGRAPH = 0.9;
const VOLLEY_SHOTS = 3;
const VOLLEY_INTERVAL = 0.18;
const VOLLEY_FAN_RADIANS = 0.24;
const VOLLEY_DAMAGE = 16;
const VOLLEY_SPEED = 14;
/** Lunge: ground ring on the landing point, then a committed dash-strike. */
const LUNGE_TELEGRAPH = 0.7; // ×0.72 = 0.504 — still over the §9 floor
const LUNGE_RANGE = 4.5;
const LUNGE_SECONDS = 0.28;
const LUNGE_DAMAGE = 24;
const LUNGE_HIT_RADIUS = 1.9;
const LUNGE_KNOCK = 7;
/** Charge (P2+): full-lane strip, then a line rush that stops on contact. */
const CHARGE_TELEGRAPH = 0.85;
const CHARGE_SPEED = 16;
const CHARGE_RANGE = 16;
const CHARGE_DAMAGE = 30;
const CHARGE_KNOCK = 10;
const CHARGE_HIT_PAD = 0.5;
/** Slam rings (P3): disc at the feet, then an annulus wave — dash IN to dodge. */
const SLAM_TELEGRAPH = 1.0;
const SLAM_INNER_RADIUS = 4.2;
const SLAM_OUTER_RADIUS = 8.0;
const SLAM_WAVE_GAP = 0.45;
const SLAM_DAMAGE = 26;
const SLAM_KNOCK = 8;

/** Seconds of drift between attacks, per phase (index = phase − 1). */
const CHOOSE_GAP: readonly [number, number, number] = [1.6, 1.15, 0.85];
const RECOVER_SECONDS = 0.7;
/** A breath between the bar appearing and the first wind-up. */
const ENGAGE_DELAY = 0.9;

/** Drift band while choosing: close in past MAX, back off inside MIN, else strafe. */
const DRIFT_MAX_DIST = 11;
const DRIFT_MIN_DIST = 5;

const VAEL_MAX_HP = 2400;
const VAEL_ARMOR = 60;
const VAEL_CONTACT_DAMAGE = 12;
const VAEL_MOVE_SPEED = 3.4;
const VAEL_XP = 400;
/** Boss mass: incoming knock impulses are scaled down by this. */
const KNOCK_RESIST = 0.25;

/** Below the manager's 100+ enemy id stream, above the player's low ids. */
const DEFAULT_BOSS_ID = 90;
const VAEL_SEED = 0x5e11;

/** Wraith capsule proportions at scale 1 (ArchetypeEnemy's table) × this scale. */
const VAEL_SCALE = 2.2;
const WRAITH_CAPSULE_RADIUS = 0.42;
const WRAITH_CAPSULE_HEIGHT = 1.5;

/** Telegraph craft — Phase 3's values, kept identical on purpose. */
const RING_LIFT = 0.05;
const RING_MIN_SCALE = 0.06;
const STRIP_LIFT = 0.1;
/** Shots aim at the player's chest from the caster's hand height. */
const MUZZLE_HEIGHT = 0.65;
const TARGET_CHEST_HEIGHT = 1.0;
/** Facing turn rate (shortest-arc exponential, house style). */
const TURN_K = 9;
const PLAYER_ARMOR = 0; // §10's gear lands in Phase 6

/** Shield shell look: dims per remaining layer (§9 readability). */
const SHIELD_SHELL_RADIUS = 1.55;
const SHIELD_SHELL_HEIGHT = 1.75;
const SHIELD_OPACITY_PER_LAYER = 0.09;
const SHIELD_OPACITY_BASE = 0.1;

/** Arena dressing: 8 monoliths, merged into ONE geometry = one draw call. */
const PILLAR_COUNT = 8;
const PILLAR_RING_RADIUS = 15;

/**
 * The synthetic def. NOT an enemies.json entry (the boss is scripted content);
 * it exists so EnemyBase and EnemyVisual — both built to be driven by a def —
 * plug in unchanged. aggroRadius 0 keeps even a live AIBrain from ever
 * aggroing; the inert VaelBrain makes that double-safe. resists/weakTo are
 * declared for the integrator's element lookup should it generalize past
 * `instanceof ArchetypeEnemy` (see elementMultiplierFor below).
 */
const VAEL_DEF: EnemyDef = Object.freeze({
  kind: 'archmage_vael',
  archetype: 'wraith',
  palette: Object.freeze({ body: VAEL_BODY_COLOR, accent: VAEL_ACCENT_COLOR }),
  scale: VAEL_SCALE,
  maxHp: VAEL_MAX_HP,
  armor: VAEL_ARMOR,
  element: 'dark',
  resists: Object.freeze<ElementId[]>(['dark']),
  weakTo: Object.freeze<ElementId[]>(['light']),
  contactDamage: VAEL_CONTACT_DAMAGE,
  moveSpeed: VAEL_MOVE_SPEED,
  aggroRadius: 0,
  attack: Object.freeze({
    kind: 'ranged' as const,
    damage: VOLLEY_DAMAGE,
    telegraphSeconds: VOLLEY_TELEGRAPH,
    recoverSeconds: RECOVER_SECONDS,
    projectileSpeed: VOLLEY_SPEED,
  }),
  biomes: Object.freeze([4]),
  budgetCost: 1,
  skillDropChance: 0,
  respawnSeconds: 9999, // moot: readyToRespawn is overridden to false
  xp: VAEL_XP,
  attackRadius: 0,
  telegraphSeconds: VOLLEY_TELEGRAPH,
  attackRecoverSeconds: RECOVER_SECONDS,
});

// -----------------------------------------------------------------------------
// Fight FSM vocabulary
// -----------------------------------------------------------------------------

const FIGHT = { Dormant: 0, Choose: 1, Telegraph: 2, Execute: 3, Recover: 4, Dead: 5 } as const;
type FightState = (typeof FIGHT)[keyof typeof FIGHT];

/** Indexed by FightState — debug surface, allocation-free. */
const FIGHT_NAMES = ['Dormant', 'Choose', 'Telegraph', 'Execute', 'Recover', 'Dead'] as const;

const ATTACK = { Volley: 0, Lunge: 1, Charge: 2, Slam: 3 } as const;
type AttackId = (typeof ATTACK)[keyof typeof ATTACK];
const ATTACK_NAMES = ['Volley', 'Lunge', 'Charge', 'Slam'] as const;

/**
 * The inert mind. The base class hard-constructs an AIBrain; this replaces it
 * so the manager's brain-step calls land on a no-op and the state stays Idle
 * forever (Idle: no PATROL speed scale, no auto-facing, no strikes). The boss
 * FSM in BossVael.update is the only thing that moves the body.
 */
class VaelBrain extends AIBrain {
  override step(): void {
    // Deliberately empty — and deliberately NOT zeroing the out vector:
    // desiredMove is written by the boss FSM every tick after this runs.
  }

  override consumeStrike(): boolean {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Boot-time geometry helpers (allocation here is fine; §3 is per-frame)
// -----------------------------------------------------------------------------

const bakeColor = new THREE.Color();

/** EnemyVisual's per-face jitter craft, restated (its helper is module-private). */
function bakePillarColors(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const nonIndexed = geometry.index !== null ? geometry.toNonIndexed() : geometry;
  if (nonIndexed !== geometry) geometry.dispose();
  const positions = nonIndexed.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  bakeColor.setHex(hex);
  for (let i = 0; i < positions.count; i++) {
    const face = (i / 3) | 0;
    const hash = ((Math.imul(face + 1, 2654435761) >>> 16) & 255) / 255;
    const jitter = 0.88 + hash * 0.24;
    colors[i * 3] = bakeColor.r * jitter;
    colors[i * 3 + 1] = bakeColor.g * jitter;
    colors[i * 3 + 2] = bakeColor.b * jitter;
  }
  nonIndexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  nonIndexed.computeVertexNormals();
  return nonIndexed;
}

/** Deterministic per-pillar variance. */
function pillarHash(i: number, salt: number): number {
  return (((Math.imul(i * 31 + salt + 1, 2654435761) >>> 13) & 1023) / 1023);
}

/** 8 tilted monoliths on the plateau ring, merged into one 96-tri geometry. */
function buildArenaGeometry(field: HeightSampler): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < PILLAR_COUNT; i++) {
    const angle = (i / PILLAR_COUNT) * Math.PI * 2 + (pillarHash(i, 7) - 0.5) * 0.18;
    const x = ARENA_X + Math.sin(angle) * PILLAR_RING_RADIUS;
    const z = ARENA_Z + Math.cos(angle) * PILLAR_RING_RADIUS;
    const h = 4.6 + pillarHash(i, 13) * 2.6;
    const w = 1.0 + pillarHash(i, 29) * 0.5;
    const box = bakePillarColors(new THREE.BoxGeometry(w, h, w), PILLAR_COLOR);
    box.rotateZ((pillarHash(i, 41) - 0.5) * 0.12); // ruin lean
    box.rotateY(angle + pillarHash(i, 53) * 0.8);
    // Sunk 0.3 so the lean can never float a corner off the plateau.
    box.translate(x, field.heightAt(x, z) + h * 0.5 - 0.3, z);
    parts.push(box);
  }
  // Manual merge (all parts are non-indexed with identical attributes).
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part !== undefined) total += part.getAttribute('position').count;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    const p = part.getAttribute('position');
    pos.set(p.array as Float32Array, offset * 3);
    nor.set(part.getAttribute('normal').array as Float32Array, offset * 3);
    col.set(part.getAttribute('color').array as Float32Array, offset * 3);
    offset += p.count;
    part.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return merged;
}

// Module scratch — §13: nothing allocated per tick.
const scratchQuery: HitQuery = { x: 0, y: 0, z: 0, radius: 0, team: TEAM.Enemy, sourceId: 0 };

export interface BossVaelOptions {
  scene: THREE.Scene;
  field: HeightSampler;
  player: PlayerController;
  hitbox: HitboxSystem;
  damage: DamageSystem;
  /** THE shared slab — EnemyManager.sharedProjectiles(); never a second pool. */
  projectiles: EnemyProjectiles;
  bus: EventBus;
  grimoire: Grimoire;
  registry: SkillRegistry;
  /** StatusEffects-backed; same contract as EnemyManager.freezeRef. */
  freeze?: FreezeSource | null;
  id?: number;
}

export class BossVael extends EnemyBase {
  readonly radius = WRAITH_CAPSULE_RADIUS * VAEL_SCALE;
  readonly height = WRAITH_CAPSULE_HEIGHT * VAEL_SCALE;
  readonly root: THREE.Object3D;

  private readonly scene: THREE.Scene;
  private readonly player: PlayerController;
  private readonly hitboxSys: HitboxSystem;
  private readonly damageSys: DamageSystem;
  private readonly projectiles: EnemyProjectiles;
  private readonly grimoire: Grimoire;
  private readonly registry: SkillRegistry;
  private readonly freeze: FreezeSource | null;
  private readonly unsubReaction: () => void;

  private readonly visual: EnemyVisual;
  private readonly pose: EnemyPose;
  private readonly ringMain: THREE.Mesh;
  private readonly ringOuter: THREE.Mesh;
  private readonly strip: THREE.Mesh;
  private readonly shell: THREE.Mesh;
  private readonly shellMaterial: THREE.MeshBasicMaterial;
  private readonly arenaMesh: THREE.Mesh;
  private readonly arenaMaterial: THREE.MeshLambertMaterial;

  // --- fight state -----------------------------------------------------------
  private fight: FightState = FIGHT.Dormant;
  private stateTimer = 0;
  private attackKind: AttackId = ATTACK.Volley;
  private telegraphTotal = 1;
  /** Committed at telegraph start — dodgeable (§9), like every enemy. */
  private aimDirX = 0;
  private aimDirZ = 1;
  private executeElapsed = 0;
  private volleyFired = 0;
  private lungeLeft = 0;
  private chargeLeft = 0;
  private slamWavePending = false;
  private slamWaveTimer = 0;
  private phaseNum = 1;
  private shieldCount = 0;
  private shieldRefreshed = false;
  /** One-hit grace armed by a reaction strip: that hit lands undampened. */
  private reactionGrace = false;
  /** Presentation: shield pop on strip/refresh. Sim time, freezes with hitstop. */
  private stripFlash = 0;
  private strafeSign = 1;
  private strafeTimer = 0;
  private rng = VAEL_SEED;
  /** facePlayerHint copy — volley pitch aiming, drift steering. */
  private targetX = 0;
  private targetZ = 0;
  /** Annulus context for the pre-bound slam visitor (§13: no closures). */
  private hitMinRadius = 0;
  private hitDamage = 0;
  private hitKnock = 0;
  private hitAlongX = 0;
  private hitAlongZ = 0;
  private hitRadial = true;
  private hitLanded = 0;
  /** Presentation clock (shell swirl only — never gameplay). */
  private shellClock = 0;
  private lastNow = 0;

  constructor(options: BossVaelOptions) {
    super({
      id: options.id ?? DEFAULT_BOSS_ID,
      def: VAEL_DEF,
      field: options.field,
      homeX: ARENA_X,
      homeZ: ARENA_Z,
      seed: VAEL_SEED,
    });
    this.scene = options.scene;
    this.player = options.player;
    this.hitboxSys = options.hitbox;
    this.damageSys = options.damage;
    this.projectiles = options.projectiles;
    this.grimoire = options.grimoire;
    this.registry = options.registry;
    this.freeze = options.freeze ?? null;

    // Swap the base's AIBrain for the inert VaelBrain. `brain` is readonly at
    // compile time (nothing else may ever reassign it); at runtime it is a
    // plain property, and this constructor is the one sanctioned writer.
    (this as unknown as { brain: AIBrain }).brain = new VaelBrain(VAEL_DEF, VAEL_SEED);

    // Body: the wraith archetype at max contract scale in Spire colours. A
    // bespoke rig was considered and rejected — EnemyVisual's craft (shared
    // materials, refcounted geometry, proven hover animation) is exactly §5's
    // "cheapest thing that reads", and the silhouette is carried by scale,
    // palette, the void shell and the monolith ring instead of new triangles.
    this.visual = new EnemyVisual(VAEL_DEF);
    this.pose = createEnemyPose();
    this.root = this.visual.root;
    this.ringMain = this.visual.makeTelegraphRing();
    this.ringOuter = this.visual.makeTelegraphRing();
    this.strip = this.visual.makeTelegraphStrip();
    this.root.position.copy(this.position);

    // The reaction shield shell — additive, dims per remaining layer (§9:
    // the state must be READABLE, not implied). Own material because its
    // opacity animates; everything else reuses EnemyVisual's shared pair.
    this.shellMaterial = new THREE.MeshBasicMaterial({
      color: SHIELD_COLOR,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.shell = new THREE.Mesh(new THREE.IcosahedronGeometry(SHIELD_SHELL_RADIUS, 1), this.shellMaterial);
    this.shell.position.y = SHIELD_SHELL_HEIGHT;
    this.shell.visible = false;
    this.shell.renderOrder = 3;
    this.root.add(this.shell);

    // Arena dressing: one merged mesh, one draw call, placed once — the ring
    // of monoliths is world furniture and survives the fight's outcomes.
    this.arenaMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.arenaMesh = new THREE.Mesh(buildArenaGeometry(options.field), this.arenaMaterial);
    this.arenaMesh.name = 'vaelArena';
    this.scene.add(this.arenaMesh);

    this.unsubReaction = options.bus.on('combat:reaction', this.onReaction);
  }

  // --- HUD / debug surface ----------------------------------------------------

  /** Show the boss bar? (EnemyBase.active is §9's despawn flag — this is not it.) */
  get fightActive(): boolean {
    return this.alive && this.fight !== FIGHT.Dormant;
  }

  get maxHp(): number {
    return VAEL_DEF.maxHp;
  }

  /** 1..3. Advances on hp thresholds, resets with the fight. */
  get phase(): number {
    return this.phaseNum;
  }

  get shieldLayers(): number {
    return this.shieldCount;
  }

  /** For the debug surface; tuple-indexed, allocation-free. */
  get fightStateName(): string {
    return FIGHT_NAMES[this.fight];
  }

  get currentAttackName(): string {
    return ATTACK_NAMES[this.attackKind];
  }

  /** True through a wind-up — the gate measures §9's floor against this. */
  get telegraphing(): boolean {
    return this.alive && this.fight === FIGHT.Telegraph;
  }

  // --- element table (mirrors ArchetypeEnemy so the integrator's lookup CAN
  // generalize; today SkillRuntime checks `instanceof ArchetypeEnemy`, so the
  // boss takes ×1.0 from all elements — noted in the phase report) -------------

  get element(): ElementId | 'none' {
    return VAEL_DEF.element;
  }

  elementMultiplierFor(element: ElementId): number {
    if (VAEL_DEF.weakTo.indexOf(element) >= 0) return 1.5;
    if (VAEL_DEF.resists.indexOf(element) >= 0) return 0.5;
    return 1;
  }

  /** The boss never self-respawns; reset() (manager-wide) revives it. */
  override get readyToRespawn(): boolean {
    return false;
  }

  override facePlayerHint(x: number, z: number): void {
    super.facePlayerHint(x, z);
    this.targetX = x;
    this.targetZ = z;
  }

  /**
   * The teaching wrapper. Dormant → invulnerable (the fight starts at the
   * threshold, not from a sniped first hit). Shielded → the packet's FINAL
   * amount is scaled by ×0.15 unless a reaction just stripped a layer (grace):
   * the scratch mutation is DELIBERATE — DamageSystem's listeners (damage
   * numbers) see the dampened value, and those tiny numbers ARE the lesson.
   * Knock impulses are scaled by boss mass in all states.
   */
  override takeDamage(packet: DamagePacket): number {
    if (!this.alive) return 0;
    if (this.fight === FIGHT.Dormant) return 0;
    if (this.shieldCount > 0 && !this.reactionGrace) {
      packet.amount *= SHIELD_DAMAGE_MULT;
    }
    this.reactionGrace = false;
    packet.knockX *= KNOCK_RESIST;
    packet.knockZ *= KNOCK_RESIST;
    return super.takeDamage(packet);
  }

  // --- tick --------------------------------------------------------------------

  override update(dt: number): void {
    if (!this.alive) {
      super.update(dt); // corpse bookkeeping; the collapse rides deadFor
      return;
    }
    const frozen = this.freeze !== null && this.freeze.isFrozen(this);
    if (frozen) {
      // §8.5 parity with the manager's rule for ordinary enemies: a frozen
      // boss neither thinks nor moves, and his timers HOLD — freeze can never
      // be used to skip a telegraph, nor to fast-forward one.
      this.desiredMove.set(0, 0);
    } else {
      this.stepFight(dt);
    }
    super.update(dt);
    if (!frozen && this.alive) this.stepScripted(dt);
    this.faceFight(dt);
    if (this.stripFlash > 0) {
      this.stripFlash -= dt * 3;
      if (this.stripFlash < 0) this.stripFlash = 0;
    }
    // Grace is consumed synchronously by the reaction's own hit (reactionFor →
    // deal → takeDamage share one call stack); anything still armed here is a
    // leak (i-framed edge) and must not discount a later unrelated hit.
    this.reactionGrace = false;
  }

  // --- the fight FSM -------------------------------------------------------------

  private stepFight(dt: number): void {
    const player = this.player;
    const playerAlive = player.statsRef.hp > 0;
    const pdx = player.position.x - ARENA_X;
    const pdz = player.position.z - ARENA_Z;
    const playerArenaDistSq = pdx * pdx + pdz * pdz;

    if (this.fight === FIGHT.Dormant) {
      this.driftHome();
      if (playerAlive && playerArenaDistSq <= TRIGGER_RADIUS * TRIGGER_RADIUS) {
        this.fight = FIGHT.Choose;
        this.stateTimer = ENGAGE_DELAY;
      }
      return;
    }
    if (this.fight === FIGHT.Dead) return;

    // Fled or died: the whole encounter rewinds (full hp, shield state, home).
    if (!playerAlive || playerArenaDistSq > LEASH_RADIUS * LEASH_RADIUS) {
      this.reset();
      return;
    }

    this.checkPhases();

    switch (this.fight) {
      case FIGHT.Choose: {
        this.driftCombat(dt);
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) this.beginTelegraph();
        break;
      }
      case FIGHT.Telegraph: {
        this.desiredMove.set(0, 0); // planted: the wind-up is the promise
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) this.beginExecute();
        break;
      }
      case FIGHT.Execute: {
        this.desiredMove.set(0, 0); // motion here is scripted, never steered
        this.executeElapsed += dt;
        this.stepExecute(dt);
        break;
      }
      case FIGHT.Recover: {
        this.driftCombat(dt);
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) {
          this.fight = FIGHT.Choose;
          this.stateTimer = CHOOSE_GAP[(this.phaseNum - 1) as 0 | 1 | 2];
        }
        break;
      }
    }
  }

  /** Phase thresholds; entering P2 raises the shield, P3 refreshes it ONCE. */
  private checkPhases(): void {
    const frac = this.hp / VAEL_DEF.maxHp;
    if (this.phaseNum < 2 && frac <= P2_HP_FRACTION) {
      this.phaseNum = 2;
      this.shieldCount = SHIELD_LAYERS;
      this.stripFlash = 1;
    }
    if (this.phaseNum < 3 && frac <= P3_HP_FRACTION) {
      this.phaseNum = 3;
      if (!this.shieldRefreshed) {
        // THE one refresh (§9's contract): the lesson is examined twice, then
        // never again — a broken P3 shield stays broken.
        this.shieldCount = SHIELD_LAYERS;
        this.shieldRefreshed = true;
        this.stripFlash = 1;
      }
    }
  }

  private beginTelegraph(): void {
    // Commit the aim NOW — the §9 dodge contract every enemy honors.
    let ax = this.targetX - this.position.x;
    let az = this.targetZ - this.position.z;
    const dist = Math.sqrt(ax * ax + az * az);
    if (dist > 1e-5) {
      ax /= dist;
      az /= dist;
    } else {
      ax = Math.sin(this.yaw);
      az = -Math.cos(this.yaw);
    }
    this.aimDirX = ax;
    this.aimDirZ = az;

    this.attackKind = this.pickAttack(dist);
    let telegraph = this.baseTelegraphFor(this.attackKind);
    if (this.phaseNum >= 3) telegraph *= P3_TELEGRAPH_SCALE;
    if (telegraph < MIN_TELEGRAPH_SECONDS) telegraph = MIN_TELEGRAPH_SECONDS; // §9, ALWAYS
    this.telegraphTotal = telegraph;
    this.stateTimer = telegraph;
    this.fight = FIGHT.Telegraph;
  }

  private baseTelegraphFor(kind: AttackId): number {
    switch (kind) {
      case ATTACK.Volley:
        return VOLLEY_TELEGRAPH;
      case ATTACK.Lunge:
        return LUNGE_TELEGRAPH;
      case ATTACK.Charge:
        return CHARGE_TELEGRAPH;
      case ATTACK.Slam:
        return SLAM_TELEGRAPH;
      default:
        return VOLLEY_TELEGRAPH;
    }
  }

  /** Seeded pick, weighted per phase and sanity-gated by range. */
  private pickAttack(dist: number): AttackId {
    const roll = this.nextRandom();
    if (this.phaseNum === 1) {
      // P1 (§9 contract): ranged volleys + lunge. Volley-biased at range.
      if (dist <= 7 && roll < 0.45) return ATTACK.Lunge;
      return ATTACK.Volley;
    }
    if (this.phaseNum === 2) {
      // P2 adds the charge.
      if (roll < 0.38) return ATTACK.Volley;
      if (roll < 0.62) return dist <= 7 ? ATTACK.Lunge : ATTACK.Charge;
      return dist >= DRIFT_MIN_DIST ? ATTACK.Charge : ATTACK.Lunge;
    }
    // P3 adds the slam rings.
    if (roll < 0.28) return ATTACK.Volley;
    if (roll < 0.5) return dist <= SLAM_OUTER_RADIUS ? ATTACK.Slam : ATTACK.Volley;
    if (roll < 0.72) return dist <= 7 ? ATTACK.Lunge : ATTACK.Charge;
    return dist >= DRIFT_MIN_DIST ? ATTACK.Charge : ATTACK.Slam;
  }

  private beginExecute(): void {
    this.fight = FIGHT.Execute;
    this.executeElapsed = 0;
    switch (this.attackKind) {
      case ATTACK.Volley:
        this.volleyFired = 0;
        break;
      case ATTACK.Lunge:
        this.lungeLeft = LUNGE_RANGE;
        break;
      case ATTACK.Charge:
        this.chargeLeft = CHARGE_RANGE;
        break;
      case ATTACK.Slam:
        // Wave 1 exactly as the inner ring completes — promise, then payoff —
        // and wave 2 armed: dash INWARD (or i-frame) to dodge the annulus.
        this.dealRing(0, SLAM_INNER_RADIUS, SLAM_DAMAGE, SLAM_KNOCK, true, 0, 0);
        this.slamWavePending = true;
        this.slamWaveTimer = SLAM_WAVE_GAP;
        break;
    }
  }

  private stepExecute(dt: number): void {
    switch (this.attackKind) {
      case ATTACK.Volley: {
        while (
          this.volleyFired < VOLLEY_SHOTS &&
          this.executeElapsed >= this.volleyFired * VOLLEY_INTERVAL
        ) {
          this.fireVolleyShot(this.volleyFired);
          this.volleyFired++;
        }
        if (this.volleyFired >= VOLLEY_SHOTS && this.executeElapsed >= (VOLLEY_SHOTS - 1) * VOLLEY_INTERVAL + 0.15) {
          this.enterRecover();
        }
        break;
      }
      case ATTACK.Slam: {
        if (this.slamWavePending) {
          this.slamWaveTimer -= dt;
          if (this.slamWaveTimer <= 0) {
            this.slamWavePending = false;
            this.dealRing(SLAM_INNER_RADIUS, SLAM_OUTER_RADIUS, SLAM_DAMAGE, SLAM_KNOCK, true, 0, 0);
            this.enterRecover();
          }
        }
        break;
      }
      case ATTACK.Lunge:
      case ATTACK.Charge:
        // Scripted displacement — resolved in stepScripted after integration.
        break;
    }
  }

  private enterRecover(): void {
    this.fight = FIGHT.Recover;
    this.stateTimer = RECOVER_SECONDS;
  }

  /** Lunge/charge displacement, after the base integrated knock and terrain. */
  private stepScripted(dt: number): void {
    if (this.fight !== FIGHT.Execute) return;

    if (this.attackKind === ATTACK.Lunge && this.lungeLeft > 0) {
      const speed = LUNGE_RANGE / LUNGE_SECONDS;
      const step = Math.min(speed * dt, this.lungeLeft);
      this.displace(step);
      this.lungeLeft -= step;
      if (this.lungeLeft <= 1e-4) {
        this.lungeLeft = 0;
        // Landed: one radial hit exactly where the ring promised.
        this.dealRing(0, LUNGE_HIT_RADIUS, LUNGE_DAMAGE, LUNGE_KNOCK, true, 0, 0);
        this.enterRecover();
      }
      return;
    }

    if (this.attackKind === ATTACK.Charge && this.chargeLeft > 0) {
      const step = Math.min(CHARGE_SPEED * dt, this.chargeLeft);
      const hitEdge = this.displace(step);
      this.chargeLeft -= step;
      // First body contact ends the rush — one hit, never a damage drag.
      const hits = this.dealRing(
        0,
        this.radius + CHARGE_HIT_PAD,
        CHARGE_DAMAGE,
        CHARGE_KNOCK,
        false,
        this.aimDirX,
        this.aimDirZ,
      );
      if (hits > 0 || hitEdge || this.chargeLeft <= 1e-4) {
        this.chargeLeft = 0;
        this.enterRecover();
      }
    }
  }

  /** Move along the committed aim; clamp to the arena disc. True on the rim. */
  private displace(step: number): boolean {
    let nx = this.position.x + this.aimDirX * step;
    let nz = this.position.z + this.aimDirZ * step;
    const cx = nx - ARENA_X;
    const cz = nz - ARENA_Z;
    const cd = Math.sqrt(cx * cx + cz * cz);
    let onRim = false;
    if (cd > ARENA_KEEP_RADIUS && cd > 1e-5) {
      const s = ARENA_KEEP_RADIUS / cd;
      nx = ARENA_X + cx * s;
      nz = ARENA_Z + cz * s;
      onRim = true;
    }
    this.position.x = nx;
    this.position.z = nz;
    this.position.y = this.groundAt(nx, nz);
    return onRim;
  }

  private fireVolleyShot(index: number): void {
    // Fan around the committed aim; only the PITCH tracks the target's chest
    // (ArchetypeEnemy's ranged rule — slopes cannot cheat the dodge).
    const fan = (index - (VOLLEY_SHOTS - 1) / 2) * VOLLEY_FAN_RADIANS;
    const cos = Math.cos(fan);
    const sin = Math.sin(fan);
    const ax = this.aimDirX * cos - this.aimDirZ * sin;
    const az = this.aimDirX * sin + this.aimDirZ * cos;
    const muzzleY = this.position.y + this.height * MUZZLE_HEIGHT;
    const dx = this.targetX - this.position.x;
    const dz = this.targetZ - this.position.z;
    let planar = Math.sqrt(dx * dx + dz * dz);
    if (planar < 1) planar = 1;
    const targetY = this.groundAt(this.targetX, this.targetZ) + TARGET_CHEST_HEIGHT;
    const dirY = (targetY - muzzleY) / planar;
    const inv = 1 / Math.sqrt(ax * ax + dirY * dirY + az * az);
    this.projectiles.fire(
      this.position.x + ax * this.radius,
      muzzleY,
      this.position.z + az * this.radius,
      ax * inv,
      dirY * inv,
      az * inv,
      VOLLEY_SPEED,
      VOLLEY_DAMAGE,
      VAEL_ACCENT_COLOR,
      this.id,
    );
  }

  // --- movement ------------------------------------------------------------------

  private driftHome(): void {
    const dx = this.homeX - this.position.x;
    const dz = this.homeZ - this.position.z;
    const distSq = dx * dx + dz * dz;
    if (distSq > 4) {
      const inv = 1 / Math.sqrt(distSq);
      this.desiredMove.set(dx * inv, dz * inv);
    } else {
      this.desiredMove.set(0, 0);
    }
  }

  /** Hold the band: close in past MAX, back off inside MIN, else strafe. */
  private driftCombat(dt: number): void {
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      if (this.nextRandom() < 0.5) this.strafeSign = -this.strafeSign;
      this.strafeTimer = 1.4 + this.nextRandom() * 1.8;
    }
    const dx = this.targetX - this.position.x;
    const dz = this.targetZ - this.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    let mx: number;
    let mz: number;
    if (dist < 1e-4) {
      mx = 0;
      mz = 0;
    } else if (dist > DRIFT_MAX_DIST) {
      mx = dx / dist;
      mz = dz / dist;
    } else if (dist < DRIFT_MIN_DIST) {
      mx = -dx / dist;
      mz = -dz / dist;
    } else {
      mx = (-dz / dist) * this.strafeSign;
      mz = (dx / dist) * this.strafeSign;
    }
    // Arena containment beats the band — the boss never leaves the plateau.
    const cx = ARENA_X - this.position.x;
    const cz = ARENA_Z - this.position.z;
    const cd = Math.sqrt(cx * cx + cz * cz);
    if (cd > ARENA_KEEP_RADIUS - 1) {
      mx = cx / cd;
      mz = cz / cd;
    }
    this.desiredMove.set(mx, mz);
  }

  /** Face the committed aim through an attack, the player otherwise. */
  private faceFight(dt: number): void {
    let tx: number;
    let tz: number;
    if (this.fight === FIGHT.Telegraph || this.fight === FIGHT.Execute) {
      tx = this.aimDirX;
      tz = this.aimDirZ;
    } else {
      tx = this.targetX - this.position.x;
      tz = this.targetZ - this.position.z;
      if (tx * tx + tz * tz < 1e-4) return;
    }
    const targetYaw = Math.atan2(tx, -tz);
    let delta = targetYaw - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.yaw += delta * (1 - Math.exp(-TURN_K * dt));
  }

  // --- damage out -------------------------------------------------------------------

  /**
   * One annulus hit against the player's team, centred on Vael: targets with
   * planar (feet) distance inside [minRadius, maxRadius]. minRadius 0 is the
   * plain sphere every other attack uses; the slam's second wave passes the
   * inner radius so standing at the boss's feet dodges it — positioning IS
   * the counterplay. Returns the hit count.
   */
  private dealRing(
    minRadius: number,
    maxRadius: number,
    damage: number,
    knock: number,
    radial: boolean,
    alongX: number,
    alongZ: number,
  ): number {
    scratchQuery.x = this.position.x;
    scratchQuery.y = this.position.y + this.height * 0.5;
    scratchQuery.z = this.position.z;
    scratchQuery.radius = maxRadius;
    scratchQuery.sourceId = this.id;
    this.hitMinRadius = minRadius;
    this.hitDamage = damage;
    this.hitKnock = knock;
    this.hitRadial = radial;
    this.hitAlongX = alongX;
    this.hitAlongZ = alongZ;
    this.hitLanded = 0;
    this.hitboxSys.overlapSphere(scratchQuery, this.onAttackHit);
    return this.hitLanded;
  }

  /** Pre-bound visitor; context rides in the fields dealRing set (§13). */
  private readonly onAttackHit = (target: Combatant): void => {
    let kx = target.position.x - this.position.x;
    let kz = target.position.z - this.position.z;
    const len = Math.sqrt(kx * kx + kz * kz);
    if (len < this.hitMinRadius) return; // the annulus hole — the safe spot
    if (this.hitRadial) {
      if (len > 1e-5) {
        kx /= len;
        kz /= len;
      } else {
        kx = Math.sin(this.yaw);
        kz = -Math.cos(this.yaw);
      }
    } else {
      kx = this.hitAlongX;
      kz = this.hitAlongZ;
    }
    this.hitLanded++;
    const knock = this.hitKnock;
    this.damageSys.deal(
      target,
      this.hitDamage,
      0,
      PLAYER_ARMOR,
      false,
      this.id,
      kx * knock,
      kz * knock,
      target.position.x,
      target.position.y + target.height * 0.55,
      target.position.z,
    );
  };

  // --- the shield's ears ---------------------------------------------------------------

  /**
   * StatusEffects emits synchronously from reactionFor with the TARGET's own
   * coordinates, before the triggering hit deals — so an exact-position match
   * is a target match, not a proximity guess. Any of the five §8.5 reactions
   * on Vael strips one layer and arms the one-hit grace.
   */
  private readonly onReaction = (e: ReactionEvent): void => {
    if (!this.alive || this.fight === FIGHT.Dormant) return;
    const dx = e.x - this.position.x;
    const dz = e.z - this.position.z;
    if (dx * dx + dz * dz > 0.0025) return; // not on Vael
    this.reactionGrace = true; // the reaction's own hit lands undampened
    if (this.shieldCount > 0) {
      this.shieldCount--;
      this.stripFlash = 1;
    }
  };

  // --- presentation ---------------------------------------------------------------------

  applyVisual(x: number, y: number, z: number, yaw: number): void {
    const pose = this.pose;
    pose.alive = this.alive;
    pose.deadFor = this.deadFor;
    pose.hitAmount = this.hitAmount;
    pose.telegraphing = this.alive && this.fight === FIGHT.Telegraph;
    pose.telegraphProgress = 0;
    if (pose.telegraphing) {
      const t = 1 - this.stateTimer / this.telegraphTotal;
      pose.telegraphProgress = t < 0 ? 0 : t > 1 ? 1 : t;
    }

    let strike = 0;
    if (this.alive && this.fight === FIGHT.Execute) {
      switch (this.attackKind) {
        case ATTACK.Volley:
          strike = this.executeElapsed / 0.5;
          break;
        case ATTACK.Lunge:
          strike = 1 - this.lungeLeft / LUNGE_RANGE;
          break;
        case ATTACK.Charge:
          strike = 1 - this.chargeLeft / CHARGE_RANGE;
          break;
        case ATTACK.Slam:
          strike = this.executeElapsed / (SLAM_WAVE_GAP + 0.1);
          break;
      }
      if (strike > 1) strike = 1;
      else if (strike < 0.05) strike = 0.05;
    }
    pose.strike = strike;

    this.visual.apply(x, y, z, yaw, pose);
    this.updateTelegraphVisuals(x, y, z);
    this.updateShellVisual();
  }

  /** The shapes always draw the TRUE hit areas, growing over the wind-up (§9). */
  private updateTelegraphVisuals(x: number, y: number, z: number): void {
    const ringMain = this.ringMain;
    const ringOuter = this.ringOuter;
    const strip = this.strip;

    if (!this.alive) {
      ringMain.visible = false;
      ringOuter.visible = false;
      strip.visible = false;
      return;
    }

    if (this.fight === FIGHT.Telegraph) {
      const progress = 1 - this.stateTimer / this.telegraphTotal;
      const grow = progress > RING_MIN_SCALE ? progress : RING_MIN_SCALE;
      switch (this.attackKind) {
        case ATTACK.Volley: {
          // No area to promise — the pulse under the caster is the beat; the
          // projectiles are the dodgeable part (ArchetypeEnemy's ranged rule).
          ringMain.visible = true;
          ringOuter.visible = false;
          strip.visible = false;
          ringMain.position.set(0, RING_LIFT, 0);
          const s = (this.radius + 0.5) * grow;
          ringMain.scale.set(s, 1, s);
          break;
        }
        case ATTACK.Lunge: {
          const cx = x + this.aimDirX * LUNGE_RANGE;
          const cz = z + this.aimDirZ * LUNGE_RANGE;
          ringMain.visible = true;
          ringOuter.visible = false;
          strip.visible = false;
          ringMain.position.set(cx - x, this.groundAt(cx, cz) - y + RING_LIFT, cz - z);
          const s = LUNGE_HIT_RADIUS * grow;
          ringMain.scale.set(s, 1, s);
          break;
        }
        case ATTACK.Charge: {
          ringMain.visible = false;
          ringOuter.visible = false;
          strip.visible = true;
          strip.position.set(0, STRIP_LIFT, 0);
          strip.rotation.y = -Math.atan2(this.aimDirX, -this.aimDirZ);
          strip.scale.set((this.radius + CHARGE_HIT_PAD) * 2, 1, CHARGE_RANGE * grow);
          break;
        }
        case ATTACK.Slam: {
          // BOTH rings grow through the one wind-up: the inner disc hits at
          // completion, the annulus SLAM_WAVE_GAP later — each promise is on
          // screen well past §9's floor before its payoff.
          ringMain.visible = true;
          ringOuter.visible = true;
          strip.visible = false;
          ringMain.position.set(0, RING_LIFT + 0.02, 0);
          ringOuter.position.set(0, RING_LIFT + 0.02, 0);
          const si = SLAM_INNER_RADIUS * grow;
          const so = SLAM_OUTER_RADIUS * grow;
          ringMain.scale.set(si, 1, si);
          ringOuter.scale.set(so, 1, so);
          break;
        }
      }
      return;
    }

    if (this.fight === FIGHT.Execute && this.attackKind === ATTACK.Slam && this.slamWavePending) {
      // Wave 1 fired; the annulus is still armed — keep its ring burning.
      ringMain.visible = false;
      strip.visible = false;
      ringOuter.visible = true;
      ringOuter.position.set(0, RING_LIFT + 0.02, 0);
      ringOuter.scale.set(SLAM_OUTER_RADIUS, 1, SLAM_OUTER_RADIUS);
      return;
    }

    ringMain.visible = false;
    ringOuter.visible = false;
    strip.visible = false;
  }

  /** Additive void shell: opacity steps down with each remaining layer. */
  private updateShellVisual(): void {
    const show = this.alive && this.shieldCount > 0;
    this.shell.visible = show;
    if (!show) return;
    const now = performance.now();
    if (this.lastNow === 0) this.lastNow = now;
    let fdt = (now - this.lastNow) * 0.001;
    this.lastNow = now;
    if (fdt < 0) fdt = 0;
    else if (fdt > 0.1) fdt = 0.1;
    this.shellClock += fdt;
    const flash = this.stripFlash;
    this.shellMaterial.opacity =
      SHIELD_OPACITY_BASE + SHIELD_OPACITY_PER_LAYER * this.shieldCount + flash * 0.3;
    const s = 1 + flash * 0.2 + Math.sin(this.shellClock * 2.6) * 0.02;
    this.shell.scale.setScalar(s);
    this.shell.rotation.y = this.shellClock * 0.6;
    this.shell.rotation.x = Math.sin(this.shellClock * 0.9) * 0.15;
  }

  // --- lifecycle hooks ------------------------------------------------------------------

  protected onDamagedHook(_heavy: boolean): void {
    // Jiggle and knock ride EnemyBase's hitAmount; nothing extra.
  }

  /**
   * The kill: §8.2.4's scripted Legendary, found by its bossReward marker (no
   * skill id in this file — §4.1's one rule that DOES bind the boss). learn()
   * fires 'grimoire:acquired', which IS the ACQUIRED moment; def.xp banks
   * through the manager's ordinary consumeKillReward path.
   */
  protected onDiedHook(): void {
    this.fight = FIGHT.Dead;
    this.shieldCount = 0;
    this.slamWavePending = false;
    this.ringMain.visible = false;
    this.ringOuter.visible = false;
    this.strip.visible = false;
    this.shell.visible = false;
    const all = this.registry.all;
    for (let i = 0; i < all.length; i++) {
      const def = all[i];
      if (def !== undefined && def.bossReward === true) {
        this.grimoire.learn(def.id, 'boss');
        break;
      }
    }
  }

  protected onRespawnedHook(): void {
    this.fight = FIGHT.Dormant;
    this.stateTimer = 0;
    this.phaseNum = 1;
    this.shieldCount = 0;
    this.shieldRefreshed = false;
    this.reactionGrace = false;
    this.stripFlash = 0;
    this.volleyFired = 0;
    this.lungeLeft = 0;
    this.chargeLeft = 0;
    this.slamWavePending = false;
    this.slamWaveTimer = 0;
    this.executeElapsed = 0;
    this.rng = VAEL_SEED;
    this.strafeSign = 1;
    this.strafeTimer = 0;
    this.visual.reset();
    this.ringMain.visible = false;
    this.ringOuter.visible = false;
    this.strip.visible = false;
    this.shell.visible = false;
    this.root.position.copy(this.position);
  }

  protected onActiveChangedHook(active: boolean): void {
    this.visual.setVisible(active);
    if (!active && this.alive && this.fight !== FIGHT.Dormant) {
      // §9's hysteresis kicked in mid-fight (belt-and-braces: the 34 u leash
      // fires long before 90 u). Manual dormancy — reset() here would fight
      // setActive's own bookkeeping.
      this.fight = FIGHT.Dormant;
      this.hp = VAEL_DEF.maxHp;
      this.phaseNum = 1;
      this.shieldCount = 0;
      this.shieldRefreshed = false;
      this.slamWavePending = false;
      this.desiredMove.set(0, 0);
    }
  }

  dispose(): void {
    this.unsubReaction();
    this.visual.dispose();
    this.shell.geometry.dispose();
    this.shellMaterial.dispose();
    this.scene.remove(this.arenaMesh);
    this.arenaMesh.geometry.dispose();
    this.arenaMaterial.dispose();
  }

  /** mulberry32 — the seeded house generator; the gate replays the fight. */
  private nextRandom(): number {
    let t = (this.rng += 0x6d2b79f5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
