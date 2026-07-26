import type * as THREE from 'three';

/**
 * Shared combat vocabulary (Phase 3 contract). Every combat system — hitboxes,
 * damage, enemies, target lock, damage numbers — compiles against this file, so
 * changing it is an interface change for all of them. Types only, plus the TEAM
 * table; no other runtime cost.
 */

/** One damageable thing. Player and enemies both satisfy it. */
export interface Combatant {
  readonly id: number;
  /** Feet position, world space. */
  readonly position: THREE.Vector3;
  /** Capsule radius for overlap tests. */
  readonly radius: number;
  /** Full capsule height, feet to crown. */
  readonly height: number;
  readonly team: TeamId;
  readonly alive: boolean;
  /**
   * Applies damage AFTER mitigation — `packet.amount` is final. Returns the
   * amount actually applied: 0 while i-framed or dead, less than `amount` on
   * overkill. The packet is scratch (see DamagePacket) — read synchronously.
   */
  takeDamage(packet: DamagePacket): number;
}

export const TEAM = { Player: 0, Enemy: 1 } as const;
export type TeamId = (typeof TEAM)[keyof typeof TEAM];

/**
 * Reused scratch object — same rule as EventBus payloads: a receiver copies the
 * fields it needs synchronously and must never retain the object or any part
 * of it. The next hit overwrites every field.
 */
export interface DamagePacket {
  /** Final damage, post-formula (§9: element, armor, crit, reaction applied). */
  amount: number;
  sourceId: number;
  crit: boolean;
  /** Drives hitstop length + stagger. */
  heavy: boolean;
  /** Knockback impulse, world space, u/s. */
  knockX: number;
  knockZ: number;
  /** World position of the hit, for the damage number. */
  hitX: number;
  hitY: number;
  hitZ: number;
}
