import skillsJson from '../data/skills.json';

import {
  CATEGORIES,
  DELIVERY_TYPES,
  ELEMENTS,
  RARITIES,
  SCALING_STATS,
  STATUS_NAMES,
  VFX_PACKS,
} from './SkillTypes';
import type {
  DeliveryDef,
  FusionRecipe,
  MasteryBonus,
  MasteryCurve,
  ScaledAmount,
  SkillDef,
  StatusApplication,
} from './SkillTypes';

/**
 * Data-driven skill store (§4.1: adding a skill = a JSON entry, zero TS). That
 * only holds if bad JSON cannot limp past boot — a typo that surfaces at cast
 * time, or never, is worse than a hardcoded skill. So validation here is loud
 * and total: every field of every entry is type- and range-checked, unknown keys
 * are rejected (they are almost always a misspelled optional field), and every
 * error names the skill id and the field. One malformed entry fails the whole
 * boot on purpose.
 *
 * Numeric rails are sanity bounds an order of magnitude around plausible balance
 * (they catch a pasted 4500 cooldown or a -1 mana cost), not balance rules.
 *
 * All of this runs once at boot; allocation here is fine (§3 is per-frame).
 * Validated defs are deep-frozen so no system can mutate shared data at runtime.
 */

export class SkillDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillDataError';
  }
}

/** Compact value description for error messages; truncates long strings. */
function describe(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 40 ? value.slice(0, 40) + '…' : value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return 'array[' + value.length + ']';
  return typeof value;
}

/** Every message carries file, owner (skill/recipe) and field — the §4.1 promise. */
function fail(file: string, owner: string, field: string, expected: string, got: unknown): never {
  throw new SkillDataError(`${file}: ${owner}: field "${field}" ${expected} (got ${describe(got)})`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  if (typeof value !== 'string') return false;
  const list: readonly string[] = allowed;
  return list.indexOf(value) >= 0;
}

function reqOneOf<T extends string>(
  file: string,
  owner: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (isOneOf(value, allowed)) return value;
  fail(file, owner, field, `must be one of ${allowed.join(' | ')}`, value);
}

function reqString(file: string, owner: string, field: string, value: unknown, nonEmpty: boolean): string {
  if (typeof value === 'string' && (!nonEmpty || value.length > 0)) return value;
  fail(file, owner, field, nonEmpty ? 'must be a non-empty string' : 'must be a string', value);
}

function reqBool(file: string, owner: string, field: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  fail(file, owner, field, 'must be true or false', value);
}

function reqNumber(
  file: string,
  owner: string,
  field: string,
  value: unknown,
  min: number,
  max: number,
  integer: boolean,
): number {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (!integer || Number.isInteger(value))
  ) {
    return value;
  }
  fail(file, owner, field, `must be ${integer ? 'an integer' : 'a finite number'} in [${min}, ${max}]`, value);
}

/** Rejects keys outside `allowed` — an unknown key is almost always a typo'd optional. */
function checkKeys(
  file: string,
  owner: string,
  prefix: string,
  obj: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.indexOf(key) >= 0) continue;
    const field = prefix.length > 0 ? `${prefix}.${key}` : key;
    fail(file, owner, field, `is not part of the schema here — check the spelling (allowed: ${allowed.join(', ')})`, obj[key]);
  }
}

function reqScaled(file: string, owner: string, field: string, value: unknown): ScaledAmount {
  if (!isRecord(value)) fail(file, owner, field, 'must be an object { base, scaling }', value);
  checkKeys(file, owner, field, value, ['base', 'scaling']);
  const base = reqNumber(file, owner, `${field}.base`, value['base'], 0, 1000, false);
  const rawScaling = value['scaling'];
  if (!isRecord(rawScaling)) fail(file, owner, `${field}.scaling`, 'must be an object { stat, ratio }', rawScaling);
  checkKeys(file, owner, `${field}.scaling`, rawScaling, ['stat', 'ratio']);
  const stat = reqOneOf(file, owner, `${field}.scaling.stat`, rawScaling['stat'], SCALING_STATS);
  const ratio = reqNumber(file, owner, `${field}.scaling.ratio`, rawScaling['ratio'], 0, 10, false);
  return { base, scaling: { stat, ratio } };
}

function reqStatus(file: string, owner: string, value: unknown): StatusApplication {
  if (!isRecord(value)) fail(file, owner, 'status', 'must be an object { id, chance, duration, stacks }', value);
  checkKeys(file, owner, 'status', value, ['id', 'chance', 'duration', 'stacks']);
  return {
    id: reqOneOf(file, owner, 'status.id', value['id'], STATUS_NAMES),
    chance: reqNumber(file, owner, 'status.chance', value['chance'], 0, 1, false),
    duration: reqNumber(file, owner, 'status.duration', value['duration'], 0.1, 120, false),
    stacks: reqNumber(file, owner, 'status.stacks', value['stacks'], 1, 99, true),
  };
}

function reqDelivery(file: string, owner: string, value: unknown): DeliveryDef {
  if (!isRecord(value)) fail(file, owner, 'delivery', 'must be an object with a "type" field', value);
  const type = reqOneOf(file, owner, 'delivery.type', value['type'], DELIVERY_TYPES);
  switch (type) {
    case 'projectile': {
      checkKeys(file, owner, 'delivery', value, ['type', 'speed', 'pierce', 'lifetime', 'radius']);
      return {
        type: 'projectile',
        speed: reqNumber(file, owner, 'delivery.speed', value['speed'], 0.1, 200, false),
        pierce: reqNumber(file, owner, 'delivery.pierce', value['pierce'], 0, 99, true),
        lifetime: reqNumber(file, owner, 'delivery.lifetime', value['lifetime'], 0.05, 30, false),
        // Contract: hit-sphere radius defaults to 0.5 when omitted.
        radius:
          value['radius'] === undefined
            ? 0.5
            : reqNumber(file, owner, 'delivery.radius', value['radius'], 0.05, 10, false),
      };
    }
    case 'nova': {
      checkKeys(file, owner, 'delivery', value, ['type', 'radius', 'expandSeconds']);
      return {
        type: 'nova',
        radius: reqNumber(file, owner, 'delivery.radius', value['radius'], 0.1, 50, false),
        expandSeconds: reqNumber(file, owner, 'delivery.expandSeconds', value['expandSeconds'], 0, 10, false),
      };
    }
    case 'self': {
      checkKeys(file, owner, 'delivery', value, ['type']);
      return { type: 'self' };
    }
  }
}

function reqCurve(file: string, owner: string, value: unknown): MasteryCurve {
  if (!Array.isArray(value) || value.length !== 5) {
    fail(file, owner, 'masteryCurve', 'must be an array of exactly 5 integer use thresholds', value);
  }
  const arr: readonly unknown[] = value;
  const at = (i: number): number =>
    reqNumber(file, owner, `masteryCurve[${i}]`, arr[i], 0, 1_000_000, true);
  const curve: MasteryCurve = [at(0), at(1), at(2), at(3), at(4)];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1];
    const next = curve[i];
    if (prev !== undefined && next !== undefined && next <= prev) {
      fail(file, owner, `masteryCurve[${i}]`, 'must be strictly greater than the previous threshold (the curve is strictly ascending)', next);
    }
  }
  return curve;
}

function reqMasteryBonus(file: string, owner: string, value: unknown): MasteryBonus {
  if (!isRecord(value)) {
    fail(file, owner, 'masteryBonus', 'must be an object { damagePctPerLevel, cooldownPctPerLevel }', value);
  }
  checkKeys(file, owner, 'masteryBonus', value, ['damagePctPerLevel', 'cooldownPctPerLevel']);
  return {
    damagePctPerLevel: reqNumber(file, owner, 'masteryBonus.damagePctPerLevel', value['damagePctPerLevel'], 0, 100, false),
    // 4 levels above 1 stack multiplicatively toward the cooldown floor; > 20%/level
    // would let data push cooldowns negative-ish, which is never intended balance.
    cooldownPctPerLevel: reqNumber(file, owner, 'masteryBonus.cooldownPctPerLevel', value['cooldownPctPerLevel'], 0, 20, false),
  };
}

function reqTags(file: string, owner: string, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 12) {
    fail(file, owner, 'fusionTags', 'must be an array of at most 12 tag strings', value);
  }
  const arr: readonly unknown[] = value;
  const tags: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const tag = reqString(file, owner, `fusionTags[${i}]`, arr[i], true);
    if (tags.indexOf(tag) >= 0) fail(file, owner, `fusionTags[${i}]`, 'duplicates an earlier tag', tag);
    tags.push(tag);
  }
  return tags;
}

const FILE = 'skills.json';
const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
/** The complete schema surface; anything else in an entry is a rejected typo. */
const SKILL_KEYS: readonly string[] = [
  'id', 'name', 'nameStyled', 'element', 'category', 'rarity', 'tier',
  'manaCost', 'cooldown', 'castTime', 'canMoveWhileCasting', 'animation',
  'delivery', 'damage', 'heal', 'status', 'heavy',
  'vfx', 'vfxColor', 'vfxSize', 'sfx',
  'masteryCurve', 'masteryBonus', 'fusionTags', 'dropWeight', 'loreText',
  'shrineElement', 'fragments', 'bossReward',
];

/** §8.2.3: fragment skills always assemble from exactly 3 pieces — the schema
 * takes a count (not a boolean) so the rule reads at the data site, but any
 * value other than 3 is a defect, loudly. */
const FRAGMENT_PIECES = 3;

function reqFragments(file: string, owner: string, value: unknown): number {
  if (value === FRAGMENT_PIECES) return value;
  fail(file, owner, 'fragments', `must be exactly ${FRAGMENT_PIECES} (§8.2.3: fragment skills always assemble from ${FRAGMENT_PIECES} pieces) — omit the field for non-fragment skills`, value);
}

function reqBossReward(file: string, owner: string, value: unknown): boolean {
  if (value === true) return value;
  fail(file, owner, 'bossReward', 'must be true when present — omit the field entirely for non-boss skills', value);
}

function freezeDef(def: SkillDef): SkillDef {
  Object.freeze(def.delivery);
  Object.freeze(def.damage.scaling);
  Object.freeze(def.damage);
  if (def.heal !== undefined) {
    Object.freeze(def.heal.scaling);
    Object.freeze(def.heal);
  }
  if (def.status !== undefined) Object.freeze(def.status);
  Object.freeze(def.masteryBonus);
  Object.freeze(def.masteryCurve);
  Object.freeze(def.fusionTags);
  return Object.freeze(def);
}

function validateSkill(entry: unknown, index: number, byId: ReadonlyMap<string, SkillDef>): SkillDef {
  const slot = `skills[${index}]`;
  if (!isRecord(entry)) {
    throw new SkillDataError(`${FILE}: ${slot}: entry must be a skill object (got ${describe(entry)})`);
  }

  // id first, so every later message can name the skill instead of an index.
  const id = reqString(FILE, slot, 'id', entry['id'], true);
  if (!ID_PATTERN.test(id)) fail(FILE, slot, 'id', 'must be lower_snake_case matching [a-z][a-z0-9_]*', id);
  const owner = `skill "${id}"`;
  if (byId.has(id)) fail(FILE, owner, 'id', 'duplicates an earlier skill — ids must be unique', id);

  checkKeys(FILE, owner, '', entry, SKILL_KEYS);

  const def: SkillDef = {
    id,
    name: reqString(FILE, owner, 'name', entry['name'], true),
    nameStyled: reqString(FILE, owner, 'nameStyled', entry['nameStyled'], true),
    element: reqOneOf(FILE, owner, 'element', entry['element'], ELEMENTS),
    category: reqOneOf(FILE, owner, 'category', entry['category'], CATEGORIES),
    rarity: reqOneOf(FILE, owner, 'rarity', entry['rarity'], RARITIES),
    tier: reqNumber(FILE, owner, 'tier', entry['tier'], 1, 5, true),
    manaCost: reqNumber(FILE, owner, 'manaCost', entry['manaCost'], 0, 200, false),
    cooldown: reqNumber(FILE, owner, 'cooldown', entry['cooldown'], 0, 120, false),
    castTime: reqNumber(FILE, owner, 'castTime', entry['castTime'], 0, 5, false),
    canMoveWhileCasting: reqBool(FILE, owner, 'canMoveWhileCasting', entry['canMoveWhileCasting']),
    animation: reqString(FILE, owner, 'animation', entry['animation'], true),
    delivery: reqDelivery(FILE, owner, entry['delivery']),
    damage: reqScaled(FILE, owner, 'damage', entry['damage']),
    heal: entry['heal'] === undefined ? undefined : reqScaled(FILE, owner, 'heal', entry['heal']),
    status: entry['status'] === undefined ? undefined : reqStatus(FILE, owner, entry['status']),
    heavy: entry['heavy'] === undefined ? false : reqBool(FILE, owner, 'heavy', entry['heavy']),
    vfx: reqOneOf(FILE, owner, 'vfx', entry['vfx'], VFX_PACKS),
    vfxColor: reqNumber(FILE, owner, 'vfxColor', entry['vfxColor'], 0, 0xffffff, true),
    vfxSize: reqNumber(FILE, owner, 'vfxSize', entry['vfxSize'], 0.05, 10, false),
    sfx: reqString(FILE, owner, 'sfx', entry['sfx'], true),
    masteryCurve: reqCurve(FILE, owner, entry['masteryCurve']),
    masteryBonus: reqMasteryBonus(FILE, owner, entry['masteryBonus']),
    fusionTags: reqTags(FILE, owner, entry['fusionTags']),
    dropWeight: reqNumber(FILE, owner, 'dropWeight', entry['dropWeight'], 0, 1000, false),
    loreText: reqString(FILE, owner, 'loreText', entry['loreText'], false),
    // §8.2's scripted acquisition markers (Phase 5) — see SkillTypes for the rules.
    shrineElement:
      entry['shrineElement'] === undefined
        ? undefined
        : reqOneOf(FILE, owner, 'shrineElement', entry['shrineElement'], ELEMENTS),
    fragments: entry['fragments'] === undefined ? undefined : reqFragments(FILE, owner, entry['fragments']),
    bossReward: entry['bossReward'] === undefined ? undefined : reqBossReward(FILE, owner, entry['bossReward']),
  };
  // A scripted skill that also dropped from soul orbs would let RNG pre-empt
  // its scripted moment (§8.2's five paths are distinct on purpose) — refused.
  if (
    (def.shrineElement !== undefined || def.fragments !== undefined || def.bossReward === true) &&
    def.dropWeight !== 0
  ) {
    fail(FILE, owner, 'dropWeight', 'must be 0 on scripted-acquisition skills (shrineElement / fragments / bossReward): §8.2 shrine, fragment and boss skills never roll from soul orbs', def.dropWeight);
  }
  return freezeDef(def);
}

export class SkillRegistry {
  private readonly byId: Map<string, SkillDef>;
  private readonly list: readonly SkillDef[];

  /** `raw` is the imported JSON. Throws SkillDataError on the first defect. */
  constructor(raw: unknown) {
    if (!Array.isArray(raw)) {
      throw new SkillDataError(`${FILE}: root must be an array of skill objects (got ${describe(raw)})`);
    }
    if (raw.length === 0) {
      throw new SkillDataError(`${FILE}: no skills defined — an empty registry is always a data bug`);
    }
    const byId = new Map<string, SkillDef>();
    const list: SkillDef[] = [];
    // Cross-entry rules for §8.2's scripted markers: one shrine skill per
    // element, at most one boss Legendary in the whole book. Checked here
    // (not per entry) because both are claims about the file, not a field.
    const shrineOwner = new Map<string, string>();
    let bossOwner: string | null = null;
    for (let i = 0; i < raw.length; i++) {
      const entry: unknown = raw[i];
      const def = validateSkill(entry, i, byId);
      if (def.shrineElement !== undefined) {
        const prev = shrineOwner.get(def.shrineElement);
        if (prev !== undefined) {
          fail(FILE, `skill "${def.id}"`, 'shrineElement', `duplicates skill "${prev}" — §8.2.2 has exactly ONE shrine skill per element`, def.shrineElement);
        }
        shrineOwner.set(def.shrineElement, def.id);
      }
      if (def.bossReward === true) {
        if (bossOwner !== null) {
          fail(FILE, `skill "${def.id}"`, 'bossReward', `duplicates skill "${bossOwner}" — §8.2.4 has exactly ONE scripted boss Legendary`, true);
        }
        bossOwner = def.id;
      }
      byId.set(def.id, def);
      list.push(def);
    }
    this.byId = byId;
    this.list = Object.freeze(list);
  }

  get(id: string): SkillDef | undefined {
    return this.byId.get(id);
  }

  /** Definition order of skills.json — stable, so UI card numbering is stable. */
  get all(): readonly SkillDef[] {
    return this.list;
  }

  get count(): number {
    return this.list.length;
  }
}

/** The bundled data, validated. main.ts calls this once at boot. */
export function createSkillRegistry(): SkillRegistry {
  return new SkillRegistry(skillsJson);
}

const FUSIONS_FILE = 'fusions.json';

/**
 * Validates fusions.json against a built registry (recipes reference skills by
 * id, so they can only be checked after skills.json passed). Same loudness
 * contract: every error names the recipe and the field. Grimoire consumes the
 * returned frozen list.
 */
export function validateFusions(registry: SkillRegistry, raw: unknown): readonly FusionRecipe[] {
  if (!Array.isArray(raw)) {
    throw new SkillDataError(`${FUSIONS_FILE}: root must be an array of { a, b, result } recipes (got ${describe(raw)})`);
  }
  const out: FusionRecipe[] = [];
  const seenPairs = new Map<string, number>();
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    const slot = `recipe [${i}]`;
    if (!isRecord(entry)) {
      throw new SkillDataError(`${FUSIONS_FILE}: ${slot}: entry must be a { a, b, result } object (got ${describe(entry)})`);
    }
    checkKeys(FUSIONS_FILE, slot, '', entry, ['a', 'b', 'result']);
    const a = reqString(FUSIONS_FILE, slot, 'a', entry['a'], true);
    const b = reqString(FUSIONS_FILE, slot, 'b', entry['b'], true);
    const owner = `recipe [${i}] ("${a}" + "${b}")`;
    const result = reqString(FUSIONS_FILE, owner, 'result', entry['result'], true);

    if (registry.get(a) === undefined) fail(FUSIONS_FILE, owner, 'a', 'must reference a skill id defined in skills.json', a);
    if (registry.get(b) === undefined) fail(FUSIONS_FILE, owner, 'b', 'must reference a skill id defined in skills.json', b);
    if (registry.get(result) === undefined) fail(FUSIONS_FILE, owner, 'result', 'must reference a skill id defined in skills.json', result);
    if (a === b) fail(FUSIONS_FILE, owner, 'b', 'must differ from "a" — a fusion consumes two different skills', b);
    if (result === a || result === b) fail(FUSIONS_FILE, owner, 'result', 'must differ from both ingredients', result);

    // §8.3 recipes are order-insensitive, so (a,b) and (b,a) are the same pair.
    const pairKey = a < b ? `${a} ${b}` : `${b} ${a}`;
    const firstAt = seenPairs.get(pairKey);
    if (firstAt !== undefined) {
      fail(FUSIONS_FILE, owner, 'a', `repeats the pair of recipe [${firstAt}] — pairs are order-insensitive and must be unique`, a);
    }
    seenPairs.set(pairKey, i);

    out.push(Object.freeze({ a, b, result }));
  }
  return Object.freeze(out);
}
