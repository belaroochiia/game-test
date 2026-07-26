import fusionsJson from '../data/fusions.json';

import type { EventBus } from '../core/EventBus';
import { validateFusions } from './SkillRegistry';
import type { SkillRegistry } from './SkillRegistry';
import { ELEMENTS } from './SkillTypes';
import type { ElementId, FusionRecipe } from './SkillTypes';

/**
 * §8's book: what the player knows, what is equipped (4 active slots, §8.4),
 * how mastered each skill is (use-driven, §8.4), the loadout's elemental
 * resonance, and §8.3's consuming fusion.
 *
 * Frequency contract (§3): everything stateful here — learn / equip /
 * registerUse / fuse — happens at EVENT frequency (kills, casts, UI taps), so a
 * Map<string, MasteryRecord> is acceptable; it is never touched per tick. The
 * only calls that sit on the frame/hit path are elementBonus, statusChanceBonus
 * and the two mastery multipliers, and those are O(1) scalar reads off state
 * recomputed on equip change — never per query.
 *
 * No skill id appears in this file (§4.1): the starting loadout is injected by
 * the bootstrap via `startingLoadout`, fusion pairs come from fusions.json.
 */

export const ACTIVE_SLOTS = 4;
const MAX_MASTERY = 5;
/** §8.2.5: fusion ingredients must be mastered to at least this level. */
const FUSE_MASTERY = 3;
/** §8.4: 3+ equipped skills of one element → +15% damage in that element. */
const RESONANCE_MIN_SAME = 3;
const RESONANCE_ELEMENT_MULT = 1.15;
/** §8.4: 4 distinct equipped elements → +20% status effect chance. */
const VERSATILE_MIN_DISTINCT = 4;
const VERSATILE_STATUS_BONUS = 0.2;

export type LearnSource = 'orb' | 'fusion' | 'debug';

/**
 * Payload of 'grimoire:acquired'. The GameEventMap key is declared in
 * SoulOrbs.ts (the phase contract puts the augmentation there); the event is
 * EMITTED only by Grimoire.learn, so orb and fusion acquisitions cannot
 * double-fire. Reused scratch — copy fields, never retain (EventBus rule).
 */
export interface SkillAcquiredEvent {
  id: string;
  source: LearnSource;
}

export interface MasteryInfo {
  /** 0 = not known; a freshly learned skill is level 1 (curve[0] is 0 uses). */
  level: number;
  uses: number;
  /** Uses at which the next level lands; Infinity at level 5 (Awakened). */
  nextAt: number;
}

export type ResonanceKind = 'none' | 'element' | 'versatile';

export interface ResonanceInfo {
  kind: ResonanceKind;
  element: ElementId | null;
}

/**
 * canFuse verdicts, in check order. 'mastery' is §8.2.5's "mastery >= 3"
 * refusal; 'result-known' refuses burning ingredients for a skill already
 * owned — §8.3 is silent on re-fusing, and consuming two mastered skills for
 * nothing would be a trap, so it is refused here.
 */
export type FuseReason = 'ok' | 'same-skill' | 'not-known' | 'mastery' | 'no-recipe' | 'result-known';

export interface FuseCheck {
  ok: boolean;
  /** The recipe's result id whenever the pair HAS a recipe (even when not ok
   * yet) — the Fusion tab needs it for §8.3's blurred/named preview. */
  result: string | null;
  reason: FuseReason;
}

export interface GrimoireOptions {
  registry: SkillRegistry;
  bus: EventBus;
  /**
   * Bootstrap-owned starting known+equipped ids, filling slots 0..n-1 (≤ 4,
   * unique, all in skills.json — validated loudly at boot). Grimoire itself
   * hardcodes no skill id (§4.1).
   */
  startingLoadout: readonly string[];
  /** Raw recipes; defaults to the bundled src/data/fusions.json. */
  fusionsRaw?: unknown;
}

/** Two mutable ints per known skill; mutated in place, never re-created. */
interface MasteryRecord {
  uses: number;
  level: number;
}

export class Grimoire {
  /** Phase 4: free editing. Phase 6's Rest Points gate this (contract decision 2). */
  canEditLoadout = true;

  private readonly registry: SkillRegistry;
  private readonly bus: EventBus;
  private readonly recipes: readonly FusionRecipe[];
  private readonly startingLoadout: readonly string[];

  private readonly knownSet = new Set<string>();
  /** Event-frequency bookkeeping only (see header) — never in the tick path. */
  private readonly masteryMap = new Map<string, MasteryRecord>();
  private readonly slots: Array<string | null> = new Array<string | null>(ACTIVE_SLOTS).fill(null);

  /** Cached resonance, recomputed on equip change — not per query (§3). */
  private readonly resonanceInfo: ResonanceInfo = { kind: 'none', element: null };
  /** Reused counting slab for recomputeResonance, one slot per element. */
  private readonly elementCounts: number[] = new Array<number>(ELEMENTS.length).fill(0);

  /** Reused event payload — copy-don't-retain, like every bus payload. */
  private readonly acquiredEvent: SkillAcquiredEvent = { id: '', source: 'debug' };

  constructor(options: GrimoireOptions) {
    this.registry = options.registry;
    this.bus = options.bus;
    // Recipes are validated against the registry at boot — same loud-failure
    // philosophy as skills.json (§4.1: a typo'd id fails now, not at fuse time).
    this.recipes = validateFusions(options.registry, options.fusionsRaw ?? fusionsJson);

    const start = options.startingLoadout;
    if (start.length > ACTIVE_SLOTS) {
      throw new Error(`Grimoire: startingLoadout has ${start.length} ids — only ${ACTIVE_SLOTS} active slots exist (§8.4)`);
    }
    for (let i = 0; i < start.length; i++) {
      const id = start[i];
      if (id === undefined || this.registry.get(id) === undefined) {
        throw new Error(`Grimoire: startingLoadout[${i}] ("${String(id)}") is not a skill id in skills.json`);
      }
      if (start.indexOf(id) !== i) {
        throw new Error(`Grimoire: startingLoadout[${i}] ("${id}") is duplicated`);
      }
    }
    this.startingLoadout = Object.freeze(start.slice());

    this.applyStartingState();
  }

  // --- collection ----------------------------------------------------------

  isKnown(id: string): boolean {
    return this.knownSet.has(id);
  }

  /**
   * Adds a skill to the collection and emits 'grimoire:acquired' — the SKILL
   * ACQUIRED moment (§8.2) hangs off that event, so this is the ONLY place it
   * fires. Returns false (and stays silent) when already known or the id is
   * not in the registry.
   */
  learn(id: string, source: LearnSource): boolean {
    if (this.registry.get(id) === undefined) {
      console.warn('Grimoire: learn() of unknown skill id', id);
      return false;
    }
    if (this.knownSet.has(id)) return false;
    this.knownSet.add(id);
    this.masteryMap.set(id, { uses: 0, level: 1 });
    const event = this.acquiredEvent;
    event.id = id;
    event.source = source;
    this.bus.emit('grimoire:acquired', event);
    return true;
  }

  get knownCount(): number {
    return this.knownSet.size;
  }

  get totalCount(): number {
    return this.registry.count;
  }

  // --- loadout (§8.4: 4 active slots; passives are Phase 6) -----------------

  equipped(slot: number): string | null {
    return this.slots[slot] ?? null;
  }

  /**
   * Equips a known skill into a slot. A skill occupies at most ONE slot:
   * equipping it again moves it — duplicates would let a single skill fake
   * §8.4's 3-same-element resonance. False: locked loadout / bad slot /
   * unknown skill.
   */
  equip(slot: number, id: string): boolean {
    if (!this.canEditLoadout) return false;
    if (!Number.isInteger(slot) || slot < 0 || slot >= ACTIVE_SLOTS) return false;
    if (!this.knownSet.has(id)) return false;
    for (let s = 0; s < ACTIVE_SLOTS; s++) {
      if (s !== slot && this.slots[s] === id) this.slots[s] = null;
    }
    this.slots[slot] = id;
    this.recomputeResonance();
    return true;
  }

  /** Clears a slot. Same canEditLoadout gate as equip. */
  unequip(slot: number): boolean {
    if (!this.canEditLoadout) return false;
    if (!Number.isInteger(slot) || slot < 0 || slot >= ACTIVE_SLOTS) return false;
    if (this.slots[slot] == null) return false;
    this.slots[slot] = null;
    this.recomputeResonance();
    return true;
  }

  // --- mastery (§8.4: from USES against masteryCurve, not from XP) ----------

  /** SkillRuntime reports each successful cast here. Unknown ids are ignored. */
  registerUse(id: string): void {
    const record = this.masteryMap.get(id);
    if (record === undefined) return;
    const def = this.registry.get(id);
    if (def === undefined) return;
    record.uses++;
    // Levels come from the curve's thresholds and nothing else: level L is
    // reached the moment uses hits masteryCurve[L-1] (validated ascending).
    while (record.level < MAX_MASTERY) {
      const need = def.masteryCurve[record.level];
      if (need === undefined || record.uses < need) break;
      record.level++;
    }
  }

  /** Fresh object per call — UI/query frequency, outside the frame path (§3). */
  mastery(id: string): MasteryInfo {
    const record = this.masteryMap.get(id);
    if (record === undefined) return { level: 0, uses: 0, nextAt: 0 };
    const def = this.registry.get(id);
    let nextAt = Number.POSITIVE_INFINITY;
    if (def !== undefined && record.level < MAX_MASTERY) {
      nextAt = def.masteryCurve[record.level] ?? Number.POSITIVE_INFINITY;
    }
    return { level: record.level, uses: record.uses, nextAt };
  }

  /**
   * Mastery damage bonus. Per SkillTypes: percentages apply per level ABOVE 1 —
   * a freshly learned skill (level 1) casts at exactly its JSON numbers.
   */
  damageMultiplier(id: string): number {
    const record = this.masteryMap.get(id);
    if (record === undefined) return 1;
    const def = this.registry.get(id);
    if (def === undefined) return 1;
    return 1 + ((record.level - 1) * def.masteryBonus.damagePctPerLevel) / 100;
  }

  /** Mastery cooldown reduction; the validator's 20%/level cap keeps this > 0. */
  cooldownMultiplier(id: string): number {
    const record = this.masteryMap.get(id);
    if (record === undefined) return 1;
    const def = this.registry.get(id);
    if (def === undefined) return 1;
    return 1 - ((record.level - 1) * def.masteryBonus.cooldownPctPerLevel) / 100;
  }

  // --- resonance (§8.4) -----------------------------------------------------

  /** Reused object, refreshed on equip change — read fields, never retain or mutate. */
  resonance(): ResonanceInfo {
    return this.resonanceInfo;
  }

  /** ×1.15 for the resonant element, else ×1. O(1) — safe on the hit path. */
  elementBonus(element: ElementId): number {
    const info = this.resonanceInfo;
    return info.kind === 'element' && info.element === element ? RESONANCE_ELEMENT_MULT : 1;
  }

  /** +0.2 status chance when Versatile, else 0. O(1) — safe on the hit path. */
  statusChanceBonus(): number {
    return this.resonanceInfo.kind === 'versatile' ? VERSATILE_STATUS_BONUS : 0;
  }

  // --- fusion (§8.3) --------------------------------------------------------

  /** Fresh object per call — UI-tap frequency, outside the frame path (§3). */
  canFuse(a: string, b: string): FuseCheck {
    const recipe = this.findRecipe(a, b);
    const result = recipe === null ? null : recipe.result;
    if (a === b) return { ok: false, result, reason: 'same-skill' };
    if (!this.knownSet.has(a) || !this.knownSet.has(b)) {
      return { ok: false, result, reason: 'not-known' };
    }
    if (this.levelOf(a) < FUSE_MASTERY || this.levelOf(b) < FUSE_MASTERY) {
      return { ok: false, result, reason: 'mastery' };
    }
    if (recipe === null) return { ok: false, result: null, reason: 'no-recipe' };
    if (this.knownSet.has(recipe.result)) return { ok: false, result, reason: 'result-known' };
    return { ok: true, result, reason: 'ok' };
  }

  /**
   * §8.3 "Bahan habis": both ingredients are CONSUMED — collection entry, equip
   * slot and mastery all gone; that loss is what makes the grind meaningful
   * (§8.2.5). The result is learned via learn(), which fires the acquired
   * moment with source 'fusion'. Returns the result id, or null when refused
   * (ask canFuse for the reason).
   */
  fuse(a: string, b: string): string | null {
    const check = this.canFuse(a, b);
    if (!check.ok || check.result === null) return null;
    this.unlearn(a);
    this.unlearn(b);
    this.recomputeResonance();
    this.learn(check.result, 'fusion');
    return check.result;
  }

  // --- lifecycle ------------------------------------------------------------

  /** Back to the starting collection/loadout. canEditLoadout is wiring, not
   * run state, so it survives (the integrator owns it — contract decision 2). */
  reset(): void {
    this.applyStartingState();
  }

  // --- internals ------------------------------------------------------------

  private applyStartingState(): void {
    this.knownSet.clear();
    this.masteryMap.clear();
    for (let s = 0; s < ACTIVE_SLOTS; s++) this.slots[s] = null;
    const start = this.startingLoadout;
    for (let i = 0; i < start.length; i++) {
      const id = start[i];
      if (id === undefined) continue;
      // Silent learn: booting must not fire the ACQUIRED moment four times.
      this.knownSet.add(id);
      this.masteryMap.set(id, { uses: 0, level: 1 });
      this.slots[i] = id;
    }
    this.recomputeResonance();
  }

  private levelOf(id: string): number {
    const record = this.masteryMap.get(id);
    return record === undefined ? 0 : record.level;
  }

  /** §8.3 recipes are order-insensitive; the list is tiny (2 now, ~25 later). */
  private findRecipe(a: string, b: string): FusionRecipe | null {
    const recipes = this.recipes;
    for (let i = 0; i < recipes.length; i++) {
      const recipe = recipes[i];
      if (recipe === undefined) continue;
      if ((recipe.a === a && recipe.b === b) || (recipe.a === b && recipe.b === a)) return recipe;
    }
    return null;
  }

  private unlearn(id: string): void {
    this.knownSet.delete(id);
    this.masteryMap.delete(id);
    // Direct slot write, not unequip(): consumption must work even when the
    // loadout is locked at a Rest Point (Phase 6) — fusing is not an edit.
    for (let s = 0; s < ACTIVE_SLOTS; s++) {
      if (this.slots[s] === id) this.slots[s] = null;
    }
  }

  private recomputeResonance(): void {
    const counts = this.elementCounts;
    for (let i = 0; i < counts.length; i++) counts[i] = 0;
    let distinct = 0;
    let dominantIndex = -1;
    for (let s = 0; s < ACTIVE_SLOTS; s++) {
      const id = this.slots[s];
      if (id == null) continue;
      const def = this.registry.get(id);
      if (def === undefined) continue;
      const e = ELEMENTS.indexOf(def.element);
      const count = (counts[e] ?? 0) + 1;
      counts[e] = count;
      if (count === 1) distinct++;
      if (count >= RESONANCE_MIN_SAME) dominantIndex = e;
    }
    const info = this.resonanceInfo;
    if (dominantIndex >= 0) {
      info.kind = 'element';
      info.element = ELEMENTS[dominantIndex] ?? null;
    } else if (distinct >= VERSATILE_MIN_DISTINCT) {
      info.kind = 'versatile';
      info.element = null;
    } else {
      info.kind = 'none';
      info.element = null;
    }
  }
}
