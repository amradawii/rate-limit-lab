import type { Clock } from './Clock.js';
import {
  assertCost,
  assertPositiveInteger,
  type RateLimiter,
  type RateLimitResult,
} from './RateLimiter.js';

export interface TokenBucketOptions {
  /** Maximum tokens, i.e. the largest burst allowed at once. */
  capacity: number;
  /** Tokens added per second: the long-run average rate. */
  refillPerSecond: number;
}

interface Bucket {
  milliTokens: number;
  lastRefill: number;
}

const MILLI = 1_000;

/**
 * A bucket per key holds up to `capacity` tokens and refills at `refillPerSecond`. Each request
 * takes `cost` tokens. Allows short bursts (a page loading 20 assets) while enforcing the average.
 *
 * Tokens are stored as integer milli-tokens. With an integer rate per second, the refill is
 * exactly `refillPerSecond` milli-tokens per whole millisecond, so there is no floating-point
 * drift. Fractions of a millisecond (the monotonic clock is sub-millisecond) are not lost: only
 * whole milliseconds are converted, and the remainder stays in `lastRefill` for the next call.
 */
export class TokenBucketLimiter implements RateLimiter {
  readonly algorithm = 'token-bucket';
  readonly limit: number;
  readonly windowMs: number;
  readonly refillPerSecond: number;
  readonly #capacityMilli: number;
  readonly #clock: Clock;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: TokenBucketOptions, clock: Clock) {
    assertPositiveInteger('capacity', options.capacity);
    assertPositiveInteger('refillPerSecond', options.refillPerSecond);
    this.limit = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.windowMs = Math.ceil((options.capacity * MILLI) / options.refillPerSecond);
    this.#capacityMilli = options.capacity * MILLI;
    this.#clock = clock;
  }

  consume(key: string, cost = 1): RateLimitResult {
    assertCost(cost, this.limit);
    const now = this.#clock.now();
    const rate = this.refillPerSecond; // milli-tokens per millisecond

    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { milliTokens: this.#capacityMilli, lastRefill: now };
      this.#buckets.set(key, bucket);
    }

    const wholeMs = Math.floor(now - bucket.lastRefill);
    if (wholeMs > 0) {
      bucket.lastRefill += wholeMs;
      bucket.milliTokens = Math.min(this.#capacityMilli, bucket.milliTokens + wholeMs * rate);
    }

    const costMilli = cost * MILLI;
    const allowed = bucket.milliTokens >= costMilli;
    if (allowed) bucket.milliTokens -= costMilli;

    const carried = now - bucket.lastRefill; // < 1 ms already earned towards the next refill
    const msUntil = (milli: number) =>
      milli <= 0 ? 0 : Math.max(0, Math.ceil(milli / rate) - carried);

    return {
      allowed,
      limit: this.limit,
      remaining: Math.floor(bucket.milliTokens / MILLI),
      resetMs: msUntil(this.#capacityMilli - bucket.milliTokens),
      retryAfterMs: allowed ? 0 : msUntil(costMilli - bucket.milliTokens),
    };
  }

  /** Exact bucket level in milli-tokens (for tests and inspection). */
  milliTokens(key: string): number | undefined {
    return this.#buckets.get(key)?.milliTokens;
  }
}
