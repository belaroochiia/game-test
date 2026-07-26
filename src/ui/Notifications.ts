import type { Hitstop } from '../combat/Hitstop';
import type { System } from '../core/Engine';
import type { EventBus } from '../core/EventBus';
import type { SkillRegistry } from '../skills/SkillRegistry';
import { ELEMENTS, RARITIES } from '../skills/SkillTypes';
import type { ElementId, RarityId } from '../skills/SkillTypes';

/**
 * §8.2's "SKILL ACQUIRED" moment — the one the doc says to polish habis-habisan.
 *
 * On 'grimoire:acquired':
 *   1. hitstop.trigger(20)  — the FIGHT freezes ~0.33 s while camera, sky and
 *      fog keep breathing; the contrast is what sells the freeze-frame.
 *   2. White flash, opacity 1 → 0 over 150 ms.
 *   3. The skill card, centre screen: nameStyled large in its element colour,
 *      rarity border, loreText. It does NOT fade in — it is already at full
 *      scale under the flash and then overshoots 1 → 1.06 → 1 in ~160 ms
 *      (80 ms up), which reads as STAMPED onto the screen.
 *   4. navigator.vibrate(30), feature-guarded (§6.7).
 * Tap anywhere dismisses (after a short grace so combat mashing cannot skip the
 * moment unseen); 2.5 s auto-dismisses. A second acquisition while a card is up
 * queues behind it — never two cards stacked.
 *
 * House DOM discipline (HUD/DamageNumbers): ONE card, built in the constructor
 * and reused for every acquisition; values land in cached `Text` nodes; all
 * motion is CSS transform/opacity keyframes (§3). Event-rate work only — the
 * per-tick update() just advances two timers.
 */

export interface NotificationsOptions {
  mount: HTMLElement;
  bus: EventBus;
  registry: SkillRegistry;
  hitstop: Hitstop;
}

const STYLE_ID = 'notify-style';

/** ~0.33 s at the 60 Hz fixed tick — §8.2's freeze frame. */
const FREEZE_TICKS = 20;
const VIBRATE_MS = 30; // §6.7: new skill
const HOLD_SECONDS = 2.5;
const LEAVE_SECONDS = 0.15;
/** Taps earlier than this bounce off, so hitting attack the instant an orb pops
 *  cannot dismiss the card before it was ever seen. */
const MIN_SHOW_SECONDS = 0.25;

const PHASE_IDLE = 0;
const PHASE_SHOW = 1;
const PHASE_LEAVE = 2;

/** Same palette as GrimoireScreen (derived from the skills' vfxColors). */
const ELEMENT_COLOR: Readonly<Record<ElementId, string>> = {
  fire: '#ff5a2a',
  ice: '#9fdcff',
  wind: '#bfe8c8',
  earth: '#b08a55',
  water: '#4fa8e8',
  light: '#ffe9a8',
  dark: '#b050ff',
};

/** §5: Common grey · Rare blue · Epic purple · Legendary gold · Mythic white(-rainbow). */
const RARITY_COLOR: Readonly<Record<RarityId, string>> = {
  common: '#8d93a3',
  rare: '#4f9dff',
  epic: '#b45aff',
  legendary: '#ffc93c',
  mythic: '#f5f5ff',
};

/*
 * Injected once (integrator CSS files are off-limits). Palette vars reused from
 * main.css. transform/opacity only; the flash is a flat white layer, not a
 * filter. z-index 60 puts the moment above every gameplay overlay, including an
 * open GrimoireScreen (38) — a fusion confirmed in the book stamps its card
 * right over the book, which is exactly the drama §8.2 wants.
 */
function buildCss(): string {
  let vars = '';
  for (const el of ELEMENTS) {
    vars += '.notify .is-' + el + '{--nt-el:' + ELEMENT_COLOR[el] + ';}\n';
  }
  let rarity = '';
  for (const r of RARITIES) {
    rarity += '.notify__card.is-' + r + '{--nt-rar:' + RARITY_COLOR[r] + ';}\n';
  }
  return (
    '.notify{position:absolute;inset:0;z-index:60;display:grid;place-items:center;' +
    'overflow:hidden;}\n' +
    '.notify__flash{position:absolute;inset:0;background:#fff;opacity:0;' +
    'will-change:opacity;pointer-events:none;}\n' +
    '.notify__flash.is-on{animation:nt-flash 150ms linear forwards;}\n' +
    '@keyframes nt-flash{from{opacity:1;}to{opacity:0;}}\n' +
    '.notify__card{position:relative;width:min(80vw,430px);padding:20px 22px 16px;' +
    'border:2px solid var(--nt-rar,#8d93a3);border-radius:14px;text-align:center;' +
    'background:linear-gradient(165deg,#141a28 0%,#0a0d14 78%);opacity:0;' +
    'overflow:hidden;will-change:transform,opacity;}\n' +
    '.notify__card.is-in{opacity:1;animation:nt-stamp 160ms cubic-bezier(.22,.9,.34,1);}\n' +
    '@keyframes nt-stamp{0%{transform:scale(1);}50%{transform:scale(1.06);}' +
    '100%{transform:scale(1);}}\n' +
    '.notify__card.is-out{animation:nt-out 150ms ease forwards;}\n' +
    '@keyframes nt-out{from{opacity:1;transform:scale(1);}' +
    'to{opacity:0;transform:scale(.94);}}\n' +
    '.notify__banner{font-size:11px;font-weight:700;letter-spacing:.34em;' +
    'color:var(--ad-accent);}\n' +
    '.notify__name{margin-top:10px;font-size:clamp(20px,5.4vw,30px);font-weight:700;' +
    'line-height:1.25;color:var(--nt-el,var(--ad-ink));' +
    'text-shadow:0 1px 3px rgba(0,0,0,.8);}\n' +
    '.notify__meta{display:flex;justify-content:center;gap:10px;margin-top:10px;}\n' +
    '.notify__chip{padding:3px 10px;border:1px solid;border-radius:999px;' +
    'font-size:9px;font-weight:700;letter-spacing:.18em;}\n' +
    '.notify__chip--rar{border-color:var(--nt-rar,#8d93a3);color:var(--nt-rar,#8d93a3);}\n' +
    '.notify__chip--el{border-color:var(--nt-el,#888);color:var(--nt-el,#888);}\n' +
    '.notify__lore{margin:12px auto 0;max-width:36ch;font-size:11px;line-height:1.65;' +
    'color:var(--ad-ink-dim);}\n' +
    '.notify__hint{margin-top:14px;font-size:9px;letter-spacing:.3em;' +
    'color:var(--ad-ink-dim);opacity:.8;}\n' +
    rarity +
    '.notify__card.is-mythic::before{content:"";position:absolute;left:0;right:0;top:0;' +
    'height:4px;background:linear-gradient(90deg,#ffb3c8,#ffe9a8,#b8f2c8,#a8d9ff,#d8b8ff);}\n' +
    vars +
    '@media (prefers-reduced-motion:reduce){.notify__flash.is-on{animation:none;}' +
    '.notify__card.is-in{animation:none;}.notify__card.is-out{animation:none;opacity:0;}}\n'
  );
}

export class Notifications implements System {
  readonly name = 'notify';

  private readonly registry: SkillRegistry;
  private readonly hitstop: Hitstop;
  private readonly unsubAcquired: () => void;

  private layer: HTMLDivElement | undefined;
  private flash: HTMLDivElement | undefined;
  private card: HTMLDivElement | undefined;
  private nameText: Text | undefined;
  private rarityText: Text | undefined;
  private elementText: Text | undefined;
  private loreText: Text | undefined;

  private phase = PHASE_IDLE;
  private timer = 0;
  /** Pending skill ids (string copies — event payloads are never retained). */
  private readonly queue: string[] = [];
  private queueHead = 0;

  constructor(options: NotificationsOptions) {
    this.registry = options.registry;
    this.hitstop = options.hitstop;

    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.appendChild(document.createTextNode(buildCss()));
      document.head.appendChild(style);
    }

    const layer = document.createElement('div');
    layer.className = 'notify';
    // Inline, so `.ui-root > *`'s pointer-events opt-in can never outrank it
    // (same reasoning as DamageNumbers' layer). Flipped to 'auto' only while a
    // card is up, so the tap-to-dismiss surface exists exactly then.
    layer.style.pointerEvents = 'none';

    const flash = document.createElement('div');
    flash.className = 'notify__flash';
    layer.appendChild(flash);

    const card = document.createElement('div');
    card.className = 'notify__card';
    const banner = document.createElement('div');
    banner.className = 'notify__banner';
    banner.textContent = '✦ SKILL ACQUIRED ✦';
    card.appendChild(banner);
    const nameBox = document.createElement('div');
    nameBox.className = 'notify__name';
    const nameText = document.createTextNode('');
    nameBox.appendChild(nameText);
    card.appendChild(nameBox);
    const meta = document.createElement('div');
    meta.className = 'notify__meta';
    const rarChip = document.createElement('span');
    rarChip.className = 'notify__chip notify__chip--rar';
    const rarityText = document.createTextNode('');
    rarChip.appendChild(rarityText);
    meta.appendChild(rarChip);
    const elChip = document.createElement('span');
    elChip.className = 'notify__chip notify__chip--el';
    const elementText = document.createTextNode('');
    elChip.appendChild(elementText);
    meta.appendChild(elChip);
    card.appendChild(meta);
    const loreBox = document.createElement('div');
    loreBox.className = 'notify__lore';
    const loreText = document.createTextNode('');
    loreBox.appendChild(loreText);
    card.appendChild(loreBox);
    const hint = document.createElement('div');
    hint.className = 'notify__hint';
    hint.textContent = 'TAP TO CONTINUE';
    card.appendChild(hint);
    layer.appendChild(card);

    // The layer only receives events while a card is up; everything it does
    // receive is the moment's own tap and must never leak to the game beneath.
    layer.addEventListener('pointerdown', this.onTap);
    layer.addEventListener('pointermove', this.onSwallow);
    layer.addEventListener('pointerup', this.onSwallow);
    layer.addEventListener('pointercancel', this.onSwallow);
    layer.addEventListener('click', this.onSwallow);

    options.mount.appendChild(layer);
    this.layer = layer;
    this.flash = flash;
    this.card = card;
    this.nameText = nameText;
    this.rarityText = rarityText;
    this.elementText = elementText;
    this.loreText = loreText;

    this.unsubAcquired = options.bus.on('grimoire:acquired', this.onAcquired);
  }

  /** Timers only; all DOM motion is CSS keyframes on their own clock. */
  update(dt: number): void {
    if (this.phase === PHASE_SHOW) {
      this.timer += dt;
      if (this.timer >= HOLD_SECONDS) this.beginLeave();
    } else if (this.phase === PHASE_LEAVE) {
      this.timer += dt;
      if (this.timer >= LEAVE_SECONDS) this.finishLeave();
    }
  }

  reset(): void {
    this.queue.length = 0;
    this.queueHead = 0;
    this.phase = PHASE_IDLE;
    this.timer = 0;
    const card = this.card;
    if (card !== undefined) card.classList.remove('is-in', 'is-out');
    const flash = this.flash;
    if (flash !== undefined) flash.classList.remove('is-on');
    const layer = this.layer;
    if (layer !== undefined) layer.style.pointerEvents = 'none';
  }

  dispose(): void {
    this.unsubAcquired();
    const layer = this.layer;
    if (layer !== undefined) layer.remove();
    this.layer = undefined;
    this.flash = undefined;
    this.card = undefined;
    this.nameText = undefined;
    this.rarityText = undefined;
    this.elementText = undefined;
    this.loreText = undefined;
    this.queue.length = 0;
    this.queueHead = 0;
    this.phase = PHASE_IDLE;
    // The <style> tag stays: shared, static, idempotent by id (house pattern).
  }

  /* -------------------------------------------------------------- events */

  /**
   * Structurally typed on purpose: the payload's full shape ({ id, source }) is
   * declared where the event is emitted; this listener only ever needs the id,
   * copied out synchronously per the EventBus retention rule.
   */
  private readonly onAcquired = (payload: { readonly id: string }): void => {
    if (this.phase === PHASE_IDLE) {
      this.tryShow(payload.id);
    } else {
      // One card at a time — the second moment waits its turn (§8.2).
      this.queue.push(payload.id);
    }
  };

  private readonly onTap = (event: Event): void => {
    event.stopPropagation();
    if (this.phase === PHASE_SHOW && this.timer >= MIN_SHOW_SECONDS) this.beginLeave();
  };

  private readonly onSwallow = (event: Event): void => {
    event.stopPropagation();
  };

  /* --------------------------------------------------------------- flow */

  private tryShow(id: string): boolean {
    const def = this.registry.get(id);
    const layer = this.layer;
    const flash = this.flash;
    const card = this.card;
    if (def === undefined || layer === undefined || flash === undefined || card === undefined) {
      return false;
    }

    // The freeze lands the instant the card does, so a queued second card gets
    // its own beat instead of borrowing the first one's.
    this.hitstop.trigger(FREEZE_TICKS);
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(VIBRATE_MS);
    }

    const nameText = this.nameText;
    const rarityText = this.rarityText;
    const elementText = this.elementText;
    const loreText = this.loreText;
    if (nameText !== undefined) nameText.nodeValue = def.nameStyled;
    if (rarityText !== undefined) rarityText.nodeValue = def.rarity.toUpperCase();
    if (elementText !== undefined) elementText.nodeValue = def.element.toUpperCase();
    if (loreText !== undefined) loreText.nodeValue = def.loreText;

    // Fresh class string resets is-in/is-out and applies rarity + element.
    card.className = 'notify__card is-' + def.rarity + ' is-' + def.element;
    flash.classList.remove('is-on');
    // Forced reflow restarts both CSS animations. Event-rate, never per-frame.
    void flash.offsetWidth;
    flash.classList.add('is-on');
    card.classList.add('is-in');
    layer.style.pointerEvents = 'auto';

    this.phase = PHASE_SHOW;
    this.timer = 0;
    return true;
  }

  private beginLeave(): void {
    const card = this.card;
    if (card !== undefined) {
      card.classList.remove('is-in');
      card.classList.add('is-out');
    }
    this.phase = PHASE_LEAVE;
    this.timer = 0;
  }

  private finishLeave(): void {
    const card = this.card;
    if (card !== undefined) card.classList.remove('is-out');
    const layer = this.layer;
    if (layer !== undefined) layer.style.pointerEvents = 'none';
    this.phase = PHASE_IDLE;
    this.timer = 0;
    this.pump();
  }

  /** Shows the next queued card, skipping ids the registry cannot resolve. */
  private pump(): void {
    const queue = this.queue;
    while (this.queueHead < queue.length) {
      const id = queue[this.queueHead];
      this.queueHead++;
      if (this.queueHead >= queue.length) {
        queue.length = 0;
        this.queueHead = 0;
      }
      if (id !== undefined && this.tryShow(id)) return;
    }
  }
}
