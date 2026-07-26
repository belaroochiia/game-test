import * as THREE from 'three';

import type { System } from '../core/Engine';
import type { EventBus } from '../core/EventBus';
import { ObjectPool } from '../core/ObjectPool';
import type { PlayerController } from '../player/PlayerController';
import type { Grimoire, SkillAcquiredEvent } from './Grimoire';
import type { SkillRegistry } from './SkillRegistry';
import type { SkillDef } from './SkillTypes';

/**
 * §8.2.1's Soul Absorption drop: an enemy dies, an orb may float up carrying an
 * UNKNOWN skill; the player holds the (contextual) attack button for 1.2 s
 * inside 1.8 u to absorb it. Completion goes through Grimoire.learn, which
 * emits 'grimoire:acquired' — Notifications turns that into the moment.
 *
 * GPU cost: pooled 8 orbs, each a 20-tri additive icosahedron + 28-tri ground
 * ring, TWO shared materials for the whole system (§3's 12-material cap).
 * Worst case 16 draw calls / 384 tris at the 8-orb cap; typically 1-2 orbs.
 * No textures (§5) — additive blending IS the glow.
 *
 * Zero allocation per frame: fixed live slab with swap-remove, pooled visuals
 * (§13), scalar-only math in update/render. maybeDrop is event-frequency
 * (enemy deaths) and also allocates nothing once the pool is warm.
 */

/** Payload of 'grimoire:acquired'; EventBus.ts is integrator-owned, so the map
 * key is declared from here (same pattern as DamageSystem's 'combat:damage').
 * The event is emitted by Grimoire.learn ONLY — declaring the key here and
 * emitting there keeps orb and fusion acquisitions single-sourced. */
declare module '../core/EventBus' {
  interface GameEventMap {
    'grimoire:acquired': SkillAcquiredEvent;
  }
}

/** Contract: at most 8 live orbs; the pool is the cap's enforcement. */
const MAX_ORBS = 8;
/** §8.2 (contract numbers): hold 1.2 s within 1.8 u. */
const ABSORB_RANGE = 1.8;
const ABSORB_RANGE_SQ = ABSORB_RANGE * ABSORB_RANGE;
const ABSORB_SECONDS = 1.2;
/** Unclaimed orbs despawn — a littered battlefield reads as a leak. */
const ORB_LIFETIME = 30;
/** Blink for the last seconds so the timeout never reads as theft. */
const EXPIRY_WARN = 4;

const CORE_RADIUS = 0.26;
const HOVER_HEIGHT = 0.85;
const BOB_AMPLITUDE = 0.12;
const BOB_HZ = 2.3;
const SPIN_RATE = 1.7;
const RING_LIFT = 0.05;
const RING_SCALE = 0.55;
/** Pale spirit-cyan; ONE color for every orb — per-element tint would need
 * per-orb materials and break the shared-material rule. */
const SOUL_COLOR = 0x8fd8ff;
const RING_OPACITY = 0.28;
const CORE_OPACITY = 0.9;
const TAU = Math.PI * 2;

/**
 * mulberry32 over module state — DamageSystem's pattern, third independent
 * stream (crit / status / drops), so the gate can seed drops and replay a kill
 * sequence without shifting combat rolls.
 */
let rngState = 0x50f7b0e5;

export function setOrbSeed(n: number): void {
  rngState = n >>> 0;
}

function rand(): number {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** One pooled orb: fixed field set, mutated in place, never re-created. */
interface Orb {
  root: THREE.Group;
  core: THREE.Mesh;
  ring: THREE.Mesh;
  skillId: string;
  age: number;
  baseX: number;
  baseY: number;
  baseZ: number;
  /** Per-orb visual offset so simultaneous orbs don't bob in lockstep. */
  phase: number;
  /** Accumulated spin — accumulating (vs t×rate) keeps the absorb spin-up
   * continuous instead of snapping when the hold starts or cancels. */
  spin: number;
}

export interface SoulOrbsOptions {
  scene: THREE.Scene;
  player: PlayerController;
  grimoire: Grimoire;
  registry: SkillRegistry;
  /** Unused here: 'grimoire:acquired' is emitted by Grimoire.learn (single
   * source). Kept in the options per the phase contract's constructor shape. */
  bus: EventBus;
}

export class SoulOrbs implements System {
  readonly name = 'orbs';

  private readonly scene: THREE.Scene;
  private readonly player: PlayerController;
  private readonly grimoire: Grimoire;
  private readonly registry: SkillRegistry;

  private readonly coreGeometry: THREE.BufferGeometry;
  private readonly ringGeometry: THREE.BufferGeometry;
  private readonly coreMaterial: THREE.MeshBasicMaterial;
  private readonly ringMaterial: THREE.MeshBasicMaterial;

  private readonly pool: ObjectPool<Orb>;
  /** Every orb ever built, for dispose(). */
  private readonly allOrbs: Orb[] = [];
  /** Dense live slab, swap-removed — iterated every tick, never reallocated. */
  private readonly live: Array<Orb | undefined> = new Array<Orb | undefined>(MAX_ORBS).fill(undefined);
  private liveCount = 0;

  private absorbing = false;
  private absorbTimer = 0;
  /** The orb the current hold is bound to; sticky while live and in range. */
  private absorbTargetRef: Orb | null = null;
  private nearbyFlag = false;

  /** Own frame clock for render() (render rate != tick rate) — SlimeEnemy's pattern. */
  private clock = 0;
  private lastNow = 0;

  constructor(options: SoulOrbsOptions) {
    this.scene = options.scene;
    this.player = options.player;
    this.grimoire = options.grimoire;
    this.registry = options.registry;

    this.coreGeometry = new THREE.IcosahedronGeometry(CORE_RADIUS, 0); // 20 tris
    // Unit-radius ring lying flat (+Y normal); scaled per orb. 28 tris.
    this.ringGeometry = new THREE.RingGeometry(0.72, 1, 14, 1);
    this.ringGeometry.rotateX(-Math.PI / 2);
    this.coreMaterial = new THREE.MeshBasicMaterial({
      color: SOUL_COLOR,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: CORE_OPACITY,
      depthWrite: false,
    });
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: SOUL_COLOR,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: RING_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Fully pre-warmed at the cap: nothing is ever built mid-frame (§3, §13).
    this.pool = new ObjectPool<Orb>(() => this.buildOrb(), {
      initial: MAX_ORBS,
      max: MAX_ORBS,
      label: 'soul-orbs',
      onAcquire: (orb: Orb): void => {
        orb.root.visible = true;
        orb.core.visible = true;
      },
      // Idempotent (releaseAll may re-run it on free orbs — pool contract).
      onRelease: (orb: Orb): void => {
        orb.root.visible = false;
      },
    });
  }

  /**
   * Called by the integrator on every enemy death (§8.2.1's skillDropChance).
   * Rolls the drop, then picks a seeded-weighted UNKNOWN skill with
   * dropWeight > 0 that no live orb already carries (so two floating orbs are
   * never the same skill). No eligible skill → no orb: a full collection gets
   * nothing, exactly as §8.2 wants. Pool at the 8-cap → silently skipped.
   */
  maybeDrop(x: number, y: number, z: number, dropChance: number, seedNoise: number): void {
    // Fold caller noise (enemy id/seed) into the stream: two deaths in the same
    // tick roll differently, yet the sequence replays exactly under setOrbSeed.
    // (n * 0x10001) | 0 lands ints and unit-fraction floats alike on an int32.
    const noise = (seedNoise * 0x10001) | 0;
    rngState = (rngState + Math.imul(noise ^ 0x5bf03635, 0x9e3779b1)) >>> 0;
    if (rand() >= dropChance) return;

    const all = this.registry.all;
    let total = 0;
    for (let i = 0; i < all.length; i++) {
      const def = all[i];
      if (def === undefined || def.dropWeight <= 0) continue;
      if (this.grimoire.isKnown(def.id) || this.isCarried(def.id)) continue;
      total += def.dropWeight;
    }
    if (total <= 0) return;

    const orb = this.pool.acquire();
    if (orb === undefined) return;

    let pick = rand() * total;
    let chosen: SkillDef | null = null;
    for (let i = 0; i < all.length; i++) {
      const def = all[i];
      if (def === undefined || def.dropWeight <= 0) continue;
      if (this.grimoire.isKnown(def.id) || this.isCarried(def.id)) continue;
      if (pick < def.dropWeight) {
        chosen = def;
        break;
      }
      pick -= def.dropWeight;
    }
    if (chosen === null) {
      // Float-edge belt; the weights guarantee a pick, but never leak the orb.
      this.pool.release(orb);
      return;
    }

    orb.skillId = chosen.id;
    orb.age = 0;
    orb.baseX = x;
    orb.baseY = y;
    orb.baseZ = z;
    // Visual phase from position, not the PRNG — cosmetics must not shift the
    // seeded drop stream.
    orb.phase = (((x * 0.73 + z * 1.31) % TAU) + TAU) % TAU;
    orb.spin = orb.phase;
    orb.root.position.set(x, y, z);
    this.live[this.liveCount] = orb;
    this.liveCount++;
  }

  /** True while any orb is within absorb range. TouchControls reads this to
   * flip the attack button into ABSORB (contract decision 1). */
  get nearbyOrb(): boolean {
    return this.nearbyFlag;
  }

  /** Driven by TouchControls' hold on the contextual button. Releasing resets
   * the hold; moving out of range mid-hold cancels inside update(). */
  setAbsorbing(active: boolean): void {
    if (this.absorbing === active) return;
    this.absorbing = active;
    if (!active) {
      this.absorbTimer = 0;
      this.absorbTargetRef = null;
    }
  }

  /** 0..1 hold progress — the button sweep renders this. */
  get absorbProgress(): number {
    const progress = this.absorbTimer / ABSORB_SECONDS;
    return progress > 1 ? 1 : progress;
  }

  /** For the debug surface's orbs() count. */
  get liveOrbCount(): number {
    return this.liveCount;
  }

  update(dt: number): void {
    // Lifetimes first (backwards: swap-remove pulls already-aged tail entries).
    for (let i = this.liveCount - 1; i >= 0; i--) {
      const orb = this.live[i];
      if (orb === undefined) continue;
      orb.age += dt;
      if (orb.age >= ORB_LIFETIME) this.despawnAt(i);
    }

    const p = this.player.position;
    const px = p.x;
    const py = p.y;
    const pz = p.z;

    let nearest: Orb | null = null;
    let nearestDistSq = ABSORB_RANGE_SQ;
    for (let i = 0; i < this.liveCount; i++) {
      const orb = this.live[i];
      if (orb === undefined) continue;
      const dx = orb.baseX - px;
      const dy = orb.baseY - py;
      const dz = orb.baseZ - pz;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq <= nearestDistSq) {
        nearestDistSq = distSq;
        nearest = orb;
      }
    }
    this.nearbyFlag = nearest !== null;

    if (!this.absorbing) {
      this.absorbTimer = 0;
      this.absorbTargetRef = null;
      return;
    }

    // Sticky target: the orb the hold started on keeps its progress while it
    // stays live and in range. Leaving range cancels (§8.2); a despawn cancels;
    // re-entering range starts a fresh 1.2 s hold on the nearest orb.
    let target = this.absorbTargetRef;
    if (target !== null && !this.stillAbsorbable(target, px, py, pz)) {
      target = null;
      this.absorbTimer = 0;
    }
    if (target === null) target = nearest;
    this.absorbTargetRef = target;
    if (target === null) {
      this.absorbTimer = 0;
      return;
    }

    this.absorbTimer += dt;
    if (this.absorbTimer >= ABSORB_SECONDS) this.completeAbsorb(target);
  }

  /** Bob + spin + absorb feedback. Scalar writes into existing objects only (§13). */
  render(): void {
    const now = performance.now();
    if (this.lastNow === 0) this.lastNow = now;
    let fdt = (now - this.lastNow) * 0.001;
    this.lastNow = now;
    if (fdt < 0) fdt = 0;
    else if (fdt > 0.1) fdt = 0.1;
    this.clock += fdt;
    const t = this.clock;

    const progress = this.absorbProgress;
    for (let i = 0; i < this.liveCount; i++) {
      const orb = this.live[i];
      if (orb === undefined) continue;
      const held = orb === this.absorbTargetRef ? progress : 0;
      const wobble = Math.sin(t * BOB_HZ + orb.phase);
      // Absorb feedback: the held orb tightens its bob, spins up and swells —
      // the button sweep shows the number, the orb shows the pull.
      orb.spin += fdt * SPIN_RATE * (1 + held * 3);
      orb.core.position.y = HOVER_HEIGHT + wobble * BOB_AMPLITUDE * (1 - held * 0.6);
      orb.core.rotation.y = orb.spin;
      const scale = 1 + held * 0.45 + wobble * 0.04;
      orb.core.scale.set(scale, scale, scale);
      const ringScale = RING_SCALE * (1 + wobble * 0.06 + held * 0.35);
      orb.ring.scale.set(ringScale, 1, ringScale);
      const left = ORB_LIFETIME - orb.age;
      orb.core.visible = left > EXPIRY_WARN || Math.sin(t * 14) > -0.3;
    }
  }

  reset(): void {
    this.pool.releaseAll();
    for (let i = 0; i < this.live.length; i++) this.live[i] = undefined;
    this.liveCount = 0;
    this.absorbing = false;
    this.absorbTimer = 0;
    this.absorbTargetRef = null;
    this.nearbyFlag = false;
  }

  dispose(): void {
    // Teardown, not frame path — §3 relaxes here.
    for (let i = 0; i < this.allOrbs.length; i++) {
      const orb = this.allOrbs[i];
      if (orb !== undefined) this.scene.remove(orb.root);
    }
    this.coreGeometry.dispose();
    this.ringGeometry.dispose();
    this.coreMaterial.dispose();
    this.ringMaterial.dispose();
  }

  // --- internals ------------------------------------------------------------

  /** Pool factory — runs MAX_ORBS times at construction, never mid-frame. */
  private buildOrb(): Orb {
    const root = new THREE.Group();
    root.name = 'soul-orb';
    root.visible = false;
    const core = new THREE.Mesh(this.coreGeometry, this.coreMaterial);
    core.position.y = HOVER_HEIGHT;
    core.renderOrder = 2;
    const ring = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
    ring.position.y = RING_LIFT;
    ring.scale.set(RING_SCALE, 1, RING_SCALE);
    ring.renderOrder = 2;
    root.add(core);
    root.add(ring);
    this.scene.add(root);
    const orb: Orb = {
      root,
      core,
      ring,
      skillId: '',
      age: 0,
      baseX: 0,
      baseY: 0,
      baseZ: 0,
      phase: 0,
      spin: 0,
    };
    this.allOrbs.push(orb);
    return orb;
  }

  private isCarried(id: string): boolean {
    for (let i = 0; i < this.liveCount; i++) {
      const orb = this.live[i];
      if (orb !== undefined && orb.skillId === id) return true;
    }
    return false;
  }

  private stillAbsorbable(orb: Orb, px: number, py: number, pz: number): boolean {
    let isLive = false;
    for (let i = 0; i < this.liveCount; i++) {
      if (this.live[i] === orb) {
        isLive = true;
        break;
      }
    }
    if (!isLive) return false;
    const dx = orb.baseX - px;
    const dy = orb.baseY - py;
    const dz = orb.baseZ - pz;
    return dx * dx + dy * dy + dz * dz <= ABSORB_RANGE_SQ;
  }

  private completeAbsorb(orb: Orb): void {
    // learn() emits 'grimoire:acquired' — Notifications makes the §8.2 moment.
    // A false return (skill gained by another path while the orb floated, e.g.
    // debug learn) is a silent consume: no moment for something already owned.
    this.grimoire.learn(orb.skillId, 'orb');
    for (let i = 0; i < this.liveCount; i++) {
      if (this.live[i] === orb) {
        this.despawnAt(i);
        break;
      }
    }
    this.absorbTimer = 0;
    this.absorbTargetRef = null;
  }

  private despawnAt(index: number): void {
    const orb = this.live[index];
    if (orb === undefined) return;
    if (this.absorbTargetRef === orb) {
      // Mid-hold despawn (30 s ran out): cancel, don't complete.
      this.absorbTargetRef = null;
      this.absorbTimer = 0;
    }
    this.pool.release(orb);
    const last = this.liveCount - 1;
    this.live[index] = this.live[last];
    this.live[last] = undefined;
    this.liveCount = last;
  }
}
