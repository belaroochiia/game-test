import type { System } from '../core/Engine';
import type { InputState } from '../player/InputState';
import type { PlayerController } from '../player/PlayerController';
import type { PlayerStats } from '../player/PlayerStats';

/**
 * §6 in full. That section opens by warning that touch controls are what fails
 * most often in mobile games, and it is right — so the rules there are treated as
 * requirements, not suggestions:
 *
 * - the stick origin appears where the thumb lands, not at a fixed spot
 * - every pointer is tracked by `pointerId`, never `touches[0]`, so walking +
 *   camera + casting work at the same time
 * - `pointercancel` is handled, because Android fires it constantly and a missed
 *   cancel leaves the player walking forever
 */

export interface TouchControlsOptions {
  mount: HTMLElement;
  input: InputState;
  stats: PlayerStats;
  player: PlayerController;
  onSkill?: (slot: number) => void;
}

const DEAD_ZONE_PX = 8;
const MAX_RADIUS_PX = 55;

const SKILL_SLOTS = 4;
/** Pre-runtime fallback icons; replaced by element glyphs once skillsRef is wired. */
const SKILL_ICONS = ['⚡', '❄', '🔥', '🌀'];
/** Generic per-ELEMENT glyphs — data-driven safe, §4.1: no skill ids in code. */
const ELEMENT_ICONS: Record<string, string> = {
  fire: '🔥',
  ice: '❄',
  wind: '🌀',
  earth: '🪨',
  water: '💧',
  light: '✨',
  dark: '⚡',
};
/** Placeholder costs/cooldowns, used only until the bootstrap wires skillsRef. */
const SKILL_PLACEHOLDER_COST = [14, 18, 22, 20];
const SKILL_PLACEHOLDER_COOLDOWN = [1.5, 3, 4.5, 6];

/** What TouchControls needs from SkillRuntime; wired by the bootstrap (Phase 4). */
export interface SkillButtonSource {
  cooldownFraction(slot: number): number;
  cooldownSeconds(slot: number): number;
  manaCost(slot: number): number;
  skillAt(slot: number): { element: string } | null;
}

/** What TouchControls needs from SoulOrbs; wired by the bootstrap (Phase 4). */
export interface AbsorbSource {
  readonly nearbyOrb: boolean;
  setAbsorbing(active: boolean): void;
  readonly absorbProgress: number;
}

const DASH_COOLDOWN = 1.2;

/** Max simultaneous pointers we track. Pre-allocated: no allocation per touch. */
const MAX_POINTERS = 10;

const ROLE_FREE = 0;
const ROLE_STICK = 1;
const ROLE_LOOK = 2;
const ROLE_BUTTON = 3;

const STATE_IDLE = 0;
const STATE_PRESSED = 1;
const STATE_COOLDOWN = 2;
const STATE_NOMANA = 3;

interface PointerSlot {
  id: number;
  role: number;
  originX: number;
  originY: number;
  lastX: number;
  lastY: number;
  button: number;
}

interface ButtonView {
  el: HTMLButtonElement;
  cd: HTMLElement;
  cdText: Text;
  /** -1 for attack, -2 for dash, 0..3 for skills. */
  slot: number;
  visualState: number;
  cooldownLeft: number;
  cooldownTotal: number;
  pressedBy: number;
  lastCdBucket: number;
}

function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export class TouchControls implements System {
  readonly name = 'touch';

  private readonly input: InputState;
  private readonly stats: PlayerStats;
  private readonly player: PlayerController;
  private readonly onSkill: ((slot: number) => void) | undefined;

  private readonly root: HTMLDivElement;
  private readonly stickZone: HTMLDivElement;
  private readonly lookZone: HTMLDivElement;
  private readonly stick: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly buttons: ButtonView[] = [];

  private readonly pointers: PointerSlot[] = [];
  private stickPointer = -1;
  private stickWasActive = false;
  private vibrateSupported = false;

  private sensitivityValue = 0.005;
  private invertYValue = false;

  /** Phase 4 wiring; null until the bootstrap sets them. */
  skillsRef: SkillButtonSource | null = null;
  orbsRef: AbsorbSource | null = null;
  private absorbing = false;
  private attackIconState = 0; // 0 attack, 1 absorb

  private readonly onPointerDownStick: (event: PointerEvent) => void;
  private readonly onPointerDownLook: (event: PointerEvent) => void;
  private readonly onPointerMove: (event: PointerEvent) => void;
  private readonly onPointerEnd: (event: PointerEvent) => void;

  constructor(options: TouchControlsOptions) {
    this.input = options.input;
    this.stats = options.stats;
    this.player = options.player;
    this.onSkill = options.onSkill;
    this.vibrateSupported = canVibrate();

    for (let i = 0; i < MAX_POINTERS; i++) {
      this.pointers.push({
        id: -1,
        role: ROLE_FREE,
        originX: 0,
        originY: 0,
        lastX: 0,
        lastY: 0,
        button: -1,
      });
    }

    // --- DOM -------------------------------------------------------------
    this.root = document.createElement('div');
    this.root.className = 'tc';
    this.root.id = 'touch-controls';

    this.stickZone = document.createElement('div');
    this.stickZone.className = 'tc__stick-zone';
    this.stickZone.setAttribute('data-zone', 'move');
    this.root.appendChild(this.stickZone);

    this.lookZone = document.createElement('div');
    this.lookZone.className = 'tc__look-zone';
    this.lookZone.setAttribute('data-zone', 'look');
    this.root.appendChild(this.lookZone);

    this.stick = document.createElement('div');
    this.stick.className = 'tc__stick';
    this.stick.id = 'tc-stick';
    const base = document.createElement('div');
    base.className = 'tc__stick-base';
    this.knob = document.createElement('div');
    this.knob.className = 'tc__stick-knob';
    this.stick.appendChild(base);
    this.stick.appendChild(this.knob);
    this.root.appendChild(this.stick);

    const cluster = document.createElement('div');
    cluster.className = 'tc__buttons';
    this.root.appendChild(cluster);

    for (let i = 0; i < SKILL_SLOTS; i++) {
      this.buttons.push(this.makeButton(cluster, 'tc__btn--skill', SKILL_ICONS[i] ?? '?', i, String(i)));
    }
    this.buttons.push(this.makeButton(cluster, 'tc__btn--attack', '⚔', -1, undefined, 'attack'));
    this.buttons.push(this.makeButton(cluster, 'tc__btn--dash', '⤢', -2, undefined, 'dash'));

    options.mount.appendChild(this.root);

    // --- pointer plumbing -------------------------------------------------
    this.onPointerDownStick = (event: PointerEvent): void => {
      if (this.findSlotById(event.pointerId) !== null) return;
      const slot = this.takeFreeSlot();
      if (slot === null) return;
      slot.id = event.pointerId;
      slot.role = ROLE_STICK;
      // §6.1: the origin is wherever the thumb landed.
      slot.originX = event.clientX;
      slot.originY = event.clientY;
      slot.lastX = event.clientX;
      slot.lastY = event.clientY;
      this.stickPointer = event.pointerId;

      this.stick.classList.add('is-active');
      this.stick.style.transform = 'translate(' + event.clientX + 'px,' + event.clientY + 'px)';
      this.knob.style.transform = 'translate(-50%,-50%)';
      this.captureOn(this.stickZone, event.pointerId);
      event.preventDefault();
    };

    this.onPointerDownLook = (event: PointerEvent): void => {
      if (this.findSlotById(event.pointerId) !== null) return;
      const slot = this.takeFreeSlot();
      if (slot === null) return;
      slot.id = event.pointerId;
      slot.role = ROLE_LOOK;
      slot.lastX = event.clientX;
      slot.lastY = event.clientY;
      this.captureOn(this.lookZone, event.pointerId);
      event.preventDefault();
    };

    this.onPointerMove = (event: PointerEvent): void => {
      const slot = this.findSlotById(event.pointerId);
      if (slot === null) return;
      if (slot.role === ROLE_STICK) {
        // Only record the position. The axes are derived in update(), because a
        // thumb held still fires no further events — see the note there.
        slot.lastX = event.clientX;
        slot.lastY = event.clientY;
      } else if (slot.role === ROLE_LOOK) {
        // Raw pixels; CameraRig applies sensitivity so one setting covers both.
        this.input.lookDX += event.clientX - slot.lastX;
        this.input.lookDY += event.clientY - slot.lastY;
        slot.lastX = event.clientX;
        slot.lastY = event.clientY;
      }
    };

    this.onPointerEnd = (event: PointerEvent): void => {
      const slot = this.findSlotById(event.pointerId);
      if (slot === null) return;
      if (slot.role === ROLE_STICK) {
        this.stickPointer = -1;
        this.stick.classList.remove('is-active');
      } else if (slot.role === ROLE_BUTTON) {
        const view = this.buttons[slot.button];
        if (view !== undefined) {
          view.pressedBy = -1;
          if (view.slot === -1 && this.absorbing) {
            this.absorbing = false;
            const orbs = this.orbsRef;
            if (orbs !== null) orbs.setAbsorbing(false);
          }
        }
      }
      slot.id = -1;
      slot.role = ROLE_FREE;
      slot.button = -1;
    };

    this.stickZone.addEventListener('pointerdown', this.onPointerDownStick);
    this.lookZone.addEventListener('pointerdown', this.onPointerDownLook);
    // Move/end on window, so a finger that slides out of its zone keeps working.
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerEnd);
    window.addEventListener('pointercancel', this.onPointerEnd);
  }

  get sensitivity(): number {
    return this.sensitivityValue;
  }

  setSensitivity(value: number): void {
    if (value > 0) this.sensitivityValue = value;
  }

  get invertY(): boolean {
    return this.invertYValue;
  }

  setInvertY(value: boolean): void {
    this.invertYValue = value;
  }

  get active(): boolean {
    for (let i = 0; i < this.pointers.length; i++) {
      const slot = this.pointers[i];
      if (slot !== undefined && slot.id !== -1) return true;
    }
    return false;
  }

  update(dt: number): void {
    /*
     * The stick axes are derived HERE, once per tick, and not in the pointermove
     * handler. Two reasons, and the first one is a bug that shipped:
     *
     * 1. A thumb resting at full deflection fires no further pointer events. If
     *    the axes are only written on move, any producer that runs later in the
     *    tick order (KeyboardInput zeroes them every tick) wins, and the player
     *    never walks. Holding the stick is the normal case, not the edge case.
     * 2. Input belongs to the fixed tick anyway — pointer events arrive at
     *    whatever rate the digitiser feels like, up to several per frame.
     *
     * Only written while the stick is live, so desktop keyboard input is left
     * alone; the release edge zeroes the axes exactly once.
     */
    const active = this.stickPointer !== -1;
    if (active) {
      const slot = this.findSlotById(this.stickPointer);
      if (slot !== null) this.sampleStick(slot);
    } else if (this.stickWasActive) {
      this.input.moveX = 0;
      this.input.moveY = 0;
      this.knob.style.transform = 'translate(-50%,-50%)';
    }
    this.stickWasActive = active;

    // Attack button doubles as ABSORB near a soul orb (§8.2; §6 has no spare
    // button). The icon flips and the sweep shows hold progress instead.
    const orbs = this.orbsRef;
    const nearOrb = orbs !== null && orbs.nearbyOrb;
    const wantIcon = nearOrb ? 1 : 0;
    if (wantIcon !== this.attackIconState) {
      this.attackIconState = wantIcon;
      const attackView = this.buttons[SKILL_SLOTS];
      if (attackView !== undefined) {
        const icon = attackView.el.querySelector('.tc__btn-icon');
        if (icon !== null) icon.textContent = nearOrb ? '✋' : '⚔';
      }
      if (!nearOrb && this.absorbing) {
        this.absorbing = false;
        if (orbs !== null) orbs.setAbsorbing(false);
      }
    }

    const skills = this.skillsRef;
    const dashLeft = this.player.dashCooldownLeft;
    for (let i = 0; i < this.buttons.length; i++) {
      const view = this.buttons[i];
      if (view === undefined) continue;

      if (view.slot === -2) {
        view.cooldownLeft = dashLeft > 0 ? dashLeft : 0;
        view.cooldownTotal = DASH_COOLDOWN;
      } else if (view.slot >= 0 && skills !== null) {
        // Real numbers from the runtime (Phase 4): fraction drives the sweep,
        // seconds drive the countdown text.
        view.cooldownTotal = 1;
        view.cooldownLeft = skills.cooldownFraction(view.slot);
        const def = skills.skillAt(view.slot);
        const glyph = def !== null ? (ELEMENT_ICONS[def.element] ?? '?') : '·';
        if (view.el.dataset['icon'] !== glyph) {
          view.el.dataset['icon'] = glyph;
          const icon = view.el.querySelector('.tc__btn-icon');
          if (icon !== null) icon.textContent = glyph;
        }
      } else if (view.cooldownLeft > 0) {
        view.cooldownLeft -= dt;
        if (view.cooldownLeft < 0) view.cooldownLeft = 0;
      }

      this.refreshButton(view);
    }
  }

  reset(): void {
    for (let i = 0; i < this.pointers.length; i++) {
      const slot = this.pointers[i];
      if (slot === undefined) continue;
      slot.id = -1;
      slot.role = ROLE_FREE;
      slot.button = -1;
    }
    this.stickPointer = -1;
    this.stickWasActive = false;
    this.stick.classList.remove('is-active');
    for (let i = 0; i < this.buttons.length; i++) {
      const view = this.buttons[i];
      if (view === undefined) continue;
      view.cooldownLeft = 0;
      view.pressedBy = -1;
    }
  }

  dispose(): void {
    this.stickZone.removeEventListener('pointerdown', this.onPointerDownStick);
    this.lookZone.removeEventListener('pointerdown', this.onPointerDownLook);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerEnd);
    window.removeEventListener('pointercancel', this.onPointerEnd);
    this.root.remove();
  }

  // -------------------------------------------------------------------------

  private makeButton(
    parent: HTMLElement,
    variant: string,
    icon: string,
    slot: number,
    dataSlot?: string,
    dataAction?: string,
  ): ButtonView {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tc__btn ' + variant;
    if (dataSlot !== undefined) el.setAttribute('data-slot', dataSlot);
    if (dataAction !== undefined) el.setAttribute('data-action', dataAction);

    const iconEl = document.createElement('span');
    iconEl.className = 'tc__btn-icon';
    iconEl.textContent = icon;
    const cd = document.createElement('span');
    cd.className = 'tc__btn-cd';
    const cdText = document.createElement('span');
    cdText.className = 'tc__btn-cd-text';
    const cdTextNode = document.createTextNode('');
    cdText.appendChild(cdTextNode);

    el.appendChild(iconEl);
    el.appendChild(cd);
    el.appendChild(cdText);
    parent.appendChild(el);

    const view: ButtonView = {
      el,
      cd,
      cdText: cdTextNode,
      slot,
      visualState: -1,
      cooldownLeft: 0,
      cooldownTotal: slot >= 0 ? (SKILL_PLACEHOLDER_COOLDOWN[slot] ?? 1) : DASH_COOLDOWN,
      pressedBy: -1,
      lastCdBucket: -1,
    };

    el.addEventListener('pointerdown', (event: PointerEvent) => {
      // Buttons sit above the look zone, so stopping propagation is what keeps a
      // button press from also spinning the camera.
      event.stopPropagation();
      event.preventDefault();
      if (this.findSlotById(event.pointerId) !== null) return;
      const pointerSlot = this.takeFreeSlot();
      if (pointerSlot === null) return;
      pointerSlot.id = event.pointerId;
      pointerSlot.role = ROLE_BUTTON;
      pointerSlot.button = this.buttons.indexOf(view);
      view.pressedBy = event.pointerId;
      this.captureOn(el, event.pointerId);
      this.activate(view);
    });

    return view;
  }

  private activate(view: ButtonView): void {
    const now = performance.now();

    if (view.slot === -2) {
      if (this.player.dashCooldownLeft > 0) return;
      this.input.dashQueuedAt = now;
      this.buzz();
      return;
    }
    if (view.slot === -1) {
      const orbs = this.orbsRef;
      if (orbs !== null && orbs.nearbyOrb) {
        // Hold-to-absorb (§8.2's 1.2 s). Release is handled in onPointerEnd.
        this.absorbing = true;
        orbs.setAbsorbing(true);
        this.buzz();
        return;
      }
      this.input.attackQueuedAt = now;
      this.buzz();
      return;
    }

    if (this.skillsRef !== null) {
      // Runtime path (Phase 4): queue the press; the cast adapter consumes it
      // and the runtime is the single authority on cost/cooldown/refusal.
      this.input.skillQueuedAt[view.slot] = now;
      this.buzz();
      return;
    }

    if (view.cooldownLeft > 0) return;
    const cost = SKILL_PLACEHOLDER_COST[view.slot] ?? 0;
    if (this.stats.mana < cost) return;

    this.input.skillQueuedAt[view.slot] = now;
    this.stats.spendMana(cost);
    view.cooldownLeft = view.cooldownTotal;
    if (this.onSkill !== undefined) this.onSkill(view.slot);
    this.buzz();
  }

  /** §6.7 — feature-guarded, because iOS Safari has no vibrate at all. */
  private buzz(): void {
    if (!this.vibrateSupported) return;
    navigator.vibrate(10);
  }

  private refreshButton(view: ButtonView): void {
    let state = STATE_IDLE;
    if (view.pressedBy !== -1) state = STATE_PRESSED;
    else if (view.cooldownLeft > 0) state = STATE_COOLDOWN;
    else if (view.slot >= 0) {
      const cost = this.skillsRef !== null
        ? this.skillsRef.manaCost(view.slot)
        : (SKILL_PLACEHOLDER_COST[view.slot] ?? 0);
      if (cost > 0 && this.stats.mana < cost) state = STATE_NOMANA;
    }

    if (state !== view.visualState) {
      view.visualState = state;
      const list = view.el.classList;
      list.toggle('is-pressed', state === STATE_PRESSED);
      list.toggle('is-cooldown', state === STATE_COOLDOWN);
      list.toggle('is-nomana', state === STATE_NOMANA);
    }

    // §6.3's radial sweep, as a conic-gradient driven by --cd.
    const fraction = view.cooldownTotal > 0 ? view.cooldownLeft / view.cooldownTotal : 0;
    // Bucket to 1/60ths: the sweep still looks continuous, but the style write and
    // the string build happen far less often.
    const bucket = Math.round(fraction * 60);
    if (bucket !== view.lastCdBucket) {
      view.lastCdBucket = bucket;
      view.el.style.setProperty('--cd', String(fraction));
      const seconds = view.cooldownLeft;
      view.cdText.nodeValue = seconds > 0 ? (seconds >= 1 ? seconds.toFixed(0) : seconds.toFixed(1)) : '';
    }
  }

  /** Derives the axes and the knob offset from the live pointer position. */
  private sampleStick(slot: PointerSlot): void {
    let dx = slot.lastX - slot.originX;
    let dy = slot.lastY - slot.originY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance <= DEAD_ZONE_PX) {
      this.input.moveX = 0;
      this.input.moveY = 0;
      this.knob.style.transform = 'translate(-50%,-50%)';
      return;
    }

    // Remap so the axis starts at 0 right after the dead zone instead of jumping.
    const clamped = Math.min(distance, MAX_RADIUS_PX);
    const magnitude = (clamped - DEAD_ZONE_PX) / (MAX_RADIUS_PX - DEAD_ZONE_PX);
    const nx = dx / distance;
    const ny = dy / distance;

    this.input.moveX = nx * magnitude;
    this.input.moveY = ny * magnitude;

    dx = nx * clamped;
    dy = ny * clamped;
    this.knob.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
  }

  private findSlotById(id: number): PointerSlot | null {
    for (let i = 0; i < this.pointers.length; i++) {
      const slot = this.pointers[i];
      if (slot !== undefined && slot.id === id) return slot;
    }
    return null;
  }

  private takeFreeSlot(): PointerSlot | null {
    for (let i = 0; i < this.pointers.length; i++) {
      const slot = this.pointers[i];
      if (slot !== undefined && slot.id === -1) return slot;
    }
    return null;
  }

  /** Capture keeps events flowing to the element even if the finger leaves it. */
  private captureOn(element: HTMLElement, pointerId: number): void {
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // Synthetic events in tests have no real capture target; harmless.
    }
  }
}
