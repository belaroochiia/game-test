/**
 * §7's prop collision structure: a flat 5x5-unit grid of AABBs, queried with a
 * rectangle. Deliberately not a quadtree — props are roughly uniform in size and
 * density here, so a hash grid is both faster and simpler, and §13 rules out a
 * physics engine's broadphase.
 *
 * `query` is allocation-free: it reports through a callback instead of returning
 * an array, and de-duplicates boxes spanning several cells with a monotonic
 * integer stamp rather than a Set.
 */

export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

const DEFAULT_CELL_SIZE = 5;

export class SpatialHash {
  private readonly cellSize: number;
  private readonly invCellSize: number;

  /** Dense store. A removed slot's box is kept but marked dead via `alive`. */
  private readonly boxes: AABB[] = [];
  private readonly alive: boolean[] = [];
  /** Last query that visited each box, so a multi-cell box reports once. */
  private readonly stamp: number[] = [];
  private currentStamp = 0;
  /**
   * Ids returned by `remove`, reused by the next `insert`. Without this the store
   * grows monotonically: Phase 2 streams props in and out of the active set
   * continuously, so ~8 AABBs per chunk entry would accumulate forever, inflating
   * both the heap and every query bucket they still sat in.
   */
  private readonly freeIds: number[] = [];

  /** cellKey -> ids. Arrays are reused; ids are appended, never spliced on clear. */
  private readonly cells = new Map<number, number[]>();
  private liveCount = 0;

  constructor(cellSize: number = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize > 0 ? cellSize : DEFAULT_CELL_SIZE;
    this.invCellSize = 1 / this.cellSize;
  }

  /** The AABB is copied, so callers may reuse a scratch object. */
  insert(box: AABB): number {
    // Reuse a freed slot when one exists; its cell entries were removed by
    // `remove`, so the id cannot resurface in a stale bucket.
    let id = this.freeIds.pop() ?? -1;
    if (id >= 0) {
      const existing = this.boxes[id];
      if (existing !== undefined) {
        existing.minX = box.minX;
        existing.minY = box.minY;
        existing.minZ = box.minZ;
        existing.maxX = box.maxX;
        existing.maxY = box.maxY;
        existing.maxZ = box.maxZ;
      }
      this.alive[id] = true;
      this.stamp[id] = -1;
    } else {
      id = this.boxes.length;
      this.boxes.push({
        minX: box.minX,
        minY: box.minY,
        minZ: box.minZ,
        maxX: box.maxX,
        maxY: box.maxY,
        maxZ: box.maxZ,
      });
      this.alive.push(true);
      this.stamp.push(-1);
    }
    this.liveCount++;

    const x0 = Math.floor(box.minX * this.invCellSize);
    const x1 = Math.floor(box.maxX * this.invCellSize);
    const z0 = Math.floor(box.minZ * this.invCellSize);
    const z1 = Math.floor(box.maxZ * this.invCellSize);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = SpatialHash.key(cx, cz);
        let bucket = this.cells.get(key);
        if (bucket === undefined) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push(id);
      }
    }
    return id;
  }

  /**
   * Frees the box: its id is pulled out of every cell bucket it occupies and
   * returned to the free list.
   *
   * An earlier version only tombstoned, on the theory that a dead id costs one
   * boolean check per visit. That is true per visit but wrong in aggregate —
   * streaming props in and out of the active set left every removed AABB in its
   * buckets forever, so both the heap and the query cost grew for the whole
   * session. A box spans 1–4 cells, so pulling it out now is cheap and bounded.
   */
  remove(id: number): void {
    if (id < 0 || id >= this.alive.length) return;
    if (this.alive[id] !== true) return;
    const box = this.boxes[id];
    if (box !== undefined) {
      const x0 = Math.floor(box.minX * this.invCellSize);
      const x1 = Math.floor(box.maxX * this.invCellSize);
      const z0 = Math.floor(box.minZ * this.invCellSize);
      const z1 = Math.floor(box.maxZ * this.invCellSize);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const key = SpatialHash.key(cx, cz);
          const bucket = this.cells.get(key);
          if (bucket === undefined) continue;
          // Swap-with-last: bucket order carries no meaning.
          for (let i = 0; i < bucket.length; i++) {
            if (bucket[i] !== id) continue;
            const last = bucket.length - 1;
            const tail = bucket[last];
            if (tail !== undefined) bucket[i] = tail;
            bucket.length = last;
            break;
          }
          if (bucket.length === 0) this.cells.delete(key);
        }
      }
    }
    this.alive[id] = false;
    this.stamp[id] = -1;
    this.freeIds.push(id);
    this.liveCount--;
  }

  clear(): void {
    this.boxes.length = 0;
    this.alive.length = 0;
    this.stamp.length = 0;
    this.freeIds.length = 0;
    this.cells.clear();
    this.liveCount = 0;
    this.currentStamp = 0;
  }

  /**
   * Visits every live box whose cell overlaps the query rectangle. Boxes are
   * reported at most once per query. `visit` must be a pre-bound function — do
   * not pass a fresh arrow from the frame path (§13).
   */
  query(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    visit: (box: AABB, id: number) => void,
  ): void {
    const stampNow = ++this.currentStamp;
    const x0 = Math.floor(minX * this.invCellSize);
    const x1 = Math.floor(maxX * this.invCellSize);
    const z0 = Math.floor(minZ * this.invCellSize);
    const z1 = Math.floor(maxZ * this.invCellSize);

    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.cells.get(SpatialHash.key(cx, cz));
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i];
          if (id === undefined) continue;
          if (this.alive[id] !== true) continue;
          if (this.stamp[id] === stampNow) continue;
          this.stamp[id] = stampNow;
          const box = this.boxes[id];
          if (box === undefined) continue;
          visit(box, id);
        }
      }
    }
  }

  get count(): number {
    return this.liveCount;
  }

  /**
   * Packs signed cell coordinates into one integer key. +32768 bias keeps the
   * value positive for cells within +/-163 840 world units at cellSize 5, which
   * is ~270x the 600x600 map (§5) — no wraparound is reachable.
   */
  private static key(cx: number, cz: number): number {
    return ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);
  }
}
