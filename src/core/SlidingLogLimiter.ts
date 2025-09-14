import type { Clock } from './Clock.js';
import { KeyStore } from './KeyStore.js';
import {
  assertCost,
  assertPositiveInteger,
  type RateLimiter,
  type RateLimitResult,
  type WindowOptions,
} from './RateLimiter.js';

/**
 * Keeps a timestamp for every allowed unit and counts those younger than one window.
 *
 * Exact: no more than `limit` units in any rolling window, so no boundary burst. The cost is
 * memory: up to `limit` timestamps per key (only allowed requests are logged, so a flooding
 * client cannot grow its log past the limit). Timestamps older than the window are pruned on
 * each call for that key.
 */
export class SlidingLogLimiter implements RateLimiter {
  readonly algorithm = 'sliding-log';
  readonly limit: number;
  readonly windowMs: number;
  readonly #clock: Clock;
  readonly #store: KeyStore<number[]>;

  constructor(options: WindowOptions, clock: Clock) {
    assertPositiveInteger('limit', options.limit);
    assertPositiveInteger('windowMs', options.windowMs);
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.#clock = clock;
    // Expired once the newest logged request has left the window.
    this.#store = new KeyStore(
      clock,
      (log, now) => {
        const newest = log.at(-1);
        return newest === undefined || newest + this.windowMs <= now;
      },
      options.keys,
    );
  }

  consume(key: string, cost = 1): RateLimitResult {
    assertCost(cost, this.limit);
    const now = this.#clock.now();
    const log = this.#store.getOrCreate(key, () => []);

    // Oldest first. An entry stops counting once a full window has passed since it.
    let expired = 0;
    while (expired < log.length && log[expired]! <= now - this.windowMs) expired++;
    if (expired > 0) log.splice(0, expired);

    const allowed = log.length + cost <= this.limit;
    let retryAfterMs = 0;
    if (allowed) {
      for (let i = 0; i < cost; i++) log.push(now);
    } else {
      // Wait until enough of the oldest entries have expired to make room for `cost` units.
      const mustExpire = log.length + cost - this.limit;
      retryAfterMs = log[mustExpire - 1]! + this.windowMs - now;
    }

    const newest = log.at(-1);
    return {
      allowed,
      limit: this.limit,
      remaining: this.limit - log.length,
      resetMs: newest === undefined ? 0 : newest + this.windowMs - now,
      retryAfterMs,
    };
  }

  /** Total timestamps held across all keys: the memory cost of exactness (edge case #2). */
  storedEntries(): number {
    let total = 0;
    for (const log of this.#store.values()) total += log.length;
    return total;
  }

  trackedKeys(): number {
    return this.#store.size;
  }
}
