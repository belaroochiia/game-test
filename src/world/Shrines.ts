import * as THREE from 'three';

import type { System } from '../core/Engine';
import type { EventBus } from '../core/EventBus';
import type { EnemyBase } from '../enemy/EnemyBase';
import type { EnemyDef, EnemyDefs } from '../enemy/EnemyDefs';
import type { EnemyManager } from '../enemy/EnemyManager';
import type { PlayerController } from '../player/PlayerController';
import type { Grimoire } from '../skills/Grimoire';
import type { SkillRegistry } from '../skills/SkillRegistry';
import type { ElementId } from '../skills/SkillTypes';
import { BIOME, createBiomeSample, hash2 } from './BiomeTable';
import type { BiomeId, BiomeSample, BiomeTable } from './BiomeTable';
import { SEA_LEVEL, SPIRE_PLATEAU_X, SPIRE_PLATEAU_Z } from './HeightField';
import type { HeightSampler } from './HeightField';

/**
 * §8.2.2's six Elemental Shrines: one per element, seeded into its home region,
 * each a small stone monument with a floating element-coloured gem and one
 * challenge FSM (idle → active → done; fail → idle, retryable). Success is a
 * guaranteed Epic: the skill whose `shrineElement` field names this shrine's
 * element (skills.json, agent E — looked up by field, NO ids in TS, §4.1) is
 * learned via grimoire.learn(id, 'shrine'), which fires the ACQUIRED moment by
 * itself.
 *
 * GPU cost per shrine: ONE merged vertex-coloured stone mesh (ring + pillar +
 * torch poles, ≤ 170 tris), one gem, one ground glow ring, up to 4 torch-tip
 * glows (hidden until lit) — ≤ 236 tris and 3–7 draws, and the whole root is
 * distance-culled at 150 u, so at most one shrine is ever actually drawn. TWO
 * materials for shrines AND fragment sites together (shared via
 * acquireSiteAssets below — Fragments.ts imports them), honouring §3's
 * 12-material cap. No textures (§5): additive blending IS the glow.
 *
 * Survive-wave pressure is driven straight through manager.spawnDef with
 * region-valid defs (the contract names a SpawnDirector reference here, but
 * SpawnDirector compiles in parallel this phase — deviation noted in the
 * report). spawnDef enforces §9's 18-cap, so waves can never blow the budget.
 *
 * Zero allocation per frame: shrines are fixed records mutated in place,
 * update/render are scalar-only, and the two poll objects TouchControls/HUD
 * read (nearbyShrine, challengeStatus) are reused scratch.
 */

// ---------------------------------------------------------------------------
// Shared site assets — also used by Fragments.ts (same two materials, §3)
// ---------------------------------------------------------------------------

export interface SiteAssets {
  /** Vertex-coloured lit stone; shared by every shrine and fragment site. */
  readonly stone: THREE.MeshLambertMaterial;
  /** Vertex-coloured additive glow (gems, rings, shards, torch tips). */
  readonly glow: THREE.MeshBasicMaterial;
}

interface SiteAssetsStore extends SiteAssets {
  refs: number;
}

let siteAssets: SiteAssetsStore | null = null;

/** Ref-counted (SlimeEnemy's assets pattern): built once, disposed at zero. */
export function acquireSiteAssets(): SiteAssets {
  if (siteAssets === null) {
    siteAssets = {
      stone: new THREE.MeshLambertMaterial({ vertexColors: true }),
      glow: new THREE.MeshBasicMaterial({
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      refs: 0,
    };
  }
  siteAssets.refs++;
  return siteAssets;
}

export function releaseSiteAssets(): void {
  if (siteAssets === null) return;
  siteAssets.refs--;
  if (siteAssets.refs > 0) return;
  siteAssets.stone.dispose();
  siteAssets.glow.dispose();
  siteAssets = null;
}

/** §5 palette accents, one per element. Water has no shrine (§8.2.2 lists six). */
export function elementColor(element: ElementId): number {
  switch (element) {
    case 'fire':
      return 0xff7a1c;
    case 'ice':
      return 0x9fe8ff;
    case 'wind':
      return 0xa9f0b6;
    case 'earth':
      return 0xd8a24e;
    case 'water':
      return 0x4fa8e8;
    case 'light':
      return 0xffe9a3;
    case 'dark':
      return 0xb44cff;
  }
}

// ---------------------------------------------------------------------------
// Merged-geometry builder — construction-time only, shared with Fragments.ts
// ---------------------------------------------------------------------------

const STONE_HEX = 0x8d8b84;
const FACE_JITTER_BASE = 0.82;
const FACE_JITTER_SPAN = 0.3;
const JITTER_SALT = 977;

const scratchColor = new THREE.Color();

interface SoupTemplate {
  positions: Float32Array;
  normals: Float32Array;
}

let boxTemplate: SoupTemplate | null = null;
let pillarTemplate: SoupTemplate | null = null;

function soupFrom(geometry: THREE.BufferGeometry): SoupTemplate {
  const soup = geometry.toNonIndexed();
  const template: SoupTemplate = {
    positions: new Float32Array(soup.getAttribute('position').array),
    normals: new Float32Array(soup.getAttribute('normal').array),
  };
  soup.dispose();
  geometry.dispose();
  return template;
}

function getBoxTemplate(): SoupTemplate {
  if (boxTemplate === null) boxTemplate = soupFrom(new THREE.BoxGeometry(1, 1, 1)); // 12 tris
  return boxTemplate;
}

function getPillarTemplate(): SoupTemplate {
  // 6-sided tapered column, 24 tris; unit height, feet at y=0, scaled on add.
  if (pillarTemplate === null) {
    const geometry = new THREE.CylinderGeometry(0.34, 0.52, 1, 6, 1);
    geometry.translate(0, 0.5, 0);
    pillarTemplate = soupFrom(geometry);
  }
  return pillarTemplate;
}

/**
 * Accumulates yaw-rotated, scaled boxes/pillars into ONE vertex-coloured
 * geometry — a whole monument is a single draw call. Flat per-face colour
 * jitter (SlimeEnemy's trick) keeps big facets from reading as plastic (§5).
 * Construction-time only; §3 does not apply here.
 */
export class SiteMeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];

  addBox(
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    yaw: number,
    hex: number,
    jitterSeed: number,
  ): void {
    this.append(getBoxTemplate(), cx, cy, cz, sx, sy, sz, yaw, hex, jitterSeed);
  }

  addPillar(cx: number, cy: number, cz: number, width: number, height: number, hex: number, jitterSeed: number): void {
    this.append(getPillarTemplate(), cx, cy, cz, width, height, width, 0, hex, jitterSeed);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.normals), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.colors), 3));
    return geometry;
  }

  private append(
    template: SoupTemplate,
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    yaw: number,
    hex: number,
    jitterSeed: number,
  ): void {
    scratchColor.setHex(hex);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const src = template.positions;
    const nrm = template.normals;
    const count = src.length / 3;
    for (let i = 0; i < count; i++) {
      const lx = (src[i * 3] ?? 0) * sx;
      const ly = (src[i * 3 + 1] ?? 0) * sy;
      const lz = (src[i * 3 + 2] ?? 0) * sz;
      this.positions.push(lx * cos + lz * sin + cx, ly + cy, -lx * sin + lz * cos + cz);
      const nx = nrm[i * 3] ?? 0;
      const ny = nrm[i * 3 + 1] ?? 0;
      const nz = nrm[i * 3 + 2] ?? 0;
      this.normals.push(nx * cos + nz * sin, ny, -nx * sin + nz * cos);
      // Same jitter for the whole face (6 verts per box quad) => flat facets.
      const face = (i / 6) | 0;
      const jitter = FACE_JITTER_BASE + hash2(face, jitterSeed, JITTER_SALT) * FACE_JITTER_SPAN;
      this.colors.push(scratchColor.r * jitter, scratchColor.g * jitter, scratchColor.b * jitter);
    }
  }
}

/** Bakes one uniform colour into a glow geometry (additive: intensity = brightness). */
export function paintGlow(geometry: THREE.BufferGeometry, hex: number, intensity: number): THREE.BufferGeometry {
  scratchColor.setHex(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = scratchColor.r * intensity;
    colors[i * 3 + 1] = scratchColor.g * intensity;
    colors[i * 3 + 2] = scratchColor.b * intensity;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// ---------------------------------------------------------------------------
// Seeding — mulberry32 over module state, SoulOrbs' pattern (own stream)
// ---------------------------------------------------------------------------

let shrineSeed = 0x517e11a3;

/** Placement is rolled at construction; re-seed BEFORE constructing (gate use). */
export function setShrineSeed(n: number): void {
  shrineSeed = n >>> 0;
}

function makeRand(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Placement + challenge tables (contract §8.2.2 / the Decisions)
// ---------------------------------------------------------------------------

export type ShrineState = 'idle' | 'active' | 'done';
export type ChallengeKind = 'survive60' | 'torches4in90' | 'guardian';

/** The six shrine elements, fixed order (water has no shrine). */
const SHRINE_ELEMENTS: readonly ElementId[] = ['fire', 'ice', 'wind', 'earth', 'light', 'dark'];
/**
 * Two of each challenge across the six (contract), assigned where they read
 * best: guardians in the hostile flanks, torch hunts where the region invites
 * wandering, survival where waves feel like a siege.
 */
const CHALLENGE_OF: readonly ChallengeKind[] = [
  'guardian', // fire — Emberscar
  'torches4in90', // ice — Frostvale
  'survive60', // wind — Verdant disc edge
  'guardian', // earth — Whisperwood edge
  'torches4in90', // light — Verdant heart
  'survive60', // dark — Spire outskirts
];

/**
 * Proposal boxes per element (thematically right region, the contract's
 * fire→Emberscar / ice→Frostvale / wind+earth→Verdant-Whisperwood edges /
 * light→Verdant / dark→Spire outskirts). Boxes only speed up the rejection
 * sampling — the biome test below is what actually decides membership.
 * [region, x0, x1, z0, z1, rMin, rMax] with rMin/rMax a distance band from
 * the origin (0 = unconstrained).
 */
const PLACE_RULES: readonly (readonly [BiomeId, number, number, number, number, number, number])[] = [
  [BIOME.Emberscar, 88, 262, -50, 100, 0, 0],
  [BIOME.Frostvale, -262, -88, -50, 100, 0, 0],
  [BIOME.VerdantHollow, -115, 115, -35, 115, 78, 112], // wind: the disc's edge
  [BIOME.Whisperwood, -150, 150, -135, -70, 0, 0], // earth: the southern border band
  [BIOME.VerdantHollow, -100, 100, -100, 100, 60, 95], // light: inner Verdant
  [BIOME.HollowSpire, -160, 160, 132, 262, 0, 0],
];

/** §8.2.2: every shrine sits ≥ 60 u out and on ground flatter than 20°. */
const MIN_SPAWN_DIST = 60;
const SLOPE_LIMIT = (20 * Math.PI) / 180;
const SLOPE_LIMIT_RELAXED = (25 * Math.PI) / 180;
const MIN_SEPARATION = 40;
const MIN_SEPARATION_RELAXED = 30;
/** Stay off §5's rim cliff and out of the fog sea. */
const RIM_LIMIT = 268;
const MIN_GROUND = SEA_LEVEL + 0.5;
/** The dark shrine is Spire OUTSKIRTS — clear of the boss plateau (agent E). */
const PLATEAU_CLEAR = 55;
const PLACE_TRIES = 5000;
/** Ring-stone footprint; slope is checked here too so the monument sits sane. */
const FOOT_RADIUS = 2.6;

// ---------------------------------------------------------------------------
// Gameplay numbers (contract §8.2.2)
// ---------------------------------------------------------------------------

const INTERACT_RADIUS = 5;
const INTERACT_RADIUS_SQ = INTERACT_RADIUS * INTERACT_RADIUS;
const VIS_DIST_SQ = 150 * 150;

const SURVIVE_SECONDS = 60;
const SURVIVE_RADIUS = 25;
const SURVIVE_RADIUS_SQ = SURVIVE_RADIUS * SURVIVE_RADIUS;
/** Out of the circle for longer than this and the siege is abandoned. */
const SURVIVE_GRACE_SECONDS = 5;
const WAVE_INTERVAL = 6;
const WAVE_SIZE = 2;
const WAVE_RING_MIN = 12;
const WAVE_RING_SPAN = 4;

const TORCH_SECONDS = 90;
const TORCH_COUNT = 4;
const TORCH_RADIUS_MIN = 8;
const TORCH_RADIUS_SPAN = 6;
const TORCH_LIGHT_RADIUS = 1.2;
const TORCH_LIGHT_RADIUS_SQ = TORCH_LIGHT_RADIUS * TORCH_LIGHT_RADIUS;

const GUARDIAN_HP_MULT = 2.5;
const GUARDIAN_SPAWN_DIST = 9;
/** Walking away this far abandons the duel (there is no timer to fail on). */
const GUARDIAN_ABANDON_DIST_SQ = 60 * 60;

// Visual proportions.
const RING_STONES = 8;
const STONE_RING_RADIUS = 2.6;
const PILLAR_HEIGHT = 2.3;
const GEM_BASE_Y = 2.95;
const GEM_BOB = 0.16;
const GEM_BOB_HZ = 1.7;
const GEM_SPIN_IDLE = 0.9;
const GEM_SPIN_ACTIVE = 3.4;
const GLOW_RING_SCALE = 2.15;
const TORCH_TIP_Y = 1.62;
const TAU = Math.PI * 2;

/** One shrine — fixed record, mutated in place, never re-created (§13). */
interface Shrine {
  readonly element: ElementId;
  readonly kind: ChallengeKind;
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly region: BiomeId;
  state: ShrineState;
  readonly root: THREE.Group;
  readonly gem: THREE.Mesh;
  readonly glowRing: THREE.Mesh;
  readonly ownedGeometries: THREE.BufferGeometry[];
  readonly phase: number;
  // torches4in90 (empty arrays otherwise)
  readonly torchX: number[];
  readonly torchZ: number[];
  readonly torchTips: THREE.Mesh[];
  readonly torchLit: boolean[];
  litCount: number;
  // runtime
  timer: number;
  outsideTimer: number;
  waveTimer: number;
  waveCursor: number;
  guardianRef: EnemyBase | null;
  guardianMaxHp: number;
  /** Region-valid enemies.json defs (never kind strings — §4.1). */
  readonly validDefs: readonly EnemyDef[];
  readonly guardianDef: EnemyDef | null;
}

export interface ShrinesOptions {
  scene: THREE.Scene;
  field: HeightSampler;
  biomes: BiomeTable;
  player: PlayerController;
  grimoire: Grimoire;
  registry: SkillRegistry;
  /** Unused here: the reward fires through grimoire.learn (single source).
   * Kept in the options per the phase contract's constructor shape. */
  bus: EventBus;
  defs: EnemyDefs;
  manager: EnemyManager;
  /** Contract shape: a SpawnDirector reference for survive-wave pressure. It
   * compiles in parallel (agent C), so it is accepted untyped and unused —
   * waves go straight through manager.spawnDef instead (reported deviation). */
  director?: unknown;
}

export class Shrines implements System {
  readonly name = 'shrines';

  /** Gate hook (contract test 7): scales challenge clocks only, never spawns. */
  timeScale = 1;

  private readonly scene: THREE.Scene;
  private readonly field: HeightSampler;
  private readonly player: PlayerController;
  private readonly grimoire: Grimoire;
  private readonly registry: SkillRegistry;
  private readonly manager: EnemyManager;

  private readonly assets: SiteAssets;
  private readonly shrines: Shrine[] = [];
  private readonly biomeScratch: BiomeSample = createBiomeSample();

  private nearIndex = -1;
  private activeIndex = -1;

  /** Reused poll objects — TouchControls/HUD read fields, never retain (§13). */
  private readonly nearbyOut: { element: ElementId; state: ShrineState } = { element: 'fire', state: 'idle' };
  private readonly statusOut: { kind: ChallengeKind; remaining: number; progress: number } = {
    kind: 'survive60',
    remaining: 0,
    progress: 0,
  };

  /** Own frame clock for render() (render rate != tick rate) — house pattern. */
  private clock = 0;
  private lastNow = 0;

  constructor(options: ShrinesOptions) {
    this.scene = options.scene;
    this.field = options.field;
    this.player = options.player;
    this.grimoire = options.grimoire;
    this.registry = options.registry;
    this.manager = options.manager;
    this.assets = acquireSiteAssets();

    const rand = makeRand(shrineSeed);
    for (let i = 0; i < SHRINE_ELEMENTS.length; i++) {
      const element = SHRINE_ELEMENTS[i];
      const kind = CHALLENGE_OF[i];
      const rule = PLACE_RULES[i];
      if (element === undefined || kind === undefined || rule === undefined) continue;
      const spot = this.findSpot(element, rule, options.biomes, rand);
      const shrine = this.buildShrine(i, element, kind, spot.x, spot.z, rule[0], options.defs);
      this.shrines.push(shrine);
      if (kind === 'guardian' && shrine.guardianDef === null) {
        console.warn('Shrines: no enemies.json def is valid for region', rule[0], '— the', element, 'guardian cannot start');
      }
    }
  }

  // --- TouchControls' ShrineSource + the HUD poll ---------------------------

  /** Nearest shrine within 5 u, or null. Reused object — read, never retain. */
  get nearbyShrine(): { element: ElementId; state: ShrineState } | null {
    const shrine = this.nearIndex >= 0 ? this.shrines[this.nearIndex] : undefined;
    if (shrine === undefined) return null;
    const out = this.nearbyOut;
    out.element = shrine.element;
    out.state = shrine.state;
    return out;
  }

  /**
   * TouchControls' contextual tap on an idle shrine in range. One challenge at
   * a time; a guardian with no valid def refuses (already warned at boot).
   */
  beginChallenge(): boolean {
    if (this.activeIndex >= 0) return false;
    const index = this.nearIndex;
    const shrine = index >= 0 ? this.shrines[index] : undefined;
    if (shrine === undefined || shrine.state !== 'idle') return false;

    switch (shrine.kind) {
      case 'survive60':
        shrine.timer = 0;
        shrine.outsideTimer = 0;
        shrine.waveTimer = 1.5; // first wave hits shortly after the commitment
        break;
      case 'torches4in90':
        shrine.timer = 0;
        this.clearTorches(shrine);
        break;
      case 'guardian': {
        // Reuse a still-alive guardian from a failed attempt (no stacking);
        // otherwise spawn fresh at ×2.5 hp. ArchetypeEnemy has no scale/hp
        // hint (checked): root-scaling would also inflate the telegraph ring
        // and make it lie about the damage area, so the buff is hp only.
        let guardian = shrine.guardianRef;
        if (guardian === null || !guardian.alive) {
          const def = shrine.guardianDef;
          if (def === null) return false;
          const angle = hash2(index, 71, shrineSeed) * TAU;
          const gx = shrine.x + Math.sin(angle) * GUARDIAN_SPAWN_DIST;
          const gz = shrine.z + Math.cos(angle) * GUARDIAN_SPAWN_DIST;
          guardian = this.manager.spawnDef(def, gx, gz);
          if (guardian === null) return false; // §9's 18-cap is full; retry later
          guardian.hp = def.maxHp * GUARDIAN_HP_MULT;
        }
        shrine.guardianRef = guardian;
        shrine.guardianMaxHp = guardian.hp;
        break;
      }
    }
    shrine.state = 'active';
    this.activeIndex = index;
    return true;
  }

  /** HUD progress poll. Reused object — read fields, never retain. */
  challengeStatus(): { kind: ChallengeKind; remaining: number; progress: number } | null {
    const shrine = this.activeIndex >= 0 ? this.shrines[this.activeIndex] : undefined;
    if (shrine === undefined) return null;
    const out = this.statusOut;
    out.kind = shrine.kind;
    switch (shrine.kind) {
      case 'survive60':
        out.remaining = SURVIVE_SECONDS - shrine.timer;
        out.progress = shrine.timer / SURVIVE_SECONDS;
        break;
      case 'torches4in90':
        out.remaining = TORCH_SECONDS - shrine.timer;
        out.progress = shrine.litCount / TORCH_COUNT;
        break;
      case 'guardian': {
        out.remaining = 0; // no clock on a duel
        const guardian = shrine.guardianRef;
        const dealt = guardian === null ? 0 : 1 - guardian.hp / shrine.guardianMaxHp;
        out.progress = dealt < 0 ? 0 : dealt > 1 ? 1 : dealt;
        break;
      }
    }
    if (out.remaining < 0) out.remaining = 0;
    if (out.progress > 1) out.progress = 1;
    return out;
  }

  // --- debug surface (gate frequency — fresh objects are fine here) ---------

  get count(): number {
    return this.shrines.length;
  }

  shrineInfo(index: number): { element: ElementId; x: number; z: number; state: ShrineState; kind: ChallengeKind } | null {
    const shrine = this.shrines[index];
    if (shrine === undefined) return null;
    return { element: shrine.element, x: shrine.x, z: shrine.z, state: shrine.state, kind: shrine.kind };
  }

  /** Torch poles of the ACTIVE shrine (gate test 7 walks to them). */
  torchAt(index: number): { x: number; z: number; lit: boolean } | null {
    const shrine = this.activeIndex >= 0 ? this.shrines[this.activeIndex] : undefined;
    if (shrine === undefined) return null;
    const x = shrine.torchX[index];
    const z = shrine.torchZ[index];
    const lit = shrine.torchLit[index];
    if (x === undefined || z === undefined || lit === undefined) return null;
    return { x, z, lit };
  }

  // --- System ----------------------------------------------------------------

  update(dt: number): void {
    const px = this.player.position.x;
    const pz = this.player.position.z;

    // Nearest-in-range + distance culling. 6 shrines × scalar math per tick.
    let nearest = -1;
    let nearestSq = INTERACT_RADIUS_SQ;
    const shrines = this.shrines;
    for (let i = 0; i < shrines.length; i++) {
      const shrine = shrines[i];
      if (shrine === undefined) continue;
      const dx = shrine.x - px;
      const dz = shrine.z - pz;
      const distSq = dx * dx + dz * dz;
      const visible = distSq < VIS_DIST_SQ;
      if (shrine.root.visible !== visible) shrine.root.visible = visible;
      if (distSq <= nearestSq) {
        nearestSq = distSq;
        nearest = i;
      }
    }
    this.nearIndex = nearest;

    const active = this.activeIndex >= 0 ? shrines[this.activeIndex] : undefined;
    if (active !== undefined) this.stepChallenge(active, dt * this.timeScale, px, pz);
  }

  render(): void {
    const now = performance.now();
    if (this.lastNow === 0) this.lastNow = now;
    let fdt = (now - this.lastNow) * 0.001;
    this.lastNow = now;
    if (fdt < 0) fdt = 0;
    else if (fdt > 0.1) fdt = 0.1;
    this.clock += fdt;
    const t = this.clock;

    const shrines = this.shrines;
    for (let i = 0; i < shrines.length; i++) {
      const shrine = shrines[i];
      if (shrine === undefined || !shrine.root.visible) continue;
      const activeNow = shrine.state === 'active';
      const gem = shrine.gem;
      gem.position.y = GEM_BASE_Y + Math.sin(t * GEM_BOB_HZ * TAU * 0.5 + shrine.phase) * GEM_BOB;
      gem.rotation.y += fdt * (activeNow ? GEM_SPIN_ACTIVE : GEM_SPIN_IDLE);
      // Active: urgent pulse. Done: swollen and steady — readable from afar.
      const pulse = activeNow ? 1 + 0.14 * Math.sin(t * 6.5) : shrine.state === 'done' ? 1.18 : 1 + 0.04 * Math.sin(t * 2 + shrine.phase);
      gem.scale.set(pulse, pulse, pulse);
      shrine.glowRing.rotation.y = t * 0.25 + shrine.phase;

      const tips = shrine.torchTips;
      for (let k = 0; k < tips.length; k++) {
        const tip = tips[k];
        if (tip === undefined || !tip.visible) continue;
        const flicker = 1 + 0.18 * Math.sin(t * 11 + k * 2.1);
        tip.scale.set(flicker, flicker, flicker);
      }
    }
  }

  /** Everything back to idle and retryable. Done shrines re-arm too — reset()
   * also rewinds the Grimoire, so the rewards become earnable again. */
  reset(): void {
    for (let i = 0; i < this.shrines.length; i++) {
      const shrine = this.shrines[i];
      if (shrine === undefined) continue;
      shrine.state = 'idle';
      shrine.timer = 0;
      shrine.outsideTimer = 0;
      shrine.waveTimer = 0;
      shrine.waveCursor = 0;
      shrine.guardianRef = null; // the manager reset it to a plain enemy
      shrine.guardianMaxHp = 1;
      this.clearTorches(shrine);
    }
    this.nearIndex = -1;
    this.activeIndex = -1;
  }

  dispose(): void {
    for (let i = 0; i < this.shrines.length; i++) {
      const shrine = this.shrines[i];
      if (shrine === undefined) continue;
      this.scene.remove(shrine.root);
      for (let g = 0; g < shrine.ownedGeometries.length; g++) shrine.ownedGeometries[g]?.dispose();
    }
    this.shrines.length = 0;
    releaseSiteAssets();
  }

  // --- challenge FSM ----------------------------------------------------------

  private stepChallenge(shrine: Shrine, dt: number, px: number, pz: number): void {
    if (this.player.statsRef.hp <= 0) {
      this.failChallenge(shrine);
      return;
    }
    const dx = px - shrine.x;
    const dz = pz - shrine.z;
    const distSq = dx * dx + dz * dz;

    switch (shrine.kind) {
      case 'survive60': {
        shrine.timer += dt;
        if (distSq > SURVIVE_RADIUS_SQ) {
          shrine.outsideTimer += dt;
          if (shrine.outsideTimer > SURVIVE_GRACE_SECONDS) {
            this.failChallenge(shrine);
            return;
          }
        } else {
          shrine.outsideTimer = 0;
        }
        shrine.waveTimer -= dt;
        if (shrine.waveTimer <= 0) {
          shrine.waveTimer = WAVE_INTERVAL;
          this.spawnWave(shrine);
        }
        if (shrine.timer >= SURVIVE_SECONDS) this.succeedChallenge(shrine);
        break;
      }
      case 'torches4in90': {
        shrine.timer += dt;
        if (shrine.timer >= TORCH_SECONDS) {
          this.failChallenge(shrine);
          return;
        }
        const torchX = shrine.torchX;
        const torchZ = shrine.torchZ;
        const lit = shrine.torchLit;
        for (let i = 0; i < torchX.length; i++) {
          if (lit[i] === true) continue;
          const tx = (torchX[i] ?? 0) - px;
          const tz = (torchZ[i] ?? 0) - pz;
          if (tx * tx + tz * tz <= TORCH_LIGHT_RADIUS_SQ) {
            lit[i] = true;
            shrine.litCount++;
            const tip = shrine.torchTips[i];
            if (tip !== undefined) tip.visible = true;
          }
        }
        if (shrine.litCount >= TORCH_COUNT) this.succeedChallenge(shrine);
        break;
      }
      case 'guardian': {
        const guardian = shrine.guardianRef;
        if (guardian === null) {
          this.failChallenge(shrine);
          return;
        }
        if (!guardian.alive) {
          this.succeedChallenge(shrine);
          return;
        }
        if (distSq > GUARDIAN_ABANDON_DIST_SQ) this.failChallenge(shrine);
        break;
      }
    }
  }

  /** §9's cap and purge live inside spawnDef; a full field just skips the wave. */
  private spawnWave(shrine: Shrine): void {
    const defs = shrine.validDefs;
    if (defs.length === 0) return;
    for (let i = 0; i < WAVE_SIZE; i++) {
      const def = defs[shrine.waveCursor % defs.length];
      const angle = hash2(shrine.waveCursor, 313, shrineSeed) * TAU;
      const radius = WAVE_RING_MIN + hash2(shrine.waveCursor, 631, shrineSeed) * WAVE_RING_SPAN;
      shrine.waveCursor++;
      if (def === undefined) continue;
      this.manager.spawnDef(def, shrine.x + Math.sin(angle) * radius, shrine.z + Math.cos(angle) * radius);
    }
  }

  /** Fail → idle, retryable (§8.2.2). A surviving guardian is kept for reuse. */
  private failChallenge(shrine: Shrine): void {
    shrine.state = 'idle';
    shrine.timer = 0;
    shrine.outsideTimer = 0;
    shrine.waveTimer = 0;
    this.clearTorches(shrine);
    this.activeIndex = -1;
  }

  private succeedChallenge(shrine: Shrine): void {
    shrine.state = 'done';
    this.activeIndex = -1;
    // §4.1: the reward is the skill whose shrineElement field (agent E's JSON)
    // names this element — looked up defensively so this compiles before the
    // schema addition lands. learn() fires the ACQUIRED moment itself.
    const reward = this.findShrineSkill(shrine.element);
    if (reward === null) {
      console.warn('Shrines: no skill in skills.json carries shrineElement ==', shrine.element, '— challenge done, no reward');
      return;
    }
    this.grimoire.learn(reward, 'shrine');
  }

  /** Event-frequency scan; the field is optional until agent E's schema lands. */
  private findShrineSkill(element: ElementId): string | null {
    const all = this.registry.all;
    for (let i = 0; i < all.length; i++) {
      const def = all[i];
      if (def === undefined) continue;
      const tagged = (def as unknown as Record<string, unknown>)['shrineElement'];
      if (typeof tagged === 'string' && tagged === element) return def.id;
    }
    return null;
  }

  // --- placement + construction (boot only — §3 does not apply) ---------------

  private findSpot(
    element: ElementId,
    rule: readonly [BiomeId, number, number, number, number, number, number],
    biomes: BiomeTable,
    rand: () => number,
  ): { x: number; z: number } {
    const [region, x0, x1, z0, z1, rMin, rMax] = rule;
    // Pass 1 at the contract's numbers, pass 2 slightly relaxed. Deterministic
    // (the rand stream is seeded), loud on failure — a shrine that cannot be
    // placed is a data/tuning bug that must fail the boot, not hide.
    for (let pass = 0; pass < 2; pass++) {
      const slopeLimit = pass === 0 ? SLOPE_LIMIT : SLOPE_LIMIT_RELAXED;
      const separation = pass === 0 ? MIN_SEPARATION : MIN_SEPARATION_RELAXED;
      for (let attempt = 0; attempt < PLACE_TRIES; attempt++) {
        const x = x0 + rand() * (x1 - x0);
        const z = z0 + rand() * (z1 - z0);
        const originDist = Math.sqrt(x * x + z * z);
        if (originDist < MIN_SPAWN_DIST) continue;
        if (rMin > 0 && (originDist < rMin || originDist > rMax)) continue;
        const ax = x < 0 ? -x : x;
        const az = z < 0 ? -z : z;
        if (ax > RIM_LIMIT || az > RIM_LIMIT) continue;
        if (region === BIOME.HollowSpire) {
          const dpx = x - SPIRE_PLATEAU_X;
          const dpz = z - SPIRE_PLATEAU_Z;
          if (dpx * dpx + dpz * dpz < PLATEAU_CLEAR * PLATEAU_CLEAR) continue;
        }
        if (biomes.sample(x, z, this.biomeScratch).dominant !== region) continue;
        if (!this.groundOk(x, z, slopeLimit)) continue;
        let clear = true;
        for (let s = 0; s < this.shrines.length; s++) {
          const other = this.shrines[s];
          if (other === undefined) continue;
          const dx = other.x - x;
          const dz = other.z - z;
          if (dx * dx + dz * dz < separation * separation) {
            clear = false;
            break;
          }
        }
        if (!clear) continue;
        return { x, z };
      }
    }
    throw new Error(`Shrines: could not place the ${element} shrine in region ${region} under seed ${shrineSeed}`);
  }

  /** Above the sea and flatter than the limit at centre AND the stone ring. */
  private groundOk(x: number, z: number, slopeLimit: number): boolean {
    const field = this.field;
    if (field.heightAt(x, z) < MIN_GROUND) return false;
    if (field.slopeAt(x, z) > slopeLimit) return false;
    const r = FOOT_RADIUS;
    return (
      field.slopeAt(x + r, z) <= slopeLimit &&
      field.slopeAt(x - r, z) <= slopeLimit &&
      field.slopeAt(x, z + r) <= slopeLimit &&
      field.slopeAt(x, z - r) <= slopeLimit &&
      field.heightAt(x + r, z) >= MIN_GROUND &&
      field.heightAt(x - r, z) >= MIN_GROUND &&
      field.heightAt(x, z + r) >= MIN_GROUND &&
      field.heightAt(x, z - r) >= MIN_GROUND
    );
  }

  private buildShrine(
    index: number,
    element: ElementId,
    kind: ChallengeKind,
    x: number,
    z: number,
    region: BiomeId,
    defs: EnemyDefs,
  ): Shrine {
    const field = this.field;
    const centreY = field.heightAt(x, z);
    const hex = elementColor(element);
    const owned: THREE.BufferGeometry[] = [];

    const root = new THREE.Group();
    root.name = 'shrine';
    root.position.set(x, centreY, z);

    // ONE merged stone mesh: 8 ring stones + pillar (+ 4 torch poles) = 1 draw.
    const builder = new SiteMeshBuilder();
    for (let i = 0; i < RING_STONES; i++) {
      const jitterA = hash2(index * RING_STONES + i, 11, shrineSeed);
      const jitterB = hash2(index * RING_STONES + i, 29, shrineSeed);
      const angle = (i / RING_STONES) * TAU + (jitterA - 0.5) * 0.35;
      const sx = Math.sin(angle) * STONE_RING_RADIUS;
      const sz = Math.cos(angle) * STONE_RING_RADIUS;
      const groundY = field.heightAt(x + sx, z + sz) - centreY;
      const height = 1.05 + jitterB * 0.65;
      // Sunk 0.18 so stones meet sloped ground without floating corners.
      builder.addBox(sx, groundY + height * 0.5 - 0.18, sz, 0.5 + jitterA * 0.16, height, 0.42, angle + (jitterB - 0.5) * 0.5, STONE_HEX, index * 64 + i);
    }
    builder.addPillar(0, -0.15, 0, 1, PILLAR_HEIGHT, STONE_HEX, index * 64 + 31);

    const torchX: number[] = [];
    const torchZ: number[] = [];
    const torchTips: THREE.Mesh[] = [];
    const torchLit: boolean[] = [];
    let tipGeometry: THREE.BufferGeometry | null = null;
    if (kind === 'torches4in90') {
      tipGeometry = paintGlow(new THREE.OctahedronGeometry(0.16, 0), hex, 1.4); // 8 tris
      owned.push(tipGeometry);
      for (let i = 0; i < TORCH_COUNT; i++) {
        // Cardinal spread with jitter; a few radius attempts dodge steep spots
        // (a leaning pole is cosmetic — the last candidate is always accepted).
        let tx = 0;
        let tz = 0;
        for (let attempt = 0; attempt < 6; attempt++) {
          const jA = hash2(index * 16 + i, 101 + attempt, shrineSeed);
          const jB = hash2(index * 16 + i, 211 + attempt, shrineSeed);
          const angle = (i / TORCH_COUNT) * TAU + (jA - 0.5) * 0.9;
          const radius = TORCH_RADIUS_MIN + jB * TORCH_RADIUS_SPAN;
          tx = x + Math.sin(angle) * radius;
          tz = z + Math.cos(angle) * radius;
          if (field.slopeAt(tx, tz) <= SLOPE_LIMIT_RELAXED && field.heightAt(tx, tz) >= MIN_GROUND) break;
        }
        const groundY = field.heightAt(tx, tz) - centreY;
        builder.addBox(tx - x, groundY + 0.72, tz - z, 0.16, 1.5, 0.16, 0, 0x5c5148, index * 64 + 40 + i);
        const tip = new THREE.Mesh(tipGeometry, this.assets.glow);
        tip.position.set(tx - x, groundY + TORCH_TIP_Y, tz - z);
        tip.renderOrder = 2;
        tip.visible = false;
        root.add(tip);
        torchX.push(tx);
        torchZ.push(tz);
        torchTips.push(tip);
        torchLit.push(false);
      }
    }

    const stoneGeometry = builder.build();
    owned.push(stoneGeometry);
    root.add(new THREE.Mesh(stoneGeometry, this.assets.stone));

    // Element-coloured gem + ground glow: colours are BAKED as vertex colour,
    // so all six shrines share the one additive material (§3's 12-mat cap).
    const gemGeometry = paintGlow(new THREE.OctahedronGeometry(0.42, 0), hex, 1.25); // 8 tris
    gemGeometry.scale(1, 1.45, 1);
    owned.push(gemGeometry);
    const gem = new THREE.Mesh(gemGeometry, this.assets.glow);
    gem.position.y = GEM_BASE_Y;
    gem.renderOrder = 2;
    root.add(gem);

    const ringGeometry = paintGlow(new THREE.RingGeometry(0.72, 1, 14, 1), hex, 0.5); // 28 tris
    ringGeometry.rotateX(-Math.PI / 2);
    owned.push(ringGeometry);
    const glowRing = new THREE.Mesh(ringGeometry, this.assets.glow);
    glowRing.position.y = 0.06;
    glowRing.scale.set(GLOW_RING_SCALE, 1, GLOW_RING_SCALE);
    glowRing.renderOrder = 2;
    root.add(glowRing);

    this.scene.add(root);

    // Region-valid defs for waves; guardian = the region's heaviest def
    // (budgetCost, then maxHp — deterministic, reads as "the named one").
    const validDefs: EnemyDef[] = [];
    let guardianDef: EnemyDef | null = null;
    const all = defs.all;
    for (let i = 0; i < all.length; i++) {
      const def = all[i];
      if (def === undefined || def.biomes.indexOf(region) < 0) continue;
      validDefs.push(def);
      if (
        guardianDef === null ||
        def.budgetCost > guardianDef.budgetCost ||
        (def.budgetCost === guardianDef.budgetCost && def.maxHp > guardianDef.maxHp)
      ) {
        guardianDef = def;
      }
    }

    return {
      element,
      kind,
      x,
      z,
      y: centreY,
      region,
      state: 'idle',
      root,
      gem,
      glowRing,
      ownedGeometries: owned,
      phase: (((x * 0.73 + z * 1.31) % TAU) + TAU) % TAU,
      torchX,
      torchZ,
      torchTips,
      torchLit,
      litCount: 0,
      timer: 0,
      outsideTimer: 0,
      waveTimer: 0,
      waveCursor: 0,
      guardianRef: null,
      guardianMaxHp: 1,
      validDefs,
      guardianDef,
    };
  }

  private clearTorches(shrine: Shrine): void {
    shrine.litCount = 0;
    for (let i = 0; i < shrine.torchLit.length; i++) {
      shrine.torchLit[i] = false;
      const tip = shrine.torchTips[i];
      if (tip !== undefined) tip.visible = false;
    }
  }
}
