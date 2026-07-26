import * as THREE from 'three';

import type { System } from '../../core/Engine';

/**
 * Pooled skill VFX (Phase 4, §5/§13). Renders ANY skill from exactly three data
 * values — (style pack, colorHex, sizeScale) — which is what keeps new skills
 * zero-code (§4.1): SkillRuntime maps delivery events onto the four pack looks
 * ('bolt' projectile head + trail, 'burst' impact flash + puff, 'ring' expanding
 * nova ring, 'glow' caster pulse) and nothing in here ever sees a skill id.
 *
 * GPU shape — three draw calls worst case, zero when idle, three materials:
 *  1. ALL particles (trails, puffs, glows): 192 camera-facing quads in ONE
 *     instanced draw. Billboarding is done in a tiny vertex shader (the one
 *     sanctioned ShaderMaterial); the soft disc is computed from UV in the
 *     fragment shader, so there is no texture anywhere (§5).
 *  2. The 16 projectile heads: one InstancedMesh of octahedra, per-instance
 *     colour, free slots collapsed to scale 0.
 *  3. The 6 nova/impact rings: one InstancedMesh of flat rings; additive
 *     blending means fading is just darkening the instance colour.
 * The contract phrased heads/rings as "pooled meshes"; pooling INSTANCES of one
 * mesh each keeps the same slots-and-back-pressure behaviour while cutting the
 * worst case from 23 draws to 3 — well under the ≤ 10 budget.
 *
 * Everything is preallocated at construction; spawning writes into slabs and
 * pops a free-index stack — zero allocation at cast time (§3, §13). When a slab
 * is full the effect is skipped, never allocated around (ObjectPool's rule).
 *
 * Not hitstop-gated, same stance as StatusEffects: particles drifting through a
 * 100 ms freeze is imperceptible and keeps the system dependency-free.
 */

export interface SkillVfxOptions {
  scene: THREE.Scene;
}

const MAX_PARTICLES = 192;
const MAX_BOLTS = 16; // mirrors SkillRuntime's projectile pool 1:1
const MAX_RINGS = 6;

/** Head octahedron world radius at sizeScale 1. */
const HEAD_RADIUS = 0.16;
const HEAD_SPIN_RATE = 9; // rad/s tumble — reads "magic", costs nothing
/** Trail puffs are dropped every SECOND tick: 16 bolts × 30/s × 0.22 s ≈ 105 live, under the slab. */
const TRAIL_LIFE = 0.22;
const TRAIL_SIZE = 0.3;

const PUFF_COUNT = 9;
const PUFF_SPEED = 3.2;
const PUFF_LIFE = 0.34;
const PUFF_GRAVITY = -7;

const SPARK_COUNT = 4;
const SPARK_SPEED = 2.2;
const SPARK_LIFE = 0.26;

const GLOW_LIFE = 0.3;
const GLOW_RISE = 0.5; // u/s upward drift sells "power gathering"

/** Ring expansion ease is quadratic-out; after full radius it fades over this. */
const RING_FADE = 0.22;
/** Impact flash reuses the ring pool: small radius, very fast sweep. */
const IMPACT_RING_RADIUS = 0.85;
const IMPACT_RING_SWEEP = 0.13;

/**
 * Visual-only mulberry32. Deliberately NOT the seeded combat streams: scatter
 * directions influence nothing measurable, and reseeding them from the gate
 * would only couple tests to eye candy.
 */
let vfxRngState = 0x9e3779b9;
function vrand(): number {
  vfxRngState = (vfxRngState + 0x6d2b79f5) >>> 0;
  let t = vfxRngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Module-scope scratch (§13: no allocation in update/render).
const scratchColor = new THREE.Color();
const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchEuler = new THREE.Euler();
const scratchQuat = new THREE.Quaternion();
const identityQuat = new THREE.Quaternion();

const TWO_PI = Math.PI * 2;

/**
 * Classic view-space billboard: push the quad corner out in eye space so the
 * quad always faces the camera, then a soft radial falloff from UV — a fake
 * glow sprite with no texture (§5's "fake glow pakai sprite additive").
 */
const PARTICLE_VERTEX = /* glsl */ `
attribute vec3 aOffset;
attribute float aScale;
attribute vec3 aColor;
attribute float aFade;
varying vec3 vColor;
varying vec2 vUv;
void main() {
  vColor = aColor * aFade;
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
  mv.xy += position.xy * aScale;
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying vec2 vUv;
void main() {
  vec2 d = vUv - 0.5;
  float glow = smoothstep(0.25, 0.02, dot(d, d));
  gl_FragColor = vec4(vColor * glow, 1.0);
  #include <colorspace_fragment>
}
`;

export class SkillVfx implements System {
  readonly name = 'skillVfx';

  private readonly scene: THREE.Scene;

  // --- particle slab (one instanced draw for every quad) --------------------
  private readonly particleGeometry: THREE.InstancedBufferGeometry;
  private readonly particleMaterial: THREE.ShaderMaterial;
  private readonly particleMesh: THREE.Mesh;
  private readonly aOffset: THREE.InstancedBufferAttribute;
  private readonly aScale: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly aFade: THREE.InstancedBufferAttribute;

  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly pz = new Float32Array(MAX_PARTICLES);
  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly vz = new Float32Array(MAX_PARTICLES);
  /** Per-tick velocity retention (fixed 60 Hz, so a plain factor is exact). */
  private readonly damp = new Float32Array(MAX_PARTICLES);
  private readonly grav = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly invMaxLife = new Float32Array(MAX_PARTICLES);
  private readonly sizeStart = new Float32Array(MAX_PARTICLES);
  private readonly sizeEnd = new Float32Array(MAX_PARTICLES);
  private readonly colR = new Float32Array(MAX_PARTICLES);
  private readonly colG = new Float32Array(MAX_PARTICLES);
  private readonly colB = new Float32Array(MAX_PARTICLES);
  private readonly freeIdx = new Int32Array(MAX_PARTICLES);
  private freeTop = 0;

  // --- bolt heads -----------------------------------------------------------
  private readonly headGeometry: THREE.OctahedronGeometry;
  private readonly headMaterial: THREE.MeshBasicMaterial;
  private readonly headMesh: THREE.InstancedMesh;
  private readonly boltLive = new Uint8Array(MAX_BOLTS);
  private readonly boltX = new Float32Array(MAX_BOLTS);
  private readonly boltY = new Float32Array(MAX_BOLTS);
  private readonly boltZ = new Float32Array(MAX_BOLTS);
  private readonly boltScale = new Float32Array(MAX_BOLTS);
  private readonly boltSize = new Float32Array(MAX_BOLTS);
  private readonly boltR = new Float32Array(MAX_BOLTS);
  private readonly boltG = new Float32Array(MAX_BOLTS);
  private readonly boltB = new Float32Array(MAX_BOLTS);
  private headColorDirty = false;
  private spinClock = 0;
  private trailTick = false;

  // --- rings ----------------------------------------------------------------
  private readonly ringGeometry: THREE.RingGeometry;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly ringMesh: THREE.InstancedMesh;
  private readonly ringLive = new Uint8Array(MAX_RINGS);
  private readonly ringX = new Float32Array(MAX_RINGS);
  private readonly ringY = new Float32Array(MAX_RINGS);
  private readonly ringZ = new Float32Array(MAX_RINGS);
  private readonly ringAge = new Float32Array(MAX_RINGS);
  private readonly ringSweep = new Float32Array(MAX_RINGS);
  private readonly ringRadius = new Float32Array(MAX_RINGS);
  private readonly ringR = new Float32Array(MAX_RINGS);
  private readonly ringG = new Float32Array(MAX_RINGS);
  private readonly ringB = new Float32Array(MAX_RINGS);

  constructor(options: SkillVfxOptions) {
    this.scene = options.scene;

    // Base quad, hand-built: PlaneGeometry would work but shares GPU buffers
    // awkwardly with InstancedBufferGeometry; 4 verts by hand is clearer.
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]),
        3,
      ),
    );
    geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2),
    );
    geometry.setIndex([0, 1, 2, 2, 1, 3]);

    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.aScale = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.aFade = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1);
    this.aOffset.setUsage(THREE.DynamicDrawUsage);
    this.aScale.setUsage(THREE.DynamicDrawUsage);
    this.aColor.setUsage(THREE.DynamicDrawUsage);
    this.aFade.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aOffset', this.aOffset);
    geometry.setAttribute('aScale', this.aScale);
    geometry.setAttribute('aColor', this.aColor);
    geometry.setAttribute('aFade', this.aFade);
    geometry.instanceCount = 0;
    this.particleGeometry = geometry;

    this.particleMaterial = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false, // additive glow never occludes (TargetLock's pattern)
      side: THREE.DoubleSide,
    });

    this.particleMesh = new THREE.Mesh(geometry, this.particleMaterial);
    this.particleMesh.name = 'skillParticles';
    // Instance offsets are world-space and change every frame; culling against a
    // stale local bound would blink the whole system off-screen.
    this.particleMesh.frustumCulled = false;
    this.particleMesh.matrixAutoUpdate = false;
    this.particleMesh.renderOrder = 8;
    this.particleMesh.visible = false;
    this.scene.add(this.particleMesh);

    for (let i = 0; i < MAX_PARTICLES; i++) this.freeIdx[i] = i;
    this.freeTop = MAX_PARTICLES;

    this.headGeometry = new THREE.OctahedronGeometry(1, 0); // 8 tris
    this.headMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff, // per-instance colour carries the skill tint
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.headMesh = new THREE.InstancedMesh(this.headGeometry, this.headMaterial, MAX_BOLTS);
    this.headMesh.name = 'skillBoltHeads';
    this.headMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.headMesh.frustumCulled = false;
    this.headMesh.renderOrder = 8;
    this.headMesh.visible = false;
    scratchColor.setRGB(0, 0, 0);
    scratchMatrix.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_BOLTS; i++) {
      this.headMesh.setMatrixAt(i, scratchMatrix);
      this.headMesh.setColorAt(i, scratchColor); // creates instanceColor up front
    }
    this.scene.add(this.headMesh);

    this.ringGeometry = new THREE.RingGeometry(0.78, 1, 20, 1); // 40 tris
    this.ringGeometry.rotateX(-Math.PI / 2); // lie flat; scale carries the radius
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.ringMesh = new THREE.InstancedMesh(this.ringGeometry, this.ringMaterial, MAX_RINGS);
    this.ringMesh.name = 'skillRings';
    this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 8;
    this.ringMesh.visible = false;
    for (let i = 0; i < MAX_RINGS; i++) {
      this.ringMesh.setMatrixAt(i, scratchMatrix);
      this.ringMesh.setColorAt(i, scratchColor);
    }
    this.scene.add(this.ringMesh);
  }

  // --- the pack surface (everything below is (colour, size) driven) ---------

  /**
   * 'glow': soft pulse on the caster. SkillRuntime fires this on EVERY accepted
   * cast — the button must visibly do something the same frame — and again,
   * larger, when a self skill completes.
   */
  castFlash(x: number, y: number, z: number, colorHex: number, sizeScale: number): void {
    scratchColor.setHex(colorHex);
    const r = scratchColor.r;
    const g = scratchColor.g;
    const b = scratchColor.b;
    // Soft body in the skill colour, plus a smaller whitened core — two quads
    // are enough to read as a "flash" instead of a flat disc.
    this.spawnParticle(x, y, z, 0, GLOW_RISE, 0, 0.92, 0, GLOW_LIFE,
      1.05 * sizeScale, 1.5 * sizeScale, r, g, b);
    this.spawnParticle(x, y, z, 0, GLOW_RISE * 1.4, 0, 0.92, 0, GLOW_LIFE * 0.7,
      0.5 * sizeScale, 0.8 * sizeScale,
      r + (1 - r) * 0.6, g + (1 - g) * 0.6, b + (1 - b) * 0.6);
  }

  /**
   * 'bolt': claims a head slot for a projectile. Returns the handle SkillRuntime
   * threads through boltMove/boltEnd, or -1 when the pool is dry (the projectile
   * still flies; §13's back-pressure is to skip the visual, never allocate).
   */
  boltStart(colorHex: number, sizeScale: number, x: number, y: number, z: number): number {
    for (let i = 0; i < MAX_BOLTS; i++) {
      if (this.boltLive[i] !== 0) continue;
      this.boltLive[i] = 1;
      this.boltX[i] = x;
      this.boltY[i] = y;
      this.boltZ[i] = z;
      this.boltScale[i] = HEAD_RADIUS * sizeScale;
      this.boltSize[i] = sizeScale;
      scratchColor.setHex(colorHex);
      this.boltR[i] = scratchColor.r;
      this.boltG[i] = scratchColor.g;
      this.boltB[i] = scratchColor.b;
      this.headMesh.setColorAt(i, scratchColor);
      this.headColorDirty = true;
      return i;
    }
    return -1;
  }

  /** Per rendered frame, with the caller's interpolated position. */
  boltMove(handle: number, x: number, y: number, z: number): void {
    if (handle < 0 || handle >= MAX_BOLTS || this.boltLive[handle] === 0) return;
    this.boltX[handle] = x;
    this.boltY[handle] = y;
    this.boltZ[handle] = z;
  }

  boltEnd(handle: number): void {
    if (handle < 0 || handle >= MAX_BOLTS) return;
    this.boltLive[handle] = 0; // matrix collapses to scale 0 on the next render
  }

  /** 'burst': impact flash — small fast ring plus an upward-biased puff. */
  impact(x: number, y: number, z: number, colorHex: number, sizeScale: number): void {
    this.ringWave(x, y, z, colorHex, sizeScale, IMPACT_RING_RADIUS * sizeScale, IMPACT_RING_SWEEP);
    scratchColor.setHex(colorHex);
    const r = scratchColor.r;
    const g = scratchColor.g;
    const b = scratchColor.b;
    for (let i = 0; i < PUFF_COUNT; i++) {
      const angle = vrand() * TWO_PI;
      const speed = PUFF_SPEED * (0.4 + 0.6 * vrand());
      this.spawnParticle(
        x, y, z,
        Math.cos(angle) * speed, 1.2 + vrand() * 2.4, Math.sin(angle) * speed,
        0.86, PUFF_GRAVITY, PUFF_LIFE * (0.7 + 0.5 * vrand()),
        0.34 * sizeScale, 0.04 * sizeScale, r, g, b,
      );
    }
  }

  /** Minor hit feedback (per-enemy nova touches): a few sparks, no ring. */
  sparkle(x: number, y: number, z: number, colorHex: number, sizeScale: number): void {
    scratchColor.setHex(colorHex);
    for (let i = 0; i < SPARK_COUNT; i++) {
      const angle = vrand() * TWO_PI;
      const speed = SPARK_SPEED * (0.5 + 0.5 * vrand());
      this.spawnParticle(
        x, y, z,
        Math.cos(angle) * speed, 0.8 + vrand() * 1.6, Math.sin(angle) * speed,
        0.88, PUFF_GRAVITY, SPARK_LIFE * (0.7 + 0.5 * vrand()),
        0.2 * sizeScale, 0.03 * sizeScale, scratchColor.r, scratchColor.g, scratchColor.b,
      );
    }
  }

  /**
   * 'ring': expanding nova ring. `radius` is the TRUE damage radius so the
   * visual never lies about the area; `sweepSeconds` matches the damage sweep
   * (SkillRuntime floors it for instant novas so they still animate). If all 6
   * slots are busy the wave is skipped — back-pressure, not allocation.
   */
  ringWave(
    x: number, y: number, z: number,
    colorHex: number, sizeScale: number,
    radius: number, sweepSeconds: number,
  ): void {
    for (let i = 0; i < MAX_RINGS; i++) {
      if (this.ringLive[i] !== 0) continue;
      this.ringLive[i] = 1;
      this.ringX[i] = x;
      this.ringY[i] = y;
      this.ringZ[i] = z;
      this.ringAge[i] = 0;
      this.ringSweep[i] = sweepSeconds > 0.01 ? sweepSeconds : 0.01;
      this.ringRadius[i] = radius;
      scratchColor.setHex(colorHex);
      // sizeScale brightens rather than widens: the radius is gameplay truth.
      const boost = 0.75 + 0.25 * sizeScale;
      this.ringR[i] = scratchColor.r * boost;
      this.ringG[i] = scratchColor.g * boost;
      this.ringB[i] = scratchColor.b * boost;
      return;
    }
  }

  // --- System ---------------------------------------------------------------

  update(dt: number): void {
    this.spinClock += dt;
    if (this.spinClock > 1e6) this.spinClock = 0; // keep the float precise

    // Particle sim: scalar slab walk, frees pushed back on the stack.
    const life = this.life;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const remaining = life[i] ?? 0;
      if (remaining <= 0) continue;
      const next = remaining - dt;
      if (next <= 0) {
        life[i] = 0;
        this.freeIdx[this.freeTop] = i;
        this.freeTop++;
        continue;
      }
      life[i] = next;
      const nvy = (this.vy[i] ?? 0) + (this.grav[i] ?? 0) * dt;
      const d = this.damp[i] ?? 1;
      this.px[i] = (this.px[i] ?? 0) + (this.vx[i] ?? 0) * dt;
      this.py[i] = (this.py[i] ?? 0) + nvy * dt;
      this.pz[i] = (this.pz[i] ?? 0) + (this.vz[i] ?? 0) * dt;
      this.vx[i] = (this.vx[i] ?? 0) * d;
      this.vy[i] = nvy * d;
      this.vz[i] = (this.vz[i] ?? 0) * d;
    }

    // Trails: every second tick, one puff per live bolt at its last position.
    this.trailTick = !this.trailTick;
    if (this.trailTick) {
      for (let i = 0; i < MAX_BOLTS; i++) {
        if (this.boltLive[i] === 0) continue;
        const size = this.boltSize[i] ?? 1;
        this.spawnParticle(
          this.boltX[i] ?? 0, this.boltY[i] ?? 0, this.boltZ[i] ?? 0,
          0, 0, 0, 1, 0, TRAIL_LIFE,
          TRAIL_SIZE * size, 0.03 * size,
          this.boltR[i] ?? 1, this.boltG[i] ?? 1, this.boltB[i] ?? 1,
        );
      }
    }

    // Rings age here; radii and brightness are derived in render.
    for (let i = 0; i < MAX_RINGS; i++) {
      if (this.ringLive[i] === 0) continue;
      const age = (this.ringAge[i] ?? 0) + dt;
      this.ringAge[i] = age;
      if (age >= (this.ringSweep[i] ?? 0) + RING_FADE) this.ringLive[i] = 0;
    }
  }

  /** Writes the GPU-visible state. Compaction order is free under additive blending. */
  render(): void {
    // Particles → instanced attributes, compacted to the live count.
    const offsets = this.aOffset.array as Float32Array;
    const scales = this.aScale.array as Float32Array;
    const colors = this.aColor.array as Float32Array;
    const fades = this.aFade.array as Float32Array;
    let n = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const remaining = this.life[i] ?? 0;
      if (remaining <= 0) continue;
      const t = remaining * (this.invMaxLife[i] ?? 0); // 1 at spawn → 0 at death
      const o3 = n * 3;
      offsets[o3] = this.px[i] ?? 0;
      offsets[o3 + 1] = this.py[i] ?? 0;
      offsets[o3 + 2] = this.pz[i] ?? 0;
      const s0 = this.sizeStart[i] ?? 0;
      const s1 = this.sizeEnd[i] ?? 0;
      scales[n] = s1 + (s0 - s1) * t;
      colors[o3] = this.colR[i] ?? 0;
      colors[o3 + 1] = this.colG[i] ?? 0;
      colors[o3 + 2] = this.colB[i] ?? 0;
      fades[n] = t;
      n++;
    }
    if (n > 0) {
      this.particleGeometry.instanceCount = n;
      this.aOffset.needsUpdate = true;
      this.aScale.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aFade.needsUpdate = true;
      this.particleMesh.visible = true;
    } else {
      this.particleGeometry.instanceCount = 0;
      this.particleMesh.visible = false;
    }

    // Heads: compose 16 matrices (trivial), dead slots collapse to scale 0.
    let anyHead = false;
    for (let i = 0; i < MAX_BOLTS; i++) {
      if (this.boltLive[i] !== 0) {
        anyHead = true;
        scratchPosition.set(this.boltX[i] ?? 0, this.boltY[i] ?? 0, this.boltZ[i] ?? 0);
        const phase = this.spinClock * HEAD_SPIN_RATE + i * 0.7;
        scratchEuler.set(phase * 0.6, phase, 0);
        scratchQuat.setFromEuler(scratchEuler);
        scratchScale.setScalar(this.boltScale[i] ?? HEAD_RADIUS);
        scratchMatrix.compose(scratchPosition, scratchQuat, scratchScale);
      } else {
        scratchMatrix.makeScale(0, 0, 0);
      }
      this.headMesh.setMatrixAt(i, scratchMatrix);
    }
    this.headMesh.instanceMatrix.needsUpdate = true;
    if (this.headColorDirty) {
      const headColors = this.headMesh.instanceColor;
      if (headColors !== null) headColors.needsUpdate = true;
      this.headColorDirty = false;
    }
    this.headMesh.visible = anyHead;

    // Rings: quadratic-out expansion, then fade by darkening (additive black = gone).
    let anyRing = false;
    for (let i = 0; i < MAX_RINGS; i++) {
      if (this.ringLive[i] !== 0) {
        anyRing = true;
        const age = this.ringAge[i] ?? 0;
        const sweep = this.ringSweep[i] ?? 0.01;
        let t = age / sweep;
        if (t > 1) t = 1;
        const eased = 1 - (1 - t) * (1 - t);
        let radius = (this.ringRadius[i] ?? 0) * eased;
        if (radius < 0.02) radius = 0.02;
        const bright = age <= sweep ? 1 : 1 - (age - sweep) / RING_FADE;
        scratchPosition.set(this.ringX[i] ?? 0, this.ringY[i] ?? 0, this.ringZ[i] ?? 0);
        scratchScale.set(radius, 1, radius);
        scratchMatrix.compose(scratchPosition, identityQuat, scratchScale);
        scratchColor.setRGB(
          (this.ringR[i] ?? 0) * bright,
          (this.ringG[i] ?? 0) * bright,
          (this.ringB[i] ?? 0) * bright,
        );
      } else {
        scratchMatrix.makeScale(0, 0, 0);
        scratchColor.setRGB(0, 0, 0);
      }
      this.ringMesh.setMatrixAt(i, scratchMatrix);
      this.ringMesh.setColorAt(i, scratchColor);
    }
    this.ringMesh.instanceMatrix.needsUpdate = true;
    const ringColors = this.ringMesh.instanceColor;
    if (ringColors !== null) ringColors.needsUpdate = true;
    this.ringMesh.visible = anyRing;
  }

  reset(): void {
    this.life.fill(0);
    for (let i = 0; i < MAX_PARTICLES; i++) this.freeIdx[i] = i;
    this.freeTop = MAX_PARTICLES;
    this.boltLive.fill(0);
    this.ringLive.fill(0);
    this.spinClock = 0;
    this.trailTick = false;
    this.headColorDirty = false;
    this.particleGeometry.instanceCount = 0;
    this.particleMesh.visible = false;
    this.headMesh.visible = false;
    this.ringMesh.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.particleMesh);
    this.scene.remove(this.headMesh);
    this.scene.remove(this.ringMesh);
    this.particleGeometry.dispose();
    this.particleMaterial.dispose();
    this.headGeometry.dispose();
    this.headMaterial.dispose();
    this.headMesh.dispose();
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
    this.ringMesh.dispose();
  }

  // --- internals ------------------------------------------------------------

  private spawnParticle(
    x: number, y: number, z: number,
    velX: number, velY: number, velZ: number,
    dampPerTick: number, gravity: number, lifeSeconds: number,
    startSize: number, endSize: number,
    r: number, g: number, b: number,
  ): void {
    if (this.freeTop === 0) return; // slab full — skip the quad, never allocate (§13)
    this.freeTop--;
    const i = this.freeIdx[this.freeTop] ?? 0;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = velX;
    this.vy[i] = velY;
    this.vz[i] = velZ;
    this.damp[i] = dampPerTick;
    this.grav[i] = gravity;
    this.life[i] = lifeSeconds;
    this.invMaxLife[i] = 1 / lifeSeconds;
    this.sizeStart[i] = startSize;
    this.sizeEnd[i] = endSize;
    this.colR[i] = r;
    this.colG[i] = g;
    this.colB[i] = b;
  }
}
