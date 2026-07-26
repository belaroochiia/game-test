import * as THREE from 'three';

import type { Combatant, DamagePacket } from '../combat/CombatTypes';
import { TEAM } from '../combat/CombatTypes';
import type { DamageSystem } from '../combat/DamageSystem';
import type { HitboxSystem, HitQuery } from '../combat/HitboxSystem';
import type { Hitstop } from '../combat/Hitstop';
import type { System } from '../core/Engine';
import type { PlayerController } from '../player/PlayerController';
import type { HeightSampler } from '../world/HeightField';
import type { SpatialHash } from '../world/SpatialHash';
import { AI_STATE, STRIKE_RADIUS } from './AIBrain';
import type { AIContext } from './AIBrain';
import { ArchetypeEnemy, EnemyProjectiles } from './ArchetypeEnemy';
import type { EnemyBase } from './EnemyBase';
import type { EnemyDef as ArchetypeDef } from './EnemyDefs';

/**
 * Owns the enemy population: spawning, §9's staggered brain updates, despawn
 * hysteresis, and the wiring of enemy attacks into agent A's combat plumbing.
 * Individual enemies never touch HitboxSystem/DamageSystem — all damage flows
 * through here, so the per-enemy code stays presentation + motion only.
 *
 * The whole update early-returns while hitstop is active (contract): enemies
 * freeze mid-hop while the camera and world keep breathing — that contrast is
 * what makes 4 ticks read as impact.
 */

export interface EnemyManagerOptions {
  scene: THREE.Scene;
  field: HeightSampler;
  player: PlayerController;
  hitbox: HitboxSystem;
  damage: DamageSystem;
  hitstop: Hitstop;
}

/** Phase 4: what the manager needs from StatusEffects. Wired by the bootstrap. */
export interface FreezeSource {
  isFrozen(c: { readonly id: number }): boolean;
}

/** Phase 4: status-board lifecycle, so spawned enemies can carry statuses. */
export interface BoardSource {
  register(c: Combatant): void;
  unregister(c: Combatant): void;
}

/** §9's cheap AI stagger: past this distance, brains step every 6th tick. */
const BRAIN_NEAR_DIST = 30;
const BRAIN_TICK_STRIDE = 6;
/** §9 despawn with hysteresis so the boundary does not flap. */
const DEACTIVATE_DIST = 90;
const REACTIVATE_DIST = 80;
/** Respawn only when the player is farther than this from the corpse's home. */
const RESPAWN_MIN_PLAYER_DIST = 25;
/** Contact sphere = enemy radius + this; quick-rejected far before the overlap. */
const CONTACT_PAD = 0.15;
const CONTACT_CHECK_DIST = 1.6;
/** Knockback impulses (u/s) dealt to the player. */
const STRIKE_KNOCK = 7;
const CONTACT_KNOCK = 3.5;
/** Phase 3 player has no gear (§10 is Phase 6). */
const PLAYER_ARMOR = 0;
const SPAWN_MARGIN = 2;

let nextEnemyId = 100; // clear of whatever id the integrator gives the player

// Module scratch — §13: nothing allocated per tick.
const scratchCtx: AIContext = {
  self: null as unknown as EnemyBase,
  playerPos: null as unknown as THREE.Vector3,
  playerAlive: false,
  distToPlayer: 0,
  dt: 0,
};
const scratchQuery: HitQuery = { x: 0, y: 0, z: 0, radius: 0, team: TEAM.Enemy, sourceId: 0 };
const killPacket: DamagePacket = {
  amount: 0,
  sourceId: -1,
  crit: false,
  heavy: true,
  knockX: 0,
  knockZ: 0,
  hitX: 0,
  hitY: 0,
  hitZ: 0,
};

export class EnemyManager implements System {
  readonly name = 'enemies';

  /** Phase 4 wiring; null until the bootstrap sets it. */
  freezeRef: FreezeSource | null = null;
  boardsRef: BoardSource | null = null;
  /** Phase 5 wiring (optional): prop AABBs so charge attacks stop on props. */
  propsRef: SpatialHash | null = null;

  /** Stable array — TargetLock iterates it; never reallocated per frame. */
  readonly enemies: EnemyBase[] = [];

  private readonly scene: THREE.Scene;
  private readonly field: HeightSampler;
  private readonly player: PlayerController;
  private readonly hitbox: HitboxSystem;
  private readonly damage: DamageSystem;
  private readonly hitstop: Hitstop;

  private tick = 0;
  /** §8.2's soul-drop economy arrives in Phase 4; Phase 6 spends this. */
  private xpTotal = 0;
  private seedCursor = 1237;
  /** Phase 5: ONE projectile slab shared by every enemy, built on first need. */
  private projectiles: EnemyProjectiles | null = null;
  /**
   * Phase 5: the one scripted boss (spawnBoss). Exempt from purgeDead — its
   * corpse must not be reclaimed, because the HUD's boss bar keeps reading the
   * object and a purged boss could never be revived by reset().
   */
  private bossExempt: EnemyBase | null = null;

  /** Callback context for the pre-bound overlap visitor (§13: no closures). */
  private hitSource: EnemyBase | null = null;
  private hitKnock = 0;

  constructor(options: EnemyManagerOptions) {
    this.scene = options.scene;
    this.field = options.field;
    this.player = options.player;
    this.hitbox = options.hitbox;
    this.damage = options.damage;
    this.hitstop = options.hitstop;
  }

  /** §9's hard cap on concurrently active enemies. */
  static readonly MAX_ENEMIES = 18;

  /**
   * Removes dead enemies entirely: hitbox slot released, mesh out of the scene,
   * disposed, compacted out of the array. Spawning past the cap without this
   * exhausted HitboxSystem's fixed slots — corpses held them forever.
   */
  purgeDead(): number {
    const enemies = this.enemies;
    let write = 0;
    let purged = 0;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (enemy === undefined) continue;
      // The scripted boss is never reclaimed (see bossExempt) — its corpse
      // outlives the kill so the HUD bar and a later reset() still reach it.
      if (!enemy.alive && enemy !== this.bossExempt) {
        this.hitbox.unregister(enemy);
        if (this.boardsRef !== null) this.boardsRef.unregister(enemy);
        this.scene.remove(enemy.root);
        enemy.dispose();
        purged++;
        continue;
      }
      enemies[write] = enemy;
      write++;
    }
    enemies.length = write;
    return purged;
  }

  /**
   * Phase 5: spawn one enemy from a validated enemies.json def (§4.1 extended
   * to enemies — the def carries body, stats and attack; no kind reaches
   * code). Returns the enemy, or null when §9's cap of 18 leaves no room.
   * Spawns are director-managed: they never self-respawn — SpawnDirector owns
   * the population and death releases its budget.
   */
  spawnDef(def: ArchetypeDef, x: number, z: number, directorManaged = true): EnemyBase | null {
    this.purgeDead();
    if (this.enemies.length >= EnemyManager.MAX_ENEMIES) return null;
    const field = this.field;
    let homeX = x;
    let homeZ = z;
    if (homeX < field.minX + SPAWN_MARGIN) homeX = field.minX + SPAWN_MARGIN;
    else if (homeX > field.maxX - SPAWN_MARGIN) homeX = field.maxX - SPAWN_MARGIN;
    if (homeZ < field.minZ + SPAWN_MARGIN) homeZ = field.minZ + SPAWN_MARGIN;
    else if (homeZ > field.maxZ - SPAWN_MARGIN) homeZ = field.maxZ - SPAWN_MARGIN;

    const projectiles = this.sharedProjectiles();

    this.seedCursor = (this.seedCursor + 7919) | 0;
    const enemy = new ArchetypeEnemy({
      id: nextEnemyId++,
      def,
      field,
      homeX,
      homeZ,
      seed: this.seedCursor,
      hitbox: this.hitbox,
      damage: this.damage,
      projectiles,
      props: this.propsRef,
      // Director-managed enemies never self-respawn — population is the
      // director's job. Gate/debug spawns keep EnemyBase's 12 s home respawn,
      // which the Phase 3 gate asserts.
      directorManaged,
    });
    this.scene.add(enemy.root);
    this.hitbox.register(enemy);
    if (this.boardsRef !== null) this.boardsRef.register(enemy);
    this.enemies.push(enemy);
    return enemy;
  }

  /**
   * Phase 5: adopt the scripted boss (BossVael constructs itself — it is
   * content, not an enemies.json kind) into the ordinary lifecycle: scene,
   * hitbox slot, status board, the enemies array (so TargetLock can lock it),
   * §9's cap, hitstop gating and despawn hysteresis all apply unchanged. The
   * boss is exempt from purgeDead and never self-respawns; reset() revives it
   * with everything else. Returns false when the cap leaves no room.
   */
  spawnBoss(boss: EnemyBase): boolean {
    this.purgeDead();
    if (this.enemies.length >= EnemyManager.MAX_ENEMIES) return false;
    this.scene.add(boss.root);
    this.hitbox.register(boss);
    if (this.boardsRef !== null) this.boardsRef.register(boss);
    this.enemies.push(boss);
    this.bossExempt = boss;
    return true;
  }

  /**
   * Phase 5: THE shared enemy projectile slab (contract: one pool for the
   * whole bestiary, §13). Lazily built; spawnDef and the boss wiring both
   * draw from here so a second slab can never exist.
   */
  sharedProjectiles(): EnemyProjectiles {
    if (this.projectiles === null) {
      this.projectiles = new EnemyProjectiles({
        scene: this.scene,
        hitbox: this.hitbox,
        damage: this.damage,
        field: this.field,
      });
    }
    return this.projectiles;
  }

  get aliveCount(): number {
    let count = 0;
    const enemies = this.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (enemy !== undefined && enemy.alive) count++;
    }
    return count;
  }

  /** Banked kill xp; Phase 6's progression consumes it. */
  get xpBanked(): number {
    return this.xpTotal;
  }

  update(dt: number): void {
    // The freeze IS the feel: every enemy stops dead while hitstop runs.
    if (this.hitstop.active) return;
    this.tick++;

    const player = this.player;
    const px = player.position.x;
    const pz = player.position.z;
    const playerAlive = player.statsRef.hp > 0;
    scratchCtx.playerPos = player.position;
    scratchCtx.playerAlive = playerAlive;

    const enemies = this.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (enemy === undefined) continue;

      const dx = px - enemy.position.x;
      const dz = pz - enemy.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      this.xpTotal += enemy.consumeKillReward();

      if (!enemy.alive) {
        enemy.update(dt); // corpse slide + deadFor bookkeeping
        if (enemy.readyToRespawn && dist > RESPAWN_MIN_PLAYER_DIST) enemy.reset();
        continue;
      }

      // §9 despawn hysteresis: out past 90 u, back inside 80 u.
      if (enemy.active) {
        if (dist > DEACTIVATE_DIST) enemy.setActive(false);
      } else if (dist < REACTIVATE_DIST) {
        enemy.setActive(true);
      }
      if (!enemy.active) continue;

      enemy.facePlayerHint(px, pz);

      // §9's stagger: far brains think every 6th tick (spread by id so they do
      // not all think on the same tick), but position integrates every tick.
      enemy.accumulateBrainDt(dt);
      if (dist <= BRAIN_NEAR_DIST || (this.tick + enemy.id) % BRAIN_TICK_STRIDE === 0) {
        if (enemy.staggered) {
          enemy.consumeBrainDt(); // stagger eats the time, not the FSM
        } else {
          scratchCtx.self = enemy;
          scratchCtx.distToPlayer = dist;
          scratchCtx.dt = enemy.consumeBrainDt();
          // §8.5 Freeze: a frozen enemy neither thinks nor moves. The brain's
          // timers also hold, so freeze cannot be used to skip a telegraph.
          if (this.freezeRef !== null && this.freezeRef.isFrozen(enemy)) {
            enemy.desiredMove.set(0, 0);
          } else {
            enemy.brain.step(scratchCtx, enemy.desiredMove);
          }
          if (enemy.brain.consumeStrike()) enemy.beginStrike();
        }
      }

      enemy.update(dt);

      // The lunge landed: damage exactly where the telegraph ring promised.
      if (enemy.consumeStrikeLanded()) {
        this.dealArea(enemy, STRIKE_RADIUS, STRIKE_KNOCK);
      }

      // Touching a slime hurts — 0.5 s per-enemy cooldown, and never during an
      // attack, so the telegraph's "no damage before the ring completes" holds.
      if (
        dist < CONTACT_CHECK_DIST &&
        enemy.contactReady &&
        enemy.brain.state !== AI_STATE.Attack
      ) {
        const hits = this.dealArea(enemy, enemy.radius + CONTACT_PAD, CONTACT_KNOCK);
        if (hits > 0) enemy.markContactHit();
      }
    }

    // Shared enemy shots fly on the same gate, so they freeze with hitstop too.
    if (this.projectiles !== null) this.projectiles.update(dt);
  }

  render(alpha: number): void {
    const enemies = this.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (enemy === undefined || !enemy.active) continue;
      const prev = enemy.prevPosition;
      const cur = enemy.position;
      const x = prev.x + (cur.x - prev.x) * alpha;
      const y = prev.y + (cur.y - prev.y) * alpha;
      const z = prev.z + (cur.z - prev.z) * alpha;
      enemy.applyVisual(x, y, z, enemy.yaw);
    }
    if (this.projectiles !== null) this.projectiles.render(alpha);
  }

  /** Everyone back to their home point at full hp; the population survives. */
  reset(): void {
    this.tick = 0;
    this.xpTotal = 0;
    const enemies = this.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (enemy !== undefined) enemy.reset();
    }
    if (this.projectiles !== null) this.projectiles.reset();
  }

  dispose(): void {
    const enemies = this.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (enemy === undefined) continue;
      this.hitbox.unregister(enemy);
      this.scene.remove(enemy.root);
      enemy.dispose();
    }
    enemies.length = 0;
    this.bossExempt = null;
    if (this.projectiles !== null) {
      this.projectiles.dispose();
      this.projectiles = null;
    }
  }

  /** Debug hook (the gate's killAllEnemies) — through takeDamage so death flows run. */
  killAll(): void {
    const enemies = this.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (enemy === undefined || !enemy.alive) continue;
      killPacket.amount = enemy.hp;
      killPacket.knockX = 0;
      killPacket.knockZ = 0;
      killPacket.hitX = enemy.position.x;
      killPacket.hitY = enemy.position.y + enemy.height * 0.5;
      killPacket.hitZ = enemy.position.z;
      enemy.takeDamage(killPacket);
    }
  }

  /**
   * Sphere overlap at the enemy's centre against the player's team, dealing
   * contact damage with radial knockback. Returns the hit count.
   */
  private dealArea(source: EnemyBase, radius: number, knock: number): number {
    scratchQuery.x = source.position.x;
    scratchQuery.y = source.position.y + source.height * 0.5;
    scratchQuery.z = source.position.z;
    scratchQuery.radius = radius;
    scratchQuery.sourceId = source.id;
    this.hitSource = source;
    this.hitKnock = knock;
    const hits = this.hitbox.overlapSphere(scratchQuery, this.onEnemyHit);
    this.hitSource = null;
    return hits;
  }

  /** Pre-bound overlap visitor; per-call context rides in hitSource/hitKnock. */
  private readonly onEnemyHit = (target: Combatant): void => {
    const source = this.hitSource;
    if (source === null) return;
    let dx = target.position.x - source.position.x;
    let dz = target.position.z - source.position.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len > 1e-5) {
      dx /= len;
      dz /= len;
    } else {
      dx = Math.sin(source.yaw);
      dz = -Math.cos(source.yaw);
    }
    const knock = this.hitKnock;
    this.damage.deal(
      target,
      source.def.contactDamage,
      0, // enemies have no stat scaling in Phase 3
      PLAYER_ARMOR,
      false,
      source.id,
      dx * knock,
      dz * knock,
      target.position.x,
      target.position.y + target.height * 0.55,
      target.position.z,
    );
  };
}
