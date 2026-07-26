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
const ATTACK_DURATION = 0.3;

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
  private attackTimer = 0;
  private dashDirX = 0;
  private dashDirZ = -1;

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
    this.prevPosition.copy(this.position);

    const input = this.input;
    const now = performance.now();

    if (this.dashCooldown > 0) this.dashCooldown -= dt;
    if (this.attackTimer > 0) this.attackTimer -= dt;

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

    // --- dash: buffered input (§7's 0.12 s) plus coyote time -----------------
    const canCoyoteDash = this.isGrounded || this.airTime < COYOTE_TIME;
    const dashRequested = consumeBuffered(input, 'dashQueuedAt', now);
    if (dashRequested && this.dashCooldown <= 0 && canCoyoteDash && this.currentState !== PLAYER_STATE.Dash) {
      this.startDash(wishX, wishZ, hasInput);
    }

    const attackRequested = consumeBuffered(input, 'attackQueuedAt', now);
    if (attackRequested && this.currentState !== PLAYER_STATE.Dash && this.attackTimer <= 0) {
      // Phase 3 replaces this stub with the real 3-hit combo (§9).
      this.attackTimer = ATTACK_DURATION;
    }

    // --- horizontal velocity ------------------------------------------------
    if (this.currentState === PLAYER_STATE.Dash) {
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

    if (this.attackTimer > 0) {
      this.currentState = PLAYER_STATE.Attack1;
      return;
    }

    if (hasInput && this.speed > 0.2) {
      this.currentState = sprintHeld ? PLAYER_STATE.Sprint : PLAYER_STATE.Move;
      return;
    }
    this.currentState = PLAYER_STATE.Idle;
  }

  /** Mana and health live in PlayerStats; exposed here for the UI's convenience. */
  get statsRef(): PlayerStats {
    return this.stats;
  }
}
