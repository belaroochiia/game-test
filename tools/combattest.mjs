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

/** Per-hit series from an enemy-hp sample series: drops become hits. */
function hitsFromSamples(samples) {
  const hits = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev.alive === 0) continue;
    const d = prev.hp - cur.hp;
    if (d > 1e-9) hits.push({ t: cur.t, amount: d, stage: cur.stage });
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
 * §9 formula sanity without knowing statScaling: within one combo stage every
 * armor-0 hit must be either v (non-crit, = base + scaling exactly) or 1.6v.
 * So the distinct values per stage cluster to at most two, the big one is
 * exactly 1.6x the small one, and the small one is ≥ the stage base.
 */
function clusterCheck(hits) {
  const byStage = new Map();
  for (const hit of hits) {
    if (!byStage.has(hit.stage)) byStage.set(hit.stage, []);
    byStage.get(hit.stage).push(hit.amount);
  }
  const problems = [];
  const summary = [];
  for (const [stage, values] of byStage) {
    const distinct = [];
    for (const v of values) {
      let found = false;
      for (const d of distinct) {
        if (Math.abs(v - d) <= Math.max(1e-6, d * 1e-9)) {
          found = true;
          break;
        }
      }
      if (!found) distinct.push(v);
    }
    distinct.sort((a, b) => a - b);
    const base = STAGE_BASE[stage] ?? 0;
    summary.push(`stage ${stage}: ${values.length} hits, values [${distinct.map((v) => v.toFixed(4)).join(', ')}]`);
    if (distinct.length > 2) {
      problems.push(`stage ${stage} has ${distinct.length} distinct damage values (${distinct.map((v) => v.toFixed(4)).join(', ')}) — expected {v, 1.6v}`);
      continue;
    }
    const low = distinct[0];
    if (stage >= 1 && stage <= 3 && low < base - 1e-9) {
      problems.push(`stage ${stage} non-crit ${low.toFixed(4)} is BELOW its base ${base} — scaling cannot be negative`);
    }
    if (distinct.length === 2) {
      const ratio = distinct[1] / distinct[0];
      if (Math.abs(ratio - CRIT_MULT) > 1e-6) {
        problems.push(`stage ${stage} value ratio ${ratio.toFixed(6)} is not the crit multiplier ${CRIT_MULT}`);
      }
    }
  }
  return { problems, summary };
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
          if (d > 1e-9) hits.push({ t: samples[i].t, amount: d, stage: samples[i].stage });
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
    let prevIFrames = -1;
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
      const jumped = prevIFrames >= 0 && c.playerIFrames > prevIFrames + 0.05 ? 1 : 0;
      prevIFrames = c.playerIFrames;
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

// __PART2__
