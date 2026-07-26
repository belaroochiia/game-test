import * as THREE from 'three';

import { BIOME_COUNT, BiomeTable, createBiomeSample, hash2, smoothstep, valueNoise } from './BiomeTable';
import type { BiomeSample } from './BiomeTable';

/**
 * The single source of truth for world shape (§5's 600x600 map), deliberately
 * separated from any mesh. Collision must stay exact no matter which LOD a chunk
 * is currently drawn at, so Phase 1's guarantee has to be restated here rather
 * than inherited from a mesh: `heightAt()` returns the plane of the LOD0 triangle
 * containing the point, using the same diagonal split the chunk mesher builds its
 * indices from. Bilinear interpolation over the quad would be smooth but WRONG —
 * it lies in neither triangle's plane, and the player would visibly float on one
 * half of every quad and sink on the other.
 *
 * `sampleVertex()` is a pure function of world (x, z): no cache, no
 * `Math.random()`, no per-chunk rounding or offsets. That is what makes adjacent
 * chunks agree bit-for-bit on their shared edge, so same-LOD seams are exactly
 * zero with no stitching pass at all.
 *
 * Everything on the hot path is allocation-free (§3: 0 byte/frame). `heightAt`
 * runs several times per tick for collision and the camera; `sampleVertex` and
 * `colorAt` run tens of thousands of times per chunk build.
 */

/** What PlayerController and CameraRig need. TerrainGen already satisfies this. */
export interface HeightSampler {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  slopeAt(x: number, z: number): number;
  inBounds(x: number, z: number): boolean;
}

export interface HeightFieldOptions {
  seed?: number; // default 1337
  worldSize?: number; // default 600 (§5)
  chunkSize?: number; // default 50 (§5)
  /** LOD0 cells per chunk edge. Defines the collision grid. Default 50 => 1 u spacing. */
  baseCells?: number;
}

const DEFAULT_SEED = 1337;
const DEFAULT_WORLD_SIZE = 600;
const DEFAULT_CHUNK_SIZE = 50;
const DEFAULT_BASE_CELLS = 50;

/** Water sits here (§5's fog sea); anything below is submerged and gets no props. */
export const SEA_LEVEL = -3;

/**
 * Three octaves, not Phase 1's four. A four-octave stack at wavelength 36 puts
 * its finest detail at 4.5 u, which LOD1's 3.125 u spacing cannot resolve — the
 * chunk would visibly change shape on a LOD swap, which is exactly the popping
 * §12 fails the phase for. Three octaves keep the smallest feature at 9 u,
 * comfortably above LOD1's Nyquist limit, and cost 25 % less in a function the
 * mesher calls ~10 000 times per chunk build.
 */
const OCTAVES = 3;
/** Decorrelates octaves; same constant Phase 1 used. */
const OCTAVE_SEED_STRIDE = 7919;

/** Spawn stays flat inside this radius, easing out to FLAT_FADE (Phase 1 values). */
const FLAT_RADIUS = 6;
const FLAT_FADE = 13;

/**
 * A deliberate ridge steeper than §7's 45 deg limit so sliding stays testable,
 * inherited from Phase 1. Unlike Phase 1 it is windowed along Z as well: an
 * un-windowed Gaussian ridge would run the full 600 units and wall off the map.
 */
const RIDGE_X = 14;
const RIDGE_Z = 0;
const RIDGE_WIDTH = 2.6;
const RIDGE_LENGTH = 30;
const RIDGE_HEIGHT = 5.4;

/** §5: the border is a cliff into fog, not an invisible wall. */
const EDGE_MARGIN = 20;
/** How far below sea level the rim settles — deep enough to read as a drop. */
const EDGE_DROP = 24;
/** Continued fall per unit past the world rect, so there is no walkable shelf. */
const EDGE_FALL = 1.2;

const SLOPE_ROCK_START = (32 * Math.PI) / 180;
const SLOPE_ROCK_FULL = (46 * Math.PI) / 180;
const RAMP_MID_LO = 0.08;
const RAMP_MID_HI = 0.42;
const RAMP_HIGH_LO = 0.45;
const RAMP_HIGH_HI = 0.9;
/** Per-vertex colour jitter, or large flat areas look like plastic (Phase 1). */
const JITTER_SEED = 104729;
const JITTER_BASE = 0.94;
const JITTER_SPAN = 0.12;

/** Palette slots per biome, in the order they are packed: low, mid, high, rock. */
const PALETTE_SLOTS = 4;

const hexToLinear = new THREE.Color();

export class HeightField implements HeightSampler {
  readonly worldSize: number;
  readonly chunkSize: number;
  readonly chunksPerSide: number; // 12
  readonly spacing: number; // LOD0 vertex spacing, 1.0
  /** LOD0 cells per chunk edge. The chunk mesher needs this to match the collision grid. */
  readonly baseCells: number;
  readonly seed: number;
  /** The table this field was shaped by — pass it to ChunkManager so they agree. */
  readonly biomes: BiomeTable;

  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;

  private readonly invSpacing: number;
  private readonly edgeInner: number;
  private readonly edgeOuter: number;

  /** Per-biome shaping, unpacked into typed arrays so sampling never touches an object. */
  private readonly biomeAmplitude: Float32Array;
  private readonly biomeWavelength: Float32Array;
  private readonly biomeRidged: Float32Array;
  /** Linear RGB, BIOME_COUNT * PALETTE_SLOTS * 3. */
  private readonly palette: Float32Array;

  /** Separate scratches: a caller may hold the result of biomeAt across a heightAt. */
  private readonly fieldSample: BiomeSample = createBiomeSample();
  private readonly colorSample: BiomeSample = createBiomeSample();

  /** Output of resolveTriangle: height and the containing triangle's plane gradient. */
  private triHeight = 0;
  private triDu = 0;
  private triDv = 0;

  constructor(options?: HeightFieldOptions, biomes?: BiomeTable) {
    this.seed = Math.floor(options?.seed ?? DEFAULT_SEED);
    this.worldSize = options?.worldSize ?? DEFAULT_WORLD_SIZE;
    this.chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.baseCells = Math.max(1, Math.floor(options?.baseCells ?? DEFAULT_BASE_CELLS));
    this.biomes = biomes ?? new BiomeTable(this.seed);

    this.chunksPerSide = Math.max(1, Math.round(this.worldSize / this.chunkSize));
    this.spacing = this.chunkSize / this.baseCells;
    this.invSpacing = 1 / this.spacing;

    // The grid origin is the world corner, which is a whole number of chunks and
    // therefore a whole number of cells away from every chunk origin. That is why
    // a mesher's `chunkMinX + i * spacing` lands on exactly the vertices heightAt
    // samples, with no float drift to reconcile.
    this.minX = -this.worldSize * 0.5;
    this.minZ = -this.worldSize * 0.5;
    this.maxX = this.minX + this.worldSize;
    this.maxZ = this.minZ + this.worldSize;

    this.edgeInner = this.worldSize * 0.5 - EDGE_MARGIN;
    this.edgeOuter = this.worldSize * 0.5;

    this.biomeAmplitude = new Float32Array(BIOME_COUNT);
    this.biomeWavelength = new Float32Array(BIOME_COUNT);
    this.biomeRidged = new Float32Array(BIOME_COUNT);
    this.palette = new Float32Array(BIOME_COUNT * PALETTE_SLOTS * 3);

    for (let i = 0; i < BIOME_COUNT; i++) {
      const def = this.biomes.get(i as 0 | 1);
      this.biomeAmplitude[i] = def.amplitude;
      this.biomeWavelength[i] = def.wavelength;
      this.biomeRidged[i] = def.ridged ? 1 : 0;
      this.packColor(i, 0, def.colorLow);
      this.packColor(i, 1, def.colorMid);
      this.packColor(i, 2, def.colorHigh);
      this.packColor(i, 3, def.colorRock);
    }
  }

  /**
   * Raw field height at (x, z), in world units. Defined everywhere, not only on
   * grid vertices, so a LOD1 mesher can sample its coarser lattice from the same
   * function. Pure, allocation-free, and the only place world shape is decided.
   */
  sampleVertex(x: number, z: number): number {
    const seed = this.seed;
    const sample = this.biomes.sample(x, z, this.fieldSample);
    const weights = sample.weights;

    // Blended shaping. Wavelength varies smoothly, so the two regions' relief
    // grades into each other instead of butting up against a discontinuity.
    let amplitude = 0;
    let wavelength = 0;
    let ridgeWeight = 0;
    for (let i = 0; i < BIOME_COUNT; i++) {
      const w = weights[i] ?? 0;
      if (w <= 0) continue;
      amplitude += (this.biomeAmplitude[i] ?? 0) * w;
      wavelength += (this.biomeWavelength[i] ?? 0) * w;
      ridgeWeight += (this.biomeRidged[i] ?? 0) * w;
    }
    if (wavelength < 1e-3) wavelength = 1;

    // Smooth and ridged shapes share one octave loop: the ridged variant is a
    // fold of the same noise value, so blending between them costs no extra
    // hashing — only two accumulators.
    let frequency = 1 / wavelength;
    let octaveAmplitude = 1;
    let total = 0;
    let smooth = 0;
    let ridged = 0;
    for (let octave = 0; octave < OCTAVES; octave++) {
      const n = valueNoise(x * frequency, z * frequency, seed + octave * OCTAVE_SEED_STRIDE);
      smooth += n * octaveAmplitude;
      const folded = n * 2 - 1;
      ridged += (1 - (folded < 0 ? -folded : folded)) * octaveAmplitude;
      total += octaveAmplitude;
      octaveAmplitude *= 0.5;
      frequency *= 2;
    }
    const shape = (smooth * (1 - ridgeWeight) + ridged * ridgeWeight) / total;

    let h = (shape * 2 - 1) * amplitude;

    // Flatten the spawn area so the first thing the player does is walk, not climb.
    const distance = Math.sqrt(x * x + z * z);
    h *= smoothstep(FLAT_RADIUS, FLAT_FADE, distance);

    // One face steeper than the 45 deg limit, within sight of spawn (§7's slide).
    const ridgeDx = (x - RIDGE_X) / RIDGE_WIDTH;
    const ridgeDz = (z - RIDGE_Z) / RIDGE_LENGTH;
    h += RIDGE_HEIGHT * Math.exp(-ridgeDx * ridgeDx - ridgeDz * ridgeDz);

    // §5's border: a cliff into the fog sea. Chebyshev distance, so the drop runs
    // parallel to the map edges instead of forming a circular bowl.
    const ax = x < 0 ? -x : x;
    const az = z < 0 ? -z : z;
    const rim = ax > az ? ax : az;
    if (rim > this.edgeInner) {
      const t = smoothstep(this.edgeInner, this.edgeOuter, rim);
      const floorY = SEA_LEVEL - EDGE_DROP;
      h += (floorY - h) * t;
      // Keep falling outside the rect, so there is no walkable shelf to stand on.
      if (rim > this.edgeOuter) h -= (rim - this.edgeOuter) * EDGE_FALL;
    }

    return h;
  }

  /** Collision height: the plane of the LOD0 triangle containing (x, z). */
  heightAt(x: number, z: number): number {
    this.resolveTriangle(x, z);
    return this.triHeight;
  }

  /** Unit surface normal of the containing LOD0 triangle, written into `out`. */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    this.resolveTriangle(x, z);
    // The triangle plane is h = h00 + du*u + dv*v, so the gradient is constant
    // across it and the normal is exact, not a finite difference.
    out.set(-this.triDu * this.invSpacing, 1, -this.triDv * this.invSpacing);
    return out.normalize();
  }

  /** Slope in radians from vertical: 0 is flat. */
  slopeAt(x: number, z: number): number {
    this.resolveTriangle(x, z);
    const dx = this.triDu * this.invSpacing;
    const dz = this.triDv * this.invSpacing;
    return Math.atan(Math.sqrt(dx * dx + dz * dz));
  }

  inBounds(x: number, z: number): boolean {
    return x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ;
  }

  /** Biome weights at (x, z), written into `out`. */
  biomeAt(x: number, z: number, out: BiomeSample): BiomeSample {
    return this.biomes.sample(x, z, out);
  }

  /**
   * Vertex colour for the terrain mesh, written into `out` (r,g,b in 0..1 linear).
   *
   * The height ramp is anchored to the *blended amplitude*, never to a chunk's own
   * min/max: normalising per chunk would make the same hillside a different colour
   * depending on which chunk it fell in, which is a seam that moves as you walk.
   */
  colorAt(x: number, z: number, out: THREE.Color): THREE.Color {
    this.resolveTriangle(x, z);
    const h = this.triHeight;
    const dx = this.triDu * this.invSpacing;
    const dz = this.triDv * this.invSpacing;
    const slope = Math.atan(Math.sqrt(dx * dx + dz * dz));

    const weights = this.biomes.sample(x, z, this.colorSample).weights;
    const palette = this.palette;

    let amplitude = 0;
    let lowR = 0;
    let lowG = 0;
    let lowB = 0;
    let midR = 0;
    let midG = 0;
    let midB = 0;
    let highR = 0;
    let highG = 0;
    let highB = 0;
    let rockR = 0;
    let rockG = 0;
    let rockB = 0;
    for (let i = 0; i < BIOME_COUNT; i++) {
      const w = weights[i] ?? 0;
      if (w <= 0) continue;
      amplitude += (this.biomeAmplitude[i] ?? 0) * w;
      const base = i * PALETTE_SLOTS * 3;
      lowR += (palette[base] ?? 0) * w;
      lowG += (palette[base + 1] ?? 0) * w;
      lowB += (palette[base + 2] ?? 0) * w;
      midR += (palette[base + 3] ?? 0) * w;
      midG += (palette[base + 4] ?? 0) * w;
      midB += (palette[base + 5] ?? 0) * w;
      highR += (palette[base + 6] ?? 0) * w;
      highG += (palette[base + 7] ?? 0) * w;
      highB += (palette[base + 8] ?? 0) * w;
      rockR += (palette[base + 9] ?? 0) * w;
      rockG += (palette[base + 10] ?? 0) * w;
      rockB += (palette[base + 11] ?? 0) * w;
    }
    if (amplitude < 1e-3) amplitude = 1;

    let t = (h + amplitude) / (2 * amplitude);
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    const toMid = smoothstep(RAMP_MID_LO, RAMP_MID_HI, t);
    const toHigh = smoothstep(RAMP_HIGH_LO, RAMP_HIGH_HI, t);
    // Rock wherever it is too steep to hold soil — reads as readable relief.
    const toRock = smoothstep(SLOPE_ROCK_START, SLOPE_ROCK_FULL, slope);

    let r = lowR + (midR - lowR) * toMid;
    let g = lowG + (midG - lowG) * toMid;
    let b = lowB + (midB - lowB) * toMid;
    r += (highR - r) * toHigh;
    g += (highG - g) * toHigh;
    b += (highB - b) * toHigh;
    r += (rockR - r) * toRock;
    g += (rockG - g) * toRock;
    b += (rockB - b) * toRock;

    // Jitter keyed to the LOD0 grid cell, so it is a pure function of position and
    // cannot flicker as chunks stream in and out.
    const gi = Math.round((x - this.minX) * this.invSpacing);
    const gj = Math.round((z - this.minZ) * this.invSpacing);
    const jitter = JITTER_BASE + hash2(gi, gj, this.seed + JITTER_SEED) * JITTER_SPAN;

    out.r = r * jitter;
    out.g = g * jitter;
    out.b = b * jitter;
    return out;
  }

  /**
   * Snaps to the LOD0 grid and resolves the triangle containing (x, z), leaving
   * its interpolated height and plane gradient in `triHeight`/`triDu`/`triDv`.
   *
   * The quad's diagonal runs from local (0,0) to (1,1) — the same split the chunk
   * mesher emits its indices with — so `v > u` is the (v00, v01, v11) triangle and
   * otherwise it is (v00, v11, v10). Both reduce to the same value on the diagonal
   * itself, so the surface is continuous. Only the three corners the chosen
   * triangle actually uses are sampled; the fourth is never needed, which is a
   * quarter of the field evaluations saved on the hottest path in the phase.
   *
   * Coordinates are not clamped to the world rect: the field keeps ramping down
   * outside it (§5's drop into fog), and clamping would replace that with a flat
   * shelf the player could stand on.
   */
  private resolveTriangle(x: number, z: number): void {
    const spacing = this.spacing;
    const gx = (x - this.minX) * this.invSpacing;
    const gz = (z - this.minZ) * this.invSpacing;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const u = gx - i;
    const v = gz - j;

    const x0 = this.minX + i * spacing;
    const z0 = this.minZ + j * spacing;
    const h00 = this.sampleVertex(x0, z0);
    const h11 = this.sampleVertex(x0 + spacing, z0 + spacing);

    if (v > u) {
      const h01 = this.sampleVertex(x0, z0 + spacing);
      this.triDu = h11 - h01;
      this.triDv = h01 - h00;
    } else {
      const h10 = this.sampleVertex(x0 + spacing, z0);
      this.triDu = h10 - h00;
      this.triDv = h11 - h10;
    }
    this.triHeight = h00 + u * this.triDu + v * this.triDv;
  }

  /** sRGB -> linear once per palette entry at construction, never per sample. */
  private packColor(biome: number, slot: number, hex: number): void {
    hexToLinear.setHex(hex);
    const base = (biome * PALETTE_SLOTS + slot) * 3;
    this.palette[base] = hexToLinear.r;
    this.palette[base + 1] = hexToLinear.g;
    this.palette[base + 2] = hexToLinear.b;
  }
}
