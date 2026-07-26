# Arcanum Drift

Mini open-world 3D · medieval magic · anime skill collection · **mobile-first**.

The full design doc is [`CLAUDE.md`](./CLAUDE.md) — it is the source of truth for
scope, performance budgets and anti-patterns. Work proceeds **one phase per
session** and a phase is not done until its acceptance criterion is met on a real
phone.

> **Status: Phase 0 — Foundation. Complete.**
> Phases 1–7 are not started. Do not add gameplay features before Phase 0's
> acceptance criterion is verified on hardware (§12, §13).

## Stack

| | |
|---|---|
| Renderer | three.js `0.185.x` (ES modules) |
| Language | TypeScript 7, `strict` + `noUncheckedIndexedAccess` + `erasableSyntaxOnly` |
| Bundler | Vite 8 |
| Physics | none — custom collision comes in Phase 1 (§7) |
| UI | DOM/CSS overlay above the canvas, never inside WebGL (§2) |

No physics engine, no postprocessing stack, no React, no state library, zero
runtime dependencies besides three.js.

## Quick start

```bash
npm install
npm run dev        # Vite with --host, so a phone on the same Wi-Fi can open it
```

Then open the **Network** URL Vite prints (e.g. `http://192.168.1.20:5173`) on
your phone. Desktop DevTools device mode is *not* a substitute (§13).

```bash
npm run typecheck  # tsc --noEmit, strict
npm run build      # typecheck + production bundle into dist/
npm run preview    # serve dist/ over the LAN
npm run smoke      # headless Chromium budget check against dist/ (see caveat below)
```

## What Phase 0 contains

```
src/
  main.ts                  bootstrap, WebGL2 guard, debug hook, the spinning cube
  core/
    Engine.ts              renderer + scene + camera + system list + frame wiring
    Loop.ts                fixed 30 Hz logic accumulator, uncapped interpolated render
    DynamicResolution.ts   adaptive pixel-ratio ladder driven by smoothed frame time
    Profiler.ts            FPS / frame / CPU / draws / tris / heap DOM overlay
    EventBus.ts            typed, allocation-free, re-entrancy safe pub-sub
    ObjectPool.ts          generic pool with hard cap and high-water tracking
  styles/main.css          game-surface CSS: no scroll, no zoom, safe-area aware
tools/smoke.mjs            headless verification harness
```

### Engine conventions worth knowing before Phase 1

- **Fixed timestep 30 Hz.** `System.update(dt)` is always called with
  `dt = 1/30`; visual smoothing belongs in the optional `System.render(alpha)`,
  where `alpha` is the interpolation factor between the last two ticks. Never
  move anything by "per frame" amounts (§4.2).
- **Systems, not singletons.** `engine.addSystem({ name, update, reset })`.
  `Engine` is the only global-ish object (§4.4). Adding or removing a system
  during a tick is deferred to the end of that tick, so it is safe.
- **Zero allocation per frame.** Nothing reachable from the loop may allocate —
  no `new THREE.Vector3()`, no array literals, no closures, no template strings.
  Use module-scope scratch objects and `ObjectPool` (§13). The smoke test prints
  JS-heap drift as an early warning.
- **Pixel ratio is owned by `DynamicResolution`.** Call `engine.resize()`; never
  call `renderer.setPixelRatio()` from gameplay code.
- **The overlay tells the truth.** Rows turn amber within 10 % of a §3 budget and
  red past it. If a row is red on your phone, that is the bug — fix it before
  adding content.

### Debug controls

- `DBG` button (top-right) or the `P` key toggles the profiler overlay.
- `?debug=0` starts with the overlay hidden.
- `window.__ARCANUM_DEBUG__` exposes `metrics()`, `frameCount()`, `tickCount()`,
  `elapsed()`, `toggleDebug()`, `setPixelRatio(ladderIndex)` — the smoke test
  drives the game through it.

## Verifying on a real device

1. `npm run dev`, open the Network URL on the phone, hold it in landscape.
2. The cube should spin perfectly smoothly. Any visible stutter means the loop or
   the interpolation is wrong — that is a Phase 0 bug, not a phone problem.
3. Read the overlay: `FPS` ≈ 60 (or the panel's refresh rate), `DRAWS` 2,
   `TRIS` 14, `RES` showing the drawing buffer and applied pixel ratio.
4. Lock the screen and unlock it, or switch tabs and come back: the loop pauses
   while hidden and resumes without fast-forwarding (the cube must not jump).
5. Rotate the device: the canvas re-fits with no stretching and no black bars.

### Caveat on `npm run smoke`

The smoke test runs Chromium with SwiftShader **software** rendering, because CI
containers have no GPU. It is a correctness and budget gate — draw calls,
triangle count, absence of console errors, monotonic frame counter, heap drift.
Its FPS number is meaningless as a device measurement. Only a phone can tell you
whether the frame budget in §3 is met.

## Known deviations from `CLAUDE.md`

- **§2 "fallback WebGL 1" is not implementable.** three.js removed WebGL 1
  support in r163 (`WebGL1Renderer` is gone), so a WebGL2-capable browser is a
  hard requirement. The engine detects the absence of WebGL 2 up front and shows
  a plain-language message instead of failing silently. In practice this costs
  almost nothing: WebGL 2 has been available in Chrome Android since 2017 and in
  iOS Safari since 15 (2021).
- `src/core/DynamicResolution.ts` is not in the §4 file tree. Adaptive resolution
  is listed as Phase 0 work, and it needs its own hysteresis state, so it lives
  in a dedicated file with the standard `update`/`reset` shape rather than
  bloating `Engine.ts`.
- The profiler's `FRAME` row warns at **17.5 ms**, not §3's literal 16.6 ms. A
  healthy vsync-locked 60 Hz device averages 16.67 ms, so gating at 16.6 would
  paint the row amber permanently and train us to ignore it. The red threshold is
  still §3's 33 ms floor.
- `§3 "0 byte per frame"` is honoured for **our** code. three.js's own
  `render()` allocates internally, so the absolute figure is unreachable; the
  smoke test therefore reports heap *drift*, which is the number that matters.

## Open decision before Phase 1

**Fixed tick rate: 30 Hz (as specified) or 60 Hz?** Phase 0 ships §4.2's 30 Hz
because the doc mandates it, and `Loop` takes `fixedDt` as an option so it is a
one-line change in `Engine`. But 30 Hz has concrete costs for the mechanics the
doc itself specifies:

- One tick is 33 ms — 22 % of §7's 0.15 s dash i-frame and 28 % of its 0.12 s
  input buffer. The "enak" feel §7 is aiming for gets quantised away.
- §9's 60–90 ms hitstop collapses to 2–3 indistinguishable ticks.
- A 14 u/s dash advances 0.47 u per tick against a 0.4-radius capsule, so the
  player can tunnel through thin props (§7's collision is discrete, not swept).

Logic for one player plus §9's 18-enemy cap is nowhere near the CPU budget — a
Snapdragon 680 is GPU-bound here, and §3's budget is a *GPU* budget. The
recommendation is `FIXED_HZ = 60` with tick-parity staggering: movement,
collision, camera and hitboxes every tick; AI, status effects and spawning on
even ticks, which §9 already asks for. Decide this before `PlayerController`
exists, because dash, coyote time and the input buffer are all written against
the tick length.
