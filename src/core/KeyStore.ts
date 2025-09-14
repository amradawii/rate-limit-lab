import type { Clock } from './Clock.js';
import { assertPositiveInteger } from './RateLimiter.js';

export interface KeyStoreOptions {
  /** Hard cap on tracked keys. Default 10 000. */
  maxKeys?: number;
  /** Minimum time between sweeps for expired keys. Default 1 000 ms. */
  sweepIntervalMs?: number;
}

/**
 * Per-key limiter state with bounded memory (edge case #8).
 *
 * A plain Map that never forgets is a memory leak: an attacker rotating keys creates one entry
 * per request. This store:
 *
 * 1. Sweeps **expired** keys: those whose limiter state is fully restored, so forgetting them
 *    changes nothing (a key is never dropped while it is still being limited). Sweeps run at
 *    most once per `sweepIntervalMs`, keeping the cost amortised.
 * 2. Enforces `maxKeys`. When a new key arrives at the cap, a due sweep runs first; if the store
 *    is still full, the **least recently used** key is evicted. That key gets a fresh limit if it
 *    returns: the price of bounded memory, documented rather than hidden.
 *
 * Recency is tracked by Map insertion order: each access moves the key to the end.
 */
export class KeyStore<V> {
  readonly maxKeys: number;
  readonly sweepIntervalMs: number;
  readonly #entries = new Map<string, V>();
  readonly #clock: Clock;
  readonly #isExpired: (value: V, now: number) => boolean;
  #lastSweep: number;

  constructor(
    clock: Clock,
    isExpired: (value: V, now: number) => boolean,
    options: KeyStoreOptions = {},
  ) {
    this.maxKeys = options.maxKeys ?? 10_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 1_000;
    assertPositiveInteger('maxKeys', this.maxKeys);
    assertPositiveInteger('sweepIntervalMs', this.sweepIntervalMs);
    this.#clock = clock;
    this.#isExpired = isExpired;
    this.#lastSweep = clock.now();
  }

  get size(): number {
    return this.#entries.size;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** Reads a key without marking it as used. */
  peek(key: string): V | undefined {
    return this.#entries.get(key);
  }

  values(): IterableIterator<V> {
    return this.#entries.values();
  }

  /** Returns the state for `key`, creating it with `create` if missing, and marks it as used. */
  getOrCreate(key: string, create: () => V): V {
    const now = this.#clock.now();
    if (now - this.#lastSweep >= this.sweepIntervalMs) this.sweep(now);

    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return existing;
    }

    if (this.#entries.size >= this.maxKeys) {
      const lru = this.#entries.keys().next();
      if (!lru.done) this.#entries.delete(lru.value);
    }
    const value = create();
    this.#entries.set(key, value);
    return value;
  }

  /** Removes every expired key. Returns how many were removed. */
  sweep(now = this.#clock.now()): number {
    this.#lastSweep = now;
    let removed = 0;
    for (const [key, value] of this.#entries) {
      if (this.#isExpired(value, now)) {
        this.#entries.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
