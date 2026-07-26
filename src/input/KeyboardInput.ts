import type { System } from '../core/Engine';
import type { InputState } from '../player/InputState';

/**
 * Desktop input. Not shipped-facing — §6's thumb controls are the real interface —
 * but it is what the automated playtest drives to measure §7's movement numbers,
 * and it makes development on a laptop bearable.
 */

interface HeldKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
}

export class KeyboardInput implements System {
  readonly name = 'keyboard';

  private readonly input: InputState;
  private readonly held: HeldKeys = {
    forward: false,
    back: false,
    left: false,
    right: false,
    sprint: false,
  };

  private mouseLookActive = false;
  private lastMouseX = 0;
  private lastMouseY = 0;

  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private readonly onKeyUp: (event: KeyboardEvent) => void;
  private readonly onBlur: () => void;
  private readonly onPointerDown: (event: PointerEvent) => void;
  private readonly onPointerMove: (event: PointerEvent) => void;
  private readonly onPointerUp: (event: PointerEvent) => void;

  constructor(input: InputState) {
    this.input = input;

    this.onKeyDown = (event: KeyboardEvent): void => {
      // Repeats would re-queue dash every few milliseconds.
      if (event.repeat) return;
      if (this.setKey(event.code, true)) event.preventDefault();

      const now = performance.now();
      if (event.code === 'Space') {
        this.input.dashQueuedAt = now;
        event.preventDefault();
      } else if (event.code === 'KeyJ') {
        this.input.attackQueuedAt = now;
      } else if (event.code.startsWith('Digit')) {
        const slot = Number.parseInt(event.code.slice(5), 10) - 1;
        if (slot >= 0 && slot <= 3) this.input.skillQueuedAt[slot] = now;
      }
    };

    this.onKeyUp = (event: KeyboardEvent): void => {
      this.setKey(event.code, false);
    };

    // Without this the player walks forever after an alt-tab: the keyup never lands.
    this.onBlur = (): void => {
      this.held.forward = false;
      this.held.back = false;
      this.held.left = false;
      this.held.right = false;
      this.held.sprint = false;
      this.mouseLookActive = false;
    };

    this.onPointerDown = (event: PointerEvent): void => {
      // Only the mouse, and only on the canvas — touch belongs to TouchControls.
      if (event.pointerType !== 'mouse') return;
      if (!(event.target instanceof HTMLCanvasElement)) return;
      if (event.button === 0) this.input.attackQueuedAt = performance.now();
      this.mouseLookActive = true;
      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;
    };

    this.onPointerMove = (event: PointerEvent): void => {
      if (!this.mouseLookActive || event.pointerType !== 'mouse') return;
      this.input.lookDX += event.clientX - this.lastMouseX;
      this.input.lookDY += event.clientY - this.lastMouseY;
      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;
    };

    this.onPointerUp = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse') return;
      this.mouseLookActive = false;
    };

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  /** Returns true when the code was one we consume. */
  private setKey(code: string, down: boolean): boolean {
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        this.held.forward = down;
        return true;
      case 'KeyS':
      case 'ArrowDown':
        this.held.back = down;
        return true;
      case 'KeyA':
      case 'ArrowLeft':
        this.held.left = down;
        return true;
      case 'KeyD':
      case 'ArrowRight':
        this.held.right = down;
        return true;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.held.sprint = down;
        return true;
      default:
        return false;
    }
  }

  update(): void {
    const held = this.held;
    let x = 0;
    let y = 0;
    if (held.left) x -= 1;
    if (held.right) x += 1;
    if (held.forward) y -= 1;
    if (held.back) y += 1;

    // Normalise, or diagonals would be 41 % faster.
    if (x !== 0 && y !== 0) {
      const inv = Math.SQRT1_2;
      x *= inv;
      y *= inv;
    }

    this.input.moveX = x;
    this.input.moveY = y;
    this.input.sprint = held.sprint;
  }

  reset(): void {
    this.onBlur();
    this.input.moveX = 0;
    this.input.moveY = 0;
    this.input.sprint = false;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }
}
