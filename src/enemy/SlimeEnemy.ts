import * as THREE from 'three';

import type { HeightSampler } from '../world/HeightField';
import { LUNGE_DISTANCE, STRIKE_RADIUS } from './AIBrain';
import { EnemyBase } from './EnemyBase';
import type { EnemyDef } from './EnemyBase';

/**
 * Phase 3's one enemy. All feel, no VFX (§12): the hop IS the walk cycle —
 * squash on landing, stretch mid-air, driven by the distance EnemyBase actually
 * integrated, never wall time, so slimes can no more skate than the player's
 * legs can. A hop reads at 20 m on a phone where a walk cycle would not.
 *
 * GPU cost per slime: one 80-tri blob + one 24-tri telegraph ring, ONE shared
 * vertex-coloured MeshLambertMaterial across every slime and one shared additive
 * ring material — two materials total for the whole enemy population (§3's 12).
 */

export const SLIME_DEF: EnemyDef = {
  kind: 'slime',
  maxHp: 40,
  armor: 0,
  contactDamage: 8,
  moveSpeed: 2.6,
  aggroRadius: 11,
  attackRadius: 2.2,
  telegraphSeconds: 0.55,
  attackRecoverSeconds: 0.8,
  respawnSeconds: 12,
  xp: 8,
};

export interface SlimeEnemyOptions {
  id: number;
  field: HeightSampler;
  homeX: number;
  homeZ: number;
  seed: number;
}

const BLOB_RADIUS = 0.55;
/** Pre-squash so the rest pose already reads "blob", not "sphere". */
const BLOB_SQUASH = 0.85;
/** Soft-flatten below this local height — a sitting base, not a ball contact point. */
const BLOB_BOTTOM = -0.19;
const COLOR_LOW = 0x2e8a4d;
const COLOR_HIGH = 0x9fe97b;
/** Per-face brightness variation — large flat facets read as plastic without it (§5). */
const FACE_JITTER_BASE = 0.93;
const FACE_JITTER_SPAN = 0.14;

/** World units per hop; one squash-stretch cycle per hop. */
const HOP_LENGTH = 1.15;
const HOP_HEIGHT = 0.34;
/** Grounded (landing squash) and apex (air stretch) Y scales of the hop cycle. */
const SQUASH_Y = 0.78;
const STRETCH_Y = 1.16;
/** Pose smoothing time-to-90 % ~77 ms — kills mode-switch pops, keeps landings crisp. */
const POSE_K = 30;
/** Telegraph: wind down like a compressed spring; the strike is the release. */
const TELEGRAPH_SQUASH = 0.38;
const TELEGRAPH_SPREAD = 0.32;
const TELEGRAPH_TREMBLE_HZ = 42;
const STRIKE_HOP_HEIGHT = 0.3;
/** Death: pancake over 0.35 s, hold a beat, hide. The timing carries it — no VFX. */
const DEATH_PANCAKE_SECONDS = 0.35;
const DEATH_HIDE_SECONDS = 0.7;
const DEATH_SCALE_Y = 0.07;
const DEATH_SCALE_XZ = 1.85;
const RING_LIFT = 0.05;
const RING_MIN_SCALE = 0.06;

const scratchColorA = new THREE.Color();
const scratchColorB = new THREE.Color();

interface SlimeAssets {
  blobGeometry: THREE.BufferGeometry;
  blobMaterial: THREE.MeshLambertMaterial;
  ringGeometry: THREE.BufferGeometry;
  ringMaterial: THREE.MeshBasicMaterial;
  refs: number;
}

let assets: SlimeAssets | null = null;

/**
 * Icosphere blob, vertex-coloured green gradient, feet at local origin so
 * scaling squashes about the ground plane — a landing squash that lifted the
 * feet would break the ground contact illusion.
 */
function buildBlobGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(BLOB_RADIUS, 1); // 80 tris, soup
  const positions = geometry.getAttribute('position');
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < positions.count; i++) {
    let y = positions.getY(i) * BLOB_SQUASH;
    if (y < BLOB_BOTTOM) y = BLOB_BOTTOM + (y - BLOB_BOTTOM) * 0.35;
    positions.setY(i, y);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  geometry.translate(0, -minY, 0);
  const span = maxY - minY;

  scratchColorA.setHex(COLOR_LOW);
  scratchColorB.setHex(COLOR_HIGH);
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    let t = span > 0 ? positions.getY(i) / span : 0;
    t = t * t * (3 - 2 * t);
    // Same jitter for all 3 corners of a face => flat facet tint, not noise.
    const face = (i / 3) | 0;
    const hash = ((Math.imul(face + 1, 2654435761) >>> 16) & 255) / 255;
    const jitter = FACE_JITTER_BASE + hash * FACE_JITTER_SPAN;
    colors[i * 3] = (scratchColorA.r + (scratchColorB.r - scratchColorA.r) * t) * jitter;
    colors[i * 3 + 1] = (scratchColorA.g + (scratchColorB.g - scratchColorA.g) * t) * jitter;
    colors[i * 3 + 2] = (scratchColorA.b + (scratchColorB.b - scratchColorA.b) * t) * jitter;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function acquireAssets(): SlimeAssets {
  if (assets === null) {
    // Unit-radius ring lying flat (+Y normal); per-slime meshes scale it.
    const ringGeometry = new THREE.RingGeometry(0.82, 1, 12, 1); // 24 tris
    ringGeometry.rotateX(-Math.PI / 2);
    assets = {
      blobGeometry: buildBlobGeometry(),
      blobMaterial: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      ringGeometry,
      ringMaterial: new THREE.MeshBasicMaterial({
        color: 0xff6a3c,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      refs: 0,
    };
  }
  assets.refs++;
  return assets;
}

function releaseAssets(): void {
  if (assets === null) return;
  assets.refs--;
  if (assets.refs > 0) return;
  assets.blobGeometry.dispose();
  assets.blobMaterial.dispose();
  assets.ringGeometry.dispose();
  assets.ringMaterial.dispose();
  assets = null;
}

export class SlimeEnemy extends EnemyBase {
  readonly radius = 0.5;
  readonly height = 0.9;
  readonly root: THREE.Group;

  private readonly blob: THREE.Mesh;
  /** The slime's own pooled telegraph ring — NOT agent C's TargetLock ring. */
  private readonly ring: THREE.Mesh;

  private hopPhase = 0;
  private lastX = 0;
  private lastZ = 0;
  private hasLast = false;
  private lastNow = 0;
  private clock = 0;
  /** 0 idle .. 1 hopping — blends the breath pose into the hop pose. */
  private moveBlend = 0;
  private curScaleY = 1;
  private curScaleXZ = 1;
  /** Pose at the moment of death, so the pancake starts from it, not from 1. */
  private deathFromY = 1;
  private deathFromXZ = 1;

  constructor(options: SlimeEnemyOptions) {
    super({
      id: options.id,
      def: SLIME_DEF,
      field: options.field,
      homeX: options.homeX,
      homeZ: options.homeZ,
      seed: options.seed,
    });
    const shared = acquireAssets();

    // Root stays axis-aligned at the feet; only the blob rotates. The ring can
    // then be placed in world-aligned local space with no basis change.
    this.root = new THREE.Group();
    this.root.name = 'slime';
    this.blob = new THREE.Mesh(shared.blobGeometry, shared.blobMaterial);
    this.ring = new THREE.Mesh(shared.ringGeometry, shared.ringMaterial);
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    this.root.add(this.blob);
    this.root.add(this.ring);
    this.root.position.copy(this.position);
  }

  /**
   * Runs every rendered frame. Only scalar writes into existing objects (§13).
   * Everything timing-critical (hit jiggle, death, strike) is driven by SIM
   * time from EnemyBase, so hitstop freezes the pose — the freeze is the feel.
   */
  applyVisual(x: number, y: number, z: number, yaw: number): void {
    this.root.position.set(x, y, z);
    const blob = this.blob;
    blob.rotation.y = yaw;

    // Own frame clock (render rate != tick rate) — PlayerAvatar's pattern.
    const now = performance.now();
    if (this.lastNow === 0) this.lastNow = now;
    let fdt = (now - this.lastNow) * 0.001;
    this.lastNow = now;
    if (fdt < 0) fdt = 0;
    else if (fdt > 0.1) fdt = 0.1;
    this.clock += fdt;

    // Distance actually covered on screen — the only thing that advances the hop.
    let travelled = 0;
    if (this.hasLast) {
      const dx = x - this.lastX;
      const dz = z - this.lastZ;
      travelled = Math.sqrt(dx * dx + dz * dz);
    }
    this.lastX = x;
    this.lastZ = z;
    this.hasLast = true;

    if (!this.alive) {
      this.applyDeath();
      return;
    }

    const brain = this.brain;

    // Telegraph ring: grows from zero to the true strike area over the wind-up —
    // area and timing in one shape (§9). Centred on the lunge's landing point.
    if (brain.telegraphing) {
      const ring = this.ring;
      ring.visible = true;
      const cx = x + brain.aimX * LUNGE_DISTANCE;
      const cz = z + brain.aimZ * LUNGE_DISTANCE;
      ring.position.set(cx - x, this.groundAt(cx, cz) - y + RING_LIFT, cz - z);
      const scale = STRIKE_RADIUS * Math.max(RING_MIN_SCALE, brain.telegraphProgress);
      ring.scale.set(scale, 1, scale);
    } else {
      this.ring.visible = false;
    }

    let targetY: number;
    let targetXZ: number;
    let hopLift = 0;
    let zStretch = 1;

    if (brain.telegraphing) {
      // Wind down like a compressed spring; tremble sells the charge.
      const p = brain.telegraphProgress;
      targetY = 1 - TELEGRAPH_SQUASH * p;
      targetXZ = 1 + TELEGRAPH_SPREAD * p + Math.sin(this.clock * TELEGRAPH_TREMBLE_HZ) * 0.03 * p;
      this.hopPhase = 0; // strike hop launches from the ground
      this.moveBlend = 0;
    } else if (this.striking) {
      const p = this.strikeProgress;
      hopLift = Math.sin(p * Math.PI) * STRIKE_HOP_HEIGHT;
      targetY = 1.28;
      targetXZ = 0.86;
      zStretch = 1.18; // stretched along the lunge — blob yaw faces it already
    } else {
      const speed = fdt > 1e-4 ? travelled / fdt : 0;
      const moving = speed > 0.3;
      this.moveBlend += ((moving ? 1 : 0) - this.moveBlend) * (1 - Math.exp(-10 * fdt));
      if (moving) {
        this.hopPhase += travelled / HOP_LENGTH;
        if (this.hopPhase > 1e6) this.hopPhase -= 1e6; // keep the float precise
      } else {
        // Settle onto the nearest landing — a blob must never hang mid-air.
        const settle = Math.round(this.hopPhase);
        this.hopPhase += (settle - this.hopPhase) * (1 - Math.exp(-14 * fdt));
      }
      const air = Math.abs(Math.sin(this.hopPhase * Math.PI)); // 0 ground, 1 apex
      hopLift = air * HOP_HEIGHT * this.moveBlend;
      const hopY = SQUASH_Y + (STRETCH_Y - SQUASH_Y) * air;
      const hopXZ = 1 + (1 - hopY) * 0.55; // rough volume preservation
      const breath = Math.sin(this.clock * 2.1);
      const idleY = 1 + breath * 0.035;
      const idleXZ = 1 - breath * 0.025;
      targetY = idleY + (hopY - idleY) * this.moveBlend;
      targetXZ = idleXZ + (hopXZ - idleXZ) * this.moveBlend;
    }

    // Hit jiggle rides on any pose; hitAmount is sim time, so hitstop holds it.
    const hit = this.hitAmount;
    if (hit > 0) {
      targetY *= 1 - 0.22 * hit;
      targetXZ *= 1 + 0.26 * hit;
    }

    const blendK = 1 - Math.exp(-POSE_K * fdt);
    this.curScaleY += (targetY - this.curScaleY) * blendK;
    this.curScaleXZ += (targetXZ - this.curScaleXZ) * blendK;
    blob.scale.set(this.curScaleXZ, this.curScaleY, this.curScaleXZ * zStretch);
    blob.position.y = hopLift;
    if (!blob.visible) blob.visible = true;
  }

  dispose(): void {
    releaseAssets();
  }

  protected onDamagedHook(_heavy: boolean): void {
    // Jiggle and knock are handled by hitAmount / EnemyBase; nothing extra.
  }

  protected onDiedHook(): void {
    this.deathFromY = this.curScaleY;
    this.deathFromXZ = this.curScaleXZ;
    this.ring.visible = false;
  }

  protected onRespawnedHook(): void {
    this.blob.visible = true;
    this.ring.visible = false;
    this.curScaleY = 1;
    this.curScaleXZ = 1;
    this.hopPhase = 0;
    this.moveBlend = 0;
    this.hasLast = false;
    this.blob.scale.set(1, 1, 1);
    this.blob.position.y = 0;
    this.root.position.copy(this.position);
  }

  protected onActiveChangedHook(active: boolean): void {
    this.root.visible = active;
    if (active) this.hasLast = false; // no phantom hop from the reactivation jump
  }

  /** deadFor is sim time — a mid-hitstop kill holds its freeze like everything else. */
  private applyDeath(): void {
    this.ring.visible = false;
    const blob = this.blob;
    const t = this.deadFor;
    if (t >= DEATH_HIDE_SECONDS) {
      blob.visible = false;
      return;
    }
    blob.visible = true;
    let p = t / DEATH_PANCAKE_SECONDS;
    if (p > 1) p = 1;
    p = 1 - (1 - p) * (1 - p); // ease-out: fast collapse, soft settle
    this.curScaleY = this.deathFromY + (DEATH_SCALE_Y - this.deathFromY) * p;
    this.curScaleXZ = this.deathFromXZ + (DEATH_SCALE_XZ - this.deathFromXZ) * p;
    blob.scale.set(this.curScaleXZ, this.curScaleY, this.curScaleXZ);
    blob.position.y = 0;
  }
}
