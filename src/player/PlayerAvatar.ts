import * as THREE from 'three';

import type { PlayerState } from './PlayerController';
import { PLAYER_STATE } from './PlayerController';

/**
 * §5's blocky procedural character — and, just as importantly, the seam §5 asks
 * for: "code must be separated so switching to a rigged GLTF is one adapter
 * class". Anything that wants to drive a character talks to `Avatar`, never to
 * `BlockyAvatar`, so a future `GltfAvatar` drops in with no other edits.
 */

export interface AvatarState {
  /** Feet position, already interpolated by the caller. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Horizontal speed in u/s — drives the walk cycle. */
  speed: number;
  grounded: boolean;
  state: PlayerState;
}

export interface Avatar {
  readonly root: THREE.Object3D;
  apply(state: AvatarState, alpha: number): void;
  reset(): void;
  dispose(): void;
}

// Proportions, summing to exactly 1.8 so the visual matches §7's capsule.
const LEG_LENGTH = 0.8;
const TORSO_HEIGHT = 0.65;
const HEAD_SIZE = 0.35;
const HIP_Y = LEG_LENGTH;
const SHOULDER_Y = HIP_Y + TORSO_HEIGHT * 0.88;
const ARM_LENGTH = 0.6;

/** World distance per step. Phase is advanced by distance, so feet never skate. */
const STRIDE = 0.85;
const SWING_AT_WALK = 0.55;
const SWING_AT_SPRINT = 0.85;
const BOB_HEIGHT = 0.055;

const COLOR_SKIN = 0xe8b98c;
const COLOR_TUNIC = 0x4a6fa5;
const COLOR_TRIM = 0x2f4870;
const COLOR_LEG = 0x3b3f4a;

const scratchColor = new THREE.Color();

/**
 * One material for the whole character (§5's budget) with per-part colour baked
 * into each box's vertex colours — different colours, still a single program.
 */
function coloredBox(
  width: number,
  height: number,
  depth: number,
  hex: number,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  scratchColor.setHex(hex);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = scratchColor.r;
    colors[i * 3 + 1] = scratchColor.g;
    colors[i * 3 + 2] = scratchColor.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export class BlockyAvatar implements Avatar {
  readonly root: THREE.Object3D;

  private readonly material: THREE.MeshLambertMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];

  /** Pivot groups, so a rotation happens at the hip/shoulder rather than the centre. */
  private readonly body: THREE.Object3D;
  private readonly torso: THREE.Object3D;
  private readonly legLeft: THREE.Object3D;
  private readonly legRight: THREE.Object3D;
  private readonly armLeft: THREE.Object3D;
  private readonly armRight: THREE.Object3D;

  private phase = 0;
  private lastX = 0;
  private lastZ = 0;
  private hasLast = false;
  private clock = 0;
  private lastNow = 0;
  private lean = 0;
  /** Seconds since the current attack state was entered; drives the swing pose. */
  private attackClock = 0;
  private lastState: PlayerState = PLAYER_STATE.Idle;

  constructor() {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

    this.root = new THREE.Object3D();
    this.root.name = 'playerAvatar';

    // `body` carries the bob and the yaw so the feet stay planted on `root`.
    this.body = new THREE.Object3D();
    this.root.add(this.body);

    this.torso = new THREE.Object3D();
    this.torso.position.y = HIP_Y;
    this.body.add(this.torso);

    const torsoGeo = coloredBox(0.52, TORSO_HEIGHT, 0.3, COLOR_TUNIC);
    const torsoMesh = new THREE.Mesh(torsoGeo, this.material);
    torsoMesh.position.y = TORSO_HEIGHT * 0.5;
    this.torso.add(torsoMesh);
    this.geometries.push(torsoGeo);

    const beltGeo = coloredBox(0.56, 0.1, 0.34, COLOR_TRIM);
    const beltMesh = new THREE.Mesh(beltGeo, this.material);
    beltMesh.position.y = 0.06;
    this.torso.add(beltMesh);
    this.geometries.push(beltGeo);

    const headGeo = coloredBox(HEAD_SIZE, HEAD_SIZE, HEAD_SIZE, COLOR_SKIN);
    const headMesh = new THREE.Mesh(headGeo, this.material);
    headMesh.position.y = TORSO_HEIGHT + HEAD_SIZE * 0.5;
    this.torso.add(headMesh);
    this.geometries.push(headGeo);

    const armGeo = coloredBox(0.14, ARM_LENGTH, 0.16, COLOR_TUNIC);
    this.geometries.push(armGeo);
    this.armLeft = new THREE.Object3D();
    this.armLeft.position.set(-0.33, SHOULDER_Y - HIP_Y, 0);
    const armLeftMesh = new THREE.Mesh(armGeo, this.material);
    armLeftMesh.position.y = -ARM_LENGTH * 0.5;
    this.armLeft.add(armLeftMesh);
    this.torso.add(this.armLeft);

    this.armRight = new THREE.Object3D();
    this.armRight.position.set(0.33, SHOULDER_Y - HIP_Y, 0);
    const armRightMesh = new THREE.Mesh(armGeo, this.material);
    armRightMesh.position.y = -ARM_LENGTH * 0.5;
    this.armRight.add(armRightMesh);
    this.torso.add(this.armRight);

    const legGeo = coloredBox(0.18, LEG_LENGTH, 0.2, COLOR_LEG);
    this.geometries.push(legGeo);
    this.legLeft = new THREE.Object3D();
    this.legLeft.position.set(-0.13, HIP_Y, 0);
    const legLeftMesh = new THREE.Mesh(legGeo, this.material);
    legLeftMesh.position.y = -LEG_LENGTH * 0.5;
    this.legLeft.add(legLeftMesh);
    this.body.add(this.legLeft);

    this.legRight = new THREE.Object3D();
    this.legRight.position.set(0.13, HIP_Y, 0);
    const legRightMesh = new THREE.Mesh(legGeo, this.material);
    legRightMesh.position.y = -LEG_LENGTH * 0.5;
    this.legRight.add(legRightMesh);
    this.body.add(this.legRight);
  }

  /**
   * Runs every rendered frame — up to 120 Hz on the target device — so it only
   * ever writes scalars into existing objects (§13).
   */
  apply(state: AvatarState, _alpha: number): void {
    const now = performance.now();
    if (this.lastNow === 0) this.lastNow = now;
    let frameDt = (now - this.lastNow) * 0.001;
    this.lastNow = now;
    if (frameDt < 0) frameDt = 0;
    else if (frameDt > 0.1) frameDt = 0.1;
    this.clock += frameDt;

    this.root.position.set(state.x, state.y, state.z);
    this.root.rotation.y = state.yaw;

    // Advance the cycle by distance actually travelled, not by time: at half speed
    // the legs take half as many steps over the same ground, so nothing skates.
    if (this.hasLast) {
      const dx = state.x - this.lastX;
      const dz = state.z - this.lastZ;
      const travelled = Math.sqrt(dx * dx + dz * dz);
      this.phase += (travelled / STRIDE) * Math.PI;
    }
    this.lastX = state.x;
    this.lastZ = state.z;
    this.hasLast = true;
    if (this.phase > Math.PI * 4) this.phase -= Math.PI * 4;

    const speed = state.speed;
    const moving = speed > 0.25;
    const sprinting = state.state === PLAYER_STATE.Sprint;
    const dashing = state.state === PLAYER_STATE.Dash;

    if (state.state !== this.lastState) {
      this.attackClock = 0;
      this.lastState = state.state;
    } else {
      this.attackClock += frameDt;
    }

    // Attack poses (§9): wall-time is fine here — the swing is 0.4 s of pure
    // presentation and never moves the feet, so nothing can skate.
    const stage =
      state.state === PLAYER_STATE.Attack1
        ? 1
        : state.state === PLAYER_STATE.Attack2
          ? 2
          : state.state === PLAYER_STATE.Attack3
            ? 3
            : 0;
    if (stage > 0) {
      // Wind up briefly, then whip through: a two-part curve reads as a swing
      // even on 6 boxes. Stage 2 mirrors; stage 3 is both arms overhead.
      const t = this.attackClock;
      const wind = Math.min(1, t / 0.08);
      const through = t <= 0.08 ? 0 : Math.min(1, (t - 0.08) / 0.14);
      const swing = -0.9 * wind + 2.1 * through;
      if (stage === 1) {
        this.armRight.rotation.x = -1.2 + swing;
        this.armLeft.rotation.x = 0.25 - through * 0.4;
      } else if (stage === 2) {
        this.armLeft.rotation.x = -1.2 + swing;
        this.armRight.rotation.x = 0.25 - through * 0.4;
      } else {
        this.armLeft.rotation.x = -2.2 + swing * 1.15;
        this.armRight.rotation.x = -2.2 + swing * 1.15;
      }
      this.torso.rotation.x = 0.12 + through * 0.14;
      this.legLeft.rotation.x = 0.18;
      this.legRight.rotation.x = -0.18;
      this.body.position.y = 0;
      return;
    }

    if (state.state === PLAYER_STATE.Hit) {
      // Recoil: torso thrown back, arms up. Held for the stagger's 0.25 s.
      this.torso.rotation.x = -0.32;
      this.armLeft.rotation.x = -0.7;
      this.armRight.rotation.x = -0.7;
      this.legLeft.rotation.x = -0.12;
      this.legRight.rotation.x = 0.2;
      this.body.position.y = 0;
      return;
    }

    if (state.state === PLAYER_STATE.Down) {
      // Collapsed: the whole body pitches to the ground plane.
      this.torso.rotation.x = 1.35;
      this.armLeft.rotation.x = 0.5;
      this.armRight.rotation.x = 0.5;
      this.legLeft.rotation.x = 1.2;
      this.legRight.rotation.x = 1.1;
      this.body.position.y = -0.55;
      return;
    }

    let targetLean = 0;
    if (dashing) targetLean = 0.42;
    else if (sprinting) targetLean = 0.2;
    else if (moving) targetLean = 0.07;
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-9 * frameDt));
    this.torso.rotation.x = this.lean;

    if (!state.grounded) {
      // Tucked legs read instantly as "off the ground".
      this.legLeft.rotation.x = -0.75;
      this.legRight.rotation.x = -0.35;
      this.armLeft.rotation.x = -0.5;
      this.armRight.rotation.x = -0.5;
      this.body.position.y = 0;
      return;
    }

    if (dashing) {
      // A stretched pose: trailing leg back, leading leg forward, arms swept.
      this.legLeft.rotation.x = 0.85;
      this.legRight.rotation.x = -0.7;
      this.armLeft.rotation.x = -0.9;
      this.armRight.rotation.x = -1.05;
      this.body.position.y = 0.04;
      return;
    }

    if (moving) {
      const swing = sprinting ? SWING_AT_SPRINT : SWING_AT_WALK;
      const swingScale = Math.min(1, speed / 4);
      const amount = swing * swingScale;
      const s = Math.sin(this.phase);
      this.legLeft.rotation.x = s * amount;
      this.legRight.rotation.x = -s * amount;
      // Arms counter-swing against the legs, which is what sells a walk.
      this.armLeft.rotation.x = -s * amount * 0.75;
      this.armRight.rotation.x = s * amount * 0.75;
      // Bob peaks twice per cycle, at each footfall.
      this.body.position.y = Math.abs(Math.sin(this.phase)) * BOB_HEIGHT * swingScale;
      return;
    }

    // Idle: a small breath. A perfectly static character reads as broken.
    const breath = Math.sin(this.clock * 1.9);
    this.legLeft.rotation.x = 0;
    this.legRight.rotation.x = 0;
    this.armLeft.rotation.x = breath * 0.045;
    this.armRight.rotation.x = breath * 0.045;
    this.body.position.y = breath * 0.012;
  }

  reset(): void {
    this.phase = 0;
    this.hasLast = false;
    this.clock = 0;
    this.lastNow = 0;
    this.lean = 0;
    this.torso.rotation.x = 0;
    this.legLeft.rotation.x = 0;
    this.legRight.rotation.x = 0;
    this.armLeft.rotation.x = 0;
    this.armRight.rotation.x = 0;
    this.body.position.y = 0;
  }

  dispose(): void {
    for (let i = 0; i < this.geometries.length; i++) {
      this.geometries[i]?.dispose();
    }
    this.geometries.length = 0;
    this.material.dispose();
  }
}
