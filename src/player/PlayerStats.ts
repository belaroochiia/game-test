import type { System } from '../core/Engine';

/**
 * §10's five stats plus the pools derived from them. Phase 1 needs this only so
 * the HUD has real numbers and the skill buttons have a real no-mana state; the
 * level-up and respec flow is Phase 6.
 */

export interface PlayerStatsOptions {
  level?: number;
}

/** Derivation constants, kept in one place so Phase 6 balancing has a single knob set. */
const BASE_HP = 120;
const HP_PER_VITALITY = 14;
const BASE_MANA = 80;
const MANA_PER_INTELLECT = 9;
/** Mana per second at focus 10, scaling linearly. Deliberately slow: mana should bite. */
const MANA_REGEN_BASE = 1.8;
const MANA_REGEN_PER_FOCUS = 0.22;

export class PlayerStats implements System {
  readonly name = 'stats';

  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  level: number;

  vitality: number;
  intellect: number;
  agility: number;
  focus: number;
  fortitude: number;

  constructor(options?: PlayerStatsOptions) {
    this.level = options?.level ?? 1;

    // Flat starting spread; §10's 3-points-per-level allocation arrives in Phase 6.
    this.vitality = 10;
    this.intellect = 10;
    this.agility = 10;
    this.focus = 10;
    this.fortitude = 10;

    this.maxHp = BASE_HP + this.vitality * HP_PER_VITALITY;
    this.maxMana = BASE_MANA + this.intellect * MANA_PER_INTELLECT;
    this.hp = this.maxHp;
    this.mana = this.maxMana;
  }

  get manaRegenPerSecond(): number {
    return MANA_REGEN_BASE + this.focus * MANA_REGEN_PER_FOCUS;
  }

  /** False when there is not enough mana — callers must not spend partially. */
  spendMana(amount: number): boolean {
    if (amount <= 0) return true;
    if (this.mana < amount) return false;
    this.mana -= amount;
    return true;
  }

  damage(amount: number): void {
    if (amount <= 0) return;
    this.hp -= amount;
    if (this.hp < 0) this.hp = 0;
  }

  heal(amount: number): void {
    if (amount <= 0) return;
    this.hp += amount;
    if (this.hp > this.maxHp) this.hp = this.maxHp;
  }

  update(dt: number): void {
    if (this.mana >= this.maxMana) return;
    this.mana += this.manaRegenPerSecond * dt;
    if (this.mana > this.maxMana) this.mana = this.maxMana;
  }

  reset(): void {
    this.maxHp = BASE_HP + this.vitality * HP_PER_VITALITY;
    this.maxMana = BASE_MANA + this.intellect * MANA_PER_INTELLECT;
    this.hp = this.maxHp;
    this.mana = this.maxMana;
  }

  get hpFraction(): number {
    return this.maxHp > 0 ? this.hp / this.maxHp : 0;
  }

  get manaFraction(): number {
    return this.maxMana > 0 ? this.mana / this.maxMana : 0;
  }
}
