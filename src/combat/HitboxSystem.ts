import type { System } from '../core/Engine';
import type { Combatant, TeamId } from './CombatTypes';

export interface HitQuery {
  /** Sphere centre, world space. */
  x: number;
  y: number;
  z: number;
  radius: number;
  /** ATTACKER's team; the query hits the OTHER team. */
  team: TeamId;
  sourceId: number;
}

/** Player + §9's cap of 18 active enemies. */
const MAX_COMBATANTS = 19;

/**
 * Sphere-vs-capsule overlap queries over a flat registry (§7: sphere/capsule
 * overlap only). With at most 19 combatants a linear scan with a cheap XZ
 * pre-reject beats any spatial structure before the structure finishes being
 * maintained — building one here is the engineering §13 exists to prevent.
 */
export class HitboxSystem implements System {
  readonly name = 'hitbox';

  /** Fixed slab, swap-remove; slot order carries no meaning. */
  private readonly combatants: (Combatant | undefined)[];
  private count = 0;

  constructor() {
    this.combatants = new Array<Combatant | undefined>(MAX_COMBATANTS).fill(undefined);
  }

  /** Called at spawn time, never per frame. Duplicates and overflow are bugs. */
  register(combatant: Combatant): void {
    const list = this.combatants;
    for (let i = 0; i < this.count; i++) {
      if (list[i] === combatant) {
        console.warn('HitboxSystem: combatant already registered:', combatant.id);
        return;
      }
    }
    if (this.count >= MAX_COMBATANTS) {
      // The spawner owns the enemy cap (§9); reaching this line is a spawn bug.
      console.warn('HitboxSystem: registry full, dropping combatant:', combatant.id);
      return;
    }
    list[this.count] = combatant;
    this.count++;
  }

  unregister(combatant: Combatant): void {
    const list = this.combatants;
    for (let i = 0; i < this.count; i++) {
      if (list[i] !== combatant) continue;
      const last = this.count - 1;
      list[i] = list[last];
      list[last] = undefined;
      this.count = last;
      return;
    }
  }

  /**
   * Calls `onHit(combatant)` for every LIVING opponent of `query.team` whose
   * capsule overlaps the sphere. Touching counts: the test is inclusive at a
   * distance of exactly radius + radius. Allocation-free — pass a pre-bound
   * callback, and never register/unregister from inside it (swap-remove would
   * skew the scan in progress). Returns the number of hits.
   */
  overlapSphere(query: HitQuery, onHit: (target: Combatant) => void): number {
    const list = this.combatants;
    const n = this.count;
    const qx = query.x;
    const qy = query.y;
    const qz = query.z;
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const target = list[i];
      if (target === undefined || !target.alive || target.team === query.team) continue;

      const feet = target.position;
      const dx = qx - feet.x;
      const dz = qz - feet.z;
      const reach = query.radius + target.radius;
      const reachSq = reach * reach;
      // XZ reject first: the 3D distance can only be larger, and most
      // candidates fail here without touching the segment clamp below.
      if (dx * dx + dz * dz > reachSq) continue;

      // Capsule = sphere of target.radius swept along the vertical core
      // segment [feet + r, head - r]; clamp the sphere centre's Y to it.
      const segMin = feet.y + target.radius;
      let segMax = feet.y + target.height - target.radius;
      if (segMax < segMin) segMax = segMin; // stubby (height < 2r) degenerates to a sphere
      let dy = qy;
      if (dy < segMin) dy = segMin;
      else if (dy > segMax) dy = segMax;
      dy = qy - dy;

      if (dx * dx + dy * dy + dz * dz > reachSq) continue;
      hits++;
      onHit(target);
    }
    return hits;
  }

  /** Queries are attack-driven; the registry has no per-tick work. */
  update(): void {}

  /**
   * Keeps the registry: combatant lifetime is register-at-spawn /
   * unregister-at-despawn, and Engine.reset() resets the combatants themselves
   * in place — dropping them here would silently disarm everyone after a reset,
   * with no owner responsible for re-registering.
   */
  reset(): void {}
}
