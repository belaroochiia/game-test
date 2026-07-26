/**
 * §8.1's skill schema as the compiler sees it (Phase 4 contract). Runtime,
 * Grimoire, orbs, VFX and UI all compile against this file, so it holds types
 * plus the closed vocabulary tables the validator checks against — nothing else.
 *
 * Each union is derived from one `as const` array instead of being written twice:
 * SkillRegistry's validator walks the array at boot and the type system reads the
 * same source, so widening a vocabulary is a single edit that both sides see.
 */

/**
 * §8.1 lists six elements; 'water' is the seventh, added by the Phase 4 contract
 * because §8.5's Wet reactions (Deep Freeze, Overload) are unreachable without a
 * Wet applier and Wet has no source among the six.
 */
export const ELEMENTS = ['fire', 'ice', 'wind', 'earth', 'water', 'light', 'dark'] as const;
export type ElementId = (typeof ELEMENTS)[number];

export const CATEGORIES = ['attack', 'mobility', 'support', 'passive'] as const;
export type SkillCategory = (typeof CATEGORIES)[number];

export const RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'] as const;
export type RarityId = (typeof RARITIES)[number];

/**
 * Same order as StatusEffects' numeric STATUS table (Burn 0 .. Silence 5), so
 * `STATUS_NAMES.indexOf(name)` is the numeric StatusId — no mapping table needed.
 */
export const STATUS_NAMES = ['burn', 'freeze', 'wet', 'shock', 'bleed', 'silence'] as const;
export type StatusName = (typeof STATUS_NAMES)[number];

/** §10's five stats; damage/heal scaling may reference any of them. */
export const SCALING_STATS = ['vitality', 'intellect', 'agility', 'focus', 'fortitude'] as const;
export type ScalingStat = (typeof SCALING_STATS)[number];

export const DELIVERY_TYPES = ['projectile', 'nova', 'self'] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

/**
 * §8.1's `vfx` was a bespoke effect name ("vfx_fire_lance"); the contract replaces
 * it with a style pack + colour + size so SkillVfx renders ANY skill from data.
 * This substitution is what makes new skills zero-code (§4.1).
 */
export const VFX_PACKS = ['bolt', 'burst', 'ring', 'glow'] as const;
export type VfxPackId = (typeof VFX_PACKS)[number];

/** `stat` is read off PlayerStats by name at cast time; `ratio` multiplies it. */
export interface ScalingDef {
  readonly stat: ScalingStat;
  readonly ratio: number;
}

/** Damage or heal magnitude: `base + stat × ratio` before mastery/element/reaction. */
export interface ScaledAmount {
  readonly base: number;
  readonly scaling: ScalingDef;
}

/** §8.1's status block; chance is rolled by StatusEffects' seeded PRNG. */
export interface StatusApplication {
  readonly id: StatusName;
  readonly chance: number;
  readonly duration: number;
  readonly stacks: number;
}

/**
 * Machine-readable replacement for §8.1's prose masteryBonus string ("damage +8%
 * per level..."). Percentages per mastery level above 1, applied by Grimoire.
 */
export interface MasteryBonus {
  readonly damagePctPerLevel: number;
  readonly cooldownPctPerLevel: number;
}

export interface ProjectileDelivery {
  readonly type: 'projectile';
  /** Units per second. */
  readonly speed: number;
  /** Enemies passed through before the projectile dies; 0 = stops on first hit. */
  readonly pierce: number;
  /** Seconds before despawn. */
  readonly lifetime: number;
  /** Hit-sphere radius. Optional in JSON (default 0.5); always present here. */
  readonly radius: number;
}

export interface NovaDelivery {
  readonly type: 'nova';
  /** Final ring radius, centred on the caster. */
  readonly radius: number;
  /** Seconds for the ring to reach full radius; 0 = instant. */
  readonly expandSeconds: number;
}

/** Buff/heal on the caster; nothing to parameterise. */
export interface SelfDelivery {
  readonly type: 'self';
}

export type DeliveryDef = ProjectileDelivery | NovaDelivery | SelfDelivery;

/** Uses at which mastery levels 1..5 are reached. Strictly ascending; [0] is 0. */
export type MasteryCurve = readonly [number, number, number, number, number];

/**
 * One validated skill. Constructed only by SkillRegistry — everything a system
 * reads off this object has already been type- and range-checked at boot, so
 * consumers never defend against bad data.
 */
export interface SkillDef {
  readonly id: string;
  readonly name: string;
  /** §8.1's kanji-dot display name, e.g. "焔槍 · Flame Lance". */
  readonly nameStyled: string;
  readonly element: ElementId;
  readonly category: SkillCategory;
  readonly rarity: RarityId;
  readonly tier: number;
  readonly manaCost: number;
  readonly cooldown: number;
  readonly castTime: number;
  readonly canMoveWhileCasting: boolean;
  /** Avatar pose name; PlayerAvatar maps or ignores it. */
  readonly animation: string;
  readonly delivery: DeliveryDef;
  /** base may be 0 for pure status/heal skills (§8.1 clarification). */
  readonly damage: ScaledAmount;
  readonly heal?: ScaledAmount;
  readonly status?: StatusApplication;
  /**
   * Hits stagger (DamagePacket.heavy). Not in §8.1, but the contract's earth
   * starter ("heavy=true") needs it in data. Optional in JSON, default false.
   */
  readonly heavy: boolean;
  readonly vfx: VfxPackId;
  /** 0xRRGGBB as a JSON int. */
  readonly vfxColor: number;
  /** Scale factor on the pack's base size. */
  readonly vfxSize: number;
  /** Stored but unused until Phase 7 (audio). */
  readonly sfx: string;
  readonly masteryCurve: MasteryCurve;
  readonly masteryBonus: MasteryBonus;
  readonly fusionTags: readonly string[];
  /** Soul-orb weighting; 0 = never drops (fusion-only results). */
  readonly dropWeight: number;
  readonly loreText: string;
}

/** One fusions.json entry, by skill id. Order-insensitive: (a,b) ≡ (b,a). */
export interface FusionRecipe {
  readonly a: string;
  readonly b: string;
  readonly result: string;
}
