import * as THREE from 'three';

import type { Combatant } from '../combat/CombatTypes';
import { TEAM } from '../combat/CombatTypes';
import type { DamageSystem } from '../combat/DamageSystem';
import type { HitboxSystem, HitQuery } from '../combat/HitboxSystem';
import type { ElementId } from '../skills/SkillTypes';
import type { HeightSampler } from '../world/HeightField';
import type { AABB, SpatialHash } from '../world/SpatialHash';
import { LUNGE_DISTANCE, STRIKE_RADIUS } from './AIBrain';
import { EnemyBase } from './EnemyBase';
import type { ArchetypeId, EnemyDef } from './EnemyDefs';
import { EnemyVisual, createEnemyPose } from './EnemyVisual';
import type { EnemyPose } from './EnemyVisual';

/**
 * The Phase 5 enemy: an EnemyBase driven ENTIRELY by a validated enemies.json
 * def — body (EnemyVisual archetype), stats, element table and one of the four
 * attack kinds. No kind string exists in code (§4.1 extended to enemies); the
 * def IS the enemy.
 *
 * Attack kinds, all §9-telegraphed (>= 0.5 s, enforced at boot by EnemyDefs):
 * - 'lunge'  — Phase 3's pattern generalised: ground ring grows on the landing
 *              spot over the wind-up, then the committed hop covers exactly
 *              LUNGE_DISTANCE and the damage lands where the ring promised.
 * - 'ranged' — ring pulse on the caster, then ONE pooled projectile (shared
 *              slab of 12 across ALL enemies) flies the aim committed at
 *              telegraph start; it hits via a HitboxSystem sphere riding it.
 * - 'charge' — a ground STRIP telegraphs the full rush lane, then a line rush
 *              at chargeSpeed that stops on prop collision (SpatialHash), the
 *              world rim, first contact, or chargeRange.
 * - 'slam'   — an expanding ring telegraphs the true slamRadius, then one
 *              radial hit inside exactly that radius.
 *
 * The brain (AIBrain, untouched) still owns WHEN: telegraph -> strike frame ->
 * recover. EnemyManager's Phase 3 strike-damage hook is disarmed via the
 * consumeStrikeLanded override, because damage here is per-kind and uses
 * attack.damage, not contactDamage.
 *
 * Element multipliers (contract): x0.5 resisted, x1.5 weak, else 1.0 — exposed
 * as elementMultiplierFor() for the integrator's damage lookup.
 */

export interface ArchetypeEnemyOptions {
  id: number;
  def: EnemyDef;
  field: HeightSampler;
  homeX: number;
  homeZ: number;
  seed: number;
  hitbox: HitboxSystem;
  damage: DamageSystem;
  /** ONE pool shared by every enemy — never per-enemy (§13). */
  projectiles: EnemyProjectiles;
  /** Prop AABBs for charge stops; null = stop on range/rim/contact only. */
  props?: SpatialHash | null;
  /**
   * Director-spawned enemies never self-respawn (the SpawnDirector owns the
   * population; EnemyBase's home-respawn was Phase 3's stand-in).
   */
  directorManaged?: boolean;
}

export const ELEMENT_RESIST_MULT = 0.5;
export const ELEMENT_WEAK_MULT = 1.5;

/** Phase 5 player still has no gear armor (§10 lands in Phase 6). */
const PLAYER_ARMOR = 0;
/** Knockback impulses (u/s) dealt to the player, per attack kind. */
const LUNGE_KNOCK = 7;
const SLAM_KNOCK = 8;
const CHARGE_KNOCK = 10;
const PROJECTILE_KNOCK = 4;
/** Telegraph ring craft — Phase 3's values, kept identical on purpose. */
const RING_LIFT = 0.05;
const RING_MIN_SCALE = 0.06;
const STRIP_LIFT = 0.1;
/** Extra reach of the rushing body beyond the capsule — the shoulder check. */
const CHARGE_HIT_PAD = 0.5;
/** Post-release swing window driving the ranged/slam strike pose. */
const FLASH_SECONDS = 0.28;
/** Charge obstacles: boxes below this are stepped over, like §7's step-up. */
const BLOCK_STEP_ALLOWANCE = 0.4;
const WORLD_MARGIN = 1;
/** Muzzle height fraction for ranged shots; aims at the player's chest. */
const MUZZLE_HEIGHT = 0.65;
const TARGET_CHEST_HEIGHT = 1.0;

/** Capsule proportions per archetype at scale 1 (× def.scale at spawn). */
const CAPSULE_RADIUS: Record<ArchetypeId, number> = {
  blob: 0.5,
  quad: 0.45,
  biped: 0.4,
  sentinel: 0.55,
  wraith: 0.42,
};
const CAPSULE_HEIGHT: Record<ArchetypeId, number> = {
  blob: 0.9,
  quad: 0.9,
  biped: 1.5,
  sentinel: 1.6,
  wraith: 1.5,
};

// Module scratch — §13: nothing allocated per tick.
const scratchQuery: HitQuery = { x: 0, y: 0, z: 0, radius: 0, team: TEAM.Enemy, sourceId: 0 };

export class ArchetypeEnemy extends EnemyBase {
  readonly radius: number;
  readonly height: number;
  readonly root: THREE.Object3D;
  /** The validated def with the Phase 5 fields (this.def is the base view). */
  readonly archDef: EnemyDef;

  private readonly visual: EnemyVisual;
  private readonly pose: EnemyPose;
  private readonly ring: THREE.Mesh;
  private readonly strip: THREE.Mesh | null;
  private readonly hitboxSys: HitboxSystem;
  private readonly damageSys: DamageSystem;
  private readonly projectiles: EnemyProjectiles;
  private readonly props: SpatialHash | null;
  private readonly directorManaged: boolean;
  /** Ring/damage radius of the lunge — ONE value, so the ring cannot lie. */
  private readonly lungeRadius: number;

  private charging = false;
  private chargeDirX = 0;
  private chargeDirZ = 1;
  private chargeLeft = 0;
  private flashTimer = 0;
  /** Player position copy (facePlayerHint) — ranged pitch aiming only. */
  private targetX = 0;
  private targetZ = 0;

  // Pre-bound visitor context (§13: no closures per hit).
  private hitDamage = 0;
  private hitKnock = 0;
  private knockAlongX = 0;
  private knockAlongZ = 0;
  private knockRadial = true;
  private blocked = false;
  private blockX = 0;
  private blockZ = 0;

  constructor(options: ArchetypeEnemyOptions) {
    super({
      id: options.id,
      def: options.def,
      field: options.field,
      homeX: options.homeX,
      homeZ: options.homeZ,
      seed: options.seed,
    });
    const def = options.def;
    this.archDef = def;
    this.radius = CAPSULE_RADIUS[def.archetype] * def.scale;
    this.height = CAPSULE_HEIGHT[def.archetype] * def.scale;
    this.hitboxSys = options.hitbox;
    this.damageSys = options.damage;
    this.projectiles = options.projectiles;
    this.props = options.props ?? null;
    this.directorManaged = options.directorManaged === true;
    this.lungeRadius = Math.max(1, STRIKE_RADIUS * def.scale);

    this.visual = new EnemyVisual(def);
    this.pose = createEnemyPose();
    this.root = this.visual.root;
    this.ring = this.visual.makeTelegraphRing();
    this.strip = def.attack.kind === 'charge' ? this.visual.makeTelegraphStrip() : null;
    this.root.position.copy(this.position);
  }

  // --- element table (integrator's §9 elementMultiplier lookup) ---------------

  get element(): ElementId | 'none' {
    return this.archDef.element;
  }

  get resists(): readonly ElementId[] {
    return this.archDef.resists;
  }

  get weakTo(): readonly ElementId[] {
    return this.archDef.weakTo;
  }

  /** ×0.5 resisted, ×1.5 weak, else 1.0 (contract). Allocation-free. */
  elementMultiplierFor(element: ElementId): number {
    if (this.archDef.weakTo.indexOf(element) >= 0) return ELEMENT_WEAK_MULT;
    if (this.archDef.resists.indexOf(element) >= 0) return ELEMENT_RESIST_MULT;
    return 1;
  }

  get skillDropChance(): number {
    return this.archDef.skillDropChance;
  }

  /** Director-managed enemies never self-respawn; the director owns population. */
  override get expendable(): boolean {
    return this.directorManaged;
  }

  override get readyToRespawn(): boolean {
    return this.directorManaged ? false : super.readyToRespawn;
  }

  // --- attack dispatch ----------------------------------------------------------

  /** Keeps the manager's player-position hint AND copies it for ranged pitch. */
  override facePlayerHint(x: number, z: number): void {
    super.facePlayerHint(x, z);
    this.targetX = x;
    this.targetZ = z;
  }

  /**
   * The manager's Phase 3 hook ("strike landed -> contactDamage area") is
   * disarmed: this class resolves its own per-kind attack damage inside
   * update(), where it consumes the base flag itself.
   */
  override consumeStrikeLanded(): boolean {
    return false;
  }

  /** The brain's strike frame (manager calls this) — launch the def's attack. */
  override beginStrike(): void {
    const attack = this.archDef.attack;
    switch (attack.kind) {
      case 'lunge':
        // The committed Phase 3 hop; damage lands when the base flags it.
        super.beginStrike();
        break;
      case 'ranged': {
        this.flashTimer = FLASH_SECONDS;
        const muzzleY = this.position.y + this.height * MUZZLE_HEIGHT;
        // Horizontal aim was committed at telegraph start (dodgeable, §9);
        // only the pitch tracks the target's chest so slopes cannot cheat it.
        const ax = this.brain.aimX;
        const az = this.brain.aimZ;
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
          attack.projectileSpeed,
          attack.damage,
          this.archDef.palette.accent,
          this.id,
        );
        break;
      }
      case 'charge':
        this.charging = true;
        this.chargeDirX = this.brain.aimX;
        this.chargeDirZ = this.brain.aimZ;
        this.chargeLeft = attack.chargeRange;
        break;
      case 'slam':
        // The expanding ring reached slamRadius exactly now: one radial hit
        // inside exactly that radius — the promise is the payoff.
        this.flashTimer = FLASH_SECONDS;
        this.dealSphere(attack.slamRadius, attack.damage, SLAM_KNOCK, true, 0, 0);
        break;
    }
  }

  override update(dt: number): void {
    super.update(dt);
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer < 0) this.flashTimer = 0;
    }
    if (!this.alive) {
      this.charging = false;
      return;
    }
    // Lunge landing (base integrated the committed hop this tick).
    if (super.consumeStrikeLanded()) {
      this.dealSphere(this.lungeRadius, this.archDef.attack.damage, LUNGE_KNOCK, true, 0, 0);
    }
    if (this.charging) this.stepCharge(dt);
  }

  /**
   * The rush: a scripted displacement on top of the base integration (the
   * brain sits in its recover window for the whole rush — EnemyDefs enforces
   * recoverSeconds >= chargeRange / chargeSpeed at boot). Runs on the fixed
   * tick, so hitstop freezes it with everything else.
   */
  private stepCharge(dt: number): void {
    const attack = this.archDef.attack;
    if (attack.kind !== 'charge') {
      this.charging = false;
      return;
    }
    const step = Math.min(attack.chargeSpeed * dt, this.chargeLeft);
    const field = this.field;
    let nx = this.position.x + this.chargeDirX * step;
    let nz = this.position.z + this.chargeDirZ * step;
    let hitRim = false;
    const minX = field.minX + WORLD_MARGIN;
    const maxX = field.maxX - WORLD_MARGIN;
    const minZ = field.minZ + WORLD_MARGIN;
    const maxZ = field.maxZ - WORLD_MARGIN;
    if (nx < minX) { nx = minX; hitRim = true; }
    else if (nx > maxX) { nx = maxX; hitRim = true; }
    if (nz < minZ) { nz = minZ; hitRim = true; }
    else if (nz > maxZ) { nz = maxZ; hitRim = true; }

    if (this.props !== null && this.chargeBlockedAt(nx, nz)) {
      this.charging = false;
      return;
    }

    this.position.x = nx;
    this.position.z = nz;
    this.position.y = field.heightAt(nx, nz);
    this.chargeLeft -= step;
    // Committed facing along the rush (house yaw convention).
    this.yaw = Math.atan2(this.chargeDirX, -this.chargeDirZ);

    // First body contact ends the rush — one hit, never a damage drag.
    const hits = this.dealSphere(
      this.radius + CHARGE_HIT_PAD,
      attack.damage,
      CHARGE_KNOCK,
      false,
      this.chargeDirX,
      this.chargeDirZ,
    );
    if (hits > 0 || hitRim || this.chargeLeft <= 0) this.charging = false;
  }

  /** Capsule-vs-prop AABB check at the candidate position (§7's structure). */
  private chargeBlockedAt(x: number, z: number): boolean {
    const props = this.props;
    if (props === null) return false;
    this.blocked = false;
    this.blockX = x;
    this.blockZ = z;
    const reach = this.radius;
    props.query(x - reach, z - reach, x + reach, z + reach, this.onBlockBox);
    return this.blocked;
  }

  private readonly onBlockBox = (box: AABB): void => {
    if (this.blocked) return;
    // Vertical: ignore boxes low enough to step over, or entirely overhead.
    const feetY = this.position.y;
    if (box.maxY <= feetY + BLOCK_STEP_ALLOWANCE || box.minY >= feetY + this.height) return;
    // XZ: circle vs box.
    let dx = this.blockX;
    if (dx < box.minX) dx = box.minX;
    else if (dx > box.maxX) dx = box.maxX;
    let dz = this.blockZ;
    if (dz < box.minZ) dz = box.minZ;
    else if (dz > box.maxZ) dz = box.maxZ;
    dx -= this.blockX;
    dz -= this.blockZ;
    if (dx * dx + dz * dz <= this.radius * this.radius) this.blocked = true;
  };

  /**
   * One sphere hit against the player's team at this enemy's centre, dealing
   * `damage` with `knock` u/s — radial by default, or along (alongX, alongZ)
   * for the rush. Returns the hit count. Mirrors EnemyManager's pattern.
   */
  private dealSphere(
    radius: number,
    damage: number,
    knock: number,
    radial: boolean,
    alongX: number,
    alongZ: number,
  ): number {
    scratchQuery.x = this.position.x;
    scratchQuery.y = this.position.y + this.height * 0.5;
    scratchQuery.z = this.position.z;
    scratchQuery.radius = radius;
    scratchQuery.sourceId = this.id;
    this.hitDamage = damage;
    this.hitKnock = knock;
    this.knockRadial = radial;
    this.knockAlongX = alongX;
    this.knockAlongZ = alongZ;
    return this.hitboxSys.overlapSphere(scratchQuery, this.onAttackHit);
  }

  /** Pre-bound overlap visitor; context rides in the fields set by dealSphere. */
  private readonly onAttackHit = (target: Combatant): void => {
    let kx: number;
    let kz: number;
    if (this.knockRadial) {
      kx = target.position.x - this.position.x;
      kz = target.position.z - this.position.z;
      const len = Math.sqrt(kx * kx + kz * kz);
      if (len > 1e-5) {
        kx /= len;
        kz /= len;
      } else {
        kx = Math.sin(this.yaw);
        kz = -Math.cos(this.yaw);
      }
    } else {
      kx = this.knockAlongX;
      kz = this.knockAlongZ;
    }
    const knock = this.hitKnock;
    this.damageSys.deal(
      target,
      this.hitDamage,
      0, // enemies carry no stat scaling (§9's formula uses base only here)
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

  // --- presentation ---------------------------------------------------------------

  applyVisual(x: number, y: number, z: number, yaw: number): void {
    const pose = this.pose;
    const brain = this.brain;
    const attack = this.archDef.attack;

    pose.alive = this.alive;
    pose.deadFor = this.deadFor;
    pose.hitAmount = this.hitAmount;
    pose.telegraphing = this.alive && brain.telegraphing;
    pose.telegraphProgress = brain.telegraphProgress;

    let strike = 0;
    if (attack.kind === 'lunge') {
      strike = this.strikeProgress;
    } else if (attack.kind === 'charge') {
      if (this.charging) {
        strike = 1 - this.chargeLeft / attack.chargeRange;
        if (strike < 0.05) strike = 0.05;
      }
    } else if (this.flashTimer > 0) {
      strike = 1 - this.flashTimer / FLASH_SECONDS;
      if (strike < 0.03) strike = 0.03;
    }
    pose.strike = strike;

    this.visual.apply(x, y, z, yaw, pose);
    this.updateTelegraphs(x, y, z);
  }

  /**
   * Telegraph shapes — Phase 3's craft, per kind: the shape always draws the
   * TRUE hit area, growing over the wind-up so area and timing arrive as one
   * signal (§9). Runs on the render path; scalar writes only.
   */
  private updateTelegraphs(x: number, y: number, z: number): void {
    const brain = this.brain;
    const ring = this.ring;
    const strip = this.strip;
    if (!this.alive || !brain.telegraphing) {
      ring.visible = false;
      if (strip !== null) strip.visible = false;
      return;
    }
    const attack = this.archDef.attack;
    const progress = brain.telegraphProgress;
    const grow = progress > RING_MIN_SCALE ? progress : RING_MIN_SCALE;

    switch (attack.kind) {
      case 'lunge': {
        // Centred on the hop's landing point, sweeping to the true hit radius.
        const cx = x + brain.aimX * LUNGE_DISTANCE;
        const cz = z + brain.aimZ * LUNGE_DISTANCE;
        ring.visible = true;
        ring.position.set(cx - x, this.groundAt(cx, cz) - y + RING_LIFT, cz - z);
        const scale = this.lungeRadius * grow;
        ring.scale.set(scale, 1, scale);
        break;
      }
      case 'ranged': {
        // No area to promise — the ring pulse under the caster is the "incoming
        // shot" beat; the projectile itself is the dodgeable part.
        ring.visible = true;
        ring.position.set(0, RING_LIFT, 0);
        const scale = (this.radius + 0.45) * grow;
        ring.scale.set(scale, 1, scale);
        break;
      }
      case 'charge': {
        if (strip === null) break;
        // The full rush lane, filling toward the target over the wind-up.
        strip.visible = true;
        strip.position.set(0, STRIP_LIFT, 0);
        strip.rotation.y = -Math.atan2(brain.aimX, -brain.aimZ);
        strip.scale.set((this.radius + CHARGE_HIT_PAD) * 2, 1, attack.chargeRange * grow);
        break;
      }
      case 'slam': {
        // Expanding ring around self: at full size it IS slamRadius.
        ring.visible = true;
        ring.position.set(0, RING_LIFT + 0.02, 0);
        const scale = attack.slamRadius * grow;
        ring.scale.set(scale, 1, scale);
        break;
      }
    }
  }

  dispose(): void {
    this.visual.dispose();
  }

  protected onDamagedHook(_heavy: boolean): void {
    // Jiggle and knock are handled by hitAmount / EnemyBase; nothing extra.
  }

  protected onDiedHook(): void {
    this.ring.visible = false;
    if (this.strip !== null) this.strip.visible = false;
    this.charging = false;
    this.flashTimer = 0;
  }

  protected onRespawnedHook(): void {
    this.visual.reset();
    this.ring.visible = false;
    if (this.strip !== null) this.strip.visible = false;
    this.charging = false;
    this.chargeLeft = 0;
    this.flashTimer = 0;
    this.root.position.copy(this.position);
  }

  protected onActiveChangedHook(active: boolean): void {
    this.visual.setVisible(active);
  }
}

// -----------------------------------------------------------------------------
// Shared enemy projectile pool
// -----------------------------------------------------------------------------

export interface EnemyProjectilesOptions {
  scene: THREE.Scene;
  hitbox: HitboxSystem;
  damage: DamageSystem;
  field: HeightSampler;
}

/** ONE slab for the whole bestiary (contract) — SkillRuntime's nova pattern. */
export const ENEMY_PROJECTILE_MAX = 12;

/** Hit sphere riding the tracer. */
const PROJECTILE_RADIUS = 0.4;
/**
 * Ground kill uses its OWN clearance, not the hit radius: a small ranged kind
 * (blob at scale 0.7) fires from a muzzle only ~0.41 u up, and killing the
 * shot at `ground + 0.4` left it one centimetre of clearance on flat ground
 * and none uphill — the smallest ranged kind's volleys all died at the muzzle
 * (Phase 5 gate finding). 0.15 still reads right: the 0.16-size tracer
 * visually skims, and a shot whose CENTRE enters the hillside still dies.
 */
const PROJECTILE_GROUND_CLEARANCE = 0.15;
/** Hard expiry; the slowest def (10 u/s) still covers 40 u — beyond any aggro. */
const PROJECTILE_LIFETIME = 4;
const TRACER_SIZE = 0.16;
const TRACER_STRETCH = 2.6;

interface ProjectileSlot {
  active: boolean;
  x: number;
  y: number;
  z: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  speed: number;
  damage: number;
  sourceId: number;
  life: number;
  mesh: THREE.Mesh;
  colors: THREE.BufferAttribute;
}

const projScratchColor = new THREE.Color();
const projQuery: HitQuery = { x: 0, y: 0, z: 0, radius: 0, team: TEAM.Enemy, sourceId: 0 };

/**
 * Fixed slab of 12 pooled enemy projectiles, shared across every enemy — a
 * full slab means the 13th concurrent shot is skipped, never allocated (§13).
 *
 * Tracer: an octahedron stretched along its flight, additive-blended (§5's
 * fake-glow doctrine). ONE material for all 12; the per-shot tint is written
 * into each tracer's own tiny vertex-colour attribute (24 vertices), so a
 * cold-blue shard and an ember bolt still cost a single program.
 *
 * Stepped by EnemyManager inside its hitstop gate, so shots freeze with their
 * shooters. Damage goes through DamageSystem like every other hit.
 */
export class EnemyProjectiles {
  private readonly scene: THREE.Scene;
  private readonly hitbox: HitboxSystem;
  private readonly damage: DamageSystem;
  private readonly field: HeightSampler;
  private readonly group: THREE.Group;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly slots: ProjectileSlot[];

  /** Pre-bound visitor context. */
  private hitSlot: ProjectileSlot | null = null;
  private hitCount = 0;

  constructor(options: EnemyProjectilesOptions) {
    this.scene = options.scene;
    this.hitbox = options.hitbox;
    this.damage = options.damage;
    this.field = options.field;
    this.group = new THREE.Group();
    this.group.name = 'enemyProjectiles';
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.slots = new Array<ProjectileSlot>(ENEMY_PROJECTILE_MAX);
    for (let i = 0; i < ENEMY_PROJECTILE_MAX; i++) {
      const geometry = new THREE.OctahedronGeometry(TRACER_SIZE, 0);
      const count = geometry.getAttribute('position').count;
      const colors = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      geometry.setAttribute('color', colors);
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.visible = false;
      mesh.rotation.order = 'YXZ';
      mesh.scale.set(1, 1, TRACER_STRETCH);
      this.group.add(mesh);
      this.slots[i] = {
        active: false,
        x: 0, y: 0, z: 0,
        prevX: 0, prevY: 0, prevZ: 0,
        dirX: 0, dirY: 0, dirZ: 1,
        speed: 0,
        damage: 0,
        sourceId: 0,
        life: 0,
        mesh,
        colors,
      };
    }
    this.scene.add(this.group);
  }

  get liveCount(): number {
    let count = 0;
    for (let i = 0; i < ENEMY_PROJECTILE_MAX; i++) {
      const slot = this.slots[i];
      if (slot !== undefined && slot.active) count++;
    }
    return count;
  }

  /** Launch one shot. Returns false when the slab is full (shot skipped, §13). */
  fire(
    x: number,
    y: number,
    z: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    speed: number,
    damage: number,
    colorHex: number,
    sourceId: number,
  ): boolean {
    let slot: ProjectileSlot | undefined;
    for (let i = 0; i < ENEMY_PROJECTILE_MAX; i++) {
      const candidate = this.slots[i];
      if (candidate !== undefined && !candidate.active) {
        slot = candidate;
        break;
      }
    }
    if (slot === undefined) return false;

    slot.active = true;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.prevX = x;
    slot.prevY = y;
    slot.prevZ = z;
    slot.dirX = dirX;
    slot.dirY = dirY;
    slot.dirZ = dirZ;
    slot.speed = speed;
    slot.damage = damage;
    slot.sourceId = sourceId;
    slot.life = PROJECTILE_LIFETIME;

    // Tint the tracer — writes into its own small attribute, no new material.
    projScratchColor.setHex(colorHex);
    const colors = slot.colors;
    const array = colors.array as Float32Array;
    for (let i = 0; i < colors.count; i++) {
      array[i * 3] = projScratchColor.r;
      array[i * 3 + 1] = projScratchColor.g;
      array[i * 3 + 2] = projScratchColor.b;
    }
    colors.needsUpdate = true;

    const mesh = slot.mesh;
    mesh.visible = true;
    mesh.position.set(x, y, z);
    // Nose along the flight: -yaw maps local -Z onto the direction (see
    // EnemyVisual's facing note); pitch tips it along dirY.
    mesh.rotation.y = -Math.atan2(dirX, -dirZ);
    let pitch = dirY;
    if (pitch > 1) pitch = 1;
    else if (pitch < -1) pitch = -1;
    mesh.rotation.x = Math.asin(pitch);
    return true;
  }

  /** Fixed tick. The caller (EnemyManager) gates this behind hitstop. */
  update(dt: number): void {
    const field = this.field;
    for (let i = 0; i < ENEMY_PROJECTILE_MAX; i++) {
      const slot = this.slots[i];
      if (slot === undefined || !slot.active) continue;
      slot.prevX = slot.x;
      slot.prevY = slot.y;
      slot.prevZ = slot.z;
      const step = slot.speed * dt;
      slot.x += slot.dirX * step;
      slot.y += slot.dirY * step;
      slot.z += slot.dirZ * step;
      slot.life -= dt;

      // Terrain, rim or expiry kill the shot silently.
      if (
        slot.life <= 0 ||
        !field.inBounds(slot.x, slot.z) ||
        slot.y - PROJECTILE_GROUND_CLEARANCE <= field.heightAt(slot.x, slot.z)
      ) {
        this.deactivate(slot);
        continue;
      }

      projQuery.x = slot.x;
      projQuery.y = slot.y;
      projQuery.z = slot.z;
      projQuery.radius = PROJECTILE_RADIUS;
      projQuery.sourceId = slot.sourceId;
      this.hitSlot = slot;
      this.hitCount = 0;
      this.hitbox.overlapSphere(projQuery, this.onHit);
      this.hitSlot = null;
      if (this.hitCount > 0) this.deactivate(slot);
    }
  }

  /** Pre-bound visitor: deal and mark — no pierce, first hit ends the shot. */
  private readonly onHit = (target: Combatant): void => {
    const slot = this.hitSlot;
    if (slot === null || this.hitCount > 0) return;
    this.hitCount++;
    this.damage.deal(
      target,
      slot.damage,
      0,
      PLAYER_ARMOR,
      false,
      slot.sourceId,
      slot.dirX * PROJECTILE_KNOCK,
      slot.dirZ * PROJECTILE_KNOCK,
      target.position.x,
      target.position.y + target.height * 0.55,
      target.position.z,
    );
  };

  /** Interpolated tracer positions — the sim stays on the fixed tick. */
  render(alpha: number): void {
    for (let i = 0; i < ENEMY_PROJECTILE_MAX; i++) {
      const slot = this.slots[i];
      if (slot === undefined || !slot.active) continue;
      slot.mesh.position.set(
        slot.prevX + (slot.x - slot.prevX) * alpha,
        slot.prevY + (slot.y - slot.prevY) * alpha,
        slot.prevZ + (slot.z - slot.prevZ) * alpha,
      );
    }
  }

  reset(): void {
    for (let i = 0; i < ENEMY_PROJECTILE_MAX; i++) {
      const slot = this.slots[i];
      if (slot !== undefined) this.deactivate(slot);
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (let i = 0; i < ENEMY_PROJECTILE_MAX; i++) {
      const slot = this.slots[i];
      if (slot === undefined) continue;
      slot.mesh.geometry.dispose();
    }
    this.material.dispose();
  }

  private deactivate(slot: ProjectileSlot): void {
    slot.active = false;
    slot.mesh.visible = false;
  }
}
