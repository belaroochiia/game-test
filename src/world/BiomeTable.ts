import * as THREE from 'three';

/**
 * §5's region table, cut down to the two regions Phase 2 ships: Verdant Hollow
 * (the spawn side — soft green, golden yellow) and Whisperwood (dark green,
 * teal, blue mist).
 *
 * The boundary is a *field*, not a line: a broad spatial gradient plus
 * low-frequency noise, resolved through a ~30-unit smoothstep band. §12 fails
 * the phase for obvious popping and a hard colour seam is popping, so nothing
 * here ever makes a discrete decision about which biome a point belongs to
 * except `dominant`, which only prop selection and other yes/no calls use.
 *
 * The value-noise primitives live in this module rather than a third one:
 * Phase 2's file list is fixed, and `HeightField -> BiomeTable` is the only
 * dependency direction between the two, so exporting them here cannot create a
 * cycle.
 */

export const BIOME = { VerdantHollow: 0, Whisperwood: 1 } as const;
export type BiomeId = (typeof BIOME)[keyof typeof BIOME];
export const BIOME_COUNT = 2;

/** Reusable blend result — never allocate one per sample. */
export interface BiomeSample {
  /** Weight per biome, sums to 1. Indexed by BiomeId. */
  weights: number[];
  /** Highest-weight biome, for prop selection and discrete decisions. */
  dominant: BiomeId;
}

export function createBiomeSample(): BiomeSample {
  const weights: number[] = [];
  for (let i = 0; i < BIOME_COUNT; i++) weights.push(i === 0 ? 1 : 0);
  return { weights, dominant: BIOME.VerdantHollow };
}

export interface BiomeDef {
  readonly id: BiomeId;
  readonly name: string;
  /** Terrain shaping. */
  readonly amplitude: number; // metres of relief
  readonly wavelength: number; // feature size in world units
  readonly ridged: boolean; // ridged noise reads as forested hills
  /** Vertex colour ramp, low -> high, plus the rock colour for steep faces. */
  readonly colorLow: number;
  readonly colorMid: number;
  readonly colorHigh: number;
  readonly colorRock: number;
  /** Fog tint contribution, blended by weight (§5's "blue mist"). */
  readonly fogColor: number;
  /** Instances per chunk, indexed by PropScatter's PROP_TYPE: tree, rock, bush, mushroom. */
  readonly propDensity: readonly number[];
}

// ---------------------------------------------------------------------------
// Shared noise primitives (see the module comment for why they live here)
// ---------------------------------------------------------------------------

export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  let t = (value - edge0) / (edge1 - edge0);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/** Integer hash -> [0,1). Deterministic across reloads and platforms (§5 seeding). */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Smoothstep-interpolated value noise on the integer lattice. Pure in (x, z). */
export function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);

  const top = a + (b - a) * ux;
  const bottom = c + (d - c) * ux;
  return top + (bottom - top) * uz;
}

// ---------------------------------------------------------------------------
// Boundary shape
// ---------------------------------------------------------------------------

const DEFAULT_SEED = 1337;

/**
 * Mean world Z of the boundary. Negative Z is straight ahead of a freshly spawned
 * player (§7: facing 0 points down -Z), so walking forward from spawn is the
 * traverse that crosses regions — after ~40 units of Verdant Hollow, which keeps
 * the opening minutes in the safe region §5 asks for.
 */
const BOUNDARY_Z = -55;
/** Half-width of the transition band: 30 units end to end, as the phase requires. */
const BAND_HALF = 15;
/** How far the boundary meanders, so it reads as a treeline rather than a ruler. */
const WOBBLE = 18;
/** Two octaves only. The band is 30 units wide; anything finer than this just aliases. */
const WOBBLE_WAVELENGTH = 150;
/**
 * Slight westward tilt. Purely so the boundary is not perfectly axis-aligned —
 * an east-west line across a 600-unit map is a very readable artefact.
 */
const BOUNDARY_TILT = 0.18;

const VERDANT_HOLLOW: BiomeDef = {
  id: BIOME.VerdantHollow,
  name: 'Verdant Hollow',
  // Phase 1's amplitude, so the opening area keeps the relief that was play-tested.
  amplitude: 6,
  wavelength: 36,
  ridged: false,
  colorLow: 0x3e6b33,
  colorMid: 0x6f9a44,
  colorHigh: 0xc9b45c, // §5's golden yellow, on the hilltops
  colorRock: 0x8a8a83,
  fogColor: 0xa9c68d,
  propDensity: [5, 4, 4, 0], // open hill meadow: few trees, no mushrooms
};

const WHISPERWOOD: BiomeDef = {
  id: BIOME.Whisperwood,
  name: 'Whisperwood',
  // Taller and ridged, so §5's "dense, narrow" forest gets gullies to be narrow in.
  amplitude: 10,
  wavelength: 40,
  ridged: true,
  colorLow: 0x14332b,
  colorMid: 0x265741,
  colorHigh: 0x46836b, // §5's teal
  colorRock: 0x55636e,
  fogColor: 0x3f6f7d, // §5's blue mist
  /*
   * 15 trees, not 10: a third of Whisperwood's tree candidates are rejected for
   * exceeding PropScatter's 30 deg slope limit on this biome's ridged relief, so
   * asking for 10 yielded 6.7 per chunk — a wood, not §5's "hutan padat". At 15 the
   * yield lands near 10 and the worst-case triangle total is still ~45 000 of the
   * ~95 000 the §3 budget leaves for props.
   */
  propDensity: [15, 2, 3, 6], // dense trees, glowing mushrooms
};

/** sRGB -> linear happens once, here, not per sample. */
const hexToLinear = new THREE.Color();

export class BiomeTable {
  private readonly seed: number;
  private readonly defs: readonly [BiomeDef, BiomeDef];
  /** Linear fog RGB per biome, 3 floats each. */
  private readonly fogLinear: Float32Array;

  constructor(seed: number = DEFAULT_SEED) {
    this.seed = Math.floor(seed);
    this.defs = [VERDANT_HOLLOW, WHISPERWOOD];

    this.fogLinear = new Float32Array(BIOME_COUNT * 3);
    for (let i = 0; i < BIOME_COUNT; i++) {
      const def = i === BIOME.Whisperwood ? this.defs[1] : this.defs[0];
      hexToLinear.setHex(def.fogColor);
      this.fogLinear[i * 3] = hexToLinear.r;
      this.fogLinear[i * 3 + 1] = hexToLinear.g;
      this.fogLinear[i * 3 + 2] = hexToLinear.b;
    }
  }

  get(id: BiomeId): BiomeDef {
    // Indexed off a tuple rather than an array, so the return type is not
    // `BiomeDef | undefined` under noUncheckedIndexedAccess.
    return id === BIOME.Whisperwood ? this.defs[1] : this.defs[0];
  }

  /**
   * Smooth blend at (x, z), written into `out`. Allocation-free and a pure
   * function of world (x, z) — neighbouring chunks therefore agree exactly on
   * their shared edge with no stitching.
   */
  sample(x: number, z: number, out: BiomeSample): BiomeSample {
    const seed = this.seed;
    // Mostly a function of x, so the boundary meanders along its own length
    // instead of folding back on itself.
    const wobble =
      (valueNoise(x / WOBBLE_WAVELENGTH, z / (WOBBLE_WAVELENGTH * 3), seed + 11) * 2 - 1) * 0.7 +
      (valueNoise(x / (WOBBLE_WAVELENGTH * 0.38), z / WOBBLE_WAVELENGTH, seed + 23) * 2 - 1) * 0.3;

    const distance = BOUNDARY_Z - z - x * BOUNDARY_TILT + wobble * WOBBLE;
    const whisper = smoothstep(-BAND_HALF, BAND_HALF, distance);

    const weights = out.weights;
    weights[BIOME.VerdantHollow] = 1 - whisper;
    weights[BIOME.Whisperwood] = whisper;
    out.dominant = whisper > 0.5 ? BIOME.Whisperwood : BIOME.VerdantHollow;
    return out;
  }

  /** Weighted fog colour at (x, z), written into `out`. */
  fogColorAt(sample: BiomeSample, out: THREE.Color): THREE.Color {
    const weights = sample.weights;
    const fog = this.fogLinear;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < BIOME_COUNT; i++) {
      const w = weights[i] ?? 0;
      if (w === 0) continue;
      const base = i * 3;
      r += (fog[base] ?? 0) * w;
      g += (fog[base + 1] ?? 0) * w;
      b += (fog[base + 2] ?? 0) * w;
    }
    // Written straight into the working (linear) colour space, like three's own
    // internals — setHex would re-apply an sRGB decode that already happened.
    out.r = r;
    out.g = g;
    out.b = b;
    return out;
  }
}
