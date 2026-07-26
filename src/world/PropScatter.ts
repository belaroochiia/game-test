import * as THREE from 'three';

import { BIOME_COUNT, createBiomeSample } from './BiomeTable';
import type { BiomeSample, BiomeTable } from './BiomeTable';
import { SEA_LEVEL } from './HeightField';
import type { HeightField } from './HeightField';
import type { AABB, SpatialHash } from './SpatialHash';

/**
 * Deterministic instanced scattering for §5's props (§13: never a Mesh per prop).
 *
 * Two decisions dominate this file.
 *
 * 1. **One InstancedMesh per prop type for the whole active set, not per chunk.**
 *    §3 asks for one instanced mesh per prop type *per chunk*, but the arithmetic
 *    does not survive: 25 resident chunks x 4 prop types = 100 draw calls, plus 25
 *    terrain meshes = 125, over §3's own 110-call ceiling before water, sky or the
 *    player exist. Four meshes total, with a per-chunk *instance range* inside
 *    each, costs 4 draw calls and leaves the budget intact. Nothing else about §3
 *    changes — the props are still instanced, still one material.
 *
 * 2. **The instance buffers are allocated once and never resized.** Slots are
 *    handed out as contiguous per-chunk ranges from a compacting allocator, so
 *    `mesh.count` is exactly the number of live instances and streaming a chunk in
 *    or out is a `copyWithin` (a memmove) rather than an allocation. Reallocating a
 *    matrix buffer mid-walk is a GC spike, which is precisely the stutter §12
 *    fails the phase for.
 *
 * Determinism is the other hard requirement: a chunk leaves and re-enters the
 * active set every time the player paces back and forth, so every property of
 * every prop is a pure hash of (seed, chunkX, chunkZ, type, index). No
 * `Math.random()`, no counters, no dependence on visit order.
 *
 * Chunk coordinates follow ChunkManager's convention: indices are measured from
 * the world corner, so `chunkMinX = field.minX + chunkX * chunkSize` and a 600 u
 * world of 50 u chunks runs 0..11 on each axis. `addChunk` warns in dev if a chunk
 * rect falls entirely outside the world, which is what a convention mismatch
 * between the two modules looks like.
 */

/** Prop archetypes for the two Phase 2 biomes. Geometry is generated in code (§1). */
export const PROP_TYPE = { Tree: 0, Rock: 1, Bush: 2, Mushroom: 3 } as const;
export type PropTypeId = (typeof PROP_TYPE)[keyof typeof PROP_TYPE];
export const PROP_TYPE_COUNT = 4;

export interface PropScatterOptions {
  scene: THREE.Scene;
  field: HeightField;
  biomes: BiomeTable;
  props: SpatialHash;
  /** Chunks the manager can keep resident; sizes the instance budget. Default 25. */
  maxChunks?: number;
  /** Hard cap on instances per type across the whole active set. Default 320. */
  maxPerType?: number;
}

const DEFAULT_MAX_CHUNKS = 25;
const DEFAULT_MAX_PER_TYPE = 320;

/** Vite replaces `import.meta.env`; the guard lets this module load under plain Node too. */
const DEV: boolean = import.meta.env?.DEV === true;

/** Salt so prop placement does not correlate with the terrain that uses the same seed. */
const SCATTER_SALT = 0x5f3a91;

/** Clear radius around the world origin per type. >= the 4 units the spawn area needs. */
const SPAWN_CLEAR = new Float32Array([7, 4, 4, 4]);
const DEG = Math.PI / 180;
/** Steepest ground each type will stand on. Trees get the ~30 deg limit; rubble tolerates more. */
const MAX_SLOPE = new Float32Array([30 * DEG, 55 * DEG, 40 * DEG, 38 * DEG]);
/**
 * How far each type's origin is buried, so a base never floats on a slope. Every
 * geometry here has its base at y = 0, so this is a burial depth, not a centre
 * offset. It also has to cover the rock's random tilt (see ROCK_TILT).
 */
const SINK = new Float32Array([0.14, 0.22, 0.07, 0.02]);
/** Trees and rocks block movement; bushes and mushrooms are walk-through (§7). */
const COLLIDES = new Uint8Array([1, 1, 0, 0]);
/**
 * The tree's collider is the trunk, deliberately hand-set rather than taken from
 * the geometry: the canopy is 2.5 u wide and 2 u off the ground, so a bounding-box
 * collider would wall off a forest the player should be walking through.
 */
const TRUNK_HALF = 0.42;
const TRUNK_HEIGHT = 3.2;
/** Blob props take their collider from the mesh, pulled in to stay inside the silhouette. */
const COLLIDER_INSET = 0.85;
/** How far a collider reaches below the sampled ground, so a slope leaves no gap. */
const COLLIDER_DEPTH = 0.6;
/**
 * Rock tilt, radians. Small on purpose: a boulder whose base sits at y = 0 lifts
 * `halfWidth * sin(tilt)` on one side when tilted, and that has to stay under
 * SINK[Rock] or the player sees daylight beneath the rock.
 */
const ROCK_TILT = 0.16;

/** +/-15 % scale, so a forest does not look stamped. */
const SCALE_JITTER = 0.15;
/** Per-instance brightness spread, same reason. */
const VALUE_JITTER = 0.08;
/** Props must stand at least this far above the water line (§5's fog sea). */
const SUBMERGE_MARGIN = 0.25;

// Hash channels. Distinct salts, so no two properties of one prop correlate.
const CH_X = 0;
const CH_Z = 1;
const CH_EXISTS = 2;
const CH_SCALE = 3;
const CH_YAW = 4;
const CH_TILT_X = 5;
const CH_TILT_Z = 6;
const CH_VALUE = 7;

/**
 * Per-type, per-biome colour multiplier applied through `instanceColor`, giving
 * §5's two regions their own foliage without a second material or a second mesh:
 * Verdant Hollow pulls the canopy golden, Whisperwood pulls it dark teal. These
 * are multipliers on the baked vertex colour, not colours, so they are written
 * raw — running them through THREE.Color would apply an sRGB decode to a ratio.
 */
const TINT = new Float32Array([
  // Tree: golden green, then §5's dark green / teal
  1.1, 1.04, 0.7, 0.55, 0.82, 0.86,
  // Rock: warm grey, then cold blue-grey
  1.02, 1.0, 0.92, 0.8, 0.9, 1.02,
  // Bush
  1.08, 1.02, 0.66, 0.58, 0.86, 0.8,
  // Mushroom: only really a Whisperwood prop, and there it reads cold and bright
  1.0, 0.95, 0.9, 0.75, 1.05, 1.1,
]);

const PROP_NAMES = ['tree', 'rock', 'bush', 'mushroom'];

// --- module-scope scratch: addChunk/removeChunk run during streaming (§3) ----
const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchColor = new THREE.Color();
const scratchBiome: BiomeSample = createBiomeSample();
const scratchBox: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

/**
 * Four-way integer hash -> [0,1). Same avalanche as BiomeTable's `hash2`, widened
 * so (chunkX, chunkZ, type+index, channel) can be mixed in one call. Pure integer
 * maths, so it is bit-identical across reloads and platforms.
 */
function hash4(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a, 374761393) | 0;
  h = (h + Math.imul(b, 668265263)) | 0;
  h = (h + Math.imul(c, 2246822519)) | 0;
  h = (h + Math.imul(d, 3266489917)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

// ---------------------------------------------------------------------------
// Geometry, generated in code (§1: no external assets)
// ---------------------------------------------------------------------------

/**
 * Accumulates transformed primitives into one non-indexed buffer with a flat
 * colour baked per part. Non-indexed because merging indexed parts means
 * rebasing indices for no gain at these sizes — the triangle count, which is
 * what §3 budgets, is identical either way.
 *
 * Construction-time only; every method here allocates.
 */
class PartBuilder {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];

  /** `part` is consumed: pre-transform it with translate/rotate, then hand it over. */
  add(part: THREE.BufferGeometry, hex: number): this {
    const flat = part.index !== null ? part.toNonIndexed() : part;
    const position = flat.getAttribute('position');
    scratchColor.setHex(hex);
    for (let i = 0; i < position.count; i++) {
      this.positions.push(position.getX(i), position.getY(i), position.getZ(i));
      this.colors.push(scratchColor.r, scratchColor.g, scratchColor.b);
    }
    if (flat !== part) flat.dispose();
    part.dispose();
    return this;
  }

  build(name: string): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.colors), 3));
    // Non-indexed, so this is one normal per face — genuinely flat, and it also
    // works in the shadow pass where `material.flatShading` does not apply.
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    // The collider extents are read off this, so it is not optional.
    geometry.computeBoundingBox();
    geometry.name = name;
    return geometry;
  }
}

/** Tapered trunk + 2 stacked cones (§5's suggestion). 12 + 16 + 16 = 44 triangles. */
function buildTree(): THREE.BufferGeometry {
  return new PartBuilder()
    // Open-ended: the bottom is buried and the top is inside the canopy, so 12
    // triangles of cap would never be seen.
    .add(new THREE.CylinderGeometry(0.15, 0.26, 2.0, 6, 1, true).translate(0, 1.0, 0), 0x6b4f36)
    .add(new THREE.ConeGeometry(1.28, 1.95, 8, 1, false).translate(0, 2.4, 0), 0x4f7a3a)
    .add(new THREE.ConeGeometry(0.92, 1.65, 8, 1, false).translate(0, 3.48, 0), 0x6a9445)
    .build('prop_tree');
}

/**
 * Low-poly icosahedron, 20 triangles, with its vertices pushed around so it reads
 * as a boulder rather than a ball. The displacement is hashed from the *quantised
 * vertex position*, so the duplicated vertices of a non-indexed mesh all move
 * together and the surface cannot tear.
 *
 * Finally shifted so its base sits at y = 0, like every other prop here. An
 * icosahedron is centred on its own middle, and placing that at ground level
 * would bury four fifths of the boulder.
 */
function buildRock(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(0.9, 0);
  const position = ico.getAttribute('position');
  const array = position.array as Float32Array;
  let minY = Number.POSITIVE_INFINITY;
  for (let i = 0; i < position.count; i++) {
    const x = array[i * 3] ?? 0;
    const y = array[i * 3 + 1] ?? 0;
    const z = array[i * 3 + 2] ?? 0;
    const q = hash4(Math.round(x * 4096), Math.round(y * 4096), Math.round(z * 4096), 991);
    const f = 0.76 + q * 0.46;
    array[i * 3] = x * f;
    // Squashed vertically: a boulder sits, it does not perch.
    const ny = y * f * 0.8;
    array[i * 3 + 1] = ny;
    array[i * 3 + 2] = z * f;
    if (ny < minY) minY = ny;
  }
  ico.translate(0, -minY, 0);
  return new PartBuilder().add(ico, 0x9a9a92).build('prop_rock');
}

/** Two crossed cones, 12 + 12 = 24 triangles. */
function buildBush(): THREE.BufferGeometry {
  return new PartBuilder()
    .add(new THREE.ConeGeometry(0.55, 0.86, 6, 1, false).translate(0, 0.43, 0), 0x4a7238)
    .add(
      new THREE.ConeGeometry(0.46, 0.72, 6, 1, false).rotateZ(0.62).translate(0.3, 0.32, -0.06),
      0x5a8442,
    )
    .build('prop_bush');
}

/**
 * Stem + cap, 12 + 12 = 24 triangles. §5 wants Whisperwood's mushrooms glowing;
 * a genuinely emissive cap needs a second material, which the one-material rule
 * here forbids, so the cap is baked bright and cold instead. It reads as glow
 * under the night hemisphere fill and costs nothing.
 */
function buildMushroom(): THREE.BufferGeometry {
  return new PartBuilder()
    .add(new THREE.CylinderGeometry(0.075, 0.1, 0.42, 6, 1, true).translate(0, 0.21, 0), 0xe8e0cf)
    .add(new THREE.ConeGeometry(0.3, 0.34, 6, 1, false).translate(0, 0.47, 0), 0x7fe3d0)
    .build('prop_mushroom');
}

// ---------------------------------------------------------------------------

export class PropScatter {
  /** One per PROP_TYPE. Added to the scene by the constructor. */
  readonly meshes: THREE.InstancedMesh[] = [];
  /** Triangles in one instance of each type — for the debug overlay's estimate. */
  readonly trianglesPerInstance: readonly number[];
  /** Effective per-type instance cap after the per-chunk quota is rounded. */
  readonly maxInstancesPerType: number;
  /** Instances of one type a single chunk may contribute. */
  readonly quotaPerChunk: number;

  private readonly scene: THREE.Scene;
  private readonly field: HeightField;
  private readonly biomes: BiomeTable;
  private readonly hash: SpatialHash;
  private readonly material: THREE.MeshLambertMaterial;

  private readonly seed: number;
  private readonly chunkSize: number;
  private readonly maxChunks: number;
  /** World corner, the origin chunk indices are measured from (ChunkManager's convention). */
  private readonly originX: number;
  private readonly originZ: number;

  /** Candidate strata: a jittered `cols x rows` grid beats pure random, which clumps. */
  private readonly strataCols: number;
  private readonly strataRows: number;

  /** Chunk slots. Linear scan over <= maxChunks entries, so no Map and no allocation. */
  private readonly slotChunkX: Int32Array;
  private readonly slotChunkZ: Int32Array;
  private readonly slotUsed: Uint8Array;

  /** Per (slot, type) instance range inside that type's buffer. */
  private readonly rangeOffset: Int32Array;
  private readonly rangeLength: Int32Array;
  /** Per type, the occupied slots in ascending offset order — the compaction index. */
  private readonly orderSlots: Int32Array;
  private readonly orderCount: Int32Array;
  /** Per type, live instances == mesh.count. */
  private readonly used: Int32Array;

  /** Per (slot, type, ordinal) SpatialHash id, or -1. */
  private readonly colliderIds: Int32Array;
  private colliderLive = 0;

  /** Collider extents at scale 1, derived from the geometry so they cannot drift from it. */
  private readonly colliderHalf: Float32Array;
  private readonly colliderHeight: Float32Array;

  /** propDensity flattened to [biome][type], so scattering never touches an object. */
  private readonly density: Float32Array;

  private boundsWarned = false;

  constructor(options: PropScatterOptions) {
    this.scene = options.scene;
    this.field = options.field;
    this.biomes = options.biomes;
    this.hash = options.props;
    this.seed = (Math.floor(options.field.seed) + SCATTER_SALT) | 0;
    this.chunkSize = options.field.chunkSize;
    this.originX = options.field.minX;
    this.originZ = options.field.minZ;

    this.maxChunks = Math.max(1, Math.floor(options.maxChunks ?? DEFAULT_MAX_CHUNKS));
    const requested = Math.max(1, Math.floor(options.maxPerType ?? DEFAULT_MAX_PER_TYPE));
    // An equal per-chunk quota is what makes the allocator exact: every range is
    // bounded, so `quota * maxChunks <= maxPerType` guarantees the buffer can never
    // overflow no matter which chunks are resident.
    this.quotaPerChunk = Math.max(1, Math.floor(requested / this.maxChunks));
    this.maxInstancesPerType = this.quotaPerChunk * this.maxChunks;

    this.strataCols = Math.ceil(Math.sqrt(this.quotaPerChunk));
    this.strataRows = Math.ceil(this.quotaPerChunk / this.strataCols);

    this.slotChunkX = new Int32Array(this.maxChunks);
    this.slotChunkZ = new Int32Array(this.maxChunks);
    this.slotUsed = new Uint8Array(this.maxChunks);
    this.rangeOffset = new Int32Array(this.maxChunks * PROP_TYPE_COUNT);
    this.rangeLength = new Int32Array(this.maxChunks * PROP_TYPE_COUNT);
    this.orderSlots = new Int32Array(PROP_TYPE_COUNT * this.maxChunks);
    this.orderCount = new Int32Array(PROP_TYPE_COUNT);
    this.used = new Int32Array(PROP_TYPE_COUNT);
    this.colliderIds = new Int32Array(this.maxChunks * PROP_TYPE_COUNT * this.quotaPerChunk).fill(-1);

    this.density = new Float32Array(BIOME_COUNT * PROP_TYPE_COUNT);
    for (let b = 0; b < BIOME_COUNT; b++) {
      const def = this.biomes.get(b as 0 | 1);
      for (let t = 0; t < PROP_TYPE_COUNT; t++) {
        const d = def.propDensity[t] ?? 0;
        this.density[b * PROP_TYPE_COUNT + t] = d;
        if (DEV && d > this.quotaPerChunk) {
          console.warn('[PropScatter]', def.name, PROP_NAMES[t], 'density', d, 'exceeds the per-chunk quota', this.quotaPerChunk, '— it will be clamped');
        }
      }
    }

    // One material for all four types (§3 caps unique materials at 12). Per-type
    // colour comes from the baked vertex colours, per-instance tint from
    // `instanceColor`; both multiply into the same program, so this stays 4 draw
    // calls and one shader.
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.material.name = 'props';

    this.colliderHalf = new Float32Array(PROP_TYPE_COUNT);
    this.colliderHeight = new Float32Array(PROP_TYPE_COUNT);

    const triangles: number[] = [];
    for (let t = 0; t < PROP_TYPE_COUNT; t++) {
      const geometry =
        t === PROP_TYPE.Tree
          ? buildTree()
          : t === PROP_TYPE.Rock
            ? buildRock()
            : t === PROP_TYPE.Bush
              ? buildBush()
              : buildMushroom();
      triangles.push(geometry.getAttribute('position').count / 3);

      if (COLLIDES[t] === 1) {
        if (t === PROP_TYPE.Tree) {
          this.colliderHalf[t] = TRUNK_HALF;
          this.colliderHeight[t] = TRUNK_HEIGHT;
        } else {
          const box = geometry.boundingBox;
          const half = box === null ? 0.5 : Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z);
          this.colliderHalf[t] = half * COLLIDER_INSET;
          this.colliderHeight[t] = box === null ? 1 : box.max.y;
        }
      }

      const mesh = new THREE.InstancedMesh(geometry, this.material, this.maxInstancesPerType);
      mesh.name = 'props_' + (PROP_NAMES[t] ?? String(t));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Allocated at full size here, before `count` drops, so streaming never
      // reallocates it. Neutral white, so an unused slot tints nothing.
      const colors = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstancesPerType * 3).fill(1), 3);
      colors.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = colors;
      mesh.count = 0;
      // The mesh spans the whole active set but its geometry bounding sphere is one
      // prop at the origin, so Three's own culling test would be wrong — it would
      // drop every prop whenever the world origin left the frustum. ChunkManager
      // culls per chunk; this level has nothing useful to cull against.
      mesh.frustumCulled = false;
      // Trees and rocks are the only props big enough for a shadow to read at
      // §3's 1024 map over a 25 u radius. Costs one shadow-pass draw call each,
      // and only shows if the chunk meshes are set to receive shadows.
      mesh.castShadow = COLLIDES[t] === 1;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();

      this.meshes.push(mesh);
      this.scene.add(mesh);
    }
    this.trianglesPerInstance = triangles;
  }

  /**
   * Fills this chunk's instances. Deterministic from (seed, chunkX, chunkZ):
   * re-adding a chunk reproduces bit-identical matrices, so props never jump when
   * the player paces back and forth across a streaming boundary.
   */
  addChunk(chunkX: number, chunkZ: number): void {
    if (this.findSlot(chunkX, chunkZ) >= 0) {
      if (DEV) console.warn('[PropScatter] addChunk for a chunk that is already resident:', chunkX, chunkZ, '— ignored');
      return;
    }
    let slot = -1;
    for (let s = 0; s < this.maxChunks; s++) {
      if (this.slotUsed[s] === 0) {
        slot = s;
        break;
      }
    }
    if (slot < 0) {
      if (DEV) console.warn('[PropScatter] all', this.maxChunks, 'chunk slots are occupied — raise maxChunks to match ChunkManager');
      return;
    }

    this.slotChunkX[slot] = chunkX;
    this.slotChunkZ[slot] = chunkZ;
    this.slotUsed[slot] = 1;

    const size = this.chunkSize;
    // Same mapping ChunkManager meshes with, so a chunk's props land on the chunk's
    // own terrain rather than one region over.
    const minX = this.originX + chunkX * size;
    const minZ = this.originZ + chunkZ * size;

    if (DEV && !this.boundsWarned) {
      const field = this.field;
      if (minX + size <= field.minX || minX >= field.maxX || minZ + size <= field.minZ || minZ >= field.maxZ) {
        this.boundsWarned = true;
        console.warn('[PropScatter] chunk', chunkX, chunkZ, 'maps to world rect', minX, minZ, '- entirely outside the world. This module reads chunk indices from the world corner (chunkMinX = field.minX + chunkX * chunkSize); ChunkManager appears to use another convention.');
      }
    }

    for (let t = 0; t < PROP_TYPE_COUNT; t++) this.scatterType(slot, t, chunkX, chunkZ, minX, minZ);
  }

  /**
   * Frees this chunk's ranges and colliders. The ranges of later chunks are
   * compacted down over the hole with `copyWithin` — a memmove of at most
   * `maxPerType * 16` floats, no allocation — which keeps `mesh.count` exactly
   * equal to the live instance count, with no degenerate padding instances for
   * the GPU to transform.
   */
  removeChunk(chunkX: number, chunkZ: number): void {
    const slot = this.findSlot(chunkX, chunkZ);
    if (slot < 0) {
      if (DEV) console.warn('[PropScatter] removeChunk for a chunk that is not resident:', chunkX, chunkZ, '— ignored');
      return;
    }

    for (let t = 0; t < PROP_TYPE_COUNT; t++) {
      const key = slot * PROP_TYPE_COUNT + t;
      const length = this.rangeLength[key] ?? 0;
      if (length === 0) continue;
      const offset = this.rangeOffset[key] ?? 0;
      const live = this.used[t] ?? 0;
      const mesh = this.meshes[t];
      if (mesh === undefined) continue;

      const matrices = mesh.instanceMatrix.array as Float32Array;
      matrices.copyWithin(offset * 16, (offset + length) * 16, live * 16);
      const colors = mesh.instanceColor;
      if (colors !== null) {
        (colors.array as Float32Array).copyWithin(offset * 3, (offset + length) * 3, live * 3);
        colors.needsUpdate = true;
      }
      mesh.instanceMatrix.needsUpdate = true;

      // Shift the order list left over this slot, pulling back the offsets of every
      // range the memmove above moved down.
      const base = t * this.maxChunks;
      const count = this.orderCount[t] ?? 0;
      let write = -1;
      for (let q = 0; q < count; q++) {
        const other = this.orderSlots[base + q] ?? -1;
        if (other === slot) {
          write = q;
          continue;
        }
        if (write < 0) continue;
        const otherKey = other * PROP_TYPE_COUNT + t;
        this.rangeOffset[otherKey] = (this.rangeOffset[otherKey] ?? 0) - length;
        this.orderSlots[base + write] = other;
        write++;
      }
      if (write >= 0) this.orderCount[t] = count - 1;

      this.rangeLength[key] = 0;
      this.used[t] = live - length;
      mesh.count = live - length;
    }

    this.releaseColliders(slot);
    this.slotUsed[slot] = 0;
  }

  /** Drops every resident chunk. Other owners' colliders in the hash are untouched. */
  clear(): void {
    for (let s = 0; s < this.maxChunks; s++) {
      if (this.slotUsed[s] === 1) this.releaseColliders(s);
      this.slotUsed[s] = 0;
      for (let t = 0; t < PROP_TYPE_COUNT; t++) this.rangeLength[s * PROP_TYPE_COUNT + t] = 0;
    }
    for (let t = 0; t < PROP_TYPE_COUNT; t++) {
      this.used[t] = 0;
      this.orderCount[t] = 0;
      const mesh = this.meshes[t];
      if (mesh === undefined) continue;
      mesh.count = 0;
      mesh.instanceMatrix.needsUpdate = true;
      const colors = mesh.instanceColor;
      if (colors !== null) colors.needsUpdate = true;
    }
  }

  get instanceCount(): number {
    let total = 0;
    for (let t = 0; t < PROP_TYPE_COUNT; t++) total += this.used[t] ?? 0;
    return total;
  }

  get collidersRegistered(): number {
    return this.colliderLive;
  }

  /** Triangles the prop meshes currently submit, for the debug overlay. */
  get triangleEstimate(): number {
    let total = 0;
    for (let t = 0; t < PROP_TYPE_COUNT; t++) total += (this.used[t] ?? 0) * (this.trianglesPerInstance[t] ?? 0);
    return total;
  }

  dispose(): void {
    this.clear();
    for (let t = 0; t < PROP_TYPE_COUNT; t++) {
      const mesh = this.meshes[t];
      if (mesh === undefined) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.meshes.length = 0;
    this.material.dispose();
  }

  // -------------------------------------------------------------------------

  /**
   * Scatters one type into one chunk, appending at the end of the type's live
   * range. Allocation-free: every candidate property is a hash, and every vector
   * is module scratch.
   */
  private scatterType(slot: number, type: number, chunkX: number, chunkZ: number, minX: number, minZ: number): void {
    const mesh = this.meshes[type];
    if (mesh === undefined) return;
    const field = this.field;
    const quota = this.quotaPerChunk;
    const start = this.used[type] ?? 0;
    const cellW = this.chunkSize / this.strataCols;
    const cellD = this.chunkSize / this.strataRows;
    const clear = SPAWN_CLEAR[type] ?? 4;
    const clearSq = clear * clear;
    const maxSlope = MAX_SLOPE[type] ?? 1;
    const sink = SINK[type] ?? 0;
    const tintBase = type * BIOME_COUNT * 3;
    const colors = mesh.instanceColor;
    const colorArray = colors === null ? null : (colors.array as Float32Array);

    let n = 0;
    for (let i = 0; i < quota; i++) {
      // Stratified: candidate i owns one cell of a cols x rows grid and is
      // jittered inside it. Even coverage without a Poisson pass.
      const col = i % this.strataCols;
      const row = (i / this.strataCols) | 0;
      const x = minX + (col + hash4(chunkX, chunkZ, type * 1049 + i * 17, this.seed + CH_X * 7919)) * cellW;
      const z = minZ + (row + hash4(chunkX, chunkZ, type * 1049 + i * 17, this.seed + CH_Z * 7919)) * cellD;

      if (!field.inBounds(x, z)) continue;
      // Keep the spawn area clear, or the player wakes up inside a tree.
      if (x * x + z * z < clearSq) continue;

      // Density is the biome blend's, evaluated at the candidate itself, so the
      // treeline thickens across the transition band instead of stepping at it.
      const weights = this.biomes.sample(x, z, scratchBiome).weights;
      let density = 0;
      let tr = 0;
      let tg = 0;
      let tb = 0;
      for (let b = 0; b < BIOME_COUNT; b++) {
        const w = weights[b] ?? 0;
        if (w <= 0) continue;
        density += w * (this.density[b * PROP_TYPE_COUNT + type] ?? 0);
        const tint = tintBase + b * 3;
        tr += w * (TINT[tint] ?? 1);
        tg += w * (TINT[tint + 1] ?? 1);
        tb += w * (TINT[tint + 2] ?? 1);
      }
      // Accept with probability density/quota: the expected count over the quota
      // candidates is exactly `density` instances per chunk, and it varies
      // smoothly with the blend.
      let probability = density / quota;
      if (probability > 1) probability = 1;
      if (hash4(chunkX, chunkZ, type * 1049 + i * 17, this.seed + CH_EXISTS * 7919) >= probability) continue;

      const groundY = field.heightAt(x, z);
      if (groundY < SEA_LEVEL + SUBMERGE_MARGIN) continue;
      if (field.slopeAt(x, z) > maxSlope) continue;

      const index = start + n;
      const scale = 1 + (hash4(chunkX, chunkZ, type * 1049 + i * 17, this.seed + CH_SCALE * 7919) * 2 - 1) * SCALE_JITTER;
      const yaw = hash4(chunkX, chunkZ, type * 1049 + i * 17, this.seed + CH_YAW * 7919) * Math.PI * 2;
      if (type === PROP_TYPE.Rock) {
        // A boulder has no up. Tilting it hides that it is one repeated mesh.
        const tiltX = (hash4(chunkX, chunkZ, type * 1049 + i * 17, this.seed + CH_TILT_X * 7919) - 0.5) * 2 * ROCK_TILT;
        const tiltZ = (hash4(chunkX, chunkZ, type * 1049 + i * 17, this.seed + CH_TILT_Z * 7919) - 0.5) * 2 * ROCK_TILT;
        scratchEuler.set(tiltX, yaw, tiltZ);
      } else {
        scratchEuler.set(0, yaw, 0);
      }
      scratchQuat.setFromEuler(scratchEuler);
      scratchPos.set(x, groundY - sink * scale, z);
      scratchScale.set(scale, scale, scale);
      scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
      mesh.setMatrixAt(index, scratchMatrix);

      if (colorArray !== null) {
        const value = 1 - VALUE_JITTER + hash4(chunkX, chunkZ, type * 1049 + i * 17, this.seed + CH_VALUE * 7919) * VALUE_JITTER * 2;
        colorArray[index * 3] = tr * value;
        colorArray[index * 3 + 1] = tg * value;
        colorArray[index * 3 + 2] = tb * value;
      }

      if (COLLIDES[type] === 1) {
        const half = (this.colliderHalf[type] ?? 0) * scale;
        scratchBox.minX = x - half;
        scratchBox.maxX = x + half;
        scratchBox.minZ = z - half;
        scratchBox.maxZ = z + half;
        scratchBox.minY = groundY - COLLIDER_DEPTH;
        scratchBox.maxY = groundY + (this.colliderHeight[type] ?? 0) * scale;
        this.colliderIds[(slot * PROP_TYPE_COUNT + type) * quota + n] = this.hash.insert(scratchBox);
        this.colliderLive++;
      }

      n++;
    }

    this.rangeOffset[slot * PROP_TYPE_COUNT + type] = start;
    this.rangeLength[slot * PROP_TYPE_COUNT + type] = n;
    if (n === 0) return;

    const base = type * this.maxChunks;
    const count = this.orderCount[type] ?? 0;
    this.orderSlots[base + count] = slot;
    this.orderCount[type] = count + 1;
    this.used[type] = start + n;
    mesh.count = start + n;
    // The whole buffer is re-uploaded rather than a sub-range: `addUpdateRange`
    // allocates a range object per call (§3), removeChunk's compaction dirties an
    // arbitrary span anyway, and at 20 KB for one chunk per frame the bandwidth is
    // noise next to a single terrain chunk's vertices.
    mesh.instanceMatrix.needsUpdate = true;
    const colors2 = mesh.instanceColor;
    if (colors2 !== null) colors2.needsUpdate = true;
  }

  private findSlot(chunkX: number, chunkZ: number): number {
    for (let s = 0; s < this.maxChunks; s++) {
      if (this.slotUsed[s] !== 1) continue;
      if (this.slotChunkX[s] === chunkX && this.slotChunkZ[s] === chunkZ) return s;
    }
    return -1;
  }

  private releaseColliders(slot: number): void {
    const quota = this.quotaPerChunk;
    for (let t = 0; t < PROP_TYPE_COUNT; t++) {
      if (COLLIDES[t] !== 1) continue;
      const base = (slot * PROP_TYPE_COUNT + t) * quota;
      for (let k = 0; k < quota; k++) {
        const id = this.colliderIds[base + k] ?? -1;
        if (id < 0) continue;
        this.hash.remove(id);
        this.colliderIds[base + k] = -1;
        this.colliderLive--;
      }
    }
  }
}
