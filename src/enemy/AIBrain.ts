import * as THREE from 'three';

import type { EnemyBase, EnemyDef } from './EnemyBase';

/**
 * §9's enemy FSM: a plain switch, no behaviour tree. The brain only DECIDES —
 * it writes a desired move direction and attack timing; EnemyBase owns velocity,
 * knockback and ground contact. That split keeps the brain trivially testable
 * (step it with a fake self, no scene needed) and keeps §9's staggered updates
 * honest: skipping a brain step never freezes an enemy's motion.
 *
 * The Attack state is the whole reason Phase 3's enemy exists (§9: telegraphs
 * must be MORE readable on a phone, not less): stop, wind up for
 * `telegraphSeconds` while the ground ring grows, then strike. `consumeStrike()`
 * reports the completed wind-up exactly once — that is the frame the lunge
 * launches, and the contract every player death has to be able to point back to.
 */

export const AI_STATE = {
  Idle: 0,
  Patrol: 1,
  Alert: 2,
  Chase: 3,
  Attack: 4,
  Flee: 5,
  Dead: 6,
} as const;
export type AIState = (typeof AI_STATE)[keyof typeof AI_STATE];

/** Indexed by AIState — for the debug surface, allocation-free. */
export const AI_STATE_NAMES = ['Idle', 'Patrol', 'Alert', 'Chase', 'Attack', 'Flee', 'Dead'] as const;

export interface AIContext {
  self: EnemyBase;
  playerPos: THREE.Vector3;
  playerAlive: boolean;
  /** Precomputed by EnemyManager once per tick (2D, feet-to-feet). */
  distToPlayer: number;
  dt: number;
}

/**
 * Attack spec shared by the brain (timing), EnemyBase (the lunge) and the
 * subclass visuals (the ring). One home so the ring can never lie about the hit.
 */
export const STRIKE_SECONDS = 0.22;
export const STRIKE_RADIUS = 1.2;
export const LUNGE_DISTANCE = 0.9;

/** §9's "it noticed me" beat: face the player this long before chasing. */
const ALERT_SECONDS = 0.4;
/** Patrol wanders within this radius of home (contract). */
const WANDER_RADIUS = 8;
const WANDER_MIN_RADIUS = 1.5;
const WANDER_ARRIVE_SQ = 0.35 * 0.35;
/** Blocked wander targets (world rim, future props) time out instead of sticking. */
const WANDER_TIMEOUT_SECONDS = 8;
const IDLE_PAUSE_MIN = 1.0;
const IDLE_PAUSE_SPAN = 1.8;
/** Chase gives up past aggro x this — hysteresis so the boundary does not flap. */
const DEAGGRO_FACTOR = 1.6;
/** Flee is over once the player is this many aggro-radii away. */
const FLEE_ESCAPE_FACTOR = 2;
/** After a heavy hit cancels a wind-up, wait before telegraphing again. */
const INTERRUPTED_ATTACK_COOLDOWN = 0.6;

const PHASE_TELEGRAPH = 0;
const PHASE_STRIKE = 1;
const PHASE_RECOVER = 2;

export class AIBrain {
  /**
   * Enter Flee below this hp fraction. 0 disables — the baseline blob never flees, but
   * the state machine supports it because a later enemy will (contract).
   */
  fleeHpFraction = 0;

  private readonly def: EnemyDef;
  private readonly seed: number;

  private current: AIState = AI_STATE.Idle;
  /** One timer per state; states are exclusive so they cannot collide. */
  private timer = 0;
  private phase = PHASE_TELEGRAPH;
  private strikePending = false;
  private attackCooldown = 0;

  private wanderX = 0;
  private wanderZ = 0;
  private wanderElapsed = 0;

  /** Locked at telegraph start: a committed, dodgeable strike direction. */
  private aimDirX = 0;
  private aimDirZ = 1;

  /** mulberry32 state — seeded, so patrol is deterministic per enemy (§4). */
  private rng = 0;

  constructor(def: EnemyDef, seed: number) {
    this.def = def;
    this.seed = seed | 0;
    this.reset(true);
  }

  get state(): AIState {
    return this.current;
  }

  get telegraphing(): boolean {
    return this.current === AI_STATE.Attack && this.phase === PHASE_TELEGRAPH;
  }

  /** 0..1 while telegraphing — drives the ground ring; 0 otherwise. */
  get telegraphProgress(): number {
    if (!this.telegraphing) return 0;
    const t = 1 - this.timer / this.def.telegraphSeconds;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }

  get aimX(): number {
    return this.aimDirX;
  }

  get aimZ(): number {
    return this.aimDirZ;
  }

  /** True exactly once when a telegraph completes — the strike frame. */
  consumeStrike(): boolean {
    const pending = this.strikePending;
    this.strikePending = false;
    return pending;
  }

  /**
   * A heavy hit staggers the enemy and cancels an UNFINISHED wind-up. A strike
   * already launched is not undone — the telegraph's promise stays honest in
   * both directions.
   */
  interrupt(): void {
    if (this.current !== AI_STATE.Attack || this.phase !== PHASE_TELEGRAPH) return;
    this.strikePending = false;
    this.attackCooldown = INTERRUPTED_ATTACK_COOLDOWN;
    this.current = AI_STATE.Chase;
  }

  /**
   * `home = true` restores the seeded RNG stream (fresh spawn / respawn), so a
   * respawned enemy patrols identically — deterministic worlds stay §4's rule.
   * `home = false` keeps the stream (deactivate/reactivate must not replay).
   */
  reset(home: boolean): void {
    if (home) this.rng = this.seed;
    this.current = AI_STATE.Idle;
    this.phase = PHASE_TELEGRAPH;
    this.strikePending = false;
    this.attackCooldown = 0;
    this.wanderElapsed = 0;
    this.timer = IDLE_PAUSE_MIN + this.nextRandom() * IDLE_PAUSE_SPAN;
  }

  /** Advances the FSM by ctx.dt and writes the desired move (unit or zero). */
  step(ctx: AIContext, outMove: THREE.Vector2): void {
    outMove.set(0, 0);
    const self = ctx.self;

    if (!self.alive) {
      this.current = AI_STATE.Dead;
      this.strikePending = false;
      return;
    }
    // Revival is explicit via reset(); this is a guard, not a path.
    if (this.current === AI_STATE.Dead) this.enterIdle();

    const def = this.def;
    const dt = ctx.dt;
    if (this.attackCooldown > 0) this.attackCooldown -= dt;

    const aggro = ctx.playerAlive && ctx.distToPlayer <= def.aggroRadius;

    switch (this.current) {
      case AI_STATE.Idle: {
        if (aggro) {
          this.enterAlert();
          break;
        }
        this.timer -= dt;
        if (this.timer <= 0) this.enterPatrol(self);
        break;
      }

      case AI_STATE.Patrol: {
        if (aggro) {
          this.enterAlert();
          break;
        }
        this.wanderElapsed += dt;
        const dx = this.wanderX - self.position.x;
        const dz = this.wanderZ - self.position.z;
        const distSq = dx * dx + dz * dz;
        if (distSq <= WANDER_ARRIVE_SQ || this.wanderElapsed > WANDER_TIMEOUT_SECONDS) {
          this.enterIdle();
          break;
        }
        const inv = 1 / Math.sqrt(distSq);
        outMove.set(dx * inv, dz * inv);
        break;
      }

      case AI_STATE.Alert: {
        // Stand and face the player (EnemyBase turns toward it) — the readable
        // "noticed you" beat. It always completes; Chase re-checks range next step.
        if (!ctx.playerAlive) {
          this.enterIdle();
          break;
        }
        this.timer -= dt;
        if (this.timer <= 0) this.current = AI_STATE.Chase;
        break;
      }

      case AI_STATE.Chase: {
        if (!ctx.playerAlive || ctx.distToPlayer > def.aggroRadius * DEAGGRO_FACTOR) {
          // Wander targets are picked around HOME, so a long chase walks itself back.
          this.enterPatrol(self);
          break;
        }
        if (this.fleeHpFraction > 0 && self.hp <= def.maxHp * this.fleeHpFraction) {
          this.current = AI_STATE.Flee;
          break;
        }
        if (ctx.distToPlayer <= def.attackRadius && this.attackCooldown <= 0) {
          this.enterAttack(ctx);
          break;
        }
        const dx = ctx.playerPos.x - self.position.x;
        const dz = ctx.playerPos.z - self.position.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 1e-5) outMove.set(dx / len, dz / len);
        break;
      }

      case AI_STATE.Attack: {
        this.timer -= dt;
        if (this.phase === PHASE_TELEGRAPH) {
          if (!ctx.playerAlive) {
            // Wind down without striking a corpse.
            this.enterIdle();
            break;
          }
          if (this.timer <= 0) {
            this.strikePending = true;
            this.phase = PHASE_STRIKE;
            this.timer = STRIKE_SECONDS;
          }
        } else if (this.phase === PHASE_STRIKE) {
          if (this.timer <= 0) {
            this.phase = PHASE_RECOVER;
            this.timer = def.attackRecoverSeconds;
          }
        } else if (this.timer <= 0) {
          if (ctx.playerAlive) this.current = AI_STATE.Chase;
          else this.enterIdle();
        }
        break;
      }

      case AI_STATE.Flee: {
        if (!ctx.playerAlive || ctx.distToPlayer > def.aggroRadius * FLEE_ESCAPE_FACTOR) {
          this.enterPatrol(self);
          break;
        }
        const dx = self.position.x - ctx.playerPos.x;
        const dz = self.position.z - ctx.playerPos.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 1e-5) outMove.set(dx / len, dz / len);
        break;
      }

      case AI_STATE.Dead:
        break;
    }
  }

  private enterIdle(): void {
    this.current = AI_STATE.Idle;
    this.timer = IDLE_PAUSE_MIN + this.nextRandom() * IDLE_PAUSE_SPAN;
  }

  private enterAlert(): void {
    this.current = AI_STATE.Alert;
    this.timer = ALERT_SECONDS;
  }

  private enterPatrol(self: EnemyBase): void {
    const angle = this.nextRandom() * Math.PI * 2;
    const radius = WANDER_MIN_RADIUS + this.nextRandom() * (WANDER_RADIUS - WANDER_MIN_RADIUS);
    this.wanderX = self.homeX + Math.sin(angle) * radius;
    this.wanderZ = self.homeZ + Math.cos(angle) * radius;
    this.wanderElapsed = 0;
    this.current = AI_STATE.Patrol;
  }

  private enterAttack(ctx: AIContext): void {
    const self = ctx.self;
    let ax = ctx.playerPos.x - self.position.x;
    let az = ctx.playerPos.z - self.position.z;
    const len = Math.sqrt(ax * ax + az * az);
    if (len > 1e-5) {
      ax /= len;
      az /= len;
    } else {
      // Player standing inside the enemy: strike along current facing.
      ax = Math.sin(self.yaw);
      az = -Math.cos(self.yaw);
    }
    this.aimDirX = ax;
    this.aimDirZ = az;
    this.current = AI_STATE.Attack;
    this.phase = PHASE_TELEGRAPH;
    this.timer = this.def.telegraphSeconds;
  }

  /** mulberry32 — small, fast, deterministic; good enough for wander timers. */
  private nextRandom(): number {
    let t = (this.rng += 0x6d2b79f5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
