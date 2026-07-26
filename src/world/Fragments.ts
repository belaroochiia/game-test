import * as THREE from 'three';

import type { System } from '../core/Engine';
import type { PlayerController } from '../player/PlayerController';
import type { Grimoire } from '../skills/Grimoire';
import type { SkillRegistry } from '../skills/SkillRegistry';
import type { SkillDef } from '../skills/SkillTypes';
import { BIOME, createBiomeSample, hash2 } from './BiomeTable';
import type { BiomeId, BiomeSample, BiomeTable } from './BiomeTable';
import { SEA_LEVEL, SPIRE_PLATEAU_X, SPIRE_PLATEAU_Z } from './HeightField';
import type { HeightSampler } from './HeightField';
import { SiteMeshBuilder, acquireSiteAssets, elementColor, paintGlow, releaseSiteAssets } from './Shrines';
import type { SiteAssets } from './Shrines';

/**
 * §8.2.3's Grimoire Fragments: 9 seeded ruin sites — 3 skills × 3 pieces —
 * scattered with at least one site in every outer region. Which skills are
 * fragment-assembled comes from skills.json: any entry carrying the optional
 * `fragments: 3` field (agent E's schema addition, read defensively so this
 * compiles before it lands; NO skill ids in TS — §4.1). Walking within 1.4 u
 * of a shard collects it: grimoire.addFragment tallies the piece and, at the
 * full set, grimoire.learn(id, 'fragment') auto-assembles the skill — the
 * ACQUIRED moment fires from learn itself.
 *
 * Consumed sites stay consumed for the SESSION only: persistence is Phase 6's
 * SaveManager (reset() re-arms everything, matching Grimoire.reset clearing
 * the tallies).
 *
 * GPU cost per site: one merged 3-stone mesh + one shard + one ground glow
 * (~72 tris, 3 draws), sharing Shrines' TWO site materials (§3's 12-mat cap),
 * roots distance-culled at 120 u. Zero allocation per frame: fixed site
 * records mutated in place, scalar-only update/render.
 */

const PIECES_EXPECTED = 3;
const SKILLS_EXPECTED = 3;

const PICKUP_RADIUS = 1.4;
const PICKUP_RADIUS_SQ = PICKUP_RADIUS * PICKUP_RADIUS;
const VIS_DIST_SQ = 120 * 120;

/**
 * Region per (skill index, piece index) — a fixed plan, not a roll, so "at
 * least one site per outer region" holds under EVERY seed: Whisperwood ×2,
 * Emberscar ×2, Frostvale ×2, Spire ×1, Verdant ×2, and every skill's three
 * pieces land in three different regions (a hunt, not a sweep).
 */
const SITE_REGION_PLAN: readonly (readonly [BiomeId, BiomeId, BiomeId])[] = [
  [BIOME.Whisperwood, BIOME.Emberscar, BIOME.Frostvale],
  [BIOME.HollowSpire, BIOME.VerdantHollow, BIOME.Whisperwood],
  [BIOME.Emberscar, BIOME.Frostvale, BIOME.VerdantHollow],
];

/** Proposal boxes per region id (rejection sampling; biome test decides). */
const REGION_BOX: readonly (readonly [number, number, number, number])[] = [
  [-110, 110, -110, 110], // Verdant (plus the radius band below)
  [-180, 180, -250, -78], // Whisperwood
  [88, 262, -50, 105], // Emberscar
  [-262, -88, -50, 105], // Frostvale
  [-170, 170, 130, 262], // Hollow Spire
];
/** Verdant sites keep off the spawn meadow. */
const VERDANT_R_MIN = 40;
const VERDANT_R_MAX = 108;

const MIN_SPAWN_DIST = 35;
const SLOPE_LIMIT = (25 * Math.PI) / 180;
const SLOPE_LIMIT_RELAXED = (30 * Math.PI) / 180;
const MIN_SEPARATION = 25;
const MIN_SEPARATION_RELAXED = 18;
const RIM_LIMIT = 268;
const MIN_GROUND = SEA_LEVEL + 0.5;
const PLATEAU_CLEAR = 50;
const PLACE_TRIES = 5000;

// Visual proportions.
const STONE_COUNT = 3;
const STONE_RADIUS = 1.05;
const SHARD_BASE_Y = 1.15;
const SHARD_BOB = 0.12;
const SHARD_BOB_HZ = 2.1;
const SHARD_SPIN = 1.6;
const GLOW_RING_SCALE = 1.5;
const STONE_HEX = 0x847f76;
const TAU = Math.PI * 2;

let fragmentSeed = 0xf4a6d201;

/** Placement is rolled at construction; re-seed BEFORE constructing (gate use). */
export function setFragmentSeed(n: number): void {
  fragmentSeed = n >>> 0;
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

/** One site — fixed record, mutated in place (§13). */
interface FragmentSite {
  readonly skillId: string;
  readonly need: number;
  readonly piece: number;
  readonly region: BiomeId;
  readonly x: number;
  readonly z: number;
  taken: boolean;
  readonly root: THREE.Group;
  readonly shard: THREE.Mesh;
  readonly glowRing: THREE.Mesh;
  readonly ownedGeometries: THREE.BufferGeometry[];
  readonly phase: number;
}

export interface FragmentsOptions {
  scene: THREE.Scene;
  field: HeightSampler;
  biomes: BiomeTable;
  player: PlayerController;
  grimoire: Grimoire;
  registry: SkillRegistry;
}

export class Fragments implements System {
  readonly name = 'fragments';

  private readonly scene: THREE.Scene;
  private readonly field: HeightSampler;
  private readonly player: PlayerController;
  private readonly grimoire: Grimoire;

  private readonly assets: SiteAssets;
  private readonly sites: FragmentSite[] = [];
  private readonly biomeScratch: BiomeSample = createBiomeSample();

  /** Own frame clock for render() (render rate != tick rate) — house pattern. */
  private clock = 0;
  private lastNow = 0;

  constructor(options: FragmentsOptions) {
    this.scene = options.scene;
    this.field = options.field;
    this.player = options.player;
    this.grimoire = options.grimoire;
    this.assets = acquireSiteAssets();

    // §4.1: fragment skills are DISCOVERED off the registry by field, never
    // named here. The field is optional until agent E's schema lands.
    const fragmentSkills: Array<{ def: SkillDef; need: number }> = [];
    const all = options.registry.all;
    for (let i = 0; i < all.length; i++) {
      const def = all[i];
      if (def === undefined) continue;
      const raw = (def as unknown as Record<string, unknown>)['fragments'];
      if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 2) {
        fragmentSkills.push({ def, need: raw });
      }
    }
    if (fragmentSkills.length !== SKILLS_EXPECTED) {
      console.warn(
        `Fragments: expected ${SKILLS_EXPECTED} skills with a "fragments" field in skills.json, found ${fragmentSkills.length}` +
          (fragmentSkills.length === 0 ? ' — no sites will exist until the data lands' : ''),
      );
    }

    const rand = makeRand(fragmentSeed);
    for (let s = 0; s < fragmentSkills.length; s++) {
      const entry = fragmentSkills[s];
      if (entry === undefined) continue;
      if (entry.need !== PIECES_EXPECTED) {
        console.warn(`Fragments: skill "${entry.def.id}" wants ${entry.need} pieces; the contract plan is ${PIECES_EXPECTED}`);
      }
      const plan = SITE_REGION_PLAN[s % SITE_REGION_PLAN.length];
      for (let piece = 0; piece < entry.need; piece++) {
        const region = plan?.[piece % PIECES_EXPECTED] ?? BIOME.VerdantHollow;
        const spot = this.findSpot(entry.def.id, piece, region, options.biomes, rand);
        this.sites.push(this.buildSite(entry.def, entry.need, piece, region, spot.x, spot.z, s * 8 + piece));
      }
    }
  }

  // --- debug surface (gate frequency — fresh objects are fine here) ---------

  get siteCount(): number {
    return this.sites.length;
  }

  siteInfo(index: number): { skillId: string; piece: number; x: number; z: number; taken: boolean } | null {
    const site = this.sites[index];
    if (site === undefined) return null;
    return { skillId: site.skillId, piece: site.piece, x: site.x, z: site.z, taken: site.taken };
  }

  // --- System ----------------------------------------------------------------

  update(): void {
    const px = this.player.position.x;
    const pz = this.player.position.z;
    const sites = this.sites;
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      if (site === undefined) continue;
      const dx = site.x - px;
      const dz = site.z - pz;
      const distSq = dx * dx + dz * dz;
      const visible = distSq < VIS_DIST_SQ;
      if (site.root.visible !== visible) site.root.visible = visible;
      if (site.taken || distSq > PICKUP_RADIUS_SQ) continue;
      this.collect(site);
    }
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

    const sites = this.sites;
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      if (site === undefined || site.taken || !site.root.visible) continue;
      site.shard.position.y = SHARD_BASE_Y + Math.sin(t * SHARD_BOB_HZ + site.phase) * SHARD_BOB;
      site.shard.rotation.y += fdt * SHARD_SPIN;
    }
  }

  /** All sites re-armed. Session-only by design: Phase 6's save owns keeping
   * them consumed across reloads (Grimoire.reset clears the tallies to match). */
  reset(): void {
    for (let i = 0; i < this.sites.length; i++) {
      const site = this.sites[i];
      if (site === undefined) continue;
      site.taken = false;
      site.shard.visible = true;
      site.glowRing.visible = true;
    }
  }

  dispose(): void {
    for (let i = 0; i < this.sites.length; i++) {
      const site = this.sites[i];
      if (site === undefined) continue;
      this.scene.remove(site.root);
      for (let g = 0; g < site.ownedGeometries.length; g++) site.ownedGeometries[g]?.dispose();
    }
    this.sites.length = 0;
    releaseSiteAssets();
  }

  // --- internals ---------------------------------------------------------------

  /** Pickup frequency, not per tick. learn() is idempotent — a skill somehow
   * already known just tallies silently, exactly like SoulOrbs' consume. */
  private collect(site: FragmentSite): void {
    site.taken = true;
    site.shard.visible = false;
    site.glowRing.visible = false;
    const count = this.grimoire.addFragment(site.skillId);
    if (count >= site.need) this.grimoire.learn(site.skillId, 'fragment');
  }

  // --- placement + construction (boot only — §3 does not apply) ----------------

  private findSpot(
    skillId: string,
    piece: number,
    region: BiomeId,
    biomes: BiomeTable,
    rand: () => number,
  ): { x: number; z: number } {
    const box = REGION_BOX[region];
    if (box === undefined) throw new Error(`Fragments: no proposal box for region ${region}`);
    const [x0, x1, z0, z1] = box;
    for (let pass = 0; pass < 2; pass++) {
      const slopeLimit = pass === 0 ? SLOPE_LIMIT : SLOPE_LIMIT_RELAXED;
      const separation = pass === 0 ? MIN_SEPARATION : MIN_SEPARATION_RELAXED;
      for (let attempt = 0; attempt < PLACE_TRIES; attempt++) {
        const x = x0 + rand() * (x1 - x0);
        const z = z0 + rand() * (z1 - z0);
        const originDist = Math.sqrt(x * x + z * z);
        if (originDist < MIN_SPAWN_DIST) continue;
        if (region === BIOME.VerdantHollow && (originDist < VERDANT_R_MIN || originDist > VERDANT_R_MAX)) continue;
        const ax = x < 0 ? -x : x;
        const az = z < 0 ? -z : z;
        if (ax > RIM_LIMIT || az > RIM_LIMIT) continue;
        if (region === BIOME.HollowSpire) {
          const dpx = x - SPIRE_PLATEAU_X;
          const dpz = z - SPIRE_PLATEAU_Z;
          if (dpx * dpx + dpz * dpz < PLATEAU_CLEAR * PLATEAU_CLEAR) continue;
        }
        if (biomes.sample(x, z, this.biomeScratch).dominant !== region) continue;
        const field = this.field;
        if (field.heightAt(x, z) < MIN_GROUND || field.slopeAt(x, z) > slopeLimit) continue;
        let clear = true;
        for (let s = 0; s < this.sites.length; s++) {
          const other = this.sites[s];
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
    throw new Error(`Fragments: could not place piece ${piece} of "${skillId}" in region ${region} under seed ${fragmentSeed}`);
  }

  private buildSite(
    def: SkillDef,
    need: number,
    piece: number,
    region: BiomeId,
    x: number,
    z: number,
    salt: number,
  ): FragmentSite {
    const field = this.field;
    const centreY = field.heightAt(x, z);
    const hex = elementColor(def.element);
    const owned: THREE.BufferGeometry[] = [];

    const root = new THREE.Group();
    root.name = 'fragment-site';
    root.position.set(x, centreY, z);

    // Three leaning standing stones, merged: one draw for the whole ruin.
    const builder = new SiteMeshBuilder();
    for (let i = 0; i < STONE_COUNT; i++) {
      const jA = hash2(salt * 8 + i, 17, fragmentSeed);
      const jB = hash2(salt * 8 + i, 43, fragmentSeed);
      const angle = (i / STONE_COUNT) * TAU + (jA - 0.5) * 0.7;
      const sx = Math.sin(angle) * STONE_RADIUS;
      const sz = Math.cos(angle) * STONE_RADIUS;
      const groundY = field.heightAt(x + sx, z + sz) - centreY;
      const height = 0.95 + jB * 0.7;
      builder.addBox(sx, groundY + height * 0.5 - 0.14, sz, 0.42, height, 0.3, angle + (jB - 0.5) * 0.8, STONE_HEX, salt * 8 + i);
    }
    const stoneGeometry = builder.build();
    owned.push(stoneGeometry);
    root.add(new THREE.Mesh(stoneGeometry, this.assets.stone));

    // Element-coloured shard (colour baked as vertex colour — the one shared
    // additive material serves every site, §3's 12-material cap).
    const shardGeometry = paintGlow(new THREE.OctahedronGeometry(0.26, 0), hex, 1.2); // 8 tris
    shardGeometry.scale(1, 1.7, 1);
    owned.push(shardGeometry);
    const shard = new THREE.Mesh(shardGeometry, this.assets.glow);
    shard.position.y = SHARD_BASE_Y;
    shard.renderOrder = 2;
    root.add(shard);

    const ringGeometry = paintGlow(new THREE.RingGeometry(0.72, 1, 12, 1), hex, 0.4); // 24 tris
    ringGeometry.rotateX(-Math.PI / 2);
    owned.push(ringGeometry);
    const glowRing = new THREE.Mesh(ringGeometry, this.assets.glow);
    glowRing.position.y = 0.05;
    glowRing.scale.set(GLOW_RING_SCALE, 1, GLOW_RING_SCALE);
    glowRing.renderOrder = 2;
    root.add(glowRing);

    this.scene.add(root);

    return {
      skillId: def.id,
      need,
      piece,
      region,
      x,
      z,
      taken: false,
      root,
      shard,
      glowRing,
      ownedGeometries: owned,
      phase: (((x * 0.73 + z * 1.31) % TAU) + TAU) % TAU,
    };
  }

}
