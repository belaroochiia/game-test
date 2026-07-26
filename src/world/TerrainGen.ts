import * as THREE from 'three';

/**
 * Procedural terrain for one chunk (§5's 50x50-unit grid cell), vertex-coloured
 * with no textures at all (§5). Phase 2 turns this into streamed chunks; the API
 * is already chunk-shaped (`originX`/`originZ`) so that change stays local.
 *
 * The contract that matters most here: `heightAt()` returns the plane of the
 * triangle the GPU actually draws. A single `Float32Array` of grid heights is the
 * only source of truth, and both the index buffer and `heightAt` derive the same
 * diagonal split from it — so they cannot disagree, and the player cannot float
 * on one half of a quad and sink on the other.
 */

export interface TerrainOptions {
  seed?: number;
  size?: number;
  cells?: number;
  amplitude?: number;
  originX?: number;
  originZ?: number;
}

const DEFAULT_SEED = 1337;
const DEFAULT_SIZE = 50;
const DEFAULT_CELLS = 50;
const DEFAULT_AMPLITUDE = 6;

/** Base feature size in world units — bigger means smoother, more walkable hills. */
const NOISE_WAVELENGTH = 18;
const OCTAVES = 4;

/** Spawn stays flat inside this radius, easing out to FLAT_FADE (§12: land, then walk). */
const FLAT_RADIUS = 6;
const FLAT_FADE = 13;

/** A deliberate ridge steeper than §7's 45 deg limit, so sliding is testable. */
const RIDGE_X = 14;
const RIDGE_WIDTH = 2.6;
const RIDGE_HEIGHT = 5.4;

const SLOPE_ROCK_START = (32 * Math.PI) / 180;
const SLOPE_ROCK_FULL = (46 * Math.PI) / 180;

/** Verdant Hollow palette (§5). Built through THREE.Color so sRGB->linear is handled. */
const COLOR_HOLLOW = new THREE.Color(0x3e6b33);
const COLOR_GRASS = new THREE.Color(0x5f8f3c);
const COLOR_GRASS_HIGH = new THREE.Color(0x8ea94f);
const COLOR_GOLD = new THREE.Color(0xc9b45c);
const COLOR_ROCK = new THREE.Color(0x8a8a83);

const scratchColor = new THREE.Color();

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  let t = (value - edge0) / (edge1 - edge0);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/** Integer hash -> [0,1). Deterministic across reloads and platforms (§5 seeding). */
function hash2(ix: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function valueNoise(x: number, z: number, seed: number): number {
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

function fbm(x: number, z: number, seed: number): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1 / NOISE_WAVELENGTH;
  for (let octave = 0; octave < OCTAVES; octave++) {
    sum += valueNoise(x * frequency, z * frequency, seed + octave * 7919) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total > 0 ? sum / total : 0;
}

export class TerrainGen {
  readonly mesh: THREE.Mesh;
  readonly size: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;

  private readonly cells: number;
  private readonly verts: number;
  private readonly spacing: number;
  private readonly invSpacing: number;
  /** (cells+1)^2 grid heights, row-major by z. The single source of truth. */
  private readonly heights: Float32Array;

  constructor(options?: TerrainOptions) {
    const seed = options?.seed ?? DEFAULT_SEED;
    this.size = options?.size ?? DEFAULT_SIZE;
    this.cells = Math.max(1, Math.floor(options?.cells ?? DEFAULT_CELLS));
    const amplitude = options?.amplitude ?? DEFAULT_AMPLITUDE;
    const originX = options?.originX ?? 0;
    const originZ = options?.originZ ?? 0;

    this.verts = this.cells + 1;
    this.spacing = this.size / this.cells;
    this.invSpacing = 1 / this.spacing;
    this.minX = originX - this.size * 0.5;
    this.minZ = originZ - this.size * 0.5;
    this.maxX = this.minX + this.size;
    this.maxZ = this.minZ + this.size;

    const vertexCount = this.verts * this.verts;
    this.heights = new Float32Array(vertexCount);

    // --- pass 1: heights -------------------------------------------------
    let minHeight = Number.POSITIVE_INFINITY;
    let maxHeight = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < this.verts; j++) {
      const z = this.minZ + j * this.spacing;
      for (let i = 0; i < this.verts; i++) {
        const x = this.minX + i * this.spacing;

        let h = (fbm(x, z, seed) * 2 - 1) * amplitude;

        // Flatten the spawn area so the first thing the player does is walk, not climb.
        const distance = Math.sqrt(x * x + z * z);
        h *= smoothstep(FLAT_RADIUS, FLAT_FADE, distance);

        // One face steeper than the 45 deg limit, so §7's slide is reachable on foot.
        const ridgeDx = (x - RIDGE_X) / RIDGE_WIDTH;
        h += RIDGE_HEIGHT * Math.exp(-ridgeDx * ridgeDx);

        this.heights[j * this.verts + i] = h;
        if (h < minHeight) minHeight = h;
        if (h > maxHeight) maxHeight = h;
      }
    }

    // --- pass 2: geometry + vertex colours -------------------------------
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const heightSpan = maxHeight - minHeight > 1e-5 ? maxHeight - minHeight : 1;

    for (let j = 0; j < this.verts; j++) {
      for (let i = 0; i < this.verts; i++) {
        const index = j * this.verts + i;
        const h = this.heights[index] ?? 0;
        const x = this.minX + i * this.spacing;
        const z = this.minZ + j * this.spacing;

        positions[index * 3] = x;
        positions[index * 3 + 1] = h;
        positions[index * 3 + 2] = z;

        const t = (h - minHeight) / heightSpan;
        scratchColor.copy(COLOR_HOLLOW);
        scratchColor.lerp(COLOR_GRASS, smoothstep(0.05, 0.3, t));
        scratchColor.lerp(COLOR_GRASS_HIGH, smoothstep(0.3, 0.62, t));
        scratchColor.lerp(COLOR_GOLD, smoothstep(0.62, 0.92, t));

        // Rock wherever it is too steep to hold soil — reads as readable relief.
        const slope = this.gridSlope(i, j);
        scratchColor.lerp(COLOR_ROCK, smoothstep(SLOPE_ROCK_START, SLOPE_ROCK_FULL, slope));

        // A little per-vertex jitter, or large flat areas look like plastic.
        const jitter = 0.94 + hash2(i, j, seed + 104729) * 0.12;
        colors[index * 3] = scratchColor.r * jitter;
        colors[index * 3 + 1] = scratchColor.g * jitter;
        colors[index * 3 + 2] = scratchColor.b * jitter;
      }
    }

    // --- pass 3: indices -------------------------------------------------
    // Diagonal runs from corner (i,j) to (i+1,j+1); heightAt() splits on u == v to
    // match. Winding chosen so both triangles face +Y.
    const quadCount = this.cells * this.cells;
    const indices = new Uint32Array(quadCount * 6);
    let cursor = 0;
    for (let j = 0; j < this.cells; j++) {
      for (let i = 0; i < this.cells; i++) {
        const v00 = j * this.verts + i;
        const v10 = v00 + 1;
        const v01 = v00 + this.verts;
        const v11 = v01 + 1;
        indices[cursor++] = v00;
        indices[cursor++] = v01;
        indices[cursor++] = v11;
        indices[cursor++] = v00;
        indices[cursor++] = v11;
        indices[cursor++] = v10;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    // flatShading uses screen-space derivatives, so an indexed mesh still reads as
    // faceted — 2 601 vertices instead of 15 000 for the same look (§3).
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'terrain';
    this.mesh.frustumCulled = true;
  }

  /** Grid height with clamped indices, so edge sampling never leaves the array. */
  private gridHeight(i: number, j: number): number {
    const last = this.verts - 1;
    const ci = i < 0 ? 0 : i > last ? last : i;
    const cj = j < 0 ? 0 : j > last ? last : j;
    return this.heights[cj * this.verts + ci] ?? 0;
  }

  /** Central-difference slope at a grid vertex — colouring only, not collision. */
  private gridSlope(i: number, j: number): number {
    const dx = (this.gridHeight(i + 1, j) - this.gridHeight(i - 1, j)) / (2 * this.spacing);
    const dz = (this.gridHeight(i, j + 1) - this.gridHeight(i, j - 1)) / (2 * this.spacing);
    return Math.atan(Math.sqrt(dx * dx + dz * dz));
  }

  /**
   * Ground height under (x, z), analytic rather than a raycast (§7).
   *
   * Interpolates across the exact triangle containing the point: the quad's
   * diagonal goes from local (0,0) to (1,1), so `v > u` is the (v00, v01, v11)
   * triangle and otherwise it is (v00, v11, v10). Both reduce to the same value on
   * the diagonal itself, so the surface is continuous. Bilinear interpolation over
   * the quad would be smooth but WRONG — it does not lie in either triangle's plane.
   */
  heightAt(x: number, z: number): number {
    const last = this.cells - 1;

    let gx = (x - this.minX) * this.invSpacing;
    let gz = (z - this.minZ) * this.invSpacing;
    // Clamp into the grid so outside the chunk reads as the nearest edge.
    if (gx < 0) gx = 0;
    else if (gx > this.cells) gx = this.cells;
    if (gz < 0) gz = 0;
    else if (gz > this.cells) gz = this.cells;

    let i = Math.floor(gx);
    let j = Math.floor(gz);
    if (i > last) i = last;
    if (j > last) j = last;

    const u = gx - i;
    const v = gz - j;

    const base = j * this.verts + i;
    const h00 = this.heights[base] ?? 0;
    const h10 = this.heights[base + 1] ?? 0;
    const h01 = this.heights[base + this.verts] ?? 0;
    const h11 = this.heights[base + this.verts + 1] ?? 0;

    if (v > u) return h00 + v * (h01 - h00) + u * (h11 - h01);
    return h00 + u * (h10 - h00) + v * (h11 - h10);
  }

  /** Unit surface normal of the containing triangle, written into `out`. */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const last = this.cells - 1;

    let gx = (x - this.minX) * this.invSpacing;
    let gz = (z - this.minZ) * this.invSpacing;
    if (gx < 0) gx = 0;
    else if (gx > this.cells) gx = this.cells;
    if (gz < 0) gz = 0;
    else if (gz > this.cells) gz = this.cells;

    let i = Math.floor(gx);
    let j = Math.floor(gz);
    if (i > last) i = last;
    if (j > last) j = last;

    const u = gx - i;
    const v = gz - j;

    const base = j * this.verts + i;
    const h00 = this.heights[base] ?? 0;
    const h10 = this.heights[base + 1] ?? 0;
    const h01 = this.heights[base + this.verts] ?? 0;
    const h11 = this.heights[base + this.verts + 1] ?? 0;

    // The triangle plane is h = h00 + du*u + dv*v, so its gradient is constant
    // across the triangle and the normal is exact, not a finite difference.
    let du: number;
    let dv: number;
    if (v > u) {
      du = h11 - h01;
      dv = h01 - h00;
    } else {
      du = h10 - h00;
      dv = h11 - h10;
    }

    out.set(-du * this.invSpacing, 1, -dv * this.invSpacing);
    return out.normalize();
  }

  /** Slope in radians from vertical: 0 is flat. */
  slopeAt(x: number, z: number): number {
    const last = this.cells - 1;

    let gx = (x - this.minX) * this.invSpacing;
    let gz = (z - this.minZ) * this.invSpacing;
    if (gx < 0) gx = 0;
    else if (gx > this.cells) gx = this.cells;
    if (gz < 0) gz = 0;
    else if (gz > this.cells) gz = this.cells;

    let i = Math.floor(gx);
    let j = Math.floor(gz);
    if (i > last) i = last;
    if (j > last) j = last;

    const u = gx - i;
    const v = gz - j;

    const base = j * this.verts + i;
    const h00 = this.heights[base] ?? 0;
    const h10 = this.heights[base + 1] ?? 0;
    const h01 = this.heights[base + this.verts] ?? 0;
    const h11 = this.heights[base + this.verts + 1] ?? 0;

    let du: number;
    let dv: number;
    if (v > u) {
      du = h11 - h01;
      dv = h01 - h00;
    } else {
      du = h10 - h00;
      dv = h11 - h10;
    }

    const gx2 = du * this.invSpacing;
    const gz2 = dv * this.invSpacing;
    return Math.atan(Math.sqrt(gx2 * gx2 + gz2 * gz2));
  }

  inBounds(x: number, z: number): boolean {
    return x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
