import * as THREE from 'three';

/**
 * §5's full region table, Phase 5: Verdant Hollow (centre), Whisperwood
 * (south), Emberscar (east), Frostvale (west) and The Hollow Spire (far
 * north).
 *
 * Every boundary is a *field*, not a line: a spatial gradient resolved through
 * a ~30-unit smoothstep band, wobbled by low-frequency noise so borders wander
 * organically. §12 fails the phase for obvious popping and a hard colour seam
 * is popping, so nothing here ever makes a discrete decision about which biome
 * a point belongs to except `dominant`, which only prop selection and other
 * yes/no calls use.
 *
 * The layout (a Phase 5 contract decision, not up for local re-litigating):
 * Verdant Hollow is a disc of radius ~110 around the origin; Whisperwood is
 * everything south of z ~ -60 — it carves into the disc's southern cap, which
 * keeps Phase 2's device-verified southern traverse (spawn -> forest inside
 * 125 u) intact; Emberscar is the east beyond x ~ +70, Frostvale the mirror
 * west, and the Spire owns the far north beyond z ~ +120, taking priority over
 * east and west in the corners. Weights come from a priority chain of masks,
 * so they sum to exactly 1 with no normalisation divide.
 *
 * The value-noise primitives live in this module rather than a third one:
 * the world file list is fixed, and `HeightField -> BiomeTable` is the only
 * dependency direction between the two, so exporting them here cannot create a
 * cycle.
 */

export const BIOME = {
  VerdantHollow: 0,
  Whisperwood: 1,
  Emberscar: 2,
  Frostvale: 3,
  HollowSpire: 4,
} as const;
export type BiomeId = (typeof BIOME)[keyof typeof BIOME];
export const BIOME_COUNT = 5;

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
  readonly ridged: boolean; // ridged noise reads as harsh, creased relief
  /** Vertex colour ramp, low -> high, plus the rock colour for steep faces. */
  readonly colorLow: number;
  readonly colorMid: number;
  readonly colorHigh: number;
  readonly colorRock: number;
  /**
   * Below-sea hollows, §5's fake-glow doctrine: Emberscar's sunken basins are
   * vertex-coloured glowing orange (lava), Frostvale's ice-white (frozen
   * lakes). `hollowGlow` scales the packed linear colour — > 1 reads as
   * emissive under any light — and 0 disables the feature for the biome.
   * The single global Water plane is untouched; this is colour only.
   */
  readonly hollowColor: number;
  readonly hollowGlow: number;
  /** Fog tint contribution, blended by weight (§5's per-region atmosphere). */
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
// Region layout (see the module comment; values are the contract's)
// ---------------------------------------------------------------------------

const DEFAULT_SEED = 1337;

/** Verdant Hollow disc: full weight inside 95, gone by 125 (a 30 u band at r ~ 110). */
const DISC_IN = 95;
const DISC_OUT = 125;
/** Whisperwood south of z ~ -60: mask over -z in 45..75. */
const WHISPER_IN = 45;
const WHISPER_OUT = 75;
/** Emberscar east / Frostvale west of |x| ~ 70: mask over +/-x in 55..85. */
const FLANK_IN = 55;
const FLANK_OUT = 85;
/** The Hollow Spire north of z ~ +120: mask over z in 105..135. */
const SPIRE_IN = 105;
const SPIRE_OUT = 135;

/**
 * How far borders meander. 12, down from Phase 2's 18: with four borders and a
 * disc the wobbles can stack across a corner, and 12 keeps the worst measured
 * weight gradient in the same ~0.05/u class the 30 u band promises.
 */
const WOBBLE = 12;
/** Two octaves only. The band is 30 units wide; anything finer than this just aliases. */
const WOBBLE_WAVELENGTH = 150;

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
  hollowColor: 0x000000,
  hollowGlow: 0,
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
  hollowColor: 0x000000,
  hollowGlow: 0,
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

const EMBERSCAR: BiomeDef = {
  id: BIOME.Emberscar,
  name: 'Emberscar',
  // Ridged and harsh (§5's volcanic mountains), the steepest walkable region.
  amplitude: 12,
  wavelength: 36,
  ridged: true,
  colorLow: 0x4a3227, // ash-brown basins
  colorMid: 0x8f4a2b, // §5's brick red
  colorHigh: 0xd06a2e, // orange on the crests
  colorRock: 0x57453c, // basalt
  hollowColor: 0xff7a1c, // sunken basins glow as lava (vertex colour only)
  hollowGlow: 1.9,
  fogColor: 0xb0713f, // hot ash haze
  propDensity: [1, 9, 0, 2], // scorched near-treeless rubble field; ember vents
};

const FROSTVALE: BiomeDef = {
  id: BIOME.Frostvale,
  name: 'Frostvale',
  // Rolling: lower and broader than everything east of it (§5's snow valley).
  amplitude: 7,
  wavelength: 52,
  ridged: false,
  colorLow: 0x8fb3c4, // shadowed ice-blue hollows
  colorMid: 0xdde9ee, // snow
  colorHigh: 0xf7fbfd, // bright drifts
  colorRock: 0x6f87a0,
  hollowColor: 0xe4f6ff, // sunken basins read as frozen lakes
  hollowGlow: 1.15,
  fogColor: 0xc7dbe8, // §5's pale cyan
  propDensity: [6, 5, 2, 0], // snowy pines and rubble, nothing lush
};

const HOLLOW_SPIRE: BiomeDef = {
  id: BIOME.HollowSpire,
  name: 'The Hollow Spire',
  // Jagged: the tallest amplitude on the shortest wavelength that stays above
  // LOD1's Nyquist limit (32 / 4 = 8 u >= 3.125 u).
  amplitude: 14,
  wavelength: 32,
  ridged: true,
  colorLow: 0x221735, // void
  colorMid: 0x3f2b63, // §5's dark purple
  colorHigh: 0x8b3f9e, // magenta on the spikes
  colorRock: 0x352c47,
  hollowColor: 0x000000,
  hollowGlow: 0,
  fogColor: 0x4d3d6b, // violet murk
  propDensity: [0, 7, 0, 5], // shattered rubble + void shards (tinted mushrooms)
};

/** sRGB -> linear happens once, here, not per sample. */
const hexToLinear = new THREE.Color();

export class BiomeTable {
  private readonly seed: number;
  private readonly defs: readonly [BiomeDef, BiomeDef, BiomeDef, BiomeDef, BiomeDef];
  /** Linear fog RGB per biome, 3 floats each. */
  private readonly fogLinear: Float32Array;

  constructor(seed: number = DEFAULT_SEED) {
    this.seed = Math.floor(seed);
    this.defs = [VERDANT_HOLLOW, WHISPERWOOD, EMBERSCAR, FROSTVALE, HOLLOW_SPIRE];

    this.fogLinear = new Float32Array(BIOME_COUNT * 3);
    for (let i = 0; i < BIOME_COUNT; i++) {
      const def = this.get(i as BiomeId);
      hexToLinear.setHex(def.fogColor);
      this.fogLinear[i * 3] = hexToLinear.r;
      this.fogLinear[i * 3 + 1] = hexToLinear.g;
      this.fogLinear[i * 3 + 2] = hexToLinear.b;
    }
  }

  get(id: BiomeId): BiomeDef {
    // Indexed off a tuple rather than an array, so the return type is not
    // `BiomeDef | undefined` under noUncheckedIndexedAccess.
    return this.defs[id];
  }

  /**
   * Smooth blend at (x, z), written into `out`. Allocation-free and a pure
   * function of world (x, z) — neighbouring chunks therefore agree exactly on
   * their shared edge with no stitching.
   *
   * Two wobble fields, not one per border: `wobX` (varies mostly along z)
   * bends the east/west borders, `wobZ` (varies mostly along x) bends the
   * south/north ones, and their mean bends the disc.
   *
   * The wobbles are computed ONLY when a mask is inside its uncertain strip:
   * |wob| <= WOBBLE, so any coordinate more than WOBBLE outside its band
   * saturates the smoothstep to exactly 0 or 1 no matter what the noise says,
   * and substituting 0 for the unevaluated wobble provably returns the same
   * value. Region interiors — almost every sample the mesher takes — therefore
   * cost zero noise calls, cheaper than Phase 2's two; only the ~54 u border
   * strips pay for up to four.
   */
  sample(x: number, z: number, out: BiomeSample): BiomeSample {
    const seed = this.seed;
    const radius = Math.sqrt(x * x + z * z);
    const needDisc = radius > DISC_IN - WOBBLE && radius < DISC_OUT + WOBBLE;
    const needZ =
      needDisc ||
      (-z > WHISPER_IN - WOBBLE && -z < WHISPER_OUT + WOBBLE) ||
      (z > SPIRE_IN - WOBBLE && z < SPIRE_OUT + WOBBLE);
    const needX =
      needDisc ||
      (x > FLANK_IN - WOBBLE && x < FLANK_OUT + WOBBLE) ||
      (-x > FLANK_IN - WOBBLE && -x < FLANK_OUT + WOBBLE);

    const wl = WOBBLE_WAVELENGTH;
    let wobX = 0;
    let wobZ = 0;
    if (needX) {
      wobX =
        ((valueNoise(x / (wl * 3), z / wl, seed + 11) * 2 - 1) * 0.7 +
          (valueNoise(x / wl, z / (wl * 0.38), seed + 23) * 2 - 1) * 0.3) *
        WOBBLE;
    }
    if (needZ) {
      wobZ =
        ((valueNoise(x / wl, z / (wl * 3), seed + 37) * 2 - 1) * 0.7 +
          (valueNoise(x / (wl * 0.38), z / wl, seed + 41) * 2 - 1) * 0.3) *
        WOBBLE;
    }

    // Priority chain: Whisperwood claims the south outright (it may carve the
    // disc's southern cap), then the disc protects Verdant from the other
    // three, then the Spire outranks the flanks in the far north. Every weight
    // is a product of masks, so the five always sum to exactly 1.
    const whisper = smoothstep(WHISPER_IN, WHISPER_OUT, -z + wobZ);
    const open = smoothstep(DISC_IN, DISC_OUT, radius + (wobX + wobZ) * 0.5);
    const spireMask = smoothstep(SPIRE_IN, SPIRE_OUT, z + wobZ);
    const emberMask = smoothstep(FLANK_IN, FLANK_OUT, x + wobX);
    const frostMask = smoothstep(FLANK_IN, FLANK_OUT, -x + wobX);

    const north = (1 - whisper) * open;
    const spire = north * spireMask;
    const flank = north - spire;
    const ember = flank * emberMask;
    const frost = flank * (1 - emberMask) * frostMask;

    const weights = out.weights;
    weights[BIOME.Whisperwood] = whisper;
    weights[BIOME.HollowSpire] = spire;
    weights[BIOME.Emberscar] = ember;
    weights[BIOME.Frostvale] = frost;
    weights[BIOME.VerdantHollow] = 1 - whisper - spire - ember - frost;

    let dominant = 0;
    let best = weights[0] ?? 0;
    for (let i = 1; i < BIOME_COUNT; i++) {
      const w = weights[i] ?? 0;
      if (w > best) {
        best = w;
        dominant = i;
      }
    }
    out.dominant = dominant as BiomeId;
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
