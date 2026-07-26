import type { System } from '../core/Engine';
import type { EventBus } from '../core/EventBus';
import type { Combatant, DamagePacket } from './CombatTypes';
import type { Hitstop } from './Hitstop';

/** §9's crit stats — player-derived defaults until Phase 6 makes them real stats. */
const CRIT_CHANCE = 0.08;
const CRIT_MULT = 1.6;
/** §9: armor halves damage at 300 and diminishes past it. */
const ARMOR_SOFTCAP = 300;
/** Phase 4 fills these from skill element + status reactions (§8.5). */
const ELEMENT_MULT = 1;
const REACTION_MULT = 1;
/**
 * §9 asks for 60-90 ms; on the 60 Hz fixed step that is 4 ticks (~67 ms) for
 * light hits and 6 ticks (100 ms) for heavy — the closest the step can get to
 * 90 without going under, and erring long reads better.
 */
export const LIGHT_HITSTOP_TICKS = 4;
export const HEAVY_HITSTOP_TICKS = 6;
/** Damage numbers, HUD flash, camera shake, one spare. */
const MAX_LISTENERS = 4;

/**
 * mulberry32 over module state: one shared crit stream so the automated gate
 * can `setSeed(n)`, replay an identical fight and assert identical totals.
 * Math.random here would make every combat test flaky.
 */
let rngState = 0xa5f152c1;

export function setSeed(n: number): void {
  rngState = n >>> 0;
}

function rand(): number {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export interface DamageEvent {
  /** Scratch — copy fields, never retain (same rule as EventBus payloads). */
  packet: DamagePacket;
  target: Combatant;
  /** Post-mitigation amount actually dealt (≤ packet.amount on overkill). */
  applied: number;
  killed: boolean;
}

export interface DamageSystemOptions {
  hitstop: Hitstop;
  /** Receives 'combat:damage' with the same scratch event (map extended below). */
  bus: EventBus;
}

// EventBus.ts is integrator-owned; the typed emit needs the key, so the map is
// extended from here. The payload is the reused scratch DamageEvent.
declare module '../core/EventBus' {
  interface GameEventMap {
    'combat:damage': DamageEvent;
  }
}

/**
 * Owns §9's damage formula and the fan-out when a hit lands: apply to the
 * target, trigger hitstop, notify the pre-registered listeners, emit on the
 * bus. Allocation-free per hit — one scratch packet and one scratch event are
 * reused forever.
 */
export class DamageSystem implements System {
  readonly name = 'damage';

  private readonly hitstop: Hitstop;
  private readonly bus: EventBus;

  /** Fixed slab, filled once at boot — no push during combat, no closures per hit. */
  private readonly listeners: Array<((event: DamageEvent) => void) | undefined>;
  private listenerCount = 0;

  /** Scratch — every field is overwritten by each landed hit. */
  private readonly packet: DamagePacket = {
    amount: 0,
    sourceId: 0,
    crit: false,
    heavy: false,
    knockX: 0,
    knockZ: 0,
    hitX: 0,
    hitY: 0,
    hitZ: 0,
  };
  /** Created on the first landed hit (needs a real target), reused forever. */
  private event: DamageEvent | undefined;
  /** Re-entrancy tripwire: deal() from inside a listener would corrupt the scratch. */
  private dealing = false;

  constructor(options: DamageSystemOptions) {
    this.hitstop = options.hitstop;
    this.bus = options.bus;
    this.listeners = new Array<((event: DamageEvent) => void) | undefined>(MAX_LISTENERS).fill(
      undefined,
    );
  }

  /**
   * §9: final = (base + statScaling) × elementMultiplier × (1 − armor/(armor+300))
   * × critMult × reactionMult. Kept as an exact float — display rounding is the
   * presentation layer's job, and rounding here would break "armor 0 takes
   * base + scaling exactly". Hitstop and listener fan-out fire only when damage
   * actually applies: an i-framed no-sell must not freeze the game or spawn a
   * number. Returns the applied amount.
   */
  deal(
    target: Combatant,
    base: number,
    statScaling: number,
    armor: number,
    heavy: boolean,
    sourceId: number,
    knockX: number,
    knockZ: number,
    hitX: number,
    hitY: number,
    hitZ: number,
  ): number {
    if (!target.alive) return 0;
    if (this.dealing) {
      // Phase 4 reactions must queue their damage, not deal it synchronously.
      console.warn('DamageSystem: re-entrant deal() ignored (source', sourceId, ')');
      return 0;
    }
    this.dealing = true;
    try {
      // One roll per attempted hit keeps the seeded sequence replay-stable.
      const crit = rand() < CRIT_CHANCE;
      const mitigation = 1 - armor / (armor + ARMOR_SOFTCAP);
      let final = (base + statScaling) * ELEMENT_MULT * mitigation * REACTION_MULT;
      if (crit) final *= CRIT_MULT;

      const packet = this.packet;
      packet.amount = final;
      packet.sourceId = sourceId;
      packet.crit = crit;
      packet.heavy = heavy;
      packet.knockX = knockX;
      packet.knockZ = knockZ;
      packet.hitX = hitX;
      packet.hitY = hitY;
      packet.hitZ = hitZ;

      const applied = target.takeDamage(packet);
      if (applied <= 0) return 0;

      this.hitstop.trigger(heavy ? HEAVY_HITSTOP_TICKS : LIGHT_HITSTOP_TICKS);

      let event = this.event;
      if (event === undefined) {
        // The one allocation this system ever makes after boot.
        event = { packet, target, applied, killed: !target.alive };
        this.event = event;
      } else {
        event.target = target;
        event.applied = applied;
        event.killed = !target.alive;
      }

      const listeners = this.listeners;
      const n = this.listenerCount;
      for (let i = 0; i < n; i++) {
        const listener = listeners[i];
        if (listener === undefined) continue;
        try {
          listener(event);
        } catch (error) {
          // Same contract as EventBus: a throwing listener never eats the hit.
          console.error('DamageSystem: listener threw', error);
        }
      }
      this.bus.emit('combat:damage', event);

      return applied;
    } finally {
      this.dealing = false;
    }
  }

  /**
   * At most 4 listeners, registered once at boot. The event handed to them is
   * scratch: copy fields synchronously, never retain it or its packet.
   */
  onDamage(listener: (event: DamageEvent) => void): void {
    const listeners = this.listeners;
    for (let i = 0; i < this.listenerCount; i++) {
      if (listeners[i] === listener) {
        console.warn('DamageSystem: listener already registered');
        return;
      }
    }
    if (this.listenerCount >= MAX_LISTENERS) {
      console.warn('DamageSystem: listener cap reached, registration dropped');
      return;
    }
    listeners[this.listenerCount] = listener;
    this.listenerCount++;
  }

  /** Damage is dealt on demand by attacks; nothing advances with time. */
  update(): void {}

  /**
   * Listeners are boot-lifetime and the PRNG is only touched via setSeed(), so
   * a reset must not disturb either — replays stay reproducible across resets.
   */
  reset(): void {}
}
