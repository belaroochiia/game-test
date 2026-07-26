/**
 * Generic object pool — mandatory for every VFX / projectile / floating-damage
 * instance (§4, §13: never build a Mesh per particle).
 *
 * The free list is a stack (dense array + integer top index), so `acquire`/`release`
 * are O(1) and allocate nothing once the pool is warm. Only growth allocates, which
 * is why growth belongs in loading code, not in a frame (§3: 0 byte/frame).
 */

export interface PoolOptions<T> {
  initial?: number; // default 0 — pre-warmed instances
  max?: number; // default 0 = unbounded (grow on demand)
  grow?: number; // default 8 — how many to build when empty and below max
  onAcquire?: (item: T) => void;
  onRelease?: (item: T) => void;
  label?: string; // for Profiler / warnings
}

export class ObjectPool<T> {
  readonly label: string;

  private readonly factory: () => T;
  private readonly initialSize: number;
  private readonly maxSize: number;
  private readonly growStep: number;
  private readonly onAcquireCb: ((item: T) => void) | undefined;
  private readonly onReleaseCb: ((item: T) => void) | undefined;

  /** Every instance this pool ever built, in creation order. */
  private readonly created: T[] = [];
  /** Free stack; only slots below `top` are meaningful. */
  private readonly freeStack: T[] = [];
  private top = 0;
  private liveCount = 0;
  private highWaterMark = 0;
  private growthWarned = false;

  /** Dev-only live registry for double-release detection; absent in production. */
  private readonly liveSet: Set<T> | undefined;

  constructor(factory: () => T, options?: PoolOptions<T>) {
    this.factory = factory;
    this.label = options?.label ?? 'pool';

    const max = options?.max ?? 0;
    this.maxSize = max > 0 ? Math.floor(max) : 0;

    const initial = options?.initial ?? 0;
    let initialSize = initial > 0 ? Math.floor(initial) : 0;
    if (this.maxSize > 0 && initialSize > this.maxSize) initialSize = this.maxSize;
    this.initialSize = initialSize;

    const grow = options?.grow ?? 8;
    this.growStep = grow > 0 ? Math.floor(grow) : 1;

    this.onAcquireCb = options?.onAcquire;
    this.onReleaseCb = options?.onRelease;

    let liveSet: Set<T> | undefined;
    if (import.meta.env.DEV) liveSet = new Set<T>();
    this.liveSet = liveSet;

    if (initialSize > 0) this.create(initialSize, false);
  }

  /**
   * Takes an instance from the free stack, growing the pool if it is empty.
   * Returns `undefined` when `max` is reached — that is the intended back-pressure:
   * the caller must skip the effect rather than allocate outside the pool (§13).
   */
  acquire(): T | undefined {
    if (this.top === 0 && this.create(this.growStep, true) === 0) return undefined;
    const index = this.top - 1;
    const item = this.freeStack[index];
    if (item === undefined) return undefined;
    this.top = index;

    const live = this.liveCount + 1;
    this.liveCount = live;
    if (live > this.highWaterMark) this.highWaterMark = live;

    if (import.meta.env.DEV) {
      const set = this.liveSet;
      if (set !== undefined) set.add(item);
    }

    const onAcquire = this.onAcquireCb;
    if (onAcquire !== undefined) onAcquire(item);
    return item;
  }

  /** Returns an instance. A double release (or a foreign item) warns and is ignored. */
  release(item: T): void {
    if (import.meta.env.DEV) {
      const set = this.liveSet;
      if (set !== undefined) {
        if (!set.has(item)) {
          console.warn('[ObjectPool]', this.label, 'release of an item that is not live (double release or foreign item) — ignored');
          return;
        }
        set.delete(item);
      }
    }
    if (this.liveCount === 0) {
      console.warn('[ObjectPool]', this.label, 'release with nothing live — ignored');
      return;
    }
    this.liveCount--;

    const onRelease = this.onReleaseCb;
    if (onRelease !== undefined) onRelease(item);
    this.pushFree(item);
  }

  /**
   * Returns every live instance to the pool.
   * `onRelease` runs for each *created* instance, including ones that were already
   * free: production keeps no live registry (that would cost a Set write per
   * acquire/release, §3), so `onRelease` must be idempotent — it is a state reset.
   */
  releaseAll(): void {
    const created = this.created;
    const total = created.length;
    const onRelease = this.liveCount > 0 ? this.onReleaseCb : undefined;
    for (let i = 0; i < total; i++) {
      const item = created[i];
      if (item === undefined) continue;
      this.freeStack[i] = item;
      if (onRelease !== undefined) onRelease(item);
    }
    if (this.freeStack.length > total) this.freeStack.length = total;
    this.top = total;
    this.liveCount = 0;

    if (import.meta.env.DEV) {
      const set = this.liveSet;
      if (set !== undefined) set.clear();
    }
  }

  /** Ensures at least `count` instances are free (clamped by `max`). Allocates — load time only. */
  prewarm(count: number): void {
    if (count <= 0) return;
    const missing = Math.floor(count) - this.top;
    if (missing > 0) this.create(missing, false);
  }

  /**
   * `releaseAll()` plus drop grown capacity back to `initial`. Dropped instances are
   * garbage, not disposed — a pool of GPU resources should free them in `onRelease`
   * or simply keep its capacity. `highWater` survives on purpose: it is a session
   * diagnostic for budget tuning.
   */
  reset(): void {
    this.releaseAll();
    const keep = this.initialSize;
    const created = this.created;
    if (created.length > keep) {
      // After releaseAll(), freeStack[i] === created[i], so both truncate consistently.
      created.length = keep;
      this.freeStack.length = keep;
      this.top = keep;
    }
    this.growthWarned = false;
  }

  /** Total instances created. */
  get size(): number {
    return this.created.length;
  }

  /** Currently acquired. */
  get live(): number {
    return this.liveCount;
  }

  get free(): number {
    return this.top;
  }

  /** Peak concurrent live count — the number to size `initial`/`max` from. */
  get highWater(): number {
    return this.highWaterMark;
  }

  /** Builds up to `count` instances, clamped by `max`. Returns how many were built. */
  private create(count: number, onDemand: boolean): number {
    let wanted = count;
    const max = this.maxSize;
    if (max > 0) {
      const room = max - this.created.length;
      if (room <= 0) return 0;
      if (wanted > room) wanted = room;
    }
    if (wanted <= 0) return 0;

    for (let i = 0; i < wanted; i++) {
      const item = this.factory();
      this.created.push(item);
      this.pushFree(item);
    }

    if (import.meta.env.DEV && onDemand && !this.growthWarned) {
      // Growing mid-session means the pool was sized wrong; warn once. A pool built
      // with initial = 0 is lazy by design and opts out.
      const threshold = this.initialSize * 4;
      if (threshold > 0 && this.created.length > threshold) {
        this.growthWarned = true;
        console.warn('[ObjectPool]', this.label, 'grew past 4x initial:', this.created.length, 'created, initial', this.initialSize, '— raise initial/max, growth allocates mid-frame (§3)');
      }
    }
    return wanted;
  }

  private pushFree(item: T): void {
    const top = this.top;
    if (top < this.freeStack.length) this.freeStack[top] = item;
    else this.freeStack.push(item);
    this.top = top + 1;
  }
}
