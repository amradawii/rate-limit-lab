import type { KeyStoreOptions } from './KeyStore.js';

export interface RateLimitResult {
  allowed: boolean;
  /** Requests allowed per window (token bucket: bucket capacity). */
  limit: number;
  /** Units left right now, after this request was counted (if allowed). */
  remaining: number;
  /** Milliseconds until the quota is fully restored. */
  resetMs: number;
  /** Milliseconds until a request of the same cost could succeed. 0 when allowed. */
  retryAfterMs: number;
}

export interface RateLimiter {
  readonly algorithm: string;
  /** Requests per window (token bucket: capacity). */
  readonly limit: number;
  /** Window length in milliseconds (token bucket: time to refill from empty). */
  readonly windowMs: number;
  consume(key: string, cost?: number): RateLimitResult;
  /** Number of keys currently holding state. */
  trackedKeys(): number;
}

export interface WindowOptions {
  limit: number;
  windowMs: number;
  keys?: KeyStoreOptions;
}

export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

/** A cost larger than the limit could never succeed, so it is a programming error, not a 429. */
export function assertCost(cost: number, limit: number): void {
  assertPositiveInteger('cost', cost);
  if (cost > limit) throw new RangeError(`cost ${cost} exceeds limit ${limit}`);
}
