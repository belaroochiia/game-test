import * as THREE from 'three';

import type { Combatant, DamagePacket, TeamId } from '../combat/CombatTypes';
import { TEAM } from '../combat/CombatTypes';
import type { System } from '../core/Engine';
import type { HeightSampler } from '../world/HeightField';
import { AI_STATE, AI_STATE_NAMES, AIBrain, LUNGE_DISTANCE, STRIKE_SECONDS } from './AIBrain';

/**
 * Concrete state, abstract visuals: this class owns hp, position, velocity,
 * knockback, stagger, ground clamping and death/respawn bookkeeping; a subclass
 * owns only the mesh and how the numbers read on screen. That is the same seam
 * PlayerAvatar drew in §5 — swapping a blocky enemy for a rigged GLTF later touches
 * one subclass.
 *
 * No SpatialHash against props (contract: enemies pass through bushes — at 18
 * enemies simplicity wins), but ALWAYS clamped to the analytic terrain height,
 * so an enemy can never float or tunnel no matter what shoved it.
 */

export interface EnemyDef {
  readonly kind: string;
  readonly maxHp: number;
  readonly armor: number;
  readonly contactDamage: number;
  readonly moveSpeed: number;
  /** Alert/Chase trigger. */
  readonly aggroRadius: number;
  /** May start an attack inside this. */
  readonly attackRadius: number;
  /** §9: >= 0.5 — the wind-up must be readable on a phone. */
  readonly telegraphSeconds: number;
  readonly attackRecoverSeconds: number;
  readonly respawnSeconds: number;
  /** Stored on kill; Phase 6 consumes. */
  readonly xp: number;
}

export interface EnemyBaseOptions {
  id: number;
  def: EnemyDef;
  field: HeightSampler;
  homeX: number;
  homeZ: number;
  seed: number;
}

/** Exponential accel toward the brain's desired velocity, as time-to-90 %. */
const ACCEL_K = Math.LN10 / 0.15;
/** Staggered enemies bleed speed hard — the hit visibly takes their legs. */
const STAGGER_DECEL_K = Math.LN10 / 0.08;
/**
 * Knockback friction. v/k gives the shove distance: a heavy hit's 9 u/s slides
 * ~1.4 u — §9's "visibly shove", cheap as one exp per tick.
 */
const KNOCK_FRICTION_K = Math.LN10 / 0.35;
const KNOCK_EPSILON_SQ = 1e-4;
const TURN_K = 10;
/** Heavy-hit stagger — long enough to reward the A3 timing, short of a stunlock. */
const STAGGER_SECONDS = 0.4;
/** Drives the subclass hit-jiggle; sim time, so hitstop freezes the reaction pose. */
const HIT_REACT_SECONDS = 0.16;
/** Per-enemy contact damage cooldown (contract) so overlap does not melt the player. */
const CONTACT_COOLDOWN_SECONDS = 0.5;
/** Ambling between wander points, not marching — patrol reads as harmless. */
const PATROL_SPEED_SCALE = 0.45;
const WORLD_MARGIN = 1;
/** Staggered brains consume at most this much accumulated dt per step (§9 stagger). */
const BRAIN_DT_CLAMP = 0.2;

export abstract class EnemyBase implements Combatant, System {
  readonly name: string;
  readonly id: number;
  readonly def: EnemyDef;
  readonly team: TeamId = TEAM.Enemy;
  readonly brain: AIBrain;
  /** Feet position, world space (Combatant contract). */
  readonly position = new THREE.Vector3();
  /** Last tick's position — EnemyManager interpolates between the two on render. */
  readonly prevPosition = new THREE.Vector3();
  /** Brain-written desired direction (unit or zero); integration consumes it. */
  readonly desiredMove = new THREE.Vector2();
  readonly homeX: number;
  readonly homeZ: number;

  abstract readonly radius: number;
  abstract readonly height: number;
  /** Built by the subclass; EnemyManager adds it to the scene. */
  abstract readonly root: THREE.Object3D;

  hp: number;
  yaw = 0;

  protected readonly field: HeightSampler;

  private aliveFlag = true;
  private activeFlag = true;
  private moveVelX = 0;
  private moveVelZ = 0;
  private knockVelX = 0;
  private knockVelZ = 0;
  private staggerTimer = 0;
  private hitTimer = 0;
  private strikeTimer = 0;
  private lungeDirX = 0;
  private lungeDirZ = 1;
  private strikeLandedFlag = false;
  private contactCooldown = 0;
  private deadElapsed = 0;
  private pendingXp = 0;
  /** Accumulates real time between staggered brain steps so timers stay honest. */
  private brainDtAcc = 0;
  /** Player position, written by the manager each tick — facing only, never pathing. */
  private focusX = 0;
  private focusZ = 0;

  constructor(options: EnemyBaseOptions) {
    this.id = options.id;
    this.def = options.def;
    this.name = options.def.kind;
    this.field = options.field;
    this.homeX = options.homeX;
    this.homeZ = options.homeZ;
    this.hp = options.def.maxHp;
    this.position.set(options.homeX, options.field.heightAt(options.homeX, options.homeZ), options.homeZ);
    this.prevPosition.copy(this.position);
    this.brain = new AIBrain(options.def, options.seed);
    // No virtual calls here: subclass fields (mesh, radius) do not exist yet.
  }

  get alive(): boolean {
    return this.aliveFlag;
  }

  /** False past §9's despawn distance — mesh hidden, updates skipped. */
  get active(): boolean {
    return this.activeFlag;
  }

  get staggered(): boolean {
    return this.staggerTimer > 0;
  }

  get striking(): boolean {
    return this.strikeTimer > 0;
  }

  /** 0..1 through the strike lunge; 0 when not striking. */
  get strikeProgress(): number {
    return this.strikeTimer > 0 ? 1 - this.strikeTimer / STRIKE_SECONDS : 0;
  }

  /** 1 right after a hit, decaying to 0 — the subclass jiggle amplitude. */
  get hitAmount(): number {
    return this.hitTimer > 0 ? this.hitTimer / HIT_REACT_SECONDS : 0;
  }

  get deadFor(): number {
    return this.deadElapsed;
  }

  /** Time served — the manager still requires the player > 25 u away. */
  /**
   * True when a corpse has no future — purgeDead may reclaim its slots.
   * Phase 3 enemies self-respawn at home, so their corpses are NOT expendable;
   * director-managed enemies never respawn and are.
   */
  get expendable(): boolean {
    return false;
  }

  get readyToRespawn(): boolean {
    return !this.aliveFlag && this.deadElapsed >= this.def.respawnSeconds;
  }

  get contactReady(): boolean {
    return this.contactCooldown <= 0;
  }

  /** For the debug surface; tuple-indexed, allocation-free. */
  get stateName(): string {
    return AI_STATE_NAMES[this.brain.state];
  }

  /**
   * Applies POST-mitigation damage (Combatant contract), integrates the
   * knockback impulse, staggers on heavy, and flips to dead at 0. Returns the
   * amount that actually mattered (overkill clamped).
   */
  takeDamage(packet: DamagePacket): number {
    if (!this.aliveFlag) return 0;
    const amount = packet.amount;
    if (amount <= 0) return 0;

    const before = this.hp;
    const applied = amount < before ? amount : before;
    this.hp = before - amount;
    if (this.hp < 0) this.hp = 0;

    this.knockVelX += packet.knockX;
    this.knockVelZ += packet.knockZ;
    this.hitTimer = HIT_REACT_SECONDS;

    if (packet.heavy) {
      this.staggerTimer = STAGGER_SECONDS;
      // Cancels an unfinished wind-up only — a launched strike stays launched.
      this.brain.interrupt();
    }

    if (this.hp <= 0) this.kill();
    else this.onDamagedHook(packet.heavy);
    return applied;
  }

  /** The brain decided to strike: launch the committed forward lunge. */
  beginStrike(): void {
    this.lungeDirX = this.brain.aimX;
    this.lungeDirZ = this.brain.aimZ;
    this.strikeTimer = STRIKE_SECONDS;
  }

  /** True exactly once when the lunge lands — the manager's damage frame. */
  consumeStrikeLanded(): boolean {
    const landed = this.strikeLandedFlag;
    this.strikeLandedFlag = false;
    return landed;
  }

  /** def.xp exactly once after a kill; 0 otherwise. Phase 6 spends the bank. */
  consumeKillReward(): number {
    const xp = this.pendingXp;
    this.pendingXp = 0;
    return xp;
  }

  markContactHit(): void {
    this.contactCooldown = CONTACT_COOLDOWN_SECONDS;
  }

  accumulateBrainDt(dt: number): void {
    this.brainDtAcc += dt;
  }

  /** Clamped so a long gap (stagger, hysteresis edge) cannot jump FSM timers. */
  consumeBrainDt(): number {
    let dt = this.brainDtAcc;
    this.brainDtAcc = 0;
    if (dt > BRAIN_DT_CLAMP) dt = BRAIN_DT_CLAMP;
    return dt;
  }

  facePlayerHint(x: number, z: number): void {
    this.focusX = x;
    this.focusZ = z;
  }

  /** §9 despawn/reactivate. Deactivation zeroes motion so nothing drifts unseen. */
  setActive(active: boolean): void {
    if (this.activeFlag === active) return;
    this.activeFlag = active;
    if (!active) {
      this.moveVelX = 0;
      this.moveVelZ = 0;
      this.knockVelX = 0;
      this.knockVelZ = 0;
      this.desiredMove.set(0, 0);
      this.brainDtAcc = 0;
    }
    this.onActiveChangedHook(active);
  }

  /**
   * One fixed tick of motion. The manager gates this behind hitstop and steps
   * the brain separately (§9's stagger) — this always integrates, so a skipped
   * brain step can never make an enemy teleport or freeze.
   */
  update(dt: number): void {
    this.prevPosition.copy(this.position);
    if (this.hitTimer > 0) this.hitTimer -= dt;

    if (!this.aliveFlag) {
      this.deadElapsed += dt;
      // The killing blow's shove keeps sliding the pancake — the kill reads.
      this.integrateKnockAndClamp(dt);
      return;
    }

    if (this.contactCooldown > 0) this.contactCooldown -= dt;
    if (this.staggerTimer > 0) this.staggerTimer -= dt;

    if (this.strikeTimer > 0) {
      // The lunge is a scripted displacement, not steering: velocity is written,
      // not blended, so the strike always covers exactly LUNGE_DISTANCE.
      const lungeSpeed = LUNGE_DISTANCE / STRIKE_SECONDS;
      this.moveVelX = this.lungeDirX * lungeSpeed;
      this.moveVelZ = this.lungeDirZ * lungeSpeed;
      this.strikeTimer -= dt;
      if (this.strikeTimer <= 0) {
        this.strikeTimer = 0;
        this.strikeLandedFlag = true;
        // Land planted, not skidding.
        this.moveVelX *= 0.2;
        this.moveVelZ *= 0.2;
      }
    } else if (this.staggerTimer > 0) {
      const blend = 1 - Math.exp(-STAGGER_DECEL_K * dt);
      this.moveVelX -= this.moveVelX * blend;
      this.moveVelZ -= this.moveVelZ * blend;
    } else {
      const scale = this.brain.state === AI_STATE.Patrol ? PATROL_SPEED_SCALE : 1;
      const speed = this.def.moveSpeed * scale;
      const blend = 1 - Math.exp(-ACCEL_K * dt);
      this.moveVelX += (this.desiredMove.x * speed - this.moveVelX) * blend;
      this.moveVelZ += (this.desiredMove.y * speed - this.moveVelZ) * blend;
    }

    this.position.x += this.moveVelX * dt;
    this.position.z += this.moveVelZ * dt;
    this.integrateKnockAndClamp(dt);
    this.updateFacing(dt);
  }

  /** Full respawn at home: fresh hp, seeded brain stream, subclass visuals reset. */
  reset(): void {
    this.position.set(this.homeX, this.field.heightAt(this.homeX, this.homeZ), this.homeZ);
    this.prevPosition.copy(this.position);
    this.yaw = 0;
    this.hp = this.def.maxHp;
    this.aliveFlag = true;
    this.moveVelX = 0;
    this.moveVelZ = 0;
    this.knockVelX = 0;
    this.knockVelZ = 0;
    this.staggerTimer = 0;
    this.hitTimer = 0;
    this.strikeTimer = 0;
    this.strikeLandedFlag = false;
    this.contactCooldown = 0;
    this.deadElapsed = 0;
    this.pendingXp = 0;
    this.brainDtAcc = 0;
    this.desiredMove.set(0, 0);
    this.brain.reset(true);
    if (!this.activeFlag) {
      this.activeFlag = true;
      this.onActiveChangedHook(true);
    }
    this.onRespawnedHook();
  }

  /** Rendered-frame pose: interpolated position in, mesh writes out. */
  abstract applyVisual(x: number, y: number, z: number, yaw: number): void;

  abstract dispose(): void;

  /** Non-lethal hit landed (knock/jiggle already applied by the base). */
  protected abstract onDamagedHook(heavy: boolean): void;
  /** hp reached 0 — capture whatever the death animation needs. */
  protected abstract onDiedHook(): void;
  /** Fresh spawn or respawn — show the mesh, reset animation state. */
  protected abstract onRespawnedHook(): void;
  /** §9 despawn hysteresis — show/hide the mesh. */
  protected abstract onActiveChangedHook(active: boolean): void;

  protected groundAt(x: number, z: number): number {
    return this.field.heightAt(x, z);
  }

  private kill(): void {
    this.aliveFlag = false;
    this.deadElapsed = 0;
    this.pendingXp = this.def.xp;
    this.strikeTimer = 0;
    this.strikeLandedFlag = false;
    this.staggerTimer = 0;
    this.moveVelX = 0;
    this.moveVelZ = 0;
    this.desiredMove.set(0, 0);
    this.onDiedHook();
  }

  /** Knock impulse with exponential friction, world clamp, terrain snap. */
  private integrateKnockAndClamp(dt: number): void {
    const kx = this.knockVelX;
    const kz = this.knockVelZ;
    if (kx * kx + kz * kz > KNOCK_EPSILON_SQ) {
      this.position.x += kx * dt;
      this.position.z += kz * dt;
      const decay = 1 - Math.exp(-KNOCK_FRICTION_K * dt);
      this.knockVelX -= kx * decay;
      this.knockVelZ -= kz * decay;
    } else if (kx !== 0 || kz !== 0) {
      this.knockVelX = 0;
      this.knockVelZ = 0;
    }

    const field = this.field;
    const minX = field.minX + WORLD_MARGIN;
    const maxX = field.maxX - WORLD_MARGIN;
    const minZ = field.minZ + WORLD_MARGIN;
    const maxZ = field.maxZ - WORLD_MARGIN;
    if (this.position.x < minX) this.position.x = minX;
    else if (this.position.x > maxX) this.position.x = maxX;
    if (this.position.z < minZ) this.position.z = minZ;
    else if (this.position.z > maxZ) this.position.z = maxZ;

    // Enemies are always grounded; the hop is purely visual (subclass).
    this.position.y = field.heightAt(this.position.x, this.position.z);
  }

  private updateFacing(dt: number): void {
    let targetYaw = this.yaw;
    const brain = this.brain;
    if (this.strikeTimer > 0) {
      targetYaw = Math.atan2(this.lungeDirX, -this.lungeDirZ);
    } else if (brain.telegraphing) {
      targetYaw = Math.atan2(brain.aimX, -brain.aimZ);
    } else {
      const mx = this.desiredMove.x;
      const mz = this.desiredMove.y;
      if (mx * mx + mz * mz > 0.04) {
        targetYaw = Math.atan2(mx, -mz);
      } else {
        // Standing still while engaged: face the player. This IS the Alert beat.
        const st = brain.state;
        if (st === AI_STATE.Alert || st === AI_STATE.Chase || st === AI_STATE.Attack) {
          const fx = this.focusX - this.position.x;
          const fz = this.focusZ - this.position.z;
          if (fx * fx + fz * fz > 1e-4) targetYaw = Math.atan2(fx, -fz);
        }
      }
    }

    // Shortest-arc exponential turn, frame-rate independent (house style).
    let delta = targetYaw - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.yaw += delta * (1 - Math.exp(-TURN_K * dt));
  }
}
