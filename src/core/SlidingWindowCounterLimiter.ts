import type { Clock } from './Clock.js';
import { KeyStore } from './KeyStore.js';
import {
  assertCost,
  assertPositiveInteger,
  type RateLimiter,
  type RateLimitResult,
  type WindowOptions,
} from './RateLimiter.js';

interface CounterState {
  windowStart: number;
  previous: number;
  current: number;
}

/**
 * Two fixed-window counters per key (previous and current), blended into an estimate of the
 * rolling window:
 *
 *   estimate = previous × (time left in the current window / window) + current
 *
 * Constant memory per key. It assumes the previous window's traffic was spread evenly, which
 * blocks the classic boundary burst. It is still an approximation: if the previous window's
 * traffic was packed at its very end and the current window's traffic is spread out, a rolling
 * window can approach (but not reach) 2 × limit. With evenly spread traffic the error is small.
 */
export class SlidingWindowCounterLimiter implements RateLimiter {
  readonly algorithm = 'sliding-window-counter';
  readonly limit: number;
  readonly windowMs: number;
  readonly #clock: Clock;
  readonly #store: KeyStore<CounterState>;

  constructor(options: WindowOptions, clock: Clock) {
    assertPositiveInteger('limit', options.limit);
    assertPositiveInteger('windowMs', options.windowMs);
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.#clock = clock;
    // The current count still weighs on the next window; the previous one only on this window.
    this.#store = new KeyStore(
      clock,
      (s, now) => s.windowStart + (s.current > 0 ? 2 : 1) * this.windowMs <= now,
      options.keys,
    );
  }

  consume(key: string, cost = 1): RateLimitResult {
    assertCost(cost, this.limit);
    const W = this.windowMs;
    const now = this.#clock.now();
    const windowStart = Math.floor(now / W) * W;

    const s = this.#store.getOrCreate(key, () => ({ windowStart, previous: 0, current: 0 }));
    if (s.windowStart !== windowStart) {
      // One window later: current becomes previous. Two or more: both are stale.
      s.previous = s.windowStart === windowStart - W ? s.current : 0;
      s.current = 0;
      s.windowStart = windowStart;
    }

    const left = windowStart + W - now; // time left in the current window, (0, W]
    // Compare previous × left / W + current + cost <= limit without dividing.
    const allowed = s.previous * left + (s.current + cost) * W <= this.limit * W;
    if (allowed) s.current += cost;

    const estimate = (s.previous * left) / W + s.current;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, Math.floor(this.limit - estimate)),
      resetMs: s.current > 0 ? left + W : s.previous > 0 ? left : 0,
      retryAfterMs: allowed ? 0 : this.#retryAfter(s, cost, now),
    };
  }

  #retryAfter(s: CounterState, cost: number, now: number): number {
    const W = this.windowMs;
    const room = this.limit - s.current - cost;
    if (room >= 0 && s.previous > 0) {
      // Later in this window: previous × left' / W <= room.
      return s.windowStart + W - (room * W) / s.previous - now;
    }
    // Next window: current becomes previous and must decay until current × left'' / W + cost <= limit.
    const wait = s.current > 0 ? Math.max(0, W - ((this.limit - cost) * W) / s.current) : 0;
    return s.windowStart + W + wait - now;
  }

  /** Counters held across all keys: always two per key (edge case #2). */
  storedEntries(): number {
    return this.#store.size * 2;
  }

  trackedKeys(): number {
    return this.#store.size;
  }
}
