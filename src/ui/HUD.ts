import type { System } from '../core/Engine';
import type { PlayerStats } from '../player/PlayerStats';

/**
 * §6's status block: HP bar, MP bar, level chip, and the top-right icon row.
 *
 * Same discipline as `core/Profiler`: the DOM is built exactly once, every
 * mutable leaf is kept as a `Text` node or an element reference, and a write
 * only happens when the value it represents actually changed. Nothing here
 * queries layout, so the HUD never forces a reflow.
 *
 * Bars are driven by `transform: scaleX()`. `width` would invalidate layout for
 * the whole overlay every time the player is hit, which is the difference
 * between a free HUD and one that costs a millisecond a frame (§13).
 */

export interface HUDOptions {
  mount: HTMLElement;
  stats: PlayerStats;
}

interface BarDom {
  readonly row: HTMLDivElement;
  readonly fill: HTMLSpanElement;
  readonly num: Text;
}

interface HudDom {
  readonly root: HTMLDivElement;
  readonly hp: BarDom;
  readonly mp: BarDom;
  readonly level: Text;
}

/**
 * DOM refresh rate. Mana regenerates continuously, so an unthrottled HUD would
 * build strings 60x/s forever; 10x/s is past the point where a bar looks
 * stepped, and the transform writes below are additionally gated on change.
 */
const REFRESH_MS = 100;

/**
 * Bar fills are quantised to this many steps before being written. 256 steps
 * across a ~230 px bar is sub-pixel, and a power of two keeps `step / STEPS` an
 * exact short decimal — so the string built for `scaleX()` stays tiny instead of
 * turning into 17 significant digits.
 */
const BAR_STEPS = 256;

/** §5's readability rule: below this the HP bar pulses so it reads peripherally. */
const CRITICAL_FRACTION = 0.3;

const SCALE_OPEN = 'scaleX(';
const SCALE_CLOSE = ')';

/** Tri-state cache so the first refresh always writes (cf. Profiler's STATE_DIRTY). */
const DIRTY = -1;

function clamp01(value: number): number {
  if (!(value > 0)) return 0; // also catches NaN
  if (value > 1) return 1;
  return value;
}

function makeBar(parent: HTMLElement, modifier: string, label: string): BarDom {
  const row = document.createElement('div');
  row.className = 'hud__bar hud__bar--' + modifier;

  const key = document.createElement('span');
  key.className = 'hud__bar-key';
  key.appendChild(document.createTextNode(label));

  const track = document.createElement('span');
  track.className = 'hud__bar-track';

  const fill = document.createElement('span');
  fill.className = 'hud__bar-fill';

  const numBox = document.createElement('span');
  numBox.className = 'hud__bar-num';
  const num = document.createTextNode('');
  numBox.appendChild(num);

  // Fill first: the readout paints over it.
  track.appendChild(fill);
  track.appendChild(numBox);
  row.appendChild(key);
  row.appendChild(track);
  parent.appendChild(row);

  return { row, fill, num };
}

/**
 * §6's ⚙ 🗺 📖 row. Deliberately listener-free: the screens they open are Phase
 * 4/6 work, and an empty handler now is just a closure to forget about later.
 * They stay enabled so they keep `.hud-btn`'s press feedback and do not read as
 * broken chrome; `aria-disabled` tells assistive tech the truth.
 */
function makeIcon(parent: HTMLElement, action: string, glyph: string, label: string): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hud-btn hud__icon';
  button.setAttribute('data-action', action);
  button.setAttribute('data-todo', 'phase6');
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-disabled', 'true');
  button.appendChild(document.createTextNode(glyph));
  parent.appendChild(button);
}

export class HUD implements System {
  readonly name = 'hud';

  private readonly stats: PlayerStats;
  private dom: HudDom | undefined;

  private refreshAcc = 0;

  private hpStep = DIRTY;
  private mpStep = DIRTY;
  private hpShown = DIRTY;
  private maxHpShown = DIRTY;
  private mpShown = DIRTY;
  private maxMpShown = DIRTY;
  private levelShown = DIRTY;
  private criticalState = DIRTY;

  constructor(options: HUDOptions) {
    this.stats = options.stats;

    const root = document.createElement('div');
    root.id = 'hud';
    root.className = 'hud';

    const vitals = document.createElement('div');
    vitals.className = 'hud__vitals';

    const bars = document.createElement('div');
    bars.className = 'hud__bars';
    const hp = makeBar(bars, 'hp', 'HP');
    const mp = makeBar(bars, 'mp', 'MP');
    vitals.appendChild(bars);

    const levelChip = document.createElement('div');
    levelChip.className = 'hud__level';
    const levelKey = document.createElement('span');
    levelKey.className = 'hud__level-key';
    levelKey.appendChild(document.createTextNode('LV'));
    const levelBox = document.createElement('span');
    levelBox.className = 'hud__level-num';
    const level = document.createTextNode('');
    levelBox.appendChild(level);
    levelChip.appendChild(levelKey);
    levelChip.appendChild(levelBox);
    vitals.appendChild(levelChip);

    const icons = document.createElement('div');
    icons.className = 'hud__icons';
    makeIcon(icons, 'settings', '⚙', 'Settings');
    makeIcon(icons, 'map', '\u{1F5FA}', 'Map');
    makeIcon(icons, 'grimoire', '\u{1F4D6}', 'Grimoire');

    root.appendChild(vitals);
    root.appendChild(icons);
    options.mount.appendChild(root);

    this.dom = { root, hp, mp, level };
    // Paint once now so the first frame never shows a full bar over empty stats.
    this.refresh();
  }

  update(dt: number): void {
    this.refreshAcc += dt * 1000;
    if (this.refreshAcc < REFRESH_MS) return;
    // Reset rather than subtract: after a stall we want one refresh, not a burst.
    this.refreshAcc = 0;
    this.refresh();
  }

  reset(): void {
    this.hpStep = DIRTY;
    this.mpStep = DIRTY;
    this.hpShown = DIRTY;
    this.maxHpShown = DIRTY;
    this.mpShown = DIRTY;
    this.maxMpShown = DIRTY;
    this.levelShown = DIRTY;
    this.criticalState = DIRTY;
    this.refreshAcc = 0;
    this.refresh();
  }

  dispose(): void {
    const dom = this.dom;
    if (dom === undefined) return;
    dom.root.remove();
    this.dom = undefined;
  }

  private refresh(): void {
    const dom = this.dom;
    if (dom === undefined) return;
    const stats = this.stats;

    const hpStep = Math.round(clamp01(stats.hpFraction) * BAR_STEPS);
    if (hpStep !== this.hpStep) {
      this.hpStep = hpStep;
      dom.hp.fill.style.transform = SCALE_OPEN + hpStep / BAR_STEPS + SCALE_CLOSE;
    }

    const mpStep = Math.round(clamp01(stats.manaFraction) * BAR_STEPS);
    if (mpStep !== this.mpStep) {
      this.mpStep = mpStep;
      dom.mp.fill.style.transform = SCALE_OPEN + mpStep / BAR_STEPS + SCALE_CLOSE;
    }

    // Ceil HP so a sliver of health never reads as 0; floor mana so a spend that
    // is one hundredth short never reads as affordable.
    const hp = Math.ceil(stats.hp);
    const maxHp = Math.round(stats.maxHp);
    if (hp !== this.hpShown || maxHp !== this.maxHpShown) {
      this.hpShown = hp;
      this.maxHpShown = maxHp;
      dom.hp.num.nodeValue = hp + '/' + maxHp;
    }

    const mp = Math.floor(stats.mana);
    const maxMp = Math.round(stats.maxMana);
    if (mp !== this.mpShown || maxMp !== this.maxMpShown) {
      this.mpShown = mp;
      this.maxMpShown = maxMp;
      dom.mp.num.nodeValue = mp + '/' + maxMp;
    }

    const level = stats.level;
    if (level !== this.levelShown) {
      this.levelShown = level;
      dom.level.nodeValue = String(level);
    }

    // Only touch classList on a real transition, so style is not invalidated 10x/s.
    const critical = stats.hp > 0 && stats.hpFraction <= CRITICAL_FRACTION ? 1 : 0;
    if (critical !== this.criticalState) {
      this.criticalState = critical;
      dom.hp.row.classList.toggle('is-critical', critical === 1);
    }
  }
}
