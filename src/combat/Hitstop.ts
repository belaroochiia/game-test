import type { System } from '../core/Engine';

/**
 * §9's hitstop: freeze the FIGHT, not the world. Gated systems (player,
 * enemies) early-return their update while `active`; camera, sky, water,
 * chunks, HUD and render interpolation are NOT gated and keep running. The
 * contrast between a frozen fight and a breathing world is what makes 4 ticks
 * read as impact — freezing everything would just look like a dropped frame.
 *
 * The integrator orders this system BEFORE every gated one, so `active` is
 * consistent across a whole tick: each tick is either fully frozen or fully
 * live for every gated system.
 */
export class Hitstop implements System {
  readonly name = 'hitstop';

  private ticks = 0;
  private frozen = false;

  /**
   * Freeze gated systems for `ticks` fixed ticks. Extends, never shortens — a
   * light hit landing during a heavy freeze must not cut the heavy one short.
   */
  trigger(ticks: number): void {
    if (ticks <= 0) return;
    // Fractional requests round up: erring long reads better (§9).
    const whole = Math.ceil(ticks);
    if (whole > this.ticks) this.ticks = whole;
    // The freeze starts mid-tick, on the hit itself, for systems yet to run.
    this.frozen = true;
  }

  /** True while frozen. Gated systems early-return their update when so. */
  get active(): boolean {
    return this.frozen;
  }

  get ticksLeft(): number {
    return this.ticks;
  }

  /**
   * Counts down ONCE per tick; must run FIRST in the system order. A tick is
   * frozen when any time remained at its start, so trigger(n) yields exactly n
   * fully frozen ticks after the (partially frozen) tick that landed the hit —
   * testing the post-decrement count instead would shortchange it by one.
   */
  update(): void {
    this.frozen = this.ticks > 0;
    if (this.ticks > 0) this.ticks--;
  }

  reset(): void {
    this.ticks = 0;
    this.frozen = false;
  }
}
