#!/usr/bin/env node
/**
 * Arcanum Drift — Phase 2 world gate.
 *
 * §12's Phase 2 acceptance criterion is one sentence: "walk across two biomes
 * without stutter, without obvious popping, draw calls <= 110". This script is
 * that sentence turned into numbers.
 *
 * It boots the built bundle in headless Chromium, warps the player north of the
 * biome boundary and sprints it south across the blend, sampling EVERY frame:
 * frame time, draw calls, triangles, heap, position, ground height, biome
 * weights and ChunkManager's streaming counters. Then it steps the day-night
 * cycle through its four keyframes and measures the rendered frame.
 *
 * Two things about the traverse are deliberate and load-bearing:
 *
 *  - It heads in **-Z**. The biome boundary runs roughly east-west at z ~ -55,
 *    with the blend spanning z ~ -29 .. -59, and spawn (0,0) is 1.000 Verdant
 *    Hollow. A traverse along X would never cross the boundary and the biome
 *    assertion would pass *vacuously*, which is worse than failing — so the
 *    forward axis is calibrated by measurement (see CALIBRATE) and the achieved
 *    dz is asserted, not assumed.
 *  - Sampling happens INSIDE the page on requestAnimationFrame, into
 *    pre-allocated Float64Arrays. A CDP round trip per frame would cost more
 *    than the thing being measured, and a sampler that pushed objects would
 *    GC mid-run and manufacture exactly the hitch it is looking for.
 *
 * Like smoke.mjs and playtest.mjs this runs on SwiftShader. Absolute frame time
 * here describes a software rasteriser, not a Snapdragon 680. The stutter check
 * is therefore *relative*: a chunk build spike is an outlier against the local
 * median and shows up clearly whatever the baseline. It detects HITCHES, not
 * frame rate. Geometry budgets, draw-call accounting, streaming correctness,
 * biome blending and error-freedom are all real numbers.
 *
 * Port 4175, so smoke (4173) and playtest (4174) can run alongside it.
 *
 * Usage: npm run build && node tools/worldtest.mjs
 * Output: artifacts/worldtest.png, artifacts/worldtest.json. Exit 0 pass, 1 fail.
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
/** Deliberately not smoke.mjs's 4173 nor playtest.mjs's 4174. */
const PORT = 4175;
const URL_ = `http://${HOST}:${PORT}/`;

const OVERALL_TIMEOUT_MS = 300_000;
const SERVER_TIMEOUT_MS = 30_000;

/** §3 hard budgets. */
const BUDGET = { drawCalls: 110, triangles: 150_000, heapMb: 280 };

/** §7 / Phase 1: the player must sit on the collision field, not float over it. */
const GROUND_TOLERANCE = 0.12;

/**
 * Streaming legitimately allocates on its first pass through fresh chunks, so
 * this is looser than Phase 1's 2 KB. What it still catches is a geometry pool
 * that quietly reallocates instead of reusing — that shows as steady growth.
 */
const HEAP_BYTES_PER_FRAME = 8192;

/** A frame this many times the median is a hitch, not jitter. */
const STUTTER_RATIO = 4;
/** Frames skipped before the stutter statistics start (post-warp settling). */
const STUTTER_WARMUP_FRAMES = 12;

/**
 * Draw calls that are NOT terrain chunks. The contract's central deviation from
 * §3 is "one InstancedMesh per prop type for the whole active set, not per
 * chunk"; per-chunk prop meshes would put this at ~100 instead of ~13
 * (4 props + 1 water + 1 sky + 7 blocky avatar parts). This is the assertion
 * that actually polices that decision, independently of the 110 total.
 */
/*
 * 45, up from Phase 2's 20: the Phase 5 world legitimately carries
 * position-varying non-terrain content — six distance-culled shrines (3 draws
 * each), nine fragment sites, torches, the dormant boss and its pillar ring.
 * The check still catches the failure it exists for (per-chunk prop meshes
 * would blow far past this), and total draws stay gated at 110 elsewhere.
 */
const DRAW_OVERHEAD_MAX = 45;

/**
 * Steepest biome-weight change per world unit. §5 asks for a ~30 u transition
 * band; smoothstep over 30 u peaks at 1.5/30 = 0.05 per unit, so this leaves
 * better than 2x headroom while a hard seam (>= 1.0 per unit) fails loudly.
 */
const BIOME_MAX_GRADIENT = 0.12;

/** §5: 600x600 units. */
const WORLD_SIZE = 600;

/** The traverse. North of the blend, south past the far side of it. */
const TRAVERSE_START_Z = 45;
const TRAVERSE_TARGET_Z = -80;
const TRAVERSE_MAX_MS = 45_000;
const TRAVERSE_MIN_DZ = 90;

/** The heap/streaming traverse. Contract asks for 12 s of continuous streaming. */
const HEAP_START_Z = 30;
const HEAP_DURATION_MS = 12_000;

/** §5's four keyframes: 0 night, 0.25 dawn, 0.5 day, 0.75 dusk. */
const DAY_PHASES = [0, 0.25, 0.5, 0.75];
/** Mean full-frame RGB distance (0..255 units) required between any two phases. */
const DAY_COLOR_SEPARATION = 4;
/** Full-frame luma the day keyframe must exceed the night keyframe by. */
const DAY_NIGHT_LUMA_GAP = 15;

const CHROMIUM_ARGS = [
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--proxy-server=direct://',
  '--proxy-bypass-list=*',
  // Without this performance.memory quantises to 10 MB steps and the heap
  // drift measurement becomes meaningless.
  '--enable-precise-memory-info',
  '--hide-scrollbars',
  '--mute-audio',
];

// ---------------------------------------------------------------------------
// process plumbing (same shape as playtest.mjs — never leave an orphan server)
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

// Last-resort synchronous reap for any exit path not anticipated above.
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
    console.error(`\n[worldtest] ${signal} received — tearing down.`);
    setTimeout(() => process.exit(130), 4000).unref();
    void cleanup().finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const report = {
  tool: 'tools/worldtest.mjs',
  phase: 2,
  startedAt: new Date().toISOString(),
  durationMs: 0,
  verdict: 'FAIL',
  renderingBackend: 'SwiftShader (software) — absolute frame time is NOT a device number',
  budgets: BUDGET,
  measurements: {},
  dayNight: [],
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
/** Something the harness could not measure at all — reported, and it fails the gate. */
const unknown = (name, detail) => record(name, 'FAIL', `UNVERIFIABLE: ${detail}`);

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

function quantile(sortedValues, q) {
  const n = sortedValues.length;
  if (n === 0) return 0;
  if (n === 1) return sortedValues[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

/** Peak of `key` plus the index it happened at, so the report can say *where*. */
function peakAt(series, key) {
  const arr = series[key];
  let best = -Infinity;
  let index = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > best) {
      best = arr[i];
      index = i;
    }
  }
  return { value: best === -Infinity ? 0 : best, index };
}

function minOf(arr) {
  let best = Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] < best) best = arr[i];
  return best === Infinity ? 0 : best;
}

function maxOf(arr) {
  let best = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > best) best = arr[i];
  return best === -Infinity ? 0 : best;
}

/** Mean over the last `fraction` of a series — skips any acceleration ramp. */
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

function where(series, index) {
  if (index < 0 || index >= series.x.length) return 'unknown position';
  return `x=${series.x[index].toFixed(1)} z=${series.z[index].toFixed(1)} t=${series.t[index].toFixed(2)}s`;
}

/** Frame-time stats, skipping the warmup frames and the synthetic first delta. */
function frameStats(frameMs) {
  const values = [];
  for (let i = STUTTER_WARMUP_FRAMES; i < frameMs.length; i++) {
    if (frameMs[i] > 0) values.push(frameMs[i]);
  }
  values.sort((a, b) => a - b);
  const median = quantile(values, 0.5);
  const limit = median * STUTTER_RATIO;
  let over = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > limit) over++;
  return {
    frames: values.length,
    median,
    p90: quantile(values, 0.9),
    p99: quantile(values, 0.99),
    worst: values.length > 0 ? values[values.length - 1] : 0,
    limit,
    over,
  };
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function roundSeries(arr, digits) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = round(arr[i], digits);
  return out;
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
      throw new Fatal(
        `vite preview exited early with code ${previewChild.exitCode}. Is port ${PORT} in use?`,
      );
    }
    await sleep(250);
  }
  throw new Fatal(`vite preview did not answer on ${URL_} within ${SERVER_TIMEOUT_MS} ms.`);
}

/** The bare specifier fails here — playwright is a global install, not a dependency. */
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
  throw new Fatal(
    'Could not import playwright (tried the bare specifier and the global install at /opt/node22).',
  );
}

// ---------------------------------------------------------------------------
// in-page drivers — serialised across the CDP boundary, so self-contained
// ---------------------------------------------------------------------------

/**
 * Warps, then waits for ChunkManager's build queue to drain before sampling
 * starts. A teleport legitimately bursts chunk builds; counting that burst as
 * "stutter" would fail the phase for something no player can do. §12's stutter
 * is about a continuous walk, so the walk starts from a settled world.
 */
const SETTLE = async (o) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
  debug.clearInput();
  debug.warp(o.x, o.z);

  // Unconditional frames first: on the very frame after a warp the manager has
  // not noticed yet, so queuedChunks === 0 would be a false "settled".
  for (let i = 0; i < 10; i++) await nextFrame();

  const deadline = performance.now() + o.timeoutMs;
  let drained = false;
  while (performance.now() < deadline) {
    const w = debug.world();
    if (w.queuedChunks === 0) {
      drained = true;
      break;
    }
    await nextFrame();
  }
  for (let i = 0; i < 8; i++) await nextFrame();

  const w = debug.world();
  const p = debug.player();
  return {
    drained,
    activeChunks: w.activeChunks,
    visibleChunks: w.visibleChunks,
    queuedChunks: w.queuedChunks,
    pooledGeometries: w.pooledGeometries,
    propInstances: w.propInstances,
    colliders: w.colliders,
    seaLevel: w.seaLevel,
    worldSize: w.worldSize,
    playerY: p.y,
    playerX: p.x,
    playerZ: p.z,
  };
};

/**
 * Measures which way world-space "forward" points for input (0, -1), so the
 * traverse can be aimed at -Z regardless of the boot camera yaw. Aiming by
 * assumption is how a biome assertion passes vacuously.
 */
const CALIBRATE = (o) => {
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

/**
 * The rich traverse sampler: everything the gate needs, once per rAF, into
 * pre-allocated Float64Arrays. Stops at `untilZ` or `durationMs`, whichever
 * comes first — distance-terminated so a slow rasteriser cannot shorten the
 * traverse and quietly skip the biome boundary.
 *
 * `debug.biomeAt()` and `debug.world()` return fresh objects (the integrator's
 * allocation, not ours), so this series is NOT the one used for heap drift.
 */
const TRAVERSE = (o) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    const cap = Math.ceil((o.durationMs / 1000) * 140) + 256;
    const t = new Float64Array(cap);
    const frameMs = new Float64Array(cap);
    const draws = new Float64Array(cap);
    const tris = new Float64Array(cap);
    const heap = new Float64Array(cap);
    const ticks = new Float64Array(cap);
    const x = new Float64Array(cap);
    const y = new Float64Array(cap);
    const z = new Float64Array(cap);
    const groundY = new Float64Array(cap);
    const speed = new Float64Array(cap);
    const w0 = new Float64Array(cap);
    const dominant = new Float64Array(cap);
    const active = new Float64Array(cap);
    const visible = new Float64Array(cap);
    const queued = new Float64Array(cap);
    const pooled = new Float64Array(cap);
    const propInstances = new Float64Array(cap);
    let n = 0;

    debug.clearInput();
    debug.setInput({ moveX: o.moveX, moveY: o.moveY, sprint: o.sprint === true });

    const started = performance.now();
    let last = started;

    const finish = (reason) => {
      debug.clearInput();
      resolve({
        reason,
        count: n,
        t: Array.from(t.subarray(0, n)),
        frameMs: Array.from(frameMs.subarray(0, n)),
        drawCalls: Array.from(draws.subarray(0, n)),
        triangles: Array.from(tris.subarray(0, n)),
        heapMb: Array.from(heap.subarray(0, n)),
        ticks: Array.from(ticks.subarray(0, n)),
        x: Array.from(x.subarray(0, n)),
        y: Array.from(y.subarray(0, n)),
        z: Array.from(z.subarray(0, n)),
        groundY: Array.from(groundY.subarray(0, n)),
        speed: Array.from(speed.subarray(0, n)),
        w0: Array.from(w0.subarray(0, n)),
        dominant: Array.from(dominant.subarray(0, n)),
        activeChunks: Array.from(active.subarray(0, n)),
        visibleChunks: Array.from(visible.subarray(0, n)),
        queuedChunks: Array.from(queued.subarray(0, n)),
        pooledGeometries: Array.from(pooled.subarray(0, n)),
        propInstances: Array.from(propInstances.subarray(0, n)),
      });
    };

    const tick = () => {
      const now = performance.now();
      const p = debug.player();
      const m = debug.metrics();
      const b = debug.biomeAt(p.x, p.z);
      const w = debug.world();

      if (n < cap) {
        t[n] = (now - started) / 1000;
        frameMs[n] = now - last;
        draws[n] = m.drawCalls;
        tris[n] = m.triangles;
        heap[n] = m.heapMb;
        ticks[n] = m.ticks;
        x[n] = p.x;
        y[n] = p.y;
        z[n] = p.z;
        groundY[n] = debug.terrainHeightAt(p.x, p.z);
        speed[n] = p.speed;
        w0[n] = b.weights[0];
        dominant[n] = b.dominant;
        active[n] = w.activeChunks;
        visible[n] = w.visibleChunks;
        queued[n] = w.queuedChunks;
        pooled[n] = w.pooledGeometries;
        propInstances[n] = w.propInstances;
        n++;
      }
      last = now;

      if (typeof o.untilZ === 'number' && p.z <= o.untilZ) {
        finish('reached-target-z');
        return;
      }
      if (now - started >= o.durationMs) {
        finish('duration');
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/**
 * The clean sampler. Same walk, but it touches only `metrics()`, `player()` and
 * `terrainHeightAt()` — all of which return numbers or a small fixed object —
 * and writes into pre-allocated arrays. This is the series the heap-drift and
 * stutter assertions use, because the harness must not be the thing allocating.
 */
const CLEAN_TRAVERSE = (o) => {
  const debug = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    const cap = Math.ceil((o.durationMs / 1000) * 140) + 256;
    const t = new Float64Array(cap);
    const frameMs = new Float64Array(cap);
    const draws = new Float64Array(cap);
    const tris = new Float64Array(cap);
    const heap = new Float64Array(cap);
    const x = new Float64Array(cap);
    const y = new Float64Array(cap);
    const z = new Float64Array(cap);
    const groundY = new Float64Array(cap);
    let n = 0;

    debug.clearInput();
    debug.setInput({ moveX: o.moveX, moveY: o.moveY, sprint: o.sprint === true });

    const started = performance.now();
    let last = started;

    const tick = () => {
      const now = performance.now();
      const p = debug.player();
      const m = debug.metrics();
      if (n < cap) {
        t[n] = (now - started) / 1000;
        frameMs[n] = now - last;
        draws[n] = m.drawCalls;
        tris[n] = m.triangles;
        heap[n] = m.heapMb;
        x[n] = p.x;
        y[n] = p.y;
        z[n] = p.z;
        groundY[n] = debug.terrainHeightAt(p.x, p.z);
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
          x: Array.from(x.subarray(0, n)),
          y: Array.from(y.subarray(0, n)),
          z: Array.from(z.subarray(0, n)),
          groundY: Array.from(groundY.subarray(0, n)),
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/**
 * Opportunistically reads fog colour / sun intensity if the debug surface
 * happens to expose them. The Phase 2 contract does NOT guarantee it, so the
 * day-night assertion cannot depend on this — it is corroboration for the
 * pixel measurement, which is the primary evidence.
 */
const SKY_STATE = () => {
  const d = globalThis.__ARCANUM_DEBUG__;
  const out = {
    phase: typeof d.dayPhase === 'function' ? d.dayPhase() : null,
    fogHex: null,
    fogDensity: null,
    sunIntensity: null,
    hemiIntensity: null,
    source: 'none',
  };
  const candidates = [];
  const collect = (name) => {
    if (typeof d[name] === 'function') {
      try {
        candidates.push(d[name]());
      } catch {
        /* ignore a hook that throws */
      }
    }
  };
  collect('sky');
  collect('dayNight');
  collect('lighting');
  collect('world');

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c === null || typeof c !== 'object') continue;
    const fog = typeof c.fogColor === 'number' ? c.fogColor : typeof c.fogHex === 'number' ? c.fogHex : null;
    if (out.fogHex === null && fog !== null) {
      out.fogHex = fog;
      out.source = 'debug';
    }
    if (out.fogDensity === null && typeof c.fogDensity === 'number') out.fogDensity = c.fogDensity;
    if (out.sunIntensity === null && typeof c.sunIntensity === 'number') {
      out.sunIntensity = c.sunIntensity;
      out.source = 'debug';
    }
    if (out.hemiIntensity === null && typeof c.hemiIntensity === 'number') {
      out.hemiIntensity = c.hemiIntensity;
    }
  }
  return out;
};

/**
 * Decodes a PNG screenshot back inside the page and averages three horizontal
 * bands. Node has no image decoder without a dependency, and the browser
 * already has one — so the bytes make one round trip and `getImageData` does
 * the work.
 *
 * This is how the gate proves the day-night cycle changes what is on screen
 * without needing the integrator to expose the FogExp2 instance.
 */
const BANDS = async (b64) => {
  try {
    const response = await fetch('data:image/png;base64,' + b64);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const w = bitmap.width;
    const h = bitmap.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const band = (y0f, y1f) => {
      const y0 = Math.max(0, Math.floor(h * y0f));
      const y1 = Math.min(h, Math.max(y0 + 1, Math.floor(h * y1f)));
      const data = ctx.getImageData(0, y0, w, y1 - y0).data;
      let r = 0;
      let g = 0;
      let b = 0;
      const pixels = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
      }
      r /= pixels;
      g /= pixels;
      b /= pixels;
      return { r, g, b, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
    };

    return { ok: true, w, h, sky: band(0.02, 0.18), ground: band(0.8, 0.98), all: band(0, 1) };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
};

function colorDistance(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  hardTimer = setTimeout(() => {
    hardTimedOut = true;
    console.error(`[worldtest] HARD TIMEOUT after ${OVERALL_TIMEOUT_MS} ms — killing everything.`);
    void cleanup();
    setTimeout(() => process.exit(1), 1500);
  }, OVERALL_TIMEOUT_MS);
  hardTimer.unref?.();

  const m = report.measurements;

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

    // --- debug surface ----------------------------------------------------
    // NOTE the `null`: the signature is waitForFunction(fn, arg, options). Passing
    // the options object in the arg slot silently serialises it as the function's
    // argument and leaves the timeout at Playwright's 30 s default.
    await page.waitForFunction(() => globalThis.__ARCANUM_DEBUG__ !== undefined, null, { timeout: 15_000 });
    const shape = await page.evaluate(() => {
      const d = globalThis.__ARCANUM_DEBUG__;
      const phase1 = [
        'metrics', 'frameCount', 'tickCount', 'elapsed',
        'setInput', 'clearInput', 'press', 'player', 'camera', 'terrainHeightAt', 'warp',
      ];
      const phase2 = ['biomeAt', 'setDayPhase', 'dayPhase', 'world'];
      const missing = [];
      for (const k of phase1) if (typeof d[k] !== 'function') missing.push(k + ' (phase 1)');
      for (const k of phase2) if (typeof d[k] !== 'function') missing.push(k + ' (phase 2)');
      let worldKeys = [];
      try {
        worldKeys = typeof d.world === 'function' ? Object.keys(d.world()) : [];
      } catch (error) {
        worldKeys = ['<world() threw: ' + String((error && error.message) || error) + '>'];
      }
      return { missing, version: d.version, worldKeys };
    });
    if (shape.missing.length > 0) {
      throw new Fatal(
        `__ARCANUM_DEBUG__ is missing: ${shape.missing.join(', ')}. ` +
          'The Phase 2 gate cannot run until the integrator exposes biomeAt/setDayPhase/dayPhase/world.',
      );
    }
    pass('__ARCANUM_DEBUG__ phase 2 shape', `complete, version ${shape.version}`);

    const worldNeeded = [
      'activeChunks', 'visibleChunks', 'queuedChunks', 'pooledGeometries',
      'propInstances', 'colliders', 'seaLevel', 'worldSize',
    ];
    const worldMissing = worldNeeded.filter((k) => !shape.worldKeys.includes(k));
    if (worldMissing.length > 0) {
      throw new Fatal(`world() is missing keys: ${worldMissing.join(', ')} (got ${shape.worldKeys.join(', ')})`);
    }
    pass('world() shape', shape.worldKeys.join(', '));

    await page.waitForFunction(() => globalThis.__ARCANUM_DEBUG__.frameCount() > 40, null, { timeout: 20_000 });
    pass('render loop running', 'frameCount passed 40');

    // --- spawn state: water, sea level, world size ------------------------
    const spawn = await page.evaluate(SETTLE, { x: 0, z: 0, timeoutMs: 8000 });
    m.spawn = spawn;

    if (spawn.worldSize === WORLD_SIZE) {
      pass('world is 600x600 units (§5)', `worldSize ${spawn.worldSize}`);
    } else {
      fail('world is 600x600 units (§5)', `worldSize ${spawn.worldSize}, expected ${WORLD_SIZE}`);
    }

    if (typeof spawn.seaLevel === 'number' && Number.isFinite(spawn.seaLevel)) {
      if (spawn.playerY > spawn.seaLevel) {
        pass(
          'water exists and spawn is above sea level',
          `seaLevel ${spawn.seaLevel.toFixed(2)}, spawn y ${spawn.playerY.toFixed(2)} (${(spawn.playerY - spawn.seaLevel).toFixed(2)} u clear)`,
        );
      } else {
        fail(
          'water exists and spawn is above sea level',
          `spawn y ${spawn.playerY.toFixed(2)} is at or below seaLevel ${spawn.seaLevel.toFixed(2)} — the player boots underwater`,
        );
      }
    } else {
      fail('water exists and spawn is above sea level', `world().seaLevel is not a number: ${String(spawn.seaLevel)}`);
    }

    if (spawn.propInstances > 0) {
      pass('props are instanced into the world', `${spawn.propInstances} instances at spawn`);
    } else {
      fail('props are instanced into the world', '0 prop instances — PropScatter is not filling chunks');
    }
    if (spawn.colliders > 0) {
      pass('prop colliders registered', `${spawn.colliders} AABBs in the spatial hash`);
    } else {
      fail('prop colliders registered', '0 colliders — trees and rocks are walk-through');
    }

    // --- aim the traverse at -Z -------------------------------------------
    /*
     * Movement is camera-relative, so input (0,-1) is only -Z if the boot yaw
     * happens to be 0. Measure the forward axis, solve for the input vector
     * that gives world (0,-1), then VERIFY it — a traverse along X would cross
     * no biome boundary and the biome check would pass for the wrong reason.
     */
    const cal = await page.evaluate(CALIBRATE, { x: 0, z: 0, moveX: 0, moveY: -1, durationMs: 900 });
    const calLength = Math.hypot(cal.dx, cal.dz);
    if (!(calLength > 0.5)) {
      throw new Fatal(
        `calibration walk moved only ${calLength.toFixed(3)} u in 0.9 s — the player is not moving, so the traverse cannot be aimed.`,
      );
    }
    /*
     * F = (fx, fz) is the world direction produced by input (0, -1).
     * For a yaw-rotated basis the world direction of input (1, 0) is R = (-fz, fx).
     * Decompose the wanted direction D = (0, -1) onto that basis:
     *   a = D . F = -fz      (coefficient on forward; input moveY = -a)
     *   b = D . R = -fx      (coefficient on right;   input moveX =  b)
     * At yaw 0 (F = (0,-1)) this collapses to (moveX, moveY) = (0, -1), as it must.
     */
    const fx = cal.dx / calLength;
    const fz = cal.dz / calLength;
    let moveX = -fx;
    let moveY = fz;
    const aimLength = Math.hypot(moveX, moveY);
    if (aimLength > 1e-6) {
      moveX /= aimLength;
      moveY /= aimLength;
    } else {
      moveX = 0;
      moveY = -1;
    }

    let verify = await page.evaluate(CALIBRATE, { x: 0, z: 0, moveX, moveY, durationMs: 900 });
    if (verify.dz > -1.5) {
      // The engine's right-hand basis may be mirrored relative to the guess.
      moveX = -moveX;
      verify = await page.evaluate(CALIBRATE, { x: 0, z: 0, moveX, moveY, durationMs: 900 });
    }
    m.aim = { forward: { x: round(fx, 4), z: round(fz, 4) }, input: { moveX: round(moveX, 4), moveY: round(moveY, 4) }, verifyDz: round(verify.dz, 3), verifyDx: round(verify.dx, 3) };
    if (verify.dz < -1.5) {
      pass(
        'traverse aimed at -Z (crosses the biome boundary)',
        `input (${moveX.toFixed(2)}, ${moveY.toFixed(2)}) moved dz=${verify.dz.toFixed(2)} dx=${verify.dx.toFixed(2)} in 0.9 s`,
      );
    } else {
      fail(
        'traverse aimed at -Z (crosses the biome boundary)',
        `best input (${moveX.toFixed(2)}, ${moveY.toFixed(2)}) gave dz=${verify.dz.toFixed(2)} dx=${verify.dx.toFixed(2)} — cannot aim south, so the biome crossing below is NOT trustworthy`,
      );
    }

    // --- the main traverse: z = +45 -> -80, sprinting --------------------
    const settleA = await page.evaluate(SETTLE, { x: 0, z: TRAVERSE_START_Z, timeoutMs: 10_000 });
    m.settleBeforeTraverse = settleA;
    const framesBefore = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.frameCount());

    const traverse = await page.evaluate(TRAVERSE, {
      durationMs: TRAVERSE_MAX_MS,
      untilZ: TRAVERSE_TARGET_Z,
      moveX,
      moveY,
      sprint: true,
    });
    if (traverse.count < 60) {
      throw new Fatal(`the traverse produced only ${traverse.count} frames — nothing to assert on.`);
    }
    const framesAfter = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.frameCount());

    const startZ = traverse.z[0];
    const endZ = traverse.z[traverse.count - 1];
    const dz = endZ - startZ;
    const traversedDistance = Math.hypot(
      traverse.x[traverse.count - 1] - traverse.x[0],
      endZ - startZ,
    );
    m.traverse = {
      reason: traverse.reason,
      frames: traverse.count,
      seconds: round(traverse.t[traverse.count - 1], 2),
      startZ: round(startZ, 2),
      endZ: round(endZ, 2),
      dz: round(dz, 2),
      distance: round(traversedDistance, 2),
      meanSpeed: round(tailMean(traverse.speed, 0.7), 2),
    };

    if (-dz >= TRAVERSE_MIN_DZ) {
      pass(
        'traverse covered the biome boundary in -Z',
        `z ${startZ.toFixed(1)} -> ${endZ.toFixed(1)} (${(-dz).toFixed(1)} u south) over ${traverse.count} frames, ${traverse.t[traverse.count - 1].toFixed(1)} s, reason "${traverse.reason}"`,
      );
    } else {
      fail(
        'traverse covered the biome boundary in -Z',
        `only ${(-dz).toFixed(1)} u of southward travel (needed ${TRAVERSE_MIN_DZ}) — the boundary at z ~ -55 was probably never reached, so the biome check below is vacuous`,
      );
    }

    // --- 1 + 2. draw calls and triangles while walking --------------------
    const drawPeak = peakAt(traverse, 'drawCalls');
    const triPeak = peakAt(traverse, 'triangles');
    m.peakDrawCalls = drawPeak.value;
    m.peakDrawCallsAt = where(traverse, drawPeak.index);
    m.peakTriangles = triPeak.value;
    m.peakTrianglesAt = where(traverse, triPeak.index);

    if (drawPeak.value <= BUDGET.drawCalls) {
      pass('draw calls <= 110 while walking (§12)', `peak ${drawPeak.value} at ${m.peakDrawCallsAt}`);
    } else {
      fail('draw calls <= 110 while walking (§12)', `peak ${drawPeak.value} at ${m.peakDrawCallsAt}`);
    }
    if (triPeak.value <= BUDGET.triangles) {
      pass('triangles <= 150000 while walking (§3)', `peak ${triPeak.value} at ${m.peakTrianglesAt}`);
    } else {
      fail('triangles <= 150000 while walking (§3)', `peak ${triPeak.value} at ${m.peakTrianglesAt}`);
    }

    /*
     * Draw-call accounting. The contract deviates from §3's "one instanced mesh
     * per prop type per chunk" precisely because 25 chunks x 4 types + 25
     * terrain = 125 > 110. This checks the deviation was actually implemented:
     * everything that is not a terrain chunk must stay a small constant.
     */
    let worstOverhead = -Infinity;
    let worstOverheadIndex = -1;
    for (let i = 0; i < traverse.count; i++) {
      const overhead = traverse.drawCalls[i] - traverse.visibleChunks[i];
      if (overhead > worstOverhead) {
        worstOverhead = overhead;
        worstOverheadIndex = i;
      }
    }
    m.worstDrawOverhead = worstOverhead;
    if (worstOverhead <= DRAW_OVERHEAD_MAX) {
      pass(
        'non-terrain draw calls stay constant (props/water/sky are not per-chunk)',
        `peak ${worstOverhead} draw calls beyond the visible chunks (<= ${DRAW_OVERHEAD_MAX}); expected ~13-40: props+water+sky+avatar plus distance-culled shrines/fragment sites (Phase 5) parts`,
      );
    } else {
      fail(
        'non-terrain draw calls stay constant (props/water/sky are not per-chunk)',
        `peak ${worstOverhead} draw calls beyond visible chunks at ${where(traverse, worstOverheadIndex)} — that looks like per-chunk prop meshes, which the budget arithmetic rules out`,
      );
    }

    // --- streaming health -------------------------------------------------
    const maxQueued = maxOf(traverse.queuedChunks);
    const finalQueued = traverse.queuedChunks[traverse.count - 1];
    const maxPooled = maxOf(traverse.pooledGeometries);
    const maxActive = maxOf(traverse.activeChunks);
    const minVisible = minOf(traverse.visibleChunks);
    const maxVisible = maxOf(traverse.visibleChunks);
    m.streaming = {
      maxQueued,
      finalQueued,
      maxPooled,
      maxActive,
      minVisible,
      maxVisible,
      maxPropInstances: maxOf(traverse.propInstances),
    };

    if (finalQueued <= 4) {
      pass('streaming keeps up (build queue drains)', `peak queue ${maxQueued}, ${finalQueued} left at the end of the sprint`);
    } else {
      fail(
        'streaming keeps up (build queue drains)',
        `${finalQueued} chunks still queued after ${(-dz).toFixed(0)} u of sprinting (peak ${maxQueued}) — the builder is falling behind the player`,
      );
    }
    if (maxPooled <= 64) {
      pass('geometry pool is bounded', `peak ${maxPooled} pooled geometries`);
    } else {
      fail('geometry pool is bounded', `peak ${maxPooled} pooled geometries — the pool is growing, not recycling`);
    }
    if (maxVisible > 0 && minVisible < maxActive) {
      pass(
        'manual frustum culling does something',
        `visible chunks ranged ${minVisible}..${maxVisible} against ${maxActive} active`,
      );
    } else {
      fail(
        'manual frustum culling does something',
        `visible ${minVisible}..${maxVisible} vs active ${maxActive} — nothing was ever culled, so §3's per-chunk culling is not running`,
      );
    }

    // --- 4. the player stays on the collision field -----------------------
    let worstGround = 0;
    let worstGroundIndex = -1;
    for (let i = 0; i < traverse.count; i++) {
      const deviation = Math.abs(traverse.y[i] - traverse.groundY[i]);
      if (deviation > worstGround) {
        worstGround = deviation;
        worstGroundIndex = i;
      }
    }
    m.worstGroundDeviation = worstGround;
    if (worstGround < GROUND_TOLERANCE) {
      pass(
        'player stays on built terrain across the traverse',
        `worst deviation ${worstGround.toFixed(4)} u (< ${GROUND_TOLERANCE})`,
      );
    } else {
      fail(
        'player stays on built terrain across the traverse',
        `worst deviation ${worstGround.toFixed(4)} u at ${where(traverse, worstGroundIndex)} — the mesher and the collision field disagree, or streaming left a hole`,
      );
    }

    // --- 5. the biome crossing actually happens, and it blends ------------
    const domStart = traverse.dominant[0];
    const domEnd = traverse.dominant[traverse.count - 1];
    const w0Start = traverse.w0[0];
    const w0End = traverse.w0[traverse.count - 1];

    let blendFrames = 0;
    let blendFirstZ = null;
    let blendLastZ = null;
    let worstStep = 0;
    let worstStepIndex = -1;
    for (let i = 0; i < traverse.count; i++) {
      const w = traverse.w0[i];
      if (w > 0.05 && w < 0.95) {
        blendFrames++;
        if (blendFirstZ === null) blendFirstZ = traverse.z[i];
        blendLastZ = traverse.z[i];
      }
      if (i > 0) {
        /*
         * Measure the weight GRADIENT (per world unit), not the per-frame step.
         * A per-frame threshold silently depends on frame rate: the same smooth
         * blend yields a bigger step at 20 fps than at 60, so a slow rasteriser
         * or a heavier scene could fail a blend that is perfectly smooth. Per
         * unit of travel, the number is a property of the world, not the run.
         */
        const stepZ = Math.abs(traverse.z[i] - traverse.z[i - 1]);
        if (stepZ >= 0.05 && stepZ <= 2) {
          const gradient = Math.abs(w - traverse.w0[i - 1]) / stepZ;
          if (gradient > worstStep) {
            worstStep = gradient;
            worstStepIndex = i;
          }
        }
      }
    }
    const blendSpan = blendFirstZ === null ? 0 : Math.abs(blendLastZ - blendFirstZ);
    m.biome = {
      dominantStart: domStart,
      dominantEnd: domEnd,
      weight0Start: round(w0Start, 4),
      weight0End: round(w0End, 4),
      blendFrames,
      blendSpanUnits: round(blendSpan, 2),
      worstWeightGradientPerUnit: round(worstStep, 4),
    };

    if (domStart !== domEnd) {
      pass(
        'traverse crossed into a second biome',
        `dominant ${domStart} -> ${domEnd}, weight[0] ${w0Start.toFixed(3)} -> ${w0End.toFixed(3)}`,
      );
    } else {
      fail(
        'traverse crossed into a second biome',
        `dominant biome stayed ${domStart} from z=${startZ.toFixed(1)} to z=${endZ.toFixed(1)} (weight[0] ${w0Start.toFixed(3)} -> ${w0End.toFixed(3)}) — no boundary was crossed`,
      );
    }

    if (blendFrames >= 15 && blendSpan >= 8) {
      pass(
        'biome boundary blends instead of flipping (§12: no obvious popping)',
        `${blendFrames} frames with intermediate weights, spanning ${blendSpan.toFixed(1)} u of z`,
      );
    } else {
      fail(
        'biome boundary blends instead of flipping (§12: no obvious popping)',
        `only ${blendFrames} frames of intermediate weight over ${blendSpan.toFixed(1)} u — that is a hard seam, which reads as popping`,
      );
    }

    if (worstStep <= BIOME_MAX_GRADIENT) {
      pass(
        'biome blend has no discontinuity',
        `steepest weight gradient ${worstStep.toFixed(4)} per world unit (<= ${BIOME_MAX_GRADIENT}); a ~30 u transition band predicts ~0.05`,
      );
    } else {
      fail(
        'biome blend has no discontinuity',
        `weight[0] changes ${worstStep.toFixed(4)} per world unit at ${where(traverse, worstStepIndex)} — that is a seam, not a blend (§12 fails the phase for obvious popping)`,
      );
    }

    // --- 9. frame counter, tick rate --------------------------------------
    m.frameCountDelta = framesAfter - framesBefore;
    if (framesAfter > framesBefore) {
      pass('frame counter increasing', `${framesBefore} -> ${framesAfter} (+${framesAfter - framesBefore})`);
    } else {
      fail('frame counter increasing', `stuck at ${framesAfter}`);
    }

    const tickRate = tailMean(traverse.ticks, 0.7);
    m.tickRate = tickRate;
    if (Math.abs(tickRate - 60) <= 6) pass('fixed tick rate ~60/s', `${tickRate.toFixed(1)} /s`);
    else fail('fixed tick rate ~60/s', `${tickRate.toFixed(1)} /s — the accumulator is not keeping up`);

    // --- 3 + 8. the clean 12 s streaming traverse -------------------------
    /*
     * A second pass over fresh ground with a sampler that allocates nothing.
     * This is the dataset the stutter and heap assertions use: the rich
     * traverse above calls biomeAt()/world() every frame, and their return
     * objects would show up as both heap drift and GC hitches that belong to
     * the harness rather than the game.
     */
    const settleB = await page.evaluate(SETTLE, { x: 0, z: HEAP_START_Z, timeoutMs: 10_000 });
    m.settleBeforeHeap = settleB;
    const clean = await page.evaluate(CLEAN_TRAVERSE, {
      durationMs: HEAP_DURATION_MS,
      moveX,
      moveY,
      sprint: true,
    });
    if (clean.count < 60) {
      throw new Fatal(`the 12 s streaming traverse produced only ${clean.count} frames.`);
    }

    const stats = frameStats(clean.frameMs);
    const traverseStats = frameStats(traverse.frameMs);
    m.frameTime = {
      dataset: 'clean 12 s traverse',
      frames: stats.frames,
      medianMs: round(stats.median, 2),
      p90Ms: round(stats.p90, 2),
      p99Ms: round(stats.p99, 2),
      worstMs: round(stats.worst, 2),
      limitMs: round(stats.limit, 2),
      framesOverLimit: stats.over,
    };
    m.frameTimeRichTraverse = {
      frames: traverseStats.frames,
      medianMs: round(traverseStats.median, 2),
      p99Ms: round(traverseStats.p99, 2),
      worstMs: round(traverseStats.worst, 2),
      framesOverLimit: traverseStats.over,
    };

    if (stats.worst <= stats.limit) {
      pass(
        'no stutter: no frame exceeds 4x the median',
        `median ${stats.median.toFixed(1)} ms, p99 ${stats.p99.toFixed(1)} ms, worst ${stats.worst.toFixed(1)} ms (limit ${stats.limit.toFixed(1)} ms) over ${stats.frames} frames`,
      );
    } else {
      fail(
        'no stutter: no frame exceeds 4x the median',
        `median ${stats.median.toFixed(1)} ms, p99 ${stats.p99.toFixed(1)} ms, WORST ${stats.worst.toFixed(1)} ms — ${stats.over} frame(s) above the ${stats.limit.toFixed(1)} ms limit. A relative outlier this large during a streaming walk is a chunk-build or GC hitch (§12's "stutter"), not a frame-rate problem`,
      );
    }

    const heapFirst = clean.heapMb[0];
    const heapLast = clean.heapMb[clean.count - 1];
    const heapPeak = maxOf(clean.heapMb);
    const driftMb = heapLast - heapFirst;
    const bytesPerFrame = clean.count > 1 ? (driftMb * 1024 * 1024) / clean.count : 0;
    m.heap = {
      firstMb: round(heapFirst, 3),
      lastMb: round(heapLast, 3),
      peakMb: round(heapPeak, 3),
      driftMb: round(driftMb, 3),
      bytesPerFrame: Math.round(bytesPerFrame),
      frames: clean.count,
      seconds: round(clean.t[clean.count - 1], 2),
    };

    if (bytesPerFrame < HEAP_BYTES_PER_FRAME) {
      pass(
        'geometry pool does not leak (heap drift over 12 s of streaming)',
        `${bytesPerFrame.toFixed(0)} B/frame, ${driftMb.toFixed(2)} MB over ${clean.count} frames (limit ${HEAP_BYTES_PER_FRAME})`,
      );
    } else {
      fail(
        'geometry pool does not leak (heap drift over 12 s of streaming)',
        `${bytesPerFrame.toFixed(0)} B/frame (${driftMb.toFixed(2)} MB over ${clean.count} frames) — above ${HEAP_BYTES_PER_FRAME} B/frame the pool is reallocating chunk geometry instead of reusing it`,
      );
    }

    if (heapPeak <= BUDGET.heapMb) pass('heap <= 280 MB (§3)', `peak ${heapPeak.toFixed(1)} MB`);
    else fail('heap <= 280 MB (§3)', `peak ${heapPeak.toFixed(1)} MB`);

    // Budgets again on the clean pass — same walk, different sampler.
    const cleanDrawPeak = peakAt(clean, 'drawCalls');
    const cleanTriPeak = peakAt(clean, 'triangles');
    m.peakDrawCallsClean = cleanDrawPeak.value;
    m.peakTrianglesClean = cleanTriPeak.value;
    if (cleanDrawPeak.value <= BUDGET.drawCalls && cleanTriPeak.value <= BUDGET.triangles) {
      pass(
        'budgets hold on the second streaming pass too',
        `${cleanDrawPeak.value} draw calls, ${cleanTriPeak.value} triangles peak`,
      );
    } else {
      fail(
        'budgets hold on the second streaming pass too',
        `${cleanDrawPeak.value} draw calls (<= ${BUDGET.drawCalls}) at ${where(clean, cleanDrawPeak.index)}, ${cleanTriPeak.value} triangles (<= ${BUDGET.triangles}) at ${where(clean, cleanTriPeak.index)}`,
      );
    }

    let cleanWorstGround = 0;
    let cleanWorstIndex = -1;
    for (let i = 0; i < clean.count; i++) {
      const deviation = Math.abs(clean.y[i] - clean.groundY[i]);
      if (deviation > cleanWorstGround) {
        cleanWorstGround = deviation;
        cleanWorstIndex = i;
      }
    }
    m.worstGroundDeviationClean = cleanWorstGround;
    if (cleanWorstGround < GROUND_TOLERANCE) {
      pass('player stays on terrain on the second pass', `worst deviation ${cleanWorstGround.toFixed(4)} u`);
    } else {
      fail(
        'player stays on terrain on the second pass',
        `worst deviation ${cleanWorstGround.toFixed(4)} u at ${where(clean, cleanWorstIndex)}`,
      );
    }

    // --- 6. day-night cycle -----------------------------------------------
    await page.evaluate(SETTLE, { x: 0, z: 0, timeoutMs: 8000 });

    // The cycle should also advance on its own (§5: 720 s), so check that
    // before setDayPhase() starts overwriting the phase.
    const drift = await page.evaluate(async () => {
      const d = globalThis.__ARCANUM_DEBUG__;
      const before = d.dayPhase();
      await new Promise((r) => setTimeout(r, 5000));
      const after = d.dayPhase();
      let delta = after - before;
      if (delta < -0.5) delta += 1; // wrap
      return { before, after, delta };
    });
    m.dayPhaseDrift = { before: round(drift.before, 5), after: round(drift.after, 5), delta: round(drift.delta, 5) };
    if (drift.delta > 0.001) {
      pass(
        'day-night cycle advances on its own',
        `phase ${drift.before.toFixed(4)} -> ${drift.after.toFixed(4)} in 5 s (+${drift.delta.toFixed(4)}; a 720 s cycle predicts +0.0069)`,
      );
    } else {
      fail(
        'day-night cycle advances on its own',
        `phase moved ${drift.delta.toFixed(5)} in 5 s — the cycle is frozen`,
      );
    }

    // Hide the DOM overlay so the band averages measure the rendered world and
    // not the HUD and touch controls sitting on top of it.
    await page.evaluate(() => {
      const root = document.getElementById('ui-root');
      if (root !== null) root.dataset.worldtestHidden = root.style.visibility;
      if (root !== null) root.style.visibility = 'hidden';
    });

    // A wandering enemy in frame varies the non-terrain draw count between
    // keyframe snapshots and fails the dome-constancy check spuriously (found
    // via GL-level draw capture). The check is about the DOME; clear the cast,
    // stop the director repopulating mid-snapshot, and let death animations,
    // orb drops and other kill transients finish before sampling.
    await page.evaluate(() => {
      const d = globalThis.__ARCANUM_DEBUG__;
      if (typeof d.pauseDirector === 'function') d.pauseDirector(true);
      if (typeof d.killAllEnemies === 'function') d.killAllEnemies();
    });
    await sleep(1600);

    const dayRows = [];
    let bandsWorked = true;
    for (const phase of DAY_PHASES) {
      await page.evaluate((p) => globalThis.__ARCANUM_DEBUG__.setDayPhase(p), phase);
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            let left = 8;
            const step = () => (left-- > 0 ? requestAnimationFrame(step) : resolve());
            requestAnimationFrame(step);
          }),
      );
      const state = await page.evaluate(SKY_STATE);
      const metrics = await page.evaluate(() => {
        const x = globalThis.__ARCANUM_DEBUG__.metrics();
        const w = globalThis.__ARCANUM_DEBUG__.world();
        return {
          drawCalls: x.drawCalls,
          triangles: x.triangles,
          programs: x.programs,
          geometries: x.geometries,
          visibleChunks: w.visibleChunks,
        };
      });
      const shot = await page.screenshot({ type: 'png' });
      const bands = await page.evaluate(BANDS, shot.toString('base64'));
      if (!bands.ok) bandsWorked = false;
      dayRows.push({ phase, state, metrics, bands });
    }
    report.dayNight = dayRows.map((row) => ({
      phase: row.phase,
      reportedPhase: row.state.phase === null ? null : round(row.state.phase, 5),
      fogHex: row.state.fogHex === null ? null : '#' + row.state.fogHex.toString(16).padStart(6, '0'),
      sunIntensity: row.state.sunIntensity,
      drawCalls: row.metrics.drawCalls,
      triangles: row.metrics.triangles,
      sky: row.bands.ok ? { r: round(row.bands.sky.r, 1), g: round(row.bands.sky.g, 1), b: round(row.bands.sky.b, 1), luma: round(row.bands.sky.luma, 1) } : null,
      ground: row.bands.ok ? { r: round(row.bands.ground.r, 1), g: round(row.bands.ground.g, 1), b: round(row.bands.ground.b, 1), luma: round(row.bands.ground.luma, 1) } : null,
      frame: row.bands.ok ? { r: round(row.bands.all.r, 1), g: round(row.bands.all.g, 1), b: round(row.bands.all.b, 1), luma: round(row.bands.all.luma, 1) } : null,
      bandError: row.bands.ok ? null : row.bands.error,
    }));

    // setDayPhase must actually take effect.
    let phaseHonoured = true;
    for (const row of dayRows) {
      if (row.state.phase !== null && Math.abs(row.state.phase - row.phase) > 0.02) phaseHonoured = false;
    }
    if (phaseHonoured) pass('setDayPhase() is honoured by dayPhase()', DAY_PHASES.join(', '));
    else fail('setDayPhase() is honoured by dayPhase()', JSON.stringify(report.dayNight.map((r) => [r.phase, r.reportedPhase])));

    if (bandsWorked) {
      let minSeparation = Infinity;
      let closestPair = '';
      for (let i = 0; i < dayRows.length; i++) {
        for (let j = i + 1; j < dayRows.length; j++) {
          const d = colorDistance(dayRows[i].bands.all, dayRows[j].bands.all);
          if (d < minSeparation) {
            minSeparation = d;
            closestPair = `${dayRows[i].phase} vs ${dayRows[j].phase}`;
          }
        }
      }
      const night = dayRows[0].bands;
      const day = dayRows[2].bands;
      const lumaGap = day.all.luma - night.all.luma;
      const groundShift = colorDistance(day.ground, night.ground);
      m.dayNightPixels = {
        minFrameSeparation: round(minSeparation, 2),
        closestPair,
        dayMinusNightLuma: round(lumaGap, 2),
        dayVsNightGroundDistance: round(groundShift, 2),
      };

      if (minSeparation > DAY_COLOR_SEPARATION) {
        pass(
          'all four day-night keyframes render differently',
          `closest pair ${closestPair} differs by ${minSeparation.toFixed(1)} RGB units (> ${DAY_COLOR_SEPARATION})`,
        );
      } else {
        fail(
          'all four day-night keyframes render differently',
          `phases ${closestPair} are only ${minSeparation.toFixed(1)} RGB units apart — the cycle is barely doing anything`,
        );
      }

      if (lumaGap > DAY_NIGHT_LUMA_GAP) {
        pass(
          'fog colour and sun intensity change across the cycle',
          `day (0.50) frame luma exceeds night (0.00) by ${lumaGap.toFixed(1)}; lit-ground colour moved ${groundShift.toFixed(1)} RGB units, which is the sun/hemi change`,
        );
      } else {
        fail(
          'fog colour and sun intensity change across the cycle',
          `day minus night frame luma is only ${lumaGap.toFixed(1)} (needed > ${DAY_NIGHT_LUMA_GAP}); ground colour moved ${groundShift.toFixed(1)} — fog and sun are not being driven`,
        );
      }
    } else {
      unknown(
        'fog colour and sun intensity change across the cycle',
        `the in-page PNG decode failed (${dayRows.find((r) => !r.bands.ok)?.bands.error}), and __ARCANUM_DEBUG__ exposes neither fog colour nor sun intensity, so this cannot be measured. Expose them on world() or a sky() hook.`,
      );
    }

    // Direct confirmation if the debug surface happens to expose the numbers.
    const fogHexes = dayRows.map((r) => r.state.fogHex).filter((v) => v !== null);
    const sunValues = dayRows.map((r) => r.state.sunIntensity).filter((v) => v !== null);
    if (fogHexes.length === DAY_PHASES.length && sunValues.length === DAY_PHASES.length) {
      const distinctFog = new Set(fogHexes).size === fogHexes.length;
      let minSunGap = Infinity;
      for (let i = 0; i < sunValues.length; i++) {
        for (let j = i + 1; j < sunValues.length; j++) {
          const gap = Math.abs(sunValues[i] - sunValues[j]);
          if (gap < minSunGap) minSunGap = gap;
        }
      }
      if (distinctFog && minSunGap > 0.05) {
        pass(
          'fog colour and sun intensity read directly from the debug surface',
          `fog ${fogHexes.map((h) => '#' + h.toString(16).padStart(6, '0')).join(' ')}, sun ${sunValues.map((v) => v.toFixed(2)).join(' / ')}`,
        );
      } else {
        fail(
          'fog colour and sun intensity read directly from the debug surface',
          `fog distinct=${distinctFog}, smallest sun-intensity gap ${minSunGap.toFixed(3)}`,
        );
      }
    } else {
      // Not a failure — the contract never promised these. Recorded so the gap is visible.
      pass(
        'fog/sun accessors (optional)',
        'not exposed on __ARCANUM_DEBUG__; the day-night check above used rendered pixels instead',
      );
    }

    /*
     * Sky dome must not add draw calls as the cycle runs: recolouring rewrites a
     * colour attribute in place, so the cost is a constant 1.
     *
     * Compare NON-TERRAIN overhead, not raw draw calls. Chunk visibility can
     * legitimately differ between two snapshots a second apart (a build lands, the
     * culler flips a border chunk), and comparing raw totals turns that into a
     * spurious "the dome changed" failure.
     */
    const domeDraws = dayRows.map((r) => r.metrics.drawCalls);
    const domeOverhead = dayRows.map((r) => r.metrics.drawCalls - r.metrics.visibleChunks);
    const domeSpread = maxOf(domeOverhead) - minOf(domeOverhead);
    m.dayNightDrawCalls = domeDraws;
    m.dayNightNonTerrainDrawCalls = domeOverhead;
    if (domeSpread <= 1 && maxOf(domeDraws) <= BUDGET.drawCalls) {
      pass(
        'sky dome costs a constant single draw call',
        `non-terrain draw calls across the four keyframes: ${domeOverhead.join(', ')} (spread ${domeSpread}); raw totals ${domeDraws.join(', ')} varied only with chunk visibility`,
      );
    } else {
      fail(
        'sky dome costs a constant single draw call',
        `non-terrain draw calls varied across keyframes: ${domeOverhead.join(', ')} (raw ${domeDraws.join(', ')}) — recolouring the dome should not change the draw count`,
      );
    }

    // Restore the overlay and a pleasant phase for the screenshot.
    await page.evaluate(() => {
      const root = document.getElementById('ui-root');
      if (root !== null) root.style.visibility = root.dataset.worldtestHidden ?? '';
    });

    // --- 10. artifacts ----------------------------------------------------
    if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
    // Mid-blend, mid-morning: the frame that should show both biomes at once.
    await page.evaluate(() => {
      globalThis.__ARCANUM_DEBUG__.clearInput();
      globalThis.__ARCANUM_DEBUG__.setDayPhase(0.35);
    });
    await page.evaluate(SETTLE, { x: 0, z: -44, timeoutMs: 8000 });
    await sleep(400);
    await page.screenshot({ path: path.join(ARTIFACTS, 'worldtest.png') });
    pass('screenshot written', 'artifacts/worldtest.png (z=-44, mid biome blend, phase 0.35)');

    report.series = {
      note:
        'traverse = rich sampler (biome + streaming counters, allocates via the debug hooks); ' +
        'clean = 12 s streaming pass with an allocation-free sampler, used for the stutter and heap assertions.',
      traverse: {
        t: roundSeries(traverse.t, 3),
        frameMs: roundSeries(traverse.frameMs, 2),
        drawCalls: traverse.drawCalls,
        triangles: traverse.triangles,
        heapMb: roundSeries(traverse.heapMb, 3),
        x: roundSeries(traverse.x, 2),
        y: roundSeries(traverse.y, 3),
        z: roundSeries(traverse.z, 2),
        groundY: roundSeries(traverse.groundY, 3),
        speed: roundSeries(traverse.speed, 2),
        weight0: roundSeries(traverse.w0, 4),
        dominant: traverse.dominant,
        activeChunks: traverse.activeChunks,
        visibleChunks: traverse.visibleChunks,
        queuedChunks: traverse.queuedChunks,
        pooledGeometries: traverse.pooledGeometries,
        propInstances: traverse.propInstances,
      },
      clean: {
        t: roundSeries(clean.t, 3),
        frameMs: roundSeries(clean.frameMs, 2),
        drawCalls: clean.drawCalls,
        triangles: clean.triangles,
        heapMb: roundSeries(clean.heapMb, 3),
        x: roundSeries(clean.x, 2),
        y: roundSeries(clean.y, 3),
        z: roundSeries(clean.z, 2),
        groundY: roundSeries(clean.groundY, 3),
      },
    };
  } catch (error) {
    if (!hardTimedOut && interrupted === null) {
      if (error instanceof Fatal) fail('harness precondition', error.message);
      else fail('harness error', error?.stack ?? String(error));
    }
  }

  /*
   * Outside the try on purpose. When the boot fails, the page's own exception is
   * the single most useful line in the report — "ChunkManager is not defined"
   * beats "waitForFunction timed out" — and it must not be skipped just because
   * the run aborted before reaching the end.
   */
  if (report.pageErrors.length === 0) pass('no uncaught page errors', '0');
  else fail('no uncaught page errors', report.pageErrors.join(' | '));
  if (report.consoleErrors.length === 0) pass('no console errors', '0');
  else fail('no console errors', report.consoleErrors.join(' | '));

  if (interrupted !== null) fail('interrupted', `${interrupted} received — no verdict.`);
  if (hardTimedOut) fail('overall timeout', `exceeded ${OVERALL_TIMEOUT_MS} ms`);

  const failed = report.checks.filter((c) => c.status === 'FAIL');
  report.verdict = failed.length === 0 ? 'PASS' : 'FAIL';
  report.durationMs = Date.now() - startedAt;

  printSummary();

  if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(path.join(ARTIFACTS, 'worldtest.json'), JSON.stringify(report, null, 2));

  await cleanup();
  process.exit(interrupted !== null ? 130 : report.verdict === 'PASS' ? 0 : 1);
}

function printSummary() {
  const m = report.measurements;
  const row = (label, value, expected) =>
    console.log('  ' + label.padEnd(34) + String(value).padStart(16) + '   ' + expected);

  console.log('\n' + '='.repeat(78));
  console.log('ARCANUM DRIFT — PHASE 2 WORLD GATE');
  console.log('='.repeat(78));

  console.log('\nTRAVERSE');
  const t = m.traverse ?? {};
  row('southward distance', (t.dz ?? 0) + ' u', 'z +45 -> -80');
  row('frames sampled', t.frames ?? 0, '');
  row('mean sprint speed', (t.meanSpeed ?? 0) + ' u/s', '~7 (§7)');

  console.log('\nBUDGETS (§3 / §12)');
  row('draw calls (peak)', m.peakDrawCalls ?? 0, '<= 110');
  row('  where', m.peakDrawCallsAt ?? '-', '');
  row('triangles (peak)', m.peakTriangles ?? 0, '<= 150000');
  row('  where', m.peakTrianglesAt ?? '-', '');
  row('non-terrain draw calls', m.worstDrawOverhead ?? 0, `<= ${DRAW_OVERHEAD_MAX}`);
  row('heap (peak)', (m.heap?.peakMb ?? 0) + ' MB', '<= 280');

  console.log('\nSTUTTER  (relative outliers — NOT frame rate)');
  const f = m.frameTime ?? {};
  row('median frame time', (f.medianMs ?? 0) + ' ms', 'SwiftShader baseline');
  row('p99 frame time', (f.p99Ms ?? 0) + ' ms', '');
  row('worst frame', (f.worstMs ?? 0) + ' ms', `<= ${f.limitMs ?? 0} (4x median)`);
  row('frames over the limit', f.framesOverLimit ?? 0, '0');

  console.log('\nSTREAMING');
  const s = m.streaming ?? {};
  row('active chunks (peak)', s.maxActive ?? 0, '~25 (5x5)');
  row('visible chunks', (s.minVisible ?? 0) + '..' + (s.maxVisible ?? 0), '< active');
  row('build queue (peak / final)', (s.maxQueued ?? 0) + ' / ' + (s.finalQueued ?? 0), 'final <= 4');
  row('pooled geometries (peak)', s.maxPooled ?? 0, 'bounded');
  row('prop instances (peak)', s.maxPropInstances ?? 0, '> 0');
  row('worst ground deviation', (m.worstGroundDeviation ?? 0).toFixed(4) + ' u', '< 0.12');
  row('heap drift', (m.heap?.bytesPerFrame ?? 0) + ' B/frame', `< ${HEAP_BYTES_PER_FRAME}`);

  console.log('\nBIOME CROSSING');
  const b = m.biome ?? {};
  row('dominant biome', (b.dominantStart ?? '-') + ' -> ' + (b.dominantEnd ?? '-'), 'must differ');
  row('weight[0]', (b.weight0Start ?? '-') + ' -> ' + (b.weight0End ?? '-'), '1 -> 0');
  row('blend band', (b.blendSpanUnits ?? 0) + ' u / ' + (b.blendFrames ?? 0) + ' frames', 'wide, not a seam');
  row('steepest weight gradient', b.worstWeightGradientPerUnit ?? 0, `<= ${BIOME_MAX_GRADIENT} / unit`);

  console.log('\nDAY-NIGHT');
  for (const d of report.dayNight) {
    const frame = d.frame === null ? 'no pixels' : `rgb(${d.frame.r}, ${d.frame.g}, ${d.frame.b}) luma ${d.frame.luma}`;
    console.log(
      `  phase ${String(d.phase).padEnd(5)} draws ${String(d.drawCalls).padStart(4)}   ${frame}` +
        (d.fogHex === null ? '' : `   fog ${d.fogHex} sun ${d.sunIntensity}`),
    );
  }

  console.log('\nCHECKS');
  for (const check of report.checks) {
    const mark = check.status === 'PASS' ? 'ok  ' : 'FAIL';
    console.log(`  [${mark}] ${check.name}  —  ${check.detail}`);
  }

  console.log('\nHONEST LIMITS OF THIS RUN');
  console.log('  SwiftShader software rendering. Absolute frame time here is not a');
  console.log('  device number, so the stutter check is deliberately RELATIVE: it');
  console.log('  detects HITCHES (a chunk build or a GC pause standing out against the');
  console.log('  local median), not frame rate. A pass means the streaming is smooth');
  console.log('  relative to itself; it does not mean 60 FPS on a Snapdragon 680.');
  console.log('  Draw calls, triangles, heap drift, streaming correctness, the biome');
  console.log('  blend and error-freedom are all real numbers and transfer to device.');
  console.log('  Fog colour / sun intensity are measured from decoded frame pixels');
  console.log('  because __ARCANUM_DEBUG__ does not expose the FogExp2 or the light —');
  console.log('  that proves the cycle is visible, which is what §5 actually asks for.');
  console.log('  §12 still requires a real handset for the feel and the frame rate.');

  const failedCount = report.checks.filter((c) => c.status === 'FAIL').length;
  console.log(
    `\nVERDICT     ${report.verdict}  (${report.checks.length - failedCount} passed, ${failedCount} failed, ${report.durationMs} ms)`,
  );
  console.log('='.repeat(78) + '\n');
}

process.on('unhandledRejection', (reason) => {
  console.error('[worldtest] unhandled rejection:', reason);
  void cleanup().finally(() => process.exit(1));
});

await main();
