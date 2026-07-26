import type { Combatant } from '../combat/CombatTypes';
import type { DamageSystem } from '../combat/DamageSystem';
import type { HitboxSystem, HitQuery } from '../combat/HitboxSystem';
import { STATUS } from '../combat/StatusEffects';
import type { StatusEffects, StatusId } from '../combat/StatusEffects';
import type { TargetLock } from '../combat/TargetLock';
import type { System } from '../core/Engine';
import type { EventBus } from '../core/EventBus';
import { ObjectPool } from '../core/ObjectPool';
import { EnemyBase } from '../enemy/EnemyBase';
import { ArchetypeEnemy } from '../enemy/ArchetypeEnemy';
import { PLAYER_STATE } from '../player/PlayerController';
import type { PlayerController } from '../player/PlayerController';
import type { PlayerStats } from '../player/PlayerStats';
import type { Grimoire } from './Grimoire';
import type { SkillRegistry } from './SkillRegistry';
import { STATUS_NAMES } from './SkillTypes';
import type { ElementId, SkillDef } from './SkillTypes';
import type { SkillVfx } from './vfx/SkillVfx';

/**
 * §8's skill runtime: cooldown, cast, mana and delivery, driven ENTIRELY by
 * validated SkillDefs (§4.1). Skill ids exist here only as opaque keys handed
 * to Grimoire — nothing branches on one; every varying behaviour (delivery
 * shape, status, heaviness, look) is a JSON field.
 *
 * Flow per §8/the Phase 4 contract:
 * - castSlot runs the refusal chain (empty → silenced → busy → cooldown →
 *   mana), then commits: mana spent, cooldown started (JSON × mastery),
 *   grimoire.registerUse (mastery counts CASTS, not hits — §8.4), and a caster
 *   glow the same frame so the button press always visibly does something.
 * - castTime > 0 goes through PlayerController.beginCast; delivery fires when
 *   the timer completes. A cast broken by a hit (player.casting drops early)
 *   fires nothing and refunds nothing — §8's cast commitment. Instants fire
 *   inside castSlot.
 * - Per hit: reaction check BEFORE the damage (StatusEffects consumes boards),
 *   then damage.deal with elementMult = resonance and reactionMult, then the
 *   JSON status roll (+ versatile chance bonus). Snapshots (mastery, scaling,
 *   resonance) are taken at fire time so a projectile in flight is one coherent
 *   shot.
 *
 * Pools: projectiles via core/ObjectPool (16, hard max — exhaustion skips the
 * spawn, §13), novas as a fixed slab of 6. Zero allocation at cast time and in
 * update().
 *
 * Not hitstop-gated (StatusEffects' stance): projectiles keep flying through a
 * 100 ms freeze — reads fine — and the pending-cast timer may lead the player's
 * frozen cast timer by the freeze length, which is imperceptible and keeps the
 * system free of a Hitstop dependency.
 */

export type CastRefusal = 'none' | 'cooldown' | 'mana' | 'silenced' | 'busy' | 'empty';

export interface SkillRuntimeOptions {
  registry: SkillRegistry;
  grimoire: Grimoire;
  stats: PlayerStats;
  player: PlayerController;
  /** The player's Combatant adapter (id 1) — silence checks and hit sourceId. */
  playerCombatant: Combatant;
  hitbox: HitboxSystem;
  damage: DamageSystem;
  status: StatusEffects;
  lock: TargetLock;
  vfx: SkillVfx;
  /** Accepted for wiring symmetry; the runtime emits nothing yet (UI polls it). */
  bus: EventBus;
}

const SLOT_COUNT = 4; // §8.4
const MAX_PROJECTILES = 16;
const MAX_NOVAS = 6; // mirrors the VFX ring pool
/** HitboxSystem's registry bound — a query can never return more. */
const MAX_HITS = 19;

/** Chest height on the caster: projectile muzzle and cast glow. */
const CAST_HEIGHT = 1.2;
/** Aim point on a locked target, fraction of its height (§6.6 "chest"). */
const TARGET_CHEST = 0.6;
/** Damage-number anchor fraction — matches the melee path in main.ts. */
const HIT_HEIGHT = 0.7;
/** Nova sphere centre above the caster's feet. */
const NOVA_HEIGHT = 0.6;
/** Visual-only floor so an instant nova's ring still sweeps (damage IS instant). */
const MIN_RING_SWEEP = 0.18;
/** Self-skill completion glow, relative to the JSON vfxSize. */
const SELF_FLASH_SCALE = 1.6;

/** Damage/status snapshot shared by every delivery, fixed at fire time. */
interface Shot {
  base: number;
  scaling: number;
  elementMult: number;
  element: ElementId;
  heavy: boolean;
  /** Numeric StatusId, or -1 for none. */
  statusId: number;
  statusChance: number;
  statusDuration: number;
  statusStacks: number;
  colorHex: number;
  sizeScale: number;
}

interface Projectile extends Shot {
  x: number;
  y: number;
  z: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  speed: number;
  radius: number;
  lifeLeft: number;
  pierceLeft: number;
  vfxHandle: number;
  /** Enemies already pierced — a fat slow projectile must not re-hit per tick. */
  readonly hitRefs: Array<Combatant | undefined>;
  hitCount: number;
}

interface Nova extends Shot {
  active: boolean;
  x: number;
  y: number;
  z: number;
  age: number;
  expandSeconds: number;
  radius: number;
  /** §8's per-nova stamp: each enemy is damaged once per nova, ever. */
  readonly hitRefs: Array<Combatant | undefined>;
  hitCount: number;
}

function makeShotDefaults(): Shot {
  return {
    base: 0,
    scaling: 0,
    elementMult: 1,
    element: 'fire',
    heavy: false,
    statusId: -1,
    statusChance: 0,
    statusDuration: 0,
    statusStacks: 1,
    colorHex: 0xffffff,
    sizeScale: 1,
  };
}

function makeProjectile(): Projectile {
  return {
    ...makeShotDefaults(),
    x: 0, y: 0, z: 0,
    prevX: 0, prevY: 0, prevZ: 0,
    dirX: 0, dirY: 0, dirZ: -1,
    speed: 0,
    radius: 0.5,
    lifeLeft: 0,
    pierceLeft: 0,
    vfxHandle: -1,
    hitRefs: new Array<Combatant | undefined>(MAX_HITS).fill(undefined),
    hitCount: 0,
  };
}

function makeNova(): Nova {
  return {
    ...makeShotDefaults(),
    active: false,
    x: 0, y: 0, z: 0,
    age: 0,
    expandSeconds: 0,
    radius: 0,
    hitRefs: new Array<Combatant | undefined>(MAX_HITS).fill(undefined),
    hitCount: 0,
  };
}

/** Idempotent (ObjectPool releaseAll may re-run it): drops retained enemy refs. */
function scrubProjectile(projectile: Projectile): void {
  const refs = projectile.hitRefs;
  for (let i = 0; i < projectile.hitCount; i++) refs[i] = undefined;
  projectile.hitCount = 0;
  projectile.vfxHandle = -1;
}

export class SkillRuntime implements System {
  readonly name = 'skills';

  private readonly registry: SkillRegistry;
  private readonly grimoire: Grimoire;
  private readonly stats: PlayerStats;
  private readonly player: PlayerController;
  private readonly playerCombatant: Combatant;
  private readonly hitbox: HitboxSystem;
  private readonly damage: DamageSystem;
  private readonly status: StatusEffects;
  private readonly lock: TargetLock;
  private readonly vfx: SkillVfx;

  private refusal: CastRefusal = 'none';

  /** Per-slot cooldown, keyed by the id it was started for: a re-equipped slot
   *  forgets the old skill's cooldown (fine while loadouts swap freely; Phase 6
   *  gates swapping at Rest Points, §8.4, which closes the swap-to-skip hole). */
  private readonly cdId: (string | null)[] = [null, null, null, null];
  private readonly cdLeft = new Float64Array(SLOT_COUNT);
  private readonly cdTotal = new Float64Array(SLOT_COUNT);

  /** The one in-flight cast (busy-checks make a second impossible). */
  private pendingDef: SkillDef | null = null;
  private pendingTimer = 0;

  private readonly projectilePool: ObjectPool<Projectile>;
  private readonly liveProjectiles: Array<Projectile | undefined>;
  private projectileCount = 0;

  private readonly novas: Nova[];

  /** Scratch query + collect slab; hits are COLLECTED first and dealt after the
   *  scan, because deal() can kill/despawn and HitboxSystem forbids registry
   *  churn mid-scan (StatusEffects' Overload pattern). */
  private readonly query: HitQuery;
  private readonly collected: Array<Combatant | undefined>;
  private collectedCount = 0;
  private filterRefs: Array<Combatant | undefined> | null = null;
  private filterCount = 0;

  constructor(options: SkillRuntimeOptions) {
    this.registry = options.registry;
    this.grimoire = options.grimoire;
    this.stats = options.stats;
    this.player = options.player;
    this.playerCombatant = options.playerCombatant;
    this.hitbox = options.hitbox;
    this.damage = options.damage;
    this.status = options.status;
    this.lock = options.lock;
    this.vfx = options.vfx;

    this.projectilePool = new ObjectPool<Projectile>(makeProjectile, {
      initial: MAX_PROJECTILES,
      max: MAX_PROJECTILES,
      label: 'skill-projectiles',
      onRelease: scrubProjectile,
    });
    this.liveProjectiles = new Array<Projectile | undefined>(MAX_PROJECTILES).fill(undefined);

    this.novas = new Array<Nova>(MAX_NOVAS);
    for (let i = 0; i < MAX_NOVAS; i++) this.novas[i] = makeNova();

    this.query = {
      x: 0, y: 0, z: 0,
      radius: 0,
      team: options.playerCombatant.team,
      sourceId: options.playerCombatant.id,
    };
    this.collected = new Array<Combatant | undefined>(MAX_HITS).fill(undefined);
  }

  // --- casting --------------------------------------------------------------

  /**
   * Cast the skill equipped in `slot` (0..3). Returns false with the reason in
   * `lastRefusal`. Refusal order is the contract's: empty → silenced → busy →
   * cooldown → mana.
   */
  castSlot(slot: number): boolean {
    if (slot < 0 || slot >= SLOT_COUNT) return this.refuse('empty');
    const id = this.grimoire.equipped(slot);
    if (id === null) return this.refuse('empty');
    const def = this.registry.get(id);
    if (def === undefined) {
      // An equipped id the registry rejects is a Grimoire bug, not a player state.
      console.warn('SkillRuntime: equipped skill missing from registry:', id);
      return this.refuse('empty');
    }

    if (this.status.has(this.playerCombatant, STATUS.Silence)) return this.refuse('silenced');

    const state = this.player.state;
    if (
      this.player.casting ||
      this.pendingDef !== null ||
      this.player.comboStage > 0 || // mid-swing IS busy; beginCast would refuse it anyway
      state === PLAYER_STATE.Dash ||
      state === PLAYER_STATE.Hit ||
      state === PLAYER_STATE.Down
    ) {
      return this.refuse('busy');
    }

    if ((this.cdLeft[slot] ?? 0) > 0 && this.cdId[slot] === id) return this.refuse('cooldown');

    if (!this.stats.spendMana(def.manaCost)) return this.refuse('mana');

    // Committed. beginCast can only fail on a state the busy check just cleared;
    // if it somehow does, this is a REFUSED cast and refunds — only a cast that
    // STARTED and was broken forfeits its mana (§8's cast commitment).
    if (def.castTime > 0 && !this.player.beginCast(def.castTime, def.canMoveWhileCasting)) {
      this.stats.mana = Math.min(this.stats.maxMana, this.stats.mana + def.manaCost);
      return this.refuse('busy');
    }

    const total = def.cooldown * this.grimoire.cooldownMultiplier(id);
    this.cdId[slot] = id;
    this.cdTotal[slot] = total;
    this.cdLeft[slot] = total;

    this.grimoire.registerUse(id); // §8.4: mastery counts casts, not hits

    // Always, same frame — even a 0.6 s cast shows the press did something.
    const p = this.player.position;
    this.vfx.castFlash(p.x, p.y + CAST_HEIGHT, p.z, def.vfxColor, def.vfxSize);

    if (def.castTime > 0) {
      this.pendingDef = def;
      this.pendingTimer = def.castTime;
    } else {
      this.fire(def);
    }
    this.refusal = 'none';
    return true;
  }

  get lastRefusal(): CastRefusal {
    return this.refusal;
  }

  /** Cooldown fraction remaining, 0..1, for the button's radial sweep. */
  cooldownFraction(slot: number): number {
    const left = this.cooldownSeconds(slot);
    if (left <= 0) return 0;
    const total = this.cdTotal[slot] ?? 0;
    return total > 0 ? left / total : 0;
  }

  cooldownSeconds(slot: number): number {
    if (slot < 0 || slot >= SLOT_COUNT) return 0;
    const left = this.cdLeft[slot] ?? 0;
    if (left <= 0) return 0;
    // A swapped-in skill starts clean; the stale timer belongs to the old id.
    if (this.cdId[slot] !== this.grimoire.equipped(slot)) return 0;
    return left;
  }

  /** Mastery alters damage and cooldown only (§8.4's bonus schema), never cost,
   *  so the JSON cost IS the post-mastery cost. */
  manaCost(slot: number): number {
    const def = this.skillAt(slot);
    return def !== null ? def.manaCost : 0;
  }

  skillAt(slot: number): SkillDef | null {
    if (slot < 0 || slot >= SLOT_COUNT) return null;
    const id = this.grimoire.equipped(slot);
    if (id === null) return null;
    return this.registry.get(id) ?? null;
  }

  // --- System ---------------------------------------------------------------

  update(dt: number): void {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const left = this.cdLeft[i] ?? 0;
      if (left > 0) this.cdLeft[i] = left > dt ? left - dt : 0;
    }

    const pending = this.pendingDef;
    if (pending !== null) {
      this.pendingTimer -= dt;
      if (this.pendingTimer <= 0) {
        // Completion outranks the cancel check: the tick where both timers hit
        // zero is a finished cast, whatever the system order made of `casting`.
        this.pendingDef = null;
        this.fire(pending);
      } else if (!this.player.casting) {
        // Broken by a hit (applyDamage zeroes the cast). No fire, no refund —
        // §8's cast commitment. Hitstop cannot fake this: a frozen player keeps
        // `casting` true.
        this.pendingDef = null;
      }
    }

    this.stepProjectiles(dt);
    for (let i = 0; i < MAX_NOVAS; i++) {
      const nova = this.novas[i];
      if (nova !== undefined && nova.active) this.stepNova(nova, dt);
    }
  }

  /** Interpolated projectile visuals — the sim stays on the fixed tick. */
  render(alpha: number): void {
    for (let i = 0; i < this.projectileCount; i++) {
      const projectile = this.liveProjectiles[i];
      if (projectile === undefined || projectile.vfxHandle < 0) continue;
      this.vfx.boltMove(
        projectile.vfxHandle,
        projectile.prevX + (projectile.x - projectile.prevX) * alpha,
        projectile.prevY + (projectile.y - projectile.prevY) * alpha,
        projectile.prevZ + (projectile.z - projectile.prevZ) * alpha,
      );
    }
  }

  reset(): void {
    this.refusal = 'none';
    this.pendingDef = null;
    this.pendingTimer = 0;
    for (let i = 0; i < SLOT_COUNT; i++) {
      this.cdId[i] = null;
      this.cdLeft[i] = 0;
      this.cdTotal[i] = 0;
    }
    for (let i = 0; i < this.projectileCount; i++) {
      const projectile = this.liveProjectiles[i];
      if (projectile !== undefined) this.vfx.boltEnd(projectile.vfxHandle);
      this.liveProjectiles[i] = undefined;
    }
    this.projectileCount = 0;
    this.projectilePool.releaseAll();
    for (let i = 0; i < MAX_NOVAS; i++) {
      const nova = this.novas[i];
      if (nova === undefined) continue;
      nova.active = false;
      for (let k = 0; k < nova.hitCount; k++) nova.hitRefs[k] = undefined;
      nova.hitCount = 0;
    }
  }

  // --- delivery -------------------------------------------------------------

  private refuse(reason: CastRefusal): boolean {
    this.refusal = reason;
    return false;
  }

  /**
   * Fires a completed cast. Everything variable is read off the def and the
   * CURRENT mastery/resonance state — the snapshot that then rides the shot.
   */
  private fire(def: SkillDef): void {
    const grimoire = this.grimoire;
    const stats = this.stats;
    const id = def.id;
    const delivery = def.delivery;
    const p = this.player.position;

    if (delivery.type === 'self') {
      const heal = def.heal;
      if (heal !== undefined) {
        // Mastery's damage bonus doubles as the potency bonus here: a support
        // skill whose mastery only trimmed cooldown would feel dead (§8.4's
        // "not just bigger numbers" spirit, minimally).
        const amount =
          (heal.base + stats[heal.scaling.stat] * heal.scaling.ratio) * grimoire.damageMultiplier(id);
        stats.heal(amount);
      }
      // Self skills with damage.base > 0 do not exist in data; a caster-centred
      // damage effect is a nova, so `self` deliberately only heals/buffs.
      this.vfx.castFlash(p.x, p.y + CAST_HEIGHT, p.z, def.vfxColor, def.vfxSize * SELF_FLASH_SCALE);
      return;
    }

    const shotStatus = def.status;
    const statusId = shotStatus === undefined ? -1 : STATUS_NAMES.indexOf(shotStatus.id);
    const statusChance =
      shotStatus === undefined ? 0 : Math.min(1, shotStatus.chance + grimoire.statusChanceBonus());
    const base = def.damage.base * grimoire.damageMultiplier(id);
    const scaling = stats[def.damage.scaling.stat] * def.damage.scaling.ratio;
    const elementMult = grimoire.elementBonus(def.element);

    if (delivery.type === 'projectile') {
      const projectile = this.projectilePool.acquire();
      if (projectile === undefined) return; // pool dry: skip the shot, never allocate (§13)

      const sx = p.x;
      const sy = p.y + CAST_HEIGHT;
      const sz = p.z;
      // §6.6 soft lock: aim at the locked target's chest, else camera-committed yaw.
      let dirX = Math.sin(this.player.yaw);
      let dirY = 0;
      let dirZ = -Math.cos(this.player.yaw);
      const target = this.lock.target;
      if (target !== null && target.alive) {
        const tp = target.position;
        const dx = tp.x - sx;
        const dy = tp.y + target.height * TARGET_CHEST - sy;
        const dz = tp.z - sz;
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (length > 1e-4) {
          dirX = dx / length;
          dirY = dy / length;
          dirZ = dz / length;
        }
      }

      projectile.x = sx;
      projectile.y = sy;
      projectile.z = sz;
      projectile.prevX = sx;
      projectile.prevY = sy;
      projectile.prevZ = sz;
      projectile.dirX = dirX;
      projectile.dirY = dirY;
      projectile.dirZ = dirZ;
      projectile.speed = delivery.speed;
      projectile.radius = delivery.radius;
      projectile.lifeLeft = delivery.lifetime;
      projectile.pierceLeft = delivery.pierce;
      this.fillShot(projectile, def, base, scaling, elementMult, statusId, statusChance);
      projectile.hitCount = 0;
      projectile.vfxHandle = this.vfx.boltStart(def.vfxColor, def.vfxSize, sx, sy, sz);
      this.liveProjectiles[this.projectileCount] = projectile;
      this.projectileCount++;
      return;
    }

    // Nova. Slab full means 6 concurrent expanding novas — cooldowns make that
    // unreachable; if it ever happens the newest is dropped, §13-style.
    let nova: Nova | undefined;
    for (let i = 0; i < MAX_NOVAS; i++) {
      const candidate = this.novas[i];
      if (candidate !== undefined && !candidate.active) {
        nova = candidate;
        break;
      }
    }
    if (nova === undefined) return;
    nova.active = true;
    nova.x = p.x;
    nova.y = p.y + NOVA_HEIGHT;
    nova.z = p.z;
    nova.age = 0;
    nova.expandSeconds = delivery.expandSeconds;
    nova.radius = delivery.radius;
    this.fillShot(nova, def, base, scaling, elementMult, statusId, statusChance);
    nova.hitCount = 0;

    // Pack picks the look; the ring always sweeps the TRUE radius so the visual
    // never lies about the area, floored so instant novas still animate.
    if (def.vfx === 'ring') {
      const sweep = delivery.expandSeconds > MIN_RING_SWEEP ? delivery.expandSeconds : MIN_RING_SWEEP;
      this.vfx.ringWave(p.x, p.y + 0.15, p.z, def.vfxColor, def.vfxSize, delivery.radius, sweep);
    } else {
      this.vfx.impact(p.x, p.y + NOVA_HEIGHT, p.z, def.vfxColor, def.vfxSize * (1 + delivery.radius * 0.2));
    }

    // dt 0 opens the sweep this tick: an instant nova (expand 0) resolves fully
    // right here; an expanding one touches only what is already on the caster.
    this.stepNova(nova, 0);
  }

  private fillShot(
    shot: Shot,
    def: SkillDef,
    base: number,
    scaling: number,
    elementMult: number,
    statusId: number,
    statusChance: number,
  ): void {
    shot.base = base;
    shot.scaling = scaling;
    shot.elementMult = elementMult;
    shot.element = def.element;
    shot.heavy = def.heavy;
    shot.statusId = statusId;
    shot.statusChance = statusChance;
    const status = def.status;
    shot.statusDuration = status !== undefined ? status.duration : 0;
    shot.statusStacks = status !== undefined ? status.stacks : 1;
    shot.colorHex = def.vfxColor;
    shot.sizeScale = def.vfxSize;
  }

  // --- stepping -------------------------------------------------------------

  private stepProjectiles(dt: number): void {
    let i = 0;
    while (i < this.projectileCount) {
      const projectile = this.liveProjectiles[i];
      if (projectile === undefined) {
        this.removeProjectileAt(i);
        continue;
      }
      projectile.prevX = projectile.x;
      projectile.prevY = projectile.y;
      projectile.prevZ = projectile.z;
      const step = projectile.speed * dt;
      projectile.x += projectile.dirX * step;
      projectile.y += projectile.dirY * step;
      projectile.z += projectile.dirZ * step;
      projectile.lifeLeft -= dt;

      this.collectHits(
        projectile.x, projectile.y, projectile.z, projectile.radius,
        projectile.hitRefs, projectile.hitCount,
      );
      let dead = projectile.lifeLeft <= 0;
      const hits = this.collectedCount;
      for (let k = 0; k < hits; k++) {
        const target = this.collected[k];
        this.collected[k] = undefined;
        if (target === undefined) continue;
        // Pierce exhausted mid-batch: the rest of this tick's overlaps are spared.
        if (dead && projectile.lifeLeft > 0) continue;
        if (projectile.hitCount < MAX_HITS) {
          projectile.hitRefs[projectile.hitCount] = target;
          projectile.hitCount++;
        }
        this.hitTarget(projectile, target);
        this.vfx.impact(
          target.position.x,
          target.position.y + target.height * HIT_HEIGHT,
          target.position.z,
          projectile.colorHex,
          projectile.sizeScale,
        );
        if (projectile.pierceLeft <= 0) dead = true; // 0 = stops on first hit (§8.1)
        else projectile.pierceLeft--;
      }
      this.collectedCount = 0;

      if (dead) {
        this.vfx.boltEnd(projectile.vfxHandle);
        this.projectilePool.release(projectile); // scrubProjectile drops the refs
        this.removeProjectileAt(i);
        continue;
      }
      i++;
    }
  }

  /** Swap-remove; order carries no meaning. */
  private removeProjectileAt(index: number): void {
    const last = this.projectileCount - 1;
    this.liveProjectiles[index] = this.liveProjectiles[last];
    this.liveProjectiles[last] = undefined;
    this.projectileCount = last;
  }

  private stepNova(nova: Nova, dt: number): void {
    nova.age += dt;
    const expand = nova.expandSeconds;
    const fraction = expand > 0 ? Math.min(nova.age / expand, 1) : 1;
    this.collectHits(nova.x, nova.y, nova.z, nova.radius * fraction, nova.hitRefs, nova.hitCount);
    const hits = this.collectedCount;
    for (let k = 0; k < hits; k++) {
      const target = this.collected[k];
      this.collected[k] = undefined;
      if (target === undefined) continue;
      if (nova.hitCount < MAX_HITS) {
        nova.hitRefs[nova.hitCount] = target; // the stamp: once per nova, ever
        nova.hitCount++;
      }
      this.hitTarget(nova, target);
      this.vfx.sparkle(
        target.position.x,
        target.position.y + target.height * HIT_HEIGHT,
        target.position.z,
        nova.colorHex,
        nova.sizeScale,
      );
    }
    this.collectedCount = 0;

    if (fraction >= 1) {
      nova.active = false;
      for (let k = 0; k < nova.hitCount; k++) nova.hitRefs[k] = undefined;
      nova.hitCount = 0;
    }
  }

  /**
   * §9's pipeline for one skill hit, in the contract's order: reaction check
   * (may consume statuses / flag heaviness), then damage.deal with element and
   * reaction multipliers, then the JSON status roll. Armor mirrors the melee
   * path (EnemyDef carries it; Combatant deliberately does not), halved while
   * Thermal Shock's break is live (§8.5).
   */
  private hitTarget(shot: Shot, target: Combatant): void {
    const status = this.status;
    const reactionMult = status.reactionFor(target, shot.element, false);
    const heavy = shot.heavy || status.lastReactionHeavy;
    let armor = target instanceof EnemyBase ? target.def.armor : 0;
    if (armor > 0 && status.armorBroken(target)) armor *= 0.5;
    // §9's elementMultiplier goes live in Phase 5: resonance × the target's
    // resist/weak table from enemies.json (×0.5 / ×1.5 / 1).
    let elementMult = shot.elementMult;
    if (target instanceof ArchetypeEnemy) {
      elementMult *= target.elementMultiplierFor(shot.element);
    }
    const tp = target.position;
    this.damage.deal(
      target,
      shot.base,
      shot.scaling,
      armor,
      heavy,
      this.playerCombatant.id,
      0, // skills carry no knockback in data yet; heavy already staggers (§9)
      0,
      tp.x,
      tp.y + target.height * HIT_HEIGHT,
      tp.z,
      elementMult,
      reactionMult,
    );
    if (shot.statusId >= 0) {
      status.apply(
        target,
        shot.statusId as StatusId,
        shot.statusChance,
        shot.statusDuration,
        shot.statusStacks,
        this.playerCombatant.id,
      );
    }
  }

  /**
   * Sphere query with the shot's already-hit filter. Targets are only COLLECTED
   * here; dealing happens after the scan (registry-churn rule). The filter
   * check lives in the callback so a fat projectile parked on an enemy costs
   * one ref-compare per tick, not a damage attempt.
   */
  private collectHits(
    x: number, y: number, z: number, radius: number,
    hitRefs: Array<Combatant | undefined>, hitCount: number,
  ): void {
    this.filterRefs = hitRefs;
    this.filterCount = hitCount;
    this.collectedCount = 0;
    const query = this.query;
    query.x = x;
    query.y = y;
    query.z = z;
    query.radius = radius;
    this.hitbox.overlapSphere(query, this.onOverlap);
    this.filterRefs = null;
  }

  private readonly onOverlap = (target: Combatant): void => {
    const refs = this.filterRefs;
    if (refs !== null) {
      for (let i = 0; i < this.filterCount; i++) {
        if (refs[i] === target) return;
      }
    }
    if (this.collectedCount >= MAX_HITS) return;
    this.collected[this.collectedCount] = target;
    this.collectedCount++;
  };
}
