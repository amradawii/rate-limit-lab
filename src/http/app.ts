import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { MonotonicClock, type Clock } from '../core/Clock.js';
import { FixedWindowLimiter } from '../core/FixedWindowLimiter.js';
import type { RateLimiter } from '../core/RateLimiter.js';
import { SlidingLogLimiter } from '../core/SlidingLogLimiter.js';
import { SlidingWindowCounterLimiter } from '../core/SlidingWindowCounterLimiter.js';
import { TokenBucketLimiter } from '../core/TokenBucketLimiter.js';
import {
  runCustomTimeline,
  runScenario,
  SCENARIO_IDS,
  type ScenarioId,
} from '../simulator/runScenario.js';
import { createHonoKeyResolver, type ClientKeyOptions } from './clientKey.js';
import { rateLimit } from './rateLimit.js';

export type AlgorithmName =
  | 'fixed-window'
  | 'sliding-log'
  | 'sliding-window-counter'
  | 'token-bucket';

export interface AppOptions extends ClientKeyOptions {
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

function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === 'string' && (SCENARIO_IDS as readonly string[]).includes(value);
}

export function createApp(options: AppOptions = {}): Hono {
  const clock = options.clock ?? new MonotonicClock();
  const keyResolver =
    options.keyResolver ??
    createHonoKeyResolver(
      options.trustedProxies !== undefined ? { trustedProxies: options.trustedProxies } : {},
    );
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

  app.post('/api/simulate', async (c) => {
    let body: {
      scenario?: unknown;
      timeline?: unknown;
      limit?: unknown;
      windowMs?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    if (body.scenario !== undefined) {
      if (!isScenarioId(body.scenario)) {
        return c.json({ error: 'unknown_scenario', scenario: body.scenario }, 400);
      }
      return c.json(runScenario(body.scenario));
    }

    if (
      Array.isArray(body.timeline) &&
      body.timeline.length > 0 &&
      body.timeline.length <= 500 &&
      body.timeline.every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0)
    ) {
      const limit = typeof body.limit === 'number' ? body.limit : undefined;
      const windowMs = typeof body.windowMs === 'number' ? body.windowMs : undefined;
      try {
        return c.json(
          runCustomTimeline({
            timeline: body.timeline as number[],
            ...(limit !== undefined ? { limit } : {}),
            ...(windowMs !== undefined ? { windowMs } : {}),
          }),
        );
      } catch (err) {
        return c.json(
          { error: 'invalid_parameters', message: err instanceof Error ? err.message : 'invalid' },
          400,
        );
      }
    }

    return c.json({ error: 'missing_scenario_or_timeline' }, 400);
  });

  app.use('/*', serveStatic({ root: './dist/public' }));

  return app;
}
