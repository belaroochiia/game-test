import * as THREE from 'three';

import type { System } from '../core/Engine';

/**
 * §5's 12-minute day-night cycle: four keyframes (night / dawn / day / dusk) driving
 * fog, ambient fill, sun direction and sun intensity, plus a vertex-coloured gradient
 * dome. §5 calls this the cheapest "wow" effect in the game and it is right, so the
 * only way to get it wrong is to make it expensive. Hence:
 *
 * - The dome geometry is built once (352 triangles, one draw call) and only its colour
 *   attribute is ever rewritten, gated on a 1/256-of-a-cycle phase step — ~2.8 s at
 *   the default speed. 221 vertices x ~256 recolours per 12 minutes is free; the same
 *   work per frame would be 43 000 colour lerps a second for no visible gain.
 * - The `FogExp2` and background `Color` handed in by the integrator are mutated in
 *   place, never replaced, and the dome's horizon band *is* the current fog colour.
 *   That identity is what makes the horizon vanish rather than show a seam — and it is
 *   also what lets §5's world edge read as a drop into a fog sea.
 * - Nothing in `update()` allocates: keyframe Colors are pre-built, the rest lerps
 *   into module-scope scratch.
 *
 * Deliberate departure from a literal reading of §5: night is not dark. Sun intensity
 * falls to ~7 % of noon, but the hemisphere fill *rises above* its daytime value, so
 * night reads as "blue and closed in" rather than "black". A genuinely dark night is
 * unplayable on the phone §3 targets, held outdoors, at whatever brightness the user
 * left it on. Hue carries the time of day; luminance stays playable.
 */

export interface SkyDayNightOptions {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fog: THREE.FogExp2;
  /** Seconds for a full cycle. Default 720 (§5's 12 minutes). */
  cycleSeconds?: number;
  /** Where the cycle starts, 0..1. Default 0.28 => mid-morning. */
  startPhase?: number;
  /**
   * Dome radius. Must sit inside the camera's far plane (§3's 180) with margin —
   * the dome is centred on the camera, so every vertex is exactly this far away.
   */
  domeRadius?: number;
}

const DEFAULT_CYCLE_SECONDS = 720;
const DEFAULT_START_PHASE = 0.28;
const DEFAULT_DOME_RADIUS = 150;

/** 16 x 12 => 352 triangles, 221 vertices. Under the 400-triangle cap with room. */
const DOME_WIDTH_SEGMENTS = 16;
const DOME_HEIGHT_SEGMENTS = 12;

/** Recolour threshold. 1/256 of a cycle changes each channel by well under 1/255. */
const RECOLOR_PHASE_STEP = 1 / 256;

/** How far the biome tint (§5's "blue mist") can pull the time-of-day fog colour. */
const BIOME_TINT_MAX = 0.45;
/** Below this the biome tint counts as unchanged, so walking a boundary does not
 *  dirty the dome every frame. */
const TINT_EPSILON = 0.01;

const TWO_PI = Math.PI * 2;

/**
 * Noon elevation is 90 deg minus this. The sun arcs overhead (§5) but deliberately
 * misses the zenith: perfectly vertical noon light flattens every silhouette, which
 * is the one thing §5's art direction cannot afford to lose.
 */
const SUN_ARC_TILT = (22 * Math.PI) / 180;
const SUN_ARC_COS = Math.cos(SUN_ARC_TILT);
const SUN_ARC_SIN = Math.sin(SUN_ARC_TILT);

/** Rotation of the rise/set axis, so the arc is not aligned to the world grid. */
const SUN_AZIMUTH = (28 * Math.PI) / 180;
const SUN_AZ_COS = Math.cos(SUN_AZIMUTH);
const SUN_AZ_SIN = Math.sin(SUN_AZIMUTH);

const SUN_DISTANCE = 90;

/**
 * Floor on the sun's height. Once it is below the horizon its intensity is ~0 anyway,
 * and a directional light from underneath lights the wrong side of everything — so
 * clamp instead. `max()` keeps the direction continuous across the horizon crossing.
 */
const SUN_MIN_Y = 0.12;

/** Dome vertical ramp: fog colour at the horizon, through mid, to zenith. */
const DOME_MID_END = 0.28;
const DOME_ZENITH_START = 0.26;
const DOME_ZENITH_END = 0.82;
/** Under the horizon the dome darkens, so the world edge reads as a drop, not a wall. */
const DOME_BELOW_FADE = 0.55;
const DOME_BELOW_DARKEN = 0.28;

interface SkyKeyframe {
  readonly fog: THREE.Color;
  readonly fogDensity: number;
  readonly sun: THREE.Color;
  readonly sunIntensity: number;
  readonly hemiSky: THREE.Color;
  readonly hemiGround: THREE.Color;
  readonly hemiIntensity: number;
  readonly skyMid: THREE.Color;
  readonly skyZenith: THREE.Color;
  readonly glow: THREE.Color;
  readonly glowStrength: number;
}

/*
 * Keyframes sit at phase 0.00 / 0.25 / 0.50 / 0.75 and wrap, so the default start
 * phase of 0.28 lands just after sunrise — mid-morning, as advertised.
 *
 * Fog density: §3 mandates dense FogExp2 precisely so the 180-unit far plane and
 * chunk streaming never show. A chunk entering the 5x5 active set does so ~100 units
 * out, where density 0.016 leaves it 92 % fogged; Phase 1's 0.012 left 21 % of it
 * visible, which is exactly the "popping" §12 fails the phase for. Densities are
 * therefore raised, and night is denser still.
 *
 * Colours go through THREE.Color, so these are sRGB hex and the sRGB->linear
 * conversion is handled for us.
 */

const KEY_NIGHT: SkyKeyframe = {
  fog: new THREE.Color(0x141c2e),
  fogDensity: 0.022,
  sun: new THREE.Color(0x6f82b4), // moonlight: cool, and almost off
  sunIntensity: 0.12,
  hemiSky: new THREE.Color(0x7186bd), // raised, not lowered — see the class comment
  hemiGround: new THREE.Color(0x2c3348),
  hemiIntensity: 1.15,
  skyMid: new THREE.Color(0x1e2b4a),
  skyZenith: new THREE.Color(0x0a1020),
  glow: new THREE.Color(0x9fb0d8),
  glowStrength: 0.16,
};

const KEY_DAWN: SkyKeyframe = {
  fog: new THREE.Color(0xd8a37c),
  fogDensity: 0.019,
  sun: new THREE.Color(0xffb072),
  sunIntensity: 0.95,
  hemiSky: new THREE.Color(0xd0b0c8),
  hemiGround: new THREE.Color(0x5a4a42),
  hemiIntensity: 0.82,
  skyMid: new THREE.Color(0xe8a889),
  skyZenith: new THREE.Color(0x5f7fb5),
  glow: new THREE.Color(0xffd9a0),
  glowStrength: 1.0,
};

const KEY_DAY: SkyKeyframe = {
  fog: new THREE.Color(0x9fc4d8), // Phase 1's verified daylight tint, kept
  fogDensity: 0.016,
  sun: new THREE.Color(0xfff3d8),
  sunIntensity: 1.6,
  hemiSky: new THREE.Color(0xbcd8ff),
  hemiGround: new THREE.Color(0x4a5340),
  hemiIntensity: 0.8,
  skyMid: new THREE.Color(0x86bade),
  skyZenith: new THREE.Color(0x3f7fc4),
  glow: new THREE.Color(0xfff6d8),
  glowStrength: 0.35,
};

const KEY_DUSK: SkyKeyframe = {
  fog: new THREE.Color(0xc07a62),
  fogDensity: 0.02,
  sun: new THREE.Color(0xff8a4c),
  sunIntensity: 0.85,
  hemiSky: new THREE.Color(0xa88ab0),
  hemiGround: new THREE.Color(0x4a3a3c),
  hemiIntensity: 0.8,
  skyMid: new THREE.Color(0xd4744f),
  skyZenith: new THREE.Color(0x3d3f78),
  glow: new THREE.Color(0xffb060),
  glowStrength: 1.1,
};

/** A switch rather than an array lookup: `noUncheckedIndexedAccess` would otherwise
 *  make every keyframe read `SkyKeyframe | undefined` for no reason. */
function keyframeAt(index: number): SkyKeyframe {
  switch (index & 3) {
    case 0:
      return KEY_NIGHT;
    case 1:
      return KEY_DAWN;
    case 2:
      return KEY_DAY;
    default:
      return KEY_DUSK;
  }
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  let t = (value - edge0) / (edge1 - edge0);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/** Shortest distance between two phases on the 0..1 circle, so 0.999 -> 0.001 is 0.002. */
function phaseDistance(a: number, b: number): number {
  let d = a - b;
  if (d < 0) d = -d;
  if (d > 0.5) d = 1 - d;
  return d;
}

function normalizePhase(phase: number): number {
  if (!Number.isFinite(phase)) return 0;
  let p = phase - Math.floor(phase);
  // Guards the fixed-point case where phase is a hair under 1 and floor() rounds it up.
  if (p < 0) p = 0;
  else if (p >= 1) p = 0;
  return p;
}

const scratchFog = new THREE.Color();
const scratchMid = new THREE.Color();
const scratchZenith = new THREE.Color();
const scratchGlow = new THREE.Color();
const scratchVertex = new THREE.Color();
const scratchPosition = new THREE.Vector3();

const NOOP_BEFORE_RENDER = (): void => {
  /* restored on dispose so the mesh stops chasing the camera */
};

export class SkyDayNight implements System {
  readonly name = 'sky';

  /** The gradient dome. The integrator parents it; it is one draw call, always. */
  readonly dome: THREE.Mesh;

  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly fog: THREE.FogExp2;
  private readonly background: THREE.Color;

  private readonly cycleSeconds: number;
  private readonly startPhase: number;

  /** Unit direction per dome vertex, so recolouring never touches the positions. */
  private readonly domeDirections: Float32Array;
  private readonly domeColors: Float32Array;
  private readonly domeColorAttribute: THREE.BufferAttribute;
  private readonly domeVertexCount: number;

  private phaseValue: number;
  /** Phase the dome colours were last written for; drives the recolour gate. */
  private domePhase = -1;
  private domeDirty = true;

  /** Un-clamped vertical component of the sun's arc: negative means below the horizon. */
  private sunHeight = 0;
  private sunDirX = 0;
  private sunDirY = 1;
  private sunDirZ = 0;

  private readonly biomeTint = new THREE.Color(0xffffff);
  private biomeTintWeight = 0;

  constructor(options: SkyDayNightOptions) {
    this.sun = options.sun;
    this.hemi = options.hemi;
    this.fog = options.fog;

    const cycle = options.cycleSeconds ?? DEFAULT_CYCLE_SECONDS;
    this.cycleSeconds = cycle > 1 ? cycle : DEFAULT_CYCLE_SECONDS;
    this.startPhase = normalizePhase(options.startPhase ?? DEFAULT_START_PHASE);
    this.phaseValue = this.startPhase;

    // Mutating whatever background Color the integrator already installed keeps the
    // clear colour and the fog in lockstep; only create one if there is none.
    const existing = options.scene.background;
    if (existing instanceof THREE.Color) {
      this.background = existing;
    } else {
      this.background = new THREE.Color();
      options.scene.background = this.background;
    }

    const radius = options.domeRadius ?? DEFAULT_DOME_RADIUS;
    const geometry = new THREE.SphereGeometry(
      radius,
      DOME_WIDTH_SEGMENTS,
      DOME_HEIGHT_SEGMENTS,
    );
    // MeshBasicMaterial without an envMap reads neither normals nor UVs, and the
    // dome is 100 % of the screen's pixels — no reason to feed the GPU either.
    geometry.deleteAttribute('normal');
    geometry.deleteAttribute('uv');

    const position = geometry.getAttribute('position');
    const count = position.count;
    this.domeVertexCount = count;

    const directions = new Float32Array(count * 3);
    const invRadius = radius > 0 ? 1 / radius : 1;
    for (let i = 0; i < count; i++) {
      directions[i * 3] = position.getX(i) * invRadius;
      directions[i * 3 + 1] = position.getY(i) * invRadius;
      directions[i * 3 + 2] = position.getZ(i) * invRadius;
    }
    this.domeDirections = directions;

    this.domeColors = new Float32Array(count * 3);
    this.domeColorAttribute = new THREE.BufferAttribute(this.domeColors, 3);
    this.domeColorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', this.domeColorAttribute);

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      // The dome already carries the fog colour at its horizon; fogging it as well
      // would double-apply and desaturate the gradient.
      fog: false,
      depthWrite: false,
    });

    this.dome = new THREE.Mesh(geometry, material);
    this.dome.name = 'sky-dome';
    // Drawn before anything else, writing no depth: everything else covers it for free.
    this.dome.renderOrder = -1;
    // Centred on the camera every frame, so a stale bounding sphere would cull it
    // wrongly during fast camera moves. It is never off-screen anyway.
    this.dome.frustumCulled = false;
    this.dome.onBeforeRender = this.followCamera;

    this.apply(true);
  }

  update(dt: number): void {
    let phase = this.phaseValue + dt / this.cycleSeconds;
    if (phase >= 1) phase -= Math.floor(phase);
    this.phaseValue = phase;
    this.apply(false);
  }

  reset(): void {
    this.phaseValue = this.startPhase;
    this.biomeTintWeight = 0;
    this.biomeTint.setRGB(1, 1, 1);
    this.apply(true);
  }

  get phase(): number {
    return this.phaseValue;
  }

  /** For the debug hook and tools/worldtest.mjs — recolours immediately, no gate. */
  setPhase(phase: number): void {
    this.phaseValue = normalizePhase(phase);
    this.apply(true);
  }

  get isNight(): boolean {
    return this.sunHeight <= 0;
  }

  /**
   * Biome fog tint from ChunkManager, blended *under* the time-of-day tint: at most
   * BIOME_TINT_MAX of the way, so Whisperwood's blue mist colours dusk rather than
   * replacing it. Dirties the dome only on a meaningful change, because the dome's
   * horizon band is this same colour and the caller may write every frame.
   */
  setBiomeFogTint(color: THREE.Color, weight: number): void {
    let w = weight;
    if (!(w > 0)) w = 0;
    else if (w > 1) w = 1;

    const tint = this.biomeTint;
    const changed =
      Math.abs(w - this.biomeTintWeight) > TINT_EPSILON ||
      Math.abs(color.r - tint.r) > TINT_EPSILON ||
      Math.abs(color.g - tint.g) > TINT_EPSILON ||
      Math.abs(color.b - tint.b) > TINT_EPSILON;

    this.biomeTintWeight = w;
    tint.copy(color);
    if (changed) this.domeDirty = true;
  }

  dispose(): void {
    this.dome.onBeforeRender = NOOP_BEFORE_RENDER;
    this.dome.removeFromParent();
    this.dome.geometry.dispose();
    (this.dome.material as THREE.Material).dispose();
  }

  /**
   * One keyframe pair, one blend factor, and a sinusoidal sun arc — the whole cycle.
   * `t` is smoothstepped so the four keyframes are joined without a visible kink in
   * the rate of change; the raw phase would give C0 continuity but a corner at each
   * keyframe, most obvious in sun intensity around sunrise.
   */
  private apply(force: boolean): void {
    const phase = this.phaseValue;
    const scaled = phase * 4;
    const slot = Math.floor(scaled);
    const raw = scaled - slot;
    const t = raw * raw * (3 - 2 * raw);

    const a = keyframeAt(slot);
    const b = keyframeAt(slot + 1);

    // --- sun arc ----------------------------------------------------------
    // Phase 0.25 is sunrise, 0.5 noon, 0.75 sunset. A great circle through the
    // vertical, tilted by SUN_ARC_TILT and rotated by SUN_AZIMUTH: still unit length,
    // four trig calls, and continuous across the 1.0 -> 0.0 wrap.
    const angle = (phase - 0.25) * TWO_PI;
    const s = Math.sin(angle);
    const c = Math.cos(angle);
    const lateral = s * SUN_ARC_SIN;
    this.sunHeight = s * SUN_ARC_COS;

    let dx = c * SUN_AZ_COS - lateral * SUN_AZ_SIN;
    let dz = c * SUN_AZ_SIN + lateral * SUN_AZ_COS;
    let dy = this.sunHeight;
    if (dy < SUN_MIN_Y) dy = SUN_MIN_Y;

    const invLength = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
    dx *= invLength;
    dy *= invLength;
    dz *= invLength;
    this.sunDirX = dx;
    this.sunDirY = dy;
    this.sunDirZ = dz;
    this.sun.position.set(dx * SUN_DISTANCE, dy * SUN_DISTANCE, dz * SUN_DISTANCE);

    // --- lights -----------------------------------------------------------
    this.sun.color.copy(a.sun).lerp(b.sun, t);
    this.sun.intensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t;

    this.hemi.color.copy(a.hemiSky).lerp(b.hemiSky, t);
    this.hemi.groundColor.copy(a.hemiGround).lerp(b.hemiGround, t);
    this.hemi.intensity = a.hemiIntensity + (b.hemiIntensity - a.hemiIntensity) * t;

    // --- fog, background and the dome's horizon: one colour, three consumers ---
    scratchFog.copy(a.fog).lerp(b.fog, t);
    if (this.biomeTintWeight > 0) {
      scratchFog.lerp(this.biomeTint, this.biomeTintWeight * BIOME_TINT_MAX);
    }
    this.fog.color.copy(scratchFog);
    this.fog.density = a.fogDensity + (b.fogDensity - a.fogDensity) * t;
    this.background.copy(scratchFog);

    if (force || this.domeDirty || phaseDistance(phase, this.domePhase) >= RECOLOR_PHASE_STEP) {
      this.domePhase = phase;
      this.domeDirty = false;
      scratchMid.copy(a.skyMid).lerp(b.skyMid, t);
      scratchZenith.copy(a.skyZenith).lerp(b.skyZenith, t);
      scratchGlow.copy(a.glow).lerp(b.glow, t);
      const glowStrength = a.glowStrength + (b.glowStrength - a.glowStrength) * t;
      this.recolorDome(scratchFog, scratchMid, scratchZenith, scratchGlow, glowStrength);
    }
  }

  /**
   * Rewrites the existing colour attribute in place — the geometry is never rebuilt.
   * 221 vertices, and only when the phase gate opens.
   */
  private recolorDome(
    horizon: THREE.Color,
    mid: THREE.Color,
    zenith: THREE.Color,
    glow: THREE.Color,
    glowStrength: number,
  ): void {
    const directions = this.domeDirections;
    const colors = this.domeColors;
    const count = this.domeVertexCount;
    const sx = this.sunDirX;
    const sy = this.sunDirY;
    const sz = this.sunDirZ;

    for (let i = 0; i < count; i++) {
      const offset = i * 3;
      const nx = directions[offset] ?? 0;
      const ny = directions[offset + 1] ?? 0;
      const nz = directions[offset + 2] ?? 0;

      scratchVertex.copy(horizon);
      if (ny > 0) {
        scratchVertex.lerp(mid, smoothstep(0, DOME_MID_END, ny));
        scratchVertex.lerp(zenith, smoothstep(DOME_ZENITH_START, DOME_ZENITH_END, ny));
      } else {
        const fade = smoothstep(0, DOME_BELOW_FADE, -ny) * DOME_BELOW_DARKEN;
        scratchVertex.multiplyScalar(1 - fade);
      }

      // Sun halo: a tight core plus a broad bloom, from powers of a dot product.
      // This is the whole of §5's "fake glow" for the sky — no sprite, no blur pass.
      const facing = nx * sx + ny * sy + nz * sz;
      if (facing > 0 && glowStrength > 0) {
        const d2 = facing * facing;
        const d4 = d2 * d2;
        const halo = (d4 * d4 + 0.22 * d4) * glowStrength;
        scratchVertex.r += glow.r * halo;
        scratchVertex.g += glow.g * halo;
        scratchVertex.b += glow.b * halo;
      }

      colors[offset] = scratchVertex.r;
      colors[offset + 1] = scratchVertex.g;
      colors[offset + 2] = scratchVertex.b;
    }

    this.domeColorAttribute.needsUpdate = true;
  }

  /**
   * Keeps the dome centred on the camera without needing a reference to it: three
   * calls `onBeforeRender` before it computes `modelViewMatrix`, so writing the
   * transform here lands in the same frame. Works whichever object the integrator
   * parents the dome to (including the camera itself, where the local position
   * resolves to the origin). Allocation-free — `worldToLocal` uses three's own
   * module scratch.
   */
  private readonly followCamera = (
    _renderer: THREE.WebGLRenderer,
    _scene: THREE.Scene,
    camera: THREE.Camera,
  ): void => {
    const dome = this.dome;
    scratchPosition.setFromMatrixPosition(camera.matrixWorld);

    const parent = dome.parent;
    if (parent !== null) parent.worldToLocal(scratchPosition);

    const position = dome.position;
    if (
      position.x === scratchPosition.x &&
      position.y === scratchPosition.y &&
      position.z === scratchPosition.z
    ) {
      return;
    }

    position.copy(scratchPosition);
    dome.updateMatrix();
    if (parent !== null) dome.matrixWorld.multiplyMatrices(parent.matrixWorld, dome.matrix);
    else dome.matrixWorld.copy(dome.matrix);
  };
}
