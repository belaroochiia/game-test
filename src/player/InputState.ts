/**
 * One mutable input struct, allocated once at boot. Producers (TouchControls,
 * KeyboardInput, test scripts) write into it; PlayerController and CameraRig read
 * it. Deliberately not an event stream: events allocate, and input needs to be
 * sampled at the fixed tick rate rather than delivered at pointer-event rate.
 */
export interface InputState {
  /** Left-stick vector in screen space, dead-zoned and clamped to |v| <= 1. */
  moveX: number;
  moveY: number;
  /** Look delta accumulated since the last tick, in radians. CameraRig zeroes it. */
  lookDX: number;
  lookDY: number;
  /** Held. */
  sprint: boolean;
  /** performance.now() of the press, -1 when empty. Edge-triggered via consumeBuffered. */
  dashQueuedAt: number;
  attackQueuedAt: number;
  /** Skill slots 0..3. Phase 4 consumes these. */
  skillQueuedAt: [number, number, number, number];
}

/** §7's input buffer: a press stays valid this long, so a slightly early tap still fires. */
export const INPUT_BUFFER_MS = 120;

const EMPTY = -1;

export function createInputState(): InputState {
  return {
    moveX: 0,
    moveY: 0,
    lookDX: 0,
    lookDY: 0,
    sprint: false,
    dashQueuedAt: EMPTY,
    attackQueuedAt: EMPTY,
    skillQueuedAt: [EMPTY, EMPTY, EMPTY, EMPTY],
  };
}

export function resetInputState(state: InputState): void {
  state.moveX = 0;
  state.moveY = 0;
  state.lookDX = 0;
  state.lookDY = 0;
  state.sprint = false;
  state.dashQueuedAt = EMPTY;
  state.attackQueuedAt = EMPTY;
  const skills = state.skillQueuedAt;
  skills[0] = EMPTY;
  skills[1] = EMPTY;
  skills[2] = EMPTY;
  skills[3] = EMPTY;
}

/**
 * Consumes a buffered press if it happened within `windowMs`. Returns true once
 * and clears the slot. A press older than the window is discarded rather than
 * fired late — a dash that comes out half a second after the tap feels worse than
 * one that never comes.
 */
export function consumeBuffered(
  state: InputState,
  field: 'dashQueuedAt' | 'attackQueuedAt',
  nowMs: number,
  windowMs: number = INPUT_BUFFER_MS,
): boolean {
  const queuedAt = state[field];
  if (queuedAt < 0) return false;
  const age = nowMs - queuedAt;
  state[field] = EMPTY;
  return age >= 0 && age <= windowMs;
}

export function consumeBufferedSkill(
  state: InputState,
  slot: number,
  nowMs: number,
  windowMs: number = INPUT_BUFFER_MS,
): boolean {
  if (slot < 0 || slot > 3) return false;
  const skills = state.skillQueuedAt;
  const queuedAt = skills[slot];
  if (queuedAt === undefined || queuedAt < 0) return false;
  const age = nowMs - queuedAt;
  skills[slot] = EMPTY;
  return age >= 0 && age <= windowMs;
}
