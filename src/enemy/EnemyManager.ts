import * as THREE from 'three';

import type { Combatant, DamagePacket } from '../combat/CombatTypes';
import { TEAM } from '../combat/CombatTypes';
import type { DamageSystem } from '../combat/DamageSystem';
import type { HitboxSystem, HitQuery } from '../combat/HitboxSystem';
import type { Hitstop } from '../combat/Hitstop';
import type { System } from '../core/Engine';
import type { PlayerController } from '../player/PlayerController';
import type { HeightSampler } from '../world/HeightField';
import { AI_STATE, STRIKE_RADIUS } from './AIBrain';
import type { AIContext } from './AIBrain';
import type { EnemyBase } from './EnemyBase';
import { SlimeEnemy } from './SlimeEnemy';

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

  /** Test spawner: N slimes ringed around a point. SpawnDirector replaces in Phase 5. */
  spawnSlimes(centerX: number, centerZ: number, count: number, ringRadius: number): void {
    const field = this.field;
    const minX = field.minX + SPAWN_MARGIN;
    const maxX = field.maxX - SPAWN_MARGIN;
    const minZ = field.minZ + SPAWN_MARGIN;
    const maxZ = field.maxZ - SPAWN_MARGIN;
    for (let i = 0; i < count; i++) {
      const angle = count > 0 ? (i / count) * Math.PI * 2 : 0;
      let homeX = centerX + Math.sin(angle) * ringRadius;
      let homeZ = centerZ + Math.cos(angle) * ringRadius;
      if (homeX < minX) homeX = minX;
      else if (homeX > maxX) homeX = maxX;
      if (homeZ < minZ) homeZ = minZ;
      else if (homeZ > maxZ) homeZ = maxZ;

      this.seedCursor = (this.seedCursor + 7919) | 0;
      const slime = new SlimeEnemy({
        id: nextEnemyId++,
        field,
        homeX,
        homeZ,
        seed: this.seedCursor,
      });
      this.scene.add(slime.root);
      this.hitbox.register(slime);
      this.enemies.push(slime);
    }
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
          enemy.brain.step(scratchCtx, enemy.desiredMove);
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
