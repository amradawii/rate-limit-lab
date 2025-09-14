import type { Clock } from './Clock.js';
import { KeyStore } from './KeyStore.js';
import {
  assertCost,
  assertPositiveInteger,
  type RateLimiter,
  type RateLimitResult,
  type WindowOptions,
} from './RateLimiter.js';

interface WindowState {
  windowStart: number;
  count: number;
}

/**
 * Counts requests in fixed, aligned windows: [0, W), [W, 2W), ...
 *
 * Cheap (one counter per key) but has the window boundary burst: `limit` requests at the end of
 * one window and `limit` more at the start of the next are all allowed, so up to 2 × limit
 * requests can pass in a span much shorter than one window.
 */
export class FixedWindowLimiter implements RateLimiter {
  readonly algorithm = 'fixed-window';
  readonly limit: number;
  readonly windowMs: number;
  readonly #clock: Clock;
  readonly #store: KeyStore<WindowState>;

  constructor(options: WindowOptions, clock: Clock) {
    assertPositiveInteger('limit', options.limit);
    assertPositiveInteger('windowMs', options.windowMs);
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.#clock = clock;
    // A key's state is meaningless once its window has ended.
    this.#store = new KeyStore(
      clock,
      (s, now) => s.windowStart + this.windowMs <= now,
      options.keys,
    );
  }

  consume(key: string, cost = 1): RateLimitResult {
    assertCost(cost, this.limit);
    const now = this.#clock.now();
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;

    const state = this.#store.getOrCreate(key, () => ({ windowStart, count: 0 }));
    if (state.windowStart !== windowStart) {
      state.windowStart = windowStart;
      state.count = 0;
    }

    const resetMs = windowStart + this.windowMs - now;
    const allowed = state.count + cost <= this.limit;
    if (allowed) state.count += cost;

    return {
      allowed,
      limit: this.limit,
      remaining: this.limit - state.count,
      resetMs,
      retryAfterMs: allowed ? 0 : resetMs,
    };
  }

  trackedKeys(): number {
    return this.#store.size;
  }
}
