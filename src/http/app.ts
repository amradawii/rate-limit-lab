import { Hono, type Context } from 'hono';
import { MonotonicClock, type Clock } from '../core/Clock.js';
import { FixedWindowLimiter } from '../core/FixedWindowLimiter.js';
import type { RateLimiter } from '../core/RateLimiter.js';
import { SlidingLogLimiter } from '../core/SlidingLogLimiter.js';
import { SlidingWindowCounterLimiter } from '../core/SlidingWindowCounterLimiter.js';
import { TokenBucketLimiter } from '../core/TokenBucketLimiter.js';
import { rateLimit } from './rateLimit.js';

export type AlgorithmName =
  | 'fixed-window'
  | 'sliding-log'
  | 'sliding-window-counter'
  | 'token-bucket';

export interface AppOptions {
  clock?: Clock;
  keyResolver?: (c: Context) => string;
}

export function createDefaultLimiters(clock: Clock): Record<AlgorithmName, RateLimiter> {
  return {
    'fixed-window': new FixedWindowLimiter({ limit: 10, windowMs: 10_000 }, clock),
    'sliding-log': new SlidingLogLimiter({ limit: 10, windowMs: 10_000 }, clock),
    'sliding-window-counter': new SlidingWindowCounterLimiter(
      { limit: 10, windowMs: 10_000 },
      clock,
    ),
    'token-bucket': new TokenBucketLimiter({ capacity: 10, refillPerSecond: 1 }, clock),
  };
}

export function createApp(options: AppOptions = {}): Hono {
  const clock = options.clock ?? new MonotonicClock();
  const keyResolver = options.keyResolver ?? (() => 'local');
  const limiters = createDefaultLimiters(clock);
  const middlewares = new Map<AlgorithmName, ReturnType<typeof rateLimit>>();

  for (const [name, limiter] of Object.entries(limiters) as [AlgorithmName, RateLimiter][]) {
    middlewares.set(name, rateLimit({ limiter, keyResolver }));
  }

  const app = new Hono();

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  app.get(
    '/api/limited/:algorithm',
    async (c, next) => {
      const name = c.req.param('algorithm') as AlgorithmName;
      const mw = middlewares.get(name);
      if (!mw) {
        return c.json({ error: 'unknown_algorithm', algorithm: name }, 404);
      }
      return mw(c, next);
    },
    (c) => {
      const algorithm = c.req.param('algorithm');
      return c.json({ ok: true, algorithm });
    },
  );

  return app;
}
