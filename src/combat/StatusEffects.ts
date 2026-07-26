import type { System } from '../core/Engine';
import type { EventBus } from '../core/EventBus';
import type { Combatant } from './CombatTypes';
import type { DamageEvent, DamageSystem } from './DamageSystem';
import type { HitboxSystem, HitQuery } from './HitboxSystem';
import type { ElementId } from '../skills/SkillTypes';

/** Fixed board slots (§8.5). Indexes into every per-combatant tuple below. */
export const STATUS = { Burn: 0, Freeze: 1, Wet: 2, Shock: 3, Bleed: 4, Silence: 5 } as const;
export type StatusId = (typeof STATUS)[keyof typeof STATUS];
export const STATUS_COUNT = 6;

/** Live view of one board slot — read it, never mutate or retain it. */
export interface StatusState {
  remaining: number;
  stacks: number;
  potency: number;
}

/** §8.5: burn/bleed deliver potency × stacks through damage.deal every tick. */
const DOT_INTERVAL = 0.5;
/** Tick damage per stack, by StatusId. Zero = flag status, not a DoT. */
const TICK_DAMAGE: readonly [number, number, number, number, number, number] = [3, 0, 0, 0, 2, 0];

/** §8.5 Shatter: "damage bonus 200%" = ×3 on the shattering hit. */
const SHATTER_MULT = 3.0;
/** §8.5 Conflagration: "damage burn ×2 langsung" — remaining ticks, doubled, at once. */
const CONFLAGRATION_FACTOR = 2;
/** §8.5 Overload chain: 60% of the triggering hit, 3 nearest others within 6 u. */
const OVERLOAD_RATIO = 0.6;
const OVERLOAD_RADIUS = 6;
const OVERLOAD_CHAIN = 3;
/** §8.5 Thermal Shock: "break defense 5s" — callers pass armor×0.5 while armorBroken(). */
const ARMOR_BREAK_SECONDS = 5;
/** §8.5 Deep Freeze: freeze lands with ×2 duration. */
const DEEP_FREEZE_MULT = 2;

/** Player + §9's cap of 18 active enemies, one spare. */
const MAX_BOARDS = 20;
/** Overloads waiting for their triggering hit's damage event. */
const MAX_PENDING = 4;
/** Updates an armed overload may wait unfilled (hit i-framed away) before dropping. */
const PENDING_MAX_AGE = 2;
/** Matches HitboxSystem's registry bound; chain candidate slabs are sized to it. */
const MAX_CANDIDATES = 19;

/**
 * mulberry32 (same generator as DamageSystem's crit stream, SEPARATE state):
 * the gate seeds status rolls and crit rolls independently, so a status proc
 * never shifts a crit outcome and vice versa.
 */
let rngState = 0x51f15eed;

export function setStatusSeed(n: number): void {
  rngState = n >>> 0;
}

function rand(): number {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Reused scratch payload — same rule as every bus payload: copy, never retain. */
export interface ReactionEvent {
  name: string;
  x: number;
  y: number;
  z: number;
}

// EventBus.ts is integrator-owned; the typed emit needs the key, so the map is
// extended from here (same pattern as DamageSystem's 'combat:damage').
declare module '../core/EventBus' {
  interface GameEventMap {
    'combat:reaction': ReactionEvent;
  }
}

type SlotTuple = [StatusState, StatusState, StatusState, StatusState, StatusState, StatusState];
type SourceTuple = [number, number, number, number, number, number];

interface Board {
  combatant: Combatant | null;
  readonly slots: SlotTuple;
  /** Who applied each status — DoT ticks and reaction bursts credit them (§8.5). */
  readonly sourceIds: SourceTuple;
  /** Shared burn/bleed tick clock; wraps every DOT_INTERVAL. */
  dotClock: number;
  /** Thermal Shock window, seconds left. */
  armorBreak: number;
  /** ×2 while a Deep Freeze is pending; consumed by the next Freeze apply attempt. */
  freezeMult: number;
}

interface PendingOverload {
  /** null = free slot. */
  target: Combatant | null;
  sourceId: number;
  /** 60% of the triggering hit, filled by its damage event. */
  amount: number;
  ready: boolean;
  age: number;
}

function makeState(): StatusState {
  return { remaining: 0, stacks: 0, potency: 0 };
}

function makeBoard(): Board {
  return {
    combatant: null,
    slots: [makeState(), makeState(), makeState(), makeState(), makeState(), makeState()],
    sourceIds: [0, 0, 0, 0, 0, 0],
    dotClock: 0,
    armorBreak: 0,
    freezeMult: 1,
  };
}

function clearSlot(slot: StatusState): void {
  slot.remaining = 0;
  slot.stacks = 0;
  slot.potency = 0;
}

function clearBoardState(board: Board): void {
  const slots = board.slots;
  for (let i = 0; i < STATUS_COUNT; i++) clearSlot(slots[i as StatusId]);
  board.dotClock = 0;
  board.armorBreak = 0;
  board.freezeMult = 1;
}

export interface StatusEffectsOptions {
  damage: DamageSystem;
  /** Overload's chain query (§8.5) — the one reaction that needs world lookup. */
  hitbox: HitboxSystem;
  bus: EventBus;
}

/**
 * §8.5: per-combatant status boards and the element reactions over them.
 * Boards are fixed slots (no Maps anywhere near the hot path) preallocated at
 * boot; update() allocates nothing.
 *
 * Design notes, in order of likely surprise:
 * - DoT ticks route through damage.deal so numbers and the kill flow stay
 *   uniform, but with silent=true: a twice-a-second tick must not freeze the
 *   fight, so deal skips ONLY the hitstop (numbers still show; listeners can
 *   read event.silent to skip trauma/haptics too).
 * - Status-sourced damage (ticks, Conflagration burst, Overload chains) passes
 *   armor 0: Combatant deliberately carries no armor (§9 keeps mitigation with
 *   the caller), and flat status damage is the cheaper, more readable rule.
 * - ONE reaction per hit, first match wins; priority is documented on
 *   reactionFor. A consumed status is cleared before anything else runs, so it
 *   can never fuel a second reaction.
 * - Overload cannot deal inside the triggering hit (deal() is non-re-entrant)
 *   and the amount is unknown at reactionFor time, so reactionFor arms a slot;
 *   the very next non-silent damage event on that target — the triggering hit
 *   itself, since reactionFor is called immediately before its deal — supplies
 *   the amount, and update() fires the chain a tick later, which even reads
 *   right for jumping lightning.
 * - Deep Freeze cannot apply a freeze it does not own: reactionFor consumes Wet
 *   and flags the board; the NEXT Freeze apply attempt doubles its duration and
 *   clears the flag even if that attempt's chance roll fails — the reaction
 *   already happened and the Wet is already spent.
 * - Not hitstop-gated: status clocks drifting through a 100 ms freeze is
 *   imperceptible and keeps this system free of a Hitstop dependency.
 */
export class StatusEffects implements System {
  readonly name = 'status';

  private readonly damage: DamageSystem;
  private readonly hitbox: HitboxSystem;
  private readonly bus: EventBus;
  private readonly unsubscribe: () => void;

  /** Fixed slots; register binds a free one, unregister frees in place (no swap). */
  private readonly boards: Board[];
  private readonly pendings: PendingOverload[];

  /** Scratch for 'combat:reaction'. */
  private readonly reactionEvent: ReactionEvent = { name: '', x: 0, y: 0, z: 0 };
  /** Scratch for the Overload chain query. TEAM literals: 0 player, 1 enemy. */
  private readonly chainQuery: HitQuery = { x: 0, y: 0, z: 0, radius: 0, team: 0, sourceId: 0 };

  /** Chain candidate slabs, filled by the pre-bound overlap callback. */
  private readonly chainRefs: Array<Combatant | undefined>;
  private readonly chainDistSq: Float64Array;
  private chainCount = 0;
  private chainExclude: Combatant | null = null;
  private chainCx = 0;
  private chainCz = 0;

  /** Thermal Shock's "stagger, heavy=true on that hit" — read after reactionFor. */
  private reactionHeavy = false;

  constructor(options: StatusEffectsOptions) {
    this.damage = options.damage;
    this.hitbox = options.hitbox;
    this.bus = options.bus;

    this.boards = new Array<Board>(MAX_BOARDS);
    for (let i = 0; i < MAX_BOARDS; i++) this.boards[i] = makeBoard();
    this.pendings = new Array<PendingOverload>(MAX_PENDING);
    for (let i = 0; i < MAX_PENDING; i++) {
      this.pendings[i] = { target: null, sourceId: 0, amount: 0, ready: false, age: 0 };
    }
    this.chainRefs = new Array<Combatant | undefined>(MAX_CANDIDATES).fill(undefined);
    this.chainDistSq = new Float64Array(MAX_CANDIDATES);

    this.unsubscribe = this.bus.on('combat:damage', this.onDamageEvent);
  }

  /** Register a combatant's board. Player (id 1) and every enemy, at spawn time. */
  register(c: Combatant): void {
    const boards = this.boards;
    let free = -1;
    for (let i = 0; i < MAX_BOARDS; i++) {
      const board = boards[i];
      if (board === undefined) continue;
      if (board.combatant === c) {
        console.warn('StatusEffects: combatant already registered:', c.id);
        return;
      }
      if (free === -1 && board.combatant === null) free = i;
    }
    if (free === -1) {
      // The spawner owns the enemy cap (§9); reaching this line is a spawn bug.
      console.warn('StatusEffects: board registry full, dropping combatant:', c.id);
      return;
    }
    const board = boards[free];
    if (board === undefined) return;
    clearBoardState(board);
    board.combatant = c;
  }

  unregister(c: Combatant): void {
    const board = this.boardOf(c);
    if (board === null) return;
    clearBoardState(board);
    board.combatant = null;
  }

  /**
   * Apply from skill JSON: { id, chance, duration, stacks } (§8.1); `stacks` is
   * the stack CAP. EVERY call consumes exactly one PRNG roll, before any
   * early-out, so a replayed fight keeps the seeded stream aligned no matter
   * who died first (same policy as DamageSystem's crit roll).
   *
   * Stacking: a fresh status starts at 1 stack; a re-apply adds a stack up to
   * the cap and keeps the LONGER duration. Freeze never stacks — a re-apply
   * refreshes remaining to the new duration (§8.5's Deep Freeze doubles it via
   * the board flag). Returns true when the status landed.
   */
  apply(
    target: Combatant,
    id: StatusId,
    chance: number,
    duration: number,
    stacks: number,
    sourceId: number,
  ): boolean {
    const landed = rand() < chance;
    const board = this.boardOf(target);
    if (board === null) {
      console.warn('StatusEffects: apply to unregistered combatant:', target.id);
      return false;
    }
    let dur = duration;
    if (id === STATUS.Freeze && board.freezeMult !== 1) {
      dur *= board.freezeMult;
      board.freezeMult = 1;
    }
    if (!target.alive || !landed) return false;

    const slot = board.slots[id];
    if (slot.remaining > 0) {
      if (id === STATUS.Freeze) {
        slot.remaining = dur;
      } else {
        const cap = stacks >= 1 ? stacks : 1;
        if (slot.stacks < cap) slot.stacks++;
        if (dur > slot.remaining) slot.remaining = dur;
      }
    } else {
      slot.remaining = dur;
      slot.stacks = 1;
      slot.potency = TICK_DAMAGE[id];
    }
    board.sourceIds[id] = sourceId;
    return true;
  }

  /** Cheap: EnemyManager polls Freeze per enemy per tick, SkillRuntime polls Silence. */
  has(c: Combatant, id: StatusId): boolean {
    const board = this.boardOf(c);
    return board !== null && board.slots[id].remaining > 0;
  }

  /** Live slot view while active, else null. Read synchronously, never retain. */
  get(c: Combatant, id: StatusId): StatusState | null {
    const board = this.boardOf(c);
    if (board === null) return null;
    const slot = board.slots[id];
    return slot.remaining > 0 ? slot : null;
  }

  /** §8.5 Thermal Shock window — DamageSystem callers pass armor×0.5 while true. */
  armorBroken(c: Combatant): boolean {
    const board = this.boardOf(c);
    return board !== null && board.armorBreak > 0;
  }

  /**
   * True when the LAST reactionFor call demanded a staggering hit (Thermal
   * Shock's "heavy=true on that hit"). Read it right after reactionFor and OR
   * it into the hit's heavy flag; valid until the next reactionFor call.
   */
  get lastReactionHeavy(): boolean {
    return this.reactionHeavy;
  }

  /**
   * §8.5's reaction check. Call BEFORE dealing the hit's damage (SkillRuntime
   * for skills, the melee path with isPhysical=true) and pass the returned
   * multiplier into damage.deal's reactionMult. Consumes statuses exactly once
   * and emits 'combat:reaction' for the floating text.
   *
   * ONE reaction per hit, first match wins:
   *   1. Shatter      — Freeze + physical or earth → ×3, freeze consumed.
   *   2. Conflagration— Burn + wind → burn's remaining ticks ×2, dealt now.
   *   3. ThermalShock — Freeze + fire, or Burn + ice → consume it, armor break
   *                     5 s, lastReactionHeavy set. Wins over Deep Freeze on a
   *                     burning+wet target: the defense break is the rarer,
   *                     more dramatic combo, and the Wet stays for a later hit.
   *   4. Deep Freeze  — Wet + ice → wet consumed, next Freeze apply lands ×2.
   *   5. Overload     — Wet + dark → wet consumed, chain armed (fires next tick
   *                     at 60% of this hit to 3 nearest others within 6 u).
   */
  reactionFor(target: Combatant, incomingElement: ElementId, isPhysical: boolean): number {
    this.reactionHeavy = false;
    const board = this.boardOf(target);
    if (board === null) return 1;
    const slots = board.slots;
    const freeze = slots[STATUS.Freeze];
    const burn = slots[STATUS.Burn];
    const wet = slots[STATUS.Wet];

    if ((isPhysical || incomingElement === 'earth') && freeze.remaining > 0) {
      clearSlot(freeze);
      this.emitReaction('Shatter', target);
      return SHATTER_MULT;
    }
    if (isPhysical) return 1; // physical hits only shatter

    if (incomingElement === 'wind' && burn.remaining > 0) {
      // Remaining ticks the burn would still have delivered, paid out doubled.
      const burst =
        burn.potency * burn.stacks * Math.ceil(burn.remaining / DOT_INTERVAL) * CONFLAGRATION_FACTOR;
      const src = board.sourceIds[STATUS.Burn];
      clearSlot(burn); // consume BEFORE dealing — the burst may kill and re-enter has()
      this.emitReaction('Conflagration', target);
      const p = target.position;
      // Safe to deal here: reactionFor runs before the hit's own deal, not inside one.
      this.damage.deal(
        target, burst, 0, 0, false, src, 0, 0,
        p.x, p.y + target.height * 0.6, p.z,
        1, 1, false,
      );
      return 1;
    }
    if (incomingElement === 'fire' && freeze.remaining > 0) {
      clearSlot(freeze);
      return this.thermalShock(board, target);
    }
    if (incomingElement === 'ice') {
      if (burn.remaining > 0) {
        clearSlot(burn);
        return this.thermalShock(board, target);
      }
      if (wet.remaining > 0) {
        clearSlot(wet);
        board.freezeMult = DEEP_FREEZE_MULT;
        this.emitReaction('Deep Freeze', target);
        return 1;
      }
      return 1;
    }
    if (incomingElement === 'dark' && wet.remaining > 0) {
      clearSlot(wet);
      this.armOverload(target);
      this.emitReaction('Overload', target);
      return 1;
    }
    return 1;
  }

  update(dt: number): void {
    // Overload chains queued by reactionFor: fire once their hit reported in.
    const pendings = this.pendings;
    for (let i = 0; i < MAX_PENDING; i++) {
      const p = pendings[i];
      if (p === undefined || p.target === null) continue;
      if (p.ready) {
        this.executeOverload(p);
        this.freePending(p);
      } else if (++p.age > PENDING_MAX_AGE) {
        this.freePending(p); // triggering hit never applied (i-framed / dead)
      }
    }

    const boards = this.boards;
    for (let i = 0; i < MAX_BOARDS; i++) {
      const board = boards[i];
      if (board === undefined) continue;
      const c = board.combatant;
      if (c === null) continue;
      if (!c.alive) {
        // Statuses do not survive death; a respawned enemy starts clean.
        clearBoardState(board);
        continue;
      }
      if (board.armorBreak > 0) {
        board.armorBreak -= dt;
        if (board.armorBreak < 0) board.armorBreak = 0;
      }
      board.dotClock += dt;
      // Epsilon: 30 accumulated dt's land a float hair under 0.5, which would
      // slip every tick one step late and drop the FINAL tick of any duration
      // that is a multiple of the interval (most JSON durations are).
      while (board.dotClock >= DOT_INTERVAL - 1e-9) {
        board.dotClock -= DOT_INTERVAL;
        this.tickDot(board, c, STATUS.Burn);
        this.tickDot(board, c, STATUS.Bleed);
      }
      // Expiry AFTER ticking: a status still live at the tick delivers it.
      const slots = board.slots;
      for (let s = 0; s < STATUS_COUNT; s++) {
        const slot = slots[s as StatusId];
        if (slot.remaining <= 0) continue;
        slot.remaining -= dt;
        if (slot.remaining <= 0) clearSlot(slot);
      }
    }
  }

  /**
   * Clears every board's state and the pending chains, but keeps registrations
   * (combatant lifetime is register-at-spawn / unregister-at-despawn — same
   * rationale as HitboxSystem.reset) and never touches the PRNG (same rationale
   * as DamageSystem: replays stay reproducible across resets).
   */
  reset(): void {
    const boards = this.boards;
    for (let i = 0; i < MAX_BOARDS; i++) {
      const board = boards[i];
      if (board !== undefined) clearBoardState(board);
    }
    const pendings = this.pendings;
    for (let i = 0; i < MAX_PENDING; i++) {
      const p = pendings[i];
      if (p !== undefined) this.freePending(p);
    }
  }

  dispose(): void {
    this.unsubscribe();
  }

  // --- internals -----------------------------------------------------------

  private boardOf(c: Combatant): Board | null {
    const boards = this.boards;
    for (let i = 0; i < MAX_BOARDS; i++) {
      const board = boards[i];
      if (board !== undefined && board.combatant === c) return board;
    }
    return null;
  }

  private tickDot(board: Board, c: Combatant, id: StatusId): void {
    const slot = board.slots[id];
    if (slot.remaining <= 0) return;
    const amount = slot.potency * slot.stacks;
    if (amount <= 0) return;
    const p = c.position;
    // silent=true: number and kill flow yes, hitstop no (§8.5 DoT contract).
    this.damage.deal(
      c, amount, 0, 0, false, board.sourceIds[id], 0, 0,
      p.x, p.y + c.height * 0.6, p.z,
      1, 1, true,
    );
  }

  private thermalShock(board: Board, target: Combatant): number {
    board.armorBreak = ARMOR_BREAK_SECONDS;
    this.reactionHeavy = true; // §8.5 "stagger" — caller flags this hit heavy
    this.emitReaction('Thermal Shock', target);
    return 1;
  }

  private emitReaction(name: string, target: Combatant): void {
    const e = this.reactionEvent;
    e.name = name;
    const p = target.position;
    e.x = p.x;
    e.y = p.y + target.height * 0.8;
    e.z = p.z;
    this.bus.emit('combat:reaction', e);
  }

  private armOverload(target: Combatant): void {
    const pendings = this.pendings;
    for (let i = 0; i < MAX_PENDING; i++) {
      const p = pendings[i];
      if (p === undefined || p.target !== null) continue;
      p.target = target;
      p.sourceId = 0;
      p.amount = 0;
      p.ready = false;
      p.age = 0;
      return;
    }
    console.warn('StatusEffects: overload queue full, chain dropped');
  }

  private freePending(p: PendingOverload): void {
    p.target = null;
    p.sourceId = 0;
    p.amount = 0;
    p.ready = false;
    p.age = 0;
  }

  /** Fills an armed overload from its triggering hit. DoT ticks (silent) never qualify. */
  private readonly onDamageEvent = (event: DamageEvent): void => {
    if (event.silent) return;
    const pendings = this.pendings;
    for (let i = 0; i < MAX_PENDING; i++) {
      const p = pendings[i];
      if (p === undefined || p.target !== event.target || p.ready) continue;
      p.amount = event.applied * OVERLOAD_RATIO;
      p.sourceId = event.packet.sourceId;
      p.ready = true;
      return;
    }
  };

  private readonly onChainCandidate = (t: Combatant): void => {
    if (t === this.chainExclude) return;
    const n = this.chainCount;
    if (n >= MAX_CANDIDATES) return;
    const dx = t.position.x - this.chainCx;
    const dz = t.position.z - this.chainCz;
    this.chainRefs[n] = t;
    this.chainDistSq[n] = dx * dx + dz * dz;
    this.chainCount = n + 1;
  };

  private executeOverload(p: PendingOverload): void {
    const origin = p.target;
    if (origin === null) return;
    // Collect first, deal after: deal can kill and despawn, and HitboxSystem
    // forbids registry churn from inside its scan.
    this.chainExclude = origin;
    this.chainCount = 0;
    const op = origin.position;
    this.chainCx = op.x;
    this.chainCz = op.z;
    const q = this.chainQuery;
    q.x = op.x;
    q.y = op.y + origin.height * 0.5;
    q.z = op.z;
    q.radius = OVERLOAD_RADIUS;
    // overlapSphere hits the OTHER team, so pose as the origin's opponent to
    // sweep the origin's own team-mates (TEAM: 0 player / 1 enemy).
    q.team = origin.team === 1 ? 0 : 1;
    q.sourceId = p.sourceId;
    this.hitbox.overlapSphere(q, this.onChainCandidate);

    const n = this.chainCount;
    const chains = n < OVERLOAD_CHAIN ? n : OVERLOAD_CHAIN;
    for (let k = 0; k < chains; k++) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = this.chainDistSq[i];
        if (d !== undefined && d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best === -1) break;
      this.chainDistSq[best] = Infinity;
      const target = this.chainRefs[best];
      if (target === undefined || !target.alive) continue;
      const tp = target.position;
      // Not silent: chain hits are real hits — numbers and (light) hitstop.
      this.damage.deal(
        target, p.amount, 0, 0, false, p.sourceId, 0, 0,
        tp.x, tp.y + target.height * 0.6, tp.z,
        1, 1, false,
      );
    }
    // Drop the refs — boards may outlive despawned combatants otherwise.
    for (let i = 0; i < n; i++) this.chainRefs[i] = undefined;
    this.chainExclude = null;
    this.chainCount = 0;
  }
}
