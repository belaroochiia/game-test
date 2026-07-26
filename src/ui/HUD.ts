import type { System } from '../core/Engine';
import type { PlayerStats } from '../player/PlayerStats';

/**
 * §6's top-left status block. Same discipline as Profiler: the DOM is built once
 * and only written when a value actually changed, and the bars are driven with
 * `transform: scaleX` rather than `width`, which would reflow every frame.
 */

export interface HUDOptions {
  mount: HTMLElement;
  stats: PlayerStats;
}

/** Bar changes below this fraction are invisible; skip the style write. */
const EPSILON = 0.002;

export class HUD implements System {
  readonly name = 'hud';

  private readonly stats: PlayerStats;
  private readonly root: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly manaFill: HTMLDivElement;
  private readonly hpText: Text;
  private readonly manaText: Text;
  private readonly levelText: Text;

  private lastHp = -1;
  private lastMana = -1;
  private lastHpLabel = -1;
  private lastManaLabel = -1;
  private lastLevel = -1;

  constructor(options: HUDOptions) {
    this.stats = options.stats;

    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.id = 'hud';

    const vitals = document.createElement('div');
    vitals.className = 'hud__vitals';

    const hpBar = document.createElement('div');
    hpBar.className = 'hud__bar hud__bar--hp';
    this.hpFill = document.createElement('div');
    this.hpFill.className = 'hud__bar-fill';
    const hpLabel = document.createElement('span');
    hpLabel.className = 'hud__bar-label';
    this.hpText = document.createTextNode('');
    hpLabel.appendChild(this.hpText);
    hpBar.appendChild(this.hpFill);
    hpBar.appendChild(hpLabel);

    const manaBar = document.createElement('div');
    manaBar.className = 'hud__bar hud__bar--mana';
    this.manaFill = document.createElement('div');
    this.manaFill.className = 'hud__bar-fill';
    const manaLabel = document.createElement('span');
    manaLabel.className = 'hud__bar-label';
    this.manaText = document.createTextNode('');
    manaLabel.appendChild(this.manaText);
    manaBar.appendChild(this.manaFill);
    manaBar.appendChild(manaLabel);

    vitals.appendChild(hpBar);
    vitals.appendChild(manaBar);

    const level = document.createElement('div');
    level.className = 'hud__level';
    this.levelText = document.createTextNode('');
    level.appendChild(this.levelText);

    this.root.appendChild(vitals);
    this.root.appendChild(level);

    // §6's top-right icon row. Inert until the screens they open exist (Phase 4/6).
    const icons = document.createElement('div');
    icons.className = 'hud__icons';
    const labels = ['⚙', '🗺', '📖'];
    const names = ['Settings', 'Map', 'Grimoire'];
    for (let i = 0; i < labels.length; i++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hud__icon';
      button.textContent = labels[i] ?? '';
      button.setAttribute('aria-label', names[i] ?? '');
      button.disabled = true;
      icons.appendChild(button);
    }
    this.root.appendChild(icons);

    options.mount.appendChild(this.root);
    this.update(0);
  }

  update(_dt: number): void {
    const stats = this.stats;

    const hp = stats.hpFraction;
    if (Math.abs(hp - this.lastHp) > EPSILON) {
      this.lastHp = hp;
      this.hpFill.style.transform = 'scaleX(' + hp + ')';
    }

    const mana = stats.manaFraction;
    if (Math.abs(mana - this.lastMana) > EPSILON) {
      this.lastMana = mana;
      this.manaFill.style.transform = 'scaleX(' + mana + ')';
    }

    // Numbers only change on whole points, so gate the string build on those.
    const hpRounded = Math.ceil(stats.hp);
    if (hpRounded !== this.lastHpLabel) {
      this.lastHpLabel = hpRounded;
      this.hpText.nodeValue = hpRounded + ' / ' + Math.round(stats.maxHp);
    }

    const manaRounded = Math.floor(stats.mana);
    if (manaRounded !== this.lastManaLabel) {
      this.lastManaLabel = manaRounded;
      this.manaText.nodeValue = manaRounded + ' / ' + Math.round(stats.maxMana);
    }

    if (stats.level !== this.lastLevel) {
      this.lastLevel = stats.level;
      this.levelText.nodeValue = 'Lv.' + stats.level;
    }
  }

  reset(): void {
    this.lastHp = -1;
    this.lastMana = -1;
    this.lastHpLabel = -1;
    this.lastManaLabel = -1;
    this.lastLevel = -1;
    this.update(0);
  }

  dispose(): void {
    this.root.remove();
  }
}
