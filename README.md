# Arcanum Drift

Mini open-world 3D · medieval magic · anime skill collection · **mobile-first**.

The full design doc is [`CLAUDE.md`](./CLAUDE.md) — it is the source of truth for
scope, performance budgets and anti-patterns. Work proceeds **one phase per
session** and a phase is not done until its acceptance criterion is met on a real
phone.

> **Status: Phase 1 — Player moves in the world. Complete and device-verified.**
> Phases 2–7 are not started. Do not add features from a later phase before the
> current one's acceptance criterion is verified on hardware (§12, §13).

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
npm run smoke      # headless boot + budget check against dist/ (see caveat below)
npm run playtest   # headless gameplay gate: drives the player, measures §7's numbers
```

Desktop controls for development: **WASD** move, **Shift** sprint, **Space** dash,
**J** or left-click attack, **1–4** skills, **mouse drag** look, **P** toggles the
profiler overlay.

## What exists

```
src/
  main.ts                  bootstrap: world assembly, system order, debug hook
  core/                    [Phase 0]
    Engine.ts              renderer + scene + camera + system list + frame wiring
    Loop.ts                fixed 60 Hz logic accumulator, uncapped interpolated render
    DynamicResolution.ts   adaptive pixel-ratio ladder driven by smoothed frame time
    Profiler.ts            FPS / frame / CPU / draws / tris / heap DOM overlay
    EventBus.ts            typed, allocation-free, re-entrancy safe pub-sub
    ObjectPool.ts          generic pool with hard cap and high-water tracking
  world/                   [Phase 1]
    TerrainGen.ts          seeded value-noise heightmap, vertex-coloured, analytic sampling
    SpatialHash.ts         5x5 grid of AABBs for prop collision, allocation-free queries
  player/                  [Phase 1]
    PlayerController.ts    capsule movement, state machine, terrain + prop collision
    CameraRig.ts           third-person orbit, collision-aware, sprint FOV, screen shake
    PlayerAvatar.ts        blocky procedural character + the GLTF swap seam (§5)
    PlayerStats.ts         §10's five stats, HP/MP pools, mana regen
    InputState.ts          the one input struct, with §7's 0.12 s input buffer
  input/KeyboardInput.ts   [Phase 1] desktop input; also what the playtest drives
  ui/                      [Phase 1]
    TouchControls.ts       dynamic joystick, camera zone, skill/attack/dash buttons
    HUD.ts                 HP/MP bars, level chip, icon row
  styles/
    main.css               game-surface CSS: no scroll, no zoom, safe-area aware
    game-ui.css            HUD + touch control layout
tools/
  smoke.mjs                headless boot and budget gate
  playtest.mjs             headless gameplay gate: measures §7's movement numbers
```

### Phase 1 notes

- **Terrain height is exact, not approximate.** `heightAt()` returns the plane of
  the triangle the GPU actually draws — it picks the triangle from the quad's
  diagonal split and interpolates barycentrically. Bilinear interpolation over the
  quad would look smooth and be wrong, making the player float on one half of
  every quad and sink on the other. Verified: max disagreement between
  `heightAt()` and the mesh over 20 000 random points is **1.8e-15**.
- **There is no jump.** §7 asks for coyote time "for jump/dash", but §6's control
  layout has no jump button, so the game has no jump. Coyote time is applied to
  **dash** instead: it stays available for 0.1 s after leaving the ground.
- **Soft target lock (§6.6) is deferred to Phase 3.** It needs enemy positions and
  there are no enemies yet. Stubbing a fake version would have been worse than
  waiting.
- Skill buttons carry placeholder costs and cooldowns so their cooldown sweep and
  no-mana states are real and visible. `SkillRegistry` replaces those in Phase 4.
- Test obstacles are one `InstancedMesh` of 24 boxes registered in the spatial
  hash — enough to prove §7's push-out works. `PropScatter` replaces it in Phase 2.

### Engine conventions worth knowing before Phase 1

- **Fixed timestep 60 Hz** (`FIXED_HZ` in `core/Loop.ts` — see the decision
  below). `System.update(dt)` is always called with `dt = 1/60`; visual
  smoothing belongs in the optional `System.render(alpha)`, where `alpha` is the
  interpolation factor between the last two ticks. Never move anything by "per
  frame" amounts (§4.2).
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

## Measured — Phase 1 (headless gate)

`npm run playtest` drives the player through the debug hook and measures §7's
numbers. **24/24 checks pass.** Software rendering, so the timings are not device
numbers — everything else here is real:

| Measured | Value | Required |
|---|---|---|
| Walk speed | **4.00 u/s** | 4 ±12 % |
| Sprint speed | **7.00 u/s** | 7 ±12 % |
| Dash peak speed | **14.00 u/s** | > 12 |
| Dash burst | 0.148 s | 0.18 ±0.04 |
| Dash i-frame | 0.138 s | 0.15 ±0.05 |
| Second dash inside 1.2 s | refused | refused |
| Worst ground deviation | **0.0000 u** | < 0.12 |
| Worst camera clearance | **0.360 u** | > 0.2 |
| Sprint FOV | 72.0° | ~72 |
| 45° slope net climb | 0.22 u over 2.5 s | < 2.5 |
| Draw calls | **9** | ≤ 110 |
| Triangles | **5 372** | ≤ 150 000 |
| Heap | 3.7 MB | ≤ 280 |
| Tick rate | 60.0 /s | 60 |
| Heap drift | **0 B/frame** | ~0 |
| Multi-touch stick + button | both registered | both |

The dash burst and i-frame read slightly short because the sampler counts
rendered frames, not ticks, so it quantises to the frame interval; the underlying
timers are 0.18 s and 0.15 s exactly.

**Device-verified** on the 120 Hz Android handset: the joystick walks the
character, dash reads as a burst rather than a teleport, and the cooldown sweep
runs. §12's Phase 1 criterion is met.

### The bug the gate let through, and what changed because of it

Phase 1 shipped once with the joystick lighting up but never moving the player.
`TouchControls` wrote the axes from inside the `pointermove` handler, and a thumb
resting at full deflection fires no further pointer events — so `KeyboardInput`,
which runs earlier in the tick order and clears the axes unconditionally, won on
every subsequent tick. Holding a direction is the normal case, so movement was
broken for essentially all real input.

The gate passed anyway, for two reasons worth remembering:

- It drove input with `dispatchEvent`, which **bypasses hit-testing entirely**.
  Synthetic events therefore cannot prove a control is reachable, only that a
  handler works when called.
- It asserted on CSS classes — that the stick lit up — instead of on the outcome,
  that the player moved. Its own output reported `0.10 u/s` and that was not
  followed up.

`tools/playtest.mjs` now drives real touch through CDP with the thumb **held
still** after the drag, and asserts outcomes: the player walks, releasing stops
it, and dash/attack/skill each produce their state change. Reverting the fix
makes that check fail, so it has teeth.

Rule for later phases: **an input check that never exercises the browser's own
hit-testing is not a check.** Assert on what the player would notice.

Triangle budget breakdown: terrain 5 000, obstacles 288, avatar 84. Draw calls:
terrain 1, obstacles 1 (instanced), avatar 7.

**Still required: the device test.** §12's acceptance criterion is thumb feel, and
no headless gate can measure that.

## Measured — Phase 0

Android handset, 120 Hz panel, Chromium-based browser, portrait, `npm run dev`
over LAN:

| Metric | Measured | §3 budget |
|---|---|---|
| FPS | **120.0** | ≥ 60 |
| Frame time | **8.3 ms** (max 8.4) | ≤ 16.6 |
| CPU (logic + render) | **0.2 ms** | — |
| Draw calls | **2** | ≤ 110 |
| Triangles | **14** | ≤ 150 000 |
| Unique materials | 2 | ≤ 12 |
| Texture memory | 0 MB | ≤ 48 MB |
| JS heap | **16 MB** | ≤ 280 MB |
| Drawing buffer | 576×984 @1.50 | pixel ratio ≤ 1.5 |
| Fixed tick rate | **30 /s** | 30 Hz (see below) |
| Bundle | 137 kB gzip | ≤ 8 MB |

Phase 0's acceptance criterion is met. Two honest caveats:

- This handset is **not** §3's reference device (Snapdragon 680 / Helio G85). A
  14-triangle scene at 8.3 ms proves the boot path, the loop and the overlay are
  correct; it proves nothing about whether the budget holds at 150 000 triangles
  and 110 draw calls. Re-measure at the end of every phase, and on the weakest
  device you can find.
- Dynamic resolution scaling never engaged here because nothing was ever slow
  enough. It was verified separately under software rendering, where frame time
  rose to 87 ms and the ladder stepped 1.50 → 1.25 on its own.

This run was captured **before** the tick rate moved to 60 Hz, so `TICK` reads
`30 /s` above. Everything else is unaffected — the tick rate touches CPU, and
CPU was 0.2 ms of a 8.3 ms frame. Re-measure at the end of Phase 1, when there
is finally something worth measuring.

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

## Decided: 60 Hz fixed tick (deviates from §4.2)

`FIXED_HZ = 60` in `core/Loop.ts`. This is an approved deviation from §4.2's
30 Hz, taken before Phase 1 so `PlayerController` could be written against the
final tick length. 30 Hz has concrete costs for the mechanics the doc itself
specifies:

- One tick is 33 ms — 22 % of §7's 0.15 s dash i-frame and 28 % of its 0.12 s
  input buffer. The "enak" feel §7 is aiming for gets quantised away.
- §9's 60–90 ms hitstop collapses to 2–3 indistinguishable ticks.
- A 14 u/s dash advances 0.47 u per tick against a 0.4-radius capsule, so the
  player can tunnel through thin props (§7's collision is discrete, not swept).

Also worth knowing: on the 120 Hz handset this was measured on, 30 Hz logic means
**four rendered frames per logic tick** — input sampled once every four frames
the player actually sees. Interpolation hides that for a spinning cube. It does
not hide it for a dash.

Logic for one player plus §9's 18-enemy cap is nowhere near the CPU budget — the
whole frame measured 0.2 ms of CPU on device, and §3's budget is a *GPU* budget.
A Snapdragon 680 is GPU-bound here too, so doubling the tick rate is close to
free.

**What this obliges us to do from Phase 5:** stagger the systems that are
expensive but tolerate latency onto even ticks — AI, status effects, spawn
director — which §9 already asks for. Movement, collision, camera and hitboxes
run every tick; those are what the extra rate buys. If a later phase blows the
CPU budget, staggering is the first lever, not reverting the tick rate.
