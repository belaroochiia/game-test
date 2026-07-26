import * as THREE from 'three';

import type { System } from '../core/Engine';
import type { HeightSampler } from '../world/HeightField';
import type { AABB, SpatialHash } from '../world/SpatialHash';
import type { InputState } from './InputState';
import { consumeBuffered } from './InputState';
import type { PlayerStats } from './PlayerStats';

/**
 * §7's player: a 0.4-radius, 1.8-tall capsule moved by hand. No physics engine
 * (§13) — terrain contact is an analytic heightmap sample, props are
 * capsule-vs-AABB push-out out of a spatial hash.
 *
 * Every number in here is from §7 and is measured by tools/playtest.mjs, so treat
 * them as a contract rather than taste.
 */

export const PLAYER_STATE = {
  Idle: 'Idle',
  Move: 'Move',
  Sprint: 'Sprint',
  Dash: 'Dash',
  Air: 'Air',
  Attack1: 'Attack1',
  Attack2: 'Attack2',
  Attack3: 'Attack3',
  Cast: 'Cast',
  CastChannel: 'CastChannel',
  Hit: 'Hit',
  Down: 'Down',
  Revive: 'Revive',
} as const;

export type PlayerState = (typeof PLAYER_STATE)[keyof typeof PLAYER_STATE];

export interface PlayerControllerOptions {
  terrain: HeightSampler;
  props: SpatialHash;
  input: InputState;
  stats: PlayerStats;
  spawnX?: number;
  spawnZ?: number;
}

export const CAPSULE_RADIUS = 0.4;
export const CAPSULE_HEIGHT = 1.8;

const WALK_SPEED = 4;
const SPRINT_SPEED = 7;
const DASH_SPEED = 14;
const DASH_DURATION = 0.18;
const DASH_IFRAME = 0.15;
const DASH_COOLDOWN = 1.2;
const COYOTE_TIME = 0.1;

/**
 * Exponential rates, expressed as time-to-90 %: accelerating in 0.12 s and
 * stopping in 0.10 s. `k = ln(10) / t`, applied as `1 - exp(-k dt)` so the curve
 * is identical at 60 and 120 Hz (§4.2).
 */
const ACCEL_K = Math.LN10 / 0.12;
const DECEL_K = Math.LN10 / 0.1;
/** Turn rate. Slow turning reads as input lag, so this is deliberately snappy. */
const TURN_K = 14;

const GRAVITY = -24;
const TERMINAL_VELOCITY = -40;
/** §7: step up automatically below this, and snap to ground within it. */
const STEP_UP = 0.5;
const SLOPE_LIMIT = (45 * Math.PI) / 180;
/** Downhill push once past the slope limit, so steep faces slide instead of sticking. */
const SLIDE_ACCEL = 16;

/**
 * §9's light-light-heavy combo. Startup/active/recovery per stage; the buffered
 * next input may cancel into the following stage once the active phase ends, and
 * §7's 0.12 s input buffer means a slightly-early tap still chains. All timing
 * is measured by tools/combattest.mjs — these are contract numbers, not taste.
 */
interface AttackStageDef {
  readonly startup: number;
  readonly active: number;
  readonly recovery: number;
  readonly base: number;
  readonly radius: number;
  readonly reach: number;
  readonly heavy: boolean;
  readonly knockback: number;
}

const ATTACK_STAGES: readonly AttackStageDef[] = [
  { startup: 0.08, active: 0.1, recovery: 0.22, base: 12, radius: 1.1, reach: 1.0, heavy: false, knockback: 2.5 },
  { startup: 0.07, active: 0.1, recovery: 0.26, base: 14, radius: 1.1, reach: 1.0, heavy: false, knockback: 3 },
  { startup: 0.16, active: 0.12, recovery: 0.42, base: 26, radius: 1.3, reach: 1.1, heavy: true, knockback: 9 },
];

/*
 * §9 asks for a 0.9 s combo-reset window; here the chain window IS the cancel
 * window (active-end to recovery-end), which is stricter and reads cleaner: a
 * press after recovery always restarts at stage 1, so there is no hidden timer
 * for the player to build a wrong model around.
 */
/** Post-hit invulnerability, so contact damage cannot melt the player (§9). */
const HIT_IFRAME_SECONDS = 0.6;
const HIT_STAGGER_SECONDS = 0.25;
const DOWN_SECONDS = 1.6;
/** Chest height, where the swing sphere lives. */
const STRIKE_HEIGHT = 1.0;

/** The strike callback the bootstrap wires to the hitbox system. */
export type StrikeHandler = (
  stage: number,
  x: number,
  y: number,
  z: number,
  radius: number,
  base: number,
  heavy: boolean,
  knockX: number,
  knockZ: number,
) => void;

// Module-scope scratch — §13's number-one rule is no allocation in update().
const scratchNormal = new THREE.Vector3();

export class PlayerController implements System {
  readonly name = 'player';

  readonly position = new THREE.Vector3();
  readonly prevPosition = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  /** Set by the bootstrap from CameraRig each tick; movement is camera-relative (§6). */
  cameraYaw = 0;

  private readonly terrain: HeightSampler;
  private readonly props: SpatialHash;
  private readonly input: InputState;
  private readonly stats: PlayerStats;
  private readonly spawnX: number;
  private readonly spawnZ: number;

  private facing = 0;
  private currentState: PlayerState = PLAYER_STATE.Idle;
  private isGrounded = true;
  private airTime = 0;
  private dashTimer = 0;
  private dashCooldown = 0;
  private dashDirX = 0;
  private dashDirZ = -1;

  /** 0 = not attacking, 1..3 = current swing. */
  private comboStageValue = 0;
  /** Cast timer (Phase 4). While > 0 the player is in Cast state. */
  private castTimer = 0;
  private castCanMove = false;
  private attackTimer = 0;
  private struckThisSwing = false;
  private hitTimer = 0;
  private iframeTimer = 0;
  private downTimer = 0;

  /** Wired by the bootstrap: the swing's active frame reports here (Phase 3). */
  onStrike: StrikeHandler | undefined;
  /** Auto-aim yaw from TargetLock; NaN when nothing is locked (§6.6). */
  aimYaw = Number.NaN;
  /** Set by the bootstrap; combat freezes during hitstop while the world runs. */
  hitstopRef: { readonly active: boolean } | undefined;

  /** Ground height found this tick, including prop tops. */
  private groundY = 0;
  /** Highest prop top the capsule is standing over, or -Infinity. */
  private propGroundY = Number.NEGATIVE_INFINITY;
  /** Pre-bound so the spatial-hash query allocates no closure (§13). */
  private readonly visitProp: (box: AABB) => void;

  constructor(options: PlayerControllerOptions) {
    this.terrain = options.terrain;
    this.props = options.props;
    this.input = options.input;
    this.stats = options.stats;
    this.spawnX = options.spawnX ?? 0;
    this.spawnZ = options.spawnZ ?? 0;

    this.visitProp = (box: AABB): void => {
      this.resolveProp(box);
    };

    this.reset();
  }

  get yaw(): number {
    return this.facing;
  }

  get state(): PlayerState {
    return this.currentState;
  }

  get grounded(): boolean {
    return this.isGrounded;
  }

  get speed(): number {
    const vx = this.velocity.x;
    const vz = this.velocity.z;
    return Math.sqrt(vx * vx + vz * vz);
  }

  get dashCooldownLeft(): number {
    return this.dashCooldown;
  }

  /** Surface height under the capsule this tick, prop tops included. */
  get groundHeight(): number {
    return this.groundY;
  }

  get invulnerable(): boolean {
    return this.currentState === PLAYER_STATE.Dash && this.dashTimer > DASH_DURATION - DASH_IFRAME;
  }

  update(dt: number): void {
    // Frozen mid-hit: no timers advance, no input consumes. The camera and the
    // world keep running — the contrast is what sells the impact (§9).
    if (this.hitstopRef !== undefined && this.hitstopRef.active) return;

    this.prevPosition.copy(this.position);

    const input = this.input;
    const now = performance.now();

    if (this.dashCooldown > 0) this.dashCooldown -= dt;
    if (this.iframeTimer > 0) this.iframeTimer -= dt;

    // --- down / hit interrupts own everything below them ---------------------
    if (this.currentState === PLAYER_STATE.Down) {
      this.downTimer -= dt;
      this.velocity.x = 0;
      this.velocity.z = 0;
      if (this.downTimer <= 0) this.respawn();
      this.resolveGround();
      return;
    }
    if (this.currentState === PLAYER_STATE.Hit) {
      this.hitTimer -= dt;
      // Knockback decays hard; no steering while staggered.
      const decay = 1 - Math.exp(-8 * dt);
      this.velocity.x -= this.velocity.x * decay;
      this.velocity.z -= this.velocity.z * decay;
      this.position.x += this.velocity.x * dt;
      this.position.z += this.velocity.z * dt;
      this.clampToChunk();
      this.resolveProps();
      this.resolveGround();
      if (this.hitTimer <= 0) this.currentState = PLAYER_STATE.Idle;
      return;
    }

    // --- resolve the stick into a world-space direction (camera-relative, §6) ---
    let inX = input.moveX;
    let inZ = input.moveY;
    const inputLengthSq = inX * inX + inZ * inZ;
    if (inputLengthSq > 1) {
      const inv = 1 / Math.sqrt(inputLengthSq);
      inX *= inv;
      inZ *= inv;
    }
    const hasInput = inputLengthSq > 1e-6;

    let wishX = 0;
    let wishZ = 0;
    if (hasInput) {
      // Screen up (-Y on the stick) means "away from the camera".
      const sin = Math.sin(this.cameraYaw);
      const cos = Math.cos(this.cameraYaw);
      wishX = inX * cos + inZ * sin;
      wishZ = -inX * sin + inZ * cos;
    }

    // --- cast lock (Phase 4) -------------------------------------------------
    if (this.castTimer > 0) this.castTimer -= dt;

    // --- attack combo (§9) ---------------------------------------------------
    const attacking = this.comboStageValue > 0;
    if (attacking) this.stepAttack(dt, now);

    // --- dash: buffered input (§7's 0.12 s) plus coyote time -----------------
    // Dash cancels an attack, but only once the active frames are done — §9's
    // cancel window. Cancelling startup would make the heavy free to whiff-test.
    const canCoyoteDash = this.isGrounded || this.airTime < COYOTE_TIME;
    const inCancelWindow = !attacking || this.attackPhase() === 2;
    const dashRequested = consumeBuffered(input, 'dashQueuedAt', now);
    if (
      dashRequested &&
      this.dashCooldown <= 0 &&
      canCoyoteDash &&
      inCancelWindow &&
      this.currentState !== PLAYER_STATE.Dash
    ) {
      this.cancelAttack();
      this.startDash(wishX, wishZ, hasInput);
    }

    // A press starts the combo; chaining is handled inside stepAttack, which
    // leaves the buffered press unconsumed until its cancel window opens.
    if (!attacking && this.currentState !== PLAYER_STATE.Dash && this.isGrounded) {
      const attackRequested = consumeBuffered(input, 'attackQueuedAt', now);
      if (attackRequested) this.startAttack(1);
    }

    // --- horizontal velocity ------------------------------------------------
    if (this.comboStageValue > 0 || (this.castTimer > 0 && !this.castCanMove)) {
      // Rooted during a swing: velocity bleeds off fast, no steering. Facing may
      // still snap to the lock (handled in startAttack), which is §6.6's auto-aim.
      const decay = 1 - Math.exp(-14 * dt);
      this.velocity.x -= this.velocity.x * decay;
      this.velocity.z -= this.velocity.z * decay;
    } else if (this.currentState === PLAYER_STATE.Dash) {
      this.dashTimer -= dt;
      this.velocity.x = this.dashDirX * DASH_SPEED;
      this.velocity.z = this.dashDirZ * DASH_SPEED;
      if (this.dashTimer <= 0) {
        // Leave the dash at walk speed rather than a dead stop, so it flows.
        this.velocity.x *= WALK_SPEED / DASH_SPEED;
        this.velocity.z *= WALK_SPEED / DASH_SPEED;
        this.currentState = PLAYER_STATE.Idle;
      }
    } else {
      const sprinting = input.sprint && hasInput;
      const targetSpeed = sprinting ? SPRINT_SPEED : WALK_SPEED;
      const targetX = wishX * targetSpeed;
      const targetZ = wishZ * targetSpeed;
      const k = hasInput ? ACCEL_K : DECEL_K;
      const blend = 1 - Math.exp(-k * dt);
      this.velocity.x += (targetX - this.velocity.x) * blend;
      this.velocity.z += (targetZ - this.velocity.z) * blend;

      if (hasInput) {
        const wishYaw = Math.atan2(wishX, -wishZ);
        this.turnToward(wishYaw, dt);
      }
    }

    // --- gravity ------------------------------------------------------------
    this.velocity.y += GRAVITY * dt;
    if (this.velocity.y < TERMINAL_VELOCITY) this.velocity.y = TERMINAL_VELOCITY;

    // --- slope: refuse to climb past the limit, slide instead (§7) ----------
    if (this.isGrounded && this.currentState !== PLAYER_STATE.Dash) {
      this.applySlope(dt);
    }

    // --- integrate ----------------------------------------------------------
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y += this.velocity.y * dt;

    this.clampToChunk();
    this.resolveProps();
    this.resolveGround();
    this.updateState(hasInput, this.input.sprint, dt);
  }

  reset(): void {
    const y = this.terrain.heightAt(this.spawnX, this.spawnZ);
    this.position.set(this.spawnX, y, this.spawnZ);
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.facing = 0;
    this.cameraYaw = 0;
    this.currentState = PLAYER_STATE.Idle;
    this.isGrounded = true;
    this.airTime = 0;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.attackTimer = 0;
    this.comboStageValue = 0;
    this.struckThisSwing = false;
    this.castTimer = 0;
    this.castCanMove = false;
    this.hitTimer = 0;
    this.iframeTimer = 0;
    this.downTimer = 0;
    this.aimYaw = Number.NaN;
    this.dashDirX = 0;
    this.dashDirZ = -1;
    this.groundY = y;
  }

  private startDash(wishX: number, wishZ: number, hasInput: boolean): void {
    if (hasInput) {
      const length = Math.sqrt(wishX * wishX + wishZ * wishZ);
      this.dashDirX = wishX / length;
      this.dashDirZ = wishZ / length;
      this.facing = Math.atan2(this.dashDirX, -this.dashDirZ);
    } else {
      // Neutral stick dashes forward, which is what players expect.
      this.dashDirX = Math.sin(this.facing);
      this.dashDirZ = -Math.cos(this.facing);
    }
    this.currentState = PLAYER_STATE.Dash;
    this.dashTimer = DASH_DURATION;
    this.dashCooldown = DASH_COOLDOWN;
  }

  /** Shortest-arc turn, frame-rate independent. */
  private turnToward(target: number, dt: number): void {
    let delta = target - this.facing;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.facing += delta * (1 - Math.exp(-TURN_K * dt));
  }

  /**
   * Past 45 deg, cancel the uphill component of motion and add a downhill push.
   * Cancelling rather than blocking is what makes a steep face feel like a slide
   * instead of an invisible wall.
   */
  private applySlope(dt: number): void {
    const nextX = this.position.x + this.velocity.x * dt;
    const nextZ = this.position.z + this.velocity.z * dt;
    if (this.terrain.slopeAt(nextX, nextZ) <= SLOPE_LIMIT) return;

    this.terrain.normalAt(nextX, nextZ, scratchNormal);
    // A surface normal's horizontal part points downhill.
    let downX = scratchNormal.x;
    let downZ = scratchNormal.z;
    const length = Math.sqrt(downX * downX + downZ * downZ);
    if (length < 1e-5) return;
    downX /= length;
    downZ /= length;

    const uphill = -(this.velocity.x * downX + this.velocity.z * downZ);
    if (uphill > 0) {
      this.velocity.x += downX * uphill;
      this.velocity.z += downZ * uphill;
    }
    this.velocity.x += downX * SLIDE_ACCEL * dt;
    this.velocity.z += downZ * SLIDE_ACCEL * dt;
  }

  /** Phase 2 replaces this with real world bounds (§5's cliffs and fog sea). */
  private clampToChunk(): void {
    const terrain = this.terrain;
    const minX = terrain.minX + CAPSULE_RADIUS;
    const maxX = terrain.maxX - CAPSULE_RADIUS;
    const minZ = terrain.minZ + CAPSULE_RADIUS;
    const maxZ = terrain.maxZ - CAPSULE_RADIUS;
    if (this.position.x < minX) {
      this.position.x = minX;
      this.velocity.x = 0;
    } else if (this.position.x > maxX) {
      this.position.x = maxX;
      this.velocity.x = 0;
    }
    if (this.position.z < minZ) {
      this.position.z = minZ;
      this.velocity.z = 0;
    } else if (this.position.z > maxZ) {
      this.position.z = maxZ;
      this.velocity.z = 0;
    }
  }

  private resolveProps(): void {
    this.propGroundY = Number.NEGATIVE_INFINITY;
    if (this.props.count === 0) return;
    const x = this.position.x;
    const z = this.position.z;
    const pad = CAPSULE_RADIUS + 0.1;
    this.props.query(x - pad, z - pad, x + pad, z + pad, this.visitProp);
  }

  /** Circle-vs-rect push-out along the axis of least penetration (§7). */
  private resolveProp(box: AABB): void {
    const feetY = this.position.y;
    const headY = feetY + CAPSULE_HEIGHT;

    // Standing on top: within step-up range counts as ground, not as a wall.
    if (box.maxY <= feetY + STEP_UP && box.maxY >= feetY - STEP_UP) {
      const nearestX = Math.min(Math.max(this.position.x, box.minX), box.maxX);
      const nearestZ = Math.min(Math.max(this.position.z, box.minZ), box.maxZ);
      const dx = this.position.x - nearestX;
      const dz = this.position.z - nearestZ;
      if (dx * dx + dz * dz <= CAPSULE_RADIUS * CAPSULE_RADIUS) {
        if (box.maxY > this.propGroundY) this.propGroundY = box.maxY;
      }
      return;
    }

    // No vertical overlap means no collision at all.
    if (box.maxY <= feetY || box.minY >= headY) return;

    const px = this.position.x;
    const pz = this.position.z;
    const nearestX = Math.min(Math.max(px, box.minX), box.maxX);
    const nearestZ = Math.min(Math.max(pz, box.minZ), box.maxZ);
    const dx = px - nearestX;
    const dz = pz - nearestZ;
    const distanceSq = dx * dx + dz * dz;

    if (distanceSq > 1e-8) {
      if (distanceSq >= CAPSULE_RADIUS * CAPSULE_RADIUS) return;
      const distance = Math.sqrt(distanceSq);
      const push = (CAPSULE_RADIUS - distance) / distance;
      this.position.x += dx * push;
      this.position.z += dz * push;
      // Kill only the velocity going into the surface, so sliding along walls works.
      const nx = dx / distance;
      const nz = dz / distance;
      const into = this.velocity.x * nx + this.velocity.z * nz;
      if (into < 0) {
        this.velocity.x -= nx * into;
        this.velocity.z -= nz * into;
      }
      return;
    }

    // Centre is inside the rect: eject through the closest face.
    const toMinX = px - box.minX + CAPSULE_RADIUS;
    const toMaxX = box.maxX - px + CAPSULE_RADIUS;
    const toMinZ = pz - box.minZ + CAPSULE_RADIUS;
    const toMaxZ = box.maxZ - pz + CAPSULE_RADIUS;
    const minPenetration = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
    if (minPenetration === toMinX) {
      this.position.x = box.minX - CAPSULE_RADIUS;
      if (this.velocity.x > 0) this.velocity.x = 0;
    } else if (minPenetration === toMaxX) {
      this.position.x = box.maxX + CAPSULE_RADIUS;
      if (this.velocity.x < 0) this.velocity.x = 0;
    } else if (minPenetration === toMinZ) {
      this.position.z = box.minZ - CAPSULE_RADIUS;
      if (this.velocity.z > 0) this.velocity.z = 0;
    } else {
      this.position.z = box.maxZ + CAPSULE_RADIUS;
      if (this.velocity.z < 0) this.velocity.z = 0;
    }
  }

  /**
   * Snap to the surface. Within STEP_UP this doubles as §7's automatic step-up:
   * small ledges are walked over, anything taller stays a wall.
   */
  private resolveGround(): void {
    const terrainY = this.terrain.heightAt(this.position.x, this.position.z);
    const ground = this.propGroundY > terrainY ? this.propGroundY : terrainY;
    this.groundY = ground;

    if (this.position.y <= ground + 1e-4) {
      this.position.y = ground;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.isGrounded = true;
      this.airTime = 0;
      return;
    }

    // Falling and close enough: stick to the surface instead of bouncing down slopes.
    if (this.velocity.y <= 0 && this.position.y - ground <= STEP_UP) {
      this.position.y = ground;
      this.velocity.y = 0;
      this.isGrounded = true;
      this.airTime = 0;
      return;
    }

    this.isGrounded = false;
  }

  private updateState(hasInput: boolean, sprintHeld: boolean, dt: number): void {
    if (this.currentState === PLAYER_STATE.Dash) return;

    if (!this.isGrounded) {
      // Drives coyote time, so it must accumulate real dt, not a hardcoded tick.
      this.airTime += dt;
      this.currentState = PLAYER_STATE.Air;
      return;
    }

    if (this.castTimer > 0) {
      this.currentState = PLAYER_STATE.Cast;
      return;
    }
    if (this.comboStageValue === 1) {
      this.currentState = PLAYER_STATE.Attack1;
      return;
    }
    if (this.comboStageValue === 2) {
      this.currentState = PLAYER_STATE.Attack2;
      return;
    }
    if (this.comboStageValue === 3) {
      this.currentState = PLAYER_STATE.Attack3;
      return;
    }

    if (hasInput && this.speed > 0.2) {
      this.currentState = sprintHeld ? PLAYER_STATE.Sprint : PLAYER_STATE.Move;
      return;
    }
    this.currentState = PLAYER_STATE.Idle;
  }

  // --- attack combo internals (§9) -----------------------------------------

  /** 0 = startup, 1 = active, 2 = recovery (cancel window). */
  private attackPhase(): number {
    const def = ATTACK_STAGES[this.comboStageValue - 1];
    if (def === undefined) return 2;
    if (this.attackTimer < def.startup) return 0;
    if (this.attackTimer < def.startup + def.active) return 1;
    return 2;
  }

  private startAttack(stage: number): void {
    const def = ATTACK_STAGES[stage - 1];
    if (def === undefined) return;
    this.comboStageValue = stage;
    this.attackTimer = 0;
    this.struckThisSwing = false;
    // §6.6 auto-aim: snap facing to the locked target at swing start. NaN means
    // no lock, keep the current facing.
    if (!Number.isNaN(this.aimYaw)) this.facing = this.aimYaw;
  }

  private cancelAttack(): void {
    this.comboStageValue = 0;
    this.attackTimer = 0;
  }

  private stepAttack(dt: number, now: number): void {
    const def = ATTACK_STAGES[this.comboStageValue - 1];
    if (def === undefined) {
      this.cancelAttack();
      return;
    }
    this.attackTimer += dt;

    // Strike exactly once, at the first tick inside the active phase.
    if (!this.struckThisSwing && this.attackTimer >= def.startup) {
      this.struckThisSwing = true;
      const strike = this.onStrike;
      if (strike !== undefined) {
        const sin = Math.sin(this.facing);
        const cos = Math.cos(this.facing);
        strike(
          this.comboStageValue,
          this.position.x + sin * def.reach,
          this.position.y + STRIKE_HEIGHT,
          this.position.z - cos * def.reach,
          def.radius,
          def.base,
          def.heavy,
          sin * def.knockback,
          -cos * def.knockback,
        );
      }
    }

    const total = def.startup + def.active + def.recovery;
    const activeDone = this.attackTimer >= def.startup + def.active;

    // §9's cancel window: a buffered press chains to the next stage once the
    // active phase ends. consumeBuffered only fires within §7's 0.12 s window,
    // so a press made mid-swing still needs to be recent — mashing works, one
    // early tap two swings ago does not.
    if (activeDone && this.comboStageValue < ATTACK_STAGES.length) {
      if (consumeBuffered(this.input, 'attackQueuedAt', now)) {
        this.startAttack(this.comboStageValue + 1);
        return;
      }
    }

    if (this.attackTimer >= total) this.cancelAttack();
  }

  /**
   * Enters the Cast state for `seconds` (Phase 4, §8.1's castTime). Refused
   * while dashing, staggered, down, or mid-swing — SkillRuntime checks first,
   * this is the belt to its braces. canMove=false roots the player like a swing.
   */
  beginCast(seconds: number, canMove: boolean): boolean {
    if (
      this.currentState === PLAYER_STATE.Dash ||
      this.currentState === PLAYER_STATE.Hit ||
      this.currentState === PLAYER_STATE.Down ||
      this.comboStageValue > 0
    ) {
      return false;
    }
    this.castTimer = seconds;
    this.castCanMove = canMove;
    if (!Number.isNaN(this.aimYaw)) this.facing = this.aimYaw;
    return true;
  }

  get casting(): boolean {
    return this.castTimer > 0;
  }

  // --- damage intake (Combatant, wired by the bootstrap) --------------------

  /** True while dash i-frames or post-hit i-frames are live. */
  get damageImmune(): boolean {
    return this.invulnerable || this.iframeTimer > 0;
  }

  get comboStage(): number {
    return this.comboStageValue;
  }

  get iframesLeft(): number {
    // The timer decrements past zero by up to one dt before the guard skips it;
    // clamp so debug consumers never see a phantom negative.
    return this.iframeTimer > 0 ? this.iframeTimer : 0;
  }

  /**
   * Applies already-mitigated damage. Returns what was applied — 0 while immune,
   * which is how dash-through-the-strike works (§9's i-frame promise).
   */
  applyDamage(amount: number, knockX: number, knockZ: number): number {
    if (!this.alive || this.damageImmune) return 0;
    this.stats.damage(amount);
    this.iframeTimer = HIT_IFRAME_SECONDS;
    this.cancelAttack();
    this.castTimer = 0;
    if (this.stats.hp <= 0) {
      this.currentState = PLAYER_STATE.Down;
      this.downTimer = DOWN_SECONDS;
      this.velocity.set(0, 0, 0);
      return amount;
    }
    this.currentState = PLAYER_STATE.Hit;
    this.hitTimer = HIT_STAGGER_SECONDS;
    this.velocity.x = knockX;
    this.velocity.z = knockZ;
    return amount;
  }

  get alive(): boolean {
    return this.currentState !== PLAYER_STATE.Down;
  }

  private respawn(): void {
    this.stats.reset();
    const y = this.terrain.heightAt(this.spawnX, this.spawnZ);
    this.position.set(this.spawnX, y, this.spawnZ);
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.currentState = PLAYER_STATE.Idle;
    this.iframeTimer = HIT_IFRAME_SECONDS;
    this.cancelAttack();
  }

  /** Mana and health live in PlayerStats; exposed here for the UI's convenience. */
  get statsRef(): PlayerStats {
    return this.stats;
  }
}
