#!/usr/bin/env node
/**
 * Arcanum Drift — Phase 1 gameplay gate.
 *
 * Boots the built bundle in headless Chromium and drives the player through
 * `__ARCANUM_DEBUG__`, asserting §7's movement numbers and §12's Phase 1
 * acceptance criterion ("walk/sprint/dash smoothly, camera never through the
 * ground") plus the §3 budgets.
 *
 * Sampling happens INSIDE the page on requestAnimationFrame, not over CDP: a
 * round trip per frame would cost more than the thing being measured.
 *
 * Like tools/smoke.mjs this runs on SwiftShader, so frame timings here describe a
 * software rasteriser, not a phone. Geometry budgets, movement numbers, collision
 * correctness and error-freedom are all still real.
 *
 * Usage: npm run build && npm run playtest
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
/** Deliberately not smoke.mjs's 4173, so both can run without colliding. */
const PORT = 4174;
const URL_ = `http://${HOST}:${PORT}/`;

const OVERALL_TIMEOUT_MS = 180_000;
const SERVER_TIMEOUT_MS = 30_000;

const BUDGET = { drawCalls: 110, triangles: 150_000, heapMb: 280 };

/** §7 */
const WALK_SPEED = 4;
const SPRINT_SPEED = 7;
const SPEED_TOLERANCE = 0.12;
const DASH_MIN_PEAK = 12;
const DASH_DURATION = 0.18;
const DASH_DURATION_TOLERANCE = 0.04;
const DASH_IFRAME = 0.15;
const GROUND_TOLERANCE = 0.12;
const CAMERA_CLEARANCE = 0.2;

const CHROMIUM_ARGS = [
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--proxy-server=direct://',
  '--proxy-bypass-list=*',
  '--enable-precise-memory-info',
  '--hide-scrollbars',
  '--mute-audio',
];

// ---------------------------------------------------------------------------
// process plumbing
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
    console.error(`\n[playtest] ${signal} received — tearing down.`);
    setTimeout(() => process.exit(130), 4000).unref();
    void cleanup().finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const report = {
  tool: 'tools/playtest.mjs',
  phase: 1,
  durationMs: 0,
  verdict: 'FAIL',
  renderingBackend: 'SwiftShader (software) — frame timings are NOT device numbers',
  budgets: BUDGET,
  measurements: {},
  consoleErrors: [],
  pageErrors: [],
  checks: [],
};

class Fatal extends Error {}

function record(name, status, detail) {
  report.checks.push({ name, status, detail });
  return status !== 'FAIL';
}
const pass = (name, detail) => record(name, 'PASS', detail);
const fail = (name, detail) => record(name, 'FAIL', detail);

function within(value, target, tolerance) {
  return Math.abs(value - target) <= target * tolerance;
}

// ---------------------------------------------------------------------------
// server
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
// in-page driver
// ---------------------------------------------------------------------------

/**
 * Runs inside the browser. Applies `input`, then samples once per rAF for
 * `durationMs`, returning the series. Self-contained on purpose — it is
 * serialised across the CDP boundary.
 */
const SAMPLER = (options) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    if (options.warp) debug.warp(options.warp[0], options.warp[1]);
    if (options.clear) debug.clearInput();
    if (options.input) debug.setInput(options.input);
    if (options.press) debug.press(options.press);

    const samples = [];
    const started = performance.now();

    const tick = () => {
      const now = performance.now();
      const p = debug.player();
      const c = debug.camera();
      const m = debug.metrics();
      if (options.look) debug.setInput({ lookDX: options.look, lookDY: 0 });
      samples.push({
        t: (now - started) / 1000,
        x: p.x,
        y: p.y,
        z: p.z,
        speed: p.speed,
        state: p.state,
        grounded: p.grounded,
        dashCd: p.dashCooldownLeft,
        invulnerable: p.invulnerable,
        groundY: debug.terrainHeightAt(p.x, p.z),
        camX: c.x,
        camY: c.y,
        camZ: c.z,
        camGroundY: debug.terrainHeightAt(c.x, c.z),
        fov: c.fov,
        drawCalls: m.drawCalls,
        triangles: m.triangles,
        heapMb: m.heapMb,
        ticks: m.ticks,
      });
      if (now - started >= options.durationMs) {
        debug.clearInput();
        resolve(samples);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** Mean of `key` over the last `fraction` of the series — skips the accel ramp. */
function steadyMean(samples, key, fraction = 0.55) {
  const start = Math.floor(samples.length * (1 - fraction));
  let sum = 0;
  let count = 0;
  for (let i = start; i < samples.length; i++) {
    sum += samples[i][key];
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function peak(samples, key) {
  let best = -Infinity;
  for (const s of samples) if (s[key] > best) best = s[key];
  return best;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  hardTimer = setTimeout(() => {
    hardTimedOut = true;
    console.error(`[playtest] HARD TIMEOUT after ${OVERALL_TIMEOUT_MS} ms — killing everything.`);
    void cleanup();
    setTimeout(() => process.exit(1), 1500);
  }, OVERALL_TIMEOUT_MS);
  hardTimer.unref?.();

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

    await page.waitForFunction(() => globalThis.__ARCANUM_DEBUG__ !== undefined, { timeout: 15_000 });
    const shape = await page.evaluate(() => {
      const d = globalThis.__ARCANUM_DEBUG__;
      const needed = ['setInput', 'clearInput', 'press', 'player', 'camera', 'terrainHeightAt', 'warp'];
      return { missing: needed.filter((k) => typeof d[k] !== 'function'), version: d.version };
    });
    if (shape.missing.length > 0) {
      throw new Fatal(`__ARCANUM_DEBUG__ is missing: ${shape.missing.join(', ')}`);
    }
    pass('__ARCANUM_DEBUG__ shape', `complete, version ${shape.version}`);

    await page.waitForFunction(() => globalThis.__ARCANUM_DEBUG__.frameCount() > 40, { timeout: 15_000 });
    pass('render loop running', 'frameCount passed 40');

    // --- 3. walk speed ----------------------------------------------------
    const walk = await page.evaluate(SAMPLER, {
      durationMs: 1600,
      warp: [0, 0],
      clear: true,
      input: { moveX: 0, moveY: -1, sprint: false },
    });
    const walkSpeed = steadyMean(walk, 'speed');
    report.measurements.walkSpeed = walkSpeed;
    if (within(walkSpeed, WALK_SPEED, SPEED_TOLERANCE)) {
      pass('walk speed ~4 u/s', `${walkSpeed.toFixed(2)} u/s`);
    } else {
      fail('walk speed ~4 u/s', `measured ${walkSpeed.toFixed(2)} u/s, expected 4 +/-12%`);
    }

    // --- 4. sprint speed --------------------------------------------------
    const sprint = await page.evaluate(SAMPLER, {
      durationMs: 1600,
      warp: [0, 0],
      clear: true,
      input: { moveX: 0, moveY: -1, sprint: true },
    });
    const sprintSpeed = steadyMean(sprint, 'speed');
    report.measurements.sprintSpeed = sprintSpeed;
    if (within(sprintSpeed, SPRINT_SPEED, SPEED_TOLERANCE)) {
      pass('sprint speed ~7 u/s', `${sprintSpeed.toFixed(2)} u/s`);
    } else {
      fail('sprint speed ~7 u/s', `measured ${sprintSpeed.toFixed(2)} u/s, expected 7 +/-12%`);
    }

    // --- 7. ground adherence ---------------------------------------------
    const roam = await page.evaluate(SAMPLER, {
      durationMs: 3000,
      warp: [-14, -14],
      clear: true,
      input: { moveX: 0.7, moveY: -0.7, sprint: false },
    });
    let worstGround = 0;
    let worstGroundAt = '';
    let airborneFrames = 0;
    for (const s of roam) {
      const deviation = Math.abs(s.y - s.groundY);
      if (deviation > worstGround) {
        worstGround = deviation;
        worstGroundAt = `x=${s.x.toFixed(2)} z=${s.z.toFixed(2)} y=${s.y.toFixed(3)} ground=${s.groundY.toFixed(3)}`;
      }
      if (!s.grounded) airborneFrames++;
    }
    report.measurements.worstGroundDeviation = worstGround;
    if (worstGround < GROUND_TOLERANCE) {
      pass('player follows the ground', `worst deviation ${worstGround.toFixed(4)} u (< ${GROUND_TOLERANCE})`);
    } else {
      fail(
        'player follows the ground',
        `worst deviation ${worstGround.toFixed(4)} u at ${worstGroundAt} — heightAt disagrees with the mesh, or ground snapping is wrong`,
      );
    }
    report.measurements.airborneFraction = roam.length > 0 ? airborneFrames / roam.length : 0;

    // --- 8. camera never underground (half of §12's criterion) ------------
    const orbit = await page.evaluate(SAMPLER, {
      durationMs: 6000,
      warp: [8, -6],
      clear: true,
      input: { moveX: 0.6, moveY: -0.8, sprint: true },
      look: 9,
    });
    let worstMargin = Infinity;
    let worstMarginAt = '';
    for (const s of orbit) {
      const margin = s.camY - s.camGroundY;
      if (margin < worstMargin) {
        worstMargin = margin;
        worstMarginAt = `cam=(${s.camX.toFixed(2)}, ${s.camY.toFixed(2)}, ${s.camZ.toFixed(2)}) ground=${s.camGroundY.toFixed(2)}`;
      }
    }
    report.measurements.worstCameraMargin = worstMargin;
    if (worstMargin > CAMERA_CLEARANCE) {
      pass('camera never below terrain', `worst margin ${worstMargin.toFixed(3)} u above ground`);
    } else {
      fail(
        'camera never below terrain',
        `worst margin ${worstMargin.toFixed(3)} u at ${worstMarginAt} — needs > ${CAMERA_CLEARANCE}`,
      );
    }

    // FOV should have widened while sprinting (§7).
    const maxFov = peak(orbit, 'fov');
    report.measurements.maxFov = maxFov;
    if (maxFov > 70) pass('sprint widens FOV to ~72', `peak ${maxFov.toFixed(1)} deg`);
    else fail('sprint widens FOV to ~72', `peak only ${maxFov.toFixed(1)} deg`);

    // --- 5 + 6. dash burst, i-frame, cooldown refusal ---------------------
    const dash = await page.evaluate(SAMPLER, {
      durationMs: 1400,
      warp: [0, 0],
      clear: true,
      press: 'dash',
    });
    const dashPeak = peak(dash, 'speed');
    let dashFrames = 0;
    let iframeFirst = Infinity;
    let iframeLast = -Infinity;
    for (const s of dash) {
      if (s.state === 'Dash') dashFrames++;
      if (s.invulnerable) {
        if (s.t < iframeFirst) iframeFirst = s.t;
        if (s.t > iframeLast) iframeLast = s.t;
      }
    }
    const frameStep = dash.length > 1 ? dash[dash.length - 1].t / (dash.length - 1) : 1 / 60;
    const dashLength = dashFrames * frameStep;
    const iframeLength = iframeLast > iframeFirst ? iframeLast - iframeFirst + frameStep : 0;
    report.measurements.dashPeakSpeed = dashPeak;
    report.measurements.dashDuration = dashLength;
    report.measurements.iframeDuration = iframeLength;

    if (dashPeak > DASH_MIN_PEAK) pass('dash peak > 12 u/s', `${dashPeak.toFixed(2)} u/s`);
    else fail('dash peak > 12 u/s', `only ${dashPeak.toFixed(2)} u/s`);

    if (Math.abs(dashLength - DASH_DURATION) <= DASH_DURATION_TOLERANCE) {
      pass('dash burst ~0.18 s', `${dashLength.toFixed(3)} s`);
    } else {
      fail('dash burst ~0.18 s', `${dashLength.toFixed(3)} s, expected 0.18 +/-0.04`);
    }

    if (Math.abs(iframeLength - DASH_IFRAME) <= 0.05) {
      pass('dash i-frame ~0.15 s', `${iframeLength.toFixed(3)} s`);
    } else {
      fail('dash i-frame ~0.15 s', `${iframeLength.toFixed(3)} s, expected 0.15 +/-0.05`);
    }

    // Second dash inside the 1.2 s cooldown must be refused.
    const refusal = await page.evaluate(async (args) => {
      const debug = globalThis.__ARCANUM_DEBUG__;
      debug.warp(0, 0);
      debug.clearInput();
      debug.press('dash');
      await new Promise((r) => setTimeout(r, args.gapMs));
      const cdBefore = debug.player().dashCooldownLeft;
      debug.press('dash');
      let peakAfter = 0;
      const started = performance.now();
      await new Promise((resolve) => {
        const tick = () => {
          const p = debug.player();
          if (p.speed > peakAfter) peakAfter = p.speed;
          if (performance.now() - started > 300) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { cdBefore, peakAfter };
    }, { gapMs: 400 });
    report.measurements.dashRefusal = refusal;
    if (refusal.cdBefore > 0 && refusal.peakAfter < DASH_MIN_PEAK) {
      pass('second dash refused inside cooldown', `cooldown ${refusal.cdBefore.toFixed(2)} s left, peak ${refusal.peakAfter.toFixed(2)} u/s`);
    } else {
      fail(
        'second dash refused inside cooldown',
        `cooldown ${refusal.cdBefore.toFixed(2)} s, peak after ${refusal.peakAfter.toFixed(2)} u/s — expected no second burst`,
      );
    }

    // --- 9. slope limit ---------------------------------------------------
    // The ridge sits at x=+14; push into its uphill flank from the low side.
    const slope = await page.evaluate(SAMPLER, {
      durationMs: 2500,
      warp: [9.5, 0],
      clear: true,
      input: { moveX: 1, moveY: 0, sprint: true },
    });
    const slopeStartY = slope.length > 0 ? slope[0].y : 0;
    const slopeEndY = slope.length > 0 ? slope[slope.length - 1].y : 0;
    const climbed = slopeEndY - slopeStartY;
    report.measurements.slopeClimb = climbed;
    if (climbed < 2.5) {
      pass('45 deg slope is not climbable', `net climb ${climbed.toFixed(2)} u over 2.5 s of pushing uphill`);
    } else {
      fail('45 deg slope is not climbable', `climbed ${climbed.toFixed(2)} u — the slope limit is not holding`);
    }

    // --- 2. budgets -------------------------------------------------------
    const all = walk.concat(sprint, roam, orbit, dash, slope);
    const peakDraws = peak(all, 'drawCalls');
    const peakTris = peak(all, 'triangles');
    const peakHeap = peak(all, 'heapMb');
    report.measurements.peakDrawCalls = peakDraws;
    report.measurements.peakTriangles = peakTris;
    report.measurements.peakHeapMb = peakHeap;

    if (peakDraws <= BUDGET.drawCalls) pass('draw calls <= 110', `peak ${peakDraws}`);
    else fail('draw calls <= 110', `peak ${peakDraws}`);
    if (peakTris <= BUDGET.triangles) pass('triangles <= 150000', `peak ${peakTris}`);
    else fail('triangles <= 150000', `peak ${peakTris}`);
    if (peakHeap <= BUDGET.heapMb) pass('heap <= 280 MB', `peak ${peakHeap.toFixed(1)} MB`);
    else fail('heap <= 280 MB', `peak ${peakHeap.toFixed(1)} MB`);

    const meanTicks = steadyMean(orbit, 'ticks', 0.8);
    report.measurements.tickRate = meanTicks;
    if (Math.abs(meanTicks - 60) <= 6) pass('fixed tick rate ~60/s', `${meanTicks.toFixed(1)} /s`);
    else fail('fixed tick rate ~60/s', `${meanTicks.toFixed(1)} /s`);

    // --- 10. heap drift ---------------------------------------------------
    const firstHeap = orbit.length > 0 ? orbit[0].heapMb : -1;
    const lastHeap = orbit.length > 0 ? orbit[orbit.length - 1].heapMb : -1;
    const driftMb = lastHeap - firstHeap;
    const bytesPerFrame = orbit.length > 1 ? (driftMb * 1024 * 1024) / orbit.length : 0;
    report.measurements.heapDriftMb = driftMb;
    report.measurements.heapBytesPerFrame = bytesPerFrame;
    if (bytesPerFrame < 2048) {
      pass('no obvious per-frame allocation', `${bytesPerFrame.toFixed(0)} B/frame over ${orbit.length} frames`);
    } else {
      fail(
        'no obvious per-frame allocation',
        `${bytesPerFrame.toFixed(0)} B/frame — something in the loop allocates (§3 wants 0)`,
      );
    }

    // --- 11. multi-touch (§6.4: the touches[0] bug) -----------------------
    const multi = await page.evaluate(async () => {
      const debug = globalThis.__ARCANUM_DEBUG__;
      debug.clearInput();

      const stickZone = document.querySelector('.tc__stick-zone');
      const skillButton = document.querySelector('.tc__btn--skill');
      if (stickZone === null || skillButton === null) {
        return { error: 'touch control DOM not found' };
      }

      const zoneRect = stickZone.getBoundingClientRect();
      const buttonRect = skillButton.getBoundingClientRect();
      const originX = Math.round(zoneRect.left + zoneRect.width * 0.4);
      const originY = Math.round(zoneRect.top + zoneRect.height * 0.6);

      const send = (target, type, id, x, y) => {
        target.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: 'touch',
            isPrimary: id === 1,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      };

      // Finger 1: land in the stick zone and drag up-left.
      send(stickZone, 'pointerdown', 1, originX, originY);
      send(window, 'pointermove', 1, originX - 40, originY - 40);

      // Finger 2, a different pointerId: press a skill button while finger 1 holds.
      send(skillButton, 'pointerdown', 2, Math.round(buttonRect.left + buttonRect.width / 2), Math.round(buttonRect.top + buttonRect.height / 2));

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const stickEl = document.getElementById('tc-stick');
      const result = {
        moveX: debug.player() ? null : null,
        stickActive: stickEl !== null && stickEl.classList.contains('is-active'),
        buttonPressed: skillButton.classList.contains('is-pressed'),
        playerSpeed: debug.player().speed,
      };

      // Release both and let the stick settle.
      send(window, 'pointerup', 2, 0, 0);
      send(window, 'pointerup', 1, originX - 40, originY - 40);
      await new Promise((r) => requestAnimationFrame(r));
      debug.clearInput();
      return result;
    });

    if (multi.error) {
      fail('multi-touch: stick + button together', multi.error);
    } else if (multi.stickActive && multi.buttonPressed) {
      pass(
        'multi-touch: stick + button together',
        `stick active and skill button pressed at the same time (player speed ${multi.playerSpeed.toFixed(2)} u/s)`,
      );
    } else {
      fail(
        'multi-touch: stick + button together',
        `stickActive=${multi.stickActive} buttonPressed=${multi.buttonPressed} — one pointer cancelled the other (the touches[0] bug §6.4 warns about)`,
      );
    }

    // --- 1. errors --------------------------------------------------------
    if (report.pageErrors.length === 0) pass('no uncaught page errors', '0');
    else fail('no uncaught page errors', report.pageErrors.join(' | '));
    if (report.consoleErrors.length === 0) pass('no console errors', '0');
    else fail('no console errors', report.consoleErrors.join(' | '));

    if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
    await page.evaluate(() => {
      globalThis.__ARCANUM_DEBUG__.clearInput();
      globalThis.__ARCANUM_DEBUG__.warp(0, -4);
    });
    await sleep(400);
    await page.screenshot({ path: path.join(ARTIFACTS, 'playtest.png') });
    pass('screenshot written', 'artifacts/playtest.png');
  } catch (error) {
    if (!hardTimedOut && interrupted === null) {
      if (error instanceof Fatal) fail('harness precondition', error.message);
      else fail('harness error', error?.stack ?? String(error));
    }
  }

  if (interrupted !== null) fail('interrupted', `${interrupted} received — no verdict.`);
  if (hardTimedOut) fail('overall timeout', `exceeded ${OVERALL_TIMEOUT_MS} ms`);

  const failed = report.checks.filter((c) => c.status === 'FAIL');
  report.verdict = failed.length === 0 ? 'PASS' : 'FAIL';
  report.durationMs = Date.now() - startedAt;

  printSummary();

  if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(path.join(ARTIFACTS, 'playtest.json'), JSON.stringify(report, null, 2));

  await cleanup();
  process.exit(interrupted !== null ? 130 : report.verdict === 'PASS' ? 0 : 1);
}

function printSummary() {
  const m = report.measurements;
  const row = (label, value, expected) =>
    console.log('  ' + label.padEnd(30) + String(value).padStart(14) + '   ' + expected);

  console.log('\n' + '='.repeat(72));
  console.log('ARCANUM DRIFT — PHASE 1 PLAYTEST');
  console.log('='.repeat(72));
  console.log('\nMEASURED');
  row('walk speed', (m.walkSpeed ?? 0).toFixed(2) + ' u/s', '4 +/-12%');
  row('sprint speed', (m.sprintSpeed ?? 0).toFixed(2) + ' u/s', '7 +/-12%');
  row('dash peak speed', (m.dashPeakSpeed ?? 0).toFixed(2) + ' u/s', '> 12');
  row('dash burst', (m.dashDuration ?? 0).toFixed(3) + ' s', '0.18 +/-0.04');
  row('dash i-frame', (m.iframeDuration ?? 0).toFixed(3) + ' s', '0.15 +/-0.05');
  row('worst ground deviation', (m.worstGroundDeviation ?? 0).toFixed(4) + ' u', '< 0.12');
  row('worst camera margin', (m.worstCameraMargin ?? 0).toFixed(3) + ' u', '> 0.2');
  row('sprint FOV peak', (m.maxFov ?? 0).toFixed(1) + ' deg', '~72');
  row('slope net climb', (m.slopeClimb ?? 0).toFixed(2) + ' u', '< 2.5');
  row('draw calls (peak)', m.peakDrawCalls ?? 0, '<= 110');
  row('triangles (peak)', m.peakTriangles ?? 0, '<= 150000');
  row('heap (peak)', (m.peakHeapMb ?? 0).toFixed(1) + ' MB', '<= 280');
  row('fixed tick rate', (m.tickRate ?? 0).toFixed(1) + ' /s', '~60');
  row('heap drift', (m.heapBytesPerFrame ?? 0).toFixed(0) + ' B/frame', '~0');

  console.log('\nCHECKS');
  for (const check of report.checks) {
    const mark = check.status === 'PASS' ? 'ok  ' : 'FAIL';
    console.log(`  [${mark}] ${check.name}  —  ${check.detail}`);
  }

  console.log('\nHONEST LIMITS OF THIS RUN');
  console.log('  SwiftShader software rendering: frame timings here are not device');
  console.log('  numbers. What this proves is movement maths, collision correctness,');
  console.log('  camera containment, geometry budgets and error-freedom. §12 still');
  console.log('  requires a real handset for the feel and the frame rate.');

  const failedCount = report.checks.filter((c) => c.status === 'FAIL').length;
  console.log(
    `\nVERDICT     ${report.verdict}  (${report.checks.length - failedCount} passed, ${failedCount} failed, ${report.durationMs} ms)`,
  );
  console.log('='.repeat(72) + '\n');
}

process.on('unhandledRejection', (reason) => {
  console.error('[playtest] unhandled rejection:', reason);
  void cleanup().finally(() => process.exit(1));
});

await main();
