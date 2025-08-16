import type { Clock } from './Clock.js';
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
  readonly #state = new Map<string, WindowState>();

  constructor(options: WindowOptions, clock: Clock) {
    assertPositiveInteger('limit', options.limit);
    assertPositiveInteger('windowMs', options.windowMs);
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.#clock = clock;
  }

  consume(key: string, cost = 1): RateLimitResult {
    assertCost(cost, this.limit);
    const now = this.#clock.now();
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;

    let state = this.#state.get(key);
    if (!state || state.windowStart !== windowStart) {
      state = { windowStart, count: 0 };
      this.#state.set(key, state);
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
}
