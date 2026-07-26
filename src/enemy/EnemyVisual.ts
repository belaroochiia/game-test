import * as THREE from 'three';

import type { EnemyDef } from './EnemyDefs';

/**
 * The five procedural body archetypes (Phase 5 contract): 'blob', 'quad',
 * 'biped', 'sentinel', 'wraith'. A def picks an archetype, a palette and a
 * scale — the body is generated, coloured and animated entirely from that, so
 * enemy #13 needs no art and no code (§4.1 extended to enemies).
 *
 * Budget craft (§3/§5):
 * - ONE MeshLambertMaterial (vertex colours, flat shading) shared by every
 *   enemy body of every archetype, plus ONE shared additive material for all
 *   telegraph rings and charge strips — two materials for the whole bestiary.
 * - Geometry is baked once per KIND (palette lives in vertex colours, so the
 *   cache key is the kind, not the archetype) and shared by every instance,
 *   refcounted like Phase 3's blob assets.
 * - Every archetype body is <= 260 triangles at scale 1 (verified in the
 *   phase's gate run).
 *
 * Animation is the house craft PlayerAvatar and Phase 3's blob established:
 * grounded gaits advance their cycle by the distance the sim actually
 * integrated — never wall time — so nothing can skate; only presentation
 * flourishes (breath, tremble, tail) ride a frame clock. The one deliberate
 * exception: the WRAITH bobs on the clock, because it floats — there is no
 * ground contact to betray, so skating does not apply and a hover that
 * stopped bobbing while hovering in place would read as a freeze-frame bug.
 * Zero allocation per frame: scalar writes into existing objects only (§13).
 */

export interface EnemyPose {
  alive: boolean;
  /** Sim-time seconds since death (drives the collapse; hitstop freezes it). */
  deadFor: number;
  /** 1 right after a hit, decaying to 0 — jiggle amplitude (sim time). */
  hitAmount: number;
  telegraphing: boolean;
  /** 0..1 through the wind-up; 0 otherwise. */
  telegraphProgress: number;
  /** 0..1 through the active attack motion (lunge hop, rush, slam swing); 0 idle. */
  strike: number;
}

/** Reusable pose scratch for callers (one per enemy, filled every frame). */
export function createEnemyPose(): EnemyPose {
  return { alive: true, deadFor: 0, hitAmount: 0, telegraphing: false, telegraphProgress: 0, strike: 0 };
}

// --- shared, refcounted GPU assets ------------------------------------------

interface SharedAssets {
  bodyMaterial: THREE.MeshLambertMaterial;
  telegraphMaterial: THREE.MeshBasicMaterial;
  /** Unit ring lying flat (+Y normal); per-mesh scale gives it its radius. 24 tris. */
  ringGeometry: THREE.BufferGeometry;
  /** Unit strip lying flat, origin at the near edge, extending along -Z. 2 tris. */
  stripGeometry: THREE.BufferGeometry;
  refs: number;
}

let shared: SharedAssets | null = null;

function acquireShared(): SharedAssets {
  if (shared === null) {
    const ringGeometry = new THREE.RingGeometry(0.82, 1, 12, 1);
    ringGeometry.rotateX(-Math.PI / 2);
    const stripGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    stripGeometry.rotateX(-Math.PI / 2);
    // Origin at the near edge so scale.z stretches it away from the attacker.
    stripGeometry.translate(0, 0, -0.5);
    shared = {
      bodyMaterial: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      // Phase 3's telegraph orange — danger reads as ONE colour across the game.
      telegraphMaterial: new THREE.MeshBasicMaterial({
        color: 0xff6a3c,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      ringGeometry,
      stripGeometry,
      refs: 0,
    };
  }
  shared.refs++;
  return shared;
}

function releaseShared(): void {
  if (shared === null) return;
  shared.refs--;
  if (shared.refs > 0) return;
  shared.bodyMaterial.dispose();
  shared.telegraphMaterial.dispose();
  shared.ringGeometry.dispose();
  shared.stripGeometry.dispose();
  shared = null;
}

// --- per-kind geometry cache -------------------------------------------------

interface KindAssets {
  /** All geometries of the rig, in the archetype's fixed assembly order. */
  geometries: THREE.BufferGeometry[];
  /** Exact triangle total of one body instance (telegraphs not included). */
  triangles: number;
  refs: number;
}

const kindCache = new Map<string, KindAssets>();

const scratchColorA = new THREE.Color();
const scratchColorB = new THREE.Color();

/** Per-face brightness jitter — large flat facets read as plastic without it (§5). */
const FACE_JITTER_BASE = 0.92;
const FACE_JITTER_SPAN = 0.16;

function faceJitter(face: number): number {
  const hash = ((Math.imul(face + 1, 2654435761) >>> 16) & 255) / 255;
  return FACE_JITTER_BASE + hash * FACE_JITTER_SPAN;
}

/**
 * Bakes one flat colour (x shade) into a geometry, jittered per face so the
 * silhouette stays readable in flat light. Indexed geometries jitter per
 * vertex-triple anyway — boxes and cones from three are what pass through here
 * and their shared corners split per face already.
 */
function bakeFlat(geometry: THREE.BufferGeometry, hex: number, shade: number): THREE.BufferGeometry {
  const nonIndexed = geometry.index !== null ? geometry.toNonIndexed() : geometry;
  if (nonIndexed !== geometry) geometry.dispose();
  const positions = nonIndexed.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  scratchColorA.setHex(hex);
  for (let i = 0; i < positions.count; i++) {
    const jitter = faceJitter((i / 3) | 0) * shade;
    colors[i * 3] = scratchColorA.r * jitter;
    colors[i * 3 + 1] = scratchColorA.g * jitter;
    colors[i * 3 + 2] = scratchColorA.b * jitter;
  }
  nonIndexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  nonIndexed.computeVertexNormals();
  return nonIndexed;
}

function box(w: number, h: number, d: number, hex: number, shade = 1): THREE.BufferGeometry {
  return bakeFlat(new THREE.BoxGeometry(w, h, d), hex, shade);
}

/**
 * Phase 3's blob shape, palette-parameterised: squashed icosphere (80 tris),
 * soft-flattened base, feet at local origin, body->accent gradient by height.
 */
function blobGeometry(bodyHex: number, accentHex: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(0.55, 1);
  const positions = geometry.getAttribute('position');
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < positions.count; i++) {
    let y = positions.getY(i) * 0.85;
    if (y < -0.19) y = -0.19 + (y + 0.19) * 0.35;
    positions.setY(i, y);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  geometry.translate(0, -minY, 0);
  const span = maxY - minY;

  scratchColorA.setHex(bodyHex);
  scratchColorB.setHex(accentHex);
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    let t = span > 0 ? positions.getY(i) / span : 0;
    t = t * t * (3 - 2 * t);
    const jitter = faceJitter((i / 3) | 0);
    colors[i * 3] = (scratchColorA.r + (scratchColorB.r - scratchColorA.r) * t) * jitter;
    colors[i * 3 + 1] = (scratchColorA.g + (scratchColorB.g - scratchColorA.g) * t) * jitter;
    colors[i * 3 + 2] = (scratchColorA.b + (scratchColorB.b - scratchColorA.b) * t) * jitter;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function buildKindGeometries(def: EnemyDef): THREE.BufferGeometry[] {
  const body = def.palette.body;
  const accent = def.palette.accent;
  switch (def.archetype) {
    case 'blob':
      return [blobGeometry(body, accent)];
    case 'quad':
      return [
        box(0.52, 0.42, 0.95, body), // 0 torso
        box(0.3, 0.28, 0.3, body, 1.06), // 1 head
        box(0.16, 0.13, 0.22, accent), // 2 muzzle
        box(0.07, 0.15, 0.07, accent, 0.9), // 3 ear L
        box(0.07, 0.15, 0.07, accent, 0.9), // 4 ear R
        box(0.13, 0.4, 0.13, body, 0.78), // 5-8 legs FL FR BL BR
        box(0.13, 0.4, 0.13, body, 0.78),
        box(0.13, 0.4, 0.13, body, 0.78),
        box(0.13, 0.4, 0.13, body, 0.78),
        box(0.08, 0.08, 0.42, accent, 0.95), // 9 tail
      ];
    case 'biped':
      return [
        box(0.44, 0.55, 0.26, body), // 0 torso
        box(0.48, 0.09, 0.3, accent, 0.9), // 1 belt
        box(0.3, 0.3, 0.3, body, 1.08), // 2 head
        box(0.17, 0.1, 0.22, accent), // 3-4 shoulder pads
        box(0.17, 0.1, 0.22, accent),
        box(0.12, 0.44, 0.14, body, 0.85), // 5-6 arms
        box(0.12, 0.44, 0.14, body, 0.85),
        box(0.15, 0.6, 0.17, body, 0.7), // 7-8 legs
        box(0.15, 0.6, 0.17, body, 0.7),
      ];
    case 'sentinel':
      return [
        box(0.75, 0.7, 0.45, body), // 0 torso
        box(0.32, 0.28, 0.32, body, 0.92), // 1 head
        box(0.32, 0.16, 0.5, accent, 0.9), // 2-3 shoulder slabs
        box(0.32, 0.16, 0.5, accent, 0.9),
        box(0.2, 0.62, 0.22, body, 0.8), // 4-5 arms
        box(0.2, 0.62, 0.22, body, 0.8),
        box(0.22, 0.45, 0.24, body, 0.68), // 6-7 legs
        box(0.22, 0.45, 0.24, body, 0.68),
        bakeFlat(new THREE.OctahedronGeometry(0.15, 0), accent, 1.6), // 8 core (fake glow)
      ];
    case 'wraith':
      return [
        bakeFlat(new THREE.ConeGeometry(0.4, 1.05, 8, 1, true), body, 1), // 0 cloak
        bakeFlat(new THREE.IcosahedronGeometry(0.17, 0), body, 1.15), // 1 head
        box(0.09, 0.34, 0.1, body, 0.8), // 2-3 arms
        box(0.09, 0.34, 0.1, body, 0.8),
        bakeFlat(new THREE.OctahedronGeometry(0.11, 0), accent, 1.7), // 4 core (fake glow)
      ];
  }
}

function triangleCount(geometries: readonly THREE.BufferGeometry[]): number {
  let total = 0;
  for (let i = 0; i < geometries.length; i++) {
    const geometry = geometries[i];
    if (geometry === undefined) continue;
    const index = geometry.index;
    total += (index !== null ? index.count : geometry.getAttribute('position').count) / 3;
  }
  return total;
}

function acquireKind(def: EnemyDef): KindAssets {
  let assets = kindCache.get(def.kind);
  if (assets === undefined) {
    const geometries = buildKindGeometries(def);
    assets = { geometries, triangles: triangleCount(geometries), refs: 0 };
    kindCache.set(def.kind, assets);
  }
  assets.refs++;
  return assets;
}

function releaseKind(kind: string): void {
  const assets = kindCache.get(kind);
  if (assets === undefined) return;
  assets.refs--;
  if (assets.refs > 0) return;
  for (let i = 0; i < assets.geometries.length; i++) assets.geometries[i]?.dispose();
  kindCache.delete(kind);
}

// --- animation constants ------------------------------------------------------

/** Pose smoothing time-to-90 % ~77 ms — kills mode-switch pops (Phase 3 value). */
const POSE_K = 30;
const HOP_LENGTH = 1.15;
const HOP_HEIGHT = 0.34;
const SQUASH_Y = 0.78;
const STRETCH_Y = 1.16;
const TELEGRAPH_SQUASH = 0.38;
const TELEGRAPH_SPREAD = 0.32;
const TREMBLE_HZ = 42;
/** World units per full gait cycle at scale 1, per archetype family. */
const QUAD_STRIDE = 0.9;
const BIPED_STRIDE = 0.85;
const SENTINEL_STRIDE = 1.35;
/** Death choreography (Phase 3 timing: fast collapse, brief hold, hide). */
const DEATH_FALL_SECONDS = 0.35;
const DEATH_HIDE_SECONDS = 0.7;
/** Wraith hover: base ride height and clock-driven bob. */
const FLOAT_BASE = 0.22;
const FLOAT_BOB = 0.09;
const FLOAT_HZ = 2.2;

// Part indices (this.parts). B_* blob, Q_* quad, H_* humanoid (biped+sentinel), W_* wraith.
const B_BLOB = 0;
const Q_HEAD = 0;
const Q_TAIL = 1;
const Q_LEG_FL = 2;
const Q_LEG_FR = 3;
const Q_LEG_BL = 4;
const Q_LEG_BR = 5;
const H_TORSO = 0;
const H_ARM_L = 1;
const H_ARM_R = 2;
const H_LEG_L = 3;
const H_LEG_R = 4;
const W_CLOAK = 0;
const W_ARM_L = 1;
const W_ARM_R = 2;
const W_CORE = 3;

/**
 * One enemy body: shared-geometry meshes under pivot groups, plus the
 * per-archetype animator. The caller (ArchetypeEnemy) feeds it a pose every
 * rendered frame; this class never reads game state.
 */
export class EnemyVisual {
  /** Stays axis-aligned at the feet; only `body` rotates (Phase 3's seam). */
  readonly root: THREE.Group;
  /** Exact triangle count of the body (budget accounting / the gate). */
  readonly triangles: number;

  private readonly def: EnemyDef;
  private readonly assets: SharedAssets;
  private readonly kindAssets: KindAssets;
  private readonly body: THREE.Group;
  private readonly parts: THREE.Object3D[] = [];

  // Animation state — reused scalars, meaning varies by archetype.
  private phase = 0;
  private lastX = 0;
  private lastZ = 0;
  private hasLast = false;
  private clock = 0;
  private lastNow = 0;
  private moveBlend = 0;
  private poseY = 1;
  private poseXZ = 1;
  private deathFromY = 1;
  private deathFromXZ = 1;
  private bodyVisible = true;

  constructor(def: EnemyDef) {
    this.def = def;
    this.assets = acquireShared();
    this.kindAssets = acquireKind(def);

    this.root = new THREE.Group();
    this.root.name = 'enemy';
    this.body = new THREE.Group();
    this.body.scale.setScalar(def.scale);
    this.root.add(this.body);

    this.assemble();
    this.triangles = this.kindAssets.triangles;
  }

  /** A telegraph ring on the shared assets, parented to root, hidden. 24 tris. */
  makeTelegraphRing(): THREE.Mesh {
    const ring = new THREE.Mesh(this.assets.ringGeometry, this.assets.telegraphMaterial);
    ring.visible = false;
    ring.renderOrder = 2;
    this.root.add(ring);
    return ring;
  }

  /** A ground strip (unit, extends -Z, origin near edge), parented to root, hidden. */
  makeTelegraphStrip(): THREE.Mesh {
    const strip = new THREE.Mesh(this.assets.stripGeometry, this.assets.telegraphMaterial);
    strip.visible = false;
    strip.renderOrder = 2;
    this.root.add(strip);
    return strip;
  }

  /**
   * Runs every rendered frame. Scalar writes only (§13). Timing-critical
   * inputs (hit, death, telegraph, strike) arrive in SIM time via the pose,
   * so hitstop freezes the reaction exactly like Phase 3.
   */
  apply(x: number, y: number, z: number, yaw: number, pose: EnemyPose): void {
    this.root.position.set(x, y, z);
    // Gameplay yaw is atan2(dirX, -dirZ) (EnemyBase), whose facing vector is
    // (sin yaw, -cos yaw). rotation.y = -yaw maps local -Z EXACTLY onto that
    // vector for every direction — rotation.y = +yaw only agrees on the +/-Z
    // axis and mirrors X elsewhere, which Phase 3's front-back-symmetric
    // bodies could never show. Bodies here are built with their face at -Z.
    this.body.rotation.y = -yaw;

    // Own frame clock (render rate != tick rate) — PlayerAvatar's pattern.
    const now = performance.now();
    if (this.lastNow === 0) this.lastNow = now;
    let fdt = (now - this.lastNow) * 0.001;
    this.lastNow = now;
    if (fdt < 0) fdt = 0;
    else if (fdt > 0.1) fdt = 0.1;
    this.clock += fdt;

    // Distance actually covered on screen — the only thing advancing any gait.
    let travelled = 0;
    if (this.hasLast) {
      const dx = x - this.lastX;
      const dz = z - this.lastZ;
      travelled = Math.sqrt(dx * dx + dz * dz);
    }
    this.lastX = x;
    this.lastZ = z;
    this.hasLast = true;

    if (!pose.alive) {
      this.applyDeath(pose.deadFor);
      return;
    }
    if (!this.bodyVisible) {
      this.bodyVisible = true;
      this.body.visible = true;
    }

    switch (this.def.archetype) {
      case 'blob':
        this.applyBlob(pose, fdt, travelled);
        break;
      case 'quad':
        this.applyQuad(pose, fdt, travelled);
        break;
      case 'biped':
        this.applyHumanoid(pose, fdt, travelled, false);
        break;
      case 'sentinel':
        this.applyHumanoid(pose, fdt, travelled, true);
        break;
      case 'wraith':
        this.applyWraith(pose, fdt, travelled);
        break;
    }
  }

  /** Fresh spawn / respawn: neutral pose, no phantom gait from the position jump. */
  reset(): void {
    this.phase = 0;
    this.hasLast = false;
    this.moveBlend = 0;
    this.poseY = 1;
    this.poseXZ = 1;
    this.bodyVisible = true;
    this.body.visible = true;
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    const scale = this.def.scale;
    this.body.scale.set(scale, scale, scale);
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      if (part === undefined) continue;
      part.rotation.set(0, 0, 0);
    }
  }

  /** §9 despawn hysteresis — hide/show without touching animation state. */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
    if (visible) this.hasLast = false;
  }

  dispose(): void {
    releaseKind(this.def.kind);
    releaseShared();
  }

  // --- assembly ---------------------------------------------------------------

  private mesh(geometryIndex: number): THREE.Mesh {
    const geometry = this.kindAssets.geometries[geometryIndex] as THREE.BufferGeometry;
    return new THREE.Mesh(geometry, this.assets.bodyMaterial);
  }

  private pivot(x: number, y: number, z: number): THREE.Object3D {
    const group = new THREE.Object3D();
    group.position.set(x, y, z);
    this.body.add(group);
    this.parts.push(group);
    return group;
  }

  private assemble(): void {
    switch (this.def.archetype) {
      case 'blob': {
        const blob = this.mesh(0);
        this.body.add(blob);
        this.parts.push(blob);
        break;
      }
      case 'quad': {
        const torso = this.mesh(0);
        torso.position.set(0, 0.52, 0.05);
        this.body.add(torso);

        // Facing is local -Z (yaw convention), so the head leads that way.
        const head = this.pivot(0, 0.62, -0.5);
        const skull = this.mesh(1);
        skull.position.set(0, 0.02, -0.1);
        head.add(skull);
        const muzzle = this.mesh(2);
        muzzle.position.set(0, -0.05, -0.3);
        head.add(muzzle);
        const earL = this.mesh(3);
        earL.position.set(-0.1, 0.2, -0.08);
        head.add(earL);
        const earR = this.mesh(4);
        earR.position.set(0.1, 0.2, -0.08);
        head.add(earR);

        const tail = this.pivot(0, 0.6, 0.5);
        const tailMesh = this.mesh(9);
        tailMesh.position.set(0, 0, 0.2);
        tail.add(tailMesh);

        // Legs pivot at the hip so the swing happens at the joint.
        const hipY = 0.4;
        const offsets: ReadonlyArray<readonly [number, number]> = [
          [-0.17, -0.32],
          [0.17, -0.32],
          [-0.17, 0.34],
          [0.17, 0.34],
        ];
        for (let i = 0; i < 4; i++) {
          const offset = offsets[i] as readonly [number, number];
          const leg = this.pivot(offset[0], hipY, offset[1]);
          const legMesh = this.mesh(5 + i);
          legMesh.position.y = -0.2;
          leg.add(legMesh);
        }
        break;
      }
      case 'biped':
        this.assembleHumanoid(0.6, 0.55, 1.0, 0.3, 0.26, 0.44);
        break;
      case 'sentinel':
        this.assembleHumanoid(0.45, 0.7, 1.28, 0.55, 0.31, 0.62);
        break;
      case 'wraith': {
        // Hovers: the whole silhouette rides FLOAT_BASE above the feet origin;
        // applyWraith adds the clock bob on top.
        const cloak = this.pivot(0, FLOAT_BASE + 0.55, 0);
        const cloakMesh = this.mesh(0);
        cloak.add(cloakMesh);
        const head = this.mesh(1);
        head.position.set(0, 0.62, -0.02);
        cloak.add(head);

        const armL = this.pivot(-0.24, FLOAT_BASE + 0.95, -0.05);
        const armLMesh = this.mesh(2);
        armLMesh.position.y = -0.17;
        armL.add(armLMesh);
        const armR = this.pivot(0.24, FLOAT_BASE + 0.95, -0.05);
        const armRMesh = this.mesh(3);
        armRMesh.position.y = -0.17;
        armR.add(armRMesh);

        const core = this.pivot(0, FLOAT_BASE + 0.78, -0.22);
        core.add(this.mesh(4));
        break;
      }
    }
  }

  /** Shared torso/arms/legs frame for biped and sentinel; proportions differ. */
  private assembleHumanoid(
    legLen: number,
    torsoH: number,
    shoulderY: number,
    armX: number,
    padX: number,
    armLen: number,
  ): void {
    const torso = this.pivot(0, legLen, 0);
    const torsoMesh = this.mesh(0);
    torsoMesh.position.y = torsoH * 0.5;
    torso.add(torsoMesh);
    const belt = this.mesh(1);
    belt.position.y = 0.05;
    torso.add(belt);
    const head = this.mesh(2);
    head.position.y = torsoH + 0.17;
    torso.add(head);
    const padL = this.mesh(3);
    padL.position.set(-padX, torsoH - 0.02, 0);
    torso.add(padL);
    const padR = this.mesh(4);
    padR.position.set(padX, torsoH - 0.02, 0);
    torso.add(padR);

    const shoulderLocal = shoulderY - legLen;
    const armL = new THREE.Object3D();
    armL.position.set(-armX, shoulderLocal, 0);
    const armLMesh = this.mesh(5);
    armLMesh.position.y = -armLen * 0.5;
    armL.add(armLMesh);
    torso.add(armL);
    this.parts.push(armL);
    const armR = new THREE.Object3D();
    armR.position.set(armX, shoulderLocal, 0);
    const armRMesh = this.mesh(6);
    armRMesh.position.y = -armLen * 0.5;
    armR.add(armRMesh);
    torso.add(armR);
    this.parts.push(armR);

    const legL = this.pivot(-0.14, legLen, 0);
    const legLMesh = this.mesh(7);
    legLMesh.position.y = -legLen * 0.5;
    legL.add(legLMesh);
    const legR = this.pivot(0.14, legLen, 0);
    const legRMesh = this.mesh(8);
    legRMesh.position.y = -legLen * 0.5;
    legR.add(legRMesh);
  }

  private part(index: number): THREE.Object3D {
    return this.parts[index] as THREE.Object3D;
  }

  // --- animators ----------------------------------------------------------------

  /** Phase 3's blob feel, verbatim: hop by distance, spring-squash telegraph. */
  private applyBlob(pose: EnemyPose, fdt: number, travelled: number): void {
    const blob = this.part(B_BLOB);
    const scale = this.def.scale;
    let targetY: number;
    let targetXZ: number;
    let hopLift = 0;

    if (pose.telegraphing) {
      const p = pose.telegraphProgress;
      targetY = 1 - TELEGRAPH_SQUASH * p;
      targetXZ = 1 + TELEGRAPH_SPREAD * p + Math.sin(this.clock * TREMBLE_HZ) * 0.03 * p;
      this.phase = 0;
      this.moveBlend = 0;
    } else if (pose.strike > 0) {
      hopLift = Math.sin(pose.strike * Math.PI) * 0.3;
      targetY = 1.28;
      targetXZ = 0.86;
    } else {
      const speed = fdt > 1e-4 ? travelled / fdt : 0;
      const moving = speed > 0.3;
      this.moveBlend += ((moving ? 1 : 0) - this.moveBlend) * (1 - Math.exp(-10 * fdt));
      if (moving) {
        this.phase += travelled / (HOP_LENGTH * scale);
        if (this.phase > 1e6) this.phase -= 1e6;
      } else {
        const settle = Math.round(this.phase);
        this.phase += (settle - this.phase) * (1 - Math.exp(-14 * fdt));
      }
      const air = Math.abs(Math.sin(this.phase * Math.PI));
      hopLift = air * HOP_HEIGHT * this.moveBlend;
      const hopY = SQUASH_Y + (STRETCH_Y - SQUASH_Y) * air;
      const hopXZ = 1 + (1 - hopY) * 0.55;
      const breath = Math.sin(this.clock * 2.1);
      const idleY = 1 + breath * 0.035;
      const idleXZ = 1 - breath * 0.025;
      targetY = idleY + (hopY - idleY) * this.moveBlend;
      targetXZ = idleXZ + (hopXZ - idleXZ) * this.moveBlend;
    }

    const hit = pose.hitAmount;
    if (hit > 0) {
      targetY *= 1 - 0.22 * hit;
      targetXZ *= 1 + 0.26 * hit;
    }
    const blend = 1 - Math.exp(-POSE_K * fdt);
    this.poseY += (targetY - this.poseY) * blend;
    this.poseXZ += (targetXZ - this.poseXZ) * blend;
    blob.scale.set(this.poseXZ, this.poseY, this.poseXZ);
    blob.position.y = hopLift;
    this.deathFromY = this.poseY;
    this.deathFromXZ = this.poseXZ;
  }

  /** Four legs in diagonal pairs; gallop stretch during a rush or lunge. */
  private applyQuad(pose: EnemyPose, fdt: number, travelled: number): void {
    const scale = this.def.scale;
    const speed = fdt > 1e-4 ? travelled / fdt : 0;
    const moving = speed > 0.3;
    this.moveBlend += ((moving ? 1 : 0) - this.moveBlend) * (1 - Math.exp(-10 * fdt));
    this.phase += (travelled / (QUAD_STRIDE * scale)) * Math.PI;
    if (this.phase > Math.PI * 4) this.phase -= Math.PI * 4;

    const swing = Math.sin(this.phase) * 0.75 * this.moveBlend;
    this.part(Q_LEG_FL).rotation.x = swing;
    this.part(Q_LEG_BR).rotation.x = swing;
    this.part(Q_LEG_FR).rotation.x = -swing;
    this.part(Q_LEG_BL).rotation.x = -swing;

    const body = this.body;
    let pitch = 0;
    let lift = Math.abs(Math.sin(this.phase)) * 0.05 * this.moveBlend;
    if (pose.telegraphing) {
      // Crouch low, head down: a pounce being loaded (§9's readable wind-up).
      const p = pose.telegraphProgress;
      pitch = 0.22 * p + Math.sin(this.clock * TREMBLE_HZ) * 0.02 * p;
      lift = -0.12 * p;
      this.part(Q_HEAD).rotation.x = 0.35 * p;
    } else if (pose.strike > 0) {
      // Stretched flight: legs trail, head thrust forward.
      pitch = -0.18;
      lift = 0.1;
      this.part(Q_HEAD).rotation.x = -0.25;
      this.part(Q_LEG_FL).rotation.x = -0.9;
      this.part(Q_LEG_FR).rotation.x = -0.9;
      this.part(Q_LEG_BL).rotation.x = 0.9;
      this.part(Q_LEG_BR).rotation.x = 0.9;
    } else {
      this.part(Q_HEAD).rotation.x = Math.sin(this.clock * 1.7) * 0.05;
    }
    this.part(Q_TAIL).rotation.y = Math.sin(this.clock * 6) * 0.35;

    const hit = pose.hitAmount;
    body.rotation.x = pitch;
    body.rotation.z = hit * 0.15;
    body.position.y = lift * scale;
    body.scale.set(scale * (1 + 0.08 * hit), scale * (1 - 0.1 * hit), scale * (1 + 0.08 * hit));
  }

  /** Walk cycle with counter-swinging arms; overhead wind-up; slam follow-through. */
  private applyHumanoid(pose: EnemyPose, fdt: number, travelled: number, heavy: boolean): void {
    const scale = this.def.scale;
    const stride = (heavy ? SENTINEL_STRIDE : BIPED_STRIDE) * scale;
    const speed = fdt > 1e-4 ? travelled / fdt : 0;
    const moving = speed > 0.25;
    this.moveBlend += ((moving ? 1 : 0) - this.moveBlend) * (1 - Math.exp(-10 * fdt));
    this.phase += (travelled / stride) * Math.PI;
    if (this.phase > Math.PI * 4) this.phase -= Math.PI * 4;

    const torso = this.part(H_TORSO);
    const armL = this.part(H_ARM_L);
    const armR = this.part(H_ARM_R);
    const legL = this.part(H_LEG_L);
    const legR = this.part(H_LEG_R);

    const swingAmount = (heavy ? 0.4 : 0.6) * this.moveBlend;
    const s = Math.sin(this.phase);
    legL.rotation.x = s * swingAmount;
    legR.rotation.x = -s * swingAmount;

    let bob = Math.abs(s) * (heavy ? 0.05 : 0.035) * this.moveBlend;
    if (pose.telegraphing) {
      // Both arms hauled overhead, torso coiling back — the §9 wind-up beat.
      const p = pose.telegraphProgress;
      const tremble = Math.sin(this.clock * TREMBLE_HZ) * 0.03 * p;
      armL.rotation.x = -2.4 * p + tremble;
      armR.rotation.x = -2.4 * p - tremble;
      torso.rotation.x = -0.22 * p;
      // Heavy attackers sink into the slam stance; the frame telegraphs mass.
      if (heavy) bob = -0.08 * p;
    } else if (pose.strike > 0) {
      // Whip through: overhead to full extension in the strike window.
      const p = pose.strike;
      armL.rotation.x = -2.4 + 3.4 * p;
      armR.rotation.x = -2.4 + 3.4 * p;
      torso.rotation.x = 0.3 * p;
    } else {
      armL.rotation.x = -s * swingAmount * 0.7 + Math.sin(this.clock * 1.9) * 0.04;
      armR.rotation.x = s * swingAmount * 0.7 - Math.sin(this.clock * 1.9) * 0.04;
      torso.rotation.x = 0.06 * this.moveBlend + (heavy ? 0.04 : 0);
      // The heavy frame rolls its shoulders with each step — mass, not haste.
      torso.rotation.z = heavy ? s * 0.06 * this.moveBlend : 0;
    }

    const hit = pose.hitAmount;
    if (hit > 0) torso.rotation.x -= 0.3 * hit;
    this.body.position.y = bob * scale;
    this.body.scale.set(scale * (1 + 0.05 * hit), scale * (1 - 0.07 * hit), scale * (1 + 0.05 * hit));
  }

  /**
   * The floater. Bob rides the CLOCK, not distance — a wraith holds no ground
   * contact, so the skate rule has nothing to protect and a hover must keep
   * living while stationary. Drift lean is still speed-derived so motion reads.
   */
  private applyWraith(pose: EnemyPose, fdt: number, travelled: number): void {
    const scale = this.def.scale;
    const speed = fdt > 1e-4 ? travelled / fdt : 0;
    this.moveBlend += ((speed > 0.3 ? 1 : 0) - this.moveBlend) * (1 - Math.exp(-8 * fdt));

    const cloak = this.part(W_CLOAK);
    const armL = this.part(W_ARM_L);
    const armR = this.part(W_ARM_R);
    const core = this.part(W_CORE);

    let bob = Math.sin(this.clock * FLOAT_HZ) * FLOAT_BOB;
    let corePulse = 1 + Math.sin(this.clock * 3.1) * 0.08;
    if (pose.telegraphing) {
      // Rise and flare: arms spread, core swells toward the release (§9).
      const p = pose.telegraphProgress;
      bob += 0.18 * p;
      armL.rotation.z = 0.9 * p;
      armR.rotation.z = -0.9 * p;
      armL.rotation.x = -0.6 * p;
      armR.rotation.x = -0.6 * p;
      corePulse = 1 + p * 0.9 + Math.sin(this.clock * TREMBLE_HZ) * 0.06 * p;
    } else if (pose.strike > 0) {
      // The release: snap forward, core dumped back to rest size.
      const p = 1 - pose.strike;
      armL.rotation.x = -1.4 * p;
      armR.rotation.x = -1.4 * p;
      armL.rotation.z = 0;
      armR.rotation.z = 0;
      corePulse = 1 + p * 0.4;
    } else {
      armL.rotation.x = Math.sin(this.clock * 1.6) * 0.12 - 0.15;
      armR.rotation.x = Math.sin(this.clock * 1.6 + 1.3) * 0.12 - 0.15;
      armL.rotation.z = 0.12;
      armR.rotation.z = -0.12;
    }
    core.scale.setScalar(corePulse);
    core.rotation.y = this.clock * 1.4;
    cloak.rotation.z = Math.sin(this.clock * FLOAT_HZ * 0.7) * 0.06;

    const hit = pose.hitAmount;
    this.body.rotation.x = -0.22 * this.moveBlend - 0.25 * hit;
    this.body.position.y = bob * scale;
    this.body.scale.set(scale * (1 + 0.06 * hit), scale * (1 - 0.08 * hit), scale * (1 + 0.06 * hit));
  }

  /** Sim-timed collapse (hitstop holds it), then hide — Phase 3's beat. */
  private applyDeath(deadFor: number): void {
    if (deadFor >= DEATH_HIDE_SECONDS) {
      if (this.bodyVisible) {
        this.bodyVisible = false;
        this.body.visible = false;
      }
      return;
    }
    let p = deadFor / DEATH_FALL_SECONDS;
    if (p > 1) p = 1;
    p = 1 - (1 - p) * (1 - p); // ease-out: fast collapse, soft settle
    const scale = this.def.scale;
    const body = this.body;
    switch (this.def.archetype) {
      case 'blob': {
        // The pancake, from whatever pose death caught.
        const blob = this.part(B_BLOB);
        const y = this.deathFromY + (0.07 - this.deathFromY) * p;
        const xz = this.deathFromXZ + (1.85 - this.deathFromXZ) * p;
        blob.scale.set(xz, y, xz);
        blob.position.y = 0;
        break;
      }
      case 'quad':
        body.rotation.z = p * 1.5; // keels over sideways
        body.rotation.x = 0;
        body.position.y = -0.1 * p * scale;
        break;
      case 'biped':
        body.rotation.x = p * 1.5; // face-plants forward
        body.position.y = -0.1 * p * scale;
        break;
      case 'sentinel':
        body.rotation.x = -p * 1.4; // topples backward, slow and heavy
        body.position.y = -0.15 * p * scale;
        break;
      case 'wraith':
        // Gutters out: sinks to the ground and collapses inward.
        body.position.y = -FLOAT_BASE * scale * p;
        body.scale.set(scale * (1 - 0.7 * p), scale * (1 - 0.85 * p), scale * (1 - 0.7 * p));
        break;
    }
  }
}
