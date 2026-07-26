/**
 * Typed, allocation-free event bus (§4: plain TS class + event bus, no store lib).
 *
 * `emit()` allocates nothing: handlers live in plain arrays walked by index, and
 * mutation during dispatch is absorbed by a re-entrancy depth counter plus reused
 * deferred queues instead of copying the handler list (§3: 0 byte/frame).
 *
 * Payloads are CALLER-OWNED and are usually reused scratch objects at call sites in
 * the frame path. A handler must read what it needs synchronously and must never
 * retain the payload object or any part of it.
 */

/** Payload map. Extended in later phases; keep alphabetical. */
export interface GameEventMap {
  'debug:toggle': { visible: boolean };
  'engine:quality': { pixelRatio: number; direction: -1 | 0 | 1 };
  'engine:resize': { width: number; height: number; pixelRatio: number };
  'engine:started': { webgl2: boolean };
  'loop:stall': { frameMs: number; droppedSteps: number };
}

export type GameEventName = keyof GameEventMap;
export type Handler<K extends GameEventName> = (payload: GameEventMap[K]) => void;

/** Handlers are stored type-erased; the public methods re-apply the payload type. */
type StoredHandler = (payload: unknown) => void;

interface ListenerList {
  /** A slot is `undefined` when it was tombstoned by a removal during dispatch. */
  handlers: Array<StoredHandler | undefined>;
  onceFlags: boolean[];
  /** Live (non-tombstone) entries — keeps `listenerCount` O(1). */
  count: number;
  holes: number;
  /** Already queued for compaction. */
  dirty: boolean;
}

export class EventBus {
  private readonly lists = new Map<GameEventName, ListenerList>();
  /** Every list ever created, so flush/reset can iterate without a Map iterator. */
  private readonly all: ListenerList[] = [];

  /** Nested `emit` depth. > 0 means arrays are being walked and must not be resized. */
  private depth = 0;
  private liveTotal = 0;

  // Deferred registrations (only used while depth > 0). Reused, never re-created.
  private readonly pendingLists: Array<ListenerList | undefined> = [];
  private readonly pendingHandlers: Array<StoredHandler | undefined> = [];
  private readonly pendingOnce: boolean[] = [];
  private pendingCount = 0;

  // Lists that hold tombstones and need compaction on flush. Reused.
  private readonly dirtyLists: Array<ListenerList | undefined> = [];
  private dirtyCount = 0;

  /** Subscribes and returns an idempotent unsubscribe. */
  on<K extends GameEventName>(name: K, handler: Handler<K>): () => void {
    this.add(name, handler as StoredHandler, false);
    let done = false;
    return (): void => {
      if (done) return;
      done = true;
      this.off(name, handler);
    };
  }

  /** Like `on`, but the handler is unsubscribed *before* it is invoked. */
  once<K extends GameEventName>(name: K, handler: Handler<K>): () => void {
    this.add(name, handler as StoredHandler, true);
    let done = false;
    return (): void => {
      if (done) return;
      done = true;
      this.off(name, handler);
    };
  }

  /** Removes the first registration of `handler`. Unknown handlers are a silent no-op. */
  off<K extends GameEventName>(name: K, handler: Handler<K>): void {
    const list = this.lists.get(name);
    if (list === undefined) return;
    const target = handler as StoredHandler;
    const handlers = list.handlers;
    const len = handlers.length;
    for (let i = 0; i < len; i++) {
      if (handlers[i] !== target) continue;
      if (this.depth > 0) {
        // An emit loop holds indices into this array: tombstone, compact on flush.
        handlers[i] = undefined;
        list.onceFlags[i] = false;
        list.holes++;
        list.count--;
        this.liveTotal--;
        this.markDirty(list);
      } else {
        const last = len - 1;
        handlers[i] = handlers[last];
        list.onceFlags[i] = list.onceFlags[last] === true;
        handlers.length = last;
        list.onceFlags.length = last;
        list.count--;
        this.liveTotal--;
      }
      return;
    }
    // Not live: the registration may still be sitting in the deferred add queue.
    if (this.pendingCount > 0) this.cancelPending(list, target);
  }

  /**
   * Dispatches synchronously to every handler registered when the emit started.
   * Allocation-free. A throwing handler is logged and does not abort the dispatch.
   * Handlers added during the emit run on the next emit; handlers removed during it
   * are skipped for the rest of this emit (including nested ones).
   */
  emit<K extends GameEventName>(name: K, payload: GameEventMap[K]): void {
    const list = this.lists.get(name);
    if (list === undefined || list.count === 0) return;
    const handlers = list.handlers;
    const onceFlags = list.onceFlags;
    const len = handlers.length;
    this.depth++;
    try {
      for (let i = 0; i < len; i++) {
        const handler = handlers[i];
        if (handler === undefined) continue;
        if (onceFlags[i] === true) {
          // Unsubscribe before invoking so a re-entrant emit cannot double-fire it.
          handlers[i] = undefined;
          onceFlags[i] = false;
          list.holes++;
          list.count--;
          this.liveTotal--;
          this.markDirty(list);
        }
        try {
          handler(payload);
        } catch (error) {
          console.error('[EventBus] handler threw for', name, error);
        }
      }
    } finally {
      this.depth--;
      if (this.depth === 0) this.flush();
    }
  }

  /** Handlers for `name`, or for every event when omitted. Counts deferred adds. */
  listenerCount(name?: GameEventName): number {
    const pending = this.pendingCount;
    if (name === undefined) return this.liveTotal + pending;
    const list = this.lists.get(name);
    if (list === undefined) return 0;
    let count = list.count;
    for (let i = 0; i < pending; i++) {
      if (this.pendingLists[i] === list) count++;
    }
    return count;
  }

  /** Drops all handlers. Safe to call from inside a handler. */
  reset(): void {
    const pending = this.pendingCount;
    for (let i = 0; i < pending; i++) {
      this.pendingLists[i] = undefined;
      this.pendingHandlers[i] = undefined;
      this.pendingOnce[i] = false;
    }
    this.pendingCount = 0;

    const all = this.all;
    const listCount = all.length;
    const emitting = this.depth > 0;
    for (let i = 0; i < listCount; i++) {
      const list = all[i];
      if (list === undefined) continue;
      const handlers = list.handlers;
      const len = handlers.length;
      if (emitting) {
        for (let j = 0; j < len; j++) {
          handlers[j] = undefined;
          list.onceFlags[j] = false;
        }
        list.holes = len;
        list.count = 0;
        if (len > 0) this.markDirty(list);
      } else {
        handlers.length = 0;
        list.onceFlags.length = 0;
        list.count = 0;
        list.holes = 0;
      }
    }
    this.liveTotal = 0;

    if (!emitting) {
      const dirty = this.dirtyCount;
      for (let i = 0; i < dirty; i++) {
        const list = this.dirtyLists[i];
        if (list !== undefined) list.dirty = false;
        this.dirtyLists[i] = undefined;
      }
      this.dirtyCount = 0;
    }
  }

  private listFor(name: GameEventName): ListenerList {
    let list = this.lists.get(name);
    if (list === undefined) {
      // Once per event name, never in steady state.
      list = { handlers: [], onceFlags: [], count: 0, holes: 0, dirty: false };
      this.lists.set(name, list);
      this.all.push(list);
    }
    return list;
  }

  private add(name: GameEventName, handler: StoredHandler, once: boolean): void {
    const list = this.listFor(name);
    if (this.depth > 0) {
      const n = this.pendingCount;
      if (n < this.pendingLists.length) {
        this.pendingLists[n] = list;
        this.pendingHandlers[n] = handler;
        this.pendingOnce[n] = once;
      } else {
        this.pendingLists.push(list);
        this.pendingHandlers.push(handler);
        this.pendingOnce.push(once);
      }
      this.pendingCount = n + 1;
      return;
    }
    list.handlers.push(handler);
    list.onceFlags.push(once);
    list.count++;
    this.liveTotal++;
  }

  /** Removes a still-queued registration, preserving the order of the rest. */
  private cancelPending(list: ListenerList, handler: StoredHandler): void {
    const n = this.pendingCount;
    for (let i = 0; i < n; i++) {
      if (this.pendingLists[i] !== list || this.pendingHandlers[i] !== handler) continue;
      for (let j = i + 1; j < n; j++) {
        this.pendingLists[j - 1] = this.pendingLists[j];
        this.pendingHandlers[j - 1] = this.pendingHandlers[j];
        this.pendingOnce[j - 1] = this.pendingOnce[j] === true;
      }
      const last = n - 1;
      this.pendingLists[last] = undefined;
      this.pendingHandlers[last] = undefined;
      this.pendingOnce[last] = false;
      this.pendingCount = last;
      return;
    }
  }

  private markDirty(list: ListenerList): void {
    if (list.dirty) return;
    list.dirty = true;
    const n = this.dirtyCount;
    if (n < this.dirtyLists.length) this.dirtyLists[n] = list;
    else this.dirtyLists.push(list);
    this.dirtyCount = n + 1;
  }

  /** Applies everything that was deferred while dispatching. Depth is 0 here. */
  private flush(): void {
    const pending = this.pendingCount;
    if (pending > 0) {
      for (let i = 0; i < pending; i++) {
        const list = this.pendingLists[i];
        const handler = this.pendingHandlers[i];
        this.pendingLists[i] = undefined;
        this.pendingHandlers[i] = undefined;
        const once = this.pendingOnce[i] === true;
        this.pendingOnce[i] = false;
        if (list === undefined || handler === undefined) continue;
        list.handlers.push(handler);
        list.onceFlags.push(once);
        list.count++;
        this.liveTotal++;
      }
      this.pendingCount = 0;
    }

    const dirty = this.dirtyCount;
    if (dirty === 0) return;
    for (let i = 0; i < dirty; i++) {
      const list = this.dirtyLists[i];
      this.dirtyLists[i] = undefined;
      if (list === undefined) continue;
      list.dirty = false;
      if (list.holes > 0) EventBus.compact(list);
    }
    this.dirtyCount = 0;
  }

  /** Squeezes out tombstones in place, keeping registration order. */
  private static compact(list: ListenerList): void {
    const handlers = list.handlers;
    const onceFlags = list.onceFlags;
    const len = handlers.length;
    let write = 0;
    for (let read = 0; read < len; read++) {
      const handler = handlers[read];
      if (handler === undefined) continue;
      if (write !== read) {
        handlers[write] = handler;
        onceFlags[write] = onceFlags[read] === true;
      }
      write++;
    }
    handlers.length = write;
    onceFlags.length = write;
    list.count = write;
    list.holes = 0;
  }
}
