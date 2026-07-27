import type { DamagePacket } from '../combat/CombatTypes';
import type { System } from '../core/Engine';
import type { PlayerController } from '../player/PlayerController';
import { BIOME_COUNT, createBiomeSample } from '../world/BiomeTable';
import type { BiomeId, BiomeSample, BiomeTable } from '../world/BiomeTable';
import { SEA_LEVEL, SPIRE_PLATEAU_X, SPIRE_PLATEAU_Z } from '../world/HeightField';
import type { HeightSampler } from '../world/HeightField';
import type { EnemyBase } from './EnemyBase';
import type { EnemyDef, EnemyDefs } from './EnemyDefs';
import { EnemyManager } from './EnemyManager';

/**
 * §9's population authority, Phase 5: the world has no fixed camps any more —
 * WHO exists near the player, and how many, is decided here, on a ~2 s
 * cadence, against a per-region budget of spawn points. The EnemyManager stays
 * the mechanism (spawnDef / purgeDead / the 18 cap / the 90-80 hysteresis);
 * this class is only the policy.
 *
 * The loop, once per cadence — never per frame:
 *  1. purgeDead(): corpses release their HitboxSystem slots and cap room.
 *  2. Re-count the ledger: dead entries drop (death releases budget for good),
 *     deactivated entries (§9: past 90 u the manager turned them off) release
 *     their points but STAY tracked — if the hysteresis turns one back on
 *     (< 80 u) its cost re-counts. That can push a region transiently over
 *     budget; being over budget only pauses NEW spawns, the §9 cap of 18 is
 *     the hard invariant and the manager enforces it unconditionally.
 *  3. If the player's dominant region has headroom AND the manager is under
 *     the cap: pick a def tagged for that region (seeded, weighted 1/cost so
 *     cheap kinds are the crowd and expensive ones the event) and place it
 *     25-45 u out, preferring the camera's blind half-plane.
 *
 * Region transitions (contract): NOTHING is culled on a biome change — a
 * visible vanish is exactly the popping §12 fails the phase for. Each enemy's
 * points stay charged to the region it was spawned FOR; the current region's
 * budget gates only new spawns. What the contract calls "despawn naturally"
 * is the reclaim below: an enemy that stays deactivated (> 90 u, mesh already
 * hidden) for RECLAIM_AFTER_SECONDS is silently retired. Without it the cap
 * pins permanently on a long trek — director enemies never self-respawn and
 * never die on their own, so 18 stragglers behind the player would starve
 * spawning for the rest of the session, i.e. §12's "empty world" verbatim.
 * The reclaim goes through EnemyBase.takeDamage directly, NOT DamageSystem,
 * so no kill event fires (no soul orb, no damage number 100 u away), and the
 * kill reward is consumed on the spot so retired enemies bank zero xp.
 *
 * §13 discipline: the ledger lives in arrays pre-sized to the §9 cap, the
 * biome scratch is reused, every visitor is a method, and the only per-tick
 * work between cadences is one accumulator add. The PRNG is a module-scope
 * mulberry32 so the gate can pin the whole pick-and-place sequence with
 * setDirectorSeed().
 */

/** What the director needs from the camera: CameraRig.yaw's convention — the
 * camera sits at player + (sin yaw, ·, cos yaw) · boom, looking at the player.
 * "Behind the camera half-plane" is therefore the (sin yaw, cos yaw) side. */
export interface CameraYawSource {
  getYaw(): number;
}

export interface SpawnDirectorOptions {
  defs: EnemyDefs;
  manager: EnemyManager;
  biomes: BiomeTable;
  player: PlayerController;
  field: HeightSampler;
  /** Optional at construction; the integrator may late-wire the public field. */
  cameraYawRef?: CameraYawSource | null;
}

/** §9 budget points per region, indexed by BiomeId (contract numbers):
 * Verdant 6, Whisperwood 10, Emberscar 12, Frostvale 12, Hollow Spire 14. */
const REGION_BUDGET: readonly number[] = [6, 10, 12, 12, 14];

/** Spawn cadence. Accumulated against the fixed tick, at most one per period. */
const SPAWN_INTERVAL_SECONDS = 2;
/** Placement annulus around the player (contract): outside soft-lock range,
 * inside the 90 u despawn line with margin to roam. */
const SPAWN_MIN_DIST = 25;
const SPAWN_MAX_DIST = 45;
/** Keep-outs: the flat spawn disc at the origin, and the boss arena plateau. */
const SPAWN_DISC_RADIUS = 12;
const PLATEAU_KEEPOUT = 30;
/** On ground, above the fog sea — half a unit of margin so a spawn never wades. */
const MIN_GROUND_HEIGHT = SEA_LEVEL + 0.5;
/** Candidate attempts per cadence; the first block prefers the blind side. */
const PLACEMENT_ATTEMPTS = 10;
const BEHIND_ATTEMPTS = 6;
/** ±85.5° around the camera azimuth — strictly inside the back half-plane, so
 * a "behind" candidate can never ride the frustum edge. */
const BEHIND_SPREAD = Math.PI * 0.475;
/** An enemy deactivated (> 90 u, invisible) this long is retired. Long enough
 * that turning straight back (re-entering 80 u resets it) finds the world as
 * it was left; short enough that the cap can never pin on stragglers. */
const RECLAIM_AFTER_SECONDS = 12;

// Module scratch — §13: nothing allocated on the cadence path.
const reclaimPacket: DamagePacket = {
  amount: 0,
  sourceId: -1,
  crit: false,
  heavy: false,
  knockX: 0,
  knockZ: 0,
  hitX: 0,
  hitY: 0,
  hitZ: 0,
};

/**
 * Module-scope mulberry32, the same shape SoulOrbs uses: the gate calls
 * setDirectorSeed(n) and the pick + placement sequence replays exactly
 * (rejected candidates consume draws too, so identical world + identical
 * player path is part of the fixture).
 */
let rngState = 0x51ab7e93;

export function setDirectorSeed(seed: number): void {
  rngState = (seed | 0) >>> 0;
}

function rand(): number {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export class SpawnDirector implements System {
  /** Debug/world-gate switch: a paused director does nothing at all — no spawns, no reclaims. */
  paused = false;

  readonly name = 'spawnDirector';

  /** Camera blind-side hint; null falls back to full-circle placement. */
  cameraYawRef: CameraYawSource | null;

  private readonly manager: EnemyManager;
  private readonly biomes: BiomeTable;
  private readonly player: PlayerController;
  private readonly field: HeightSampler;

  /** Per-region candidate tables, built once at boot from enemies.json biome
   * tags (§4.1: the JSON is the authority; adding kind #13 lands here with
   * zero code). Weights are 1/budgetCost — cheap kinds are the common sight. */
  private readonly regionDefs: EnemyDef[][] = [];
  private readonly regionWeights: Float64Array[] = [];

  /** The ledger, pre-sized to the §9 cap — one row per live director spawn. */
  private readonly trackedEnemy: (EnemyBase | null)[];
  private readonly trackedCost: Int32Array;
  private readonly trackedRegion: Int32Array;
  /** Seconds spent deactivated, in cadence steps; drives the far reclaim. */
  private readonly trackedInactive: Float64Array;
  private trackedCount = 0;

  /** Points charged per region by live ACTIVE spawns; recomputed each cadence. */
  private readonly spentByRegion: Int32Array;
  private readonly sampleScratch: BiomeSample = createBiomeSample();

  private cadence = 0;
  private currentRegion: BiomeId = 0;
  private spawned = 0;
  /** findSpot's out-params (§13: no result objects). */
  private spotX = 0;
  private spotZ = 0;

  constructor(options: SpawnDirectorOptions) {
    this.manager = options.manager;
    this.biomes = options.biomes;
    this.player = options.player;
    this.field = options.field;
    this.cameraYawRef = options.cameraYawRef ?? null;

    if (REGION_BUDGET.length !== BIOME_COUNT) {
      // Boot-time guard: a sixth region added without a budget must fail loud.
      throw new Error(
        `SpawnDirector: REGION_BUDGET has ${REGION_BUDGET.length} entries for ${BIOME_COUNT} biomes`,
      );
    }

    const all = options.defs.all;
    for (let region = 0; region < BIOME_COUNT; region++) {
      const list: EnemyDef[] = [];
      for (let i = 0; i < all.length; i++) {
        const def = all[i];
        if (def !== undefined && def.biomes.indexOf(region) >= 0) list.push(def);
      }
      const weights = new Float64Array(list.length);
      for (let i = 0; i < list.length; i++) {
        const def = list[i];
        weights[i] = def === undefined ? 0 : 1 / def.budgetCost;
      }
      if (list.length === 0) {
        // Legal (the table stays data-driven) but §12-suspect: a region with
        // no tagged kinds will simply never spawn anything.
        console.warn(`SpawnDirector: no enemies.json entry is tagged for biome ${region}`);
      }
      this.regionDefs.push(list);
      this.regionWeights.push(weights);
    }

    const cap = EnemyManager.MAX_ENEMIES;
    this.trackedEnemy = new Array<EnemyBase | null>(cap).fill(null);
    this.trackedCost = new Int32Array(cap);
    this.trackedRegion = new Int32Array(cap);
    this.trackedInactive = new Float64Array(cap);
    this.spentByRegion = new Int32Array(BIOME_COUNT);

    const p = this.player.position;
    this.currentRegion = this.biomes.sample(p.x, p.z, this.sampleScratch).dominant;
  }

  /** Points currently charged against the player's dominant region. */
  get activeBudgetUsed(): number {
    return this.spentByRegion[this.currentRegion] ?? 0;
  }

  /** The dominant region's §9 budget cap. */
  get regionBudget(): number {
    return REGION_BUDGET[this.currentRegion] ?? 0;
  }

  /** Total successful director spawns since boot/reset — the debug surface. */
  get spawnedCount(): number {
    return this.spawned;
  }

  update(dt: number): void {
    if (this.paused) return;
    // Accumulated, not per-frame (contract): between cadences this method is
    // one add and one compare — nothing else runs at tick rate.
    this.cadence += dt;
    if (this.cadence < SPAWN_INTERVAL_SECONDS) return;
    this.cadence -= SPAWN_INTERVAL_SECONDS;
    // A stall (tab hidden, debugger) banks at most one extra period: the
    // director refills at cadence rate, it never bursts to catch up.
    if (this.cadence > SPAWN_INTERVAL_SECONDS) this.cadence = SPAWN_INTERVAL_SECONDS;
    this.cadenceTick();
  }

  /** Clears the ledger and cadence. The enemies themselves are the manager's
   * (contract); after an engine reset the manager revives its population and
   * the §9 cap alone bounds any overlap until attrition rebalances it. */
  reset(): void {
    this.cadence = 0;
    this.spawned = 0;
    this.trackedCount = 0;
    for (let i = 0; i < this.trackedEnemy.length; i++) this.trackedEnemy[i] = null;
    this.trackedInactive.fill(0);
    this.spentByRegion.fill(0);
    const p = this.player.position;
    this.currentRegion = this.biomes.sample(p.x, p.z, this.sampleScratch).dominant;
  }

  // --- the cadence ------------------------------------------------------------

  private cadenceTick(): void {
    const manager = this.manager;
    // Corpses out first: releases hitbox slots and cap room (contract), which
    // is also what lets "a dead one just frees budget" replace kinds — the
    // next pick rolls fresh, it does not remember what died.
    manager.purgeDead();
    this.recount();

    // §9's hard cap gates before any pick. spawnDef re-checks it regardless.
    if (manager.enemies.length >= EnemyManager.MAX_ENEMIES) return;
    // No population pressure on a dead player — respawn should not be a mob.
    if (this.player.statsRef.hp <= 0) return;

    const region = this.currentRegion;
    const cap = REGION_BUDGET[region] ?? 0;
    const used = this.spentByRegion[region] ?? 0;
    const headroom = cap - used;
    if (headroom <= 0) return;

    const def = this.pickDef(region, headroom);
    if (def === null) return;
    if (!this.findSpot(region)) return;

    const enemy = manager.spawnDef(def, this.spotX, this.spotZ);
    if (enemy === null) return;

    const row = this.trackedCount;
    if (row < this.trackedEnemy.length) {
      // Always true: every tracked row is a live enemy, and live enemies are
      // capped at 18 by the manager. The guard is belt-and-braces.
      this.trackedEnemy[row] = enemy;
      this.trackedCost[row] = def.budgetCost;
      this.trackedRegion[row] = region;
      this.trackedInactive[row] = 0;
      this.trackedCount = row + 1;
    }
    this.spentByRegion[region] = used + def.budgetCost;
    this.spawned++;
  }

  /**
   * One pass over the ledger: drop the dead, retire long-deactivated
   * stragglers, charge the points of everything alive AND active to the
   * region it was spawned for, and re-sample the player's dominant region.
   * In-place compaction over the pre-sized arrays — zero allocation.
   */
  private recount(): void {
    const spent = this.spentByRegion;
    spent.fill(0);
    const enemies = this.trackedEnemy;
    const costs = this.trackedCost;
    const regions = this.trackedRegion;
    const inactive = this.trackedInactive;

    let write = 0;
    for (let i = 0; i < this.trackedCount; i++) {
      const enemy = enemies[i];
      if (enemy === undefined || enemy === null) continue;
      if (!enemy.alive) {
        // Death releases the points for good; next purgeDead frees the slot.
        enemies[i] = null;
        continue;
      }

      let inactiveFor = inactive[i] ?? 0;
      if (enemy.active) {
        inactiveFor = 0;
        const region = regions[i] ?? 0;
        spent[region] = (spent[region] ?? 0) + (costs[i] ?? 0);
      } else {
        // Deactivated (§9: > 90 u, mesh hidden): points already released. If
        // it stays out long enough, retire it so it cannot pin the cap.
        inactiveFor += SPAWN_INTERVAL_SECONDS;
        if (inactiveFor >= RECLAIM_AFTER_SECONDS) {
          this.reclaim(enemy);
          enemies[i] = null;
          continue;
        }
      }

      if (write !== i) {
        enemies[write] = enemy;
        costs[write] = costs[i] ?? 0;
        regions[write] = regions[i] ?? 0;
        enemies[i] = null;
      }
      inactive[write] = inactiveFor;
      write++;
    }
    this.trackedCount = write;

    const p = this.player.position;
    this.currentRegion = this.biomes.sample(p.x, p.z, this.sampleScratch).dominant;
  }

  /**
   * Silent far despawn (§9: "musuh jauh > 90 unit di-despawn"). Direct
   * EnemyBase.takeDamage, deliberately NOT DamageSystem.deal: no kill event
   * fires, so no soul orb, no damage number, no reaction — and the reward is
   * consumed here so the manager's xp sweep finds nothing to bank. The mesh
   * has been hidden since deactivation, so nothing is visible either way.
   */
  private reclaim(enemy: EnemyBase): void {
    reclaimPacket.amount = enemy.hp;
    reclaimPacket.hitX = enemy.position.x;
    reclaimPacket.hitY = enemy.position.y;
    reclaimPacket.hitZ = enemy.position.z;
    enemy.takeDamage(reclaimPacket);
    enemy.consumeKillReward();
  }

  /**
   * Seeded weighted pick among the region's kinds that FIT the remaining
   * headroom. Weight 1/budgetCost: in Verdant a 1-pt kind is twice as
   * likely as a 2-pt kind — crowds stay cheap, heavies stay events —
   * and the last points in a budget go to the small kinds by construction.
   */
  private pickDef(region: number, headroom: number): EnemyDef | null {
    const defs = this.regionDefs[region];
    const weights = this.regionWeights[region];
    if (defs === undefined || weights === undefined || defs.length === 0) return null;

    let total = 0;
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      if (def !== undefined && def.budgetCost <= headroom) total += weights[i] ?? 0;
    }
    if (total <= 0) return null;

    let roll = rand() * total;
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      if (def === undefined || def.budgetCost > headroom) continue;
      roll -= weights[i] ?? 0;
      if (roll <= 0) return def;
    }
    // Float dust fell past the last bucket: take the last eligible kind.
    for (let i = defs.length - 1; i >= 0; i--) {
      const def = defs[i];
      if (def !== undefined && def.budgetCost <= headroom) return def;
    }
    return null;
  }

  /**
   * Candidate placement, up to PLACEMENT_ATTEMPTS rejection-sampled tries per
   * cadence. The first BEHIND_ATTEMPTS aim into the camera's back half-plane
   * (§9 cleanliness: nothing materialises on screen); the rest fall back to
   * the full circle so a player backed against a cliff still gets pressure.
   * A candidate must be: inside the world, in the annulus, off the origin
   * spawn disc, off the boss plateau, on ground above the fog sea, and in the
   * SAME dominant region the def was picked for — a spawn point across a
   * border would put a region-valid kind in the wrong region's scenery.
   */
  private findSpot(region: number): boolean {
    const p = this.player.position;
    const field = this.field;
    const yawSource = this.cameraYawRef;

    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
      let theta: number;
      if (yawSource !== null && attempt < BEHIND_ATTEMPTS) {
        theta = yawSource.getYaw() + (rand() * 2 - 1) * BEHIND_SPREAD;
      } else {
        theta = rand() * Math.PI * 2;
      }
      const dist = SPAWN_MIN_DIST + rand() * (SPAWN_MAX_DIST - SPAWN_MIN_DIST);
      const x = p.x + Math.sin(theta) * dist;
      const z = p.z + Math.cos(theta) * dist;

      if (x * x + z * z < SPAWN_DISC_RADIUS * SPAWN_DISC_RADIUS) continue;
      const px = x - SPIRE_PLATEAU_X;
      const pz = z - SPIRE_PLATEAU_Z;
      if (px * px + pz * pz < PLATEAU_KEEPOUT * PLATEAU_KEEPOUT) continue;
      if (!field.inBounds(x, z)) continue;
      if (this.biomes.sample(x, z, this.sampleScratch).dominant !== region) continue;
      if (field.heightAt(x, z) < MIN_GROUND_HEIGHT) continue;

      this.spotX = x;
      this.spotZ = z;
      return true;
    }
    return false;
  }
}
