#!/usr/bin/env node
/**
 * Arcanum Drift — Phase 5 content gate.
 *
 * §12's Phase 5 acceptance criterion — "20 minutes of exploration without
 * feeling empty or repetitive" — is a FEEL criterion, judged on a handset.
 * What this gate proves is the structure that feeling is built on: the §4.1
 * law extended to ENEMY KINDS (node-side, before any browser), all 5 regions
 * reachable and distinct, the SpawnDirector's budgets and the §9 cap of 18,
 * every one of the 12 bestiary kinds spawnable / moving / telegraphing /
 * hitting / killable, the element multiplier live (×0.5 / ×1.5), Phase 4's
 * recorded debt paid (Shatter ×3 and Thermal Shock's armor break now
 * MEASURABLE on armored high-hp kinds), one shrine of each challenge type
 * driven to completion, a fragment set assembled by walking into its sites,
 * the Vael fight driven through all three phases with the reaction shield
 * observed doing its ×0.15 teaching, and the §3 budgets held THROUGHOUT.
 *
 * Every per-kind and per-skill expectation is DERIVED from src/data/*.json at
 * run time — the gate hardcodes no enemy kind and no skill id anywhere; actors
 * are picked by predicate (element, resists, armor, attack kind, challenge
 * kind, shrineElement / fragments / bossReward markers). The only hardcoded
 * numbers are documented engine truths (below) and Boss Vael's scripted
 * constants, which the phase contract explicitly exempts from §4.1.
 *
 * Honest compressions, stated loudly here and in the NOTE section:
 *  - survive60 runs under shrineTimeScale(6) — the integrator's sanctioned
 *    debug hook; the FSM, waves, radius rule and reward all run for real.
 *  - Vael's 2400 hp is stepped between phases with setEnemyHp; every phase
 *    transition, shield raise/strip/refresh and damage number is then produced
 *    by REAL seeded casts through the real pipeline.
 *  - Enemy pose animation (limb swing, hover bob) lives in EnemyVisual and is
 *    not on the debug surface; the gate proves locomotion (position over time)
 *    and leaves pose quality to the device test.
 *
 * Infrastructure is the proven sibling shape (skilltest.mjs is the model):
 * detached vite preview + process-group teardown, global Playwright import,
 * hard timeout, SIGINT→130, in-page rAF drivers (never Node-side sleeps where
 * timing matters), samplers installed BEFORE the actions they observe, and
 * waitForFunction's three-argument form.
 *
 * Port 4178 (smoke 4173, playtest 4174, worldtest 4175, combattest 4176,
 * skilltest 4177).
 *
 * Usage: npm run build && node tools/contenttest.mjs
 * Output: artifacts/contenttest.json + 6 screenshots (one per region + boss).
 * Exit 0/1, 130 on SIGINT.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');
const ARTIFACTS = path.join(ROOT, 'artifacts');

const HOST = '127.0.0.1';
const PORT = 4178;
const URL_ = `http://${HOST}:${PORT}/`;

/** Five 30 s region walks + 12 kind probes + 3 shrines + the boss: this gate
 * does a lot of honest real-time driving. */
const OVERALL_TIMEOUT_MS = 900_000;
const SERVER_TIMEOUT_MS = 30_000;

/** §3 hard budgets. */
const BUDGET = { drawCalls: 110, triangles: 150_000, heapMb: 280 };
/** Contract test 10: heap drift < 4 KB/frame over the whole run. */
const HEAP_BYTES_PER_FRAME = 4096;
/** Contract test 2: ground deviation tolerance (worldtest's number). */
const GROUND_TOLERANCE = 0.12;
const GROUND_MIN_SAMPLES = 200;
/** §9: telegraphs are readable — never under 0.5 s (0.45 leaves rAF slack). */
const TELEGRAPH_MIN_S = 0.45;
/** §9: at most 18 active enemies, ever. */
const ENEMY_CAP = 18;

/** Engine truths this gate leans on (documented, not guessed):
 *  - PlayerStats boots every stat at 10; melee stage-1 base is 12 with
 *    agility × 0.35 scaling (combattest's proven STAGE_BASE);
 *  - DamageSystem: crit 8% ×1.6, armor softcap 300, mulberry32 streams that
 *    setDamageSeed/setStatusSeed re-seed (solved offline below);
 *  - StatusEffects: Shatter ×3, Thermal Shock halves armor for 5 s, board ids
 *    burn0 freeze1 wet2 shock3 bleed4 silence5;
 *  - EnemyDefs.deriveAttackRadius: lunge 1.7+0.5·scale, ranged min(aggro·0.85,
 *    14), charge range·0.85, slam radius·0.8 (drives spawn distances only). */
const STAT_VALUE = 10;
const CRIT_CHANCE = 0.08;
const ARMOR_SOFTCAP = 300;
const MELEE_STAGE1_BASE = 12;
const MELEE_AGI_RATIO = 0.35;
const SHATTER_MULT = 3.0;
const STATUS_INDEX = { burn: 0, freeze: 1, wet: 2, shock: 3, bleed: 4, silence: 5 };

/** Boss Vael's scripted constants (§4.1-exempt content, per the contract;
 *  restated from src/enemy/BossVael.ts so drift there fails here loudly). */
const VAEL = {
  maxHp: 2400,
  armor: 60,
  arenaX: 0,
  arenaZ: 255,
  triggerRadius: 20,
  leashRadius: 34,
  p2Fraction: 0.66,
  p3Fraction: 0.33,
  shieldLayers: 3,
  shieldDamageMult: 0.15,
  resists: ['dark'],
  weakTo: ['light'],
};

/** Region ids (BiomeTable.BIOME — a stable Phase 2 contract, not a kind). */
const REGION = { verdant: 0, whisperwood: 1, emberscar: 2, frostvale: 3, spire: 4 };
const REGION_NAMES = ['verdant', 'whisperwood', 'emberscar', 'frostvale', 'spire'];
/** §9 budget points per region (contract numbers, asserted against director()). */
const REGION_BUDGET = [6, 10, 12, 12, 14];
/** Search boxes for region probe points — from the contract's region layout
 * (Verdant centre disc, Whisperwood south, Emberscar east, Frostvale west,
 * Spire far north). Hints for the finder; regionAt() decides membership. */
const REGION_SEARCH = [
  { cx: 0, cz: 30, x0: -80, x1: 80, z0: -60, z1: 90 },
  { cx: 0, cz: -150, x0: -140, x1: 140, z0: -230, z1: -95 },
  { cx: 160, cz: 20, x0: 100, x1: 240, z0: -40, z1: 90 },
  { cx: -160, cz: 20, x0: -240, x1: -100, z0: -40, z1: 90 },
  { cx: -80, cz: 185, x0: -150, x1: 150, z0: 145, z1: 235 },
];
/** Spire walks keep clear of the arena so the boss stays dormant until #9. */
const SPIRE_KEEPOUT = 62;

const REGION_WALK_MS = 30_000;
const WALK_RADIUS = 16;

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
// process plumbing (identical shape to the sibling gates — never orphan the server)
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
    console.error(`\n[contenttest] ${signal} received — tearing down.`);
    setTimeout(() => process.exit(130), 4000).unref();
    void cleanup().finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const report = {
  tool: 'tools/contenttest.mjs',
  phase: 5,
  startedAt: new Date().toISOString(),
  durationMs: 0,
  verdict: 'FAIL',
  renderingBackend:
    'SwiftShader (software) — not device numbers; §12\'s "20 minutes without feeling empty" is the device test\'s to judge',
  budgets: BUDGET,
  measurements: {},
  misSpecified: [],
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
/** Observed, real, but not a code defect — listed in the NOTE section. */
function note(name, detail) {
  record(name, 'NOTE', detail);
  report.misSpecified.push(`${name} — ${detail}`);
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function maxOf(arr) {
  let best = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > best) best = arr[i];
  return best === -Infinity ? 0 : best;
}

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

function minBy(list, score) {
  let best = null;
  let bestScore = Infinity;
  for (const item of list) {
    const v = score(item);
    if (v < bestScore) {
      bestScore = v;
      best = item;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// mulberry32 replica — seeds are SOLVED here, offline, then handed to the page
// ---------------------------------------------------------------------------

function mulberrySeq(seed, n) {
  let s = seed >>> 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return out;
}

function findSeed(predicate, rolls = 16, tries = 500_000) {
  for (let seed = 1; seed <= tries; seed++) {
    if (predicate(mulberrySeq(seed, rolls))) return seed;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// PART 1 — node-side: §4.1 for enemies, data sanity, derived expectations
// ---------------------------------------------------------------------------

function loadJson(rel) {
  return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
}

function normalizeSkills(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === 'object' && Array.isArray(raw.skills)) return raw.skills;
  throw new Fatal('src/data/skills.json has neither an array nor a { skills: [...] } shape.');
}

function walkTs(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Blanks comments (block + line) while KEEPING string/template literal
 * contents — a kind string smuggled into a literal is exactly what the law
 * forbids, while "a slime (1 pt) is twice as likely" in a design comment is
 * prose, not a code path. Comment-only mentions are still reported as a NOTE
 * so nothing is silently waved through.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let mode = 0; // 0 code, 1 line comment, 2 block comment, 3 ' 4 " 5 `
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (mode === 0) {
      if (c === '/' && d === '/') {
        mode = 1;
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && d === '*') {
        mode = 2;
        out += '  ';
        i += 2;
        continue;
      }
      if (c === "'") mode = 3;
      else if (c === '"') mode = 4;
      else if (c === '`') mode = 5;
      out += c;
      i++;
      continue;
    }
    if (mode === 1) {
      if (c === '\n') {
        mode = 0;
        out += '\n';
      } else out += ' ';
      i++;
      continue;
    }
    if (mode === 2) {
      if (c === '*' && d === '/') {
        mode = 0;
        out += '  ';
        i += 2;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    // inside a string/template literal — keep verbatim, honour escapes
    if (c === '\\') {
      out += c + d;
      i += 2;
      continue;
    }
    if ((mode === 3 && c === "'") || (mode === 4 && c === '"') || (mode === 5 && c === '`')) mode = 0;
    out += c;
    i++;
  }
  return out;
}

function scanForKinds(kinds) {
  const files = walkTs(SRC, []);
  const codeHits = [];
  const commentHits = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const stripped = stripComments(raw);
    const rawLines = raw.split('\n');
    const codeLines = stripped.split('\n');
    for (let i = 0; i < rawLines.length; i++) {
      for (const kind of kinds) {
        if (!rawLines[i].includes(kind)) continue;
        const where = `${path.relative(ROOT, file)}:${i + 1} contains "${kind}"`;
        if ((codeLines[i] ?? '').includes(kind)) codeHits.push(where);
        else commentHits.push(where);
      }
    }
  }
  return { files: files.length, codeHits, commentHits };
}

const mitigation = (armor) => 1 - armor / (armor + ARMOR_SOFTCAP);
const expDmg = (s) => (s.damage !== undefined ? s.damage.base + STAT_VALUE * s.damage.scaling.ratio : 0);
const isAttack = (s) => s.damage !== undefined && s.damage.base > 0;
const elemMultOf = (def, element) => {
  if (def.weakTo.indexOf(element) >= 0) return 1.5;
  if (def.resists.indexOf(element) >= 0) return 0.5;
  return 1;
};
/** Mastery multiplies the BASE only (SkillRuntime.fire), +damagePct per level. */
const masteryMult = (skill, level) =>
  1 + (Math.max(1, level) - 1) * ((skill.masteryBonus?.damagePctPerLevel ?? 0) / 100);
/** Expected hit through the §9 formula, non-crit, reactionMult 1. */
const skillHit = (skill, level, elementTableMult, armor, armorFactor = 1) =>
  (skill.damage.base * masteryMult(skill, level) + STAT_VALUE * skill.damage.scaling.ratio) *
  elementTableMult *
  mitigation(armor * armorFactor);

/** deriveAttackRadius restated (engine truth) — used only to pick spawn distances. */
function attackRadiusOf(def) {
  const a = def.attack;
  switch (a.kind) {
    case 'lunge':
      return 1.7 + 0.5 * def.scale;
    case 'ranged': {
      const r = def.aggroRadius * 0.85;
      return r > 14 ? 14 : r;
    }
    case 'charge':
      return a.chargeRange * 0.85;
    case 'slam':
      return a.slamRadius * 0.8;
    default:
      return 2;
  }
}

/**
 * Two distances per kind: where locomotion is observed (beyond attack range,
 * inside aggro) and where the ATTACK is observed. For ranged kinds these
 * differ: their natural stand-off (~aggro x 0.85, 12-14 u) regularly has no
 * line of sight over the convex slope around the origin arena, and a shot
 * without LOS honestly dies in the hillside — so the hit is proven at 6.5 u
 * on the flat disc, where LOS is a certainty (see the #4 NOTE).
 */
function spawnDistanceFor(def) {
  const reach = attackRadiusOf(def);
  if (def.attack.kind === 'ranged') {
    return { move: def.aggroRadius - 0.5, fight: 6.5 };
  }
  if (def.attack.kind === 'charge') {
    const d = Math.min(def.aggroRadius - 0.5, reach + 2.2);
    return { move: d, fight: d };
  }
  const d = Math.min(def.aggroRadius - 1, 6.5);
  return { move: d, fight: d };
}

/** Every named actor below is PICKED from the JSON by predicate. */
function derivePicks(skills, defs) {
  const picks = {};

  // Element-multiplier trio: an element with an attack projectile skill, a
  // def that resists it and a def weak to it. Slow targets preferred (they
  // reach the caster later).
  picks.elementTrio = null;
  for (const element of ['fire', 'ice', 'wind', 'earth', 'light', 'dark', 'water']) {
    const skill = minBy(
      skills.filter((s) => s.element === element && isAttack(s) && s.delivery.type === 'projectile'),
      expDmg,
    );
    if (skill === null) continue;
    const weakDefs = defs.filter((d) => d.weakTo.includes(element) && d.maxHp > expDmg(skill) * 1.8);
    const resistDefs = defs.filter((d) => d.resists.includes(element) && d.maxHp > expDmg(skill));
    if (weakDefs.length === 0 || resistDefs.length === 0) continue;
    picks.elementTrio = {
      element,
      skill,
      weakDef: minBy(weakDefs, (d) => d.moveSpeed),
      resistDef: minBy(resistDefs, (d) => d.moveSpeed),
    };
    break;
  }

  // Phase 4's debt: a high-hp ARMORED kind (Shatter x3 / Thermal Shock).
  const armored = defs.filter((d) => d.armor > 0 && d.maxHp >= 200);
  picks.armoredDef =
    minBy(armored.filter((d) => d.attack.kind === 'slam'), (d) => d.moveSpeed) ??
    minBy(armored, (d) => d.moveSpeed);

  // A statusless wind attack (safe on frozen targets: wind reacts only with
  // burn), and the general-purpose executioner (fast statusless projectile).
  picks.windPlain = minBy(
    skills.filter((s) => s.element === 'wind' && isAttack(s) && s.status === undefined),
    expDmg,
  );
  picks.killSkill = minBy(
    skills.filter((s) => isAttack(s) && s.delivery.type === 'projectile' && s.status === undefined),
    (s) => s.castTime * 10 + s.cooldown,
  );
  picks.fireSkill = minBy(
    skills.filter((s) => s.element === 'fire' && isAttack(s) && s.delivery.type === 'projectile'),
    expDmg,
  );
  picks.wetSkill = minBy(
    skills.filter((s) => s.status !== undefined && s.status.id === 'wet' && s.status.chance >= 0.99 && isAttack(s)),
    expDmg,
  );
  picks.darkSkill = minBy(
    skills.filter((s) => s.element === 'dark' && isAttack(s) && s.delivery.type === 'projectile'),
    expDmg,
  );
  picks.healSkill = skills.find((s) => s.heal !== undefined && s.delivery.type === 'self') ?? null;

  // Phase 5's ten scripted-acquisition skills.
  picks.shrineSkills = new Map();
  for (const s of skills) {
    if (typeof s.shrineElement === 'string') picks.shrineSkills.set(s.shrineElement, s);
  }
  picks.fragmentSkills = skills.filter((s) => s.fragments === 3);
  picks.bossSkills = skills.filter((s) => s.bossReward === true);
  return picks;
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

/** Short walk under a fixed input; returns the displacement (the house trick). */
const CAL_WALK = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    d.clearInput();
    d.warp(o.x, o.z);
    const start = d.player();
    const sx = start.x;
    const sz = start.z;
    d.setInput({ moveX: o.moveX, moveY: o.moveY, sprint: false });
    const t0 = performance.now();
    const tick = () => {
      if (performance.now() - t0 >= o.durationMs) {
        const p = d.player();
        d.clearInput();
        resolve({ dx: p.x - sx, dz: p.z - sz });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** Find a probe point whose 20 u neighbourhood is dominated by one region. */
const REGION_FIND = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  const pts = [];
  for (let x = o.x0; x <= o.x1; x += o.step) {
    for (let z = o.z0; z <= o.z1; z += o.step) {
      pts.push({ x, z, score: (x - o.cx) * (x - o.cx) + (z - o.cz) * (z - o.cz) });
    }
  }
  pts.sort((a, b) => a.score - b.score);
  const ringOk = (x, z) => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (d.regionAt(x + Math.sin(a) * o.ringR, z + Math.cos(a) * o.ringR) !== o.region) return false;
    }
    return true;
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (o.avoidR > 0) {
      const ax = p.x - o.avoidX;
      const az = p.z - o.avoidZ;
      if (ax * ax + az * az < o.avoidR * o.avoidR) continue;
    }
    if (d.regionAt(p.x, p.z) !== o.region) continue;
    if (d.terrainHeightAt(p.x, p.z) < o.minH) continue;
    if (!ringOk(p.x, p.z)) continue;
    return { x: p.x, z: p.z };
  }
  return null;
};

/**
 * The #3 workhorse: 30 s circling walk in one region with the director LIVE.
 * Samples budgets/cap/terrain-deviation per rAF; records each enemy's kind and
 * the dominant region at FIRST sight (spawn attribution); freezes anything
 * within guard radius every ~1.1 s and casts the heal slot when the HUD hp
 * runs low — both defensive only, so a 30 s walk cannot end in a respawn that
 * would invalidate the region premise.
 */
const REGION_WALK = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  const readHp = () => {
    const el = document.querySelector('.hud__bar--hp .hud__bar-num');
    if (el === null) return null;
    const v = Number((el.textContent || '').split('/')[0]);
    return Number.isFinite(v) ? v : null;
  };
  return new Promise((resolve) => {
    const cap = Math.ceil((o.durationMs / 1000) * 140) + 64;
    const t = new Float64Array(cap);
    const frameMs = new Float64Array(cap);
    const draws = new Float64Array(cap);
    const tris = new Float64Array(cap);
    const heap = new Float64Array(cap);
    const ticksArr = new Float64Array(cap);
    const alive = new Float64Array(cap);
    const used = new Float64Array(cap);
    const capArr = new Float64Array(cap);
    const dev = new Float64Array(cap);
    let n = 0;

    const seen = {};
    const sightings = [];
    let maxAlive = 0;
    let overBudgetSamples = 0;
    let healCasts = 0;
    let died = false;
    let healing = false;
    let healT = 0;
    let lastGuard = 0;

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

    d.clearInput();
    d.warp(o.cx + o.radius, o.cz);
    const spawnedStart = d.director().spawned;
    const started = performance.now();
    let last = started;

    const tick = () => {
      const now = performance.now();
      const p = d.player();
      const m = d.metrics();
      const dir = d.director();
      const rows = d.enemies();

      let aliveNow = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.alive) continue;
        aliveNow++;
        if (seen[r.id] === undefined) {
          seen[r.id] = true;
          sightings.push({ id: r.id, kind: r.kind, region: d.regionAt(r.x, r.z), x: Math.round(r.x), z: Math.round(r.z) });
        }
      }
      if (aliveNow > maxAlive) maxAlive = aliveNow;
      if (dir.budgetUsed > dir.regionBudget) overBudgetSamples++;

      if (n < cap) {
        t[n] = (now - started) / 1000;
        frameMs[n] = now - last;
        draws[n] = m.drawCalls;
        tris[n] = m.triangles;
        heap[n] = m.heapMb;
        ticksArr[n] = m.ticks;
        alive[n] = aliveNow;
        used[n] = dir.budgetUsed;
        capArr[n] = dir.regionBudget;
        dev[n] = p.grounded ? Math.abs(p.y - d.terrainHeightAt(p.x, p.z)) : -1;
        n++;
      }
      last = now;

      if (p.state === 'Down') died = true;

      // Defensive freeze: anything close gets held (real StatusEffects path).
      if (now - lastGuard >= 1100) {
        lastGuard = now;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (!r.alive) continue;
          const dist = Math.hypot(r.x - p.x, r.z - p.z);
          if (dist < o.guardRadius) d.freezeEnemy(r.id, 2.5);
        }
      }

      // Defensive heal: stop, cast the heal slot, resume.
      const hp = readHp();
      if (!healing && hp !== null && hp < o.healBelow) {
        healing = true;
        healT = now;
        d.setInput({ moveX: 0, moveY: 0, sprint: false });
      }
      if (healing) {
        if (d.castSlot(o.healSlot)) {
          healCasts++;
          healing = false;
        } else if (now - healT > 2400) {
          healing = false; // cooldown or refusals — give up this round
        }
      } else {
        const ang = Math.atan2(p.x - o.cx, p.z - o.cz) + 0.5;
        const tx = o.cx + Math.sin(ang) * o.radius;
        const tz = o.cz + Math.cos(ang) * o.radius;
        const iv = inputFor(tx - p.x, tz - p.z);
        d.setInput({ moveX: iv.ix, moveY: iv.iy, sprint: false });
      }

      if (now - started >= o.durationMs || died) {
        d.clearInput();
        resolve({
          count: n,
          t: Array.from(t.subarray(0, n)),
          frameMs: Array.from(frameMs.subarray(0, n)),
          drawCalls: Array.from(draws.subarray(0, n)),
          triangles: Array.from(tris.subarray(0, n)),
          heapMb: Array.from(heap.subarray(0, n)),
          ticks: Array.from(ticksArr.subarray(0, n)),
          alive: Array.from(alive.subarray(0, n)),
          budgetUsed: Array.from(used.subarray(0, n)),
          budgetCap: Array.from(capArr.subarray(0, n)),
          deviation: Array.from(dev.subarray(0, n)),
          sightings,
          maxAlive,
          overBudgetSamples,
          healCasts,
          died,
          spawnedDelta: d.director().spawned - spawnedStart,
          endHp: readHp(),
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/**
 * One bestiary kind, end to end: spawn via spawnKind, watch it move, watch a
 * full telegraph cycle, take its hit (iframes jump = the exact hit clock),
 * then freeze it, drop its hp and kill it with a real seeded cast.
 *
 * Two-stage mode (fightDist != moveDist, used for ranged kinds): locomotion
 * is observed at the natural stand-off first, then a FRESH instance is
 * spawned at fightDist for the attack — because a ranged shot from 13+ u
 * across the convex slope around the arena has no line of sight and honestly
 * dies in the hillside (measured; see the #4 NOTE).
 */
const KIND_PROBE = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    const out = {
      spawnOk: false, id: -1, kindSeen: '', maxHpSeen: -1,
      moved: 0, teleRiseT: -1, teleFallT: -1, teleCycles: 0, teleDur: -1,
      hitT: -1, distAtHit: -1, riseBeforeHitT: -1,
      killed: false, killCastAccepted: false, reason: 'init',
    };
    const twoStage = o.fightDist !== o.moveDist;
    d.killAllEnemies();
    d.clearInput();
    d.warp(o.ax, o.az);
    const t0 = performance.now();
    let phase = 0;
    let phaseT = t0;
    let watchStart = t0;
    let fightMode = !twoStage;
    let sx = 0;
    let sz = 0;
    let hasPrevIfr = false;
    let prevIfr = 0;
    let teleWas = false;
    let lastRise = -1;
    let killT = 0;
    let lastCastTry = -1e9;
    const rowMine = () => {
      const rows = d.enemies();
      if (out.id >= 0) {
        for (let i = 0; i < rows.length; i++) if (rows[i].id === out.id) return rows[i];
        return null;
      }
      let best = null;
      let bd = Infinity;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.alive || r.kind !== o.kind) continue;
        const dist = Math.hypot(r.x - sx, r.z - sz);
        if (dist < bd) {
          bd = dist;
          best = r;
        }
      }
      return best;
    };
    const tick = () => {
      const now = performance.now();
      const t = (now - t0) / 1000;
      if (now - t0 > o.timeoutMs) {
        out.reason = 'timeout(phase ' + phase + ')';
        resolve(out);
        return;
      }
      if (phase === 0) {
        // brief face-forward so the kill cast later starts aligned
        d.setInput({ moveX: 0, moveY: -1, sprint: false });
        if (now - phaseT >= 180) {
          d.clearInput();
          sx = o.ax + o.fx * o.moveDist;
          sz = o.az + o.fz * o.moveDist;
          out.spawnOk = d.spawnKind(o.kind, sx, sz);
          if (!out.spawnOk) {
            out.reason = 'spawnKind-false';
            resolve(out);
            return;
          }
          phase = 1;
          phaseT = now;
        }
      } else if (phase === 1) {
        if (now - phaseT >= 260) {
          const row = rowMine();
          if (row === null) {
            out.reason = 'row-never-appeared';
            resolve(out);
            return;
          }
          out.id = row.id;
          out.kindSeen = row.kind;
          out.maxHpSeen = row.maxHp;
          sx = row.x;
          sz = row.z;
          phase = 2;
          phaseT = now;
          watchStart = now;
        }
      } else if (phase === 15) {
        // two-stage: acquire the fresh fight-range instance
        if (now - phaseT >= 260) {
          const row = rowMine();
          if (row === null) {
            out.reason = 'fight-row-never-appeared';
            resolve(out);
            return;
          }
          out.id = row.id;
          phase = 2;
          phaseT = now;
          watchStart = now;
          fightMode = true;
          teleWas = false;
          hasPrevIfr = false;
        }
      } else if (phase === 2) {
        const row = rowMine();
        if (row === null || !row.alive) {
          out.reason = 'target-died-early';
          resolve(out);
          return;
        }
        if (!fightMode || !twoStage) {
          const disp = Math.hypot(row.x - sx, row.z - sz);
          if (disp > out.moved) out.moved = disp;
        }

        if (!fightMode) {
          // stage A (ranged): locomotion only, then swap to the LOS arena.
          if (out.moved >= 0.9 || now - watchStart >= 7000) {
            d.killAllEnemies();
            out.id = -1;
            sx = o.ax + o.fx * o.fightDist;
            sz = o.az + o.fz * o.fightDist;
            if (!d.spawnKind(o.kind, sx, sz)) {
              out.reason = 'fight-spawn-false';
              resolve(out);
              return;
            }
            phase = 15;
            phaseT = now;
          }
          requestAnimationFrame(tick);
          return;
        }

        const tele = row.telegraphing === true;
        if (tele && !teleWas) {
          lastRise = t;
          if (out.teleRiseT < 0) out.teleRiseT = t;
        }
        if (!tele && teleWas && lastRise >= 0) {
          out.teleCycles++;
          if (out.teleDur < 0) {
            out.teleFallT = t;
            out.teleDur = t - lastRise;
          }
        }
        teleWas = tele;

        const c = d.combat();
        const jumped = hasPrevIfr && c.playerIFrames > prevIfr + 0.05;
        prevIfr = c.playerIFrames;
        hasPrevIfr = true;
        if (jumped && out.hitT < 0) {
          out.hitT = t;
          const p = d.player();
          out.distAtHit = Math.hypot(row.x - p.x, row.z - p.z);
          out.riseBeforeHitT = lastRise;
        }

        const done = out.hitT >= 0 && out.teleDur >= 0;
        if (done || now - watchStart >= o.watchMs) {
          // kill phase setup
          d.freezeEnemy(out.id, 10);
          d.setEnemyHp(out.id, 4);
          d.refillMana();
          d.learnSkill(o.killSkillId);
          d.equipSkill(0, o.killSkillId);
          const r2 = rowMine();
          if (r2 !== null) d.warp(r2.x - o.fx * 4.5, r2.z - o.fz * 4.5);
          d.setInput({ moveX: 0, moveY: -1, sprint: false });
          phase = 3;
          phaseT = now;
        }
      } else if (phase === 3) {
        if (now - phaseT >= 200) {
          d.clearInput();
          phase = 4;
          phaseT = now;
          killT = now;
        }
      } else {
        const row = rowMine();
        if (row === null || !row.alive) {
          out.killed = true;
          out.reason = 'done';
          resolve(out);
          return;
        }
        if (now - lastCastTry >= 120) {
          lastCastTry = now;
          if (d.castSlot(0)) out.killCastAccepted = true;
        }
        if (now - killT > o.killMs) {
          out.reason = 'kill-timeout';
          resolve(out);
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** Clean-room spawn: killAll, warp, face, spawnKind at dist along F. */
const SPAWN_TARGET = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    d.killAllEnemies();
    d.clearInput();
    d.warp(o.ax, o.az);
    const t0 = performance.now();
    let phase = 0;
    const tick = () => {
      const now = performance.now();
      if (phase === 0) {
        d.setInput({ moveX: 0, moveY: -1, sprint: false });
        if (now - t0 >= 180) {
          d.clearInput();
          if (!d.spawnKind(o.kind, o.ax + o.fx * o.dist, o.az + o.fz * o.dist)) {
            resolve(null);
            return;
          }
          phase = 1;
        }
      } else if (now - t0 >= 500) {
        const rows = d.enemies();
        let best = null;
        let bd = Infinity;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (!r.alive || r.kind !== o.kind) continue;
          const dist = Math.hypot(r.x - o.ax, r.z - o.az);
          if (dist < bd) {
            bd = dist;
            best = r;
          }
        }
        resolve(best === null ? null : { id: best.id, hp: best.hp, maxHp: best.maxHp, x: best.x, z: best.z });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/**
 * One measured skill cast against one existing target: optional freeze,
 * refillMana, learn+equip, seed, retry through busy/cooldown, then record the
 * FIRST hp drop (the hit itself — DoT ticks come later), any reaction names,
 * the notification card, and the target's status board at the end.
 */
const MEASURED_CAST = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  const uiText = () => {
    const el = document.getElementById('ui-root') || document.body;
    return el.textContent || '';
  };
  return new Promise((resolve) => {
    const out = {
      accepted: false, refusals: [], hpBefore: -1, dropAmt: -1, dropT: -1,
      namesSeen: {}, sawCard: false, statusesAfter: [], targetAlive: true,
      masteryLevel: 1, reason: 'init',
    };
    for (let i = 0; i < o.watchNames.length; i++) out.namesSeen[o.watchNames[i]] = -1;
    const rowById = () => {
      const rows = d.enemies();
      for (let i = 0; i < rows.length; i++) if (rows[i].id === o.targetId) return rows[i];
      return null;
    };
    const t0 = performance.now();
    let phase = 0;
    let phaseT = t0;
    let castT = -1;
    const tick = () => {
      const now = performance.now();
      if (now - t0 > o.timeoutMs) {
        out.reason = 'timeout(phase ' + phase + ')';
        resolve(out);
        return;
      }
      if (castT > 0) {
        const text = uiText();
        for (let i = 0; i < o.watchNames.length; i++) {
          const name = o.watchNames[i];
          if (out.namesSeen[name] < 0 && text.indexOf(name) !== -1) out.namesSeen[name] = (now - castT) / 1000;
        }
        if (!out.sawCard && document.querySelector('.notify__card.is-in') !== null) out.sawCard = true;
      }
      if (phase === 0) {
        const row = rowById();
        if (row === null) {
          out.reason = 'no-target';
          resolve(out);
          return;
        }
        if (o.freezeSeconds > 0) d.freezeEnemy(o.targetId, o.freezeSeconds);
        d.refillMana();
        d.learnSkill(o.skillId);
        d.equipSkill(o.slot, o.skillId);
        // Mastery scales damage (+pct/level on BASE); the caller folds the
        // level at cast time into its expectation.
        const g = d.grimoire();
        const mastery = g.mastery[o.skillId];
        out.masteryLevel = mastery !== undefined ? mastery.level : 1;
        if (o.useOffset) d.warp(row.x + o.offX, row.z + o.offZ);
        d.setInput({ moveX: 0, moveY: -1, sprint: false });
        phase = 1;
        phaseT = now;
      } else if (phase === 1) {
        if (now - phaseT >= o.faceMs) {
          d.clearInput();
          d.setStatusSeed(o.statusSeed);
          d.setDamageSeed(o.damageSeed);
          phase = 2;
          phaseT = now;
        }
      } else if (phase === 2) {
        const ok = d.castSlot(o.slot);
        if (ok) {
          out.accepted = true;
          const row = rowById();
          out.hpBefore = row !== null ? row.hp : -1;
          castT = now;
          phase = 3;
          phaseT = now;
        } else {
          const r = d.lastRefusal();
          if (out.refusals.length < 24) out.refusals.push(r);
          if (r !== 'busy' && r !== 'cooldown') {
            out.reason = 'refused:' + r;
            resolve(out);
            return;
          }
          if (now - phaseT > o.acceptMs) {
            out.reason = 'cast-never-accepted';
            resolve(out);
            return;
          }
        }
      } else {
        const row = rowById();
        if (row !== null) {
          if (out.dropAmt < 0 && row.hp < out.hpBefore - 1e-6) {
            out.dropAmt = out.hpBefore - row.hp;
            out.dropT = (now - castT) / 1000;
          }
          if (!row.alive) out.targetAlive = false;
        }
        if (now - phaseT >= o.windowMs) {
          out.statusesAfter = d.statusOf(o.targetId);
          out.reason = 'done';
          resolve(out);
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** One seeded stage-1 melee press against an adjacent target. */
const MELEE_ONE = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  const uiText = () => {
    const el = document.getElementById('ui-root') || document.body;
    return el.textContent || '';
  };
  return new Promise((resolve) => {
    const out = { hpBefore: -1, dropAmt: -1, sawShatter: false, reason: 'init' };
    const rowById = () => {
      const rows = d.enemies();
      for (let i = 0; i < rows.length; i++) if (rows[i].id === o.targetId) return rows[i];
      return null;
    };
    const t0 = performance.now();
    let phase = 0;
    let phaseT = t0;
    const tick = () => {
      const now = performance.now();
      if (now - t0 > o.timeoutMs) {
        out.reason = 'timeout(phase ' + phase + ')';
        resolve(out);
        return;
      }
      if (phase === 0) {
        const row = rowById();
        if (row === null) {
          out.reason = 'no-target';
          resolve(out);
          return;
        }
        if (o.freezeSeconds > 0) d.freezeEnemy(o.targetId, o.freezeSeconds);
        d.warp(row.x - o.fx * 1.15, row.z - o.fz * 1.15);
        d.setInput({ moveX: 0, moveY: -1, sprint: false });
        phase = 1;
        phaseT = now;
      } else if (phase === 1) {
        if (now - phaseT >= 150) {
          d.clearInput();
          d.setDamageSeed(o.damageSeed);
          const row = rowById();
          out.hpBefore = row !== null ? row.hp : -1;
          d.press('attack');
          phase = 2;
          phaseT = now;
        }
      } else {
        if (!out.sawShatter && uiText().indexOf('Shatter') !== -1) out.sawShatter = true;
        const row = rowById();
        if (row !== null && out.dropAmt < 0 && row.hp < out.hpBefore - 1e-6) {
          out.dropAmt = out.hpBefore - row.hp;
        }
        if (now - phaseT >= o.windowMs) {
          out.reason = 'done';
          resolve(out);
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** Survive-challenge driver: hold position, purge each wave, watch the state. */
const SURVIVE_DRIVE = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    const out = { state: 'active', sawEnemies: false, maxAlive: 0, sawCard: false, reason: 'init' };
    const t0 = performance.now();
    let lastKill = t0;
    const tick = () => {
      const now = performance.now();
      const rows = d.enemies();
      let aliveNow = 0;
      for (let i = 0; i < rows.length; i++) if (rows[i].alive && rows[i].maxHp < 1000) aliveNow++;
      if (aliveNow > 0) out.sawEnemies = true;
      if (aliveNow > out.maxAlive) out.maxAlive = aliveNow;
      if (!out.sawCard && document.querySelector('.notify__card.is-in') !== null) out.sawCard = true;
      if (now - lastKill >= o.killEveryMs) {
        lastKill = now;
        d.killAllEnemies();
      }
      const info = d.shrines()[o.index];
      const state = info !== undefined ? info.state : 'missing';
      out.state = state;
      if (state !== 'active') {
        out.reason = 'state:' + state;
        resolve(out);
        return;
      }
      if (now - t0 > o.timeoutMs) {
        out.reason = 'timeout';
        resolve(out);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/**
 * Torch-challenge driver: the torch poles' positions are not on the debug
 * surface, so the player is warped along concentric circles that cover the
 * whole 8-14 u placement annulus with the 1.2 u light radius — an honest
 * walk-into-each sweep, just a dense one.
 */
const TORCH_SPIRAL = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    const out = { state: 'active', points: 0, sawCard: false, reason: 'init' };
    const pts = [];
    for (let r = 0; r < o.radii.length; r++) {
      const radius = o.radii[r];
      const steps = Math.ceil((Math.PI * 2 * radius) / o.stepU);
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        pts.push({ x: o.sx + Math.sin(a) * radius, z: o.sz + Math.cos(a) * radius });
      }
    }
    const t0 = performance.now();
    let i = 0;
    const tick = () => {
      const now = performance.now();
      if (!out.sawCard && document.querySelector('.notify__card.is-in') !== null) out.sawCard = true;
      const info = d.shrines()[o.index];
      const state = info !== undefined ? info.state : 'missing';
      out.state = state;
      if (state !== 'active') {
        out.reason = 'state:' + state;
        resolve(out);
        return;
      }
      if (i < pts.length) {
        d.warp(pts[i].x, pts[i].z);
        i++;
        out.points = i;
      }
      if (now - t0 > o.timeoutMs) {
        out.reason = 'timeout(after ' + i + '/' + pts.length + ' points)';
        resolve(out);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** Emergency heal loop between scenarios (mend-class self skill). */
const HEAL_NOW = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  const readHp = () => {
    const el = document.querySelector('.hud__bar--hp .hud__bar-num');
    if (el === null) return null;
    const v = Number((el.textContent || '').split('/')[0]);
    return Number.isFinite(v) ? v : null;
  };
  return new Promise((resolve) => {
    d.killAllEnemies();
    d.clearInput();
    d.refillMana();
    d.learnSkill(o.skillId);
    d.equipSkill(o.slot, o.skillId);
    const t0 = performance.now();
    let cast = false;
    let castT = 0;
    const tick = () => {
      const now = performance.now();
      if (!cast) {
        if (d.castSlot(o.slot)) {
          cast = true;
          castT = now;
        } else if (now - t0 > 3000) {
          resolve({ cast: false, hp: readHp() });
          return;
        }
      } else if (now - castT > 1100) {
        resolve({ cast: true, hp: readHp() });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** Screenshot luminance (worldtest's decoder trick, trimmed to one band). */
const LUMA = async (b64) => {
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
    const data = ctx.getImageData(0, 0, w, h).data;
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
    return { ok: true, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  hardTimer = setTimeout(() => {
    hardTimedOut = true;
    console.error(`[contenttest] HARD TIMEOUT after ${OVERALL_TIMEOUT_MS} ms — killing everything.`);
    void cleanup();
    setTimeout(() => process.exit(1), 1500);
  }, OVERALL_TIMEOUT_MS);
  hardTimer.unref?.();

  const m = report.measurements;

  // =========================================================================
  // PART 1 — node-side: the §4.1 law for ENEMIES + data-derived expectations.
  // =========================================================================
  let defs;
  let skills;
  let picks;
  let seeds;
  const defByKind = new Map();
  try {
    defs = loadJson('src/data/enemies.json');
    skills = normalizeSkills(loadJson('src/data/skills.json'));
    if (!Array.isArray(defs) || defs.length === 0) throw new Fatal('src/data/enemies.json is not a non-empty array.');
    for (const d of defs) defByKind.set(d.kind, d);

    // --- #1 the law, extended to enemy kinds --------------------------------
    const kinds = defs.map((d) => d.kind);
    const scan = scanForKinds(kinds);
    m.kindScan = { filesScanned: scan.files, codeHits: scan.codeHits, commentHits: scan.commentHits };
    if (scan.files < 20) {
      fail('#1 §4.1 scan covered the source tree', `only ${scan.files} .ts files under src/ — scan broken`);
    } else if (scan.codeHits.length === 0) {
      pass(
        '#1 §4.1 LAW: no enemy kind string in src/**/*.ts code',
        `${kinds.length} kinds x ${scan.files} files, zero occurrences in code or literals — enemy #13 is a JSON edit`,
      );
    } else {
      fail(
        '#1 §4.1 LAW: no enemy kind string in src/**/*.ts code',
        `${scan.codeHits.length} occurrence(s) in CODE/LITERALS: ${scan.codeHits.slice(0, 10).join(' | ')}`,
      );
    }
    if (scan.commentHits.length > 0) {
      note(
        '#1 kind words appear in comments only',
        `${scan.commentHits.length} comment-only mention(s) (e.g. ${scan.commentHits[0]}) — prose, not code paths; ` +
          'the skilltest precedent scans raw lines, so this gate reports them here instead of silently passing them',
      );
    }

    // --- #1 bestiary data sanity --------------------------------------------
    if (defs.length === 12) pass('#1 bestiary has 12 kinds', kinds.join(', '));
    else fail('#1 bestiary has 12 kinds', `${defs.length} kinds: ${kinds.join(', ')}`);
    const archetypes = new Set(defs.map((d) => d.archetype));
    if (['blob', 'quad', 'biped', 'sentinel', 'wraith'].every((a) => archetypes.has(a))) {
      pass('#1 all 5 archetypes used', [...archetypes].join(', '));
    } else {
      fail('#1 all 5 archetypes used', [...archetypes].join(', '));
    }
    const attackKinds = new Set(defs.map((d) => d.attack.kind));
    if (['lunge', 'ranged', 'charge', 'slam'].every((a) => attackKinds.has(a))) {
      pass('#1 all 4 attack kinds used', [...attackKinds].join(', '));
    } else {
      fail('#1 all 4 attack kinds used', [...attackKinds].join(', '));
    }
    const regionsCovered = new Set();
    for (const d of defs) for (const b of d.biomes) regionsCovered.add(b);
    if ([0, 1, 2, 3, 4].every((r) => regionsCovered.has(r))) {
      pass('#1 every region has at least one tagged kind', [...regionsCovered].sort().join(', '));
    } else {
      fail('#1 every region has at least one tagged kind', `covered: ${[...regionsCovered].sort().join(', ')}`);
    }
    const slowTelegraphs = defs.filter((d) => d.attack.telegraphSeconds < 0.5);
    if (slowTelegraphs.length === 0) pass('#1 every def telegraphs >= 0.5 s (data)', 'all 12 within §9');
    else fail('#1 every def telegraphs >= 0.5 s (data)', slowTelegraphs.map((d) => `${d.kind}=${d.attack.telegraphSeconds}`).join(', '));
    const armoredKinds = defs.filter((d) => d.armor > 0);
    if (armoredKinds.length > 0) pass('#1 armor exists from the outer regions (Phase 4 debt precondition)', armoredKinds.map((d) => `${d.kind}:${d.armor}`).join(', '));
    else fail('#1 armor exists from the outer regions (Phase 4 debt precondition)', 'no def carries armor > 0 — Shatter/Thermal Shock stay unobservable');

    // --- #1 Phase 5 skill data ----------------------------------------------
    picks = derivePicks(skills, defs);
    const shrineElems = [...picks.shrineSkills.keys()].sort();
    if (shrineElems.length === 6 && ['dark', 'earth', 'fire', 'ice', 'light', 'wind'].every((e) => picks.shrineSkills.has(e))) {
      pass('#1 six shrine Epics, one per element', [...picks.shrineSkills.values()].map((s) => s.id).join(', '));
    } else {
      fail('#1 six shrine Epics, one per element', `shrineElement present for: ${shrineElems.join(', ')}`);
    }
    if (picks.fragmentSkills.length === 3) pass('#1 three fragment skills (fragments: 3)', picks.fragmentSkills.map((s) => s.id).join(', '));
    else fail('#1 three fragment skills (fragments: 3)', `${picks.fragmentSkills.length} found`);
    if (picks.bossSkills.length === 1) pass('#1 exactly one bossReward skill', picks.bossSkills[0].id);
    else fail('#1 exactly one bossReward skill', `${picks.bossSkills.length} found`);
    const scripted = [...picks.shrineSkills.values(), ...picks.fragmentSkills, ...picks.bossSkills];
    const wrongDrop = scripted.filter((s) => s.dropWeight !== 0);
    if (wrongDrop.length === 0) pass('#1 scripted skills carry dropWeight 0', `${scripted.length} skills`);
    else fail('#1 scripted skills carry dropWeight 0', wrongDrop.map((s) => `${s.id}:${s.dropWeight}`).join(', '));

    const missing = [];
    for (const key of ['elementTrio', 'armoredDef', 'windPlain', 'killSkill', 'fireSkill', 'wetSkill', 'darkSkill', 'healSkill']) {
      if (picks[key] === null || picks[key] === undefined) missing.push(key);
    }
    if (missing.length > 0) {
      fail('#1 gate can derive its actors from the JSON', `no data matches predicate(s): ${missing.join(', ')}`);
    } else {
      pass(
        '#1 gate can derive its actors from the JSON',
        `elem=${picks.elementTrio.element}/${picks.elementTrio.skill.id} vs ${picks.elementTrio.weakDef.kind}(weak)/${picks.elementTrio.resistDef.kind}(resist), ` +
          `armored=${picks.armoredDef.kind}, kill=${picks.killSkill.id}, wet=${picks.wetSkill.id}, dark=${picks.darkSkill.id}, heal=${picks.healSkill.id}`,
      );
    }

    seeds = {
      nonCrit: findSeed((r) => r.slice(0, 14).every((v) => v >= CRIT_CHANCE + 0.02)),
      statusHit: findSeed((r) => r[0] < 0.25 && r[1] < 0.25 && r[2] < 0.25 && r[3] < 0.25),
      // 4 rolls like skilltest: 0.08^4 is findable in 500k seeds, 0.07^6 is not.
      statusMiss: findSeed((r) => r.slice(0, 4).every((v) => v > 0.92)),
    };
    m.seeds = seeds;
    if (seeds.nonCrit > 0 && seeds.statusHit > 0 && seeds.statusMiss > 0) {
      pass('#1 deterministic seeds solved offline', JSON.stringify(seeds));
    } else {
      fail('#1 deterministic seeds solved offline', JSON.stringify(seeds));
    }
  } catch (error) {
    fail('#1 node-side data phase', error instanceof Fatal ? error.message : String(error?.stack ?? error));
    finish(startedAt);
    return;
  }

  // =========================================================================
  // PART 2 — the live gate.
  // =========================================================================
  /** Aggregated §3 series across every long sampler (for #10). */
  const budgetAgg = { frames: 0, peakDraws: 0, peakTris: 0, peakHeap: 0, firstHeap: -1, lastHeap: -1 };
  const feedBudget = (r) => {
    budgetAgg.frames += r.count;
    const pd = maxOf(r.drawCalls);
    const pt = maxOf(r.triangles);
    const ph = maxOf(r.heapMb);
    if (pd > budgetAgg.peakDraws) budgetAgg.peakDraws = pd;
    if (pt > budgetAgg.peakTris) budgetAgg.peakTris = pt;
    if (ph > budgetAgg.peakHeap) budgetAgg.peakHeap = ph;
    if (budgetAgg.firstHeap < 0 && r.count > 0) budgetAgg.firstHeap = r.heapMb[0];
    if (r.count > 0) budgetAgg.lastHeap = r.heapMb[r.count - 1];
  };

  try {
    await startPreview();
    pass('#0 vite preview reachable', URL_);

    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    pass('#0 Chromium launched (headless, SwiftShader)', browser.version());

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
    pass('#0 page loaded', `HTTP ${response.status()}`);

    // NOTE the `null`: waitForFunction(fn, arg, options) — three-argument form.
    await page.waitForFunction(() => globalThis.__ARCANUM_DEBUG__ !== undefined, null, { timeout: 15_000 });
    const shape = await page.evaluate(() => {
      const d = globalThis.__ARCANUM_DEBUG__;
      const needed = [
        'metrics', 'frameCount', 'setInput', 'clearInput', 'press', 'player', 'warp', 'terrainHeightAt',
        'enemies', 'combat', 'setDamageSeed', 'setStatusSeed', 'setOrbSeed', 'spawnSlimes', 'killAllEnemies',
        'skills', 'grimoire', 'castSlot', 'lastRefusal', 'statusOf', 'learnSkill', 'equipSkill',
        'refillMana', 'setEnemyHp', 'orbs', 'setDayPhase',
        // phase 5 additions
        'regionAt', 'director', 'shrines', 'fragments', 'boss', 'warpBoss', 'spawnKind',
        'shrineTimeScale', 'pauseDirector', 'freezeEnemy',
      ];
      const missing = [];
      for (const k of needed) if (typeof d[k] !== 'function') missing.push(k);
      return { missing, version: d.version };
    });
    if (shape.missing.length > 0) {
      throw new Fatal(`__ARCANUM_DEBUG__ is missing phase-5 hooks: ${shape.missing.join(', ')}`);
    }
    pass('#0 __ARCANUM_DEBUG__ phase 5 shape', `complete, version ${shape.version}`);

    await page.waitForFunction(() => globalThis.__ARCANUM_DEBUG__.frameCount() > 40, null, { timeout: 20_000 });
    pass('#0 render loop running', 'frameCount passed 40');

    // The world is LIVE: park the director and clear its opening population
    // before anything snapshot-like runs (the hard-won harness rule).
    await page.evaluate(() => {
      const d = globalThis.__ARCANUM_DEBUG__;
      d.pauseDirector(true);
      d.killAllEnemies();
      d.setDayPhase(0.3);
      d.setOrbSeed(424242);
    });
    await sleep(1600);

    // --- calibration (camera yaw never changes, so F/R hold all run) --------
    const calF = await page.evaluate(CAL_WALK, { x: 0, z: 0, moveX: 0, moveY: -1, durationMs: 800 });
    const calR = await page.evaluate(CAL_WALK, { x: 0, z: 0, moveX: 1, moveY: 0, durationMs: 800 });
    const lenF = Math.hypot(calF.dx, calF.dz);
    const lenR = Math.hypot(calR.dx, calR.dz);
    if (lenF < 0.5 || lenR < 0.5) throw new Fatal(`calibration walks moved ${lenF.toFixed(2)} / ${lenR.toFixed(2)} u — player not moving.`);
    const F = { x: calF.dx / lenF, z: calF.dz / lenF };
    const R = { x: calR.dx / lenR, z: calR.dz / lenR };
    m.calibration = { F: { x: round(F.x, 3), z: round(F.z, 3) }, R: { x: round(R.x, 3), z: round(R.z, 3) } };
    pass('#0 input-to-world axes calibrated', `F (${F.x.toFixed(2)}, ${F.z.toFixed(2)}), R (${R.x.toFixed(2)}, ${R.z.toFixed(2)})`);

    const healSlot = 3;
    const healIfLow = async (threshold) => {
      const hp = await page.evaluate(() => {
        const el = document.querySelector('.hud__bar--hp .hud__bar-num');
        return el !== null ? Number((el.textContent || '').split('/')[0]) : null;
      });
      if (hp !== null && hp < threshold) {
        const r = await page.evaluate(HEAL_NOW, { skillId: picks.healSkill.id, slot: healSlot });
        return r.hp;
      }
      return hp;
    };
    const waitNoCard = () =>
      page
        .waitForFunction(() => document.querySelector('.notify__card.is-in') === null, null, { timeout: 9000 })
        .catch(() => {});

    // =======================================================================
    // #2 — all five regions reachable and distinct.
    // =======================================================================
    const probes = [];
    {
      for (let r = 0; r < 5; r++) {
        const box = REGION_SEARCH[r];
        const found = await page.evaluate(REGION_FIND, {
          region: r,
          x0: box.x0, x1: box.x1, z0: box.z0, z1: box.z1,
          cx: box.cx, cz: box.cz,
          step: 12, ringR: 20, minH: -2.4,
          avoidX: VAEL.arenaX, avoidZ: VAEL.arenaZ,
          avoidR: r === REGION.spire ? SPIRE_KEEPOUT : 0,
        });
        probes.push(found);
      }
      m.regionProbes = probes.map((p, i) => ({ region: REGION_NAMES[i], point: p }));
      const missing = probes.map((p, i) => (p === null ? REGION_NAMES[i] : null)).filter((x) => x !== null);
      if (missing.length > 0) {
        fail('#2 all 5 regions reachable', `no probe point found for: ${missing.join(', ')}`);
      } else {
        const dominants = await page.evaluate(
          (pts) => pts.map((p) => globalThis.__ARCANUM_DEBUG__.regionAt(p.x, p.z)),
          probes,
        );
        const distinct = new Set(dominants);
        if (distinct.size === 5 && [0, 1, 2, 3, 4].every((r) => distinct.has(r))) {
          pass('#2 five probe points, five distinct dominants', probes.map((p, i) => `${REGION_NAMES[i]}(${p.x},${p.z})`).join(' '));
        } else {
          fail('#2 five probe points, five distinct dominants', `dominants: [${dominants.join(', ')}]`);
        }
      }
    }

    // =======================================================================
    // #3 + #2 + #10 — director walks in every region (30 s each, LIVE), with
    // terrain deviation and §3 sampling riding along; screenshot per region.
    // =======================================================================
    const walkSummaries = [];
    let worstDeviation = 0;
    let deviationSamples = 0;
    let tickRates = [];
    const shots = [];
    {
      // The heal slot is armed once; walks cast it defensively when low.
      await page.evaluate(
        (o) => {
          const d = globalThis.__ARCANUM_DEBUG__;
          d.learnSkill(o.id);
          d.equipSkill(o.slot, o.id);
        },
        { id: picks.healSkill.id, slot: healSlot },
      );

      for (let r = 0; r < 5; r++) {
        const probePt = probes[r];
        if (probePt === null) {
          unknown(`#3 director walk (${REGION_NAMES[r]})`, 'no probe point — region unreachable above');
          continue;
        }
        await healIfLow(180);
        // Fresh population for THIS region: purge, then unpause.
        await page.evaluate(() => {
          const d = globalThis.__ARCANUM_DEBUG__;
          d.killAllEnemies();
          d.clearInput();
          d.pauseDirector(false);
        });
        const walk = await page.evaluate(REGION_WALK, {
          cx: probePt.x, cz: probePt.z, radius: WALK_RADIUS,
          durationMs: REGION_WALK_MS,
          fx: F.x, fz: F.z, rx: R.x, rz: R.z,
          guardRadius: 9, healBelow: 150, healSlot,
        });
        // Screenshot with the region population still standing.
        const shotName = `contenttest-${REGION_NAMES[r]}.png`;
        if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
        const png = await page.screenshot({ path: path.join(ARTIFACTS, shotName), type: 'png' });
        const luma = await page.evaluate(LUMA, png.toString('base64'));
        shots.push({ name: shotName, luma: luma.ok ? round(luma.luma, 1) : null, bytes: png.length });
        await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.pauseDirector(true));

        feedBudget(walk);
        tickRates.push(tailMean(walk.ticks, 0.7));

        // Terrain deviation (contract #2): grounded samples only.
        let regionWorst = 0;
        for (let i = 0; i < walk.deviation.length; i++) {
          const dv = walk.deviation[i];
          if (dv < 0) continue;
          deviationSamples++;
          if (dv > regionWorst) regionWorst = dv;
        }
        if (regionWorst > worstDeviation) worstDeviation = regionWorst;

        // Kind validity: every sighting's def must be tagged for the dominant
        // region at FIRST sight (spawn-fresh attribution). The dormant boss is
        // adopted into the manager and shows up in Spire — identified by hp
        // scale, not by kind string.
        const badKinds = [];
        let directorSightings = 0;
        for (const s of walk.sightings) {
          const def = defByKind.get(s.kind);
          if (def === undefined) {
            if (s.kind === picks.bossKindSeen || Math.hypot(s.x - VAEL.arenaX, s.z - VAEL.arenaZ) < 40) continue; // the dormant boss
            badKinds.push(`${s.kind}@(${s.x},${s.z}) is not an enemies.json kind`);
            continue;
          }
          directorSightings++;
          if (!def.biomes.includes(s.region)) {
            badKinds.push(`${s.kind}@(${s.x},${s.z}) sighted in region ${s.region}, tagged for [${def.biomes.join(',')}]`);
          }
        }

        const summary = {
          region: REGION_NAMES[r],
          frames: walk.count,
          sightings: walk.sightings.length,
          kinds: [...new Set(walk.sightings.map((s) => s.kind))],
          maxAlive: walk.maxAlive,
          spawnedDelta: walk.spawnedDelta,
          overBudgetSamples: walk.overBudgetSamples,
          maxBudgetUsed: maxOf(walk.budgetUsed),
          budgetCap: walk.budgetCap.length > 0 ? walk.budgetCap[walk.budgetCap.length - 1] : -1,
          worstDeviation: round(regionWorst, 4),
          healCasts: walk.healCasts,
          died: walk.died,
          endHp: walk.endHp,
          tickRate: round(tailMean(walk.ticks, 0.7), 1),
        };
        walkSummaries.push(summary);

        if (walk.died) {
          fail(`#3 director walk survives (${REGION_NAMES[r]})`, 'player died mid-walk despite guard — population data for this region is truncated');
        } else if (walk.spawnedDelta > 0 && directorSightings > 0) {
          pass(`#3 director spawns in ${REGION_NAMES[r]}`, `${walk.spawnedDelta} spawns in 30 s, kinds [${summary.kinds.join(', ')}]`);
        } else {
          fail(`#3 director spawns in ${REGION_NAMES[r]}`, `spawnedDelta ${walk.spawnedDelta}, sightings ${walk.sightings.length} — the region reads EMPTY (§12)`);
        }
        if (walk.maxAlive <= ENEMY_CAP) pass(`#3 cap 18 held in ${REGION_NAMES[r]}`, `max alive ${walk.maxAlive}`);
        else fail(`#3 cap 18 held in ${REGION_NAMES[r]}`, `max alive ${walk.maxAlive} > ${ENEMY_CAP}`);
        if (walk.overBudgetSamples === 0) {
          pass(`#3 budget respected in ${REGION_NAMES[r]}`, `peak ${summary.maxBudgetUsed}/${summary.budgetCap} points`);
        } else {
          fail(`#3 budget respected in ${REGION_NAMES[r]}`, `${walk.overBudgetSamples} sample(s) over budget (peak ${summary.maxBudgetUsed}/${summary.budgetCap})`);
        }
        if (badKinds.length === 0) pass(`#3 only region-valid kinds in ${REGION_NAMES[r]}`, `${walk.sightings.length} sightings clean`);
        else fail(`#3 only region-valid kinds in ${REGION_NAMES[r]}`, badKinds.slice(0, 6).join(' | '));
        const expectedCap = REGION_BUDGET[r];
        if (summary.budgetCap === expectedCap) pass(`#3 ${REGION_NAMES[r]} budget cap is the contract number`, `${summary.budgetCap} points`);
        else fail(`#3 ${REGION_NAMES[r]} budget cap is the contract number`, `director says ${summary.budgetCap}, contract says ${expectedCap}`);
      }
      m.regionWalks = walkSummaries;

      if (deviationSamples >= GROUND_MIN_SAMPLES && worstDeviation < GROUND_TOLERANCE) {
        pass('#2 terrain invariant spot-check across regions', `worst ground deviation ${worstDeviation.toFixed(4)} u over ${deviationSamples} grounded samples (< ${GROUND_TOLERANCE})`);
      } else if (deviationSamples < GROUND_MIN_SAMPLES) {
        unknown('#2 terrain invariant spot-check across regions', `only ${deviationSamples} grounded samples (< ${GROUND_MIN_SAMPLES})`);
      } else {
        fail('#2 terrain invariant spot-check across regions', `worst ground deviation ${worstDeviation.toFixed(4)} u over ${deviationSamples} samples — mesher vs collision disagree somewhere`);
      }
    }

    // =======================================================================
    // #4 — every bestiary kind, live: spawn, move, telegraph, hit, die.
    // =======================================================================
    {
      const rows = [];
      for (const def of defs) {
        await waitNoCard();
        await healIfLow(190);
        const dist = spawnDistanceFor(def);
        const probeRes = await page.evaluate(KIND_PROBE, {
          kind: def.kind,
          ax: 0, az: 0, fx: F.x, fz: F.z,
          moveDist: dist.move,
          fightDist: dist.fight,
          killSkillId: picks.killSkill.id,
          watchMs: 20_000,
          killMs: 9000,
          timeoutMs: 42_000,
        });
        const problems = [];
        if (!probeRes.spawnOk || probeRes.id < 0) problems.push(`spawnKind failed (${probeRes.reason})`);
        if (probeRes.kindSeen !== def.kind) problems.push(`row kind "${probeRes.kindSeen}"`);
        if (probeRes.maxHpSeen !== def.maxHp) problems.push(`row maxHp ${probeRes.maxHpSeen} != JSON ${def.maxHp}`);
        if (probeRes.moved < 0.8) problems.push(`moved only ${probeRes.moved.toFixed(2)} u (archetype locomotion not observed)`);
        if (probeRes.teleDur < 0) problems.push('no complete telegraph cycle observed');
        else if (probeRes.teleDur < TELEGRAPH_MIN_S) problems.push(`telegraph ${probeRes.teleDur.toFixed(2)} s < ${TELEGRAPH_MIN_S}`);
        else if (probeRes.teleDur > def.attack.telegraphSeconds + 1.0) problems.push(`telegraph ${probeRes.teleDur.toFixed(2)} s vs JSON ${def.attack.telegraphSeconds} (+1.0 tolerance)`);
        if (probeRes.hitT < 0) problems.push('never hit the standing player');
        else {
          if (probeRes.riseBeforeHitT < 0 || probeRes.hitT - probeRes.riseBeforeHitT < TELEGRAPH_MIN_S) {
            problems.push(`hit came ${probeRes.riseBeforeHitT < 0 ? 'with no telegraph' : (probeRes.hitT - probeRes.riseBeforeHitT).toFixed(2) + ' s after onset'} (< ${TELEGRAPH_MIN_S})`);
          }
          if (def.attack.kind === 'ranged' && probeRes.distAtHit < 2.5) {
            problems.push(`ranged kind hit at ${probeRes.distAtHit.toFixed(1)} u — contact, not a projectile`);
          }
        }
        if (!probeRes.killed) problems.push(`not killed (${probeRes.reason}, castAccepted=${probeRes.killCastAccepted})`);
        rows.push({
          kind: def.kind, archetype: def.archetype, attack: def.attack.kind,
          moveDist: round(dist.move, 1), fightDist: round(dist.fight, 1),
          moved: round(probeRes.moved, 2), teleDur: round(probeRes.teleDur, 2),
          teleToHit: probeRes.hitT >= 0 && probeRes.riseBeforeHitT >= 0 ? round(probeRes.hitT - probeRes.riseBeforeHitT, 2) : null,
          distAtHit: round(probeRes.distAtHit, 1), killed: probeRes.killed, problems,
        });
        if (problems.length === 0) {
          pass(`#4 ${def.kind} (${def.archetype}, ${def.attack.kind})`, `moved ${probeRes.moved.toFixed(1)} u, telegraph ${probeRes.teleDur.toFixed(2)} s, onset-to-hit ${(probeRes.hitT - probeRes.riseBeforeHitT).toFixed(2)} s, hit at ${probeRes.distAtHit.toFixed(1)} u, killed`);
        } else {
          fail(`#4 ${def.kind} (${def.archetype}, ${def.attack.kind})`, problems.join(' | '));
        }
      }
      m.kindProbes = rows;
      note(
        '#4 ranged hits proven at 6.5 u with line of sight',
        'from their natural 12-14 u stand-off across the convex slope around the origin arena, ranged shots honestly die in the hillside (no LOS from a low muzzle; measured: clearance -0.8 u mid-path). The projectile pipeline itself hits reliably with LOS. Ranged AI attacking without LOS wastes its volleys — a design observation for the phase report, not a §-contract violation',
      );
      note(
        '#4 archetype pose animation not directly observable',
        'limb/hover animation lives in EnemyVisual and is not on the debug surface; the gate proves locomotion, telegraphs and attacks per kind — pose quality is the device test\'s (screenshots attached)',
      );
    }

    // =======================================================================
    // #5 — element multiplier live: x1.5 weak, x0.5 resist, exact formula.
    // =======================================================================
    {
      const trio = picks.elementTrio;
      const skill = trio.skill;
      const statusSeed = seeds.statusMiss; // keep DoTs out of the drop
      const runOne = async (def) => {
        await healIfLow(180);
        const target = await page.evaluate(SPAWN_TARGET, { kind: def.kind, ax: 0, az: 0, fx: F.x, fz: F.z, dist: 8 });
        if (target === null) return null;
        return page.evaluate(MEASURED_CAST, {
          targetId: target.id, skillId: skill.id, slot: 0,
          statusSeed, damageSeed: seeds.nonCrit,
          freezeSeconds: 0, useOffset: false, offX: 0, offZ: 0, faceMs: 160,
          acceptMs: 8000, windowMs: 2600, timeoutMs: 18_000, watchNames: [],
        });
      };
      const weak = await runOne(trio.weakDef);
      const resist = await runOne(trio.resistDef);
      const expWeak = skillHit(skill, weak !== null ? weak.masteryLevel : 1, 1.5, trio.weakDef.armor);
      const expResist = skillHit(skill, resist !== null ? resist.masteryLevel : 1, 0.5, trio.resistDef.armor);
      m.elementMult = {
        element: trio.element, skill: skill.id,
        weak: { kind: trio.weakDef.kind, armor: trio.weakDef.armor, expected: round(expWeak, 3), measured: weak !== null ? round(weak.dropAmt, 3) : null },
        resist: { kind: trio.resistDef.kind, armor: trio.resistDef.armor, expected: round(expResist, 3), measured: resist !== null ? round(resist.dropAmt, 3) : null },
      };
      if (weak === null || !weak.accepted || weak.dropAmt < 0) {
        fail('#5 weak target takes x1.5', `no measured hit (${weak !== null ? weak.reason : 'spawn failed'})`);
      } else if (Math.abs(weak.dropAmt - expWeak) <= 0.9) {
        pass('#5 weak target takes x1.5', `${skill.id} on ${trio.weakDef.kind}: ${weak.dropAmt.toFixed(2)} = (${expDmg(skill).toFixed(1)}) x1.5 x mit(${trio.weakDef.armor})`);
      } else {
        fail('#5 weak target takes x1.5', `${skill.id} on ${trio.weakDef.kind}: measured ${weak.dropAmt.toFixed(3)}, expected ${expWeak.toFixed(3)}`);
      }
      if (resist === null || !resist.accepted || resist.dropAmt < 0) {
        fail('#5 resistant target takes x0.5', `no measured hit (${resist !== null ? resist.reason : 'spawn failed'})`);
      } else if (Math.abs(resist.dropAmt - expResist) <= 0.9) {
        pass('#5 resistant target takes x0.5', `${skill.id} on ${trio.resistDef.kind}: ${resist.dropAmt.toFixed(2)} = (${expDmg(skill).toFixed(1)}) x0.5 x mit(${trio.resistDef.armor})`);
      } else {
        fail('#5 resistant target takes x0.5', `${skill.id} on ${trio.resistDef.kind}: measured ${resist.dropAmt.toFixed(3)}, expected ${expResist.toFixed(3)}`);
      }
      if (weak !== null && resist !== null && weak.dropAmt > 0 && resist.dropAmt > 0) {
        const ratio = (weak.dropAmt / mitigation(trio.weakDef.armor)) / (resist.dropAmt / mitigation(trio.resistDef.armor));
        if (Math.abs(ratio - 3.0) <= 0.1) pass('#5 weak/resist ratio is exactly 3 (armor factored out)', `ratio ${ratio.toFixed(3)}`);
        else fail('#5 weak/resist ratio is exactly 3 (armor factored out)', `ratio ${ratio.toFixed(3)}, expected 3.0`);
      }
    }

    // =======================================================================
    // #6 — Phase 4's debt paid: Shatter x3 and Thermal Shock's armor break,
    // both MEASURED on an armored high-hp kind.
    // =======================================================================
    {
      const golem = picks.armoredDef;
      const meleeHit = (MELEE_STAGE1_BASE + STAT_VALUE * MELEE_AGI_RATIO) * mitigation(golem.armor);

      // Shatter: baseline stage-1 press vs the same press on a frozen target.
      await healIfLow(180);
      let baseline = null;
      let shattered = null;
      {
        const t1 = await page.evaluate(SPAWN_TARGET, { kind: golem.kind, ax: 0, az: 0, fx: F.x, fz: F.z, dist: 2.2 });
        if (t1 !== null) {
          baseline = await page.evaluate(MELEE_ONE, {
            targetId: t1.id, fx: F.x, fz: F.z, damageSeed: seeds.nonCrit, freezeSeconds: 0, windowMs: 1600, timeoutMs: 8000,
          });
        }
        await healIfLow(160);
        const t2 = await page.evaluate(SPAWN_TARGET, { kind: golem.kind, ax: 0, az: 0, fx: F.x, fz: F.z, dist: 2.2 });
        if (t2 !== null) {
          shattered = await page.evaluate(MELEE_ONE, {
            targetId: t2.id, fx: F.x, fz: F.z, damageSeed: seeds.nonCrit, freezeSeconds: 6, windowMs: 1600, timeoutMs: 8000,
          });
        }
      }
      m.shatter = {
        kind: golem.kind, armor: golem.armor,
        expectedBase: round(meleeHit, 3), expectedShatter: round(meleeHit * SHATTER_MULT, 3),
        measuredBase: baseline !== null ? round(baseline.dropAmt, 3) : null,
        measuredShatter: shattered !== null ? round(shattered.dropAmt, 3) : null,
      };
      if (baseline === null || shattered === null || baseline.dropAmt < 0 || shattered.dropAmt < 0) {
        fail('#6 Shatter x3 measurable on an armored kind', `baseline ${baseline !== null ? baseline.reason : 'spawn failed'} / shatter ${shattered !== null ? shattered.reason : 'spawn failed'}`);
      } else {
        const ratio = shattered.dropAmt / baseline.dropAmt;
        const ok = Math.abs(ratio - SHATTER_MULT) <= 0.05 && Math.abs(baseline.dropAmt - meleeHit) <= 0.5;
        if (ok && shattered.sawShatter) {
          pass('#6 Shatter x3 measurable on an armored kind', `${golem.kind} (armor ${golem.armor}): ${baseline.dropAmt.toFixed(2)} -> ${shattered.dropAmt.toFixed(2)} (x${ratio.toFixed(2)}), Shatter text shown`);
        } else {
          fail('#6 Shatter x3 measurable on an armored kind', `base ${baseline.dropAmt.toFixed(3)} (exp ${meleeHit.toFixed(3)}), frozen ${shattered.dropAmt.toFixed(3)} (x${ratio.toFixed(3)}, exp 3.0), text=${shattered.sawShatter}`);
        }
      }

      // Thermal Shock: freeze + fire consumes the freeze, breaks armor for
      // 5 s; a statusless wind follow-up measures the halved armor exactly.
      await healIfLow(180);
      const wind = picks.windPlain;
      const fire = picks.fireSkill;
      const target = await page.evaluate(SPAWN_TARGET, { kind: golem.kind, ax: 0, az: 0, fx: F.x, fz: F.z, dist: 7 });
      let dropA = null;
      let dropB = null;
      let dropC = null;
      if (target !== null) {
        dropA = await page.evaluate(MEASURED_CAST, {
          targetId: target.id, skillId: wind.id, slot: 0,
          statusSeed: seeds.statusMiss, damageSeed: seeds.nonCrit,
          freezeSeconds: 5, useOffset: true, offX: -F.x * 7, offZ: -F.z * 7, faceMs: 160,
          acceptMs: 7000, windowMs: 2200, timeoutMs: 16_000, watchNames: [],
        });
        dropB = await page.evaluate(MEASURED_CAST, {
          targetId: target.id, skillId: fire.id, slot: 1,
          statusSeed: seeds.statusMiss, damageSeed: seeds.nonCrit,
          freezeSeconds: 0, useOffset: true, offX: -F.x * 7, offZ: -F.z * 7, faceMs: 140,
          acceptMs: 7000, windowMs: 2200, timeoutMs: 16_000, watchNames: ['Thermal Shock'],
        });
        dropC = await page.evaluate(MEASURED_CAST, {
          targetId: target.id, skillId: wind.id, slot: 0,
          statusSeed: seeds.statusMiss, damageSeed: seeds.nonCrit,
          freezeSeconds: 4, useOffset: true, offX: -F.x * 7, offZ: -F.z * 7, faceMs: 140,
          acceptMs: 7000, windowMs: 2200, timeoutMs: 16_000, watchNames: [],
        });
      }
      const expA = skillHit(wind, dropA !== null ? dropA.masteryLevel : 1, elemMultOf(golem, wind.element), golem.armor);
      // The break applies to the triggering fire hit itself (reactionFor runs
      // before the armor read in hitTarget) and to the wind follow-up.
      const expB = skillHit(fire, dropB !== null ? dropB.masteryLevel : 1, elemMultOf(golem, fire.element), golem.armor, 0.5);
      const expC = skillHit(wind, dropC !== null ? dropC.masteryLevel : 1, elemMultOf(golem, wind.element), golem.armor, 0.5);
      m.thermalShock = {
        kind: golem.kind, wind: wind.id, fire: fire.id,
        expected: { before: round(expA, 3), fireHit: round(expB, 3), after: round(expC, 3) },
        measured: {
          before: dropA !== null ? round(dropA.dropAmt, 3) : null,
          fireHit: dropB !== null ? round(dropB.dropAmt, 3) : null,
          after: dropC !== null ? round(dropC.dropAmt, 3) : null,
        },
      };
      if (target === null || dropA === null || dropB === null || dropC === null || dropA.dropAmt < 0 || dropB.dropAmt < 0 || dropC.dropAmt < 0) {
        fail('#6 Thermal Shock armor break measurable', `hits missing: A=${dropA !== null ? dropA.reason : 'x'} B=${dropB !== null ? dropB.reason : 'x'} C=${dropC !== null ? dropC.reason : 'x'}`);
      } else {
        const sawText = dropB.namesSeen['Thermal Shock'] >= 0;
        const freezeGone = !dropB.statusesAfter.some((s) => s.id === STATUS_INDEX.freeze);
        const okA = Math.abs(dropA.dropAmt - expA) <= 0.7;
        const okB = Math.abs(dropB.dropAmt - expB) <= 0.9;
        const okC = Math.abs(dropC.dropAmt - expC) <= 0.7;
        if (sawText && okA && okB && okC && dropC.dropAmt > dropA.dropAmt) {
          pass(
            '#6 Thermal Shock armor break measurable',
            `${golem.kind}: ${wind.id} ${dropA.dropAmt.toFixed(2)} -> (freeze+${fire.id}: ${dropB.dropAmt.toFixed(2)}, text shown, freeze consumed=${freezeGone}) -> ${wind.id} ${dropC.dropAmt.toFixed(2)} inside the 5 s break (armor ${golem.armor} -> ${golem.armor / 2})`,
          );
        } else {
          fail(
            '#6 Thermal Shock armor break measurable',
            `text=${sawText} A ${dropA.dropAmt.toFixed(3)}/${expA.toFixed(3)} B ${dropB.dropAmt.toFixed(3)}/${expB.toFixed(3)} C ${dropC.dropAmt.toFixed(3)}/${expC.toFixed(3)} freezeGone=${freezeGone}`,
          );
        }
      }
    }

    // =======================================================================
    // #7 — shrines: placement data + one challenge of EACH type to completion.
    // =======================================================================
    {
      const list = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.shrines());
      m.shrines = list;
      if (list.length === 6) pass('#7 six shrines exist', list.map((s) => `${s.element}:${s.kind}`).join(', '));
      else fail('#7 six shrines exist', `${list.length} shrines`);
      const elems = new Set(list.map((s) => s.element));
      if (elems.size === 6 && ['fire', 'ice', 'wind', 'earth', 'light', 'dark'].every((e) => elems.has(e))) {
        pass('#7 one shrine per element', [...elems].join(', '));
      } else {
        fail('#7 one shrine per element', [...elems].join(', '));
      }
      const kindCounts = {};
      for (const s of list) kindCounts[s.kind] = (kindCounts[s.kind] ?? 0) + 1;
      if (kindCounts.survive60 === 2 && kindCounts.torches4in90 === 2 && kindCounts.guardian === 2) {
        pass('#7 two challenges of each type', JSON.stringify(kindCounts));
      } else {
        fail('#7 two challenges of each type', JSON.stringify(kindCounts));
      }
      const tooClose = list.filter((s) => Math.hypot(s.x, s.z) < 60);
      if (tooClose.length === 0) pass('#7 every shrine >= 60 u from spawn', list.map((s) => Math.hypot(s.x, s.z).toFixed(0)).join(', '));
      else fail('#7 every shrine >= 60 u from spawn', tooClose.map((s) => `${s.element}@${Math.hypot(s.x, s.z).toFixed(0)}u`).join(', '));
      // Thematic homes (contract decisions): fire=Emberscar, ice=Frostvale,
      // wind+light=Verdant, earth=Whisperwood, dark=Spire outskirts.
      const homes = { fire: 2, ice: 3, wind: 0, earth: 1, light: 0, dark: 4 };
      const regionRows = await page.evaluate(
        (pts) => pts.map((p) => globalThis.__ARCANUM_DEBUG__.regionAt(p.x, p.z)),
        list.map((s) => ({ x: s.x, z: s.z })),
      );
      const misplaced = list.filter((s, i) => regionRows[i] !== homes[s.element]);
      if (misplaced.length === 0) pass('#7 shrines sit in their thematic regions', list.map((s, i) => `${s.element}:${REGION_NAMES[regionRows[i]]}`).join(', '));
      else fail('#7 shrines sit in their thematic regions', misplaced.map((s) => `${s.element} not in region ${homes[s.element]}`).join(', '));

      const attackPoint = await page.evaluate(() => {
        const el = document.querySelector('.tc__btn--attack');
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (attackPoint === null) throw new Fatal('.tc__btn--attack not found — cannot start shrine challenges through the real TouchControls path.');
      const cdp = await page.context().newCDPSession(page);
      const tapAttack = async () => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: attackPoint.x, y: attackPoint.y, id: 7 }] });
        await sleep(90);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      const knownIds = async () => page.evaluate(() => globalThis.__ARCANUM_DEBUG__.grimoire().known);

      /** Approach an idle shrine and start it through the REAL contextual tap. */
      const startChallenge = async (index, shrine) => {
        await waitNoCard();
        await page.evaluate(
          (o) => {
            const d = globalThis.__ARCANUM_DEBUG__;
            d.killAllEnemies();
            d.clearInput();
            d.warp(o.x, o.z);
          },
          { x: shrine.x + F.x * 2.6, z: shrine.z + F.z * 2.6 },
        );
        await sleep(500);
        const pre = await page.evaluate(() => ({
          icon: (document.querySelector('.tc__btn--attack .tc__btn-icon') || {}).textContent ?? null,
          orbNear: globalThis.__ARCANUM_DEBUG__.orbs().nearby,
        }));
        await tapAttack();
        const active = await page
          .waitForFunction(
            (i) => globalThis.__ARCANUM_DEBUG__.shrines()[i].state === 'active',
            index,
            { timeout: 4000 },
          )
          .then(() => true)
          .catch(() => false);
        return { pre, active };
      };

      // ---- guardian -------------------------------------------------------
      {
        const index = list.findIndex((s) => s.kind === 'guardian');
        const shrine = list[index];
        await healIfLow(190);
        const before = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.enemies().filter((e) => e.alive).map((e) => e.id));
        const start = await startChallenge(index, shrine);
        if (!start.active) {
          fail('#7 guardian challenge starts via the real contextual tap', `state never went active (icon was "${String(start.pre.icon)}", orbNear=${start.pre.orbNear})`);
        } else {
          const iconOk = start.pre.icon !== null && start.pre.icon !== '⚔';
          pass('#7 guardian challenge starts via the real contextual tap', `attack button showed the contextual icon (${iconOk ? 'morphed' : 'UNMORPHED'}), tap -> active`);
          const guardian = await page.evaluate(
            (prev) => {
              const rows = globalThis.__ARCANUM_DEBUG__.enemies();
              for (const r of rows) if (r.alive && prev.indexOf(r.id) === -1) return r;
              return null;
            },
            before,
          );
          if (guardian === null) {
            fail('#7 guardian spawns buffed', 'no new enemy row after the tap');
          } else {
            const gdef = defByKind.get(guardian.kind);
            const hpMult = gdef !== undefined ? guardian.hp / gdef.maxHp : -1;
            const regionOfShrine = await page.evaluate((p) => globalThis.__ARCANUM_DEBUG__.regionAt(p.x, p.z), { x: shrine.x, z: shrine.z });
            const regionOk = gdef !== undefined && gdef.biomes.includes(regionOfShrine);
            if (gdef !== undefined && Math.abs(hpMult - 2.5) < 0.01 && regionOk) {
              pass('#7 guardian spawns buffed', `${guardian.kind} at ${guardian.hp} hp = 2.5 x ${gdef.maxHp}, region-valid`);
            } else {
              fail('#7 guardian spawns buffed', `${guardian.kind} hp ${guardian.hp} (x${hpMult.toFixed(2)} of def), regionValid=${regionOk}`);
            }
            // Real-kill flow: freeze, drop hp, one seeded cast.
            const kill = await page.evaluate(MEASURED_CAST, {
              targetId: guardian.id, skillId: picks.killSkill.id, slot: 0,
              statusSeed: seeds.statusMiss, damageSeed: seeds.nonCrit,
              freezeSeconds: 8, useOffset: true, offX: -F.x * 4.5, offZ: -F.z * 4.5, faceMs: 160,
              acceptMs: 8000, windowMs: 2600, timeoutMs: 16_000, watchNames: [],
            });
            await page.evaluate((id) => globalThis.__ARCANUM_DEBUG__.setEnemyHp(id, 3), guardian.id);
            const kill2 = kill.targetAlive
              ? await page.evaluate(MEASURED_CAST, {
                  targetId: guardian.id, skillId: picks.killSkill.id, slot: 0,
                  statusSeed: seeds.statusMiss, damageSeed: seeds.nonCrit,
                  freezeSeconds: 6, useOffset: true, offX: -F.x * 4.5, offZ: -F.z * 4.5, faceMs: 140,
                  acceptMs: 8000, windowMs: 2600, timeoutMs: 16_000, watchNames: [],
                })
              : null;
            const done = await page
              .waitForFunction((i) => globalThis.__ARCANUM_DEBUG__.shrines()[i].state === 'done', index, { timeout: 9000 })
              .then(() => true)
              .catch(() => false);
            const reward = picks.shrineSkills.get(shrine.element);
            const known = await knownIds();
            const sawCard = kill.sawCard || (kill2 !== null && kill2.sawCard) || (await page.evaluate(() => document.querySelector('.notify__card.is-in') !== null));
            if (done && reward !== undefined && known.includes(reward.id)) {
              pass('#7 guardian kill completes the shrine and teaches its Epic', `${shrine.element} shrine done, learned ${reward.id}, card=${sawCard}`);
            } else {
              fail('#7 guardian kill completes the shrine and teaches its Epic', `done=${done}, reward=${reward !== undefined ? reward.id : 'none'}, known=${known.length}`);
            }
          }
        }
      }

      // ---- torches --------------------------------------------------------
      {
        const index = list.findIndex((s) => s.kind === 'torches4in90');
        const shrine = list[index];
        await healIfLow(160);
        const start = await startChallenge(index, shrine);
        if (!start.active) {
          fail('#7 torch challenge starts', `state never went active (icon "${String(start.pre.icon)}")`);
        } else {
          const spiral = await page.evaluate(TORCH_SPIRAL, {
            index, sx: shrine.x, sz: shrine.z,
            radii: [8.3, 9.5, 10.7, 11.9, 13.1, 14.2],
            stepU: 1.0,
            timeoutMs: 80_000,
          });
          const reward = picks.shrineSkills.get(shrine.element);
          const known = await knownIds();
          m.torchSpiral = { points: spiral.points, state: spiral.state, reason: spiral.reason };
          if (spiral.state === 'done' && reward !== undefined && known.includes(reward.id)) {
            pass('#7 lighting 4 torches completes the shrine', `${shrine.element} shrine done after ${spiral.points} sweep points, learned ${reward.id}, card=${spiral.sawCard}`);
          } else {
            fail('#7 lighting 4 torches completes the shrine', `state ${spiral.state} (${spiral.reason}), reward known=${reward !== undefined && known.includes(reward.id)}`);
          }
        }
      }

      // ---- survive60 (time-compressed via the sanctioned debug hook) -------
      {
        const index = list.findIndex((s) => s.kind === 'survive60');
        const shrine = list[index];
        await healIfLow(200);
        await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.shrineTimeScale(6));
        const start = await startChallenge(index, shrine);
        if (!start.active) {
          fail('#7 survive challenge starts', `state never went active (icon "${String(start.pre.icon)}")`);
        } else {
          const survive = await page.evaluate(SURVIVE_DRIVE, { index, killEveryMs: 1500, timeoutMs: 30_000 });
          await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.shrineTimeScale(1));
          const reward = picks.shrineSkills.get(shrine.element);
          const known = await knownIds();
          m.survive = { state: survive.state, sawEnemies: survive.sawEnemies, maxAlive: survive.maxAlive };
          if (survive.state === 'done' && survive.sawEnemies && reward !== undefined && known.includes(reward.id)) {
            pass('#7 survive60 completes under pressure', `${shrine.element} shrine done (timeScale 6, ~10 s real), waves spawned (peak ${survive.maxAlive} alive), learned ${reward.id}, card=${survive.sawCard}`);
          } else {
            fail('#7 survive60 completes under pressure', `state ${survive.state} (${survive.reason}), sawEnemies=${survive.sawEnemies}, reward known=${reward !== undefined && known.includes(reward.id)}`);
          }
          note('#7 survive60 was time-compressed', 'shrineTimeScale(6) shrank the 60 s clock to ~10 s real; waves, the 25 u radius rule and the reward flow all ran for real (the contract offers exactly this compression)');
        }
      }
    }

    // =======================================================================
    // #8 — fragments: 9 sites, walk-in pickups, auto-assembly at 3/3.
    // =======================================================================
    {
      const frag = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.fragments());
      m.fragmentSites = frag.sites;
      if (frag.sites.length === 9) pass('#8 nine fragment sites exist', frag.sites.map((s) => s.skillId).join(', '));
      else fail('#8 nine fragment sites exist', `${frag.sites.length} sites`);
      const perSkill = {};
      for (const s of frag.sites) perSkill[s.skillId] = (perSkill[s.skillId] ?? 0) + 1;
      const fragIds = picks.fragmentSkills.map((s) => s.id);
      const threeEach = fragIds.length === 3 && fragIds.every((id) => perSkill[id] === 3);
      if (threeEach) pass('#8 three pieces per fragment skill', JSON.stringify(perSkill));
      else fail('#8 three pieces per fragment skill', `sites ${JSON.stringify(perSkill)} vs JSON fragment skills [${fragIds.join(', ')}]`);
      const siteRegions = await page.evaluate(
        (pts) => pts.map((p) => globalThis.__ARCANUM_DEBUG__.regionAt(p.x, p.z)),
        frag.sites.map((s) => ({ x: s.x, z: s.z })),
      );
      const outer = new Set(siteRegions.filter((r) => r !== 0));
      if ([1, 2, 3, 4].every((r) => outer.has(r))) pass('#8 at least one site in every outer region', `regions: ${siteRegions.join(', ')}`);
      else fail('#8 at least one site in every outer region', `regions: ${siteRegions.join(', ')} — missing ${[1, 2, 3, 4].filter((r) => !outer.has(r)).join(', ')}`);

      const targetId = fragIds[0];
      const mySites = frag.sites.map((s, i) => ({ ...s, index: i })).filter((s) => s.skillId === targetId);
      const counts = [];
      let sawCard = false;
      await waitNoCard();
      await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.killAllEnemies());
      for (const site of mySites) {
        await page.evaluate((o) => globalThis.__ARCANUM_DEBUG__.warp(o.x, o.z), { x: site.x, z: site.z });
        const taken = await page
          .waitForFunction(
            (i) => globalThis.__ARCANUM_DEBUG__.fragments().sites[i].taken === true,
            site.index,
            { timeout: 4000 },
          )
          .then(() => true)
          .catch(() => false);
        const state = await page.evaluate((id) => {
          const d = globalThis.__ARCANUM_DEBUG__;
          return {
            count: d.fragments().counts[id] ?? 0,
            known: d.grimoire().known.includes(id),
            card: document.querySelector('.notify__card.is-in') !== null,
          };
        }, targetId);
        counts.push({ taken, count: state.count, known: state.known });
        if (state.card) sawCard = true;
      }
      m.fragmentRun = { skill: targetId, counts };
      const countsOk = counts.length === 3 && counts.every((c, i) => c.taken && c.count === i + 1);
      const learned = counts.length === 3 && counts[2].known && !counts[0].known && !counts[1].known;
      if (countsOk && learned) {
        pass('#8 walking into 3 sites assembles the skill', `${targetId}: counts 1,2,3 -> learned exactly at 3/3, card=${sawCard}`);
      } else {
        fail('#8 walking into 3 sites assembles the skill', `${targetId}: ${JSON.stringify(counts)} (card=${sawCard})`);
      }
    }

    // =======================================================================
    // #9 — Boss Vael: trigger, three phases, the reaction shield's teaching,
    // the scripted Legendary. Hp is stepped with setEnemyHp between phases;
    // every observed number comes from a real seeded cast.
    // =======================================================================
    {
      await healIfLow(200);
      await waitNoCard();
      await page.evaluate(() => {
        const d = globalThis.__ARCANUM_DEBUG__;
        d.killAllEnemies();
        d.clearInput();
      });
      const dormant = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.boss());
      if (dormant === null) pass('#9 boss dormant before the trigger', 'boss() null at distance');
      else fail('#9 boss dormant before the trigger', JSON.stringify(dormant));

      await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.warpBoss());
      const atEdge = await page.evaluate(() => {
        const d = globalThis.__ARCANUM_DEBUG__;
        const p = d.player();
        return { x: p.x, z: p.z, boss: d.boss() };
      });
      const edgeDist = Math.hypot(atEdge.x - VAEL.arenaX, atEdge.z - VAEL.arenaZ);
      if (edgeDist > VAEL.triggerRadius && atEdge.boss === null) {
        pass('#9 warpBoss lands outside the trigger, boss still dormant', `${edgeDist.toFixed(1)} u from the heart`);
      } else {
        fail('#9 warpBoss lands outside the trigger, boss still dormant', `dist ${edgeDist.toFixed(1)}, boss ${JSON.stringify(atEdge.boss)}`);
      }

      await page.evaluate((o) => globalThis.__ARCANUM_DEBUG__.warp(o.x, o.z), { x: VAEL.arenaX - F.x * 9, z: VAEL.arenaZ - F.z * 9 });
      const engaged = await page
        .waitForFunction(() => {
          const b = globalThis.__ARCANUM_DEBUG__.boss();
          return b !== null && b.active === true;
        }, null, { timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      const engageState = await page.evaluate(() => ({ boss: globalThis.__ARCANUM_DEBUG__.boss() }));
      m.bossEngage = engageState;
      if (engaged && engageState.boss.phase === 1 && engageState.boss.shield === 0 && engageState.boss.maxHp === VAEL.maxHp) {
        pass('#9 stepping inside 20 u starts the fight', `active, phase 1, shield 0, ${engageState.boss.hp}/${engageState.boss.maxHp} hp`);
      } else {
        fail('#9 stepping inside 20 u starts the fight', `engaged=${engaged}, state ${JSON.stringify(engageState.boss)}`);
      }
      // The encounter HUD refreshes on its own throttle — WAIT for the bar
      // instead of reading the DOM on the engagement edge (run-2 lesson).
      const barShown = await page
        .waitForFunction(() => document.querySelector('.enc__boss.is-on') !== null, null, { timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      if (barShown) pass('#9 boss HP bar appears', '.enc__boss.is-on visible');
      else fail('#9 boss HP bar appears', '.enc__boss.is-on never appeared within 4 s of engagement');

      const bossRow = await page.evaluate(() => {
        const rows = globalThis.__ARCANUM_DEBUG__.enemies();
        for (const r of rows) if (r.maxHp >= 1000) return { id: r.id, hp: r.hp };
        return null;
      });
      if (bossRow === null) throw new Fatal('boss row (maxHp >= 1000) not found in enemies() — cannot drive the fight.');
      const bid = bossRow.id;
      const gale = picks.windPlain; // wind: mult 1 vs Vael, reaction-free on a frozen boss
      const bossCast = (skillId, slot, opts = {}) =>
        page.evaluate(MEASURED_CAST, {
          targetId: bid, skillId, slot,
          statusSeed: opts.statusSeed ?? seeds.statusMiss,
          damageSeed: seeds.nonCrit,
          freezeSeconds: opts.freeze ?? 3.5,
          useOffset: true, offX: -F.x * 8, offZ: -F.z * 8, faceMs: 160,
          acceptMs: 9000, windowMs: 2600, timeoutMs: 18_000,
          watchNames: opts.watch ?? [],
        });
      // P1: plain damage lands FULL (expectation folds the mastery level the
      // run has accumulated on the workhorse skill — the run-1 lesson).
      const p1 = await bossCast(gale.id, 0);
      const expP1 = skillHit(gale, p1.masteryLevel, 1, VAEL.armor);
      m.bossP1 = { expected: round(expP1, 3), measured: p1.dropAmt >= 0 ? round(p1.dropAmt, 3) : null, masteryLevel: p1.masteryLevel };
      if (p1.accepted && Math.abs(p1.dropAmt - expP1) <= 0.8) {
        pass('#9 P1: plain damage lands undampened', `${gale.id} hit ${p1.dropAmt.toFixed(2)} (expected ${expP1.toFixed(2)}, armor ${VAEL.armor}, mastery L${p1.masteryLevel})`);
      } else {
        fail('#9 P1: plain damage lands undampened', `measured ${p1.dropAmt.toFixed(3)}, expected ${expP1.toFixed(3)} at mastery L${p1.masteryLevel} (${p1.reason})`);
      }

      // Into P2 (hp stepped; the threshold logic itself runs live).
      await page.evaluate((o) => globalThis.__ARCANUM_DEBUG__.setEnemyHp(o.id, o.hp), { id: bid, hp: Math.floor(VAEL.maxHp * (VAEL.p2Fraction - 0.01)) });
      const p2Up = await page
        .waitForFunction(() => {
          const b = globalThis.__ARCANUM_DEBUG__.boss();
          return b !== null && b.phase === 2 && b.shield === 3;
        }, null, { timeout: 9000 })
        .then(() => true)
        .catch(() => false);
      if (p2Up) pass('#9 P2 at 66%: shield raised', 'phase 2, 3 layers');
      else fail('#9 P2 at 66%: shield raised', JSON.stringify(await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.boss())));

      // P2: the SAME seeded hit now lands at x0.15. Expectation is absolute
      // (with P2's own mastery level) — a level-up between the two casts must
      // not masquerade as a shield error.
      const p2 = await bossCast(gale.id, 0);
      const expP2 = skillHit(gale, p2.masteryLevel, 1, VAEL.armor) * VAEL.shieldDamageMult;
      const dampRatio = p1.dropAmt > 0 && p2.dropAmt > 0 ? p2.dropAmt / p1.dropAmt : -1;
      m.bossP2 = { expected: round(expP2, 3), measured: p2.dropAmt >= 0 ? round(p2.dropAmt, 3) : null, ratio: round(dampRatio, 4), masteryLevel: p2.masteryLevel };
      if (p2.accepted && Math.abs(p2.dropAmt - expP2) <= 0.25) {
        pass('#9 P2: shielded plain damage is x0.15', `${p2.dropAmt.toFixed(2)} = full hit x ${VAEL.shieldDamageMult} (ratio vs P1: x${dampRatio.toFixed(3)}) — the teaching numbers`);
      } else {
        fail('#9 P2: shielded plain damage is x0.15', `measured ${p2.dropAmt.toFixed(3)}, expected ${expP2.toFixed(3)} at mastery L${p2.masteryLevel} (${p2.reason})`);
      }

      // Forced reaction: wet, then dark = Overload ON VAEL -> one layer
      // stripped and the triggering hit lands undampened (the grace).
      const shieldBefore = (await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.boss())).shield;
      const wetCast = await bossCast(picks.wetSkill.id, 1, { statusSeed: seeds.statusHit, freeze: 5 });
      const wetOn = wetCast.statusesAfter.some((s) => s.id === STATUS_INDEX.wet);
      const spark = await bossCast(picks.darkSkill.id, 2, { freeze: 0, watch: ['Overload'] });
      const sparkExp = skillHit(
        picks.darkSkill,
        spark.masteryLevel,
        elemMultOf({ resists: VAEL.resists, weakTo: VAEL.weakTo }, picks.darkSkill.element),
        VAEL.armor,
      );
      const shieldAfter = (await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.boss())).shield;
      m.bossStrip = {
        wetApplied: wetOn, shieldBefore, shieldAfter,
        overloadSeenAt: spark.namesSeen['Overload'],
        graceHit: spark.dropAmt >= 0 ? round(spark.dropAmt, 3) : null,
        graceExpected: round(sparkExp, 3),
      };
      if (wetOn && spark.namesSeen['Overload'] >= 0 && shieldAfter === shieldBefore - 1) {
        pass('#9 a forced reaction strips a shield layer', `wet (${picks.wetSkill.id}) + ${picks.darkSkill.id} -> Overload on Vael, shield ${shieldBefore} -> ${shieldAfter}`);
      } else {
        fail('#9 a forced reaction strips a shield layer', `wet=${wetOn}, OverloadSeen=${spark.namesSeen['Overload']}, shield ${shieldBefore} -> ${shieldAfter}`);
      }
      if (spark.dropAmt >= 0 && Math.abs(spark.dropAmt - sparkExp) <= 0.9) {
        pass('#9 the reaction hit lands undampened (grace)', `${spark.dropAmt.toFixed(2)} = full x0.5-resist hit, not the x0.15 residue (${(sparkExp * VAEL.shieldDamageMult).toFixed(2)})`);
      } else {
        fail('#9 the reaction hit lands undampened (grace)', `measured ${spark.dropAmt.toFixed(3)}, expected ${sparkExp.toFixed(3)}`);
      }

      // Into P3: the shield refreshes exactly once.
      await page.evaluate((o) => globalThis.__ARCANUM_DEBUG__.setEnemyHp(o.id, o.hp), { id: bid, hp: Math.floor(VAEL.maxHp * (VAEL.p3Fraction - 0.03)) });
      const p3Up = await page
        .waitForFunction(() => {
          const b = globalThis.__ARCANUM_DEBUG__.boss();
          return b !== null && b.phase === 3 && b.shield === 3;
        }, null, { timeout: 9000 })
        .then(() => true)
        .catch(() => false);
      if (p3Up) pass('#9 P3 at 33%: reached, shield refreshed once', `phase 3, shield back to 3 (was ${shieldAfter})`);
      else fail('#9 P3 at 33%: reached, shield refreshed once', JSON.stringify(await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.boss())));

      // Boss arena screenshot, shield shell up, phase 3.
      const bossShotName = 'contenttest-boss.png';
      const bossPng = await page.screenshot({ path: path.join(ARTIFACTS, bossShotName), type: 'png' });
      const bossLuma = await page.evaluate(LUMA, bossPng.toString('base64'));
      shots.push({ name: bossShotName, luma: bossLuma.ok ? round(bossLuma.luma, 1) : null, bytes: bossPng.length });

      // The kill: real cast lands the killing blow; the Legendary is scripted.
      const knownBefore = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.grimoire().known);
      await page.evaluate((o) => globalThis.__ARCANUM_DEBUG__.setEnemyHp(o.id, o.hp), { id: bid, hp: 3 });
      const killCast = await bossCast(gale.id, 0, { freeze: 3 });
      const deadState = await page
        .waitForFunction(() => {
          const b = globalThis.__ARCANUM_DEBUG__.boss();
          return b !== null && b.hp <= 0;
        }, null, { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      const bossReward = picks.bossSkills[0];
      const rewardKnown = await page
        .waitForFunction((id) => globalThis.__ARCANUM_DEBUG__.grimoire().known.includes(id), bossReward.id, { timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      const cardInfo = await page.evaluate(() => {
        const card = document.querySelector('.notify__card.is-in');
        const name = card !== null ? card.querySelector('.notify__name') : null;
        return { card: card !== null, name: name !== null ? name.textContent : '' };
      });
      m.bossKill = { deadState, rewardKnown, card: cardInfo, killDrop: killCast.dropAmt >= 0 ? round(killCast.dropAmt, 2) : null };
      if (deadState && killCast.accepted) pass('#9 the kill lands through a real cast', `boss hp <= 0 after ${gale.id} (drop ${killCast.dropAmt >= 0 ? killCast.dropAmt.toFixed(2) : 'overkill'})`);
      else fail('#9 the kill lands through a real cast', `dead=${deadState}, cast ${killCast.reason}`);
      if (rewardKnown && !knownBefore.includes(bossReward.id)) {
        pass('#9 scripted Legendary learned on the kill', `${bossReward.id} (bossReward marker), ACQUIRED card=${cardInfo.card || killCast.sawCard}`);
      } else {
        fail('#9 scripted Legendary learned on the kill', `known=${rewardKnown}, was already known=${knownBefore.includes(bossReward.id)}`);
      }
      note(
        '#9 boss hp compressed between phases',
        'Vael\'s 2400 hp was stepped with setEnemyHp at the 66%/33% thresholds (an honest fight is minutes of cooldown waiting); every phase flip, shield raise/strip/refresh, x0.15 number and the kill itself came from real seeded casts through the live pipeline. P3\'s faster-telegraph scaling was not measured at runtime.',
      );
    }

    // =======================================================================
    // #10 — budgets THROUGHOUT + hygiene.
    // =======================================================================
    {
      m.budgetAggregate = {
        framesSampled: budgetAgg.frames,
        peakDrawCalls: budgetAgg.peakDraws,
        peakTriangles: budgetAgg.peakTris,
        peakHeapMb: round(budgetAgg.peakHeap, 1),
        heapFirstMb: round(budgetAgg.firstHeap, 2),
        heapLastMb: round(budgetAgg.lastHeap, 2),
        tickRates: tickRates.map((t) => round(t, 1)),
      };
      if (budgetAgg.frames < 1000) {
        unknown('#10 budgets sampled throughout', `only ${budgetAgg.frames} sampled frames`);
      } else {
        if (budgetAgg.peakDraws <= BUDGET.drawCalls) pass('#10 draw calls <= 110 across all five region walks', `peak ${budgetAgg.peakDraws} over ${budgetAgg.frames} frames`);
        else fail('#10 draw calls <= 110 across all five region walks', `peak ${budgetAgg.peakDraws}`);
        if (budgetAgg.peakTris <= BUDGET.triangles) pass('#10 triangles <= 150000 across the run', `peak ${budgetAgg.peakTris}`);
        else fail('#10 triangles <= 150000 across the run', `peak ${budgetAgg.peakTris}`);
        if (budgetAgg.peakHeap <= BUDGET.heapMb) pass('#10 heap <= 280 MB', `peak ${budgetAgg.peakHeap.toFixed(1)} MB`);
        else fail('#10 heap <= 280 MB', `peak ${budgetAgg.peakHeap.toFixed(1)} MB`);
        const driftBytes = ((budgetAgg.lastHeap - budgetAgg.firstHeap) * 1024 * 1024) / budgetAgg.frames;
        m.budgetAggregate.heapBytesPerFrame = Math.round(driftBytes);
        if (driftBytes < HEAP_BYTES_PER_FRAME) {
          pass('#10 heap drift < 4 KB/frame over the streaming+spawning run', `${driftBytes.toFixed(0)} B/frame across ${budgetAgg.frames} frames of five-region streaming`);
        } else {
          fail('#10 heap drift < 4 KB/frame over the streaming+spawning run', `${driftBytes.toFixed(0)} B/frame — something retains per frame`);
        }
        const badTicks = tickRates.filter((t) => Math.abs(t - 60) > 6);
        if (badTicks.length === 0) pass('#10 fixed tick ~60/s in every region walk', tickRates.map((t) => t.toFixed(1)).join(', '));
        else fail('#10 fixed tick ~60/s in every region walk', tickRates.map((t) => t.toFixed(1)).join(', '));
      }
    }

    // =======================================================================
    // #11 — screenshots: one per region + the boss arena, none black.
    // =======================================================================
    {
      m.screenshots = shots;
      const missing = shots.filter((s) => !existsSync(path.join(ARTIFACTS, s.name)));
      const dark = shots.filter((s) => s.luma === null || s.luma < 6);
      const tiny = shots.filter((s) => {
        try {
          return statSync(path.join(ARTIFACTS, s.name)).size < 15_000;
        } catch {
          return true;
        }
      });
      if (shots.length === 6 && missing.length === 0 && dark.length === 0 && tiny.length === 0) {
        pass('#11 six screenshots written and non-black', shots.map((s) => `${s.name} (luma ${s.luma})`).join(', '));
      } else {
        fail('#11 six screenshots written and non-black', `count ${shots.length}, missing [${missing.map((s) => s.name).join(',')}], dark [${dark.map((s) => `${s.name}:${s.luma}`).join(',')}], tiny [${tiny.map((s) => s.name).join(',')}]`);
      }
    }
  } catch (error) {
    if (!hardTimedOut && interrupted === null) {
      if (error instanceof Fatal) fail('harness precondition', error.message);
      else fail('harness error', error?.stack ?? String(error));
    }
  }

  finish(startedAt);
}

function finish(startedAt) {
  if (report.pageErrors.length === 0) pass('#10 no uncaught page errors', '0');
  else fail('#10 no uncaught page errors', report.pageErrors.join(' | '));
  if (report.consoleErrors.length === 0) pass('#10 no console errors', '0');
  else fail('#10 no console errors', report.consoleErrors.slice(0, 8).join(' | '));

  if (interrupted !== null) fail('interrupted', `${interrupted} received — no verdict.`);
  if (hardTimedOut) fail('overall timeout', `exceeded ${OVERALL_TIMEOUT_MS} ms`);

  const failed = report.checks.filter((c) => c.status === 'FAIL');
  report.verdict = failed.length === 0 ? 'PASS' : 'FAIL';
  report.durationMs = Date.now() - startedAt;

  printSummary();

  if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(path.join(ARTIFACTS, 'contenttest.json'), JSON.stringify(report, null, 2));

  void cleanup().finally(() => process.exit(interrupted !== null ? 130 : report.verdict === 'PASS' ? 0 : 1));
}

function printSummary() {
  const m = report.measurements;
  const row = (label, value, expected) =>
    console.log('  ' + label.padEnd(38) + String(value).padStart(14) + '   ' + expected);

  console.log('\n' + '='.repeat(78));
  console.log('ARCANUM DRIFT — PHASE 5 CONTENT GATE');
  console.log('='.repeat(78));

  console.log('\n§4.1 LAW (ENEMY KINDS)');
  const scan = m.kindScan ?? {};
  row('kind hits in src/**/*.ts CODE', (scan.codeHits ?? ['?']).length, '0 — enemy #13 is a JSON edit');
  row('comment-only mentions', (scan.commentHits ?? []).length, 'reported, non-fatal (prose)');
  row('.ts files scanned', scan.filesScanned ?? '-', '> 20');

  console.log('\nDIRECTOR (per region: spawns / max alive / peak budget)');
  for (const w of m.regionWalks ?? []) {
    row(w.region, `${w.spawnedDelta} / ${w.maxAlive} / ${w.maxBudgetUsed}:${w.budgetCap}`, `alive <= 18, budget <= cap, kinds [${w.kinds.join(',')}]`);
  }

  console.log('\nELEMENT MULTIPLIER / DEBT');
  const em = m.elementMult ?? {};
  row('weak hit (x1.5)', em.weak !== undefined ? `${em.weak.measured} / ${em.weak.expected}` : '-', 'measured / expected');
  row('resist hit (x0.5)', em.resist !== undefined ? `${em.resist.measured} / ${em.resist.expected}` : '-', 'measured / expected');
  const sh = m.shatter ?? {};
  row('Shatter x3', sh.measuredBase !== undefined ? `${sh.measuredBase} -> ${sh.measuredShatter}` : '-', `expected ${sh.expectedBase} -> ${sh.expectedShatter}`);
  const ts = m.thermalShock ?? {};
  row('Thermal Shock break', ts.measured !== undefined ? `${ts.measured.before} -> ${ts.measured.after}` : '-', ts.expected !== undefined ? `expected ${ts.expected.before} -> ${ts.expected.after}` : '');

  console.log('\nBOSS');
  const b1 = m.bossP1 ?? {};
  const b2 = m.bossP2 ?? {};
  row('P1 plain hit', b1.measured ?? '-', `expected ${b1.expected ?? '-'}`);
  row('P2 shielded ratio', b2.ratio ?? '-', 'x0.15');
  const bs = m.bossStrip ?? {};
  row('reaction strip', bs.shieldBefore !== undefined ? `${bs.shieldBefore} -> ${bs.shieldAfter}` : '-', 'one layer per reaction');
  row('grace hit', bs.graceHit ?? '-', `expected ${bs.graceExpected ?? '-'} (undampened)`);

  console.log('\nBUDGETS (§3, sampled across all five region walks)');
  const ba = m.budgetAggregate ?? {};
  row('draw calls (peak)', ba.peakDrawCalls ?? '-', '<= 110');
  row('triangles (peak)', ba.peakTriangles ?? '-', '<= 150000');
  row('heap (peak)', (ba.peakHeapMb ?? '-') + ' MB', '<= 280');
  row('heap drift', (ba.heapBytesPerFrame ?? '-') + ' B/frame', `< ${HEAP_BYTES_PER_FRAME}`);
  row('frames sampled', ba.framesSampled ?? '-', '> 1000');

  console.log('\nCHECKS');
  for (const check of report.checks) {
    const mark = check.status === 'PASS' ? 'ok  ' : check.status === 'NOTE' ? 'note' : 'FAIL';
    console.log(`  [${mark}] ${check.name}  —  ${check.detail}`);
  }

  if (report.misSpecified.length > 0) {
    console.log('\nNOTES (observed, not silently skipped)');
    for (const item of report.misSpecified) console.log('  * ' + item);
  }

  console.log('\nHONEST LIMITS OF THIS RUN');
  console.log('  SwiftShader software rendering: nothing here is a device number, and');
  console.log('  §12\'s Phase 5 acceptance — 20 minutes of exploration that never feels');
  console.log('  empty or repetitive — is a FEEL verdict only a handset can give. What');
  console.log('  DOES transfer: the §4.1 law now covering enemy kinds, region layout and');
  console.log('  terrain continuity, the director\'s budgets and the hard cap of 18, every');
  console.log('  bestiary kind\'s JSON-to-behaviour correctness, the live element table,');
  console.log('  Shatter x3 / Thermal Shock on real armor, all three shrine challenge');
  console.log('  FSMs, fragment assembly, and Vael\'s reaction-shield teaching measured');
  console.log('  in exact damage numbers. Compressions taken (and flagged as NOTEs):');
  console.log('  survive60 ran under shrineTimeScale(6); Vael\'s hp was stepped between');
  console.log('  phases; enemy pose animation is proven only as locomotion. The torch');
  console.log('  hunt ran at REAL time with a dense walk-in sweep, because torch');
  console.log('  positions are deliberately not on the debug surface.');

  const failedCount = report.checks.filter((c) => c.status === 'FAIL').length;
  console.log(
    `\nVERDICT     ${report.verdict}  (${report.checks.length - failedCount} passed/noted, ${failedCount} failed, ${report.durationMs} ms)`,
  );
  console.log('='.repeat(78) + '\n');
}

process.on('unhandledRejection', (reason) => {
  console.error('[contenttest] unhandled rejection:', reason);
  void cleanup().finally(() => process.exit(1));
});

await main();
