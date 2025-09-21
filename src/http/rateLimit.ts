import type { Context, MiddlewareHandler } from 'hono';
import type { RateLimiter } from '../core/RateLimiter.js';

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiter;
  /** Policy identifier for the structured IETF RateLimit headers. Default "default". */
  policyName?: string;
  /** Extracts the client key from the request context. */
  keyResolver?: (c: Context) => string;
}

/**
 * Hono middleware enforcing a RateLimiter and emitting IETF structured headers
 * per draft-ietf-httpapi-ratelimit-headers-09 (edge case #7):
 *
 *   RateLimit-Policy: "default";q=10;w=10
 *   RateLimit: "default";r=9;t=10
 *
 * On 429 Too Many Requests, also sets `Retry-After` (delta-seconds, rounded up to at least 1)
 * and returns a JSON body with retry details so clients can back off instead of hammering.
 */
export function rateLimit(options: RateLimitMiddlewareOptions): MiddlewareHandler {
  const { limiter, policyName = 'default', keyResolver = () => 'anonymous' } = options;
  const windowSeconds = Math.max(1, Math.ceil(limiter.windowMs / 1_000));
  const policyHeader = `"${policyName}";q=${limiter.limit};w=${windowSeconds}`;

  return async (c, next) => {
    const key = keyResolver(c);
    const result = limiter.consume(key);
    const resetSeconds = Math.max(0, Math.ceil(result.resetMs / 1_000));

    c.header('RateLimit-Policy', policyHeader);
    c.header('RateLimit', `"${policyName}";r=${result.remaining};t=${resetSeconds}`);

    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json(
        {
          error: 'rate_limit_exceeded',
          algorithm: limiter.algorithm,
          limit: result.limit,
          remaining: result.remaining,
          resetMs: Math.ceil(result.resetMs),
          retryAfterMs: Math.ceil(result.retryAfterMs),
          retryAfterSeconds,
        },
        429,
      );
    }

    await next();
  };
}
