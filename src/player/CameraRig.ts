import * as THREE from 'three';

import type { System } from '../core/Engine';
import type { HeightSampler } from '../world/HeightField';
import type { AABB, SpatialHash } from '../world/SpatialHash';
import type { InputState } from './InputState';
import type { PlayerController } from './PlayerController';
import { PLAYER_STATE } from './PlayerController';

/**
 * §7's third-person orbit camera. Two things here are load-bearing for how the
 * game feels, and one is load-bearing for Phase 1's acceptance criterion:
 *
 * - The transform is written in `render(alpha)` from the player's interpolated
 *   position. Doing it in `update()` judders visibly on the 120 Hz phone this was
 *   measured on, because logic ticks at 60.
 * - All smoothing is `1 - exp(-k dt)`, so it behaves the same at any refresh rate.
 * - It must never end up under the ground. That is checked every frame by
 *   tools/playtest.mjs, so there is a marched sample AND a hard floor clamp.
 */

export interface CameraRigOptions {
  camera: THREE.PerspectiveCamera;
  target: PlayerController;
  terrain: HeightSampler;
  props: SpatialHash;
  input: InputState;
  sensitivity?: number;
  invertY?: boolean;
}

const DISTANCE = 6;
const HEIGHT_OFFSET = 1.6;
const PITCH_MIN = (-15 * Math.PI) / 180;
const PITCH_MAX = (60 * Math.PI) / 180;

const FOV_BASE = 65;
const FOV_SPRINT = 72;
/** §7 asks for a subtle 0.3 s ease; as an exponential that is time-to-90 %. */
const FOV_K = Math.LN10 / 0.3;

const FOLLOW_K = 12;
const DISTANCE_K = 10;

/** Clearance kept above the surface. The marcher aims for this; the clamp enforces it. */
const GROUND_CLEARANCE = 0.35;
/** Samples along the boom. 8 is plenty at 6 units and costs 8 analytic lookups. */
const MARCH_STEPS = 8;
const MIN_DISTANCE = 1.2;

const SHAKE_DECAY = 1.6;
const SHAKE_STRENGTH = 0.45;

const DEFAULT_SENSITIVITY = 0.005;

// Module-scope scratch (§13).
const desired = new THREE.Vector3();
const pivot = new THREE.Vector3();
const boom = new THREE.Vector3();
const sample = new THREE.Vector3();

export class CameraRig implements System {
  readonly name = 'camera';

  private readonly camera: THREE.PerspectiveCamera;
  private readonly target: PlayerController;
  private readonly terrain: HeightSampler;
  private readonly props: SpatialHash;
  private readonly input: InputState;

  private yawValue = 0;
  private pitchValue = (18 * Math.PI) / 180;
  private sensitivityValue: number;
  private invertYValue: boolean;

  /** Smoothed boom length, so pulling in and letting out is not a snap. */
  private distance = DISTANCE;
  private fov = FOV_BASE;

  private trauma = 0;
  private shakeSeed = 0;

  /** Smoothed pivot (the player's head), so the camera lags the body slightly. */
  private readonly smoothPivot = new THREE.Vector3();
  private pivotInitialised = false;

  /** Nearest allowed boom length found by the prop query this frame. */
  private propLimit = DISTANCE;
  private readonly visitProp: (box: AABB) => void;

  constructor(options: CameraRigOptions) {
    this.camera = options.camera;
    this.target = options.target;
    this.terrain = options.terrain;
    this.props = options.props;
    this.input = options.input;
    this.sensitivityValue = options.sensitivity ?? DEFAULT_SENSITIVITY;
    this.invertYValue = options.invertY ?? false;

    this.visitProp = (box: AABB): void => {
      this.limitByProp(box);
    };

    this.camera.fov = FOV_BASE;
    this.camera.updateProjectionMatrix();
  }

  get yaw(): number {
    return this.yawValue;
  }

  get pitch(): number {
    return this.pitchValue;
  }

  addTrauma(amount: number): void {
    this.trauma += amount;
    if (this.trauma > 1) this.trauma = 1;
  }

  setSensitivity(value: number): void {
    if (value > 0) this.sensitivityValue = value;
  }

  setInvertY(value: boolean): void {
    this.invertYValue = value;
  }

  update(dt: number): void {
    const input = this.input;

    // Consume the swipe exactly once (§6.2).
    this.yawValue -= input.lookDX * this.sensitivityValue;
    const pitchDelta = input.lookDY * this.sensitivityValue * (this.invertYValue ? -1 : 1);
    this.pitchValue += pitchDelta;
    input.lookDX = 0;
    input.lookDY = 0;

    if (this.pitchValue < PITCH_MIN) this.pitchValue = PITCH_MIN;
    else if (this.pitchValue > PITCH_MAX) this.pitchValue = PITCH_MAX;

    // Keep yaw bounded so the float never drifts into precision trouble.
    if (this.yawValue > Math.PI) this.yawValue -= Math.PI * 2;
    else if (this.yawValue < -Math.PI) this.yawValue += Math.PI * 2;

    // Sprint FOV — a free sense of speed (§7).
    const state = this.target.state;
    const wantsWide = state === PLAYER_STATE.Sprint || state === PLAYER_STATE.Dash;
    const targetFov = wantsWide ? FOV_SPRINT : FOV_BASE;
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-FOV_K * dt));

    if (this.trauma > 0) {
      this.trauma -= SHAKE_DECAY * dt;
      if (this.trauma < 0) this.trauma = 0;
    }
    this.shakeSeed += dt;
  }

  render(alpha: number): void {
    const player = this.target;
    const previous = player.prevPosition;
    const current = player.position;

    // Interpolated feet position, plus the head offset, is what the camera orbits.
    pivot.set(
      previous.x + (current.x - previous.x) * alpha,
      previous.y + (current.y - previous.y) * alpha + HEIGHT_OFFSET,
      previous.z + (current.z - previous.z) * alpha,
    );

    if (!this.pivotInitialised) {
      this.smoothPivot.copy(pivot);
      this.pivotInitialised = true;
    } else {
      // Frame-time here is the render delta; alpha-driven smoothing would be
      // rate-dependent, so derive dt from the fixed tick and the frame's alpha.
      const blend = 1 - Math.exp(-FOLLOW_K * (1 / 60));
      this.smoothPivot.x += (pivot.x - this.smoothPivot.x) * blend;
      this.smoothPivot.y += (pivot.y - this.smoothPivot.y) * blend;
      this.smoothPivot.z += (pivot.z - this.smoothPivot.z) * blend;
    }

    // Boom direction from yaw/pitch, pointing from the pivot back to the camera.
    const cosPitch = Math.cos(this.pitchValue);
    boom.set(
      Math.sin(this.yawValue) * cosPitch,
      Math.sin(this.pitchValue),
      Math.cos(this.yawValue) * cosPitch,
    );

    const allowed = this.findAllowedDistance();
    const blend = 1 - Math.exp(-DISTANCE_K * (1 / 60));
    // Pull in immediately, let out smoothly: a slow pull-in clips through geometry.
    this.distance = allowed < this.distance ? allowed : this.distance + (allowed - this.distance) * blend;

    desired.set(
      this.smoothPivot.x + boom.x * this.distance,
      this.smoothPivot.y + boom.y * this.distance,
      this.smoothPivot.z + boom.z * this.distance,
    );

    // Hard floor. The marcher above is an approximation over 8 samples; this is the
    // guarantee that the camera is never under the ground, which is half of §12's
    // Phase 1 acceptance criterion.
    const groundY = this.terrain.heightAt(desired.x, desired.z) + GROUND_CLEARANCE;
    if (desired.y < groundY) desired.y = groundY;

    this.camera.position.copy(desired);
    this.camera.lookAt(this.smoothPivot.x, this.smoothPivot.y, this.smoothPivot.z);

    // Shake is an offset applied after the look-at, so it never feeds back into
    // the smoothed base position (§7 is explicit about this).
    if (this.trauma > 0) {
      const magnitude = this.trauma * this.trauma * SHAKE_STRENGTH;
      const t = this.shakeSeed * 37;
      this.camera.position.x += Math.sin(t * 1.7) * magnitude;
      this.camera.position.y += Math.sin(t * 2.3 + 1.1) * magnitude;
      this.camera.position.z += Math.sin(t * 1.9 + 2.7) * magnitude;
    }

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  reset(): void {
    this.yawValue = 0;
    this.pitchValue = (18 * Math.PI) / 180;
    this.distance = DISTANCE;
    this.fov = FOV_BASE;
    this.trauma = 0;
    this.shakeSeed = 0;
    this.pivotInitialised = false;
    this.camera.fov = FOV_BASE;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Walks out along the boom and stops at the first sample that would put the
   * camera inside terrain, then lets props shorten it further. Cheap by design:
   * §13 rules out a physics sphere-cast, and 8 analytic height lookups is nothing.
   */
  private findAllowedDistance(): number {
    let allowed = DISTANCE;

    for (let step = 1; step <= MARCH_STEPS; step++) {
      const t = (DISTANCE * step) / MARCH_STEPS;
      sample.set(
        this.smoothPivot.x + boom.x * t,
        this.smoothPivot.y + boom.y * t,
        this.smoothPivot.z + boom.z * t,
      );
      const surface = this.terrain.heightAt(sample.x, sample.z) + GROUND_CLEARANCE;
      if (sample.y < surface) {
        // Stop just short of the offending sample.
        allowed = (DISTANCE * (step - 1)) / MARCH_STEPS;
        break;
      }
    }

    this.propLimit = allowed;
    if (this.props.count > 0) {
      const x0 = Math.min(this.smoothPivot.x, this.smoothPivot.x + boom.x * allowed);
      const x1 = Math.max(this.smoothPivot.x, this.smoothPivot.x + boom.x * allowed);
      const z0 = Math.min(this.smoothPivot.z, this.smoothPivot.z + boom.z * allowed);
      const z1 = Math.max(this.smoothPivot.z, this.smoothPivot.z + boom.z * allowed);
      this.props.query(x0 - 0.3, z0 - 0.3, x1 + 0.3, z1 + 0.3, this.visitProp);
      allowed = this.propLimit;
    }

    return allowed < MIN_DISTANCE ? MIN_DISTANCE : allowed;
  }

  /** Shortens the boom to the first sample that lands inside this box. */
  private limitByProp(box: AABB): void {
    for (let step = 1; step <= MARCH_STEPS; step++) {
      const t = (this.propLimit * step) / MARCH_STEPS;
      const x = this.smoothPivot.x + boom.x * t;
      const y = this.smoothPivot.y + boom.y * t;
      const z = this.smoothPivot.z + boom.z * t;
      if (x < box.minX || x > box.maxX) continue;
      if (z < box.minZ || z > box.maxZ) continue;
      if (y < box.minY || y > box.maxY) continue;
      const limit = (this.propLimit * (step - 1)) / MARCH_STEPS;
      if (limit < this.propLimit) this.propLimit = limit;
      return;
    }
  }
}
