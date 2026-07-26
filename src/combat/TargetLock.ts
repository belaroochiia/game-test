import * as THREE from 'three';

import type { System } from '../core/Engine';
import type { EnemyManager } from '../enemy/EnemyManager';
import type { PlayerController } from '../player/PlayerController';
import type { Combatant } from './CombatTypes';

/**
 * §6.6's soft target lock — the mobile aiming fix. Attacks and skills are
 * auto-aimed at the nearest living enemy inside a 40° cone / 15 u radius, so
 * the player never has to line up a shot with a thumb.
 *
 * The cone is measured from CAMERA yaw (what the player is LOOKING at), not the
 * player model's facing — the model trails the stick, and aiming with it feels
 * drunk. The apex sits at the player because 15 u is the player's reach.
 *
 * Stickiness is the feature, not a nicety: re-picking "nearest in cone" every
 * tick flickers between two enemies at similar range, which reads as broken.
 * Once locked, the target is KEPT until it dies, leaves 1.2x the radius, or
 * exits a wider 70° cone; only then does acquisition run again.
 */

export interface TargetLockOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  player: PlayerController;
  enemies: EnemyManager;
}

const ACQUIRE_RADIUS = 15; // §6.6
const KEEP_RADIUS = ACQUIRE_RADIUS * 1.2;
const ACQUIRE_RADIUS_SQ = ACQUIRE_RADIUS * ACQUIRE_RADIUS;
const KEEP_RADIUS_SQ = KEEP_RADIUS * KEEP_RADIUS;

/** §6.6's 40° full cone to acquire; a 70° full cone before a lock lets go. */
const ACQUIRE_COS = Math.cos((20 * Math.PI) / 180);
const KEEP_COS = Math.cos((35 * Math.PI) / 180);
const ACQUIRE_COS_SQ = ACQUIRE_COS * ACQUIRE_COS;
const KEEP_COS_SQ = KEEP_COS * KEEP_COS;

/** Standing on top of an enemy makes the cone degenerate — always inside. */
const TOUCH_DIST_SQ = 1e-4;

// Indicator ring: 16 theta segments x 1 phi = 32 tris, the contract's ceiling.
const RING_INNER = 0.34;
const RING_OUTER = 0.46;
const RING_SEGMENTS = 16;
const RING_COLOR = 0xffd45e;
const RING_OPACITY = 0.85;
/** Hover height above the target's crown. */
const HOVER = 0.4;
const SPIN_RATE = 1.6; // rad/s — gentle
const BOB_AMPLITUDE = 0.06;
const TWO_PI = Math.PI * 2;

/**
 * Ring position chase, written per rendered frame. EnemyBase does not expose a
 * prevPosition to interpolate against, so a short exponential chase is what
 * keeps the ring from juddering against the interpolated world; the constant is
 * per-frame like CameraRig's (render cadence, not tick cadence).
 */
const FOLLOW_BLEND = 1 - Math.exp(-22 / 60);

export class TargetLock implements System {
  readonly name = 'targetLock';

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly player: PlayerController;
  private readonly enemies: EnemyManager;

  private targetRef: Combatant | null = null;
  private yawValue = Number.NaN;

  /** Last valid horizontal camera forward, kept for degenerate frames. */
  private fwdX = 0;
  private fwdZ = -1;

  private spinPhase = 0;
  /** Snap (not chase) the ring on the next render — set on target switch. */
  private snapPending = true;

  private readonly ring: THREE.Mesh;
  private readonly ringGeometry: THREE.RingGeometry;
  private readonly ringMaterial: THREE.MeshBasicMaterial;

  constructor(options: TargetLockOptions) {
    this.scene = options.scene;
    this.camera = options.camera;
    this.player = options.player;
    this.enemies = options.enemies;

    this.ringGeometry = new THREE.RingGeometry(RING_INNER, RING_OUTER, RING_SEGMENTS);
    // Bake the lie-flat orientation so mesh yaw is free for the spin.
    this.ringGeometry.rotateX(-Math.PI / 2);
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: RING_COLOR,
      transparent: true,
      opacity: RING_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false, // never occludes; additive glow over anything behind it
      side: THREE.DoubleSide,
      fog: false, // an additive marker must not pick up fog colour
    });
    this.ring = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
    this.ring.visible = false;
    this.scene.add(this.ring);
  }

  /** Current target or null. Sticky — see the class comment. */
  get target(): Combatant | null {
    return this.targetRef;
  }

  get hasTarget(): boolean {
    return this.targetRef !== null;
  }

  /**
   * Yaw from the PLAYER to the target, player convention (yaw 0 faces -Z,
   * `atan2(dx, -dz)`) — feeds PlayerController.aimYaw directly. NaN when
   * nothing is locked, which is aimYaw's own "no lock" sentinel.
   */
  get yawToTarget(): number {
    return this.yawValue;
  }

  /** Allocation-free: scalar maths over the stable enemy array only. */
  update(dt: number): void {
    this.spinPhase += SPIN_RATE * dt;
    if (this.spinPhase >= TWO_PI) this.spinPhase -= TWO_PI;

    // Horizontal camera forward from the -Z basis column of matrixWorld. One
    // frame stale in update() — irrelevant for a selection cone with hysteresis.
    // Pitch is clamped at 60° (§7), so the horizontal part cannot degenerate,
    // but the identity-matrix first tick is guarded anyway.
    const m = this.camera.matrixWorld.elements;
    let fx = -(m[8] ?? 0);
    let fz = -(m[10] ?? 0);
    const forwardLength = Math.sqrt(fx * fx + fz * fz);
    if (forwardLength > 1e-4) {
      fx /= forwardLength;
      fz /= forwardLength;
      this.fwdX = fx;
      this.fwdZ = fz;
    } else {
      fx = this.fwdX;
      fz = this.fwdZ;
    }

    const px = this.player.position.x;
    const pz = this.player.position.z;

    // --- keep phase: hold the current lock inside the WIDE bounds -----------
    let target = this.targetRef;
    if (target !== null) {
      if (!target.alive) {
        target = null;
      } else {
        const dx = target.position.x - px;
        const dz = target.position.z - pz;
        const distSq = dx * dx + dz * dz;
        if (distSq > KEEP_RADIUS_SQ) {
          target = null;
        } else if (distSq > TOUCH_DIST_SQ) {
          const dot = dx * fx + dz * fz;
          if (dot <= 0 || dot * dot < KEEP_COS_SQ * distSq) target = null;
        }
      }
    }

    // --- acquire phase: only when unlocked, nearest inside the TIGHT cone ---
    if (target === null && this.enemies.aliveCount > 0) {
      const list = this.enemies.enemies;
      let bestSq = ACQUIRE_RADIUS_SQ;
      for (let i = 0; i < list.length; i++) {
        const enemy = list[i];
        if (enemy === undefined || !enemy.alive) continue;
        const dx = enemy.position.x - px;
        const dz = enemy.position.z - pz;
        const distSq = dx * dx + dz * dz;
        if (distSq >= bestSq) continue;
        if (distSq > TOUCH_DIST_SQ) {
          // dot² vs cos²·d² keeps the cone test sqrt-free per candidate.
          const dot = dx * fx + dz * fz;
          if (dot <= 0 || dot * dot < ACQUIRE_COS_SQ * distSq) continue;
        }
        bestSq = distSq;
        target = enemy;
      }
    }

    if (target !== this.targetRef) {
      this.targetRef = target;
      this.snapPending = true;
    }

    if (target !== null) {
      this.yawValue = Math.atan2(target.position.x - px, -(target.position.z - pz));
    } else {
      this.yawValue = Number.NaN;
    }
  }

  /** Ring transform lives here so it tracks the freshest positions per frame. */
  render(): void {
    const target = this.targetRef;
    const ring = this.ring;
    if (target === null || !target.alive) {
      if (ring.visible) ring.visible = false;
      return;
    }
    if (!ring.visible) ring.visible = true;

    const x = target.position.x;
    const y = target.position.y + target.height + HOVER + Math.sin(this.spinPhase * 2) * BOB_AMPLITUDE;
    const z = target.position.z;

    const position = ring.position;
    if (this.snapPending) {
      this.snapPending = false;
      position.set(x, y, z);
    } else {
      position.x += (x - position.x) * FOLLOW_BLEND;
      position.y += (y - position.y) * FOLLOW_BLEND;
      position.z += (z - position.z) * FOLLOW_BLEND;
    }
    ring.rotation.y = this.spinPhase;
  }

  reset(): void {
    this.targetRef = null;
    this.yawValue = Number.NaN;
    this.fwdX = 0;
    this.fwdZ = -1;
    this.spinPhase = 0;
    this.snapPending = true;
    this.ring.visible = false;
    this.ring.rotation.y = 0;
  }

  dispose(): void {
    this.scene.remove(this.ring);
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
  }
}
