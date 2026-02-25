// =============================================================================
// LRU Cache — Bounded in-memory cache with TTL eviction
// =============================================================================
// A simple Least-Recently-Used cache that:
//   • Holds a configurable maximum number of entries (default 500)
//   • Evicts entries after a configurable TTL (default 5 minutes)
//   • Drops the oldest entry when the cache is full
//   • Is fully synchronous — no async overhead for hot reads
//
// Uses a Map (insertion-ordered) for O(1) get/set/delete.
// =============================================================================

interface CacheEntry<V> {
  value: V;
  /** Timestamp (ms) when this entry expires */
  expiresAt: number;
}

export class LRUCache<K, V> {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly store = new Map<K, CacheEntry<V>>();

  /**
   * @param maxSize — Maximum number of entries (default 500)
   * @param ttlMs   — Time-to-live per entry in milliseconds (default 5 min)
   */
  constructor(maxSize = 500, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * Retrieve a cached value.
   * Returns `undefined` if the key is missing or expired.
   * On hit, the entry is moved to the "most recent" position.
   */
  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    // Move to most-recent position (delete + re-insert)
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value;
  }

  /**
   * Store a value in the cache.
   * If the cache is full, the oldest (least-recently-used) entry is evicted.
   */
  set(key: K, value: V): void {
    // If key already exists, delete it first so it moves to the end
    if (this.store.has(key)) {
      this.store.delete(key);
    }

    // Evict oldest if at capacity
    if (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Remove a specific key from the cache.
   */
  delete(key: K): boolean {
    return this.store.delete(key);
  }

  /**
   * Remove all entries from the cache.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Current number of entries (including potentially expired ones).
   * Call `prune()` first for an accurate live count.
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Remove all expired entries.
   */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
