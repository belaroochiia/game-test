# Arcanum Drift

Mini open-world 3D · medieval magic · anime skill collection · **mobile-first**.

The full design doc is [`CLAUDE.md`](./CLAUDE.md) — it is the source of truth for
scope, performance budgets and anti-patterns. Work proceeds **one phase per
session** and a phase is not done until its acceptance criterion is met on a real
phone.

> **Status: Phase 5 — the filled world. Code-complete, all six headless gates
> green. Awaiting device verification** (§12: 20 minutes of exploration without
> emptiness or repetition — a feel judgement only a phone can make).
> Phases 6–7 are not started. Do not add features from a later phase before the
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
npm run worldtest  # streaming, LOD, biomes, day-night, water, budgets on a world walk
npm run combattest # melee combo, telegraphs, i-frames, hitstop, death/respawn, seeds
npm run skilltest  # the Grimoire: every skill from JSON, reactions, mastery, fusion
npm run contenttest# Phase 5 content: regions, director, bestiary, shrines, boss Vael
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
  world/
    TerrainGen.ts          [P1] seeded value-noise heightmap, vertex-coloured, analytic
    SpatialHash.ts         [P1] 5x5 grid of AABBs for prop collision, allocation-free
    HeightField.ts         [P2] world-space height/tint sampling, region-aware
    BiomeTable.ts          [P2→5] the five §5 regions as priority-chain masks
    ChunkManager.ts        [P2] 5x5 streaming, LOD0/LOD1, pooled geometry, culling
    PropScatter.ts         [P2→5] instanced props, deterministic per (seed, chunk)
    SkyDayNight.ts         [P2] 12-minute cycle from 4 keyframes; fog, sun, ambient
    Water.ts               [P2] one displaced plane, 2-colour gradient + fresnel
    Shrines.ts             [P5] six elemental shrines: FSM, three challenge kinds
    Fragments.ts           [P5] nine Grimoire Fragment sites, 3-of-a-kind assembly
  player/                  [Phase 1]
    PlayerController.ts    capsule movement, state machine, terrain + prop collision
    CameraRig.ts           third-person orbit, collision-aware, sprint FOV, screen shake
    PlayerAvatar.ts        blocky procedural character + the GLTF swap seam (§5)
    PlayerStats.ts         §10's five stats, HP/MP pools, mana regen
    InputState.ts          the one input struct, with §7's 0.12 s input buffer
  input/KeyboardInput.ts   [Phase 1] desktop input; also what the gates drive
  combat/                  [Phase 3–4]
    HitboxSystem.ts        sphere/capsule overlap, fixed slots, team filters
    DamageSystem.ts        §9's formula, seeded crits, hitstop hook, damage events
    Hitstop.ts             tick-gated freeze: combat stops, the world breathes
    StatusEffects.ts       burn/freeze/wet/shock/bleed/silence + §8.5 reactions
    TargetLock.ts          §6.6 soft lock: nearest enemy in the 40° / 15 u cone
  skills/                  [Phase 4]
    SkillRegistry.ts       data-driven registry; §4.1: adding a skill = JSON only
    SkillRuntime.ts        cast, cooldown, mana, delivery (projectile/nova/self)
    Grimoire.ts            collection, equip slots, mastery, fragments, fusion
    SoulOrbs.ts            §8.2 soul absorption: orb, hold, freeze-frame, card
    vfx/SkillVfx.ts        pooled, data-keyed cast/projectile/nova/status visuals
  enemy/
    EnemyBase.ts           [P3] shared enemy lifecycle: hp, knockback, respawn seam
    AIBrain.ts             [P3] §9 FSM: Idle→Patrol→Alert→Chase→Attack→Flee→Dead
    EnemyDefs.ts           [P5] enemies.json → frozen archetype defs (§4.1 for enemies)
    EnemyVisual.ts         [P5] five procedural body archetypes, per-kind tint/scale
    ArchetypeEnemy.ts      [P5] one class, twelve kinds: stats, attacks, projectiles
    EnemyManager.ts        [P3→5] registry, cap 18, purge/respawn, hitstop gating
    SpawnDirector.ts       [P5] §9 budgets per region, cadence, despawn hysteresis
    BossVael.ts            [P5] scripted 3-phase boss, reaction-stripped shield
  ui/
    TouchControls.ts       [P1→5] joystick, camera, skills, contextual ⚔/✋/⚑ button
    HUD.ts                 [P1] HP/MP bars, level chip, icon row
    DamageNumbers.ts       [P3] pooled DOM damage/reaction floaters
    Notifications.ts       [P4] the SKILL ACQUIRED card and its freeze-frame
    GrimoireScreen.ts      [P4] collection grid, filters, loadout, fusion tabs
  data/
    skills.json            21 skills; enemies.json: 12 kinds; fusions.json: recipes;
    loadout.json           the starting loadout (no skill id lives in TS)
  styles/                  game-surface + HUD/touch CSS, safe-area aware
tools/                     six headless gates, one per phase (see Quick start)
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

## Measured — Phase 5 (headless gate)

`npm run contenttest` proves the filled world in executable form. **109 checks
pass or note honestly, 0 fail** (~5 minutes; it walks all five regions live).
The gate itself survived an adversarial four-lens review (tautology, contract
coverage, false-pass harness bugs, product-fix side effects) — ten raw findings,
all fixed before this count.

| Proven | How |
|---|---|
| **§4.1 extended to enemies** | strict scan, same rule as skills: 12 kind ids × 49 .ts files, **zero occurrences — code, string literals or comments** |
| Five regions, five identities | 5 probe points → 5 distinct dominant regions; ground deviation 0.0000 u over 6 241 grounded samples |
| SpawnDirector, independently audited | 30 s live walks per region: the director's ledger is cross-checked against an **independent census** (Σ `budgetCost` over the live population, unknown kinds poison the sum) — census ≤ contract cap on every sample, ledger == census on ≥ 94.9 % of samples; cap 18 never hit; every sighting region-valid, boss exempted by identity not position |
| All 12 kinds live | each spawns with JSON hp, moves, telegraphs ≥ 0.5 s (§9), ranged kinds hit from 5.7 u stand-off, all killable |
| Element multipliers | flame_lance vs frost_golem (weak) and ash_wraith (resist): measured == JSON-derived to 3 decimals, ratio ×3.000 |
| **Phase 4's debt, repaid** | Shatter ×3.00 exact on an armored golem; Thermal Shock's armor-break measured through a 3-hit sequence — the multipliers Phase 4 could only NOTE are now numbers |
| Shrines | all three challenge kinds completed end-to-end (guardian at 2.5× hp via a real CDP tap on ⚑, torch walk at real time, survive via the sanctioned time-scale hook) → Epic learned **and the ACQUIRED card gated, not just observed** |
| Fragments | walking tide_coil's three sites counts 1, 2, 3 — auto-learned exactly at 3/3, card gated |
| Boss Vael | dormant → P1 (damage exact) → P2 shield (plain damage ×0.15 measured; **Overload strips a layer**) → P3 (the one shield refresh) → kill → scripted Legendary + card |
| Budgets **throughout** | sampled across the walks, all 12 kind probes, the shrine challenges and the whole boss fight: peak **64 draws (the boss arena is the peak scene)**, 77 k tris, heap 4.4 MB, **0 B/frame over 10 187 frames**, tick 60.0, ≤ 5 enemies beyond the walks |

The gate found one real product bug: the smallest ranged kind (spore, a blob at
scale 0.7) fired from a muzzle 0.41 u up while the shared projectile pool killed
shots at `ground + 0.4` — its volleys died at the muzzle with clear line of
sight (0/7 hits at 8 u on flat ground). Ground-kill now uses its own 0.15 u
clearance; the player-hit radius is unchanged.

Recorded, not hidden: ranged AI fires from its natural 12–14 u stand-off with no
line-of-sight check, so across convex slopes volleys can honestly die in the
hillside — a Phase 7 polish candidate, not a Phase 5 blocker. Pose animation is
not on the debug surface (locomotion + screenshots stand in), and Vael's P3
telegraph acceleration is asserted from data, not measured at runtime.

**Device verification pending** — §12's Phase 5 criterion is "20 minutes of
exploration without feeling empty or repetitive", which only a phone can judge.

## Measured — Phase 4 (headless gate)

`npm run skilltest` proves §12's acceptance criterion in executable form.
**78 checks pass, 0 fail** (plus honest NOTEs where shipped balance makes a
multiplier unobservable — see below).

| Proven | How |
|---|---|
| **§4.1's law: zero skill ids in TS** | node-side grep of 11 ids × 43 .ts files: zero hits; the starting loadout lives in `data/loadout.json` |
| Every skill driven by JSON alone | one loop over the registry: learn → equip → cast → assert mana/cooldown/damage/heal/status/delivery shape from the JSON fields |
| Reactions | Conflagration, Shatter (fires through the **melee** path), Deep Freeze, Overload chain, Thermal Shock — seeded |
| Refusals | cooldown / mana / busy, with the button sweep decreasing |
| Mastery | level flips exactly at `masteryCurve[1]`; damage bonus measured **with statScaling dilution accounted for** (mastery multiplies base only) |
| Resonance | 3× fire = +15 % same-seed delta; 4 elements = versatile status bonus |
| Fusion | consumes inputs, result learned, ACQUIRED card in the DOM |
| Soul orb loop | real CDP hold on the morphed ✋ button: orb → 1.2 s → card + 19-tick freeze + known+1 |
| Budgets in a 4-skill brawl | 48 draws, 67 k tris, **0 B/frame** |

**Device-verified** on the 120 Hz Android handset: all four starters cast with
real JSON costs, reactions fire with their floating names, the soul-orb absorb
and the SKILL ACQUIRED moment land as designed, the Grimoire screen works under
thumbs, and budgets hold in a full skill brawl. §12's Phase 4 criterion is met.

The gate found four real product bugs before they reached a phone: debug-spawned
slimes had no status boards; the hitbox registry's 19 slots were never recycled
(after ~19 lifetime spawns nothing was hittable); `combat:reaction` floating
text was unwired; and the melee path never consulted `reactionFor`, which made
Shatter — a §8.5 reaction — unreachable. All fixed and re-proven.

**Balance debt, recorded not hidden**: several §8.5 multipliers are real in code
but unobservable against the only Phase 4 enemy — a 40 hp, 0-armor slime dies
before Shatter's ×3 or a status can be read. Phase 5's tougher, armored enemies
are what make that content visible; the gate NOTEs each case instead of
green-lighting an untested claim.

Deviations worth knowing: element list is 7, not §8.1's 6 — §8.5's Wet reactions
are unreachable without a water applier. `masteryBonus` is machine-readable
rather than §8.1's prose. Conflagration is single-target for now (§8.5 says
area). Channeling is supported by the schema but unused by the starter nine.

## Measured — Phase 3 (headless gate)

`npm run combattest` spawns slimes, fights them with scripted and real-touch
input, dies, respawns, and replays seeded damage sequences. **43/43 checks
pass.** The §12 criterion — "hitting a slime feels satisfying without VFX" — is
a feel judgement no headless gate can make; what the gate proves is the numbers
the feel is built from.

| Measured | Value | Required |
|---|---|---|
| Combo stages reached | 1 → 2 → 3 | all three |
| Hitstop | 5–6 ticks, enemy frozen 0.0000 u | ≤ 7 ticks, world unfrozen |
| World during hitstop | dayPhase + frames advance | not gated |
| Telegraph warning | **0.80 s**, zero damage during wind-up | ≥ 0.5 s, honest |
| Dash through a strike | unharmed | i-frames win |
| Hit spacing on the player | ≥ 0.84 s over 29 hits | ≥ 0.55 s (i-frames) |
| Player death → respawn | Down 1.68 s → spawn at 260/260 | full reset |
| Enemy respawn | t+12.1 s when far; stays dead when camped | 12 s, > 25 u only |
| Seeded damage series | [24.8, 15.2] twice, identical | deterministic |
| Draw calls / triangles | 44 / 50 300 | ≤ 110 / ≤ 150 000 |
| Heap drift in a brawl | **0 B/frame** | < 2 KB/frame |

**Device-verified** on the 120 Hz Android handset, all six §12 feel checks:
hitstop reads as impact, the three-hit combo chains, the telegraph is readable
and honest, dash i-frames beat the strike, death and respawn work, and the
overlay stays inside budget mid-brawl. "Hitting a slime feels satisfying
without VFX" — confirmed by the person holding the phone, which is the only
instrument that can measure it.

Notes from the phase:

- **Hitstop counts in ticks, not milliseconds.** §9 asks for 60–90 ms; at a
  fixed 60 Hz the choices are 4 ticks (67 ms) or 6 (100 ms). Light hits take 4,
  heavies 6 — erring long reads better than erring short.
- **The telegraph is enforced, not aspirational**: the gate asserts no contact
  damage lands while `telegraphing` is true, and measured 0.80 s of continuous
  warning before the first hit.
- **Two measurement bugs masqueraded as regressions** when live slimes joined
  the world: enemies chasing the player through §7's movement measurements
  truncated a dash into a Hit state (the movement gate now neutralises enemies
  per section), and span timing under-read on slow pages until the press was
  deferred past the first sample so both edges of a state span are bracketed.
  The isolated tick trace shows the dash at exactly 0.18 s throughout.

## Measured — Phase 2 (headless gate)

`npm run worldtest` streams a 600×600 world, walks 125 units south across the
biome boundary, and samples every frame. **38/38 checks pass.**

| Measured | Value | Required |
|---|---|---|
| Draw calls while walking | **30** | ≤ 110 (§12) |
| Triangles while walking | **67 452** | ≤ 150 000 |
| Non-terrain draw calls | **13**, constant | not per-chunk |
| Player stays on built terrain | **0.0000 u** deviation | < 0.12 |
| Build queue | peak 11, drains to 0 | keeps up |
| Geometry pool | peak 27, **0 B/frame** drift | bounded, no leak |
| Frustum culling | 12–17 visible of 25 active | culls something |
| Biome crossing | dominant 0 → 1 over 22 u | blends, no flip |
| Worst single-frame biome step | 0.0483 per world unit | no popping |
| Day-night cycle | 4 keyframes all differ; +0.0070/5 s | 720 s cycle |
| Sky dome | 1 draw call, constant | 1 |
| Prop instances / colliders | 354 / 238 | — |
| Heap | 3.8 MB peak | ≤ 280 |

**Device-verified** on the 120 Hz Android handset: the biome traverse streams
without stutter, draws/tris stay inside budget on the overlay, no popping at the
boundary, and the day-night cycle runs. §12's Phase 2 criterion is met.

Draw calls came in at 30 against a budget of 110 because of the one deliberate
deviation from §3 (below). Triangles at 67 k of 150 k is the LOD scheme working:
25 chunks at Phase 1's resolution would have been 125 000 on their own.

### Where the budget went, and the deviation that made it fit

§3 says "one instanced mesh per prop type per chunk". With a 5×5 active set and
four prop types that is 100 draw calls, plus 25 terrain meshes = **125, over §3's
own 110 budget before the water, the sky or the player are drawn.** So props use
**one InstancedMesh per type for the whole active set**, with per-chunk instance
ranges inside it: 4 draw calls instead of 100.

The LOD scheme is likewise not optional. A chunk at Phase 1's 50-cell resolution
is 5 000 triangles, so 25 of them is 125 000 — 83 % of the triangle budget with
nothing else on screen. LOD0 (50 cells) covers the 3×3 around the player and LOD1
(16 cells, 512 triangles) the ring beyond, for 53 000.

Three findings that only came out of measuring rather than reasoning:

- **Noise frequency has to be checked against LOD vertex spacing.** A 4th fBm
  octave lands at a 4.5-unit wavelength, below LOD1's 3.125-unit spacing, so a
  chunk would change shape the moment its LOD swapped — the popping §12 fails the
  phase for. The field runs 3 octaves for that reason.
- **Fog density is a popping control, not just a mood control.** At §3's suggested
  0.012 a chunk entering the active set is 21 % visible. Day density is 0.016.
- **The water plane's segment count bounds the wave length it can express.** At
  700 units across 24 segments the vertex spacing is 29 units, so the swell could
  only resolve a 175-unit wavelength and read as a flat sheet. It is 320/48 with
  `setCenter` following the player instead.

Fog density needed arbitrating: hiding chunk pop-in argues for ~0.016, while the
terrain horizon at a 2-chunk radius is only 100–125 units away, which argues for
≥ 0.02 so the far plane never shows through. Settled by looking rather than by
arithmetic — a noon screenshot on open ground (`artifacts/horizon-noon.png`) shows
the terrain blending into the sky with no edge at 0.016, because the sky dome's
horizon band is set to exactly the fog colour. Denser fog would only have cost
view distance.

### Night is deliberately not dark

Sun intensity drops to 0.12 at night but the hemisphere fill rises **above** its
daytime value, landing at 52 % of daytime luminance. §5 asks for a night; a
genuinely dark one is unplayable on a phone held outdoors, which is the device
this game is for.

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
