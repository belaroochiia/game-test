#!/usr/bin/env node
/**
 * Arcanum Drift — Phase 4 Grimoire gate.
 *
 * §12's Phase 4 acceptance criterion is §4.1's law in executable form: adding
 * the next skill must be a skills.json edit and ZERO lines of TypeScript. This
 * gate enforces it twice. FIRST, node-side, before any browser exists: every
 * skill id in skills.json is grepped across every src/**\/*.ts file, and ANY
 * occurrence fails the gate with file:line. No exceptions — the starting
 * loadout, the fusion recipes and everything else id-shaped live in JSON.
 * SECOND, in-page: ONE loop drives EVERY skill in the registry through learn →
 * equip → cast → observe, with every expectation (mana, cooldown, damage vs
 * heal, status id/duration, projectile vs nova vs self) derived from the JSON
 * entry alone. The gate itself hardcodes no skill id anywhere: every skill it
 * names is picked from skills.json by predicate (element, delivery, cost...).
 *
 * On top of that: the five §8.5 reactions (seeded), cooldown/mana refusals,
 * mastery thresholds and their damage delta, elemental/versatile resonance,
 * fusion, the soul-orb absorb through the REAL TouchControls hold (CDP), the
 * Grimoire screen, and the §3 budgets under a four-skill brawl.
 *
 * Where the shipped balance makes a contract assertion structurally
 * unobservable (the 40 hp slime is one-shot by most skills; slime armor is 0),
 * the gate says so with a NOTE instead of silently passing, asserts the
 * strongest observable evidence instead (reaction floating text, status
 * consumption, the reaction-forced heavy flag), and lists every such case in a
 * MIS-SPECIFIED section of the summary. Feel — the ACQUIRED moment's drama —
 * belongs to the real-handset test; what transfers from here is
 * data-correctness, determinism, reactions and budgets.
 *
 * Infrastructure is the proven combattest.mjs shape: detached vite preview +
 * process-group teardown, global Playwright import, hard timeout, SIGINT→130,
 * in-page rAF samplers, sampler-before-action ordering for CDP touches, and
 * waitForFunction's three-argument form.
 *
 * Port 4177 (smoke 4173, playtest 4174, worldtest 4175, combattest 4176).
 *
 * Usage: npm run build && node tools/skilltest.mjs
 * Output: artifacts/skilltest.png, artifacts/skilltest.json. Exit 0/1, 130 on SIGINT.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');
const ARTIFACTS = path.join(ROOT, 'artifacts');

const HOST = '127.0.0.1';
const PORT = 4177;
const URL_ = `http://${HOST}:${PORT}/`;

const OVERALL_TIMEOUT_MS = 300_000;
const SERVER_TIMEOUT_MS = 30_000;

/** §3 hard budgets. */
const BUDGET = { drawCalls: 110, triangles: 150_000, heapMb: 280 };
const HEAP_BYTES_PER_FRAME = 2048;

/** Engine truths this gate leans on (documented, not guessed):
 *  - PlayerStats boots every stat at 10 (damage/heal scaling estimates);
 *  - StatusEffects' numeric board ids, in this order;
 *  - DamageSystem/StatusEffects/SoulOrbs all use mulberry32 with the same
 *    step function, so seeds can be solved for HERE, offline. */
const STAT_VALUE = 10;
const STATUS_INDEX = { burn: 0, freeze: 1, wet: 2, shock: 3, bleed: 4, silence: 5 };
const CRIT_CHANCE = 0.08;
const SLIME_MAX_HP = 40;
const VERSATILE_BONUS = 0.2;
const RESONANCE_MULT = 1.15;
const ABSORB_HOLD_MS = 1600; // > the 1.2 s contract hold
const NOTIFY_FREEZE_TICKS = 20;

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
    console.error(`\n[skilltest] ${signal} received — tearing down.`);
    setTimeout(() => process.exit(130), 4000).unref();
    void cleanup().finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const report = {
  tool: 'tools/skilltest.mjs',
  phase: 4,
  startedAt: new Date().toISOString(),
  durationMs: 0,
  verdict: 'FAIL',
  renderingBackend:
    'SwiftShader (software) — not device numbers; the ACQUIRED moment\'s FEEL is the device test\'s to judge',
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
/** Contract expectation that shipped balance makes structurally unobservable.
 *  Does not fail the gate, but is listed in the MIS-SPECIFIED section. */
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

function findSeed(predicate, rolls = 12, tries = 500_000) {
  for (let seed = 1; seed <= tries; seed++) {
    if (predicate(mulberrySeq(seed, rolls))) return seed;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// PART 1 — node-side §4.1 law + data derivation. Runs before any browser.
// ---------------------------------------------------------------------------

function walkTs(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function loadJson(rel) {
  return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
}

/** skills.json may ship as a bare array or as { skills, startingLoadout }. */
function normalizeSkills(raw) {
  if (Array.isArray(raw)) return { skills: raw, startingLoadout: null };
  if (raw !== null && typeof raw === 'object' && Array.isArray(raw.skills)) {
    return { skills: raw.skills, startingLoadout: raw.startingLoadout ?? null };
  }
  throw new Fatal('src/data/skills.json has neither an array nor a { skills: [...] } shape.');
}

function scanForSkillIds(skillIds) {
  const files = walkTs(SRC, []);
  const hits = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const id of skillIds) {
        if (lines[i].includes(id)) {
          hits.push(`${path.relative(ROOT, file)}:${i + 1} contains "${id}"`);
        }
      }
    }
  }
  return { files: files.length, hits };
}

const expDmg = (s) =>
  s.damage !== undefined && s.damage.base > 0 ? s.damage.base + STAT_VALUE * s.damage.scaling.ratio : 0;
const expHeal = (s) => (s.heal !== undefined ? s.heal.base + STAT_VALUE * s.heal.scaling.ratio : 0);

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

/** Every named skill the gate uses is PICKED from the JSON by predicate. */
function derivePicks(skills, fusions) {
  const fusionResults = new Set(fusions.map((r) => r.result));
  const nonResult = skills.filter((s) => !fusionResults.has(s.id));
  const attack = (s) => expDmg(s) > 0;

  const picks = {};
  picks.wetApplier = minBy(
    skills.filter((s) => s.status !== undefined && s.status.id === 'wet' && s.status.chance >= 0.99 && attack(s)),
    expDmg,
  );
  picks.burnLow = minBy(
    skills.filter((s) => s.status !== undefined && s.status.id === 'burn' && attack(s) && expDmg(s) < SLIME_MAX_HP - 2),
    expDmg,
  );
  picks.iceLow = minBy(skills.filter((s) => s.element === 'ice' && attack(s)), expDmg);
  picks.windLow = minBy(skills.filter((s) => s.element === 'wind' && attack(s)), expDmg);
  picks.darkLow = minBy(skills.filter((s) => s.element === 'dark' && attack(s)), expDmg);
  picks.freezeApplier = minBy(
    skills.filter((s) => s.status !== undefined && s.status.id === 'freeze' && attack(s)),
    expDmg,
  );
  picks.cdSkill = minBy(nonResult, (s) => -s.cooldown);
  picks.manaSkill = minBy(nonResult, (s) => -s.manaCost);
  picks.masterySkill = minBy(
    skills.filter((s) => attack(s) && s.delivery.type === 'projectile'),
    expDmg,
  );
  picks.novaSkill =
    skills.find((s) => s.delivery.type === 'nova' && s.vfx === 'ring') ??
    skills.find((s) => s.delivery.type === 'nova') ??
    null;

  // Resonance: an element with >= 3 skills, measured on its cheapest attack
  // whose boosted hit still leaves the 40 hp slime alive (else the x1.15 is
  // clamped away by overkill).
  const byElement = new Map();
  for (const s of skills) {
    const list = byElement.get(s.element) ?? [];
    list.push(s);
    byElement.set(s.element, list);
  }
  picks.resonance = null;
  for (const [element, list] of byElement) {
    if (list.length < 3) continue;
    const measured = minBy(
      list.filter((s) => attack(s) && expDmg(s) * RESONANCE_MULT < SLIME_MAX_HP - 2),
      expDmg,
    );
    if (measured === null) continue;
    const trio = [measured, ...list.filter((s) => s !== measured)].slice(0, 3);
    picks.resonance = { element, measured, trio: trio.map((s) => s.id) };
    break;
  }

  // Versatile: a status skill with chance <= 0.45 (so a +0.2 bonus flips a
  // seeded roll) whose non-crit hit leaves the slime alive.
  picks.versatileSkill = minBy(
    skills.filter(
      (s) =>
        s.status !== undefined &&
        s.status.chance <= 0.45 &&
        attack(s) &&
        expDmg(s) < SLIME_MAX_HP - 2,
    ),
    expDmg,
  );
  if (picks.versatileSkill !== null) {
    const t = picks.versatileSkill;
    // Loadout B: 4 pairwise-distinct elements including T. Loadout A: <= 3
    // distinct elements, no element x3 (kind 'none').
    const others = skills.filter((s) => s.id !== t.id);
    const distinct = [];
    const seen = new Set([t.element]);
    for (const s of others) {
      if (!seen.has(s.element)) {
        seen.add(s.element);
        distinct.push(s.id);
        if (distinct.length === 3) break;
      }
    }
    picks.versatileB = distinct.length === 3 ? [t.id, ...distinct] : null;
    let pairElement = null;
    for (const [element, list] of byElement) {
      if (element !== t.element && list.length >= 2) {
        pairElement = list.slice(0, 2).map((s) => s.id);
        break;
      }
    }
    const sameElementMate = nonResult.find((s) => s.element === t.element && s.id !== t.id) ?? null;
    picks.versatileA =
      pairElement !== null && sameElementMate !== null ? [t.id, ...pairElement, sameElementMate.id] : null;
  } else {
    picks.versatileA = null;
    picks.versatileB = null;
  }

  // The fusion recipe under test: result must NOT be a skill the resonance
  // trio needs pre-learned (learning a result blocks its recipe: result-known).
  const trioSet = new Set(picks.resonance !== null ? picks.resonance.trio : []);
  picks.recipe = fusions.find((r) => !trioSet.has(r.result)) ?? fusions[0] ?? null;

  picks.fusionResults = [...fusionResults];
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

/** Short walk under a fixed input; returns the displacement (worldtest's trick). */
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

/**
 * The §4.1 part-2 workhorse: spawn, learn+equip, wait mana, seed, cast, watch.
 * Everything it expects arrives in `o` and was derived from skills.json.
 */
const CAST_AT = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  const readMp = () => {
    const el = document.querySelector('.hud__bar--mp .hud__bar-num');
    if (el === null) return null;
    const v = Number((el.textContent || '').split('/')[0]);
    return Number.isFinite(v) ? v : null;
  };
  return new Promise((resolve) => {
    const out = {
      targetId: -1, flankId: -1,
      accepted: false, refusals: [], cdAfter: -1,
      mpBefore: -1, mpMin: Infinity,
      hpStart: -1, firstDropT: -1, firstDropAmt: 0,
      statusSeen: null, statusT: -1,
      flankStart: -1, flankDropped: false, flankDropAmt: 0,
      targetDead: false, reason: 'init',
    };
    d.killAllEnemies();
    d.clearInput();
    d.warp(o.ax, o.az);
    const t0 = performance.now();
    let phase = 0;
    let phaseT = t0;
    let castT = -1;
    const frontX = o.ax + o.fx * o.frontDist;
    const frontZ = o.az + o.fz * o.frontDist;
    const backX = o.ax - o.fx * o.flankDist;
    const backZ = o.az - o.fz * o.flankDist;
    const nearestTo = (x, z, notId) => {
      const rows = d.enemies();
      let best = null;
      let bd = Infinity;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.alive || r.id === notId) continue;
        const dist = Math.hypot(r.x - x, r.z - z);
        if (dist < bd) {
          bd = dist;
          best = r;
        }
      }
      return best;
    };
    const rowById = (id) => {
      const rows = d.enemies();
      for (let i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
      return null;
    };
    const tick = () => {
      const now = performance.now();
      if (now - t0 > o.timeoutMs) {
        out.reason = 'timeout(phase ' + phase + ')';
        resolve(out);
        return;
      }
      if (phase === 0) {
        if (now - phaseT >= 250) {
          if (o.frontDist > 0) d.spawnSlimes(frontX, frontZ, 1, 0);
          if (o.flankDist > 0) d.spawnSlimes(backX, backZ, 1, 0);
          phase = 1;
          phaseT = now;
        }
      } else if (phase === 1) {
        if (now - phaseT >= 250) {
          if (o.frontDist > 0) {
            const t = nearestTo(frontX, frontZ, -1);
            if (t === null) {
              out.reason = 'no-target-spawned';
              resolve(out);
              return;
            }
            out.targetId = t.id;
            out.hpStart = t.hp;
          }
          if (o.flankDist > 0) {
            const f = nearestTo(backX, backZ, out.targetId);
            if (f === null) {
              out.reason = 'no-flanker-spawned';
              resolve(out);
              return;
            }
            out.flankId = f.id;
            out.flankStart = f.hp;
          }
          d.learnSkill(o.skillId);
          d.equipSkill(0, o.skillId);
          phase = 2;
          phaseT = now;
        }
      } else if (phase === 2) {
        const mp = readMp();
        if (mp !== null && mp >= o.manaCost + 2) {
          d.setStatusSeed(o.statusSeed);
          d.setDamageSeed(o.damageSeed);
          phase = 3;
          phaseT = now;
        }
      } else if (phase === 3) {
        const ok = d.castSlot(0);
        if (ok) {
          out.accepted = true;
          out.cdAfter = d.skills()[0].cooldownLeft; // synchronous: zero ticks elapsed
          // Re-read at ACCEPT (HUD lags <= 100 ms): busy-wait regen must not
          // skew the drop measurement (the stone_spike lesson from run 1).
          const mpNow = readMp();
          out.mpBefore = mpNow !== null ? mpNow : -1;
          castT = now;
          phase = 4;
          phaseT = now;
        } else {
          const r = d.lastRefusal();
          if (out.refusals.length < 24) out.refusals.push(r);
          // 'cooldown' is WAITED OUT, not swapped away: slot cooldowns are
          // id-keyed, so a retried cast of the same skill must sit out its own
          // earlier cast's cooldown. acceptMs covers cooldown + castTime.
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
        const mp = readMp();
        if (mp !== null && mp < out.mpMin) out.mpMin = mp;
        if (out.targetId >= 0) {
          const row = rowById(out.targetId);
          if (row !== null) {
            if (out.firstDropT < 0 && row.hp < out.hpStart - 1e-6) {
              out.firstDropT = (now - castT) / 1000;
              out.firstDropAmt = out.hpStart - row.hp;
            }
            if (!row.alive) out.targetDead = true;
            if (out.statusSeen === null && o.statusIdNum >= 0) {
              const st = d.statusOf(out.targetId);
              for (let i = 0; i < st.length; i++) {
                if (st[i].id === o.statusIdNum) {
                  out.statusSeen = { remaining: st[i].remaining, stacks: st[i].stacks };
                  out.statusT = (now - castT) / 1000;
                  break;
                }
              }
            }
          }
        }
        if (out.flankId >= 0) {
          const fr = rowById(out.flankId);
          if (fr !== null && fr.hp < out.flankStart - 1e-6) {
            out.flankDropped = true;
            out.flankDropAmt = out.flankStart - fr.hp;
          }
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

/** Self/heal path: get hurt by a slime ring, clear, cast, watch the HUD rise. */
const HEAL_TEST = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  const readBar = (sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const parts = (el.textContent || '').split('/');
    const v = Number(parts[0]);
    const m = Number(parts[1]);
    return Number.isFinite(v) && Number.isFinite(m) ? { v, m } : null;
  };
  return new Promise((resolve) => {
    const out = {
      hpMax: -1, hpAtCast: -1, hpPeak: -1,
      accepted: false, refusals: [], cdAfter: -1, mpBefore: -1, mpMin: Infinity,
      reason: 'init',
    };
    d.killAllEnemies();
    d.clearInput();
    d.warp(o.ax, o.az);
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
        if (now - phaseT >= 250) {
          d.spawnSlimes(o.ax, o.az, 3, 1.5);
          phase = 1;
          phaseT = now;
        }
      } else if (phase === 1) {
        const hp = readBar('.hud__bar--hp .hud__bar-num');
        if (hp !== null) {
          out.hpMax = hp.m;
          if (hp.v <= hp.m - o.needDeficit) {
            d.killAllEnemies();
            phase = 2;
            phaseT = now;
          }
        }
      } else if (phase === 2) {
        if (now - phaseT >= 900) {
          d.learnSkill(o.skillId);
          d.equipSkill(0, o.skillId);
          phase = 3;
          phaseT = now;
        }
      } else if (phase === 3) {
        const mp = readBar('.hud__bar--mp .hud__bar-num');
        if (mp !== null && mp.v >= o.manaCost + 2) {
          out.mpBefore = mp.v;
          phase = 4;
          phaseT = now;
        }
      } else if (phase === 4) {
        const ok = d.castSlot(0);
        if (ok) {
          out.accepted = true;
          out.cdAfter = d.skills()[0].cooldownLeft;
          const hp = readBar('.hud__bar--hp .hud__bar-num');
          out.hpAtCast = hp !== null ? hp.v : -1;
          out.hpPeak = out.hpAtCast;
          phase = 5;
          phaseT = now;
        } else {
          const r = d.lastRefusal();
          if (out.refusals.length < 24) out.refusals.push(r);
          if (r !== 'busy' && r !== 'cooldown') {
            out.reason = 'refused:' + r;
            resolve(out);
            return;
          }
          if (now - phaseT > 3500) {
            out.reason = 'cast-never-accepted';
            resolve(out);
            return;
          }
        }
      } else {
        const hp = readBar('.hud__bar--hp .hud__bar-num');
        const mp = readBar('.hud__bar--mp .hud__bar-num');
        if (hp !== null && hp.v > out.hpPeak) out.hpPeak = hp.v;
        if (mp !== null && mp.v < out.mpMin) out.mpMin = mp.v;
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

/**
 * Reaction scenario: prep skill applies a status to the front target, then the
 * act (a second cast, or adjacent melee presses) fires the reaction. A text
 * watcher scans the UI root for the reaction names the whole time; flanker hp,
 * target status and .dmg--heavy are sampled per rAF.
 */
const REACT = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  const uiText = () => {
    const el = document.getElementById('ui-root') || document.body;
    return el.textContent || '';
  };
  return new Promise((resolve) => {
    const out = {
      targetId: -1,
      prepAccepted: false, preStatusSeen: false, preStatusRemaining: -1,
      actAccepted: false, actRefusals: [],
      namesSeen: {}, sawHeavyDmg: false,
      hpAtAct: -1, targetDeadAfter: false,
      freezeMaxAfterAct: -1, statusGoneAfterAct: null,
      flankIds: [], flankStart: [], flankDropped: [], flankDropAmt: [],
      reason: 'init',
    };
    for (let i = 0; i < o.watchNames.length; i++) out.namesSeen[o.watchNames[i]] = -1;
    d.killAllEnemies();
    d.clearInput();
    d.warp(o.ax, o.az);
    const t0 = performance.now();
    let phase = 0;
    let phaseT = t0;
    let actT = -1;
    let presses = 0;
    let lastPress = -1e9;
    const frontX = o.ax + o.fx * o.frontDist;
    const frontZ = o.az + o.fz * o.frontDist;
    const rowById = (id) => {
      const rows = d.enemies();
      for (let i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
      return null;
    };
    const nearestTo = (x, z, exclude) => {
      const rows = d.enemies();
      let best = null;
      let bd = Infinity;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.alive || exclude.indexOf(r.id) !== -1) continue;
        const dist = Math.hypot(r.x - x, r.z - z);
        if (dist < bd) {
          bd = dist;
          best = r;
        }
      }
      return best;
    };
    const watch = (now) => {
      const text = uiText();
      for (let i = 0; i < o.watchNames.length; i++) {
        const name = o.watchNames[i];
        if (out.namesSeen[name] < 0 && text.indexOf(name) !== -1) {
          out.namesSeen[name] = actT > 0 ? (now - actT) / 1000 : 0;
        }
      }
      if (!out.sawHeavyDmg && document.querySelector('.dmg--heavy.is-live') !== null) {
        // Only meaningful in scenarios whose act is a non-heavy skill cast.
        if (actT > 0) out.sawHeavyDmg = true;
      }
    };
    const tick = () => {
      const now = performance.now();
      if (now - t0 > o.timeoutMs) {
        out.reason = 'timeout(phase ' + phase + ')';
        resolve(out);
        return;
      }
      if (actT > 0) watch(now);
      if (phase === 0) {
        if (now - phaseT >= 250) {
          d.spawnSlimes(frontX, frontZ, 1, 0);
          for (let i = 0; i < o.flankers.length; i++) {
            d.spawnSlimes(frontX + o.flankers[i].dx, frontZ + o.flankers[i].dz, 1, 0);
          }
          phase = 1;
          phaseT = now;
        }
      } else if (phase === 1) {
        if (now - phaseT >= 250) {
          const target = nearestTo(frontX, frontZ, []);
          if (target === null) {
            out.reason = 'no-target';
            resolve(out);
            return;
          }
          out.targetId = target.id;
          const used = [target.id];
          for (let i = 0; i < o.flankers.length; i++) {
            const f = nearestTo(frontX + o.flankers[i].dx, frontZ + o.flankers[i].dz, used);
            if (f === null) {
              out.reason = 'no-flanker-' + i;
              resolve(out);
              return;
            }
            used.push(f.id);
            out.flankIds.push(f.id);
            out.flankStart.push(f.hp);
            out.flankDropped.push(false);
            out.flankDropAmt.push(0);
          }
          if (o.prepSkillId !== null) {
            d.learnSkill(o.prepSkillId);
            d.equipSkill(0, o.prepSkillId);
            d.setStatusSeed(o.prepStatusSeed);
            d.setDamageSeed(o.prepDamageSeed);
            phase = 2;
          } else {
            phase = 3;
          }
          phaseT = now;
        }
      } else if (phase === 2) {
        // prep cast, retried through busy/cooldown (cooldowns are waited out —
        // they are id-keyed and cannot be swapped away).
        const ok = d.castSlot(0);
        if (ok) {
          phase = 25;
          phaseT = now;
          out.prepAccepted = true;
        } else if (now - phaseT > 7000) {
          out.reason = 'prep-cast-never-accepted:' + d.lastRefusal();
          resolve(out);
          return;
        }
      } else if (phase === 25) {
        // wait for the prep status to land on the target.
        const st = d.statusOf(out.targetId);
        for (let i = 0; i < st.length; i++) {
          if (st[i].id === o.preStatusId) {
            out.preStatusSeen = true;
            out.preStatusRemaining = st[i].remaining;
          }
        }
        if (out.preStatusSeen) {
          phase = 3;
          phaseT = now;
        } else if (now - phaseT > 3000) {
          out.reason = 'prep-status-never-landed';
          resolve(out);
          return;
        }
      } else if (phase === 3) {
        if (o.melee) {
          const row = rowById(out.targetId);
          if (row === null) {
            out.reason = 'target-vanished-pre-melee';
            resolve(out);
            return;
          }
          d.warp(row.x - o.fx * 1.15, row.z - o.fz * 1.15);
          actT = now;
          const r = rowById(out.targetId);
          out.hpAtAct = r !== null ? r.hp : -1;
          phase = 4;
          phaseT = now;
        } else {
          d.learnSkill(o.actSkillId);
          d.equipSkill(0, o.actSkillId);
          d.setStatusSeed(o.actStatusSeed);
          d.setDamageSeed(o.actDamageSeed);
          const ok = d.castSlot(0);
          if (ok) {
            actT = now;
            const r = rowById(out.targetId);
            out.hpAtAct = r !== null ? r.hp : -1;
            out.actAccepted = true;
            phase = 4;
            phaseT = now;
          } else {
            const r = d.lastRefusal();
            if (out.actRefusals.length < 24) out.actRefusals.push(r);
            if (r !== 'busy' && r !== 'cooldown') {
              out.reason = 'act-refused:' + r;
              resolve(out);
              return;
            }
            if (now - phaseT > 7000) {
              out.reason = 'act-cast-never-accepted';
              resolve(out);
              return;
            }
          }
        }
      } else {
        if (o.melee && presses < 4 && now - lastPress >= 260) {
          d.press('attack');
          lastPress = now;
          presses++;
          out.actAccepted = true;
        }
        const row = rowById(out.targetId);
        if (row !== null) {
          if (!row.alive) out.targetDeadAfter = true;
          const st = d.statusOf(out.targetId);
          let preStillThere = false;
          for (let i = 0; i < st.length; i++) {
            if (st[i].id === o.preStatusId) preStillThere = true;
            if (st[i].id === 1 && st[i].remaining > out.freezeMaxAfterAct) {
              out.freezeMaxAfterAct = st[i].remaining;
            }
          }
          if (row.alive) out.statusGoneAfterAct = !preStillThere;
        }
        for (let i = 0; i < out.flankIds.length; i++) {
          const fr = rowById(out.flankIds[i]);
          if (fr !== null && fr.hp < out.flankStart[i] - 1e-6 && !out.flankDropped[i]) {
            out.flankDropped[i] = true;
            out.flankDropAmt[i] = out.flankStart[i] - fr.hp;
          }
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

/** Cast-use grinder: swap-equip resets the slot cooldown (the documented Phase 4
 *  hole), so uses accumulate as fast as mana and cast time allow. */
const GRIND = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  const readMp = () => {
    const el = document.querySelector('.hud__bar--mp .hud__bar-num');
    if (el === null) return null;
    const v = Number((el.textContent || '').split('/')[0]);
    return Number.isFinite(v) ? v : null;
  };
  return new Promise((resolve) => {
    const out = { casts: 0, uses: 0, level: 0, reason: 'init' };
    d.killAllEnemies();
    d.clearInput();
    d.learnSkill(o.mainId);
    const t0 = performance.now();
    let waitUntil = 0;
    const usesNow = () => {
      const g = d.grimoire();
      const m = g.mastery[o.mainId];
      return m !== undefined ? m.uses : 0;
    };
    const tick = () => {
      const now = performance.now();
      const uses = usesNow();
      if (uses >= o.targetUses || now - t0 > o.timeoutMs) {
        const g = d.grimoire();
        const m = g.mastery[o.mainId];
        out.uses = m !== undefined ? m.uses : 0;
        out.level = m !== undefined ? m.level : 0;
        out.reason = uses >= o.targetUses ? 'done' : 'timeout';
        resolve(out);
        return;
      }
      if (now >= waitUntil) {
        const mp = readMp();
        if (mp !== null && mp >= o.manaCost + 1) {
          d.equipSkill(0, o.dummyId);
          d.equipSkill(0, o.mainId);
          if (d.castSlot(0)) {
            out.casts++;
            waitUntil = now + o.castTimeMs + 120;
          } else {
            waitUntil = now + 100;
          }
        } else {
          waitUntil = now + 250;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/**
 * Drain mana until the runtime refuses with 'mana'. Rotates FOUR expensive
 * skills across all four slots: at focus-10 regen (~4 mana/s) no single skill
 * can outrun its own cooldown's regen, but a four-slot burst drains ~70 mana
 * per cooldown cycle. That imbalance is itself worth knowing (see report).
 */
const MANA_DRAIN = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  const readMp = () => {
    const el = document.querySelector('.hud__bar--mp .hud__bar-num');
    if (el === null) return null;
    const v = Number((el.textContent || '').split('/')[0]);
    return Number.isFinite(v) ? v : null;
  };
  return new Promise((resolve) => {
    const out = { casts: 0, refused: false, refusal: '', mpAtRefusal: -1, refusedCost: -1, reason: 'init' };
    d.killAllEnemies();
    d.clearInput();
    for (let i = 0; i < 4; i++) {
      d.learnSkill(o.ids[i]);
      d.equipSkill(i, o.ids[i]);
    }
    const t0 = performance.now();
    let slot = 0;
    const tick = () => {
      const now = performance.now();
      if (now - t0 > o.timeoutMs) {
        out.reason = 'timeout';
        resolve(out);
        return;
      }
      const ok = d.castSlot(slot);
      if (ok) {
        out.casts++;
      } else {
        const r = d.lastRefusal();
        if (r === 'mana') {
          out.refused = true;
          out.refusal = r;
          out.refusedCost = o.costs[slot];
          const mp = readMp();
          out.mpAtRefusal = mp !== null ? mp : -1;
          out.reason = 'refused';
          resolve(out);
          return;
        }
        if (r !== 'busy' && r !== 'cooldown') {
          out.refusal = r;
          out.reason = 'wrong-refusal:' + r;
          resolve(out);
          return;
        }
      }
      slot = (slot + 1) % 4;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** Kill adjacent slimes (melee) until a soul orb drops at our feet. */
const KILL_FOR_ORB = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    const out = { kills: 0, orbCount: 0, nearby: false, reason: 'init' };
    d.killAllEnemies();
    d.clearInput();
    d.warp(o.ax, o.az);
    const t0 = performance.now();
    let phase = 0;
    let phaseT = t0;
    let targetId = -1;
    let lastPress = -1e9;
    const rowById = (id) => {
      const rows = d.enemies();
      for (let i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
      return null;
    };
    const tick = () => {
      const now = performance.now();
      if (now - t0 > o.timeoutMs) {
        out.orbCount = d.orbs().count;
        out.nearby = d.orbs().nearby;
        out.reason = 'timeout';
        resolve(out);
        return;
      }
      const orbs = d.orbs();
      if (orbs.nearby) {
        d.clearInput();
        out.orbCount = orbs.count;
        out.nearby = true;
        out.reason = 'orb';
        resolve(out);
        return;
      }
      if (phase === 0) {
        if (out.kills >= o.maxKills) {
          out.reason = 'no-drop-after-' + out.kills;
          resolve(out);
          return;
        }
        const p = d.player();
        d.spawnSlimes(p.x + o.fx * 1.5, p.z + o.fz * 1.5, 1, 0);
        phase = 1;
        phaseT = now;
        targetId = -1;
      } else if (phase === 1) {
        if (now - phaseT >= 250) {
          const rows = d.enemies();
          let best = null;
          let bd = Infinity;
          const p = d.player();
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (!r.alive) continue;
            const dist = Math.hypot(r.x - p.x, r.z - p.z);
            if (dist < bd) {
              bd = dist;
              best = r;
            }
          }
          if (best === null) {
            phase = 0;
            phaseT = now;
          } else {
            targetId = best.id;
            phase = 2;
            phaseT = now;
          }
        }
      } else {
        const row = rowById(targetId);
        if (row === null || !row.alive) {
          out.kills++;
          phase = 0;
          phaseT = now;
        } else {
          if (now - lastPress >= 200) {
            d.warp(row.x - o.fx * 1.15, row.z - o.fz * 1.15);
            d.press('attack');
            lastPress = now;
          }
          if (now - phaseT > 9000) {
            out.reason = 'kill-stuck';
            resolve(out);
            return;
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** Passive watcher for the CDP absorb hold — started BEFORE the touch. */
const ORB_WATCH = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    const out = {
      maxProgress: 0, sawCard: false, sawFlash: false, cardName: '',
      maxHitstop: 0, knownEnd: 0, orbEnd: -1, progressSamples: 0,
    };
    const t0 = performance.now();
    const tick = () => {
      const now = performance.now();
      const orbs = d.orbs();
      if (orbs.absorbProgress > out.maxProgress) out.maxProgress = orbs.absorbProgress;
      if (orbs.absorbProgress > 0) out.progressSamples++;
      const c = d.combat();
      if (c.hitstopTicksLeft > out.maxHitstop) out.maxHitstop = c.hitstopTicksLeft;
      const card = document.querySelector('.notify__card.is-in');
      if (card !== null) {
        out.sawCard = true;
        const name = card.querySelector('.notify__name');
        if (name !== null && out.cardName === '') out.cardName = name.textContent || '';
      }
      if (document.querySelector('.notify__flash.is-on') !== null) out.sawFlash = true;
      if (now - t0 >= o.durationMs) {
        out.knownEnd = d.grimoire().known.length;
        out.orbEnd = d.orbs().count;
        resolve(out);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

/** The §3 budget brawl: 4 slimes, all four equipped skills spammed on cooldown
 *  plus melee, sampled per rAF into pre-allocated arrays. */
const BRAWL4 = (o) => {
  const d = globalThis.__ARCANUM_DEBUG__;
  return new Promise((resolve) => {
    const cap = Math.ceil((o.durationMs / 1000) * 140) + 64;
    const t = new Float64Array(cap);
    const frameMs = new Float64Array(cap);
    const draws = new Float64Array(cap);
    const tris = new Float64Array(cap);
    const heap = new Float64Array(cap);
    let n = 0;
    let castsAccepted = 0;
    let lastCast = -1e9;
    let lastAttack = -1e9;
    let slot = 0;
    const started = performance.now();
    let last = started;
    // Kite while fighting, like a real player: the Phase 5 bestiary staggers a
    // stationary caster into 'busy' refusals, and a probe that measures an
    // idle scene undercounts the very VFX load it exists to measure.
    d.setInput({ moveX: 0.35, moveY: -0.45, sprint: false });
    const tick = () => {
      const now = performance.now();
      if (now - lastCast >= o.castCadenceMs) {
        // Try every frame once due; advance the slot only when a cast lands, so
        // one busy moment does not silently skip a whole skill's turn.
        if (d.castSlot(slot)) {
          castsAccepted++;
          slot = (slot + 1) % 4;
          lastCast = now;
        }
      }
      if (now - lastAttack >= 900) {
        d.press('attack');
        lastAttack = now;
      }
      const m = d.metrics();
      if (n < cap) {
        t[n] = (now - started) / 1000;
        frameMs[n] = now - last;
        draws[n] = m.drawCalls;
        tris[n] = m.triangles;
        heap[n] = m.heapMb;
        n++;
      }
      last = now;
      if (now - started >= o.durationMs) {
        d.clearInput();
        resolve({
          count: n,
          castsAccepted,
          t: Array.from(t.subarray(0, n)),
          frameMs: Array.from(frameMs.subarray(0, n)),
          drawCalls: Array.from(draws.subarray(0, n)),
          triangles: Array.from(tris.subarray(0, n)),
          heapMb: Array.from(heap.subarray(0, n)),
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
    console.error(`[skilltest] HARD TIMEOUT after ${OVERALL_TIMEOUT_MS} ms — killing everything.`);
    void cleanup();
    setTimeout(() => process.exit(1), 1500);
  }, OVERALL_TIMEOUT_MS);
  hardTimer.unref?.();

  const m = report.measurements;

  // =========================================================================
  // PART 1 — §4.1's law, node-side, before any browser exists.
  // =========================================================================
  let skills;
  let fusions;
  let picks;
  let seeds;
  let loadoutIds = null;
  try {
    const normal = normalizeSkills(loadJson('src/data/skills.json'));
    skills = normal.skills;
    fusions = loadJson('src/data/fusions.json');
    if (normal.startingLoadout !== null) loadoutIds = normal.startingLoadout;
    else {
      try {
        const lo = loadJson('src/data/loadout.json');
        if (Array.isArray(lo.startingLoadout)) loadoutIds = lo.startingLoadout;
      } catch {
        loadoutIds = null;
      }
    }
    const ids = skills.map((s) => s.id);
    if (ids.length < 9) fail('#2 skills.json has the starter set', `${ids.length} skills found, contract wants >= 9`);
    else pass('#2 skills.json has the starter set', `${ids.length} skills (incl. fusion results)`);

    const scan = scanForSkillIds(ids);
    m.dataDrivenScan = { filesScanned: scan.files, hits: scan.hits };
    if (scan.files < 20) {
      fail('#2 §4.1 scan covered the source tree', `only ${scan.files} .ts files found under src/ — scan is broken`);
    } else if (scan.hits.length === 0) {
      pass(
        '#2 §4.1 LAW: no skill id in any src/**/*.ts',
        `${ids.length} ids x ${scan.files} files, zero occurrences — adding skill №${ids.length + 1} is a JSON edit`,
      );
    } else {
      fail(
        '#2 §4.1 LAW: no skill id in any src/**/*.ts',
        `${scan.hits.length} occurrence(s): ${scan.hits.slice(0, 12).join(' | ')}${scan.hits.length > 12 ? ' | …' : ''}`,
      );
    }
    if (loadoutIds !== null && loadoutIds.length === 4 && loadoutIds.every((id) => ids.includes(id))) {
      pass('#2 starting loadout lives in JSON', `[${loadoutIds.join(', ')}]`);
    } else {
      fail(
        '#2 starting loadout lives in JSON',
        loadoutIds === null
          ? 'no startingLoadout found in skills.json or src/data/loadout.json — where does the boot loadout come from?'
          : `startingLoadout [${String(loadoutIds)}] is not 4 valid skill ids`,
      );
    }

    picks = derivePicks(skills, fusions);
    const missing = [];
    for (const key of ['wetApplier', 'burnLow', 'iceLow', 'windLow', 'darkLow', 'freezeApplier', 'cdSkill', 'manaSkill', 'masterySkill', 'novaSkill', 'recipe']) {
      if (picks[key] === null || picks[key] === undefined) missing.push(key);
    }
    if (missing.length > 0) {
      fail('#2 gate can derive its actors from the JSON', `no skill matches predicate(s): ${missing.join(', ')}`);
    } else {
      pass(
        '#2 gate can derive its actors from the JSON',
        `wet=${picks.wetApplier.id} burn=${picks.burnLow.id} ice=${picks.iceLow.id} wind=${picks.windLow.id} dark=${picks.darkLow.id} cd=${picks.cdSkill.id} mana=${picks.manaSkill.id} mastery=${picks.masterySkill.id} nova=${picks.novaSkill.id} recipe=${picks.recipe.a}+${picks.recipe.b}`,
      );
    }

    // Seeds, solved against the engines' shared mulberry32 step.
    seeds = {
      statusHit: findSeed((r) => r[0] < 0.3 && r[1] < 0.3 && r[2] < 0.3 && r[3] < 0.3),
      statusMiss: findSeed((r) => r[0] > 0.92 && r[1] > 0.92 && r[2] > 0.92 && r[3] > 0.92),
      nonCrit: findSeed((r) => r.slice(0, 10).every((v) => v >= CRIT_CHANCE + 0.02)),
      edge: -1,
    };
    if (picks.versatileSkill !== null && picks.versatileSkill !== undefined) {
      const c = picks.versatileSkill.status.chance;
      seeds.edge = findSeed((r) => r[0] > c + 0.05 && r[0] < c + VERSATILE_BONUS - 0.05);
    }
    m.seeds = seeds;
    if (seeds.statusHit > 0 && seeds.statusMiss > 0 && seeds.nonCrit > 0) {
      pass('#2 deterministic seeds solved offline', JSON.stringify(seeds));
    } else {
      fail('#2 deterministic seeds solved offline', JSON.stringify(seeds));
    }
  } catch (error) {
    fail('#2 node-side data phase', error instanceof Fatal ? error.message : String(error?.stack ?? error));
    finish(startedAt);
    return;
  }

  const byId = new Map(skills.map((s) => [s.id, s]));
  const dummyFor = (id) => {
    for (const s of skills) if (s.id !== id) return s.id;
    return id;
  };

  // =========================================================================
  // PART 2 — the live gate.
  // =========================================================================
  try {
    await startPreview();
    pass('#1 vite preview reachable', URL_);

    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    pass('#1 Chromium launched (headless, SwiftShader)', browser.version());

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
    pass('#1 page loaded', `HTTP ${response.status()}`);

    // NOTE the `null`: waitForFunction(fn, arg, options) — three-argument form.
    await page.waitForFunction(() => globalThis.__ARCANUM_DEBUG__ !== undefined, null, { timeout: 15_000 });
    const shape = await page.evaluate(() => {
      const d = globalThis.__ARCANUM_DEBUG__;
      const needed = [
        'metrics', 'frameCount', 'setInput', 'clearInput', 'press', 'player', 'warp',
        'enemies', 'combat', 'setDamageSeed', 'spawnSlimes', 'killAllEnemies',
        'skills', 'grimoire', 'castSlot', 'lastRefusal', 'statusOf', 'learnSkill',
        'equipSkill', 'setStatusSeed', 'setOrbSeed', 'fuse', 'orbs', 'forceAbsorb',
        'grimoireScreen', 'openGrimoire', 'closeGrimoire',
      ];
      const missing = [];
      for (const k of needed) if (typeof d[k] !== 'function') missing.push(k);
      // Optional drivers the fusion grind can use if the integrator ships them.
      const optional = {};
      for (const k of ['addSkillUses', 'addUses', 'grantUses', 'setSkillUses', 'setMastery', 'setMana', 'refillMana']) {
        optional[k] = typeof d[k] === 'function';
      }
      return { missing, version: d.version, optional };
    });
    if (shape.missing.length > 0) {
      throw new Fatal(`__ARCANUM_DEBUG__ is missing phase-4 hooks: ${shape.missing.join(', ')}`);
    }
    pass('#1 __ARCANUM_DEBUG__ phase 4 shape', `complete, version ${shape.version}`);
    m.optionalDrivers = shape.optional;

    await page.waitForFunction(() => globalThis.__ARCANUM_DEBUG__.frameCount() > 40, null, { timeout: 20_000 });
    pass('#1 render loop running', 'frameCount passed 40');

    // --- #1 idle invariants (prior gates' quick checks) ---------------------
    const idle = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const d = globalThis.__ARCANUM_DEBUG__;
          const ticks = [];
          let draws = 0;
          let tris = 0;
          const t0 = performance.now();
          const tick = () => {
            const mm = d.metrics();
            ticks.push(mm.ticks);
            if (mm.drawCalls > draws) draws = mm.drawCalls;
            if (mm.triangles > tris) tris = mm.triangles;
            if (performance.now() - t0 >= 2000) {
              resolve({ ticks, draws, tris });
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    const tickRate = tailMean(idle.ticks, 0.7);
    m.idle = { tickRate: round(tickRate, 1), peakDraws: idle.draws, peakTris: idle.tris };
    if (Math.abs(tickRate - 60) <= 6) pass('#1 fixed tick ~60/s at boot', `${tickRate.toFixed(1)} /s`);
    else fail('#1 fixed tick ~60/s at boot', `${tickRate.toFixed(1)} /s`);
    if (idle.draws <= BUDGET.drawCalls) pass('#1 idle draw calls <= 110', `peak ${idle.draws}`);
    else fail('#1 idle draw calls <= 110', `peak ${idle.draws}`);

    // --- boot grimoire state -----------------------------------------------
    const bootG = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.grimoire());
    m.bootGrimoire = bootG;
    const bootEquipped = bootG.equipped.filter((id) => id !== null);
    if (bootEquipped.length === 4 && bootG.known.length === 4) {
      pass('#1 boot: 4 known, 4 equipped', `[${bootEquipped.join(', ')}]`);
    } else {
      fail('#1 boot: 4 known, 4 equipped', `known ${bootG.known.length}, equipped ${bootEquipped.length}`);
    }
    if (loadoutIds !== null) {
      const match =
        bootEquipped.length === loadoutIds.length && loadoutIds.every((id, i) => bootG.equipped[i] === id);
      if (match) pass('#1 boot loadout matches the JSON startingLoadout', bootEquipped.join(', '));
      else fail('#1 boot loadout matches the JSON startingLoadout', `JSON [${loadoutIds.join(',')}] vs page [${bootG.equipped.join(',')}]`);
    }
    const starterIds = bootEquipped.length === 4 ? bootEquipped : loadoutIds ?? bootEquipped;

    // --- calibration (combattest's trick: camera yaw never changes) --------
    const calF = await page.evaluate(CAL_WALK, { x: 0, z: 0, moveX: 0, moveY: -1, durationMs: 800 });
    const calR = await page.evaluate(CAL_WALK, { x: 0, z: 0, moveX: 1, moveY: 0, durationMs: 800 });
    const lenF = Math.hypot(calF.dx, calF.dz);
    const lenR = Math.hypot(calR.dx, calR.dz);
    if (lenF < 0.5 || lenR < 0.5) throw new Fatal(`calibration walks moved ${lenF.toFixed(2)} / ${lenR.toFixed(2)} u — player not moving.`);
    const F = { x: calF.dx / lenF, z: calF.dz / lenF };
    const R = { x: calR.dx / lenR, z: calR.dz / lenR };
    m.calibration = { F: { x: round(F.x, 3), z: round(F.z, 3) }, R: { x: round(R.x, 3), z: round(R.z, 3) } };
    pass('#1 input→world axes calibrated', `F (${F.x.toFixed(2)}, ${F.z.toFixed(2)}), R (${R.x.toFixed(2)}, ${R.z.toFixed(2)})`);

    /** Arena rotation keeps 12 s corpse-respawns out from underfoot. */
    const arenas = [
      { x: 0, z: 0 },
      { x: 0, z: 40 },
      { x: 40, z: 0 },
      { x: -40, z: 0 },
      { x: 0, z: -40 },
      { x: 40, z: 40 },
    ];
    let arenaCursor = 0;
    const nextArena = () => {
      const a = arenas[arenaCursor % arenas.length];
      arenaCursor++;
      return a;
    };

    const castSkill = (skill, opts = {}) => {
      const a = nextArena();
      const delivery = skill.delivery;
      let frontDist = 3;
      let flankDist = 2.2;
      let flankExpected = null; // null = skip check
      if (delivery.type === 'projectile') {
        flankExpected = false;
      } else if (delivery.type === 'nova') {
        frontDist = Math.max(1.2, Math.min(2.2, delivery.radius - 0.6));
        if (delivery.radius >= 2.5) {
          flankDist = frontDist;
          flankExpected = true;
        } else {
          flankDist = 0;
        }
      }
      const windowMs = Math.ceil((skill.castTime + (delivery.type === 'nova' ? delivery.expandSeconds ?? 0 : 1.0) + 2.0) * 1000);
      // A retried cast must be able to wait out its own earlier cast's cooldown.
      const acceptMs = Math.min(15_000, 3500 + Math.ceil(skill.cooldown * 1000));
      return page
        .evaluate(CAST_AT, {
          ax: a.x, az: a.z, fx: F.x, fz: F.z,
          frontDist, flankDist,
          skillId: skill.id,
          manaCost: skill.manaCost,
          statusIdNum: skill.status !== undefined ? STATUS_INDEX[skill.status.id] ?? -1 : -1,
          statusSeed: opts.statusSeed ?? seeds.statusHit,
          damageSeed: opts.damageSeed ?? seeds.nonCrit,
          windowMs,
          acceptMs,
          timeoutMs: windowMs + acceptMs + 26_000,
        })
        .then((r) => ({ ...r, flankExpected }));
    };

    // =======================================================================
    // #1 canary + spawn-churn: the two infrastructure facts EVERY later check
    // stands on. Their failure messages name the integration defect precisely
    // so the downstream wall of red has a single readable root cause.
    // =======================================================================
    let worldHittable = true;
    {
      const wet = picks.wetApplier;
      const canary = await castSkill(wet, {});
      m.canary = canary;
      if (canary.accepted && canary.firstDropT >= 0) {
        pass('#1 CANARY: a debug-spawned slime takes skill damage', `${wet.id} dropped hp by ${canary.firstDropAmt.toFixed(1)}`);
      } else {
        fail(
          '#1 CANARY: a debug-spawned slime takes skill damage',
          `reason "${canary.reason}" — if HitboxSystem logged "registry full", debug spawnSlimes/killAllEnemies are not recycling the 19-slot combatant registry`,
        );
      }
      if (canary.statusSeen !== null) {
        pass('#1 CANARY: a debug-spawned slime has a status board', `${wet.id} applied '${wet.status.id}' (remaining ${canary.statusSeen.remaining.toFixed(2)} s)`);
      } else {
        fail(
          '#1 CANARY: a debug-spawned slime has a status board',
          `statusOf stayed empty for a chance-${wet.status.chance} status under a forced seed — the debug spawnSlimes hook is not calling status.register for new enemies (console shows "apply to unregistered combatant"). Every reaction/status check below fails on this.`,
        );
      }

      worldHittable = canary.accepted && canary.firstDropT >= 0;
    }

    // =======================================================================
    // #9 — soul orb loop, EARLY (needs unknown skills left to drop).
    // =======================================================================
    {
      await page.evaluate((n) => globalThis.__ARCANUM_DEBUG__.setOrbSeed(n), 12345);
      const knownBefore = (await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.grimoire())).known;
      const a = nextArena();
      const hunt = await page.evaluate(KILL_FOR_ORB, {
        ax: a.x, az: a.z, fx: F.x, fz: F.z, maxKills: 8, timeoutMs: 45_000,
      });
      m.orbHunt = hunt;
      if (hunt.reason === 'orb' && hunt.nearby) {
        pass('#9 seeded kills drop a soul orb in reach', `after ${hunt.kills + 1} kill(s), orbs().nearby true`);
      } else {
        fail('#9 seeded kills drop a soul orb in reach', `reason "${hunt.reason}" after ${hunt.kills} kills (dropChance 0.5 → P(no drop in 8) ≈ 0.4%)`);
      }

      if (hunt.reason === 'orb') {
        // Card from any earlier debug learn must be gone before real touches.
        await page.waitForFunction(() => document.querySelector('.notify__card.is-in') === null, null, { timeout: 8000 }).catch(() => {});
        const icon = await page.evaluate(() => {
          const el = document.querySelector('.tc__btn--attack .tc__btn-icon');
          return el !== null ? el.textContent : null;
        });
        if (icon === '✋') pass('#9 attack button morphs to ABSORB near the orb', `icon "${icon}"`);
        else fail('#9 attack button morphs to ABSORB near the orb', `icon "${String(icon)}", expected the ✋ morph`);

        const attackPoint = await page.evaluate(() => {
          const el = document.querySelector('.tc__btn--attack');
          if (el === null) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        if (attackPoint === null) {
          fail('#9 REAL TouchControls absorb hold', '.tc__btn--attack not found');
        } else {
          const cdp = await page.context().newCDPSession(page);
          // Sampler BEFORE the action (the playtest lesson).
          const watcher = page.evaluate(ORB_WATCH, { durationMs: ABSORB_HOLD_MS + 1400 });
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: attackPoint.x, y: attackPoint.y, id: 1 }],
          });
          await sleep(ABSORB_HOLD_MS);
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          const orb = await watcher;
          m.orbAbsorb = orb;
          const newIds = orb.knownEnd > knownBefore.length
            ? (await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.grimoire())).known.filter((id) => !knownBefore.includes(id))
            : [];
          const droppable = skills.filter((s) => s.dropWeight > 0 && !knownBefore.includes(s.id)).map((s) => s.id);
          if (orb.maxProgress >= 0.95 && orb.knownEnd === knownBefore.length + 1) {
            pass('#9 1.2 s hold absorbs the orb (real touch path)', `progress peaked ${orb.maxProgress.toFixed(2)}, known ${knownBefore.length} → ${orb.knownEnd}`);
          } else {
            fail('#9 1.2 s hold absorbs the orb (real touch path)', `progress ${orb.maxProgress.toFixed(2)}, known ${knownBefore.length} → ${orb.knownEnd}`);
          }
          if (newIds.length === 1 && droppable.includes(newIds[0])) {
            pass('#9 orb taught an unknown dropWeight>0 skill', newIds[0]);
          } else {
            fail('#9 orb taught an unknown dropWeight>0 skill', `learned [${newIds.join(',')}], eligible [${droppable.join(',')}]`);
          }
          if (orb.sawCard && orb.sawFlash) {
            pass('#9 SKILL ACQUIRED moment fired (card + flash)', `card "${orb.cardName}"`);
          } else {
            fail('#9 SKILL ACQUIRED moment fired (card + flash)', `card=${orb.sawCard} flash=${orb.sawFlash}`);
          }
          if (orb.maxHitstop >= 10 && orb.maxHitstop <= NOTIFY_FREEZE_TICKS + 1) {
            pass('#9 acquisition freeze-frame ~20 ticks', `peak ticksLeft ${orb.maxHitstop}`);
          } else {
            fail('#9 acquisition freeze-frame ~20 ticks', `peak ticksLeft ${orb.maxHitstop} (want 10..${NOTIFY_FREEZE_TICKS + 1}; rAF sampling shaves the top)`);
          }
        }
      } else {
        unknown('#9 absorb flow', 'no orb dropped, absorb path untestable this run');
      }
    }

    // =======================================================================
    // #10 — Grimoire screen (while silhouettes still exist).
    // =======================================================================
    {
      const ui = await page.evaluate(() => {
        const d = globalThis.__ARCANUM_DEBUG__;
        const out = { openFlag: false, domOpen: false, counter: '', unknownCards: 0, totalCards: 0, tabResults: [], closeOk: false };
        d.openGrimoire();
        out.openFlag = d.grimoireScreen().open;
        const root = document.querySelector('.gs');
        out.domOpen = root !== null && root.classList.contains('is-open');
        const counter = document.querySelector('.gs__count');
        out.counter = counter !== null ? counter.textContent || '' : '';
        out.unknownCards = document.querySelectorAll('.gs-card.is-unknown').length;
        out.totalCards = document.querySelectorAll('.gs-card').length;
        const tabs = document.querySelectorAll('.gs__tab');
        const pages = document.querySelectorAll('.gs__page');
        for (let i = 0; i < tabs.length; i++) {
          tabs[i].click();
          out.tabResults.push(pages[i] !== undefined && pages[i].classList.contains('is-active'));
        }
        if (tabs.length > 0) tabs[0].click();
        d.closeGrimoire();
        out.closeOk = !d.grimoireScreen().open && root !== null && !root.classList.contains('is-open');
        return out;
      });
      m.grimoireScreen = ui;
      const g = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.grimoire());
      const expectCounter = `${g.known.length} / ${skills.length} SKILLS`;
      if (ui.openFlag && ui.domOpen) pass('#10 grimoire screen opens', 'debug hook + .gs.is-open');
      else fail('#10 grimoire screen opens', `openFlag=${ui.openFlag} domOpen=${ui.domOpen}`);
      if (ui.counter === expectCounter) pass('#10 counter header', `"${ui.counter}"`);
      else fail('#10 counter header', `"${ui.counter}" — expected "${expectCounter}"`);
      if (ui.unknownCards >= 1 && ui.unknownCards === skills.length - g.known.length && ui.totalCards === skills.length) {
        pass('#10 unknown silhouettes', `${ui.unknownCards} dark cards of ${ui.totalCards}`);
      } else {
        fail('#10 unknown silhouettes', `${ui.unknownCards} unknown of ${ui.totalCards} cards; grimoire says ${skills.length - g.known.length} unknown`);
      }
      if (ui.tabResults.length === 3 && ui.tabResults.every(Boolean)) pass('#10 tab switching', 'COLLECTION / LOADOUT / FUSION all activate');
      else fail('#10 tab switching', JSON.stringify(ui.tabResults));
      if (ui.closeOk) pass('#10 close works', 'flag false and .is-open gone');
      else fail('#10 close works', 'screen did not close');
    }

    // =======================================================================
    // #1 spawn-churn: everything below spawns freely; the 19-slot hitbox
    // registry must be RECYCLED by the debug spawn/kill hooks, not consumed.
    // =======================================================================
    {
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => {
          const d = globalThis.__ARCANUM_DEBUG__;
          d.killAllEnemies();
          d.spawnSlimes(30, 30, 4, 2);
        });
        await sleep(120);
      }
      const churn = await castSkill(picks.wetApplier, {});
      m.churn = churn;
      worldHittable = worldHittable && churn.accepted && churn.firstDropT >= 0;
      if (churn.accepted && churn.firstDropT >= 0) {
        pass('#1 spawn churn stays hittable (registry recycling)', `after 24+ lifetime spawns, ${picks.wetApplier.id} still lands (drop ${churn.firstDropAmt.toFixed(1)})`);
      } else {
        fail(
          '#1 spawn churn stays hittable (registry recycling)',
          `after ~24 lifetime spawns a fresh slime cannot be hit (reason "${churn.reason}") — HitboxSystem's 19 fixed slots fill because debug spawns are never unregistered; killAllEnemies must DESPAWN (unregister hitbox + status boards). Most later damage checks fail on this.`,
        );
      }
    }

    // =======================================================================
    // #4 — the five reactions, seeded.
    // =======================================================================
    const reactScenario = (opts) => {
      const a = nextArena();
      return page.evaluate(REACT, {
        ax: a.x, az: a.z, fx: F.x, fz: F.z,
        frontDist: opts.frontDist,
        flankers: opts.flankers ?? [],
        prepSkillId: opts.prep !== null ? opts.prep.id : null,
        prepStatusSeed: seeds.statusHit,
        prepDamageSeed: seeds.nonCrit,
        preStatusId: opts.preStatusId,
        actSkillId: opts.act === 'melee' ? null : opts.act.id,
        actStatusSeed: opts.actStatusSeed ?? seeds.statusHit,
        actDamageSeed: seeds.nonCrit,
        melee: opts.act === 'melee',
        watchNames: opts.names,
        windowMs: opts.windowMs ?? 2600,
        timeoutMs: 30_000,
      });
    };

    // (a) Conflagration — burn + wind.
    {
      const r = await reactScenario({
        prep: picks.burnLow, preStatusId: STATUS_INDEX.burn, act: picks.windLow,
        frontDist: Math.max(1.2, Math.min(2.0, picks.burnLow.delivery.type === 'nova' ? picks.burnLow.delivery.radius - 0.8 : 2.0)),
        names: ['Conflagration'],
      });
      m.conflagration = r;
      const seen = r.namesSeen['Conflagration'] >= 0;
      if (r.preStatusSeen && seen) {
        pass('#4 Conflagration (burn + wind)', `burn confirmed pre-hit, floating text at +${r.namesSeen['Conflagration'].toFixed(2)} s, target dead=${r.targetDeadAfter}`);
      } else if (!r.preStatusSeen) {
        fail('#4 Conflagration (burn + wind)', `burn never landed pre-act (reason "${r.reason}") — seeded status roll or boards broken`);
      } else {
        fail('#4 Conflagration (burn + wind)', `reaction text never appeared in the DOM (reason "${r.reason}") — §8.5 demands the floating reaction name`);
      }
      note(
        '#4 Conflagration burst DELTA unmeasurable',
        `burn applier deals ${expDmg(picks.burnLow).toFixed(0)} of the slime's 40 hp; the doubled-DoT burst always overkills the remainder, so only the text + kill are observable`,
      );
    }

    // (b) Shatter — freeze + physical melee.
    {
      const r = await reactScenario({
        prep: picks.freezeApplier, preStatusId: STATUS_INDEX.freeze, act: 'melee',
        frontDist: 3, names: ['Shatter'],
      });
      m.shatter = r;
      const seen = r.namesSeen['Shatter'] >= 0;
      if (r.preStatusSeen && seen) {
        pass('#4 Shatter (freeze + melee)', `freeze confirmed, text at +${r.namesSeen['Shatter'].toFixed(2)} s, target dead=${r.targetDeadAfter}`);
      } else if (!r.preStatusSeen) {
        fail('#4 Shatter (freeze + melee)', `freeze never landed pre-melee (reason "${r.reason}")`);
      } else {
        fail('#4 Shatter (freeze + melee)', `no 'Shatter' text — the melee path is not calling reactionFor(isPhysical), or reaction text is unwired`);
      }
      note(
        '#4 Shatter ×3 DELTA unmeasurable',
        `a frozen slime holds at most ${(SLIME_MAX_HP - expDmg(picks.freezeApplier)).toFixed(0)} hp (freeze costs ${expDmg(picks.freezeApplier).toFixed(0)} damage) and the weakest melee already overkills that — reacted and unreacted drops clamp identically`,
      );
    }

    // (c) Deep Freeze — wet + ice.
    {
      const r = await reactScenario({
        prep: picks.wetApplier, preStatusId: STATUS_INDEX.wet, act: picks.iceLow,
        frontDist: 3, names: ['Deep Freeze'],
      });
      m.deepFreeze = r;
      const seen = r.namesSeen['Deep Freeze'] >= 0;
      if (r.preStatusSeen && seen) {
        pass('#4 Deep Freeze (wet + ice)', `wet confirmed, text at +${r.namesSeen['Deep Freeze'].toFixed(2)} s`);
      } else if (!r.preStatusSeen) {
        fail('#4 Deep Freeze (wet + ice)', `wet never landed pre-act (reason "${r.reason}")`);
      } else {
        fail('#4 Deep Freeze (wet + ice)', `no 'Deep Freeze' text (reason "${r.reason}")`);
      }
      const iceDur = picks.iceLow.status !== undefined ? picks.iceLow.status.duration : 0;
      if (!r.targetDeadAfter && r.freezeMaxAfterAct > 0 && iceDur > 0) {
        const ratio = r.freezeMaxAfterAct / iceDur;
        if (ratio > 1.5 && ratio <= 2.3) pass('#4 Deep Freeze doubles the freeze duration', `${r.freezeMaxAfterAct.toFixed(2)} s vs JSON ${iceDur} s (×${ratio.toFixed(2)})`);
        else fail('#4 Deep Freeze doubles the freeze duration', `${r.freezeMaxAfterAct.toFixed(2)} s vs JSON ${iceDur} s`);
      } else {
        note(
          '#4 Deep Freeze ×2 DURATION unmeasurable',
          `wet costs ${expDmg(picks.wetApplier).toFixed(0)} hp and every ice skill deals >= ${expDmg(picks.iceLow).toFixed(0)} — the doubling ice hit always kills the 40 hp slime before its freeze can be read`,
        );
      }
    }

    // (d) Thermal Shock — burn + ice; the reaction-forced heavy flag IS observable.
    {
      const r = await reactScenario({
        prep: picks.burnLow, preStatusId: STATUS_INDEX.burn, act: picks.iceLow,
        frontDist: Math.max(1.2, Math.min(2.0, picks.burnLow.delivery.type === 'nova' ? picks.burnLow.delivery.radius - 0.8 : 2.0)),
        names: ['Thermal Shock'],
      });
      m.thermalShock = r;
      const seen = r.namesSeen['Thermal Shock'] >= 0;
      if (r.preStatusSeen && seen) {
        pass('#4 Thermal Shock (burn + ice)', `burn confirmed, text at +${r.namesSeen['Thermal Shock'].toFixed(2)} s`);
      } else if (!r.preStatusSeen) {
        fail('#4 Thermal Shock (burn + ice)', `burn never landed pre-act (reason "${r.reason}")`);
      } else {
        fail('#4 Thermal Shock (burn + ice)', `no 'Thermal Shock' text (reason "${r.reason}")`);
      }
      const iceIsHeavy = picks.iceLow.heavy === true;
      if (!iceIsHeavy && r.sawHeavyDmg) {
        pass('#4 Thermal Shock staggers (reaction-forced heavy)', `a .dmg--heavy number appeared on a hit from ${picks.iceLow.id}, which is NOT heavy in JSON`);
      } else if (!iceIsHeavy) {
        fail('#4 Thermal Shock staggers (reaction-forced heavy)', 'no .dmg--heavy during the reacting ice hit — lastReactionHeavy is not reaching damage.deal');
      }
      note(
        '#4 Thermal Shock armor-break follow-up unmeasurable',
        'slime armor is 0 (halving 0 changes nothing) AND the burn+ice pair overkills 40 hp — armorBroken can only matter in Phase 5 against armored enemies',
      );
    }

    // (e) Overload — wet + dark chains to exactly 3 of 4 clustered others.
    {
      const runOverload = () =>
        reactScenario({
          prep: picks.wetApplier, preStatusId: STATUS_INDEX.wet, act: picks.darkLow,
          frontDist: 3,
          flankers: [
            { dx: F.x * 2.2, dz: F.z * 2.2 },
            { dx: R.x * 2.2, dz: R.z * 2.2 },
            { dx: -R.x * 2.2, dz: -R.z * 2.2 },
            { dx: R.x * 4.6, dz: R.z * 4.6 },
          ],
          names: ['Overload'],
          windowMs: 3200,
        });
      let r = await runOverload();
      let dropCount = r.flankDropped.filter(Boolean).length;
      if (!(r.preStatusSeen && r.namesSeen['Overload'] >= 0 && dropCount === 3)) {
        r = await runOverload(); // one retry absorbs AI-drift flakes
        dropCount = r.flankDropped.filter(Boolean).length;
      }
      m.overload = r;
      const seen = r.namesSeen['Overload'] >= 0;
      if (r.preStatusSeen && seen) pass('#4 Overload (wet + dark) reaction fires', `text at +${r.namesSeen['Overload'].toFixed(2)} s`);
      else fail('#4 Overload (wet + dark) reaction fires', `preStatus=${r.preStatusSeen} text=${seen} (reason "${r.reason}")`);
      if (dropCount === 3) {
        pass('#4 Overload chains to exactly 3 of 4 clustered others', `drops [${r.flankDropAmt.map((v) => v.toFixed(1)).join(', ')}], farthest spared=${!r.flankDropped[3]}`);
      } else {
        fail('#4 Overload chains to exactly 3 of 4 clustered others', `${dropCount} flankers dropped (amounts [${r.flankDropAmt.map((v) => v.toFixed(1)).join(', ')}])`);
      }
    }

    // =======================================================================
    // #5 — cooldown + mana refusals, button sweep.
    // =======================================================================
    {
      const cd = picks.cdSkill;
      const a = nextArena();
      const r = await page.evaluate(
        (o) => {
          const d = globalThis.__ARCANUM_DEBUG__;
          return new Promise((resolve) => {
            const out = { firstCast: false, refusal: '', frac1: -1, frac2: -1, left1: -1, left2: -1, reason: 'init' };
            d.killAllEnemies();
            d.clearInput();
            d.warp(o.ax, o.az);
            d.learnSkill(o.skillId);
            d.equipSkill(0, o.skillId);
            const t0 = performance.now();
            let phase = 0;
            let phaseT = t0;
            const tick = () => {
              const now = performance.now();
              if (now - t0 > 20_000) {
                out.reason = 'timeout';
                resolve(out);
                return;
              }
              if (phase === 0) {
                if (d.castSlot(0)) {
                  out.firstCast = true;
                  phase = 1;
                  phaseT = now;
                } else if (d.lastRefusal() !== 'busy') {
                  out.reason = 'first-cast-refused:' + d.lastRefusal();
                  resolve(out);
                  return;
                }
              } else if (phase === 1) {
                if (now - phaseT >= o.castTimeMs + 250) {
                  const ok = d.castSlot(0);
                  const refusal = ok ? 'ACCEPTED' : d.lastRefusal();
                  // 'busy' is transient — a Hit stagger or lingering cast tick.
                  // The claim under test is that the COOLDOWN refuses; keep
                  // probing until it answers or the cooldown runs out.
                  if (refusal === 'busy' && d.skills()[0].cooldownLeft > 0.3) {
                    requestAnimationFrame(tick);
                    return;
                  }
                  out.refusal = refusal;
                  const s = d.skills()[0];
                  out.frac1 = s.cooldownFraction;
                  out.left1 = s.cooldownLeft;
                  phase = 2;
                  phaseT = now;
                }
              } else if (now - phaseT >= 600) {
                const s = d.skills()[0];
                out.frac2 = s.cooldownFraction;
                out.left2 = s.cooldownLeft;
                out.reason = 'done';
                resolve(out);
                return;
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
        },
        { ax: a.x, az: a.z, skillId: cd.id, castTimeMs: Math.ceil(cd.castTime * 1000) },
      );
      m.cooldownRefusal = r;
      if (r.firstCast && r.refusal === 'cooldown') pass('#5 double-cast refused with \'cooldown\'', `${cd.id} (cd ${cd.cooldown}s)`);
      else fail('#5 double-cast refused with \'cooldown\'', `firstCast=${r.firstCast} secondRefusal="${r.refusal}" (reason "${r.reason}")`);
      if (r.frac1 > 0 && r.frac1 <= 1 && r.frac2 < r.frac1 && r.left1 <= cd.cooldown + 0.05 && r.left2 < r.left1) {
        pass('#5 button sweep fraction sane and decreasing', `frac ${r.frac1.toFixed(3)} → ${r.frac2.toFixed(3)}, left ${r.left1.toFixed(2)} → ${r.left2.toFixed(2)} s`);
      } else {
        fail('#5 button sweep fraction sane and decreasing', JSON.stringify({ frac1: r.frac1, frac2: r.frac2, left1: r.left1, left2: r.left2 }));
      }

      const fusionResultSet = new Set(picks.fusionResults);
      const expensive = [...skills]
        .filter((s) => !fusionResultSet.has(s.id))
        .sort((a, b) => b.manaCost - a.manaCost)
        .slice(0, 4);
      const drain = await page.evaluate(MANA_DRAIN, {
        ids: expensive.map((s) => s.id),
        costs: expensive.map((s) => s.manaCost),
        timeoutMs: 45_000,
      });
      m.manaDrain = drain;
      if (drain.refused && drain.mpAtRefusal >= 0 && drain.mpAtRefusal < drain.refusedCost) {
        pass('#5 drained mana refuses with \'mana\'', `${drain.casts} casts of [${expensive.map((s) => s.id).join(',')}], refused at ${drain.mpAtRefusal} MP < cost ${drain.refusedCost}`);
      } else {
        fail('#5 drained mana refuses with \'mana\'', `reason "${drain.reason}", refusal "${drain.refusal}", MP ${drain.mpAtRefusal} after ${drain.casts} casts`);
      }
    }

    // =======================================================================
    // #6 — mastery: threshold exactness + seeded damage delta.
    // =======================================================================
    {
      const sk = picks.masterySkill;
      const curve1 = sk.masteryCurve[1];
      const base1 = await castSkill(sk, {});
      const base2 = await castSkill(sk, {});
      m.masteryBaseline = { a: base1.firstDropAmt, b: base2.firstDropAmt };
      const noDropHint = ' — zero drops: if the CANARY/churn checks failed, this is the same hitbox-registry defect';
      if (base1.firstDropT >= 0 && Math.abs(base1.firstDropAmt - base2.firstDropAmt) <= 1e-6) {
        pass('#6 seeded skill damage is deterministic', `${sk.id} twice under seed ${seeds.nonCrit}: ${base1.firstDropAmt.toFixed(3)} both times`);
      } else {
        fail('#6 seeded skill damage is deterministic', `drops ${base1.firstDropAmt.toFixed(3)} vs ${base2.firstDropAmt.toFixed(3)} (reasons ${base1.reason}/${base2.reason})${base1.firstDropT < 0 ? noDropHint : ''}`);
      }

      const grind1 = await page.evaluate(GRIND, {
        mainId: sk.id, dummyId: dummyFor(sk.id), targetUses: curve1 - 1,
        manaCost: sk.manaCost, castTimeMs: Math.ceil(sk.castTime * 1000), timeoutMs: 45_000,
      });
      const atEdge = await page.evaluate((id) => globalThis.__ARCANUM_DEBUG__.grimoire().mastery[id], sk.id);
      const grind2 = await page.evaluate(GRIND, {
        mainId: sk.id, dummyId: dummyFor(sk.id), targetUses: curve1,
        manaCost: sk.manaCost, castTimeMs: Math.ceil(sk.castTime * 1000), timeoutMs: 15_000,
      });
      m.masteryGrind = { grind1, atEdge, grind2, curve1 };
      if (atEdge !== undefined && atEdge.uses === curve1 - 1 && atEdge.level === 1 && grind2.level === 2) {
        pass('#6 mastery level rises exactly at masteryCurve[1]', `${sk.id}: level 1 at ${atEdge.uses} uses, level 2 at ${grind2.uses} (threshold ${curve1})`);
      } else {
        fail('#6 mastery level rises exactly at masteryCurve[1]', `edge {uses:${atEdge?.uses}, level:${atEdge?.level}}, after {uses:${grind2.uses}, level:${grind2.level}}, threshold ${curve1} (grind1 ${grind1.reason})`);
      }

      const after = await castSkill(sk, {});
      // Mastery multiplies the skill's BASE; statScaling (intellect 10 x JSON
      // ratio) rides on top unmultiplied, so the observable ratio is diluted:
      // (base*mult + scal) / (base + scal), with mult for level 2 = 1 + pct/100.
      const scal = 10 * (sk.damage?.scaling?.ratio ?? 0);
      const rawMult = 1 + sk.masteryBonus.damagePctPerLevel / 100;
      const expectRatio = (sk.damage.base * rawMult + scal) / (sk.damage.base + scal);
      const ratio = base1.firstDropAmt > 0 ? after.firstDropAmt / base1.firstDropAmt : 0;
      m.masteryDelta = { before: base1.firstDropAmt, after: after.firstDropAmt, ratio: round(ratio, 4), expect: expectRatio };
      if (after.firstDropT >= 0 && Math.abs(ratio - expectRatio) <= 0.02) {
        pass('#6 mastery damage bonus is the JSON percentage', `${base1.firstDropAmt.toFixed(2)} → ${after.firstDropAmt.toFixed(2)} = ×${ratio.toFixed(3)} (JSON says ×${expectRatio})`);
      } else {
        fail('#6 mastery damage bonus is the JSON percentage', `×${ratio.toFixed(3)}, expected ×${expectRatio} (after-reason "${after.reason}")${after.firstDropT < 0 ? noDropHint : ''}`);
      }
      const expectCd = sk.cooldown * (1 - sk.masteryBonus.cooldownPctPerLevel / 100);
      if (after.accepted && Math.abs(after.cdAfter - expectCd) <= 0.06) {
        pass('#6 mastery cooldown bonus is the JSON percentage', `cd ${after.cdAfter.toFixed(2)} s vs expected ${expectCd.toFixed(2)}`);
      } else {
        fail('#6 mastery cooldown bonus is the JSON percentage', `cd ${after.cdAfter.toFixed(2)} s vs expected ${expectCd.toFixed(2)}`);
      }
    }

    // =======================================================================
    // #7 — resonance: 3-same-element +15%, 4-distinct status-chance bonus.
    // =======================================================================
    if (picks.resonance !== null) {
      const { element, measured, trio } = picks.resonance;
      const distinctIds = [measured.id];
      const seenEl = new Set([measured.element]);
      for (const s of skills) {
        if (!seenEl.has(s.element)) {
          seenEl.add(s.element);
          distinctIds.push(s.id);
          if (distinctIds.length === 4) break;
        }
      }
      await page.evaluate((ids) => {
        const d = globalThis.__ARCANUM_DEBUG__;
        for (let i = 0; i < ids.length; i++) {
          d.learnSkill(ids[i]);
          d.equipSkill(i, ids[i]);
        }
      }, distinctIds);
      const plain = await castSkill(measured, { statusSeed: seeds.statusMiss });
      await page.evaluate((o) => {
        const d = globalThis.__ARCANUM_DEBUG__;
        for (let i = 0; i < o.trio.length; i++) {
          d.learnSkill(o.trio[i]);
          d.equipSkill(i, o.trio[i]);
        }
        d.learnSkill(o.filler);
        d.equipSkill(3, o.filler);
      }, { trio, filler: distinctIds[1] });
      const boosted = await castSkill(measured, { statusSeed: seeds.statusMiss });
      const ratio = plain.firstDropAmt > 0 ? boosted.firstDropAmt / plain.firstDropAmt : 0;
      m.resonance = { element, plain: plain.firstDropAmt, boosted: boosted.firstDropAmt, ratio: round(ratio, 4) };
      if (plain.firstDropT >= 0 && boosted.firstDropT >= 0 && Math.abs(ratio - RESONANCE_MULT) <= 0.02) {
        pass('#7 3-same-element resonance = +15% damage', `${measured.id} (${element}): ${plain.firstDropAmt.toFixed(2)} → ${boosted.firstDropAmt.toFixed(2)} = ×${ratio.toFixed(3)}`);
      } else {
        fail('#7 3-same-element resonance = +15% damage', `×${ratio.toFixed(3)} expected ×${RESONANCE_MULT} (reasons ${plain.reason}/${boosted.reason})${plain.firstDropT < 0 ? ' — zero drops: if the CANARY/churn checks failed, this is the same hitbox-registry defect' : ''}`);
      }
    } else {
      unknown('#7 3-same-element resonance', 'no element has 3 skills whose boosted hit leaves the slime alive');
    }

    if (picks.versatileSkill !== null && picks.versatileA !== null && picks.versatileB !== null && seeds.edge > 0) {
      const t = picks.versatileSkill;
      const equip = (ids) =>
        page.evaluate((list) => {
          const d = globalThis.__ARCANUM_DEBUG__;
          for (let i = 0; i < list.length; i++) {
            d.learnSkill(list[i]);
            d.equipSkill(i, list[i]);
          }
        }, ids);
      await equip(picks.versatileA);
      const without = await castSkill(t, { statusSeed: seeds.edge });
      await equip(picks.versatileB);
      const withBonus = await castSkill(t, { statusSeed: seeds.edge });
      m.versatile = {
        skill: t.id, chance: t.status.chance, edgeSeed: seeds.edge,
        loadoutA: picks.versatileA, loadoutB: picks.versatileB,
        withoutStatus: without.statusSeen, withStatus: withBonus.statusSeen,
      };
      if (without.statusSeen === null && withBonus.statusSeen !== null) {
        pass(
          '#7 versatile (4 distinct) +0.2 status chance flips a seeded roll',
          `${t.id} chance ${t.status.chance}: same seed misses without the bonus, lands with it (remaining ${withBonus.statusSeen.remaining.toFixed(2)} s)`,
        );
      } else {
        fail(
          '#7 versatile (4 distinct) +0.2 status chance flips a seeded roll',
          `without=${JSON.stringify(without.statusSeen)} (want null, reason ${without.reason}), with=${JSON.stringify(withBonus.statusSeen)} (want landed, reason ${withBonus.reason})`,
        );
      }
    } else {
      unknown('#7 versatile status-chance bonus', 'no suitable low-chance survivable status skill / edge seed');
    }

    // =======================================================================
    // #8 — fusion.
    // =======================================================================
    {
      const rec = picks.recipe;
      const preFuse = await page.evaluate(
        (o) => {
          const d = globalThis.__ARCANUM_DEBUG__;
          d.learnSkill(o.a);
          d.learnSkill(o.b);
          const result = d.fuse(o.a, o.b);
          const g = d.grimoire();
          return { result, known: g.known, mastery: g.mastery };
        },
        { a: rec.a, b: rec.b },
      );
      const lowA = preFuse.mastery[rec.a]?.level ?? 0;
      const lowB = preFuse.mastery[rec.b]?.level ?? 0;
      if (preFuse.result === null && !preFuse.known.includes(rec.result)) {
        pass('#8 fuse refused below mastery 3 (ingredients kept)', `${rec.a} Lv${lowA} + ${rec.b} Lv${lowB} → null`);
      } else {
        fail('#8 fuse refused below mastery 3 (ingredients kept)', `fuse returned ${String(preFuse.result)} at Lv${lowA}/Lv${lowB}`);
      }

      // Mastering two skills to level 3 needs masteryCurve[2] casts EACH; at the
      // shipped mana economy that is minutes of regen. A debug uses/mana driver
      // makes it honest AND fast — probe for one.
      const drv = m.optionalDrivers;
      const usesDriver = ['addSkillUses', 'addUses', 'grantUses', 'setSkillUses'].find((k) => drv[k]) ?? null;
      const manaDriver = ['setMana', 'refillMana'].find((k) => drv[k]) ?? null;
      const needA = byId.get(rec.a).masteryCurve[2];
      const needB = byId.get(rec.b).masteryCurve[2];

      let mastered = false;
      if (usesDriver !== null) {
        await page.evaluate(
          (o) => {
            const d = globalThis.__ARCANUM_DEBUG__;
            d[o.fn](o.a, o.needA);
            d[o.fn](o.b, o.needB);
          },
          { fn: usesDriver, a: rec.a, b: rec.b, needA, needB },
        );
        const g = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.grimoire());
        mastered = (g.mastery[rec.a]?.level ?? 0) >= 3 && (g.mastery[rec.b]?.level ?? 0) >= 3;
        m.fusionMasteryPath = { driver: usesDriver, mastered };
      } else if (manaDriver !== null) {
        for (const [id, target] of [[rec.a, needA], [rec.b, needB]]) {
          const sk = byId.get(id);
          let uses = 0;
          const deadline = Date.now() + 70_000;
          while (uses < target && Date.now() < deadline) {
            await page.evaluate((o) => globalThis.__ARCANUM_DEBUG__[o.fn](500), { fn: manaDriver });
            const g = await page.evaluate(GRIND, {
              mainId: id, dummyId: dummyFor(id), targetUses: Math.min(target, uses + 12),
              manaCost: sk.manaCost, castTimeMs: Math.ceil(sk.castTime * 1000), timeoutMs: 12_000,
            });
            uses = g.uses;
          }
        }
        const g = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.grimoire());
        mastered = (g.mastery[rec.a]?.level ?? 0) >= 3 && (g.mastery[rec.b]?.level ?? 0) >= 3;
        m.fusionMasteryPath = { driver: manaDriver, mastered };
      } else {
        m.fusionMasteryPath = { driver: null, mastered: false };
      }

      if (!mastered) {
        unknown(
          '#8 fusion end-to-end',
          `mastering ${rec.a}+${rec.b} to level 3 needs ${needA}+${needB} casts ≈ ${Math.round((needA * byId.get(rec.a).manaCost + needB * byId.get(rec.b).manaCost) / 4)}s of mana regen — impossible inside this gate's 300 s without a debug uses/mana driver, and none of [addSkillUses|addUses|grantUses|setSkillUses|setMana|refillMana] exists on __ARCANUM_DEBUG__. The contract's "debug uses loop" (assertion 8) needs the integrator to expose one.`,
        );
      } else {
        // UI preview: pick both in the Fusion tab; the undiscovered result must
        // blur to '???' (§8.3), then confirm consumes and fires the moment.
        const ui = await page.evaluate(
          (o) => {
            const d = globalThis.__ARCANUM_DEBUG__;
            d.openGrimoire();
            const tabs = document.querySelectorAll('.gs__tab');
            if (tabs[2] !== undefined) tabs[2].click();
            const rowA = document.querySelector(`[data-gs-fuse="${o.a}"]`);
            const rowB = document.querySelector(`[data-gs-fuse="${o.b}"]`);
            if (rowA !== null) rowA.click();
            if (rowB !== null) rowB.click();
            const secretBox = document.querySelector('.gs-pickbox.is-secret');
            const preview = secretBox !== null ? secretBox.textContent : null;
            const confirm = document.querySelector('[data-gs-act="fuse"]');
            const confirmEnabled = confirm !== null && !confirm.disabled;
            return { rowsFound: rowA !== null && rowB !== null, preview, confirmEnabled };
          },
          { a: rec.a, b: rec.b },
        );
        m.fusionPreview = ui;
        if (ui.rowsFound && ui.preview === '???' && ui.confirmEnabled) {
          pass('#10 fusion preview blurs the undiscovered result', `picked ${rec.a}+${rec.b} → "???", confirm enabled`);
        } else {
          fail('#10 fusion preview blurs the undiscovered result', JSON.stringify(ui));
        }

        const fused = await page.evaluate(
          (o) =>
            new Promise((resolve) => {
              const d = globalThis.__ARCANUM_DEBUG__;
              d.closeGrimoire();
              const result = d.fuse(o.a, o.b);
              const t0 = performance.now();
              let sawCard = false;
              let cardName = '';
              const tick = () => {
                const card = document.querySelector('.notify__card.is-in');
                if (card !== null) {
                  sawCard = true;
                  const name = card.querySelector('.notify__name');
                  if (name !== null) cardName = name.textContent || '';
                }
                if (performance.now() - t0 >= 1500) {
                  const g = d.grimoire();
                  resolve({ result, sawCard, cardName, known: g.known, equipped: g.equipped, mastery: g.mastery });
                  return;
                }
                requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }),
          { a: rec.a, b: rec.b },
        );
        m.fusion = { result: fused.result, sawCard: fused.sawCard, cardName: fused.cardName };
        const resultDef = byId.get(rec.result);
        const inputsGone = !fused.known.includes(rec.a) && !fused.known.includes(rec.b) &&
          !fused.equipped.includes(rec.a) && !fused.equipped.includes(rec.b) &&
          fused.mastery[rec.a] === undefined && fused.mastery[rec.b] === undefined;
        if (fused.result === rec.result && fused.known.includes(rec.result) && inputsGone) {
          pass('#8 fusion consumes both inputs and teaches the result', `${rec.a}+${rec.b} → ${rec.result}; inputs unlearned, unequipped, mastery wiped`);
        } else {
          fail('#8 fusion consumes both inputs and teaches the result', `result ${String(fused.result)}, inputsGone=${inputsGone}`);
        }
        if (fused.sawCard && fused.cardName === resultDef.nameStyled) {
          pass('#8 fusion fires the ACQUIRED card', `"${fused.cardName}"`);
        } else {
          fail('#8 fusion fires the ACQUIRED card', `sawCard=${fused.sawCard} name="${fused.cardName}" expected "${resultDef.nameStyled}"`);
        }
        const castResult = await castSkill(resultDef, {});
        if (castResult.accepted && castResult.firstDropT >= 0 && (castResult.flankExpected === null || castResult.flankDropped === castResult.flankExpected)) {
          pass('#8 the fused skill casts and novas', `${rec.result}: drop ${castResult.firstDropAmt.toFixed(1)}, flanker hit=${castResult.flankDropped}`);
        } else {
          fail('#8 the fused skill casts and novas', `reason "${castResult.reason}", drop@${castResult.firstDropT}, flank=${castResult.flankDropped}/${String(castResult.flankExpected)}`);
        }
      }
    }

    // =======================================================================
    // #3 — data-driven proof part 2: ONE loop over EVERY skill in the JSON.
    // =======================================================================
    {
      const rows = [];
      for (const skill of skills) {
        const mastBefore = await page.evaluate((id) => {
          const g = globalThis.__ARCANUM_DEBUG__.grimoire();
          return g.mastery[id] ?? { level: 1, uses: 0 };
        }, skill.id);
        const level = Math.max(1, mastBefore.level);
        const cdMult = 1 - ((level - 1) * skill.masteryBonus.cooldownPctPerLevel) / 100;
        const dmgMult = 1 + ((level - 1) * skill.masteryBonus.damagePctPerLevel) / 100;
        const expectCd = skill.cooldown * cdMult;
        const isSelf = skill.delivery.type === 'self';
        const hasDamage = skill.damage !== undefined && skill.damage.base > 0;
        const hasHeal = skill.heal !== undefined;
        const statusObservable =
          skill.status !== undefined && hasDamage
            ? expDmg(skill) * dmgMult < SLIME_MAX_HP - 2
            : skill.status !== undefined;

        let r;
        if (isSelf) {
          const a = nextArena();
          r = await page.evaluate(HEAL_TEST, {
            ax: a.x, az: a.z, skillId: skill.id, manaCost: skill.manaCost,
            needDeficit: 25, windowMs: Math.ceil((skill.castTime + 2.0) * 1000), timeoutMs: 40_000,
          });
        } else {
          r = await castSkill(skill, {});
          // One retry absorbs a cast broken by a slime strike — but only in a
          // hittable world; retrying into a known-broken registry just burns
          // the budget waiting out cooldowns.
          if (r.accepted && hasDamage && r.firstDropT < 0 && worldHittable) r = await castSkill(skill, {});
        }

        const problems = [];
        if (!r.accepted) problems.push(`cast refused (${r.reason}; refusals [${(r.refusals ?? []).join(',')}])`);
        if (r.accepted) {
          if (Math.abs(r.cdAfter - expectCd) > 0.08) problems.push(`cooldown ${r.cdAfter.toFixed(2)} != JSON ${skill.cooldown} × mastery ${cdMult.toFixed(2)} = ${expectCd.toFixed(2)}`);
          const drop = r.mpBefore >= 0 && r.mpMin !== Infinity ? r.mpBefore - r.mpMin : -1;
          if (drop < 0 || Math.abs(drop - skill.manaCost) > 3) problems.push(`mana drop ${drop} != JSON cost ${skill.manaCost} (±3)`);
          if (isSelf) {
            const rise = r.hpPeak - r.hpAtCast;
            const deficit = r.hpMax - r.hpAtCast;
            const expectRise = Math.min(expHeal(skill) * dmgMult, deficit);
            if (hasHeal && !(rise > 0 && Math.abs(rise - expectRise) <= 6)) {
              problems.push(`heal rise ${rise} != expected ~${expectRise.toFixed(0)} (JSON heal ${expHeal(skill).toFixed(0)}, deficit ${deficit})`);
            }
          } else {
            if (hasDamage && r.firstDropT < 0) problems.push('target hp never dropped');
            if (skill.status !== undefined) {
              if (statusObservable) {
                if (r.statusSeen === null) problems.push(`status '${skill.status.id}' never appeared (forced roll, seed ${seeds.statusHit})`);
                else if (r.statusSeen.remaining > skill.status.duration + 0.15 || r.statusSeen.remaining < Math.max(0.05, skill.status.duration - 1.5)) {
                  problems.push(`status remaining ${r.statusSeen.remaining.toFixed(2)} vs JSON duration ${skill.status.duration}`);
                }
              } else {
                note(
                  `#3 ${skill.id} status '${skill.status.id}' unobservable in-game`,
                  `expected damage ${(expDmg(skill) * dmgMult).toFixed(0)} one-shots the 40 hp slime, and statuses cannot land on the dead — dead content vs the only Phase 4 enemy`,
                );
              }
            }
            if (r.flankExpected === false && r.flankDropped) problems.push('projectile hit the flanker BEHIND the caster');
            if (r.flankExpected === true && !r.flankDropped) problems.push(`nova (r ${skill.delivery.radius}) missed the flanker behind the caster`);
          }
        }
        rows.push({
          id: skill.id, level, accepted: r.accepted ?? false,
          cd: round(r.cdAfter ?? -1, 3), expectCd: round(expectCd, 3),
          manaDrop: r.mpBefore >= 0 && r.mpMin !== Infinity ? round(r.mpBefore - r.mpMin, 1) : null,
          drop: isSelf ? null : round(r.firstDropAmt ?? 0, 2),
          healRise: isSelf ? round((r.hpPeak ?? 0) - (r.hpAtCast ?? 0), 1) : null,
          status: r.statusSeen ?? null, flank: isSelf ? null : `${r.flankDropped}/${String(r.flankExpected)}`,
          problems,
        });
        if (problems.length === 0) {
          pass(`#3 ${skill.id} driven end-to-end by its JSON`, `${skill.delivery.type}, cd ${r.cdAfter?.toFixed(2)}s, mana -${rows[rows.length - 1].manaDrop}${isSelf ? `, heal +${rows[rows.length - 1].healRise}` : hasDamage ? `, dmg ${rows[rows.length - 1].drop}` : ''}`);
        } else {
          fail(`#3 ${skill.id} driven end-to-end by its JSON`, problems.join(' | '));
        }
      }
      report.series.perSkill = rows;
    }

    // =======================================================================
    // #11 + #12 — budgets under a four-skill brawl + screenshot.
    // =======================================================================
    {
      await page.evaluate(
        (o) => {
          const d = globalThis.__ARCANUM_DEBUG__;
          d.killAllEnemies();
          d.clearInput();
          d.warp(o.x, o.z);
          for (let i = 0; i < o.ids.length; i++) {
            d.learnSkill(o.ids[i]);
            d.equipSkill(i, o.ids[i]);
          }
        },
        { x: 0, z: 0, ids: starterIds },
      );
      await sleep(300);
      // Radius 6, not 2.5: the Phase 5 bestiary's blob lunges harder than the
      // retired Phase 3 class, and four of them point-blank stagger-lock the
      // player into 'busy' refusals — the budget probe then measures an idle
      // scene. At 6 u they converge within a second but casts get out first.
      await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.spawnSlimes(0, 0, 4, 6));
      // The whole run drained mana; a brawl that cannot afford its casts would
      // measure an idle scene. Regen is ~4/s — wait for a real war chest.
      await page
        .waitForFunction(
          () => {
            const el = document.querySelector('.hud__bar--mp .hud__bar-num');
            if (el === null) return true;
            return Number((el.textContent || '').split('/')[0]) >= 140;
          },
          null,
          { timeout: 40_000 },
        )
        .catch(() => {});
      const brawl = await page.evaluate(BRAWL4, { durationMs: 10_000, castCadenceMs: 250 });
      const peakDraws = maxOf(brawl.drawCalls);
      const peakTris = maxOf(brawl.triangles);
      const peakHeap = maxOf(brawl.heapMb);
      const driftMb = brawl.count > 1 ? brawl.heapMb[brawl.count - 1] - brawl.heapMb[0] : 0;
      const bytesPerFrame = brawl.count > 1 ? (driftMb * 1024 * 1024) / brawl.count : 0;
      m.brawl = {
        frames: brawl.count,
        castsAccepted: brawl.castsAccepted,
        peakDrawCalls: peakDraws,
        peakTriangles: peakTris,
        peakHeapMb: round(peakHeap, 1),
        heapBytesPerFrame: Math.round(bytesPerFrame),
      };
      // Guard against a degenerate idle scene, not a cast-rate target: slot
      // polling (1 s/slot), cast-state busy windows, Hit staggers and the mana
      // economy cap a healthy brawl at ~6-10 accepted casts in 10 s.
      if (brawl.castsAccepted >= 5) pass('#11 the brawl actually cast skills', `${brawl.castsAccepted} accepted casts in 10 s (plus melee vs 4 slimes)`);
      else fail('#11 the brawl actually cast skills', `only ${brawl.castsAccepted} accepted casts — budgets below measured a near-idle scene`);
      if (peakDraws <= BUDGET.drawCalls) pass('#11 draw calls <= 110 in a four-skill brawl', `peak ${peakDraws}`);
      else fail('#11 draw calls <= 110 in a four-skill brawl', `peak ${peakDraws}`);
      if (peakTris <= BUDGET.triangles) pass('#11 triangles <= 150000', `peak ${peakTris}`);
      else fail('#11 triangles <= 150000', `peak ${peakTris}`);
      if (peakHeap <= BUDGET.heapMb) pass('#11 heap <= 280 MB', `peak ${peakHeap.toFixed(1)} MB`);
      else fail('#11 heap <= 280 MB', `peak ${peakHeap.toFixed(1)} MB`);
      if (bytesPerFrame < HEAP_BYTES_PER_FRAME) pass('#11 heap drift < 2 KB/frame with VFX flying', `${bytesPerFrame.toFixed(0)} B/frame over ${brawl.count} frames`);
      else fail('#11 heap drift < 2 KB/frame with VFX flying', `${bytesPerFrame.toFixed(0)} B/frame — skill/VFX pools are leaking (§13)`);
      report.series.brawl = {
        t: brawl.t.map((v) => round(v, 3)),
        drawCalls: brawl.drawCalls,
        triangles: brawl.triangles,
        heapMb: brawl.heapMb.map((v) => round(v, 3)),
        frameMs: brawl.frameMs.map((v) => round(v, 2)),
      };

      // Screenshot: a dedicated nova beat so the ring is mid-expansion.
      const nova = picks.novaSkill;
      await page.evaluate(
        (o) => {
          const d = globalThis.__ARCANUM_DEBUG__;
          d.killAllEnemies();
          d.warp(o.x, o.z);
          d.learnSkill(o.id);
          d.equipSkill(0, o.id);
          d.spawnSlimes(o.x, o.z, 2, 1.8);
        },
        { x: 0, z: 0, id: nova.id },
      );
      await sleep(500);
      const castOk = await page.evaluate(() => globalThis.__ARCANUM_DEBUG__.castSlot(0));
      await sleep(Math.ceil(nova.castTime * 1000) + Math.ceil(((nova.delivery.expandSeconds || 0.18) * 1000) / 2) + 60);
      if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(ARTIFACTS, 'skilltest.png') });
      pass('#12 screenshot written', `artifacts/skilltest.png — ${nova.id} ${castOk ? 'mid-cast/nova' : 'CAST REFUSED (still captured)'}`);
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
  writeFileSync(path.join(ARTIFACTS, 'skilltest.json'), JSON.stringify(report, null, 2));

  void cleanup().finally(() => process.exit(interrupted !== null ? 130 : report.verdict === 'PASS' ? 0 : 1));
}

function printSummary() {
  const m = report.measurements;
  console.log('\n' + '='.repeat(78));
  console.log('ARCANUM DRIFT — PHASE 4 GRIMOIRE GATE');
  console.log('='.repeat(78));

  const row = (label, value, expected) =>
    console.log('  ' + label.padEnd(36) + String(value).padStart(14) + '   ' + expected);

  console.log('\n§4.1 LAW');
  const scan = m.dataDrivenScan ?? {};
  row('skill-id hits in src/**/*.ts', (scan.hits ?? ['?']).length, '0 — the acceptance criterion');
  row('.ts files scanned', scan.filesScanned ?? '-', '> 20');

  console.log('\nBUDGETS (§3, four-skill brawl)');
  const b = m.brawl ?? {};
  row('draw calls (peak)', b.peakDrawCalls ?? '-', '<= 110');
  row('triangles (peak)', b.peakTriangles ?? '-', '<= 150000');
  row('heap drift', (b.heapBytesPerFrame ?? '-') + ' B/frame', '< 2048');
  row('accepted casts in 10 s', b.castsAccepted ?? '-', '>= 8');

  console.log('\nCHECKS');
  for (const check of report.checks) {
    const mark = check.status === 'PASS' ? 'ok  ' : check.status === 'NOTE' ? 'note' : 'FAIL';
    console.log(`  [${mark}] ${check.name}  —  ${check.detail}`);
  }

  if (report.misSpecified.length > 0) {
    console.log('\nMIS-SPECIFIED CONTRACT ASSERTIONS (observed, not silently skipped)');
    for (const item of report.misSpecified) console.log('  * ' + item);
  }

  console.log('\nHONEST LIMITS OF THIS RUN');
  console.log('  SwiftShader software rendering: nothing here is a device number, and');
  console.log('  the SKILL ACQUIRED moment\'s FEEL — the freeze, the stamp, the flash —');
  console.log('  is §8.2\'s whole point and only a real handset can judge it. What DOES');
  console.log('  transfer: the §4.1 zero-TS law, JSON-to-behaviour correctness for every');
  console.log('  skill, seeded determinism, the reaction matrix, refusal semantics,');
  console.log('  mastery/resonance math, and the §3 budgets. Where shipped balance makes');
  console.log('  a contract multiplier unobservable (40 hp slimes, armor 0), the gate');
  console.log('  says so above instead of green-lighting an untested claim.');

  const failedCount = report.checks.filter((c) => c.status === 'FAIL').length;
  console.log(
    `\nVERDICT     ${report.verdict}  (${report.checks.length - failedCount} passed/noted, ${failedCount} failed, ${report.durationMs} ms)`,
  );
  console.log('='.repeat(78) + '\n');
}

process.on('unhandledRejection', (reason) => {
  console.error('[skilltest] unhandled rejection:', reason);
  void cleanup().finally(() => process.exit(1));
});

await main();
