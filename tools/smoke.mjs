#!/usr/bin/env node
/**
 * Arcanum Drift — headless smoke gate (Phase 0).
 *
 * Serves the built bundle with `vite preview`, boots it in headless Chromium on
 * SwiftShader, drives it for a few seconds and asserts the CLAUDE.md §3 budgets
 * that a software rasteriser can measure *honestly*: draw calls, triangles, JS
 * heap, a live frame counter and the total absence of errors.
 *
 * It deliberately does NOT assert frame time / FPS thresholds — there is no GPU
 * here, so those numbers describe SwiftShader, not a Snapdragon 680. See the
 * disclaimer printed in the summary. Real FPS must still be measured on a phone.
 *
 * Usage: npm run build && npm run smoke
 * Output: artifacts/smoke.png, artifacts/smoke.json. Exit 0 = pass, 1 = fail.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACTS_DIR = path.join(ROOT, 'artifacts');
const PNG_PATH = path.join(ARTIFACTS_DIR, 'smoke.png');
const JSON_PATH = path.join(ARTIFACTS_DIR, 'smoke.json');

const HOST = '127.0.0.1';
const PORT = 4173;
const PAGE_URL = `http://${HOST}:${PORT}/`;

const OVERALL_TIMEOUT_MS = 90_000; // hard wall: kill everything and fail
const SERVER_READY_TIMEOUT_MS = 30_000;
const GOTO_TIMEOUT_MS = 20_000;
const DEBUG_HOOK_TIMEOUT_MS = 15_000;
const WARMUP_TIMEOUT_MS = 20_000;
const SAMPLE_INTERVAL_MS = 250;
const SAMPLE_WINDOW_MS = 6_000;
const WARMUP_FRAMES = 30;

/** §3 hard budgets. */
const BUDGET = {
  drawCalls: 110,
  triangles: 150_000,
  heapMb: 280,
  pixelRatio: 1.5, // §3 derived rule: setPixelRatio(min(devicePixelRatio, 1.5))
};

/** Heap growth over the sample window above which we print a GC-pressure smell. */
const HEAP_SMELL_MB = 1.5;

/** ProfilerMetrics keys the contract guarantees. */
const METRIC_KEYS = [
  'fps', 'frameMs', 'frameMsMax', 'cpuMs', 'drawCalls', 'triangles', 'programs',
  'geometries', 'textures', 'heapMb', 'pixelRatio', 'drawWidth', 'drawHeight', 'ticks',
];

/** `__ARCANUM_DEBUG__` members the integrator guarantees. */
const DEBUG_FNS = ['metrics', 'frameCount', 'tickCount', 'elapsed', 'toggleDebug', 'setPixelRatio'];

/**
 * No GPU in this container: WebGL2 only exists via ANGLE/SwiftShader, and the
 * `direct://` proxy keeps the localhost request away from the outbound HTTPS
 * proxy. `--enable-precise-memory-info` un-quantises performance.memory, which
 * the heap-growth smell test needs (otherwise it rounds to 10 MB steps).
 */
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
// Process state + teardown. This script must never leave an orphan server.
// ---------------------------------------------------------------------------

/** @type {import('node:child_process').ChildProcess | null} */
let previewChild = null;
/** @type {import('playwright').Browser | null} */
let browser = null;
/** @type {NodeJS.Timeout | null} */
let hardTimer = null;
let hardTimedOut = false;
let cleanedUp = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killPreview(signal) {
  const child = previewChild;
  if (child === null) return;
  // Spawned detached, so the whole group dies with it (npx adds a shell layer).
  // Signal unconditionally: a stale exitCode guard is how servers get orphaned,
  // and signalling a dead group only throws ESRCH, which we swallow.
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

/**
 * A leaked preview server makes the *next* run refuse to start, so verify.
 *
 * The test is "does anything still answer HTTP", not "can we bind": a socket the
 * kernel still holds while nothing serves on it is a teardown artefact that
 * resolves itself, and warning about it would cry wolf on every clean run.
 */
async function waitForPortRelease(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probe(PAGE_URL, 500)) === 0) return true;
    killPreview('SIGKILL');
    await sleep(250);
  }
  return (await probe(PAGE_URL, 500)) === 0;
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
      await Promise.race([b.close(), sleep(5_000)]);
    } catch {
      /* ignore */
    }
  }
  if (previewChild === null) return;
  killPreview('SIGTERM');
  await sleep(250);
  killPreview('SIGKILL');
  if (!(await waitForPortRelease(5_000))) {
    console.error(
      `[smoke] WARNING: port ${PORT} is still held after teardown. Kill the leftover\n` +
        `[smoke] preview server before the next run:  fuser -k ${PORT}/tcp`
    );
  }
}

// Last-resort synchronous reap, covers any exit path we did not anticipate.
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
    console.error(`\n[smoke] ${signal} received — tearing down.`);
    setTimeout(() => process.exit(130), 4_000).unref();
    void cleanup().finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const report = {
  tool: 'tools/smoke.mjs',
  startedAt: new Date().toISOString(),
  durationMs: 0,
  verdict: 'FAIL',
  url: PAGE_URL,
  viewport: { width: 800, height: 360, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  budgets: BUDGET,
  renderingBackend: 'SwiftShader (software) — FPS/frameMs are NOT device measurements',
  environment: {
    node: process.version,
    playwright: null,
    playwrightEntry: null,
    chromium: null,
    webglVersion: null,
    webglRenderer: null,
  },
  debugHook: null,
  samples: [],
  heap: null,
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  consoleWarnings: [],
  checks: [],
};

/** @param {'PASS'|'FAIL'|'SKIP'} status */
function record(name, status, detail) {
  report.checks.push({ name, status, detail });
  return status !== 'FAIL';
}
const pass = (name, detail) => record(name, 'PASS', detail);
const fail = (name, detail) => record(name, 'FAIL', detail);
const skip = (name, detail) => record(name, 'SKIP', detail);

/** Thrown for conditions that make the rest of the run meaningless. */
class Fatal extends Error {}

// ---------------------------------------------------------------------------
// Playwright resolution (global install — NOT a project dependency)
// ---------------------------------------------------------------------------

/**
 * Playwright lives in the global node_modules, so a bare `import 'playwright'`
 * cannot resolve from this file. Try the bare specifier first (in case the
 * project ever adds it locally), then absolute ESM entries in the known global
 * roots. Never run `playwright install` — browsers are pre-seeded in
 * PLAYWRIGHT_BROWSERS_PATH.
 */
async function loadPlaywright() {
  const tried = [];

  try {
    const mod = await import('playwright');
    report.environment.playwrightEntry = 'bare specifier (local dependency)';
    return mod;
  } catch (err) {
    tried.push(`import 'playwright' -> ${err.code ?? err.message}`);
  }

  const globalRoots = [];
  if (process.env.PLAYWRIGHT_MODULE_ROOT) globalRoots.push(process.env.PLAYWRIGHT_MODULE_ROOT);
  // /opt/node22/bin/node -> /opt/node22/lib/node_modules
  globalRoots.push(path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules'));
  globalRoots.push('/opt/node22/lib/node_modules');
  globalRoots.push('/usr/local/lib/node_modules');
  globalRoots.push('/usr/lib/node_modules');

  const seen = new Set();
  for (const root of globalRoots) {
    const pkgDir = path.join(root, 'playwright');
    if (seen.has(pkgDir)) continue;
    seen.add(pkgDir);
    const manifest = path.join(pkgDir, 'package.json');
    if (!existsSync(manifest)) {
      tried.push(`${pkgDir} -> not present`);
      continue;
    }
    const noteVersion = () => {
      try {
        const req = createRequire(path.join(ROOT, 'noop.cjs'));
        report.environment.playwright = req(manifest).version ?? null;
      } catch {
        /* version is cosmetic */
      }
    };

    const esmEntry = path.join(pkgDir, 'index.mjs');
    if (existsSync(esmEntry)) {
      try {
        const mod = await import(pathToFileURL(esmEntry).href);
        report.environment.playwrightEntry = esmEntry;
        noteVersion();
        return mod;
      } catch (err) {
        tried.push(`${esmEntry} -> ${err.message}`);
      }
    }
    // CJS fallback: require() resolves the package "main" for a directory.
    try {
      const req = createRequire(path.join(ROOT, 'noop.cjs'));
      const mod = req(pkgDir);
      report.environment.playwrightEntry = `${pkgDir} (createRequire)`;
      noteVersion();
      return mod;
    } catch (err) {
      tried.push(`createRequire('${pkgDir}') -> ${err.message}`);
    }
  }

  throw new Fatal(
    'Could not load Playwright.\n' +
      '  Playwright is expected as a GLOBAL install (e.g. /opt/node22/lib/node_modules/playwright).\n' +
      '  Do NOT run `playwright install` — browsers are pre-seeded in PLAYWRIGHT_BROWSERS_PATH.\n' +
      '  Set PLAYWRIGHT_MODULE_ROOT to the global node_modules directory to override.\n' +
      `  Attempts:\n    ${tried.join('\n    ')}`
  );
}

// ---------------------------------------------------------------------------
// Preview server
// ---------------------------------------------------------------------------

function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES'));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, HOST);
  });
}

/** Resolves the HTTP status code, or 0 when the server is not answering yet. */
function probe(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    const req = http.get(url, { agent: false, timeout: timeoutMs }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on('error', () => done(0));
    req.on('timeout', () => {
      req.destroy();
      done(0);
    });
  });
}

async function startPreviewServer() {
  const indexHtml = path.join(ROOT, 'dist', 'index.html');
  if (!existsSync(indexHtml)) {
    throw new Fatal(
      `Missing build output: ${indexHtml}\n` +
        '  The smoke gate does not build. Run `npm run build` first, then `npm run smoke`.\n' +
        '  (If vite.config.ts sets a custom build.outDir, this check needs updating.)'
    );
  }
  pass('dist/index.html present', indexHtml);

  if (await portInUse(PORT)) {
    throw new Fatal(
      `Port ${PORT} is already in use on ${HOST}.\n` +
        '  Refusing to continue: the harness would test whatever is already listening\n' +
        '  there instead of this build (a passing run would be a lie).\n' +
        `  Free it and re-run:  fuser -k ${PORT}/tcp   (or: lsof -ti:${PORT} | xargs kill)`
    );
  }

  // Prefer the project's own vite binary: identical to `npx vite preview` but
  // with no registry lookup and no extra wrapper process.
  const localVite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const previewArgs = ['preview', '--port', String(PORT), '--strictPort'];
  const usingLocal = existsSync(localVite);
  const command = usingLocal ? process.execPath : 'npx';
  const args = usingLocal ? [localVite, ...previewArgs] : ['--no-install', 'vite', ...previewArgs];

  previewChild = spawn(command, args, {
    cwd: ROOT,
    detached: true, // own process group, so cleanup can kill the whole tree
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  let output = '';
  const collect = (chunk) => {
    output += String(chunk);
    if (output.length > 8_000) output = output.slice(-8_000);
  };
  previewChild.stdout?.on('data', collect);
  previewChild.stderr?.on('data', collect);

  let spawnError = null;
  previewChild.on('error', (err) => {
    spawnError = err;
  });
  let exited = null;
  previewChild.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError !== null) {
      throw new Fatal(`Could not spawn the preview server (${command}): ${spawnError.message}`);
    }
    if (exited !== null) {
      throw new Fatal(
        `Preview server exited before becoming ready (code=${exited.code} signal=${exited.signal}).\n` +
          `  Command: ${command} ${args.join(' ')}\n` +
          `  Output:\n${indent(output.trim() || '(no output)')}`
      );
    }
    // Any HTTP answer means the server is up — a 404 here is still "listening"
    // (e.g. a non-default `base` in vite.config.ts), which page.goto reports better.
    if ((await probe(PAGE_URL, 2_000)) > 0) {
      pass('vite preview reachable', `${PAGE_URL} (${usingLocal ? 'local vite bin' : 'npx vite'})`);
      return;
    }
    await sleep(200);
  }

  throw new Fatal(
    `Preview server did not answer on ${PAGE_URL} within ${SERVER_READY_TIMEOUT_MS} ms.\n` +
      `  Output:\n${indent(output.trim() || '(no output)')}`
  );
}

const indent = (text) =>
  text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

// ---------------------------------------------------------------------------
// Browser run
// ---------------------------------------------------------------------------

async function runBrowser(playwright) {
  browser = await playwright.chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  report.environment.chromium = browser.version();
  pass('Chromium launched (headless, SwiftShader)', browser.version());

  const context = await browser.newContext({
    viewport: { width: report.viewport.width, height: report.viewport.height },
    deviceScaleFactor: report.viewport.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(GOTO_TIMEOUT_MS);

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') report.consoleErrors.push(text);
    else if (type === 'warning') report.consoleWarnings.push(text);
  });
  page.on('pageerror', (err) => {
    report.pageErrors.push(err.stack ?? String(err.message ?? err));
  });
  page.on('crash', () => {
    report.pageErrors.push('PAGE CRASHED (renderer process died)');
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (url.includes('favicon')) return; // headless never has a favicon; not a defect
    report.failedRequests.push(`${url} — ${request.failure()?.errorText ?? 'unknown'}`);
  });

  // --- load ---------------------------------------------------------------
  const response = await page.goto(PAGE_URL, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS });
  const status = response?.status() ?? 0;
  if (status === 0 || status >= 400) {
    throw new Fatal(
      `Loading ${PAGE_URL} returned HTTP ${status}.\n` +
        '  The preview server is listening but does not serve the app at "/".\n' +
        '  Check `base` / `build.outDir` in vite.config.ts.'
    );
  }
  pass('page loaded', `HTTP ${status}`);

  // --- debug hook ---------------------------------------------------------
  try {
    await page.waitForFunction(
      () => {
        const dbg = globalThis.__ARCANUM_DEBUG__;
        return (
          typeof dbg === 'object' &&
          dbg !== null &&
          typeof dbg.metrics === 'function' &&
          typeof dbg.frameCount === 'function'
        );
      },
      undefined,
      { timeout: DEBUG_HOOK_TIMEOUT_MS, polling: 100 }
    );
  } catch {
    const seen = await page
      .evaluate(() => {
        const dbg = globalThis.__ARCANUM_DEBUG__;
        if (dbg === undefined) return 'undefined';
        if (dbg === null) return 'null';
        return `${typeof dbg} with keys [${Object.keys(dbg).join(', ')}]`;
      })
      .catch(() => 'unreadable');
    throw new Fatal(
      `globalThis.__ARCANUM_DEBUG__ never became usable within ${DEBUG_HOOK_TIMEOUT_MS} ms — found: ${seen}.\n` +
        '  src/main.ts must assign it after Engine.start(), with at least\n' +
        '  metrics(): ProfilerMetrics and frameCount(): number.\n' +
        '  A bootstrap exception is the usual cause — check the page errors above.'
    );
  }

  const hook = await page.evaluate((names) => {
    const dbg = globalThis.__ARCANUM_DEBUG__;
    const types = {};
    for (let i = 0; i < names.length; i++) types[names[i]] = typeof dbg[names[i]];
    return { types, version: typeof dbg.version === 'string' ? dbg.version : null };
  }, DEBUG_FNS);
  report.debugHook = hook;

  const missingFns = DEBUG_FNS.filter((name) => hook.types[name] !== 'function');
  if (missingFns.length > 0) {
    fail('__ARCANUM_DEBUG__ shape', `not a function: ${missingFns.join(', ')}`);
  } else if (hook.version === null) {
    fail('__ARCANUM_DEBUG__ shape', 'version is missing or not a string');
  } else {
    pass('__ARCANUM_DEBUG__ shape', `complete, version ${hook.version}`);
  }

  // --- warm-up ------------------------------------------------------------
  try {
    await page.waitForFunction(
      (min) => globalThis.__ARCANUM_DEBUG__.frameCount() > min,
      WARMUP_FRAMES,
      { timeout: WARMUP_TIMEOUT_MS, polling: 100 }
    );
  } catch {
    const stuck = await page
      .evaluate(() => globalThis.__ARCANUM_DEBUG__.frameCount())
      .catch(() => 'unreadable');
    throw new Fatal(
      `frameCount() never exceeded ${WARMUP_FRAMES} within ${WARMUP_TIMEOUT_MS} ms (stuck at ${stuck}).\n` +
        '  The render loop is not running: Engine.start()/Loop.start() was never called,\n' +
        '  requestAnimationFrame is not being re-armed, or the loop threw on its first frame.'
    );
  }
  pass('render loop running', `frameCount passed ${WARMUP_FRAMES}`);

  // --- sample -------------------------------------------------------------
  const readSample = () =>
    page.evaluate(() => {
      const dbg = globalThis.__ARCANUM_DEBUG__;
      const mem = performance.memory;
      return {
        t: Math.round(performance.now()),
        frameCount: dbg.frameCount(),
        tickCount: dbg.tickCount === undefined ? -1 : dbg.tickCount(),
        elapsed: dbg.elapsed === undefined ? -1 : dbg.elapsed(),
        heapBytes: mem === undefined ? -1 : mem.usedJSHeapSize,
        metrics: dbg.metrics(),
      };
    });

  const sampleStart = Date.now();
  const sampleDeadline = sampleStart + SAMPLE_WINDOW_MS;
  for (;;) {
    report.samples.push(await readSample());
    if (Date.now() >= sampleDeadline) break;
    await sleep(SAMPLE_INTERVAL_MS);
  }
  const samples = report.samples;
  pass('sampled metrics', `${samples.length} samples over ${Date.now() - sampleStart} ms`);

  // Read the live GL strings off the game's own canvas — getContext() on an
  // initialised canvas returns the existing context, so this creates nothing.
  const gl = await page
    .evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (canvas === null) return null;
      const ctx = canvas.getContext('webgl2');
      if (ctx === null) return { version: null, renderer: 'no webgl2 context on canvas' };
      const ext = ctx.getExtension('WEBGL_debug_renderer_info');
      return {
        version: ctx.getParameter(ctx.VERSION),
        renderer: ext === null ? ctx.getParameter(ctx.RENDERER) : ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL),
      };
    })
    .catch(() => null);
  if (gl !== null) {
    report.environment.webglVersion = gl.version;
    report.environment.webglRenderer = gl.renderer;
  }
  if (gl === null || gl.version === null) {
    fail('WebGL2 context', gl === null ? 'no <canvas> in the document' : gl.renderer);
  } else {
    pass('WebGL2 context', `${gl.version} — ${gl.renderer}`);
  }

  // --- artifacts ----------------------------------------------------------
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await page.screenshot({ path: PNG_PATH });
  pass('screenshot written', path.relative(ROOT, PNG_PATH));

  await context.close().catch(() => {});
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function assertSamples() {
  const samples = report.samples;
  if (samples.length < 2) {
    fail('sample count', `${samples.length} sample(s) — need at least 2 to compare`);
    return;
  }

  const missingKeys = METRIC_KEYS.filter((key) => !finite(samples[0].metrics[key]));
  if (missingKeys.length > 0) {
    fail('ProfilerMetrics shape', `missing or non-numeric: ${missingKeys.join(', ')}`);
  } else {
    pass('ProfilerMetrics shape', `all ${METRIC_KEYS.length} keys numeric`);
  }

  // Draw calls (§3 ≤ 110) — and ≥ 1, i.e. WebGL really rendered something.
  const draws = samples.map((s) => s.metrics.drawCalls);
  const maxDraws = Math.max(...draws);
  const minDraws = Math.min(...draws);
  if (!finite(maxDraws)) fail('drawCalls readable', 'drawCalls is not a finite number');
  else if (minDraws < 1) {
    fail(
      `drawCalls >= 1`,
      `saw ${minDraws} draw calls in sample ${draws.indexOf(minDraws)} — nothing was rendered.\n` +
        '      Either renderer.render() is never called, or Profiler.sample() reads\n' +
        '      renderer.info after three reset it (read it immediately after render).'
    );
  } else if (maxDraws > BUDGET.drawCalls) {
    fail(`drawCalls <= ${BUDGET.drawCalls}`, `peak ${maxDraws} — §3 budget exceeded`);
  } else {
    pass(`drawCalls <= ${BUDGET.drawCalls}`, `peak ${maxDraws}`);
  }

  // Triangles (§3 ≤ 150 000).
  const tris = samples.map((s) => s.metrics.triangles);
  const maxTris = Math.max(...tris);
  if (!finite(maxTris)) fail('triangles readable', 'triangles is not a finite number');
  else if (maxTris > BUDGET.triangles) {
    fail(`triangles <= ${BUDGET.triangles}`, `peak ${maxTris} — §3 budget exceeded`);
  } else {
    pass(`triangles <= ${BUDGET.triangles}`, `peak ${maxTris}`);
  }

  // Frame counter strictly increasing.
  let regression = -1;
  for (let i = 1; i < samples.length; i++) {
    if (!(samples[i].frameCount > samples[i - 1].frameCount)) {
      regression = i;
      break;
    }
  }
  if (regression >= 0) {
    fail(
      'frameCount strictly increasing',
      `sample ${regression - 1} = ${samples[regression - 1].frameCount}, ` +
        `sample ${regression} = ${samples[regression].frameCount} after ${SAMPLE_INTERVAL_MS} ms — the loop stalled or stopped`
    );
  } else {
    pass(
      'frameCount strictly increasing',
      `${samples[0].frameCount} -> ${samples[samples.length - 1].frameCount}`
    );
  }

  // Fixed-timestep logic actually ticks (Phase 0 acceptance, §4.2 30 Hz).
  const firstTicks = samples[0].tickCount;
  const lastTicks = samples[samples.length - 1].tickCount;
  if (firstTicks < 0 || lastTicks < 0) {
    skip('tickCount increasing', 'tickCount() not exposed');
  } else if (lastTicks <= firstTicks) {
    fail('tickCount increasing', `${firstTicks} -> ${lastTicks} — the fixed-timestep update never ran`);
  } else {
    pass('tickCount increasing', `${firstTicks} -> ${lastTicks}`);
  }

  // FPS must be a real positive reading (not a timing assertion — see summary).
  const fpsValues = samples.map((s) => s.metrics.fps);
  const badFps = fpsValues.findIndex((v) => !finite(v) || v <= 0);
  if (badFps >= 0) {
    fail('fps > 0', `sample ${badFps} reported fps=${fpsValues[badFps]} — Profiler is not measuring`);
  } else {
    pass('fps > 0', `${Math.min(...fpsValues).toFixed(1)}..${Math.max(...fpsValues).toFixed(1)} (SwiftShader — not a device figure)`);
  }

  // §3 derived rule: pixel ratio must never exceed 1.5.
  const ratios = samples.map((s) => s.metrics.pixelRatio);
  const maxRatio = Math.max(...ratios);
  if (!finite(maxRatio)) fail('pixelRatio readable', 'pixelRatio is not a finite number');
  else if (maxRatio > BUDGET.pixelRatio + 1e-6) {
    fail(`pixelRatio <= ${BUDGET.pixelRatio}`, `peak ${maxRatio} — §3 requires min(devicePixelRatio, 1.5)`);
  } else {
    pass(`pixelRatio <= ${BUDGET.pixelRatio}`, `${Math.min(...ratios)}..${maxRatio} (stepping down under SwiftShader is expected)`);
  }

  // JS heap ceiling (§3 ≤ 280 MB).
  const heapMbValues = samples.map((s) => s.metrics.heapMb).filter((v) => finite(v) && v >= 0);
  if (heapMbValues.length === 0) {
    skip(`heapMb <= ${BUDGET.heapMb}`, 'performance.memory unavailable');
  } else {
    const peak = Math.max(...heapMbValues);
    const detail = `peak ${peak.toFixed(1)} MB`;
    if (peak > BUDGET.heapMb) fail(`heapMb <= ${BUDGET.heapMb}`, detail);
    else pass(`heapMb <= ${BUDGET.heapMb}`, detail);
  }

  // Heap growth: a smell test, never a hard failure (SwiftShader + the
  // Profiler's own 4 Hz string building both add legitimate churn).
  const first = samples[0];
  const last = samples[samples.length - 1];
  const windowSec = Math.max((last.t - first.t) / 1000, 0.001);
  let deltaMb = null;
  let source = 'unavailable';
  if (first.heapBytes > 0 && last.heapBytes > 0) {
    deltaMb = (last.heapBytes - first.heapBytes) / 1048576;
    source = 'performance.memory (precise)';
  } else if (finite(first.metrics.heapMb) && first.metrics.heapMb >= 0 && last.metrics.heapMb >= 0) {
    deltaMb = last.metrics.heapMb - first.metrics.heapMb;
    source = 'Profiler heapMb (1 MB resolution)';
  }
  report.heap = {
    source,
    firstBytes: first.heapBytes,
    lastBytes: last.heapBytes,
    deltaMb,
    windowSec,
    ratePerSecMb: deltaMb === null ? null : deltaMb / windowSec,
    frames: last.frameCount - first.frameCount,
    bytesPerFrame:
      deltaMb === null || last.frameCount === first.frameCount
        ? null
        : (deltaMb * 1048576) / (last.frameCount - first.frameCount),
    smell: deltaMb !== null && deltaMb > HEAP_SMELL_MB,
  };
}

function assertNoErrors() {
  const { consoleErrors, pageErrors, failedRequests } = report;
  if (pageErrors.length > 0) {
    fail('no uncaught page errors', `${pageErrors.length}:\n${indent(pageErrors.join('\n'))}`);
  } else {
    pass('no uncaught page errors', '0');
  }
  if (consoleErrors.length > 0) {
    fail('no console errors', `${consoleErrors.length}:\n${indent(consoleErrors.join('\n'))}`);
  } else {
    pass('no console errors', `0 (${report.consoleWarnings.length} warning(s) ignored)`);
  }
  if (failedRequests.length > 0) {
    fail('no failed requests', `${failedRequests.length}:\n${indent(failedRequests.join('\n'))}`);
  } else {
    pass('no failed requests', '0');
  }
}

// ---------------------------------------------------------------------------
// Summary output
// ---------------------------------------------------------------------------

const num = (value, digits = 1) => (finite(value) ? value.toFixed(digits) : String(value));

function statsOf(pick) {
  const values = report.samples.map(pick).filter(finite);
  if (values.length === 0) return null;
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    last: values[values.length - 1],
  };
}

function printMetricTable() {
  const rows = [
    ['fps', (s) => s.metrics.fps, 1, '(software)'],
    ['frameMs', (s) => s.metrics.frameMs, 1, '(software)'],
    ['frameMs max', (s) => s.metrics.frameMsMax, 1, '(software)'],
    ['cpuMs', (s) => s.metrics.cpuMs, 1, '(software)'],
    ['drawCalls', (s) => s.metrics.drawCalls, 0, `<= ${BUDGET.drawCalls}`],
    ['triangles', (s) => s.metrics.triangles, 0, `<= ${BUDGET.triangles}`],
    ['programs', (s) => s.metrics.programs, 0, ''],
    ['geometries', (s) => s.metrics.geometries, 0, ''],
    ['textures', (s) => s.metrics.textures, 0, ''],
    ['heapMb', (s) => s.metrics.heapMb, 1, `<= ${BUDGET.heapMb}`],
    ['pixelRatio', (s) => s.metrics.pixelRatio, 2, `<= ${BUDGET.pixelRatio}`],
    ['drawWidth', (s) => s.metrics.drawWidth, 0, ''],
    ['drawHeight', (s) => s.metrics.drawHeight, 0, ''],
    ['ticks/s', (s) => s.metrics.ticks, 0, '~30'],
    ['frameCount', (s) => s.frameCount, 0, 'increasing'],
    ['tickCount', (s) => s.tickCount, 0, 'increasing'],
    ['elapsed s', (s) => s.elapsed, 2, ''],
  ];
  const widths = [12, 10, 10, 10, 14];
  const head = ['METRIC', 'MIN', 'MAX', 'LAST', 'BUDGET'];
  const line = (cells) =>
    cells
      .map((cell, i) => (i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i])))
      .join(' ');

  console.log(line(head));
  console.log('-'.repeat(widths.reduce((a, b) => a + b + 1, -1)));
  for (const [label, pick, digits, budget] of rows) {
    const stats = statsOf(pick);
    if (stats === null) {
      console.log(line([label, 'n/a', 'n/a', 'n/a', budget]));
      continue;
    }
    console.log(
      line([label, num(stats.min, digits), num(stats.max, digits), num(stats.last, digits), budget])
    );
  }
}

function printSummary() {
  const failures = report.checks.filter((c) => c.status === 'FAIL');
  const skipped = report.checks.filter((c) => c.status === 'SKIP');

  console.log('');
  console.log('='.repeat(72));
  console.log('ARCANUM DRIFT — PHASE 0 SMOKE');
  console.log('='.repeat(72));
  console.log(`node        ${report.environment.node}`);
  console.log(`playwright  ${report.environment.playwright ?? 'n/a'}  (${report.environment.playwrightEntry ?? 'n/a'})`);
  console.log(`chromium    ${report.environment.chromium ?? 'n/a'}`);
  console.log(`webgl       ${report.environment.webglVersion ?? 'n/a'}`);
  console.log(`renderer    ${report.environment.webglRenderer ?? 'n/a'}`);
  console.log(`viewport    ${report.viewport.width}x${report.viewport.height} @dsf ${report.viewport.deviceScaleFactor}, isMobile, hasTouch`);
  console.log(`build       ${report.debugHook?.version ?? 'unknown'}  (__ARCANUM_DEBUG__.version)`);
  console.log('');

  if (report.samples.length > 0) {
    printMetricTable();
    console.log('');
  }

  console.log('CHECKS');
  for (const check of report.checks) {
    const tag = check.status === 'PASS' ? 'ok  ' : check.status === 'SKIP' ? 'skip' : 'FAIL';
    console.log(`  [${tag}] ${check.name}${check.detail ? `  —  ${check.detail}` : ''}`);
  }
  console.log('');

  if (report.heap !== null && report.heap.deltaMb !== null) {
    const { deltaMb, windowSec, frames, bytesPerFrame, source, smell } = report.heap;
    console.log('JS HEAP (GC-pressure smell test, §3 wants 0 byte/frame in the loop)');
    console.log(`  source     ${source}`);
    console.log(
      `  growth     ${deltaMb >= 0 ? '+' : ''}${deltaMb.toFixed(3)} MB over ${windowSec.toFixed(1)} s / ${frames} frames` +
        (bytesPerFrame === null ? '' : ` (~${Math.round(bytesPerFrame)} B/frame)`)
    );
    if (smell) {
      console.log(`  SMELL      heap grew > ${HEAP_SMELL_MB} MB in a static scene — something in the`);
      console.log('             loop is allocating. Not a hard failure here (the Profiler itself');
      console.log('             builds strings 4x/s), but profile it before shipping Phase 1.');
    } else {
      console.log('  verdict    flat enough — no obvious per-frame allocation.');
    }
    console.log('');
  }

  console.log('HONEST LIMITS OF THIS RUN');
  console.log('  This ran on SwiftShader software rendering (no GPU in this environment).');
  console.log('  The FPS / frameMs / cpuMs figures above are NOT a device measurement and');
  console.log('  must not be quoted as performance. What this gate really proves is:');
  console.log('  correctness of the boot path, draw-call and triangle budgets, pixel-ratio');
  console.log('  policy, a live and strictly increasing frame counter, and zero errors.');
  console.log('  CLAUDE.md §3/§13 acceptance ("60 FPS on a phone") still requires a real');
  console.log('  device: `npm run dev -- --host` and open it on the handset.');
  console.log('');

  console.log(`artifacts   ${path.relative(ROOT, JSON_PATH)}${report.samples.length > 0 ? `, ${path.relative(ROOT, PNG_PATH)}` : ''}`);
  console.log(
    `VERDICT     ${report.verdict}  (${report.checks.length - failures.length - skipped.length} passed, ` +
      `${failures.length} failed, ${skipped.length} skipped, ${report.durationMs} ms)`
  );
  if (failures.length > 0) {
    console.log('');
    console.log('FAILED:');
    for (const check of failures) console.log(`  - ${check.name}: ${check.detail}`);
  }
  console.log('='.repeat(72));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();

  hardTimer = setTimeout(() => {
    hardTimedOut = true;
    console.error('');
    console.error(`[smoke] HARD TIMEOUT after ${OVERALL_TIMEOUT_MS} ms — killing browser and preview server.`);
    console.error('[smoke] Something hung: the app never booted, or the loop never advanced.');
    killPreview('SIGKILL');
    if (browser !== null) void browser.close().catch(() => {});
    // Backstop only: the normal path below still writes artifacts and the summary.
    setTimeout(() => {
      console.error('[smoke] teardown did not finish — exiting hard.');
      process.exit(1);
    }, 5_000);
  }, OVERALL_TIMEOUT_MS);

  try {
    const playwright = await loadPlaywright();
    await startPreviewServer();
    await runBrowser(playwright);
    assertSamples();
    assertNoErrors();
  } catch (err) {
    // After a hard timeout everything downstream throws "target closed" style
    // noise; report the real cause instead of the cascade.
    if (!hardTimedOut) {
      if (err instanceof Fatal) fail('harness precondition', err.message);
      else fail('harness error', err?.stack ?? String(err));
    }
  }

  if (hardTimedOut) {
    fail(
      'overall timeout',
      `the run exceeded the ${OVERALL_TIMEOUT_MS} ms hard wall and was killed.\n` +
        '      The app hung: it never booted, the render loop never advanced, or the\n' +
        `      preview server never became reachable on ${PAGE_URL}.`
    );
  }

  report.durationMs = Date.now() - started;
  const failures = report.checks.filter((c) => c.status === 'FAIL');
  report.verdict = failures.length === 0 && report.samples.length > 0 ? 'PASS' : 'FAIL';

  try {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    console.error(`[smoke] could not write ${JSON_PATH}: ${err.message}`);
  }

  printSummary();
  await cleanup();
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}

process.on('unhandledRejection', (reason) => {
  console.error(`[smoke] unhandled rejection: ${reason?.stack ?? reason}`);
  void cleanup().finally(() => process.exit(1));
});
process.on('uncaughtException', (err) => {
  console.error(`[smoke] uncaught exception: ${err?.stack ?? err}`);
  void cleanup().finally(() => process.exit(1));
});

await main();
