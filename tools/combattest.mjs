#!/usr/bin/env node
/**
 * Arcanum Drift — Phase 3 combat gate.
 *
 * §12's Phase 3 acceptance criterion — "hitting a slime feels satisfying
 * without any VFX" — is a FEEL criterion and is explicitly not measurable in a
 * headless software rasteriser. What this gate measures instead is every number
 * that feel is built out of: the combo advances 1→2→3, hitstop fires and is
 * bounded while the world keeps breathing, the telegraph gives ≥ 0.5 s of
 * honest warning, i-frames actually gate hits, damage is deterministic under a
 * fixed seed, death/respawn works on both sides of the 25 u rule, and the §3
 * budgets hold through a brawl. If those numbers are wrong the feel cannot be
 * right; if they are right, the last word still belongs to a real handset.
 *
 * Infrastructure is the same proven shape as playtest.mjs / worldtest.mjs:
 * detached vite preview + process-group teardown, global Playwright import,
 * hard timeout, SIGINT→130, in-page rAF samplers (a CDP round trip per frame
 * would cost more than the thing being measured), CDP real-touch with the
 * sampler started BEFORE the tap, and waitForFunction's three-argument form.
 *
 * Driving trick used throughout: the camera yaw is NEVER changed (no look
 * input), so the input→world mapping measured once at boot — two short
 * calibration walks giving the world directions for stick-up (F) and
 * stick-right (R) — stays valid for the whole run. Walking toward an arbitrary
 * world point is then a 2x2 solve, with no assumptions about the engine's yaw
 * conventions. Slimes are spawned along F so player facing, camera cone and
 * target lock all agree by construction.
 *
 * Port 4176 (smoke 4173, playtest 4174, worldtest 4175).
 *
 * Usage: npm run build && node tools/combattest.mjs
 * Output: artifacts/combattest.png, artifacts/combattest.json. Exit 0/1, 130 on SIGINT.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');

const HOST = '127.0.0.1';
/** Deliberately not 4173/4174/4175 so the other gates can run alongside. */
const PORT = 4176;
const URL_ = `http://${HOST}:${PORT}/`;

/** This gate does a lot of honest waiting (respawn timers, a 33-hit death). */
const OVERALL_TIMEOUT_MS = 240_000;
const SERVER_TIMEOUT_MS = 30_000;

/** §3 hard budgets. */
const BUDGET = { drawCalls: 110, triangles: 150_000, heapMb: 280 };
/** Same limit playtest uses: the loop must not allocate (§3 wants 0). */
const HEAP_BYTES_PER_FRAME = 2048;

// --- Phase 3 contract feel-numbers (the things this gate asserts) -----------
/** §9 telegraph honesty: wind-up ≥ 0.5 s before any contact damage. */
const TELEGRAPH_MIN_S = 0.5;
/** Player post-hit i-frames are 0.6 s; 0.55 leaves sampling slack. */
const HIT_SPACING_MIN_S = 0.55;
/** Hitstop: light 4 ticks, heavy 6; contract allows ≤ 7 observed. */
const HITSTOP_MAX_TICKS = 7;
/** Slime def per the contract. */
const SLIME = { maxHp: 40, armor: 0, contactDamage: 8, respawnSeconds: 12 };
/** Combo stage base damages (statScaling ≥ 0 comes on top). */
const STAGE_BASE = [0, 12, 14, 26];
const CRIT_MULT = 1.6;
/** A lone 40 hp slime must die within this after the first attack press. */
const KILL_TIMEOUT_S = 8;
/** Down state is 1.6 s; contract says respawn "within ~3 s". */
const DOWN_TO_RESPAWN_MAX_S = 3.0;
/** DamageNumbers pool is 24; a few extra nodes tolerated, growth is not. */
const DMG_POOL_MAX = 32;

const CHROMIUM_ARGS = [
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--proxy-server=direct://',
  '--proxy-bypass-list=*',
  // Without this performance.memory quantises to 10 MB and drift is meaningless.
  '--enable-precise-memory-info',
  '--hide-scrollbars',
  '--mute-audio',
];

// ---------------------------------------------------------------------------
// process plumbing (same shape as the sibling gates — never orphan the server)
// ---------------------------------------------------------------------------

let previewChild = null;
let browser = null;
let hardTimer = null;
let hardTimedOut = false;
let interrupted = null;
let cleanedUp = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killPreview(signal) {
  const child = previewChild;
  if (child === null) return;
  // Spawned detached, so the whole group dies with it (npx adds a shell layer).
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (hardTimer !== null) {
    clearTimeout(hardTimer);
    hardTimer = null;
  }
  if (browser !== null) {
    const b = browser;
    browser = null;
    try {
      await Promise.race([b.close(), sleep(5000)]);
    } catch {
      /* ignore */
    }
  }
  killPreview('SIGTERM');
  await sleep(250);
  killPreview('SIGKILL');
}

process.on('exit', () => {
  const child = previewChild;
  if (child !== null && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = signal;
    console.error(`\n[combattest] ${signal} received — tearing down.`);
    setTimeout(() => process.exit(130), 4000).unref();
    void cleanup().finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const report = {
  tool: 'tools/combattest.mjs',
  phase: 3,
  startedAt: new Date().toISOString(),
  durationMs: 0,
  verdict: 'FAIL',
  renderingBackend:
    'SwiftShader (software) — timings are NOT device numbers; "feels satisfying" (§12) is NOT measurable here',
  budgets: BUDGET,
  measurements: {},
  consoleErrors: [],
  pageErrors: [],
  checks: [],
  series: {},
};

class Fatal extends Error {}

function record(name, status, detail) {
  report.checks.push({ name, status, detail });
  return status !== 'FAIL';
}
const pass = (name, detail) => record(name, 'PASS', detail);
const fail = (name, detail) => record(name, 'FAIL', detail);
/** Could not be measured at all — reported loudly, and it fails the gate. */
const unknown = (name, detail) => record(name, 'FAIL', `UNVERIFIABLE: ${detail}`);

// ---------------------------------------------------------------------------
// small maths
// ---------------------------------------------------------------------------

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function roundSeries(arr, digits) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = round(arr[i], digits);
  return out;
}

function maxOf(arr) {
  let best = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > best) best = arr[i];
  return best === -Infinity ? 0 : best;
}

/** Mean over the last `fraction` of a series — skips any ramp. */
function tailMean(arr, fraction = 0.6) {
  const start = Math.floor(arr.length * (1 - fraction));
  let sum = 0;
  let count = 0;
  for (let i = start; i < arr.length; i++) {
    sum += arr[i];
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Per-hit series from an enemy-hp sample series: drops become hits. The killing
 * blow is flagged `overkill` — its hp delta is clamped at zero and no longer
 * equals the formula output, so the formula check must skip it.
 */
function hitsFromSamples(samples) {
  const hits = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev.alive === 0) continue;
    const d = prev.hp - cur.hp;
    if (d > 1e-9) hits.push({ t: cur.t, amount: d, stage: cur.stage, overkill: cur.hp <= 1e-9 });
  }
  return hits;
}

/**
 * Stats over consecutive sample pairs where BOTH frames sat inside hitstop.
 * These pairs are the direct evidence for §9's freeze contrast: the gated fight
 * is still (enemy motion ~0) while the ungated world moves (dayPhase advances,
 * frameCount advances).
 */
function frozenPairStats(samples) {
  let pairs = 0;
  let phaseDelta = 0;
  let maxEnemyMove = 0;
  let framesAlwaysAdvance = true;
  let movePairs = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.hs !== 1 || b.hs !== 1) continue;
    pairs++;
    let dp = b.phase - a.phase;
    if (dp < -0.5) dp += 1; // midnight wrap
    phaseDelta += dp;
    if (!(b.frames > a.frames)) framesAlwaysAdvance = false;
    if (a.alive === 1 && b.alive === 1) {
      movePairs++;
      const move = Math.hypot(b.ex - a.ex, b.ey - a.ey, b.ez - a.ez);
      if (move > maxEnemyMove) maxEnemyMove = move;
    }
  }
  return { pairs, movePairs, phaseDelta, maxEnemyMove, framesAlwaysAdvance };
}

/**
 * §9 formula sanity without knowing statScaling, and without trusting per-hit
 * stage attribution (at mash cadence the sampled comboStage can already show
 * the NEXT swing by the time the hp drop is read). Global structure instead:
 * with armor 0 every non-overkill hit is exactly base_i + scaling_i or 1.6x
 * that, so the distinct damage values must decompose into at most 3 "root"
 * values (the non-crits, ascending ≥ 12/14/26) plus exact 1.6x partners.
 */
function formulaCheck(hits) {
  const usable = hits.filter((h) => h.overkill !== true);
  const distinct = [];
  for (const h of usable) {
    let found = false;
    for (const d of distinct) {
      if (Math.abs(h.amount - d) <= 1e-6) {
        found = true;
        break;
      }
    }
    if (!found) distinct.push(h.amount);
  }
  distinct.sort((a, b) => a - b);
  const roots = [];
  const critValues = [];
  for (const v of distinct) {
    let isCrit = false;
    for (const r of distinct) {
      if (r >= v) break;
      if (Math.abs(v - r * CRIT_MULT) <= 1e-6) {
        isCrit = true;
        break;
      }
    }
    if (isCrit) critValues.push(v);
    else roots.push(v);
  }
  const problems = [];
  if (roots.length > 3) {
    problems.push(`${roots.length} damage values that are neither a stage base nor 1.6x one: [${roots.map((v) => v.toFixed(4)).join(', ')}] — only 3 combo stages exist`);
  } else if (roots.length === 3) {
    const bases = [STAGE_BASE[1], STAGE_BASE[2], STAGE_BASE[3]];
    for (let i = 0; i < 3; i++) {
      if (roots[i] < bases[i] - 1e-9) {
        problems.push(`stage-${i + 1} non-crit ${roots[i].toFixed(4)} is BELOW its base ${bases[i]} — scaling cannot be negative`);
      }
    }
  } else {
    for (const r of roots) {
      if (r < STAGE_BASE[1] - 1e-9) problems.push(`non-crit damage ${r.toFixed(4)} is below the smallest base ${STAGE_BASE[1]}`);
    }
  }
  const summary =
    `${usable.length} clean hits (${hits.length - usable.length} overkill excluded): non-crit values [${roots.map((v) => v.toFixed(3)).join(', ')}]` +
    (critValues.length > 0 ? `, crits at exactly 1.6x [${critValues.map((v) => v.toFixed(3)).join(', ')}]` : ', no crits observed');
  return { problems, summary, roots, critValues };
}

// ---------------------------------------------------------------------------
// server + playwright
// ---------------------------------------------------------------------------

function probe(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(0);
    });
  });
}

async function startPreview() {
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Fatal('dist/index.html is missing. Run `npm run build` first.');
  }
  const bin = path.join(ROOT, 'node_modules', '.bin', 'vite');
  const command = existsSync(bin) ? bin : 'npx';
  const args = existsSync(bin)
    ? ['preview', '--port', String(PORT), '--strictPort', '--host', HOST]
    : ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', HOST];

  previewChild = spawn(command, args, { cwd: ROOT, stdio: 'ignore', detached: true });

  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await probe(URL_, 1000)) === 200) return;
    if (previewChild.exitCode !== null) {
      throw new Fatal(`vite preview exited early with code ${previewChild.exitCode}. Is port ${PORT} in use?`);
    }
    await sleep(250);
  }
  throw new Fatal(`vite preview did not answer on ${URL_} within ${SERVER_TIMEOUT_MS} ms.`);
}

/** Bare specifier fails here — playwright is a global install, not a dependency. */
async function loadPlaywright() {
  const candidates = [
    'playwright',
    pathToFileURL('/opt/node22/lib/node_modules/playwright/index.mjs').href,
  ];
  for (const specifier of candidates) {
    try {
      return await import(specifier);
    } catch {
      /* try the next */
    }
  }
  throw new Fatal('Could not import playwright (tried the bare specifier and the global install).');
}

// ---------------------------------------------------------------------------
// in-page drivers — serialised across the CDP boundary, so self-contained
// ---------------------------------------------------------------------------

/** Short walk under a fixed input; returns the displacement (worldtest's trick). */
const CAL_WALK = (o) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    debug.clearInput();
    debug.warp(o.x, o.z);
    const start = debug.player();
    const sx = start.x;
    const sz = start.z;
    debug.setInput({ moveX: o.moveX, moveY: o.moveY, sprint: false });
    const t0 = performance.now();
    const tick = () => {
      if (performance.now() - t0 >= o.durationMs) {
        const p = debug.player();
        debug.clearInput();
        resolve({ dx: p.x - sx, dz: p.z - sz });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** Walk a fixed input briefly to establish player facing, then stop. */
const FACE = (o) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    debug.setInput({ moveX: o.moveX, moveY: o.moveY, sprint: false });
    const t0 = performance.now();
    const tick = () => {
      if (performance.now() - t0 >= o.durationMs) {
        debug.setInput({ moveX: 0, moveY: 0, sprint: false });
        const p = debug.player();
        resolve({ x: p.x, z: p.z, yaw: p.yaw });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** Passive watcher for the real-touch attack tap — started BEFORE the tap. */
const TOUCH_WATCH = (o) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    let sawAttackState = false;
    let sawStage = false;
    const t0 = performance.now();
    const tick = () => {
      const p = debug.player();
      const c = debug.combat();
      if (typeof p.state === 'string' && p.state.indexOf('Attack') === 0) sawAttackState = true;
      if (c.comboStage > 0) sawStage = true;
      if (performance.now() - t0 >= o.durationMs) {
        resolve({ sawAttackState, sawStage });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/**
 * The workhorse: walk to the target slime using the calibrated input→world
 * matrix, then mash attack on a cadence, sampling everything the hitstop /
 * combo / kill assertions need once per rAF. Stops `graceMs` after the kill or
 * at `timeoutMs`. The matrix solve needs no yaw conventions: world(ix,iy) =
 * ix·R − iy·F, measured, so input = M⁻¹·direction.
 */
const MELEE = (o) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    const det = o.fx * o.rz - o.rx * o.fz;
    const inputFor = (dx, dz) => {
      const len = Math.hypot(dx, dz);
      if (len < 1e-6 || Math.abs(det) < 1e-6) return { ix: 0, iy: 0 };
      const nx = dx / len;
      const nz = dz / len;
      let ix = (-nx * o.fz + o.fx * nz) / det;
      let iy = (o.rx * nz - o.rz * nx) / det;
      const il = Math.hypot(ix, iy);
      if (il > 1e-6) {
        ix /= il;
        iy /= il;
      }
      return { ix, iy };
    };
    const findTarget = () => {
      const rows = debug.enemies();
      for (let i = 0; i < rows.length; i++) if (rows[i].id === o.targetId) return rows[i];
      return null;
    };

    const samples = [];
    const started = performance.now();
    let walking = o.walk === true;
    let lastPress = -1e9;
    let firstPressT = -1;
    let deadAt = -1;

    const finish = (reason) => {
      debug.clearInput();
      resolve({
        reason,
        firstPressT,
        killedT: deadAt > 0 ? (deadAt - started) / 1000 : -1,
        samples,
      });
    };

    const tick = () => {
      const now = performance.now();
      const t = (now - started) / 1000;
      const row = findTarget();
      if (row === null) {
        finish('target-vanished');
        return;
      }
      const p = debug.player();
      const c = debug.combat();
      const m = debug.metrics();

      if (walking && row.alive) {
        const dx = row.x - p.x;
        const dz = row.z - p.z;
        if (Math.hypot(dx, dz) <= o.arrive || t * 1000 > o.walkTimeoutMs) {
          debug.setInput({ moveX: 0, moveY: 0, sprint: false });
          walking = false;
        } else {
          const iv = inputFor(dx, dz);
          debug.setInput({ moveX: iv.ix, moveY: iv.iy, sprint: false });
        }
      }
      if (!walking && row.alive && now - lastPress >= o.cadenceMs) {
        debug.press('attack');
        lastPress = now;
        if (firstPressT < 0) firstPressT = t;
      }

      samples.push({
        t,
        hp: row.hp,
        ex: row.x,
        ey: row.y,
        ez: row.z,
        alive: row.alive ? 1 : 0,
        stage: c.comboStage,
        hs: c.hitstopActive ? 1 : 0,
        hsTicks: c.hitstopTicksLeft,
        locked: c.lockedTargetId,
        frames: debug.frameCount(),
        phase: debug.dayPhase(),
        ticksRate: m.ticks,
        draws: m.drawCalls,
        tris: m.triangles,
        heap: m.heapMb,
        dmgLive: document.querySelector('.dmg.is-live') !== null ? 1 : 0,
        dmgCount: document.querySelectorAll('.dmg').length,
      });

      if (!row.alive && deadAt < 0) deadAt = now;
      if (deadAt > 0 && now - deadAt >= o.graceMs) {
        finish('killed');
        return;
      }
      if (now - started >= o.timeoutMs) {
        finish('timeout');
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/**
 * The determinism script: exactly `presses` attack presses on a fixed cadence
 * against an adjacent slime, watching its hp. Returns the per-hit damage
 * series derived from hp drops. Input is driven via press() (the scripted
 * override path), not real touch — exact reproducibility is the point.
 */
const COMBO_SCRIPT = (o) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    const started = performance.now();
    let pressed = 0;
    let lastPress = -1e9;
    const samples = [];
    const tick = () => {
      const now = performance.now();
      if (pressed < o.presses && now - lastPress >= o.cadenceMs) {
        debug.press('attack');
        lastPress = now;
        pressed++;
      }
      const rows = debug.enemies();
      let row = null;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].id === o.targetId) {
          row = rows[i];
          break;
        }
      }
      const c = debug.combat();
      if (row !== null) {
        samples.push({
          t: (now - started) / 1000,
          hp: row.hp,
          stage: c.comboStage,
          alive: row.alive ? 1 : 0,
        });
      }
      if (now - started >= o.watchMs) {
        const hits = [];
        for (let i = 1; i < samples.length; i++) {
          if (samples[i - 1].alive === 0) continue;
          const d = samples[i - 1].hp - samples[i].hp;
          if (d > 1e-9) {
            hits.push({ t: samples[i].t, amount: d, stage: samples[i].stage, overkill: samples[i].hp <= 1e-9 });
          }
        }
        resolve({
          hits,
          sampleCount: samples.length,
          endHp: samples.length > 0 ? samples[samples.length - 1].hp : -1,
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/**
 * Stand still and take it. Samples the target's telegraph flag, the player's
 * i-frame timer (a hit is the timer jumping UP — exact, unlike the 10 Hz HUD),
 * the HUD hp readout, and the player state. Two stop modes:
 *  - 'firstHit': resolve shortly after the first landed hit (telegraph test);
 *  - 'death': resolve once a seen Down state ends in a respawn (death test).
 */
const STAND = (o) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  const readHp = () => {
    const el = document.querySelector('.hud__bar--hp .hud__bar-num');
    if (el === null) return null;
    const parts = (el.textContent || '').split('/');
    if (parts.length !== 2) return null;
    const hp = Number(parts[0]);
    const max = Number(parts[1]);
    return Number.isFinite(hp) && Number.isFinite(max) ? { hp, max } : null;
  };
  return new Promise((resolve) => {
    debug.clearInput();
    const started = performance.now();
    const samples = [];
    // NOTE: iframesLeft parks at a small NEGATIVE value once expired (the
    // controller decrements without clamping), so the previous-sample guard
    // must be a boolean — a `prev >= 0` guard silently masks every jump.
    let hasPrev = false;
    let prevIFrames = 0;
    let firstHitT = -1;
    let sawDown = false;
    let downT = -1;
    let respawnT = -1;

    const finish = (reason) => {
      resolve({ reason, samples, firstHitT, downT, respawnT, sawDown });
    };

    const tick = () => {
      const now = performance.now();
      const t = (now - started) / 1000;
      const rows = debug.enemies();
      let tele = 0;
      let targetAlive = 0;
      if (typeof o.targetId === 'number') {
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].id === o.targetId) {
            tele = rows[i].telegraphing ? 1 : 0;
            targetAlive = rows[i].alive ? 1 : 0;
            break;
          }
        }
      }
      const c = debug.combat();
      const p = debug.player();
      const h = readHp();
      const jumped = hasPrev && c.playerIFrames > prevIFrames + 0.05 ? 1 : 0;
      prevIFrames = c.playerIFrames;
      hasPrev = true;
      if (jumped === 1 && firstHitT < 0) firstHitT = t;
      if (p.state === 'Down') {
        sawDown = true;
        if (downT < 0) downT = t;
      } else if (sawDown && respawnT < 0) {
        respawnT = t;
      }

      samples.push({
        t,
        tele,
        targetAlive,
        jumped,
        ifr: c.playerIFrames,
        hp: h === null ? -1 : h.hp,
        maxHp: h === null ? -1 : h.max,
        down: p.state === 'Down' ? 1 : 0,
        px: p.x,
        pz: p.z,
      });

      if (o.mode === 'firstHit' && firstHitT > 0 && t - firstHitT >= 0.25) {
        finish('first-hit');
        return;
      }
      if (o.mode === 'death' && respawnT > 0 && t - respawnT >= 0.5) {
        finish('respawned');
        return;
      }
      if (now - started >= o.timeoutMs) {
        finish('timeout');
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/**
 * Waits for a FRESH telegraph onset (must first observe telegraphing false),
 * presses dash `delayMs` into the wind-up so the 0.15 s i-frame window covers
 * the 0.55 s strike moment, and watches the HUD hp across the strike.
 */
const DASH_THROUGH = (o) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  const readHp = () => {
    const el = document.querySelector('.hud__bar--hp .hud__bar-num');
    if (el === null) return null;
    const parts = (el.textContent || '').split('/');
    if (parts.length !== 2) return null;
    const hp = Number(parts[0]);
    return Number.isFinite(hp) ? hp : null;
  };
  return new Promise((resolve) => {
    debug.clearInput();
    const started = performance.now();
    let sawFalse = false;
    let onsetT = -1;
    let pressT = -1;
    let sawInvuln = false;
    let hpAtOnset = null;
    let minHp = Infinity;

    const tick = () => {
      const now = performance.now();
      const t = (now - started) / 1000;
      const rows = debug.enemies();
      let row = null;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].id === o.targetId) {
          row = rows[i];
          break;
        }
      }
      if (row === null || !row.alive) {
        resolve({ reason: 'target-gone', onsetT, pressT, sawInvuln, hpAtOnset, minHp, hpEnd: readHp() });
        return;
      }
      const tele = row.telegraphing === true;
      if (!tele) sawFalse = true;
      if (tele && sawFalse && onsetT < 0) {
        onsetT = t;
        hpAtOnset = readHp();
      }
      if (onsetT > 0 && pressT < 0 && t - onsetT >= o.delayMs / 1000) {
        debug.press('dash');
        pressT = t;
      }
      const p = debug.player();
      if (pressT > 0 && p.invulnerable) sawInvuln = true;
      const h = readHp();
      if (onsetT > 0 && h !== null && h < minHp) minHp = h;

      if (onsetT > 0 && t - onsetT >= o.watchMs / 1000) {
        resolve({ reason: 'done', onsetT, pressT, sawInvuln, hpAtOnset, minHp, hpEnd: readHp() });
        return;
      }
      if (now - started >= o.timeoutMs) {
        resolve({ reason: 'no-onset', onsetT, pressT, sawInvuln, hpAtOnset, minHp, hpEnd: readHp() });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/**
 * The budget brawl: mash attack amid a pack for `durationMs`, sampling into
 * pre-allocated Float64Arrays. This is the series the heap-drift assertion
 * uses, so the sampler itself must not be the thing allocating — it touches
 * only metrics() and combat(), the same discipline playtest.mjs set.
 */
const BRAWL = (o) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    const cap = Math.ceil((o.durationMs / 1000) * 140) + 64;
    const t = new Float64Array(cap);
    const frameMs = new Float64Array(cap);
    const draws = new Float64Array(cap);
    const tris = new Float64Array(cap);
    const heap = new Float64Array(cap);
    const hs = new Float64Array(cap);
    const hsTicks = new Float64Array(cap);
    let n = 0;
    let lastPress = -1e9;

    debug.setInput({ moveX: 0, moveY: 0, sprint: false });
    const started = performance.now();
    let last = started;

    const tick = () => {
      const now = performance.now();
      if (now - lastPress >= o.cadenceMs) {
        debug.press('attack');
        lastPress = now;
      }
      const m = debug.metrics();
      const c = debug.combat();
      if (n < cap) {
        t[n] = (now - started) / 1000;
        frameMs[n] = now - last;
        draws[n] = m.drawCalls;
        tris[n] = m.triangles;
        heap[n] = m.heapMb;
        hs[n] = c.hitstopActive ? 1 : 0;
        hsTicks[n] = c.hitstopTicksLeft;
        n++;
      }
      last = now;
      if (now - started >= o.durationMs) {
        debug.clearInput();
        resolve({
          count: n,
          t: Array.from(t.subarray(0, n)),
          frameMs: Array.from(frameMs.subarray(0, n)),
          drawCalls: Array.from(draws.subarray(0, n)),
          triangles: Array.from(tris.subarray(0, n)),
          heapMb: Array.from(heap.subarray(0, n)),
          hs: Array.from(hs.subarray(0, n)),
          hsTicks: Array.from(hsTicks.subarray(0, n)),
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  hardTimer = setTimeout(() => {
    hardTimedOut = true;
    console.error(`[combattest] HARD TIMEOUT after ${OVERALL_TIMEOUT_MS} ms — killing everything.`);
    void cleanup();
    setTimeout(() => process.exit(1), 1500);
  }, OVERALL_TIMEOUT_MS);
  hardTimer.unref?.();

  const m = report.measurements;
  /** Every MELEE run feeds the hitstop-freeze statistics, so slow rasterisers
   *  still accumulate enough in-freeze sample pairs to measure the contrast. */
  const meleeRuns = [];

  try {
    await startPreview();
    pass('vite preview reachable', URL_);

    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    pass('Chromium launched (headless, SwiftShader)', browser.version());

    const page = await browser.newPage({
      viewport: { width: 800, height: 360 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => report.pageErrors.push(String(error?.message ?? error)));

    const response = await page.goto(URL_, { waitUntil: 'load', timeout: 20_000 });
    if (response === null || !response.ok()) throw new Fatal(`page load failed (${response?.status()})`);
    pass('page loaded', `HTTP ${response.status()}`);

    // NOTE the `null`: waitForFunction(fn, arg, options). Passing the options
    // object in the arg slot silently leaves the timeout at the 30 s default.
    await page.waitForFunction(() => globalThis.__ARCANUM_DEBUG__ !== undefined, null, { timeout: 15_000 });
    const shape = await page.evaluate(() => {
      const d = globalThis.__ARCANUM_DEBUG__;
      const phase12 = [
        'metrics', 'frameCount', 'tickCount', 'elapsed', 'setInput', 'clearInput', 'press',
        'player', 'camera', 'terrainHeightAt', 'warp', 'biomeAt', 'setDayPhase', 'dayPhase', 'world',
      ];
      const phase3 = ['enemies', 'combat', 'setDamageSeed', 'spawnSlimes', 'killAllEnemies'];
      const missing = [];
      for (const k of phase12) if (typeof d[k] !== 'function') missing.push(k + ' (phase 1/2)');
      for (const k of phase3) if (typeof d[k] !== 'function') missing.push(k + ' (phase 3)');
      let combatKeys = [];
      try {
        combatKeys = typeof d.combat === 'function' ? Object.keys(d.combat()) : [];
      } catch (error) {
        combatKeys = ['<combat() threw: ' + String((error && error.message) || error) + '>'];
      }
      return { missing, version: d.version, combatKeys };
    });
    if (shape.missing.length > 0) {
      throw new Fatal(
        `__ARCANUM_DEBUG__ is missing: ${shape.missing.join(', ')}. The Phase 3 gate cannot run until ` +
          'the integrator exposes enemies()/combat()/setDamageSeed()/spawnSlimes()/killAllEnemies().',
      );
    }
    pass('__ARCANUM_DEBUG__ phase 3 shape', `complete, version ${shape.version}`);
    const combatNeeded = ['hitstopActive', 'hitstopTicksLeft', 'comboStage', 'lockedTargetId', 'playerIFrames'];
    const combatMissing = combatNeeded.filter((k) => !shape.combatKeys.includes(k));
    if (combatMissing.length > 0) {
      throw new Fatal(`combat() is missing keys: ${combatMissing.join(', ')} (got ${shape.combatKeys.join(', ')})`);
    }
    pass('combat() shape', shape.combatKeys.join(', '));

    await page.waitForFunction(() => globalThis.__ARCANUM_DEBUG__.frameCount() > 40, null, { timeout: 20_000 });
    pass('render loop running', 'frameCount passed 40');

    // --- Node-side helpers -------------------------------------------------
    const prep = async (x, z) => {
      await page.evaluate((o) => {
        const d = globalThis.__ARCANUM_DEBUG__;
        d.killAllEnemies();
        d.clearInput();
        d.warp(o.x, o.z);
      }, { x, z });
      await sleep(300);
    };
    const spawnAt = (x, z, count, radius) =>
      page.evaluate((o) => globalThis.__ARCANUM_DEBUG__.spawnSlimes(o.x, o.z, o.count, o.radius), { x, z, count, radius });
    const nearestAlive = (x, z) =>
      page.evaluate((o) => {
        const rows = globalThis.__ARCANUM_DEBUG__.enemies();
        let best = null;
        let bd = Infinity;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (!r.alive) continue;
          const d = Math.hypot(r.x - o.x, r.z - o.z);
          if (d < bd) {
            bd = d;
            best = r;
          }
        }
        return best === null
          ? null
          : { id: best.id, kind: best.kind, dist: bd, x: best.x, z: best.z, hp: best.hp, maxHp: best.maxHp };
      }, { x, z });
    const enemyById = (id) =>
      page.evaluate((o) => {
        const rows = globalThis.__ARCANUM_DEBUG__.enemies();
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].id === o.id) {
            const r = rows[i];
            return { id: r.id, x: r.x, y: r.y, z: r.z, hp: r.hp, alive: r.alive, state: r.state, telegraphing: r.telegraphing };
          }
        }
        return null;
      }, { id });
    const playerPos = () =>
      page.evaluate(() => {
        const p = globalThis.__ARCANUM_DEBUG__.player();
        return { x: p.x, z: p.z, state: p.state };
      });
    const lockedId = () => page.evaluate(() => globalThis.__ARCANUM_DEBUG__.combat().lockedTargetId);
    const setSeed = (n) => page.evaluate((s) => globalThis.__ARCANUM_DEBUG__.setDamageSeed(s), n);

    // --- 1. boot clean, tick ~60 ------------------------------------------
    const idleTicks = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const d = globalThis.__ARCANUM_DEBUG__;
          const out = [];
          const t0 = performance.now();
          const tick = () => {
            out.push(d.metrics().ticks);
            if (performance.now() - t0 >= 2000) {
              resolve(out);
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    const tickRate = tailMean(idleTicks, 0.7);
    m.tickRate = round(tickRate, 1);
    if (Math.abs(tickRate - 60) <= 6) pass('#1 fixed tick rate ~60/s at boot', `${tickRate.toFixed(1)} /s`);
    else fail('#1 fixed tick rate ~60/s at boot', `${tickRate.toFixed(1)} /s — the accumulator is not keeping up`);

    // --- calibration: input→world matrix + camera-forward -----------------
    /*
     * No look input is ever sent, so the camera yaw — and with it this mapping —
     * stays fixed for the entire run. F = world direction of stick-up, R = of
     * stick-right. Slimes are spawned along F so player facing, the camera cone
     * and the walk direction all agree without guessing any yaw convention.
     */
    const calF = await page.evaluate(CAL_WALK, { x: 0, z: 0, moveX: 0, moveY: -1, durationMs: 800 });
    const calR = await page.evaluate(CAL_WALK, { x: 0, z: 0, moveX: 1, moveY: 0, durationMs: 800 });
    const lenF = Math.hypot(calF.dx, calF.dz);
    const lenR = Math.hypot(calR.dx, calR.dz);
    if (lenF < 0.5 || lenR < 0.5) {
      throw new Fatal(`calibration walks moved only ${lenF.toFixed(2)} / ${lenR.toFixed(2)} u — the player is not moving.`);
    }
    const F = { x: calF.dx / lenF, z: calF.dz / lenF };
    const R = { x: calR.dx / lenR, z: calR.dz / lenR };
    const det = F.x * R.z - R.x * F.z;
    if (Math.abs(det) < 0.5) {
      throw new Fatal(`calibrated axes are near-parallel (det ${det.toFixed(3)}) — cannot steer.`);
    }
    const M = { fx: F.x, fz: F.z, rx: R.x, rz: R.z };
    m.calibration = { F: { x: round(F.x, 4), z: round(F.z, 4) }, R: { x: round(R.x, 4), z: round(R.z, 4) }, det: round(det, 4) };
    pass('input→world axes calibrated', `F (${F.x.toFixed(2)}, ${F.z.toFixed(2)}), R (${R.x.toFixed(2)}, ${R.z.toFixed(2)}), det ${det.toFixed(2)}`);

    // --- real-touch sanity: the attack button swings -----------------------
    await prep(0, 0);
    const attackPoint = await page.evaluate(() => {
      const el = document.querySelector('.tc__btn--attack');
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (attackPoint === null) {
      fail('real touch fires an attack', '.tc__btn--attack not found in the DOM');
    } else {
      const cdp = await page.context().newCDPSession(page);
      // Sampler starts BEFORE the tap: an attack state lasts ~0.4 s and a CDP
      // round trip can exceed it on a heavy page (the playtest lesson).
      const watcher = page.evaluate(TOUCH_WATCH, { durationMs: 1500 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: attackPoint.x, y: attackPoint.y, id: 1 }] });
      await sleep(60);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const touched = await watcher;
      if (touched.sawAttackState || touched.sawStage) {
        pass('real touch fires an attack', `state=${touched.sawAttackState} comboStage=${touched.sawStage}`);
      } else {
        fail('real touch fires an attack', 'CDP tap on the attack button never produced an Attack state or combo stage');
      }
    }

    // --- 2 + 3 + 4. melee kill, combo, hitstop ----------------------------
    await prep(0, 0);
    await spawnAt(F.x * 1.8, F.z * 1.8, 1, 0);
    await sleep(300);
    const killTarget = await nearestAlive(F.x * 1.8, F.z * 1.8);
    if (killTarget === null) throw new Fatal('spawnSlimes(…, 1, 0) produced no living enemy row.');
    if (killTarget.maxHp === SLIME.maxHp) pass('#2 slime def maxHp 40', `id ${killTarget.id}, kind ${killTarget.kind}`);
    else fail('#2 slime def maxHp 40', `maxHp ${killTarget.maxHp}, expected ${SLIME.maxHp}`);

    const kill = await page.evaluate(MELEE, {
      targetId: killTarget.id, ...M,
      walk: true, arrive: 1.35, walkTimeoutMs: 3000,
      cadenceMs: 130, graceMs: 600, timeoutMs: 14_000,
    });
    meleeRuns.push(kill);
    const killHits = hitsFromSamples(kill.samples);
    m.kill = {
      reason: kill.reason,
      firstPressT: round(kill.firstPressT, 2),
      killedT: round(kill.killedT, 2),
      hits: killHits.length,
      frames: kill.samples.length,
    };
    if (kill.reason === 'killed' && kill.killedT - kill.firstPressT <= KILL_TIMEOUT_S) {
      pass('#2 melee kills the slime', `dead ${(kill.killedT - kill.firstPressT).toFixed(2)} s after the first press (${killHits.length} hits)`);
    } else {
      fail('#2 melee kills the slime', `reason "${kill.reason}", first press t=${kill.firstPressT.toFixed(2)}, killed t=${kill.killedT.toFixed(2)} (limit ${KILL_TIMEOUT_S} s after first press)`);
    }

    let sawDmgLive = false;
    let maxDmgCount = 0;
    let hpUp = 0;
    const stagesSeen = new Set();
    for (let i = 0; i < kill.samples.length; i++) {
      const s = kill.samples[i];
      if (s.dmgLive === 1) sawDmgLive = true;
      if (s.dmgCount > maxDmgCount) maxDmgCount = s.dmgCount;
      if (s.stage > 0) stagesSeen.add(s.stage);
      if (i > 0 && s.alive === 1 && s.hp - kill.samples[i - 1].hp > 1e-6) hpUp++;
    }
    if (sawDmgLive) pass('#2 damage numbers appear in the DOM', `.dmg.is-live seen; peak ${maxDmgCount} .dmg nodes`);
    else fail('#2 damage numbers appear in the DOM', 'no .dmg.is-live element during a landed-hit fight');
    if (maxDmgCount <= DMG_POOL_MAX) pass('#11 damage-number pool bounded', `peak ${maxDmgCount} .dmg nodes (≤ ${DMG_POOL_MAX})`);
    else fail('#11 damage-number pool bounded', `peak ${maxDmgCount} .dmg nodes — the pool is growing, not recycling (contract: 24)`);
    if (hpUp === 0) pass('#2 slime hp never regenerates mid-fight', 'monotonic while alive');
    else fail('#2 slime hp never regenerates mid-fight', `${hpUp} sample(s) where hp increased while alive`);

    if (stagesSeen.has(1) && stagesSeen.has(2) && stagesSeen.has(3)) {
      pass('#3 combo advances 1→2→3', `stages seen: ${[...stagesSeen].sort().join(', ')}`);
    } else {
      fail('#3 combo advances 1→2→3', `stages seen while mashing: [${[...stagesSeen].sort().join(', ')}] — the cancel window or buffer is broken`);
    }
    const killTickRate = tailMean(kill.samples.map((s) => s.ticksRate), 0.7);
    m.killTickRate = round(killTickRate, 1);
    if (killTickRate >= 54 && killTickRate <= 66) {
      pass('#4 loop keeps ticking ~60/s through hitstop', `${killTickRate.toFixed(1)} /s during the fight (hitstop gates systems, not the loop)`);
    } else {
      fail('#4 loop keeps ticking ~60/s through hitstop', `${killTickRate.toFixed(1)} /s during the fight`);
    }
    let sawHitstop = false;
    let maxHsTicks = 0;
    for (const s of kill.samples) {
      if (s.hs === 1) sawHitstop = true;
      if (s.hsTicks > maxHsTicks) maxHsTicks = s.hsTicks;
    }
    if (sawHitstop) pass('#4 hitstop fires on hits', `observed active; peak ticksLeft ${maxHsTicks}`);
    else fail('#4 hitstop fires on hits', `hitstopActive never true across ${killHits.length} landed hits`);
    m.maxHitstopTicks = maxHsTicks;

    // --- 5. determinism under a fixed seed --------------------------------
    /*
     * Two identical scripted 3-press combos against a fresh adjacent slime,
     * seed 7 both times, driven via press() (the override path) for exact
     * reproducibility. The crit PRNG is one shared stream, so a slime strike
     * landing on the player mid-script would consume a roll; the script is
     * short enough (~1 s) to finish before the slime's first strike (~1.15 s).
     * One retry absorbs AI-jitter flakes; a real determinism bug fails both.
     */
    const detRun = async () => {
      await prep(0, 0);
      await page.evaluate(FACE, { moveX: 0, moveY: -1, durationMs: 250 });
      const p = await playerPos();
      const sx = p.x + F.x * 1.55;
      const sz = p.z + F.z * 1.55;
      await spawnAt(sx, sz, 1, 0);
      await sleep(250);
      const target = await nearestAlive(sx, sz);
      if (target === null) return null;
      await setSeed(7);
      // 240 ms cadence: each press arrives just as the previous swing's cancel
      // window opens (active end + hitstop), so nothing rides the 0.12 s buffer
      // to its edge — 3 presses reliably become the full A1/A2/A3 chain, and
      // the ~1 s script ends before the slime's first strike can consume a
      // roll from the shared crit stream.
      const res = await page.evaluate(COMBO_SCRIPT, { targetId: target.id, presses: 3, cadenceMs: 240, watchMs: 3200 });
      return { id: target.id, hits: res.hits, endHp: res.endHp };
    };
    const compareRuns = (a, b) => {
      if (a === null || b === null) return 'a run produced no enemy';
      // Seed 7's first roll is a crit, so 24.8 + 17.5 ≥ 40 hp: the slime
      // deterministically dies in TWO hits. Requiring the kill plus identical
      // amounts is the assertion; demanding a third hit would be wrong.
      if (a.endHp > 1e-9 || b.endHp > 1e-9) return `slime survived a run (endHp A ${a.endHp}, B ${b.endHp})`;
      if (a.hits.length < 2 || b.hits.length < 2) return `too few hits (A ${a.hits.length}, B ${b.hits.length}; expected ≥ 2)`;
      if (a.hits.length !== b.hits.length) return `hit counts differ (A ${a.hits.length}, B ${b.hits.length})`;
      for (let i = 0; i < a.hits.length; i++) {
        // Amounts are the seeded-PRNG evidence; sampled stage labels can lag a
        // frame either side of a drop and are recorded, not compared.
        if (Math.abs(a.hits[i].amount - b.hits[i].amount) > 1e-9) {
          return `hit ${i + 1} amount differs (${a.hits[i].amount} vs ${b.hits[i].amount})`;
        }
      }
      return null;
    };
    let runA = await detRun();
    let runB = await detRun();
    let detProblem = compareRuns(runA, runB);
    let detAttempts = 1;
    if (detProblem !== null) {
      detAttempts = 2;
      runA = await detRun();
      runB = await detRun();
      detProblem = compareRuns(runA, runB);
    }
    m.determinism = {
      attempts: detAttempts,
      idsMatch: runA !== null && runB !== null ? runA.id === runB.id : null,
      seriesA: runA === null ? null : runA.hits.map((h) => ({ amount: round(h.amount, 6), stage: h.stage })),
      seriesB: runB === null ? null : runB.hits.map((h) => ({ amount: round(h.amount, 6), stage: h.stage })),
    };
    if (detProblem === null) {
      pass(
        '#5 seeded damage is deterministic',
        `seed 7 twice → identical ${runA.hits.length}-hit series [${runA.hits.map((h) => h.amount.toFixed(3)).join(', ')}] (attempt ${detAttempts}${runA.id === runB.id ? ', pooled ids reused' : ', NOTE: enemy ids differed'})`,
      );
    } else {
      fail('#5 seeded damage is deterministic', `${detProblem} (after ${detAttempts} attempt(s))`);
    }

    // Formula sanity over every recorded hit: armor 0 → non-crit damage is
    // base + scaling EXACTLY, crits exactly 1.6x that (§9). Overkill excluded.
    const allHits = killHits.concat(runA?.hits ?? [], runB?.hits ?? []);
    const formula = formulaCheck(allHits);
    m.damageValues = formula.summary;
    if (allHits.length >= 4 && formula.problems.length === 0) {
      pass('#5 §9 formula sanity (armor 0 = base+scaling exactly)', formula.summary);
    } else if (allHits.length < 4) {
      unknown('#5 §9 formula sanity (armor 0 = base+scaling exactly)', `only ${allHits.length} hits recorded`);
    } else {
      fail('#5 §9 formula sanity (armor 0 = base+scaling exactly)', formula.problems.join(' | '));
    }

    // --- 6. telegraph honesty ---------------------------------------------
    await prep(0, 20);
    await page.evaluate(FACE, { moveX: 0, moveY: -1, durationMs: 250 });
    const p6 = await playerPos();
    await spawnAt(p6.x + F.x * 4.5, p6.z + F.z * 4.5, 1, 0);
    await sleep(200);
    const teleTarget = await nearestAlive(p6.x + F.x * 4.5, p6.z + F.z * 4.5);
    if (teleTarget === null) throw new Fatal('telegraph scenario: no living slime after spawn.');
    const stand = await page.evaluate(STAND, { targetId: teleTarget.id, mode: 'firstHit', timeoutMs: 15_000 });
    let teleOnsetT = -1;
    let sawFalseFirst = false;
    let longestTele = 0;
    let curStart = -1;
    let hitDuringTele = 0;
    for (const s of stand.samples) {
      if (s.tele === 0) {
        sawFalseFirst = true;
        if (curStart >= 0) {
          if (s.t - curStart > longestTele) longestTele = s.t - curStart;
          curStart = -1;
        }
      } else if (sawFalseFirst || teleOnsetT < 0) {
        if (teleOnsetT < 0) teleOnsetT = s.t;
        if (curStart < 0) curStart = s.t;
      }
      if (s.jumped === 1 && s.tele === 1) hitDuringTele++;
    }
    m.telegraph = {
      reason: stand.reason,
      onsetT: round(teleOnsetT, 3),
      firstHitT: round(stand.firstHitT, 3),
      warningS: stand.firstHitT > 0 && teleOnsetT > 0 ? round(stand.firstHitT - teleOnsetT, 3) : null,
      longestWindowS: round(longestTele, 3),
    };
    let hudDropped = false;
    for (let i = 1; i < stand.samples.length; i++) {
      if (stand.samples[i].hp >= 0 && stand.samples[i - 1].hp > stand.samples[i].hp) hudDropped = true;
    }
    if (stand.firstHitT < 0) {
      fail(
        '#6 telegraph precedes contact damage by ≥ 0.5 s',
        `no i-frame jump in 15 s (reason "${stand.reason}"; HUD hp ${hudDropped ? 'DID drop — detector disagrees with the HUD' : 'never dropped either — the slime genuinely never landed a hit'})`,
      );
    } else if (teleOnsetT < 0) {
      fail('#6 telegraph precedes contact damage by ≥ 0.5 s', 'a hit landed but telegraphing was NEVER observed true — the wind-up is missing');
    } else if (stand.firstHitT - teleOnsetT >= TELEGRAPH_MIN_S) {
      pass('#6 telegraph precedes contact damage by ≥ 0.5 s', `${(stand.firstHitT - teleOnsetT).toFixed(2)} s from wind-up start to the hit`);
    } else {
      fail('#6 telegraph precedes contact damage by ≥ 0.5 s', `only ${(stand.firstHitT - teleOnsetT).toFixed(2)} s of warning — §9 demands readable wind-ups`);
    }
    if (hitDuringTele === 0) pass('#6 no damage lands during the telegraph itself', 'every hit arrived after the wind-up ended');
    else fail('#6 no damage lands during the telegraph itself', `${hitDuringTele} hit(s) landed while telegraphing was still true`);

    // --- 8. dash i-frames beat the strike ---------------------------------
    // Same slime, still aggroed: wait for a FRESH wind-up, dash through at ~76%
    // of the 0.55 s telegraph so the 0.15 s i-frame covers the strike frame.
    const dash = await page.evaluate(DASH_THROUGH, {
      targetId: teleTarget.id, delayMs: 420, watchMs: 1400, timeoutMs: 14_000,
    });
    m.dash = {
      reason: dash.reason,
      onsetT: round(dash.onsetT, 3),
      pressT: round(dash.pressT, 3),
      sawInvuln: dash.sawInvuln,
      hpAtOnset: dash.hpAtOnset,
      minHp: dash.minHp === Infinity ? null : dash.minHp,
    };
    if (dash.reason !== 'done' || dash.hpAtOnset === null) {
      fail('#8 dash i-frames beat the strike', `no clean strike window observed (reason "${dash.reason}")`);
    } else if (dash.minHp >= dash.hpAtOnset && dash.sawInvuln) {
      pass('#8 dash i-frames beat the strike', `dashed ${((dash.pressT - dash.onsetT) * 1000).toFixed(0)} ms into the wind-up; hp held at ${dash.hpAtOnset}, invulnerability observed`);
    } else if (dash.minHp < dash.hpAtOnset) {
      fail('#8 dash i-frames beat the strike', `hp dropped ${dash.hpAtOnset} → ${dash.minHp} across the dodged strike — i-frames did not gate it`);
    } else {
      fail('#8 dash i-frames beat the strike', 'hp held but player.invulnerable was never true after the dash press — suspicious, likely a whiff, not a dodge');
    }

    // --- 9. target lock -----------------------------------------------------
    await prep(0, 0);
    const p9 = await playerPos();
    const lockedNone = await lockedId();
    await spawnAt(p9.x + F.x * 5, p9.z + F.z * 5, 1, 0); // dead ahead, in the camera cone
    await sleep(500);
    const slimeA = await nearestAlive(p9.x + F.x * 5, p9.z + F.z * 5);
    const lockedFront = await lockedId();
    await spawnAt(p9.x + R.x * 9, p9.z + R.z * 9, 1, 0); // 90° off — outside any 40° cone
    await sleep(500);
    const lockedStill = await lockedId();
    m.lock = { none: lockedNone, front: lockedFront, afterSide: lockedStill, idA: slimeA?.id ?? null };
    if (slimeA === null) {
      fail('#9 lock picks the camera-faced enemy', 'front slime failed to spawn');
    } else if (lockedFront === slimeA.id) {
      pass('#9 lock picks the camera-faced enemy', `locked id ${lockedFront} = the slime dead ahead (no-enemy value was ${String(lockedNone)})`);
    } else {
      fail('#9 lock picks the camera-faced enemy', `locked ${String(lockedFront)}, expected front slime ${slimeA.id}`);
    }
    if (slimeA !== null && lockedStill === slimeA.id) {
      pass('#9 lock is sticky against an off-cone spawn', `still ${lockedStill} after a slime appeared 90° to the side`);
    } else if (slimeA !== null) {
      fail('#9 lock is sticky against an off-cone spawn', `lock moved to ${String(lockedStill)} — a 90°-off enemy is outside the 40° cone and must not steal it`);
    }
    if (slimeA !== null) {
      const lockKill = await page.evaluate(MELEE, {
        targetId: slimeA.id, ...M,
        walk: true, arrive: 1.35, walkTimeoutMs: 4000,
        cadenceMs: 130, graceMs: 500, timeoutMs: 14_000,
      });
      meleeRuns.push(lockKill);
      await sleep(400);
      const lockedAfter = await lockedId();
      m.lock.afterKill = lockedAfter;
      if (lockKill.reason !== 'killed') {
        fail('#9 killing the target releases the lock', `could not kill the locked slime (reason "${lockKill.reason}")`);
      } else if (lockedAfter !== slimeA.id) {
        pass('#9 killing the target releases the lock', `lock left the corpse (now ${String(lockedAfter)})`);
      } else {
        fail('#9 killing the target releases the lock', `lock still points at dead slime ${slimeA.id}`);
      }
    }

    // --- 10. enemy death & conditional respawn -----------------------------
    await prep(0, 30);
    await page.evaluate(FACE, { moveX: 0, moveY: -1, durationMs: 250 });
    const p10 = await playerPos();
    const home = { x: p10.x + F.x * 1.7, z: p10.z + F.z * 1.7 };
    await spawnAt(home.x, home.z, 1, 0);
    await sleep(250);
    const respTarget = await nearestAlive(home.x, home.z);
    if (respTarget === null) throw new Fatal('respawn scenario: no living slime after spawn.');
    const respKill = await page.evaluate(MELEE, {
      targetId: respTarget.id, ...M,
      walk: true, arrive: 1.35, walkTimeoutMs: 3000,
      cadenceMs: 130, graceMs: 400, timeoutMs: 14_000,
    });
    meleeRuns.push(respKill);
    if (respKill.reason !== 'killed') fail('#10 respawn scenario kill', `could not kill the slime (reason "${respKill.reason}")`);
    const dead1 = await enemyById(respTarget.id);
    const killedWall = Date.now();

    // Far side: > 25 u away, the 12 s timer must revive it at home.
    await page.evaluate((o) => {
      const d = globalThis.__ARCANUM_DEBUG__;
      d.clearInput();
      d.warp(o.x, o.z);
    }, { x: 0, z: 75 });
    const farPlayer = await playerPos();
    const farDist = Math.hypot(farPlayer.x - home.x, farPlayer.z - home.z);
    let revived = null;
    let revivedAtMs = -1;
    while (Date.now() - killedWall < 17_000) {
      const row = await enemyById(respTarget.id);
      if (row !== null && row.alive) {
        revived = row;
        revivedAtMs = Date.now() - killedWall;
        break;
      }
      await sleep(500);
    }
    m.respawnFar = {
      playerDistFromHome: round(farDist, 1),
      revivedAtMs,
      revivedPos: revived === null ? null : { x: round(revived.x, 2), z: round(revived.z, 2) },
      home: { x: round(home.x, 2), z: round(home.z, 2) },
    };
    if (dead1 !== null && dead1.alive) {
      fail('#10 slime respawns after 12 s when the player is far', 'the slime was still alive after the kill grace — cannot test');
    } else if (revived === null) {
      fail('#10 slime respawns after 12 s when the player is far', `player ${farDist.toFixed(0)} u from home, but no respawn within 17 s of death`);
    } else if (revivedAtMs >= 10_000 && Math.hypot(revived.x - home.x, revived.z - home.z) <= 4) {
      pass('#10 slime respawns after 12 s when the player is far', `alive again at t+${(revivedAtMs / 1000).toFixed(1)} s, ${Math.hypot(revived.x - home.x, revived.z - home.z).toFixed(1)} u from home (player ${farDist.toFixed(0)} u away)`);
    } else {
      fail('#10 slime respawns after 12 s when the player is far', `revived at t+${(revivedAtMs / 1000).toFixed(1)} s at ${Math.hypot(revived.x - home.x, revived.z - home.z).toFixed(1)} u from home — expected ~12 s and the home point`);
    }

    // Near side: kill again, STAY within 25 u — it must NOT respawn.
    if (revived !== null) {
      await page.evaluate((o) => {
        const d = globalThis.__ARCANUM_DEBUG__;
        d.clearInput();
        d.warp(o.x, o.z);
      }, { x: home.x - F.x * 3, z: home.z - F.z * 3 });
      await sleep(300);
      const respKill2 = await page.evaluate(MELEE, {
        targetId: respTarget.id, ...M,
        walk: true, arrive: 1.35, walkTimeoutMs: 4000,
        cadenceMs: 130, graceMs: 400, timeoutMs: 14_000,
      });
      meleeRuns.push(respKill2);
      if (respKill2.reason !== 'killed') {
        fail('#10 dead slime stays dead while the player camps it', `second kill failed (reason "${respKill2.reason}")`);
      } else {
        const killed2Wall = Date.now();
        let cameBack = false;
        let maxCampDist = 0;
        while (Date.now() - killed2Wall < 13_500) {
          const row = await enemyById(respTarget.id);
          const pp = await playerPos();
          const dist = Math.hypot(pp.x - home.x, pp.z - home.z);
          if (dist > maxCampDist) maxCampDist = dist;
          if (row !== null && row.alive) {
            cameBack = true;
            break;
          }
          await sleep(1000);
        }
        m.respawnNear = { campedDistMax: round(maxCampDist, 1), cameBack };
        if (maxCampDist > 25) {
          fail('#10 dead slime stays dead while the player camps it', `the "camping" player drifted ${maxCampDist.toFixed(1)} u from home — premise broken, result meaningless`);
        } else if (!cameBack) {
          pass('#10 dead slime stays dead while the player camps it', `still dead 13.5 s after death with the player ${maxCampDist.toFixed(1)} u away (< 25)`);
        } else {
          fail('#10 dead slime stays dead while the player camps it', `respawned while the player camped ${maxCampDist.toFixed(1)} u from home — the 25 u rule is not enforced`);
        }
      }
    }

    // --- 7. player is hurt, dies, respawns --------------------------------
    /*
     * Ten slimes ringed on top of a standing player. The 0.6 s post-hit
     * i-frames cap incoming damage at ~1 hit / 0.6 s whatever the pack size,
     * which is itself the assertion: 260 hp / 8 per hit ≈ 33 hits ≈ 25-40 s.
     * Arena (0, 45): 13 u from the camped slime's home, so that corpse stays
     * dead and cannot interfere.
     */
    await prep(0, 45);
    await spawnAt(0, 45, 10, 1.6);
    const death = await page.evaluate(STAND, { targetId: -1, mode: 'death', timeoutMs: 80_000 });
    const hitTimes = [];
    let minHudHp = Infinity;
    let maxHudHp = -1;
    for (const s of death.samples) {
      if (s.jumped === 1) hitTimes.push(s.t);
      if (s.hp >= 0 && s.hp < minHudHp) minHudHp = s.hp;
      if (s.maxHp > maxHudHp) maxHudHp = s.maxHp;
    }
    let minSpacing = Infinity;
    for (let i = 1; i < hitTimes.length; i++) {
      const gap = hitTimes[i] - hitTimes[i - 1];
      if (gap < minSpacing) minSpacing = gap;
    }
    const last = death.samples.length > 0 ? death.samples[death.samples.length - 1] : null;
    const lastDist = last === null ? Infinity : Math.hypot(last.px, last.pz);
    m.death = {
      reason: death.reason,
      hits: hitTimes.length,
      minHitSpacingS: minSpacing === Infinity ? null : round(minSpacing, 3),
      minHudHp: minHudHp === Infinity ? null : minHudHp,
      downT: round(death.downT, 2),
      respawnT: round(death.respawnT, 2),
      downDurationS: death.downT > 0 && death.respawnT > 0 ? round(death.respawnT - death.downT, 2) : null,
      respawnPos: last === null ? null : { x: round(last.px, 2), z: round(last.pz, 2) },
      respawnHp: last === null ? null : `${last.hp}/${last.maxHp}`,
    };
    if (hitTimes.length >= 3) pass('#7 the player can be hurt', `${hitTimes.length} hits landed (HUD hp fell to ${minHudHp === Infinity ? '?' : minHudHp})`);
    else fail('#7 the player can be hurt', `only ${hitTimes.length} hit(s) landed in ${(death.samples.length > 0 ? death.samples[death.samples.length - 1].t : 0).toFixed(0)} s among 10 slimes`);
    if (hitTimes.length >= 2 && minSpacing > HIT_SPACING_MIN_S) {
      pass('#7 post-hit i-frames gate hits (≥ 0.55 s apart)', `closest pair ${minSpacing.toFixed(2)} s apart over ${hitTimes.length} hits from 10 attackers`);
    } else if (hitTimes.length >= 2) {
      fail('#7 post-hit i-frames gate hits (≥ 0.55 s apart)', `two hits only ${minSpacing.toFixed(2)} s apart — the 0.6 s i-frame window is not being honoured`);
    } else {
      unknown('#7 post-hit i-frames gate hits (≥ 0.55 s apart)', 'fewer than 2 hits recorded');
    }
    if (death.sawDown && minHudHp === 0) pass('#7 hp reaches 0 and the player enters Down', `Down at t=${death.downT.toFixed(1)} s`);
    else fail('#7 hp reaches 0 and the player enters Down', `sawDown=${death.sawDown}, min HUD hp ${minHudHp === Infinity ? 'unread' : minHudHp} (timeout reason "${death.reason}")`);
    if (death.reason === 'respawned' && death.respawnT - death.downT >= 1.0 && death.respawnT - death.downT <= DOWN_TO_RESPAWN_MAX_S) {
      pass('#7 Down lasts ~1.6 s then respawn', `${(death.respawnT - death.downT).toFixed(2)} s in Down`);
    } else {
      fail('#7 Down lasts ~1.6 s then respawn', `reason "${death.reason}", Down ${death.downT.toFixed(1)} → ${death.respawnT.toFixed(1)} s (expected 1.0–${DOWN_TO_RESPAWN_MAX_S} s)`);
    }
    if (last !== null && lastDist <= 3 && last.hp === last.maxHp && last.hp > 0) {
      pass('#7 respawn at spawn with full hp', `at (${last.px.toFixed(1)}, ${last.pz.toFixed(1)}), hp ${last.hp}/${last.maxHp}`);
    } else {
      fail('#7 respawn at spawn with full hp', last === null ? 'no samples' : `at (${last.px.toFixed(1)}, ${last.pz.toFixed(1)}) — ${lastDist.toFixed(1)} u from spawn — hp ${last.hp}/${last.maxHp}`);
    }

    // --- 4 (continued). hitstop freeze contrast, across every melee run ----
    let frozen = { pairs: 0, movePairs: 0, phaseDelta: 0, maxEnemyMove: 0, framesAlwaysAdvance: true };
    for (const run of meleeRuns) {
      const s = frozenPairStats(run.samples);
      frozen.pairs += s.pairs;
      frozen.movePairs += s.movePairs;
      frozen.phaseDelta += s.phaseDelta;
      if (s.maxEnemyMove > frozen.maxEnemyMove) frozen.maxEnemyMove = s.maxEnemyMove;
      if (!s.framesAlwaysAdvance) frozen.framesAlwaysAdvance = false;
    }
    m.hitstopFreeze = {
      pairs: frozen.pairs,
      movePairs: frozen.movePairs,
      dayPhaseDelta: round(frozen.phaseDelta, 6),
      maxEnemyMoveU: round(frozen.maxEnemyMove, 4),
      framesAlwaysAdvance: frozen.framesAlwaysAdvance,
    };
    if (maxHsTicks <= HITSTOP_MAX_TICKS) {
      pass('#4 hitstop is bounded (≤ 7 ticks)', `peak ticksLeft ${maxHsTicks} across all fights`);
    } else {
      fail('#4 hitstop is bounded (≤ 7 ticks)', `peak ticksLeft ${maxHsTicks} — light is 4, heavy 6; something is stacking freezes`);
    }
    if (frozen.pairs === 0) {
      unknown('#4 world keeps breathing during hitstop', `no two consecutive rAF samples both landed inside a freeze across ${meleeRuns.length} fights — the rasteriser is too slow to see inside a 4-6 tick window`);
    } else {
      if (frozen.phaseDelta > 1e-6 && frozen.framesAlwaysAdvance) {
        pass('#4 world keeps breathing during hitstop', `${frozen.pairs} frozen sample-pairs: dayPhase advanced ${frozen.phaseDelta.toExponential(2)}, frameCount always advanced`);
      } else {
        fail('#4 world keeps breathing during hitstop', `frozen pairs ${frozen.pairs}: dayPhase delta ${frozen.phaseDelta.toExponential(2)} (must be > 0), framesAdvance=${frozen.framesAlwaysAdvance} — hitstop is freezing the whole game, §9 wants only the fight frozen`);
      }
      if (frozen.movePairs === 0) {
        unknown('#4 the fight IS frozen during hitstop', 'no frozen pair had a living enemy to measure');
      } else if (frozen.maxEnemyMove <= 0.05) {
        pass('#4 the fight IS frozen during hitstop', `enemy moved ≤ ${frozen.maxEnemyMove.toFixed(4)} u across ${frozen.movePairs} frozen pairs (knockback would be ~0.15 u/frame if ungated)`);
      } else {
        fail('#4 the fight IS frozen during hitstop', `enemy moved ${frozen.maxEnemyMove.toFixed(3)} u inside a freeze — gated systems are not early-returning`);
      }
    }

    // --- 11 + 12. brawl budgets, hygiene, screenshot ----------------------
    await prep(0, 0);
    await page.evaluate(FACE, { moveX: 0, moveY: -1, durationMs: 200 });
    await spawnAt(0, 0, 6, 2.5);
    await sleep(300);
    const brawlPromise = page.evaluate(BRAWL, { durationMs: 10_000, cadenceMs: 150 });
    await sleep(3500);
    if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS, 'combattest.png') });
    const shotState = await page.evaluate(() => ({
      dmgLive: document.querySelectorAll('.dmg.is-live').length,
      alive: globalThis.__ARCANUM_DEBUG__.enemies().filter((e) => e.alive).length,
    }));
    pass('#12 screenshot written', `artifacts/combattest.png mid-brawl (${shotState.alive} slimes alive, ${shotState.dmgLive} live damage numbers at capture)`);
    const brawl = await brawlPromise;

    const peakDraws = maxOf(brawl.drawCalls);
    const peakTris = maxOf(brawl.triangles);
    const peakHeap = maxOf(brawl.heapMb);
    const brawlHsMax = maxOf(brawl.hsTicks);
    const driftMb = brawl.count > 1 ? brawl.heapMb[brawl.count - 1] - brawl.heapMb[0] : 0;
    const bytesPerFrame = brawl.count > 1 ? (driftMb * 1024 * 1024) / brawl.count : 0;
    const sortedFrames = brawl.frameMs.slice(1).sort((a, b) => a - b);
    m.brawl = {
      frames: brawl.count,
      peakDrawCalls: peakDraws,
      peakTriangles: peakTris,
      peakHeapMb: round(peakHeap, 1),
      heapBytesPerFrame: Math.round(bytesPerFrame),
      medianFrameMs: round(sortedFrames[Math.floor(sortedFrames.length / 2)] ?? 0, 2),
      maxHitstopTicks: brawlHsMax,
    };
    if (peakDraws <= BUDGET.drawCalls) pass('#11 draw calls ≤ 110 in a 6-slime brawl', `peak ${peakDraws}`);
    else fail('#11 draw calls ≤ 110 in a 6-slime brawl', `peak ${peakDraws}`);
    if (peakTris <= BUDGET.triangles) pass('#11 triangles ≤ 150000 in a brawl', `peak ${peakTris}`);
    else fail('#11 triangles ≤ 150000 in a brawl', `peak ${peakTris}`);
    if (peakHeap <= BUDGET.heapMb) pass('#11 heap ≤ 280 MB', `peak ${peakHeap.toFixed(1)} MB`);
    else fail('#11 heap ≤ 280 MB', `peak ${peakHeap.toFixed(1)} MB`);
    if (bytesPerFrame < HEAP_BYTES_PER_FRAME) {
      pass('#11 no per-frame allocation in combat', `${bytesPerFrame.toFixed(0)} B/frame over ${brawl.count} frames of brawling`);
    } else {
      fail('#11 no per-frame allocation in combat', `${bytesPerFrame.toFixed(0)} B/frame — combat is allocating (§3 wants 0; pools are being bypassed)`);
    }
    if (brawlHsMax <= HITSTOP_MAX_TICKS) pass('#11 hitstop stays bounded under pack pressure', `peak ticksLeft ${brawlHsMax}`);
    else fail('#11 hitstop stays bounded under pack pressure', `peak ticksLeft ${brawlHsMax} — overlapping hits are stacking freezes`);

    // --- series for the JSON ----------------------------------------------
    report.series = {
      note: 'kill = first melee kill (per-rAF); death = standing death (every 3rd sample); brawl = allocation-free 10 s sampler.',
      kill: {
        t: roundSeries(kill.samples.map((s) => s.t), 3),
        hp: roundSeries(kill.samples.map((s) => s.hp), 3),
        stage: kill.samples.map((s) => s.stage),
        hs: kill.samples.map((s) => s.hs),
        hsTicks: kill.samples.map((s) => s.hsTicks),
        phase: roundSeries(kill.samples.map((s) => s.phase), 6),
        dmgCount: kill.samples.map((s) => s.dmgCount),
      },
      death: {
        t: roundSeries(death.samples.filter((_, i) => i % 3 === 0).map((s) => s.t), 2),
        hp: death.samples.filter((_, i) => i % 3 === 0).map((s) => s.hp),
        jumped: death.samples.filter((_, i) => i % 3 === 0).map((s) => s.jumped),
        down: death.samples.filter((_, i) => i % 3 === 0).map((s) => s.down),
      },
      brawl: {
        t: roundSeries(brawl.t, 3),
        frameMs: roundSeries(brawl.frameMs, 2),
        drawCalls: brawl.drawCalls,
        triangles: brawl.triangles,
        heapMb: roundSeries(brawl.heapMb, 3),
        hsTicks: brawl.hsTicks,
      },
    };
  } catch (error) {
    if (!hardTimedOut && interrupted === null) {
      if (error instanceof Fatal) fail('harness precondition', error.message);
      else fail('harness error', error?.stack ?? String(error));
    }
  }

  /*
   * Outside the try on purpose: when the boot fails, the page's own exception
   * is the most useful line in the report and must not be skipped.
   */
  if (report.pageErrors.length === 0) pass('#1 no uncaught page errors', '0');
  else fail('#1 no uncaught page errors', report.pageErrors.join(' | '));
  if (report.consoleErrors.length === 0) pass('#1 no console errors', '0');
  else fail('#1 no console errors', report.consoleErrors.join(' | '));

  if (interrupted !== null) fail('interrupted', `${interrupted} received — no verdict.`);
  if (hardTimedOut) fail('overall timeout', `exceeded ${OVERALL_TIMEOUT_MS} ms`);

  const failed = report.checks.filter((c) => c.status === 'FAIL');
  report.verdict = failed.length === 0 ? 'PASS' : 'FAIL';
  report.durationMs = Date.now() - startedAt;

  printSummary();

  if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(path.join(ARTIFACTS, 'combattest.json'), JSON.stringify(report, null, 2));

  await cleanup();
  process.exit(interrupted !== null ? 130 : report.verdict === 'PASS' ? 0 : 1);
}

function printSummary() {
  const m = report.measurements;
  const row = (label, value, expected) =>
    console.log('  ' + label.padEnd(34) + String(value).padStart(16) + '   ' + expected);

  console.log('\n' + '='.repeat(78));
  console.log('ARCANUM DRIFT — PHASE 3 COMBAT GATE');
  console.log('='.repeat(78));

  console.log('\nMELEE');
  row('kill time (after first press)', m.kill ? `${(m.kill.killedT - m.kill.firstPressT).toFixed(2)} s` : '-', `<= ${KILL_TIMEOUT_S} s for 40 hp`);
  row('hits in the kill', m.kill?.hits ?? '-', '~4-7');
  row('tick rate mid-fight', (m.killTickRate ?? 0) + ' /s', '~60');

  console.log('\nHITSTOP');
  row('peak ticksLeft', m.maxHitstopTicks ?? '-', `<= ${HITSTOP_MAX_TICKS} (light 4 / heavy 6)`);
  const hf = m.hitstopFreeze ?? {};
  row('frozen sample-pairs', hf.pairs ?? 0, '> 0 to measure the contrast');
  row('dayPhase moved while frozen', hf.dayPhaseDelta ?? '-', '> 0 (world not gated)');
  row('enemy moved while frozen', (hf.maxEnemyMoveU ?? '-') + ' u', '<= 0.05 (fight IS gated)');

  console.log('\nENEMY');
  const tg = m.telegraph ?? {};
  row('telegraph warning', (tg.warningS ?? '-') + ' s', `>= ${TELEGRAPH_MIN_S}`);
  const d7 = m.death ?? {};
  row('hits taken to die', d7.hits ?? '-', '~33 (260 hp / 8)');
  row('closest hit spacing', (d7.minHitSpacingS ?? '-') + ' s', `> ${HIT_SPACING_MIN_S} (i-frames)`);
  row('Down duration', (d7.downDurationS ?? '-') + ' s', '~1.6');
  const rf = m.respawnFar ?? {};
  row('enemy respawn (player far)', rf.revivedAtMs > 0 ? (rf.revivedAtMs / 1000).toFixed(1) + ' s' : '-', '~12 s');
  row('enemy respawn (player near)', m.respawnNear ? (m.respawnNear.cameBack ? 'CAME BACK' : 'stayed dead') : '-', 'stayed dead');

  console.log('\nBUDGETS (§3, 6-slime brawl)');
  const b = m.brawl ?? {};
  row('draw calls (peak)', b.peakDrawCalls ?? '-', '<= 110');
  row('triangles (peak)', b.peakTriangles ?? '-', '<= 150000');
  row('heap (peak)', (b.peakHeapMb ?? '-') + ' MB', '<= 280');
  row('heap drift', (b.heapBytesPerFrame ?? '-') + ' B/frame', `< ${HEAP_BYTES_PER_FRAME}`);
  row('median frame time', (b.medianFrameMs ?? '-') + ' ms', 'SwiftShader baseline only');

  console.log('\nCHECKS');
  for (const check of report.checks) {
    const mark = check.status === 'PASS' ? 'ok  ' : 'FAIL';
    console.log(`  [${mark}] ${check.name}  —  ${check.detail}`);
  }

  console.log('\nHONEST LIMITS OF THIS RUN');
  console.log('  SwiftShader software rendering: frame times here are NOT device');
  console.log('  numbers. What transfers to a phone is timing correctness (combo,');
  console.log('  telegraph, i-frames, hitstop bounds), determinism, budgets, and');
  console.log('  error-freedom. §12\'s actual acceptance criterion — "hitting a slime');
  console.log('  feels satisfying without VFX" — is a FEEL judgement that no headless');
  console.log('  harness can make. This gate proves the numbers the feel is built');
  console.log('  from; the verdict on feel itself requires the real-handset test, and');
  console.log('  if it fails there, §12 says fix the timing, not add VFX.');

  const failedCount = report.checks.filter((c) => c.status === 'FAIL').length;
  console.log(
    `\nVERDICT     ${report.verdict}  (${report.checks.length - failedCount} passed, ${failedCount} failed, ${report.durationMs} ms)`,
  );
  console.log('='.repeat(78) + '\n');
}

process.on('unhandledRejection', (reason) => {
  console.error('[combattest] unhandled rejection:', reason);
  void cleanup().finally(() => process.exit(1));
});

await main();
