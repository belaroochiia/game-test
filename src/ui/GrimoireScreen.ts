import type { System } from '../core/Engine';
import type { EventBus } from '../core/EventBus';
import { ACTIVE_SLOTS } from '../skills/Grimoire';
import type { Grimoire } from '../skills/Grimoire';
import type { SkillRegistry } from '../skills/SkillRegistry';
import { ELEMENTS, RARITIES } from '../skills/SkillTypes';
import type { ElementId, RarityId } from '../skills/SkillTypes';

/**
 * §8.6's Grimoire screen: full-screen DOM overlay with Collection / Loadout /
 * Fusion tabs. Mastery gets no tab of its own — pips and uses-to-next live on
 * each Collection card, which is where the player is already looking (contract
 * deviation from §8.6's four tabs, noted there).
 *
 * House DOM discipline (HUD/DamageNumbers): the DOM is built exactly ONCE — and
 * lazily, on first open, so a player who never opens the book pays nothing.
 * Refreshes reuse every node through cached `Text` refs and class toggles, and
 * every write is gated on change. No virtualisation: Phase 4 ships ~11 cards;
 * §8.6's virtualised list becomes real work when Phase 7 crosses 40.
 *
 * The game keeps running behind the overlay (the engine has no pause; standard
 * mobile-ARPG behaviour). Input therefore must not leak: the root swallows its
 * own pointer/click events in the bubble phase, so window-level listeners
 * (TouchControls' move/end, KeyboardInput's mouse hooks) never see them. Fingers
 * already captured by the game (`setPointerCapture`) keep targeting their
 * captured element and never route through this overlay, so an in-flight stick
 * drag ends cleanly on release instead of getting stuck.
 */

export interface GrimoireScreenOptions {
  mount: HTMLElement;
  registry: SkillRegistry;
  grimoire: Grimoire;
  bus: EventBus;
}

const STYLE_ID = 'gs-style';
const MASTERY_LEVELS = 5;
/** Mirrors Grimoire's (unexported) FUSE_MASTERY — §8.2.5's "mastery >= 3". */
const FUSION_MASTERY = 3;

/** One palette for chips/dots everywhere; derived from the skills' vfxColors. */
const ELEMENT_COLOR: Readonly<Record<ElementId, string>> = {
  fire: '#ff5a2a',
  ice: '#9fdcff',
  wind: '#bfe8c8',
  earth: '#b08a55',
  water: '#4fa8e8',
  light: '#ffe9a8',
  dark: '#b050ff',
};

/** §5's rarity reading: grey / blue / purple / gold / white(-rainbow strip). */
const RARITY_BORDER: Readonly<Record<RarityId, string>> = {
  common: '#8d93a3',
  rare: '#4f9dff',
  epic: '#b45aff',
  legendary: '#ffc93c',
  mythic: '#f5f5ff',
};

/*
 * Injected once (integrator CSS files are off-limits). Only transform/opacity
 * are ever transitioned; no backdrop-filter anywhere (§3 — the scrim is a flat
 * rgba, which composites for free). `.gs__body` re-enables pan-y inside the
 * global `touch-action: none` shell so the card grid scrolls under a thumb.
 * All touch targets are >= 56 px with >= 10 px gaps (§6.3).
 */
function buildCss(): string {
  let vars = '';
  for (const el of ELEMENTS) {
    vars += '.gs .is-' + el + '{--gs-el:' + ELEMENT_COLOR[el] + ';}\n';
  }
  let rarity = '';
  for (const r of RARITIES) {
    rarity += '.gs-card.is-' + r + '{border-color:' + RARITY_BORDER[r] + ';}\n';
  }
  return (
    '.gs{position:absolute;inset:0;z-index:38;display:none;pointer-events:auto;' +
    'background:rgba(6,9,15,.9);}\n' +
    '.gs.is-open{display:flex;justify-content:center;}\n' +
    '.gs__panel{display:flex;flex-direction:column;width:100%;max-width:960px;min-height:0;' +
    'padding:calc(var(--ad-safe-t) + 10px) calc(var(--ad-safe-r) + 12px) ' +
    'calc(var(--ad-safe-b) + 10px) calc(var(--ad-safe-l) + 12px);}\n' +
    '.gs__head{flex:0 0 auto;display:flex;align-items:center;gap:10px;}\n' +
    '.gs__title{font-size:15px;font-weight:700;letter-spacing:.24em;color:var(--ad-ink);}\n' +
    '.gs__count{margin-left:auto;font-size:12px;letter-spacing:.1em;' +
    'font-variant-numeric:tabular-nums;color:var(--ad-accent);}\n' +
    '.gs__close{flex:0 0 auto;min-width:56px;min-height:56px;display:grid;place-items:center;' +
    'border:1px solid var(--ad-panel-line);border-radius:12px;background:var(--ad-panel);' +
    'color:var(--ad-ink);font:inherit;font-size:20px;cursor:pointer;transition:transform 80ms ease;}\n' +
    '.gs__close:active{transform:scale(.94);}\n' +
    '.gs__tabs{flex:0 0 auto;display:flex;gap:10px;margin-top:10px;}\n' +
    '.gs__tab{flex:1 1 0;min-width:56px;min-height:56px;border:1px solid var(--ad-panel-line);' +
    'border-radius:12px;background:var(--ad-panel);color:var(--ad-ink-dim);font:inherit;' +
    'font-size:11px;font-weight:700;letter-spacing:.18em;cursor:pointer;' +
    'transition:transform 80ms ease,color 120ms ease,border-color 120ms ease;}\n' +
    '.gs__tab:active{transform:scale(.96);}\n' +
    '.gs__tab.is-active{color:var(--ad-accent);border-color:rgba(127,227,196,.5);}\n' +
    '.gs__body{flex:1 1 auto;min-height:0;margin-top:10px;overflow-y:auto;' +
    'touch-action:pan-y;overscroll-behavior:contain;padding-bottom:12px;}\n' +
    '.gs__page{display:none;}\n' +
    '.gs__page.is-active{display:block;}\n' +
    /* ------------------------------------------------------------ collection */
    '.gs__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:10px;}\n' +
    '.gs-card{position:relative;min-height:104px;padding:10px 12px;overflow:hidden;' +
    'border:2px solid var(--ad-panel-line);border-radius:10px;background:var(--ad-panel);}\n' +
    '.gs-card__name{font-size:13px;font-weight:700;line-height:1.3;color:var(--ad-ink);}\n' +
    '.gs-card__chip{display:inline-block;margin-top:6px;padding:2px 8px;' +
    'border:1px solid var(--gs-el,#888);border-radius:999px;font-size:9px;font-weight:700;' +
    'letter-spacing:.14em;color:var(--gs-el,#888);}\n' +
    '.gs-card__pips{display:flex;gap:5px;margin-top:9px;}\n' +
    '.gs-card__pip{width:9px;height:9px;transform:rotate(45deg);' +
    'border:1px solid var(--ad-ink-dim);opacity:.35;}\n' +
    '.gs-card__pip.is-on{background:var(--ad-accent);border-color:var(--ad-accent);opacity:1;}\n' +
    '.gs-card__uses{margin-top:7px;font-size:10px;letter-spacing:.06em;' +
    'font-variant-numeric:tabular-nums;color:var(--ad-ink-dim);}\n' +
    rarity +
    '.gs-card.is-mythic::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;' +
    'background:linear-gradient(90deg,#ffb3c8,#ffe9a8,#b8f2c8,#a8d9ff,#d8b8ff);}\n' +
    /* Unknown silhouette (§8.6): dark mask, big "?", card number. Placed after
       the rarity rules so it wins and never leaks the rarity colour. */
    '.gs-card.is-unknown{border-color:#20242f;}\n' +
    '.gs-card.is-unknown::before{content:none;}\n' +
    '.gs-card__mask{position:absolute;inset:0;display:none;place-items:center;' +
    'background:linear-gradient(160deg,#10141d 0%,#0a0d14 100%);}\n' +
    '.gs-card.is-unknown .gs-card__mask{display:grid;}\n' +
    '.gs-card__mask-q{font-size:34px;font-weight:700;color:#2c3242;}\n' +
    '.gs-card__mask-num{position:absolute;right:9px;bottom:7px;font-size:11px;' +
    'letter-spacing:.1em;font-variant-numeric:tabular-nums;color:#3a4152;}\n' +
    /* --------------------------------------------------------------- loadout */
    '.gs__slots{display:grid;grid-template-columns:repeat(4,minmax(56px,1fr));gap:10px;}\n' +
    '.gs-slot{min-height:56px;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:3px;padding:6px 8px;border:2px solid var(--ad-panel-line);' +
    'border-radius:10px;background:var(--ad-panel);color:var(--ad-ink);font:inherit;' +
    'cursor:pointer;transition:transform 80ms ease,border-color 120ms ease;}\n' +
    '.gs-slot:active{transform:scale(.95);}\n' +
    '.gs-slot__key{font-size:9px;letter-spacing:.16em;color:var(--ad-ink-dim);}\n' +
    '.gs-slot__name{font-size:11px;font-weight:700;line-height:1.2;text-align:center;}\n' +
    '.gs-slot.is-picked{border-color:var(--ad-accent);color:var(--ad-accent);}\n' +
    '.gs-slot.is-empty .gs-slot__name{color:var(--ad-ink-dim);font-weight:400;}\n' +
    '.gs__note{margin:10px 2px 0;font-size:11px;line-height:1.5;letter-spacing:.04em;' +
    'color:var(--ad-ink-dim);}\n' +
    '.gs__resonance{margin-top:10px;padding:9px 12px;border:1px solid var(--ad-panel-line);' +
    'border-radius:8px;font-size:11px;line-height:1.5;letter-spacing:.06em;color:var(--ad-ink);}\n' +
    '.gs__resonance.is-live{border-color:rgba(127,227,196,.5);color:var(--ad-accent);}\n' +
    '.gs__list{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));' +
    'gap:10px;margin-top:10px;}\n' +
    '.gs-row{min-height:56px;display:none;align-items:center;gap:9px;padding:6px 12px;' +
    'border:1px solid var(--ad-panel-line);border-radius:10px;background:var(--ad-panel);' +
    'color:var(--ad-ink);font:inherit;font-size:12px;text-align:left;cursor:pointer;' +
    'transition:transform 80ms ease,border-color 120ms ease;}\n' +
    '.gs-row.is-shown{display:flex;}\n' +
    '.gs-row:active{transform:scale(.97);}\n' +
    '.gs-row__dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;' +
    'background:var(--gs-el,#888);}\n' +
    '.gs-row__name{flex:1 1 auto;font-weight:700;line-height:1.25;}\n' +
    '.gs-row__lvl{flex:0 0 auto;font-size:10px;letter-spacing:.08em;' +
    'font-variant-numeric:tabular-nums;color:var(--ad-ink-dim);}\n' +
    '.gs-row.is-marked{border-color:rgba(127,227,196,.5);}\n' +
    '.gs__list.is-locked .gs-row{opacity:.4;pointer-events:none;}\n' +
    /* ---------------------------------------------------------------- fusion */
    '.gs__fuse-picks{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}\n' +
    '.gs-pickbox{flex:1 1 130px;min-height:56px;display:grid;place-items:center;' +
    'padding:6px 10px;border:2px dashed var(--ad-panel-line);border-radius:10px;' +
    'font-size:12px;font-weight:700;text-align:center;color:var(--ad-ink-dim);}\n' +
    '.gs-pickbox.is-set{border-style:solid;color:var(--ad-ink);}\n' +
    '.gs-pickbox.is-secret{color:var(--ad-warn);letter-spacing:.3em;}\n' +
    '.gs__fuse-op{flex:0 0 auto;font-size:16px;color:var(--ad-ink-dim);}\n' +
    '.gs__fuse-confirm{margin-top:10px;width:100%;min-height:56px;' +
    'border:2px solid var(--ad-accent);border-radius:12px;background:rgba(127,227,196,.12);' +
    'color:var(--ad-accent);font:inherit;font-size:13px;font-weight:700;letter-spacing:.18em;' +
    'cursor:pointer;transition:transform 80ms ease,opacity 110ms linear;}\n' +
    '.gs__fuse-confirm:active{transform:scale(.97);}\n' +
    '.gs__fuse-confirm:disabled{opacity:.3;pointer-events:none;}\n' +
    vars +
    '@media (prefers-reduced-motion:reduce){.gs__close,.gs__tab,.gs-slot,.gs-row,' +
    '.gs__fuse-confirm{transition-duration:0s;}}\n'
  );
}

/* ------------------------------------------------------- tiny DOM builders */

function div(cls: string, parent: HTMLElement): HTMLDivElement {
  const el = document.createElement('div');
  el.className = cls;
  parent.appendChild(el);
  return el;
}

function span(cls: string, parent: HTMLElement): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = cls;
  parent.appendChild(el);
  return el;
}

function button(cls: string, parent: HTMLElement): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = cls;
  parent.appendChild(el);
  return el;
}

function textIn(parent: HTMLElement): Text {
  const node = document.createTextNode('');
  parent.appendChild(node);
  return node;
}

/* ------------------------------------------------------------ cached refs */

interface CardDom {
  readonly root: HTMLDivElement;
  readonly pips: readonly HTMLSpanElement[];
  readonly uses: Text;
  level: number; // -1 = force first write
  usesValue: string;
}

/** Shared by the loadout pool and the fusion list (same button anatomy). */
interface RowDom {
  readonly root: HTMLButtonElement;
  readonly lvl: Text;
  lvlValue: string;
}

interface SlotDom {
  readonly root: HTMLButtonElement;
  readonly label: Text;
  labelValue: string;
}

interface GsDom {
  readonly root: HTMLDivElement;
  readonly counter: Text;
  readonly tabs: readonly HTMLButtonElement[];
  readonly pages: readonly HTMLDivElement[];
  readonly cards: readonly CardDom[];
  readonly slots: readonly SlotDom[];
  readonly poolList: HTMLDivElement;
  readonly pool: readonly RowDom[];
  readonly resonanceBox: HTMLDivElement;
  readonly resonance: Text;
  readonly loadoutNote: Text;
  readonly fuseRows: readonly RowDom[];
  readonly fuseABox: HTMLDivElement;
  readonly fuseA: Text;
  readonly fuseBBox: HTMLDivElement;
  readonly fuseB: Text;
  readonly fuseResultBox: HTMLDivElement;
  readonly fuseResult: Text;
  readonly fuseNote: Text;
  readonly fuseConfirm: HTMLButtonElement;
}

const TAB_LABELS = ['COLLECTION', 'LOADOUT', 'FUSION'] as const;

export class GrimoireScreen implements System {
  readonly name = 'grimoireScreen';

  private readonly mount: HTMLElement;
  private readonly registry: SkillRegistry;
  private readonly grimoire: Grimoire;
  private readonly unsubAcquired: () => void;

  private dom: GsDom | undefined;
  private openFlag = false;
  private activeTab = 0;
  private pickedSlot = -1;
  private fuseA: string | null = null;
  private fuseB: string | null = null;
  private counterValue = '';

  constructor(options: GrimoireScreenOptions) {
    this.mount = options.mount;
    this.registry = options.registry;
    this.grimoire = options.grimoire;
    // Fusion from inside this screen, or a debug learn, must repaint the open
    // screen; while closed, open() repaints anyway, so the handler skips work.
    this.unsubAcquired = options.bus.on('grimoire:acquired', this.onAcquired);
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  open(): void {
    if (this.openFlag) return;
    if (this.dom === undefined) this.dom = this.build();
    this.openFlag = true;
    this.dom.root.classList.add('is-open');
    this.refresh();
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    // Selections do not survive a close: reopening always starts predictable.
    this.pickedSlot = -1;
    this.fuseA = null;
    this.fuseB = null;
    const dom = this.dom;
    if (dom !== undefined) dom.root.classList.remove('is-open');
  }

  /** Everything repaints on discrete user actions; nothing to do per tick. */
  update(): void {}

  reset(): void {
    this.close();
  }

  dispose(): void {
    this.unsubAcquired();
    const dom = this.dom;
    if (dom !== undefined) dom.root.remove();
    this.dom = undefined;
    this.openFlag = false;
    // The <style> tag stays: shared, static, idempotent by id (house pattern).
  }

  /* -------------------------------------------------------------- events */

  private readonly onAcquired = (): void => {
    if (this.openFlag) this.refresh();
  };

  /** Bubble-phase swallow: UI handled below never reaches the game's window hooks. */
  private readonly onSwallow = (event: Event): void => {
    event.stopPropagation();
  };

  /** One delegated click listener for the whole screen; runs at event rate. */
  private readonly onClick = (event: MouseEvent): void => {
    event.stopPropagation();
    const dom = this.dom;
    if (dom === undefined) return;
    let node: Element | null = event.target instanceof Element ? event.target : null;
    while (node !== null && node !== dom.root) {
      if (node instanceof HTMLElement) {
        const tab = node.getAttribute('data-gs-tab');
        if (tab !== null) {
          this.setTab(Number(tab));
          return;
        }
        const act = node.getAttribute('data-gs-act');
        if (act === 'close') {
          this.close();
          return;
        }
        if (act === 'fuse') {
          this.confirmFuse();
          return;
        }
        const slot = node.getAttribute('data-gs-slot');
        if (slot !== null) {
          this.tapSlot(Number(slot));
          return;
        }
        const pick = node.getAttribute('data-gs-pick');
        if (pick !== null) {
          this.tapPool(pick);
          return;
        }
        const fuse = node.getAttribute('data-gs-fuse');
        if (fuse !== null) {
          this.tapFuse(fuse);
          return;
        }
      }
      node = node.parentElement;
    }
  };

  /* ------------------------------------------------------------- actions */

  private setTab(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= TAB_LABELS.length) return;
    if (index === this.activeTab) return;
    this.activeTab = index;
    const dom = this.dom;
    if (dom === undefined) return;
    for (let i = 0; i < dom.tabs.length; i++) {
      const tab = dom.tabs[i];
      const page = dom.pages[i];
      if (tab !== undefined) tab.classList.toggle('is-active', i === index);
      if (page !== undefined) page.classList.toggle('is-active', i === index);
    }
  }

  /** §6-first assignment: tap a slot, then tap a skill. Tap again to unpick. */
  private tapSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= ACTIVE_SLOTS) return;
    this.pickedSlot = this.pickedSlot === slot ? -1 : slot;
    this.refreshLoadout();
  }

  private tapPool(id: string): void {
    if (this.pickedSlot >= 0 && this.grimoire.canEditLoadout) {
      this.grimoire.equip(this.pickedSlot, id);
    }
    // Repaint either way — the note explains what a slot-less tap should do.
    this.refreshLoadout();
  }

  private tapFuse(id: string): void {
    if (this.fuseA === id) {
      this.fuseA = this.fuseB;
      this.fuseB = null;
    } else if (this.fuseB === id) {
      this.fuseB = null;
    } else if (this.fuseA === null) {
      this.fuseA = id;
    } else {
      // Third pick replaces B, so correcting a choice never needs a deselect.
      this.fuseB = id;
    }
    this.refreshFusion();
  }

  private confirmFuse(): void {
    const a = this.fuseA;
    const b = this.fuseB;
    if (a === null || b === null) return;
    // Grimoire consumes the inputs and emits 'grimoire:acquired' — the
    // Notifications card is that event's job, not this screen's.
    const result = this.grimoire.fuse(a, b);
    if (result !== null) {
      this.fuseA = null;
      this.fuseB = null;
      this.refresh();
    } else {
      this.refreshFusion();
    }
  }

  /* ------------------------------------------------------------- refresh */

  private refresh(): void {
    this.refreshCounter();
    this.refreshCards();
    this.refreshLoadout();
    this.refreshFusion();
  }

  private refreshCounter(): void {
    const dom = this.dom;
    if (dom === undefined) return;
    const text = this.grimoire.knownCount + ' / ' + this.grimoire.totalCount + ' SKILLS';
    if (text !== this.counterValue) {
      this.counterValue = text;
      dom.counter.nodeValue = text;
    }
  }

  private refreshCards(): void {
    const dom = this.dom;
    if (dom === undefined) return;
    const list = this.registry.all;
    for (let i = 0; i < list.length; i++) {
      const def = list[i];
      const card = dom.cards[i];
      if (def === undefined || card === undefined) continue;
      const known = this.grimoire.isKnown(def.id);
      card.root.classList.toggle('is-unknown', !known);
      if (!known) continue;
      const info = this.grimoire.mastery(def.id);
      if (info.level !== card.level) {
        card.level = info.level;
        for (let k = 0; k < card.pips.length; k++) {
          const pip = card.pips[k];
          if (pip !== undefined) pip.classList.toggle('is-on', k < info.level);
        }
      }
      const uses =
        info.level >= MASTERY_LEVELS ? 'AWAKENED' : info.uses + ' / ' + info.nextAt + ' uses';
      if (uses !== card.usesValue) {
        card.usesValue = uses;
        card.uses.nodeValue = uses;
      }
    }
  }

  private refreshLoadout(): void {
    const dom = this.dom;
    if (dom === undefined) return;
    const g = this.grimoire;
    const editable = g.canEditLoadout;
    const e0 = g.equipped(0);
    const e1 = g.equipped(1);
    const e2 = g.equipped(2);
    const e3 = g.equipped(3);

    for (let s = 0; s < dom.slots.length; s++) {
      const slot = dom.slots[s];
      if (slot === undefined) continue;
      const id = s === 0 ? e0 : s === 1 ? e1 : s === 2 ? e2 : e3;
      const label = id === null ? 'EMPTY' : (this.registry.get(id)?.name ?? id);
      if (label !== slot.labelValue) {
        slot.labelValue = label;
        slot.label.nodeValue = label;
      }
      slot.root.classList.toggle('is-picked', s === this.pickedSlot);
      slot.root.classList.toggle('is-empty', id === null);
    }

    dom.poolList.classList.toggle('is-locked', !editable);
    const list = this.registry.all;
    for (let i = 0; i < list.length; i++) {
      const def = list[i];
      const row = dom.pool[i];
      if (def === undefined || row === undefined) continue;
      const known = g.isKnown(def.id);
      row.root.classList.toggle('is-shown', known);
      if (!known) continue;
      const lvl = 'Lv ' + g.mastery(def.id).level;
      if (lvl !== row.lvlValue) {
        row.lvlValue = lvl;
        row.lvl.nodeValue = lvl;
      }
      const equippedNow = def.id === e0 || def.id === e1 || def.id === e2 || def.id === e3;
      row.root.classList.toggle('is-marked', equippedNow);
    }

    // §8.4's resonance readout, numbers pulled from the API so data drives them.
    const res = g.resonance();
    let text: string;
    if (res.kind === 'element' && res.element !== null) {
      const pct = Math.round((g.elementBonus(res.element) - 1) * 100);
      text =
        'RESONANCE: ' + res.element.toUpperCase() + ' — +' + pct + '% ' + res.element + ' damage';
    } else if (res.kind === 'versatile') {
      const pct = Math.round(g.statusChanceBonus() * 100);
      text = 'RESONANCE: VERSATILE — +' + pct + '% status effect chance';
    } else {
      text = 'NO RESONANCE — equip 3 skills of one element, or 4 different elements';
    }
    dom.resonanceBox.classList.toggle('is-live', res.kind !== 'none');
    if (text !== dom.resonance.nodeValue) dom.resonance.nodeValue = text;

    const note = !editable
      ? 'Loadout is locked — rest at a campfire to change it.'
      : this.pickedSlot < 0
        ? 'Tap a slot, then tap a skill to equip it.'
        : 'Slot ' + (this.pickedSlot + 1) + ' selected — tap a skill below.';
    if (note !== dom.loadoutNote.nodeValue) dom.loadoutNote.nodeValue = note;
  }

  private refreshFusion(): void {
    const dom = this.dom;
    if (dom === undefined) return;
    const g = this.grimoire;
    const list = this.registry.all;
    let eligible = 0;
    for (let i = 0; i < list.length; i++) {
      const def = list[i];
      const row = dom.fuseRows[i];
      if (def === undefined || row === undefined) continue;
      const ok = g.isKnown(def.id) && g.mastery(def.id).level >= FUSION_MASTERY;
      row.root.classList.toggle('is-shown', ok);
      row.root.classList.toggle('is-marked', def.id === this.fuseA || def.id === this.fuseB);
      if (!ok) continue;
      eligible++;
      const lvl = 'Lv ' + g.mastery(def.id).level;
      if (lvl !== row.lvlValue) {
        row.lvlValue = lvl;
        row.lvl.nodeValue = lvl;
      }
    }

    const nameOf = (id: string | null): string | null =>
      id === null ? null : (this.registry.get(id)?.name ?? id);
    const aName = nameOf(this.fuseA);
    const bName = nameOf(this.fuseB);
    dom.fuseABox.classList.toggle('is-set', aName !== null);
    dom.fuseBBox.classList.toggle('is-set', bName !== null);
    dom.fuseA.nodeValue = aName ?? 'PICK A';
    dom.fuseB.nodeValue = bName ?? 'PICK B';

    let resultText = '—';
    let resultSet = false;
    let secret = false;
    let note: string;
    let canConfirm = false;
    if (this.fuseA !== null && this.fuseB !== null) {
      // Grimoire refuses re-fusing a known result ('result-known'), so an ok
      // verdict ALWAYS means an undiscovered skill: §8.3's blur is exactly the
      // ok case, and the named preview is exactly the result-known refusal.
      const check = g.canFuse(this.fuseA, this.fuseB);
      switch (check.reason) {
        case 'ok':
          canConfirm = true;
          resultSet = true;
          secret = true;
          resultText = '???';
          note = 'Something new stirs... Both skills are consumed by the fusion.';
          break;
        case 'result-known':
          resultSet = true;
          resultText =
            check.result !== null
              ? (this.registry.get(check.result)?.name ?? check.result)
              : '—';
          note = 'Already inscribed in your grimoire — nothing would be gained.';
          break;
        case 'no-recipe':
          note = 'These two refuse to combine.';
          break;
        case 'mastery':
          note = 'Both skills must be at mastery ' + FUSION_MASTERY + ' or higher.';
          break;
        case 'not-known':
          note = 'Both skills must be in your grimoire.';
          break;
        case 'same-skill':
          note = 'Pick two different skills.';
          break;
      }
    } else {
      note =
        eligible < 2
          ? 'Fusion needs two different skills, both at mastery ' + FUSION_MASTERY + ' or higher.'
          : 'Pick two skills to combine.';
    }
    dom.fuseResultBox.classList.toggle('is-set', resultSet);
    dom.fuseResultBox.classList.toggle('is-secret', secret);
    if (resultText !== dom.fuseResult.nodeValue) dom.fuseResult.nodeValue = resultText;
    if (note !== dom.fuseNote.nodeValue) dom.fuseNote.nodeValue = note;
    dom.fuseConfirm.disabled = !canConfirm;
  }

  /* --------------------------------------------------------------- build */

  /** Runs once, on first open. Allocation here is fine (§3 is per-frame). */
  private build(): GsDom {
    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.appendChild(document.createTextNode(buildCss()));
      document.head.appendChild(style);
    }

    const root = document.createElement('div');
    root.className = 'gs';
    root.addEventListener('pointerdown', this.onSwallow);
    root.addEventListener('pointermove', this.onSwallow);
    root.addEventListener('pointerup', this.onSwallow);
    root.addEventListener('pointercancel', this.onSwallow);
    root.addEventListener('click', this.onClick);

    const panel = div('gs__panel', root);

    // Head — title, "N / M SKILLS" counter, close.
    const head = div('gs__head', panel);
    const title = div('gs__title', head);
    title.textContent = 'GRIMOIRE';
    const countBox = div('gs__count', head);
    const counter = textIn(countBox);
    const closeBtn = button('gs__close', head);
    closeBtn.setAttribute('data-gs-act', 'close');
    closeBtn.setAttribute('aria-label', 'Close grimoire');
    closeBtn.textContent = '✕';

    // Tabs.
    const tabsBox = div('gs__tabs', panel);
    const tabs: HTMLButtonElement[] = [];
    for (let i = 0; i < TAB_LABELS.length; i++) {
      const tab = button('gs__tab' + (i === 0 ? ' is-active' : ''), tabsBox);
      tab.setAttribute('data-gs-tab', String(i));
      tab.textContent = TAB_LABELS[i] ?? '';
      tabs.push(tab);
    }

    const body = div('gs__body', panel);
    const pageCollection = div('gs__page is-active', body);
    const pageLoadout = div('gs__page', body);
    const pageFusion = div('gs__page', body);

    // Collection — one card per registry entry, in definition order, so the
    // silhouette numbers are stable across sessions (SkillRegistry guarantee).
    const grid = div('gs__grid', pageCollection);
    const cards: CardDom[] = [];
    const defs = this.registry.all;
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      if (def === undefined) continue;
      const card = div('gs-card is-' + def.rarity, grid);
      const cardBody = div('gs-card__body', card);
      const cardName = div('gs-card__name', cardBody);
      cardName.textContent = def.name;
      const chip = span('gs-card__chip is-' + def.element, cardBody);
      chip.textContent = def.element.toUpperCase();
      const pipsBox = div('gs-card__pips', cardBody);
      const pips: HTMLSpanElement[] = [];
      for (let k = 0; k < MASTERY_LEVELS; k++) pips.push(span('gs-card__pip', pipsBox));
      const usesBox = div('gs-card__uses', cardBody);
      const uses = textIn(usesBox);
      const mask = div('gs-card__mask', card);
      const q = div('gs-card__mask-q', mask);
      q.textContent = '?';
      const num = div('gs-card__mask-num', mask);
      num.textContent = 'No.' + String(i + 1).padStart(2, '0');
      cards.push({ root: card, pips, uses, level: -1, usesValue: '' });
    }

    // Loadout — 4 slots, resonance readout, hint, known-skill pool.
    const slotsBox = div('gs__slots', pageLoadout);
    const slots: SlotDom[] = [];
    for (let s = 0; s < ACTIVE_SLOTS; s++) {
      const slotBtn = button('gs-slot is-empty', slotsBox);
      slotBtn.setAttribute('data-gs-slot', String(s));
      const key = span('gs-slot__key', slotBtn);
      key.textContent = 'SLOT ' + (s + 1);
      const nameBox = span('gs-slot__name', slotBtn);
      const label = textIn(nameBox);
      slots.push({ root: slotBtn, label, labelValue: '' });
    }
    const resonanceBox = div('gs__resonance', pageLoadout);
    const resonance = textIn(resonanceBox);
    const loadoutNoteBox = div('gs__note', pageLoadout);
    const loadoutNote = textIn(loadoutNoteBox);
    const poolList = div('gs__list', pageLoadout);
    const pool: RowDom[] = [];
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      if (def === undefined) continue;
      pool.push(this.buildRow(poolList, 'data-gs-pick', def.id, def.name, def.element));
    }

    // Fusion — A + B = result preview, confirm, eligible list.
    const picks = div('gs__fuse-picks', pageFusion);
    const fuseABox = div('gs-pickbox', picks);
    const fuseA = textIn(fuseABox);
    const opPlus = div('gs__fuse-op', picks);
    opPlus.textContent = '+';
    const fuseBBox = div('gs-pickbox', picks);
    const fuseB = textIn(fuseBBox);
    const opEq = div('gs__fuse-op', picks);
    opEq.textContent = '=';
    const fuseResultBox = div('gs-pickbox gs__fuse-result', picks);
    const fuseResult = textIn(fuseResultBox);
    const fuseConfirm = button('gs__fuse-confirm', pageFusion);
    fuseConfirm.setAttribute('data-gs-act', 'fuse');
    fuseConfirm.textContent = 'FUSE';
    fuseConfirm.disabled = true;
    const fuseNoteBox = div('gs__note', pageFusion);
    const fuseNote = textIn(fuseNoteBox);
    const fuseList = div('gs__list', pageFusion);
    const fuseRows: RowDom[] = [];
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      if (def === undefined) continue;
      fuseRows.push(this.buildRow(fuseList, 'data-gs-fuse', def.id, def.name, def.element));
    }

    this.mount.appendChild(root);
    return {
      root,
      counter,
      tabs,
      pages: [pageCollection, pageLoadout, pageFusion],
      cards,
      slots,
      poolList,
      pool,
      resonanceBox,
      resonance,
      loadoutNote,
      fuseRows,
      fuseABox,
      fuseA,
      fuseBBox,
      fuseB,
      fuseResultBox,
      fuseResult,
      fuseNote,
      fuseConfirm,
    };
  }

  private buildRow(
    parent: HTMLElement,
    attr: string,
    id: string,
    label: string,
    element: ElementId,
  ): RowDom {
    const row = button('gs-row', parent);
    row.setAttribute(attr, id);
    span('gs-row__dot is-' + element, row);
    const nameBox = span('gs-row__name', row);
    nameBox.textContent = label;
    const lvlBox = span('gs-row__lvl', row);
    const lvl = textIn(lvlBox);
    return { root: row, lvl, lvlValue: '' };
  }
}
