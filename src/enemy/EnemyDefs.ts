import enemiesJson from '../data/enemies.json';

import { ELEMENTS } from '../skills/SkillTypes';
import type { ElementId } from '../skills/SkillTypes';
import type { EnemyDef as BaseEnemyDef } from './EnemyBase';

/**
 * Data-driven enemy store — §4.1's law extended to enemies (Phase 5 contract):
 * adding enemy type #13 is an enemies.json entry choosing an archetype, a
 * palette and stats, with ZERO TypeScript. The gate greps src/**\/*.ts for kind
 * strings exactly as it does for skill ids, so no kind may appear anywhere in
 * this file — not even in a comment.
 *
 * Validation mirrors SkillRegistry's loudness contract: every field of every
 * entry is type- and range-checked, unknown keys are rejected (they are almost
 * always a misspelled optional), attack params are required — and FORBIDDEN —
 * per attack kind, and every error names the enemy kind and the field. One
 * malformed entry fails the whole boot on purpose.
 *
 * Runs once at boot; allocation here is fine (§3 is per-frame). Validated defs
 * are deep-frozen so no system can mutate shared data at runtime.
 */

export class EnemyDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnemyDataError';
  }
}

export const ARCHETYPES = ['blob', 'quad', 'biped', 'sentinel', 'wraith'] as const;
export type ArchetypeId = (typeof ARCHETYPES)[number];

export const ATTACK_KINDS = ['lunge', 'ranged', 'charge', 'slam'] as const;
export type AttackKindId = (typeof ATTACK_KINDS)[number];

/**
 * §5's five regions, indexed 0..4 in world order: Verdant Hollow, Whisperwood,
 * Emberscar, Frostvale, The Hollow Spire. Kept as a local constant rather than
 * an import of BiomeTable's BIOME_COUNT because Phase 5 files compile in
 * parallel (contract): agent A's five-region table lands alongside this file,
 * and this registry must already accept tags for all five.
 */
export const REGION_COUNT = 5;

export interface EnemyPalette {
  readonly body: number;
  readonly accent: number;
}

interface AttackCommon {
  readonly damage: number;
  readonly telegraphSeconds: number;
  readonly recoverSeconds: number;
}

export interface LungeAttack extends AttackCommon {
  readonly kind: 'lunge';
}

export interface RangedAttack extends AttackCommon {
  readonly kind: 'ranged';
  /** Units per second toward the aim committed at telegraph start. */
  readonly projectileSpeed: number;
}

export interface ChargeAttack extends AttackCommon {
  readonly kind: 'charge';
  readonly chargeSpeed: number;
  readonly chargeRange: number;
}

export interface SlamAttack extends AttackCommon {
  readonly kind: 'slam';
  readonly slamRadius: number;
}

export type AttackDef = LungeAttack | RangedAttack | ChargeAttack | SlamAttack;

/**
 * The validated def. Extends EnemyBase's Phase 3 interface, so an ArchetypeEnemy
 * plugs into EnemyBase / AIBrain / EnemyManager without touching any of them:
 * telegraphSeconds and attackRecoverSeconds are copied up from `attack`, and
 * attackRadius (which the JSON schema deliberately omits — it is a consequence
 * of the attack, not a knob) is derived per attack kind at validation time.
 */
export interface EnemyDef extends BaseEnemyDef {
  readonly archetype: ArchetypeId;
  readonly palette: EnemyPalette;
  /** Uniform body scale, 0.6..2.2 (contract). */
  readonly scale: number;
  readonly element: ElementId | 'none';
  readonly resists: readonly ElementId[];
  readonly weakTo: readonly ElementId[];
  readonly attack: AttackDef;
  /** BiomeIds (0..4) where SpawnDirector may pick this kind. */
  readonly biomes: readonly number[];
  /** §9 spawn budget points. */
  readonly budgetCost: number;
  /** Per-def soul-orb chance, replacing Phase 4's flat 0.5 (contract). */
  readonly skillDropChance: number;
}

// --- validation helpers (SkillRegistry's shapes; private there, so restated) --

const FILE = 'enemies.json';
const KIND_PATTERN = /^[a-z][a-z0-9_]*$/;

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

/** Every message carries file, owner (enemy kind) and field — the §4.1 promise. */
function fail(owner: string, field: string, expected: string, got: unknown): never {
  throw new EnemyDataError(`${FILE}: ${owner}: field "${field}" ${expected} (got ${describe(got)})`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reqOneOf<T extends string>(
  owner: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value === 'string') {
    const list: readonly string[] = allowed;
    if (list.indexOf(value) >= 0) return value as T;
  }
  fail(owner, field, `must be one of ${allowed.join(' | ')}`, value);
}

function reqString(owner: string, field: string, value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  fail(owner, field, 'must be a non-empty string', value);
}

function reqNumber(
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
  fail(owner, field, `must be ${integer ? 'an integer' : 'a finite number'} in [${min}, ${max}]`, value);
}

/** Rejects keys outside `allowed` — an unknown key is almost always a typo'd field. */
function checkKeys(
  owner: string,
  prefix: string,
  obj: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.indexOf(key) >= 0) continue;
    const field = prefix.length > 0 ? `${prefix}.${key}` : key;
    fail(owner, field, `is not part of the schema here — check the spelling (allowed: ${allowed.join(', ')})`, obj[key]);
  }
}

function reqPalette(owner: string, value: unknown): EnemyPalette {
  if (!isRecord(value)) fail(owner, 'palette', 'must be an object { body, accent }', value);
  checkKeys(owner, 'palette', value, ['body', 'accent']);
  return Object.freeze({
    body: reqNumber(owner, 'palette.body', value['body'], 0, 0xffffff, true),
    accent: reqNumber(owner, 'palette.accent', value['accent'], 0, 0xffffff, true),
  });
}

function reqElementList(owner: string, field: string, value: unknown): readonly ElementId[] {
  if (!Array.isArray(value) || value.length > ELEMENTS.length) {
    fail(owner, field, `must be an array of at most ${ELEMENTS.length} element names`, value);
  }
  const arr: readonly unknown[] = value;
  const out: ElementId[] = [];
  for (let i = 0; i < arr.length; i++) {
    const element = reqOneOf(owner, `${field}[${i}]`, arr[i], ELEMENTS);
    if (out.indexOf(element) >= 0) fail(owner, `${field}[${i}]`, 'duplicates an earlier entry', element);
    out.push(element);
  }
  return Object.freeze(out);
}

function reqBiomes(owner: string, value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > REGION_COUNT) {
    fail(owner, 'biomes', `must be a non-empty array of at most ${REGION_COUNT} biome ids`, value);
  }
  const arr: readonly unknown[] = value;
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const id = reqNumber(owner, `biomes[${i}]`, arr[i], 0, REGION_COUNT - 1, true);
    if (out.indexOf(id) >= 0) fail(owner, `biomes[${i}]`, 'duplicates an earlier biome id', id);
    out.push(id);
  }
  return Object.freeze(out);
}

const ATTACK_COMMON_KEYS = ['kind', 'damage', 'telegraphSeconds', 'recoverSeconds'] as const;

function reqAttack(owner: string, value: unknown): AttackDef {
  if (!isRecord(value)) fail(owner, 'attack', 'must be an object with a "kind" field', value);
  const kind = reqOneOf(owner, 'attack.kind', value['kind'], ATTACK_KINDS);
  const damage = reqNumber(owner, 'attack.damage', value['damage'], 0, 500, false);
  /** §9: the wind-up must be readable on a phone — 0.5 s is a floor, not a style. */
  const telegraphSeconds = reqNumber(owner, 'attack.telegraphSeconds', value['telegraphSeconds'], 0.5, 5, false);
  const recoverSeconds = reqNumber(owner, 'attack.recoverSeconds', value['recoverSeconds'], 0, 10, false);

  switch (kind) {
    case 'lunge': {
      // checkKeys per kind: params of the OTHER kinds are rejected here, so a
      // projectileSpeed pasted onto a melee attacker fails loudly at boot.
      checkKeys(owner, 'attack', value, ATTACK_COMMON_KEYS);
      return Object.freeze({ kind, damage, telegraphSeconds, recoverSeconds });
    }
    case 'ranged': {
      checkKeys(owner, 'attack', value, [...ATTACK_COMMON_KEYS, 'projectileSpeed']);
      return Object.freeze({
        kind,
        damage,
        telegraphSeconds,
        recoverSeconds,
        projectileSpeed: reqNumber(owner, 'attack.projectileSpeed', value['projectileSpeed'], 1, 60, false),
      });
    }
    case 'charge': {
      checkKeys(owner, 'attack', value, [...ATTACK_COMMON_KEYS, 'chargeSpeed', 'chargeRange']);
      const chargeSpeed = reqNumber(owner, 'attack.chargeSpeed', value['chargeSpeed'], 2, 40, false);
      const chargeRange = reqNumber(owner, 'attack.chargeRange', value['chargeRange'], 2, 40, false);
      // The rush runs inside the brain's recover window (AIBrain owns the FSM,
      // untouched); a recover shorter than the rush would let Chase steering
      // fight the committed displacement mid-charge.
      const rushSeconds = chargeRange / chargeSpeed;
      if (recoverSeconds < rushSeconds) {
        fail(
          owner,
          'attack.recoverSeconds',
          `must be >= chargeRange / chargeSpeed (${rushSeconds.toFixed(2)}) so the rush completes inside the recover window`,
          recoverSeconds,
        );
      }
      return Object.freeze({ kind, damage, telegraphSeconds, recoverSeconds, chargeSpeed, chargeRange });
    }
    case 'slam': {
      checkKeys(owner, 'attack', value, [...ATTACK_COMMON_KEYS, 'slamRadius']);
      return Object.freeze({
        kind,
        damage,
        telegraphSeconds,
        recoverSeconds,
        slamRadius: reqNumber(owner, 'attack.slamRadius', value['slamRadius'], 0.5, 12, false),
      });
    }
  }
}

/**
 * attackRadius (AIBrain's "may start an attack inside this") is derived, not
 * authored: each kind implies its own engagement distance, and exposing it as a
 * JSON knob invited defs whose telegraph ring promised an area the attack could
 * not reach.
 */
function deriveAttackRadius(attack: AttackDef, scale: number, aggroRadius: number): number {
  switch (attack.kind) {
    case 'lunge':
      // Phase 3's blob engaged at 2.2 at scale 1; bigger bodies reach a little farther.
      return 1.7 + 0.5 * scale;
    case 'ranged': {
      // Stand off and shoot, but always from safely inside aggro so the FSM
      // cannot flap between Chase and Attack on the aggro boundary.
      const radius = aggroRadius * 0.85;
      return radius > 14 ? 14 : radius;
    }
    case 'charge':
      // Start the rush inside its own range, so a stationary target is caught.
      return attack.chargeRange * 0.85;
    case 'slam':
      // The target should already be inside the ring when the telegraph starts.
      return attack.slamRadius * 0.8;
  }
}

/** The complete schema surface; anything else in an entry is a rejected typo. */
const ENTRY_KEYS: readonly string[] = [
  'kind', 'archetype', 'palette', 'scale',
  'maxHp', 'armor', 'element', 'resists', 'weakTo',
  'contactDamage', 'moveSpeed', 'aggroRadius',
  'attack', 'biomes', 'budgetCost', 'skillDropChance', 'respawnSeconds', 'xp',
];

const ELEMENT_OR_NONE = [...ELEMENTS, 'none'] as const;

function validateEntry(entry: unknown, index: number, byKind: ReadonlyMap<string, EnemyDef>): EnemyDef {
  const slot = `enemies[${index}]`;
  if (!isRecord(entry)) {
    throw new EnemyDataError(`${FILE}: ${slot}: entry must be an enemy object (got ${describe(entry)})`);
  }

  // kind first, so every later message can name the enemy instead of an index.
  const kind = reqString(slot, 'kind', entry['kind']);
  if (!KIND_PATTERN.test(kind)) fail(slot, 'kind', 'must be lower_snake_case matching [a-z][a-z0-9_]*', kind);
  const owner = `enemy "${kind}"`;
  if (byKind.has(kind)) fail(owner, 'kind', 'duplicates an earlier enemy — kinds must be unique', kind);

  checkKeys(owner, '', entry, ENTRY_KEYS);

  const scale = reqNumber(owner, 'scale', entry['scale'], 0.6, 2.2, false);
  const aggroRadius = reqNumber(owner, 'aggroRadius', entry['aggroRadius'], 1, 60, false);
  const attack = reqAttack(owner, entry['attack']);
  const resists = reqElementList(owner, 'resists', entry['resists']);
  const weakTo = reqElementList(owner, 'weakTo', entry['weakTo']);
  for (let i = 0; i < weakTo.length; i++) {
    const element = weakTo[i];
    if (element !== undefined && resists.indexOf(element) >= 0) {
      fail(owner, `weakTo[${i}]`, 'also appears in "resists" — an element cannot be both (x0.5 and x1.5 would silently pick one)', element);
    }
  }

  const def: EnemyDef = {
    kind,
    archetype: reqOneOf(owner, 'archetype', entry['archetype'], ARCHETYPES),
    palette: reqPalette(owner, entry['palette']),
    scale,
    maxHp: reqNumber(owner, 'maxHp', entry['maxHp'], 1, 10000, false),
    armor: reqNumber(owner, 'armor', entry['armor'], 0, 300, false),
    element: reqOneOf(owner, 'element', entry['element'], ELEMENT_OR_NONE),
    resists,
    weakTo,
    contactDamage: reqNumber(owner, 'contactDamage', entry['contactDamage'], 0, 200, false),
    moveSpeed: reqNumber(owner, 'moveSpeed', entry['moveSpeed'], 0.1, 20, false),
    aggroRadius,
    attack,
    biomes: reqBiomes(owner, entry['biomes']),
    budgetCost: reqNumber(owner, 'budgetCost', entry['budgetCost'], 1, 20, true),
    skillDropChance: reqNumber(owner, 'skillDropChance', entry['skillDropChance'], 0, 1, false),
    respawnSeconds: reqNumber(owner, 'respawnSeconds', entry['respawnSeconds'], 1, 600, false),
    xp: reqNumber(owner, 'xp', entry['xp'], 0, 10000, true),
    // EnemyBase's Phase 3 surface, filled from the attack block so AIBrain and
    // EnemyManager keep working against defs from JSON with zero edits.
    attackRadius: deriveAttackRadius(attack, scale, aggroRadius),
    telegraphSeconds: attack.telegraphSeconds,
    attackRecoverSeconds: attack.recoverSeconds,
  };
  return Object.freeze(def);
}

export class EnemyDefs {
  private readonly byKind: Map<string, EnemyDef>;
  private readonly list: readonly EnemyDef[];

  /** `raw` is the imported JSON. Throws EnemyDataError on the first defect. */
  constructor(raw: unknown) {
    if (!Array.isArray(raw)) {
      throw new EnemyDataError(`${FILE}: root must be an array of enemy objects (got ${describe(raw)})`);
    }
    if (raw.length === 0) {
      throw new EnemyDataError(`${FILE}: no enemies defined — an empty bestiary is always a data bug`);
    }
    const byKind = new Map<string, EnemyDef>();
    const list: EnemyDef[] = [];
    for (let i = 0; i < raw.length; i++) {
      const entry: unknown = raw[i];
      const def = validateEntry(entry, i, byKind);
      byKind.set(def.kind, def);
      list.push(def);
    }
    this.byKind = byKind;
    this.list = Object.freeze(list);
  }

  get(kind: string): EnemyDef | undefined {
    return this.byKind.get(kind);
  }

  /** Definition order of enemies.json — stable, so debug listings are stable. */
  get all(): readonly EnemyDef[] {
    return this.list;
  }

  /** The bestiary total — the number a "12 enemy kinds" assertion reads. */
  get count(): number {
    return this.list.length;
  }
}

/** The bundled data, validated. main.ts calls this once at boot. */
export function createEnemyDefs(): EnemyDefs {
  return new EnemyDefs(enemiesJson);
}
