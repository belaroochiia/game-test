import * as THREE from 'three';

import type { System } from '../core/Engine';
import { BIOME, createBiomeSample } from './BiomeTable';
import type { BiomeSample, BiomeTable } from './BiomeTable';
import type { HeightField } from './HeightField';

/**
 * Terrain streaming: §5's 600x600 world served as a 5x5 window of 50-unit chunks
 * around the player, two LODs, manual per-chunk frustum culling, pooled geometry, and
 * one mesh build per rendered frame.
 *
 * The budget decides every choice in this file. 25 chunks at Phase 1's 50-cell
 * resolution is 125 000 triangles — 83 % of §3's entire 150 000 budget before a single
 * prop or the water exists. So LOD is mandatory, not a nicety: a 3x3 core at 50 cells
 * (5 400 tris each, skirt included) inside a ring at 16 cells (640 tris each) covers
 * the same ground in 58 840 triangles and leaves ~90 000 for props, water and the
 * player.
 *
 * Two rules keep it from stuttering, which is what §12 actually fails the phase for:
 *
 * 1. **One build per rendered frame** (`buildsPerFrame`), nearest-pending first, so
 *    what you are walking into is built first. A LOD0 build measures ~2 ms: one fits
 *    inside a 16.6 ms frame with room, two do not.
 * 2. **Nothing is allocated to do it.** Geometries are pooled per LOD and their
 *    position/colour arrays rewritten in place; the index buffer of a LOD is built
 *    once and shared by every chunk at that LOD, because the topology never changes —
 *    only the vertex data does.
 *
 * Seams between same-LOD neighbours are exactly zero and cost nothing, because the
 * mesher's only call into the world shape is `field.sampleVertex(worldX, worldZ)` with
 * unrounded world coordinates: two chunks sharing an edge evaluate the identical
 * function at the identical coordinates. Across a LOD change the edges genuinely
 * differ (measured worst case 1.55 m over the whole world), and that is covered with a
 * 2.5-unit **skirt** — the border ring duplicated, pushed straight down, and coloured
 * like the vertex it hangs from. Geomorphing would mean rewriting every chunk's
 * vertices every frame to hide a crack that dense fog already half-hides.
 *
 * No normal attribute is written at all. `flatShading` makes the fragment shader
 * derive the normal from screen-space derivatives of the view position, so a normal
 * buffer is 33 KB per LOD0 chunk of data the GPU never reads, plus the ~1 ms
 * `computeVertexNormals()` costs — half the build budget for nothing visible. If flat
 * shading is ever switched off, normals have to come back with it.
 */

/**
 * What ChunkManager needs from PropScatter, declared structurally rather than imported
 * so that neither file has to exist for the other to compile and there is no cycle.
 * `PropScatter` satisfies this as written, so the integrator passes one straight in.
 */
export interface ChunkPropSink {
  addChunk(chunkX: number, chunkZ: number): void;
  removeChunk(chunkX: number, chunkZ: number): void;
  clear(): void;
}

export interface ChunkManagerOptions {
  scene: THREE.Scene;
  field: HeightField;
  biomes: BiomeTable;
  camera: THREE.PerspectiveCamera;
  /** Player position to stream around; read every tick, never copied. */
  target: { position: THREE.Vector3 };
  props?: ChunkPropSink;
  /** Chunk radius kept resident. Default 2 => a 5x5 active set. */
  radius?: number;
  /** Chunk radius rendered at LOD0. Default 1 => a 3x3 core. */
  lod0Radius?: number;
  /** Max chunk mesh builds per frame. Default 1 — this is the anti-stutter knob. */
  buildsPerFrame?: number;
}

const DEFAULT_RADIUS = 2;
const DEFAULT_LOD0_RADIUS = 1;
const DEFAULT_BUILDS_PER_FRAME = 1;

/**
 * Cells per chunk edge at LOD1. 50/16 = 3.125 exactly in binary, so a LOD1 vertex
 * lands on the same world coordinate whichever chunk computes it and the shared edge
 * stays bit-identical. It is also above the 9-unit smallest feature HeightField's
 * three-octave stack produces, so a LOD swap changes the silhouette by ~1 m, not by a
 * whole hill.
 */
const LOD1_CELLS = 16;

/**
 * Skirt depth. The measured worst-case LOD0-vs-LOD1 height disagreement over the whole
 * world is 1.55 m, so 2.5 m covers every crack with margin. A future LOD2 at 8 cells
 * would need at least 3.65 m.
 */
const SKIRT_DEPTH = 2.5;

/**
 * How far the player must be inside a new chunk before the streaming window follows.
 * Standing on a chunk boundary and drifting a few centimetres either way would
 * otherwise re-window the set and re-LOD six chunks per twitch — bounded by the build
 * cap, but pure waste. 2 units is half a second of walking.
 */
const CENTER_HYSTERESIS = 2;

/**
 * Bounding spheres are padded by this before the frustum test. The camera rig writes
 * its transform in its own `render()`, which may run after this system's, so the
 * frustum can be one frame stale; a chunk blinking out at the screen edge during a
 * fast turn is far more visible than a few extra draw calls.
 */
const CULL_MARGIN = 8;

/**
 * Squared-distance penalty applied to a chunk that is merely changing LOD, so holes
 * are filled before detail is refined. 100 units of equivalent distance: a chunk with
 * no mesh at all outranks any amount of wrong-detail-level.
 */
const REFINE_PENALTY = 100 * 100;

/** Vertex ceiling for a 16-bit index buffer. */
const UINT16_LIMIT = 65535;

interface PooledGeometry {
  readonly lod: number;
  readonly geometry: THREE.BufferGeometry;
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly positionAttr: THREE.BufferAttribute;
  readonly colorAttr: THREE.BufferAttribute;
  /** Owned by the geometry (and assigned to it), recomputed on every fill. */
  readonly sphere: THREE.Sphere;
}

interface LodLevel {
  readonly lod: number;
  readonly cells: number;
  readonly verts: number;
  readonly spacing: number;
  readonly coreVertexCount: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Core vertex index per perimeter position, in cyclic order — drives the skirt. */
  readonly ring: Int32Array;
  /** Built once, shared by every geometry at this LOD. */
  readonly index: THREE.BufferAttribute;
  /** Every geometry ever built for this LOD, in creation order — for dispose(). */
  readonly all: PooledGeometry[];
  /** Free stack; only slots below `freeTop` are meaningful. */
  readonly free: (PooledGeometry | undefined)[];
  freeTop: number;
}

interface Chunk {
  cx: number;
  cz: number;
  /** Index into `slots`, or -1 while the record is idle. */
  slot: number;
  /** LOD of the geometry currently attached, -1 when there is none. */
  lod: number;
  wantLod: number;
  geo: PooledGeometry | undefined;
  /** Created once with the record and never replaced; only its geometry is swapped. */
  readonly mesh: THREE.Mesh;
  /** Has vertex data the culler may switch on. */
  built: boolean;
  /** Needs a (re)build; counted by `queuedCount`. */
  pending: boolean;
  propsFilled: boolean;
  centerX: number;
  centerZ: number;
}

const scratchColor = new THREE.Color();
const scratchView = new THREE.Matrix4();
const scratchViewProjection = new THREE.Matrix4();
const scratchFrustum = new THREE.Frustum();

export class ChunkManager implements System {
  readonly name = 'chunks';

  /** Shared by every chunk at every LOD — §3 caps unique materials at 12. */
  readonly material: THREE.MeshLambertMaterial;

  /**
   * Blended biome fog colour at the streaming centre (§5's "blue mist"), ready for
   * `SkyDayNight.setBiomeFogTint`. Nobody else samples biomes at the player, and this
   * is the only reason ChunkManager is handed the table.
   */
  readonly fogTint = new THREE.Color();

  private readonly scene: THREE.Scene;
  private readonly field: HeightField;
  private readonly biomes: BiomeTable;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly target: { position: THREE.Vector3 };
  private readonly props: ChunkPropSink | undefined;

  private readonly radius: number;
  private readonly lod0Radius: number;
  private readonly buildsPerFrame: number;

  private readonly chunkSize: number;
  private readonly halfChunk: number;
  private readonly chunksPerSide: number;
  private readonly originX: number;
  private readonly originZ: number;

  private readonly lod0: LodLevel;
  private readonly lod1: LodLevel;

  /** One slot per world chunk (12x12 = 144), indexed `cz * chunksPerSide + cx`. */
  private readonly slots: (Chunk | undefined)[] = [];
  /** Dense list of resident chunks; order is meaningless (swap-remove). */
  private readonly active: (Chunk | undefined)[] = [];
  private residents = 0;

  /** Every record ever built, for dispose(). */
  private readonly allRecords: Chunk[] = [];
  /** Free stack of records. */
  private readonly freeRecords: (Chunk | undefined)[] = [];
  private freeRecordTop = 0;

  private readonly maxActive: number;

  /** Parked on an idle record's mesh, so three never allocates a geometry of its own. */
  private readonly emptyGeometry = new THREE.BufferGeometry();

  private centerCx = 0;
  private centerCz = 0;
  private centerValid = false;

  private pending = 0;
  private visible = 0;
  private triCount = 0;

  private frameBuilds: number;
  private renderSeen = false;

  private readonly biomeSample: BiomeSample = createBiomeSample();
  private fogWeight = 0;

  constructor(options: ChunkManagerOptions) {
    this.scene = options.scene;
    this.field = options.field;
    this.biomes = options.biomes;
    this.camera = options.camera;
    this.target = options.target;
    this.props = options.props;

    const radius = Math.floor(options.radius ?? DEFAULT_RADIUS);
    this.radius = radius >= 0 ? radius : DEFAULT_RADIUS;
    const lod0Radius = Math.floor(options.lod0Radius ?? DEFAULT_LOD0_RADIUS);
    this.lod0Radius = lod0Radius < 0 ? 0 : lod0Radius > this.radius ? this.radius : lod0Radius;
    const builds = Math.floor(options.buildsPerFrame ?? DEFAULT_BUILDS_PER_FRAME);
    this.buildsPerFrame = builds > 0 ? builds : DEFAULT_BUILDS_PER_FRAME;
    this.frameBuilds = this.buildsPerFrame;

    const field = this.field;
    this.chunkSize = field.chunkSize;
    this.halfChunk = this.chunkSize * 0.5;
    this.chunksPerSide = field.chunksPerSide;
    this.originX = field.minX;
    this.originZ = field.minZ;

    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

    // LOD0 must be the field's own grid: that is the triangulation heightAt() returns
    // the plane of, and the player has to stand on the surface it is drawn on.
    const cells0 = field.baseCells;
    const cells1 = cells0 > LOD1_CELLS ? LOD1_CELLS : cells0;
    this.lod0 = this.buildLevel(0, cells0);
    this.lod1 = this.buildLevel(1, cells1);

    const side = this.radius * 2 + 1;
    this.maxActive = side * side;

    const slotCount = this.chunksPerSide * this.chunksPerSide;
    for (let i = 0; i < slotCount; i++) this.slots.push(undefined);
    for (let i = 0; i < this.maxActive; i++) {
      this.active.push(undefined);
      const record = this.createRecord();
      this.allRecords.push(record);
      this.freeRecords.push(record);
    }
    this.freeRecordTop = this.maxActive;

    // Prewarm both pools past their steady-state census. Boot-time allocation is free;
    // §3's zero-bytes rule is about the game loop, and a 67 KB Float32Array pair
    // allocated mid-stride is exactly the GC spike this file exists to avoid.
    //
    // LOD0 needs more than the core holds: when the window steps diagonally, the 2*side-1
    // core chunks that fall out of the core still hold their LOD0 geometry until their own
    // rebuild comes round, while the incoming ones have already taken theirs. Measured
    // high-water over a 480-unit walk plus a diagonal is 13 for the default 3x3 core; this
    // gives 14. LOD1 never grows, because the chunks leaving the window are all ring
    // chunks and they release before the new ones are built.
    const coreSide = this.lod0Radius * 2 + 1;
    const core = coreSide * coreSide;
    this.prewarm(this.lod0, core + coreSide * 2 - 1);
    this.prewarm(this.lod1, this.maxActive - core);
  }

  /**
   * Streaming and building. Allocation-free: the only heap traffic in the whole path
   * is three's `Object3D.remove()` splicing a one-element array when a chunk leaves,
   * which happens once per chunk boundary crossed, not once per frame.
   */
  update(_dt: number): void {
    const position = this.target.position;
    const x = position.x;
    const z = position.z;

    if (this.recenter(x, z)) this.refreshSet();
    this.sampleFog(x, z);
    this.runBuilds(x, z, this.takeBuildAllowance());
  }

  /**
   * Manual frustum culling (§3), plus the per-frame build allowance for the next
   * frame's ticks. Both belong here rather than in `update()`: "once per frame" is
   * exactly what this callback means, and `update()` can run five times between two
   * renders after a stall.
   */
  render(_alpha: number): void {
    this.renderSeen = true;
    this.frameBuilds = this.buildsPerFrame;
    this.cull();
  }

  reset(): void {
    this.evictAll();
    this.centerValid = false;
    this.frameBuilds = this.buildsPerFrame;
    this.visible = 0;
    // Deliberately does not re-prime: reset() runs inside a frame, and a 25-chunk
    // burst there is the hitch this whole file exists to avoid. The next update()
    // re-windows and streams back in at the usual one-per-frame pace.
  }

  dispose(): void {
    this.evictAll();
    const records = this.allRecords;
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record === undefined) continue;
      record.mesh.removeFromParent();
    }
    this.disposeLevel(this.lod0);
    this.disposeLevel(this.lod1);
    this.emptyGeometry.dispose();
    this.material.dispose();
  }

  /**
   * Blocks until the active set is fully built. Boot only — 25 builds is ~30 ms, which
   * is why §12 puts this behind the loading screen. It is the one place the per-frame
   * cap is bypassed.
   */
  primeAround(x: number, z: number): void {
    this.centerCx = this.chunkAt(x, this.originX);
    this.centerCz = this.chunkAt(z, this.originZ);
    this.centerValid = true;
    this.refreshSet();
    this.sampleFog(x, z);

    // Guarded so a bookkeeping bug can never spin here for ever.
    let guard = this.maxActive * 2 + 4;
    while (this.pending > 0 && guard > 0) {
      const chunk = this.nearestPending(x, z);
      if (chunk === undefined) break;
      this.buildChunk(chunk);
      guard--;
    }
    this.cull();
  }

  get activeCount(): number {
    return this.residents;
  }

  get visibleCount(): number {
    return this.visible;
  }

  get queuedCount(): number {
    return this.pending;
  }

  /**
   * Total geometries the pool owns (in use plus free). This is the number that must
   * stabilise: a pool that quietly reallocates shows up here as steady growth.
   */
  get pooledCount(): number {
    return this.lod0.all.length + this.lod1.all.length;
  }

  /**
   * Triangles of every built chunk, i.e. what the culler can switch on. The number the
   * GPU actually draws is this minus whatever is outside the frustum.
   */
  get triangleEstimate(): number {
    return this.triCount;
  }

  /** How strongly `fogTint` should be applied; see `sampleFog`. */
  get fogTintWeight(): number {
    return this.fogWeight;
  }

  // -------------------------------------------------------------------------
  // Streaming window
  // -------------------------------------------------------------------------

  /** Returns true when the streaming centre moved and the set needs re-windowing. */
  private recenter(x: number, z: number): boolean {
    const cx = this.chunkAt(x, this.originX);
    const cz = this.chunkAt(z, this.originZ);
    if (!this.centerValid) {
      this.centerCx = cx;
      this.centerCz = cz;
      this.centerValid = true;
      return true;
    }
    const nextCx = this.settle(x, this.originX, cx, this.centerCx);
    const nextCz = this.settle(z, this.originZ, cz, this.centerCz);
    if (nextCx === this.centerCx && nextCz === this.centerCz) return false;
    this.centerCx = nextCx;
    this.centerCz = nextCz;
    return true;
  }

  /**
   * One axis of the centre, with hysteresis: a one-chunk step only counts once the
   * player is CENTER_HYSTERESIS inside the new chunk. A jump of more than one chunk is
   * a warp and is taken immediately.
   */
  private settle(world: number, origin: number, next: number, current: number): number {
    if (next === current) return current;
    const step = next - current;
    if (step > 1 || step < -1) return next;
    const local = world - (origin + next * this.chunkSize);
    if (step > 0) return local >= CENTER_HYSTERESIS ? next : current;
    return local <= this.chunkSize - CENTER_HYSTERESIS ? next : current;
  }

  /** Chunk coordinate on one axis, clamped to the world (§5: outside is a fog sea). */
  private chunkAt(world: number, origin: number): number {
    const last = this.chunksPerSide - 1;
    const c = Math.floor((world - origin) / this.chunkSize);
    if (c < 0) return 0;
    if (c > last) return last;
    return c;
  }

  /**
   * Re-windows the active set around the current centre: evict what fell out, enter
   * what came in, restate every resident chunk's wanted LOD.
   *
   * Eviction runs first on purpose — that is what keeps the record and geometry pools
   * from ever having to hold more than one window's worth plus the handful of
   * geometries a LOD swap has in flight.
   */
  private refreshSet(): void {
    const radius = this.radius;
    const ccx = this.centerCx;
    const ccz = this.centerCz;

    const active = this.active;
    for (let i = this.residents - 1; i >= 0; i--) {
      const chunk = active[i];
      if (chunk === undefined) continue;
      let dx = chunk.cx - ccx;
      if (dx < 0) dx = -dx;
      let dz = chunk.cz - ccz;
      if (dz < 0) dz = -dz;
      if (dx > radius || dz > radius) this.evictAt(i);
    }

    const last = this.chunksPerSide - 1;
    const lod0Radius = this.lod0Radius;
    for (let dz = -radius; dz <= radius; dz++) {
      const cz = ccz + dz;
      if (cz < 0 || cz > last) continue;
      const az = dz < 0 ? -dz : dz;
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = ccx + dx;
        if (cx < 0 || cx > last) continue;
        const ax = dx < 0 ? -dx : dx;
        const ring = ax > az ? ax : az;
        const lod = ring <= lod0Radius ? 0 : 1;

        const slot = cz * this.chunksPerSide + cx;
        let chunk = this.slots[slot];
        if (chunk === undefined) {
          chunk = this.enter(cx, cz, slot, lod);
          if (chunk === undefined) continue;
        }
        chunk.wantLod = lod;
        // Recomputed rather than latched, so a chunk that flips LOD and back before it
        // is reached simply drops out of the queue again.
        const needsBuild = !chunk.built || chunk.lod !== lod;
        if (needsBuild !== chunk.pending) {
          chunk.pending = needsBuild;
          this.pending += needsBuild ? 1 : -1;
        }
      }
    }
  }

  private enter(cx: number, cz: number, slot: number, lod: number): Chunk | undefined {
    const chunk = this.takeRecord();
    if (chunk === undefined) return undefined;
    chunk.cx = cx;
    chunk.cz = cz;
    chunk.slot = slot;
    chunk.lod = -1;
    chunk.wantLod = lod;
    chunk.built = false;
    chunk.pending = false; // the caller states it from `needsBuild`
    chunk.propsFilled = false;
    chunk.centerX = this.originX + cx * this.chunkSize + this.halfChunk;
    chunk.centerZ = this.originZ + cz * this.chunkSize + this.halfChunk;
    chunk.mesh.visible = false;
    this.slots[slot] = chunk;
    this.active[this.residents] = chunk;
    this.residents++;
    return chunk;
  }

  private evictAt(index: number): void {
    const active = this.active;
    const chunk = active[index];
    if (chunk === undefined) return;

    if (chunk.pending) {
      chunk.pending = false;
      this.pending--;
    }
    if (chunk.propsFilled) {
      const props = this.props;
      if (props !== undefined) props.removeChunk(chunk.cx, chunk.cz);
      chunk.propsFilled = false;
    }
    if (chunk.built) {
      this.triCount -= this.levelAt(chunk.lod).triangleCount;
      chunk.built = false;
    }
    chunk.mesh.visible = false;

    const geo = chunk.geo;
    if (geo !== undefined) {
      chunk.geo = undefined;
      chunk.mesh.geometry = this.emptyGeometry;
      this.releaseGeometry(geo);
    }
    if (chunk.slot >= 0) this.slots[chunk.slot] = undefined;
    chunk.slot = -1;
    chunk.lod = -1;

    const lastIndex = this.residents - 1;
    active[index] = active[lastIndex];
    active[lastIndex] = undefined;
    this.residents = lastIndex;
    this.releaseRecord(chunk);
  }

  private evictAll(): void {
    for (let i = this.residents - 1; i >= 0; i--) this.evictAt(i);
    const props = this.props;
    if (props !== undefined) props.clear();
    this.triCount = 0;
    this.pending = 0;
  }

  // -------------------------------------------------------------------------
  // Build queue
  // -------------------------------------------------------------------------

  /**
   * Builds are paced per *rendered frame*, not per tick: Loop runs up to five fixed
   * ticks between two renders after a stall, and five 2 ms mesh builds in one frame is
   * precisely the hitch §12 fails the phase for. `render()` refills the allowance.
   * Before the first render — headless tools, a bare update loop — fall back to one
   * allowance per tick so streaming cannot deadlock.
   */
  private takeBuildAllowance(): number {
    if (!this.renderSeen) return this.buildsPerFrame;
    const left = this.frameBuilds;
    this.frameBuilds = 0;
    return left;
  }

  private runBuilds(px: number, pz: number, allowance: number): void {
    let budget = allowance;
    while (budget > 0 && this.pending > 0) {
      const chunk = this.nearestPending(px, pz);
      if (chunk === undefined) {
        // The counter and the flags disagree; resync instead of spinning.
        this.pending = 0;
        return;
      }
      this.buildChunk(chunk);
      budget--;
    }
  }

  /**
   * Nearest queued chunk to (px, pz). A linear scan of at most 25 records, re-run per
   * build, rather than a sorted queue: it costs nothing, allocates nothing, and always
   * ranks against where the player is *now* instead of where they were when the queue
   * was sorted.
   */
  private nearestPending(px: number, pz: number): Chunk | undefined {
    const active = this.active;
    let best: Chunk | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.residents; i++) {
      const chunk = active[i];
      if (chunk === undefined || !chunk.pending) continue;
      const dx = chunk.centerX - px;
      const dz = chunk.centerZ - pz;
      let score = dx * dx + dz * dz;
      if (chunk.built) score += REFINE_PENALTY;
      if (score < bestScore) {
        bestScore = score;
        best = chunk;
      }
    }
    return best;
  }

  private buildChunk(chunk: Chunk): void {
    const lod = chunk.wantLod;
    const level = this.levelAt(lod);

    // Taken off the books before chunk.lod moves on.
    if (chunk.built) this.triCount -= this.levelAt(chunk.lod).triangleCount;

    let geo = chunk.geo;
    if (geo === undefined || geo.lod !== lod) {
      const next = this.takeGeometry(level);
      if (geo !== undefined) this.releaseGeometry(geo);
      geo = next;
      chunk.geo = next;
      chunk.mesh.geometry = next.geometry;
    }
    chunk.lod = lod;

    this.fill(chunk, level, geo);

    chunk.built = true;
    this.triCount += level.triangleCount;
    if (chunk.pending) {
      chunk.pending = false;
      this.pending--;
    }

    // Props follow the terrain, not the active set: nothing is ever left standing over
    // a chunk that has no mesh yet, and their work spreads across frames with it.
    const props = this.props;
    if (props !== undefined && !chunk.propsFilled) {
      props.addChunk(chunk.cx, chunk.cz);
      chunk.propsFilled = true;
    }
  }

  /**
   * Rewrites one chunk's position and colour arrays in place. This is the expensive
   * function in the phase — ~2 ms for a LOD0 chunk, of which the colour ramp is three
   * quarters — and the reason only one runs per frame.
   */
  private fill(chunk: Chunk, level: LodLevel, geo: PooledGeometry): void {
    const field = this.field;
    const positions = geo.positions;
    const colors = geo.colors;
    const verts = level.verts;
    const spacing = level.spacing;
    const baseX = this.originX + chunk.cx * this.chunkSize;
    const baseZ = this.originZ + chunk.cz * this.chunkSize;

    let minHeight = Number.POSITIVE_INFINITY;
    let maxHeight = Number.NEGATIVE_INFINITY;
    let cursor = 0;

    for (let j = 0; j < verts; j++) {
      const z = baseZ + j * spacing;
      for (let i = 0; i < verts; i++) {
        const x = baseX + i * spacing;
        // Unrounded, un-offset world coordinates: this is the whole of why same-LOD
        // seams are exactly zero and need no stitching pass.
        const h = field.sampleVertex(x, z);
        positions[cursor] = x;
        positions[cursor + 1] = h;
        positions[cursor + 2] = z;

        field.colorAt(x, z, scratchColor);
        colors[cursor] = scratchColor.r;
        colors[cursor + 1] = scratchColor.g;
        colors[cursor + 2] = scratchColor.b;

        cursor += 3;
        if (h < minHeight) minHeight = h;
        if (h > maxHeight) maxHeight = h;
      }
    }

    // Skirt: the border ring again, SKIRT_DEPTH lower and wearing the colour of the
    // vertex it hangs from, so the apron that hides a LOD crack reads as terrain
    // rather than as a black wall.
    const ring = level.ring;
    const ringLength = ring.length;
    for (let r = 0; r < ringLength; r++) {
      const source = (ring[r] ?? 0) * 3;
      positions[cursor] = positions[source] ?? 0;
      positions[cursor + 1] = (positions[source + 1] ?? 0) - SKIRT_DEPTH;
      positions[cursor + 2] = positions[source + 2] ?? 0;
      colors[cursor] = colors[source] ?? 0;
      colors[cursor + 1] = colors[source + 1] ?? 0;
      colors[cursor + 2] = colors[source + 2] ?? 0;
      cursor += 3;
    }

    geo.positionAttr.needsUpdate = true;
    geo.colorAttr.needsUpdate = true;

    // Bounding sphere from the chunk's own extents: exact, O(1), and free of the two
    // O(n) passes computeBoundingSphere() would add to every build.
    const sphere = geo.sphere;
    const half = this.halfChunk;
    const low = minHeight - SKIRT_DEPTH;
    const halfHeight = (maxHeight - low) * 0.5;
    sphere.center.set(baseX + half, low + halfHeight, baseZ + half);
    sphere.radius = Math.sqrt(half * half * 2 + halfHeight * halfHeight) + CULL_MARGIN;
  }

  // -------------------------------------------------------------------------
  // Culling
  // -------------------------------------------------------------------------

  private cull(): void {
    const camera = this.camera;
    // The frustum is built once per frame into module scratch (§3), never per chunk.
    // updateMatrixWorld() guarantees the matrix matches whatever position the camera
    // holds right now; CULL_MARGIN absorbs the frame of lag when the camera rig's
    // render() runs after this one.
    camera.updateMatrixWorld();
    scratchView.copy(camera.matrixWorld).invert();
    scratchViewProjection.multiplyMatrices(camera.projectionMatrix, scratchView);
    scratchFrustum.setFromProjectionMatrix(scratchViewProjection);

    const active = this.active;
    let visible = 0;
    for (let i = 0; i < this.residents; i++) {
      const chunk = active[i];
      if (chunk === undefined) continue;
      const geo = chunk.geo;
      if (!chunk.built || geo === undefined) continue;
      const inside = scratchFrustum.intersectsSphere(geo.sphere);
      chunk.mesh.visible = inside;
      if (inside) visible++;
    }
    this.visible = visible;
  }

  // -------------------------------------------------------------------------
  // Biome fog tint
  // -------------------------------------------------------------------------

  /**
   * Weight is the local blend's departure from the spawn biome, so Verdant Hollow
   * keeps Phase 1's verified daylight fog and Whisperwood's blue mist ramps in across
   * the 30-unit boundary band instead of switching.
   */
  private sampleFog(x: number, z: number): void {
    const sample = this.biomes.sample(x, z, this.biomeSample);
    this.biomes.fogColorAt(sample, this.fogTint);
    this.fogWeight = 1 - (sample.weights[BIOME.VerdantHollow] ?? 1);
  }

  // -------------------------------------------------------------------------
  // Pools
  // -------------------------------------------------------------------------

  private levelAt(lod: number): LodLevel {
    // A ternary on two named fields rather than an array lookup: noUncheckedIndexedAccess
    // would otherwise make every level read `LodLevel | undefined` for no reason.
    return lod <= 0 ? this.lod0 : this.lod1;
  }

  private buildLevel(lod: number, cells: number): LodLevel {
    const verts = cells + 1;
    const coreVertexCount = verts * verts;
    const ringLength = cells * 4;
    const vertexCount = coreVertexCount + ringLength;
    const triangleCount = cells * cells * 2 + ringLength * 2;

    // Perimeter walk: -Z edge going +X, +X edge going +Z, +Z edge going -X, -X edge
    // going -Z. Cyclic, and the direction is what makes every skirt quad below wind
    // outwards, so back-face culling keeps them one-sided.
    const ring = new Int32Array(ringLength);
    let r = 0;
    for (let i = 0; i < cells; i++) ring[r++] = i;
    for (let j = 0; j < cells; j++) ring[r++] = j * verts + cells;
    for (let i = cells; i >= 1; i--) ring[r++] = cells * verts + i;
    for (let j = cells; j >= 1; j--) ring[r++] = j * verts;

    const indexCount = triangleCount * 3;
    const indices =
      vertexCount > UINT16_LIMIT ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    let cursor = 0;

    // Same diagonal and the same winding as TerrainGen: the quad splits from (i,j) to
    // (i+1,j+1), and HeightField.heightAt() resolves `v > u` against that same split.
    // Any other order here and collision would disagree with what the GPU draws.
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const v00 = j * verts + i;
        const v10 = v00 + 1;
        const v01 = v00 + verts;
        const v11 = v01 + 1;
        indices[cursor++] = v00;
        indices[cursor++] = v01;
        indices[cursor++] = v11;
        indices[cursor++] = v00;
        indices[cursor++] = v11;
        indices[cursor++] = v10;
      }
    }

    for (let k = 0; k < ringLength; k++) {
      const next = k + 1 === ringLength ? 0 : k + 1;
      const top0 = ring[k] ?? 0;
      const top1 = ring[next] ?? 0;
      const skirt0 = coreVertexCount + k;
      const skirt1 = coreVertexCount + next;
      indices[cursor++] = top0;
      indices[cursor++] = top1;
      indices[cursor++] = skirt1;
      indices[cursor++] = top0;
      indices[cursor++] = skirt1;
      indices[cursor++] = skirt0;
    }

    return {
      lod,
      cells,
      verts,
      spacing: this.chunkSize / cells,
      coreVertexCount,
      vertexCount,
      triangleCount,
      ring,
      index: new THREE.BufferAttribute(indices, 1),
      all: [],
      free: [],
      freeTop: 0,
    };
  }

  private createRecord(): Chunk {
    const mesh = new THREE.Mesh(this.emptyGeometry, this.material);
    mesh.name = 'chunk';
    // Vertex positions are already world-space, so the transform is the identity for
    // ever: no matrix compose, no matrixWorld propagation, for 25 meshes every frame.
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    // §3 wants the culling done by hand, per chunk, before three sees it.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    // Parented once and left there. Adding and removing 5 meshes per chunk boundary
    // would splice the scene's children list — allocation, for nothing that `visible`
    // does not already do.
    this.scene.add(mesh);
    return {
      cx: -1,
      cz: -1,
      slot: -1,
      lod: -1,
      wantLod: 0,
      geo: undefined,
      mesh,
      built: false,
      pending: false,
      propsFilled: false,
      centerX: 0,
      centerZ: 0,
    };
  }

  private takeRecord(): Chunk | undefined {
    const top = this.freeRecordTop - 1;
    if (top >= 0) {
      const record = this.freeRecords[top];
      if (record !== undefined) {
        this.freeRecordTop = top;
        return record;
      }
    }
    // Unreachable: eviction runs before entry in refreshSet(), so at most maxActive
    // records are ever live. Grow rather than leave a hole in the world.
    if (import.meta.env.DEV) {
      console.warn('[ChunkManager] record pool exhausted at', this.residents, '— growing');
    }
    const grown = this.createRecord();
    this.allRecords.push(grown);
    return grown;
  }

  private releaseRecord(record: Chunk): void {
    const top = this.freeRecordTop;
    if (top < this.freeRecords.length) this.freeRecords[top] = record;
    else this.freeRecords.push(record);
    this.freeRecordTop = top + 1;
  }

  private prewarm(level: LodLevel, count: number): void {
    for (let i = 0; i < count; i++) this.releaseGeometry(this.createGeometry(level));
  }

  private createGeometry(level: LodLevel): PooledGeometry {
    const count = level.vertexCount;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const positionAttr = new THREE.BufferAttribute(positions, 3);
    const colorAttr = new THREE.BufferAttribute(colors, 3);
    // Rewritten wholesale each time a chunk enters the set, then read for hundreds of
    // frames — which is exactly the case the dynamic hint exists for.
    positionAttr.setUsage(THREE.DynamicDrawUsage);
    colorAttr.setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', positionAttr);
    geometry.setAttribute('color', colorAttr);
    // Shared, never rebuilt: the topology of a LOD is fixed, only the vertices move.
    geometry.setIndex(level.index);
    // No normal attribute — flatShading derives normals in the fragment shader (see
    // the file header). No uv either: nothing in §5's art direction samples a texture.

    const sphere = new THREE.Sphere();
    // Assigned, so nothing downstream can trigger three's O(n) recompute.
    geometry.boundingSphere = sphere;

    const entry: PooledGeometry = {
      lod: level.lod,
      geometry,
      positions,
      colors,
      positionAttr,
      colorAttr,
      sphere,
    };
    level.all.push(entry);
    return entry;
  }

  private takeGeometry(level: LodLevel): PooledGeometry {
    const top = level.freeTop - 1;
    if (top >= 0) {
      const entry = level.free[top];
      if (entry !== undefined) {
        level.freeTop = top;
        return entry;
      }
    }
    return this.createGeometry(level);
  }

  private releaseGeometry(entry: PooledGeometry): void {
    const level = this.levelAt(entry.lod);
    const top = level.freeTop;
    if (top < level.free.length) level.free[top] = entry;
    else level.free.push(entry);
    level.freeTop = top + 1;
  }

  private disposeLevel(level: LodLevel): void {
    const all = level.all;
    for (let i = 0; i < all.length; i++) {
      const entry = all[i];
      if (entry === undefined) continue;
      entry.geometry.dispose();
    }
    all.length = 0;
    level.free.length = 0;
    level.freeTop = 0;
  }
}
