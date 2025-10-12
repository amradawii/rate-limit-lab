import { ManualClock } from '../core/Clock.js';
import { FixedWindowLimiter } from '../core/FixedWindowLimiter.js';
import type { RateLimiter } from '../core/RateLimiter.js';
import { SlidingLogLimiter } from '../core/SlidingLogLimiter.js';
import { SlidingWindowCounterLimiter } from '../core/SlidingWindowCounterLimiter.js';
import { TokenBucketLimiter } from '../core/TokenBucketLimiter.js';
import { createClientKeyResolver, resolveNaiveClientKey } from '../http/clientKey.js';

export type ScenarioId =
  | 'boundary-burst'
  | 'steady-traffic'
  | 'page-load-burst'
  | 'spoofed-xff'
  | 'ipv6-rotation';

export interface SimulatedEvent {
  index: number;
  atMs: number;
  key: string;
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface SimulatedRow {
  id: string;
  label: string;
  note: string;
  total: number;
  allowedCount: number;
  rejectedCount: number;
  peakPerSecond: number;
  events: SimulatedEvent[];
}

export interface ScenarioReport {
  id: ScenarioId | 'custom';
  title: string;
  kind: 'algorithm' | 'key';
  policySummary: string;
  problem: string;
  solution: string;
  rows: SimulatedRow[];
}

interface ScenarioRequest {
  atMs: number;
  remoteAddress: string;
  xForwardedFor?: string;
}

export function computePeakPerSecond(events: readonly SimulatedEvent[]): number {
  const allowedTimes = events.filter((e) => e.allowed).map((e) => e.atMs);
  let peak = 0;
  for (let i = 0; i < allowedTimes.length; i++) {
    const start = allowedTimes[i]!;
    let count = 0;
    for (let j = i; j < allowedTimes.length && allowedTimes[j]! < start + 1_000; j++) {
      count++;
    }
    if (count > peak) peak = count;
  }
  return peak;
}

function replayRow(
  id: string,
  label: string,
  note: string,
  requests: readonly ScenarioRequest[],
  makeLimiter: (clock: ManualClock) => RateLimiter,
  keyFn: (req: ScenarioRequest) => string,
): SimulatedRow {
  const firstAt = requests[0]?.atMs ?? 0;
  const clock = new ManualClock(firstAt);
  const limiter = makeLimiter(clock);
  const events: SimulatedEvent[] = [];
  let allowedCount = 0;

  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]!;
    clock.set(req.atMs);
    const key = keyFn(req);
    const res = limiter.consume(key);
    if (res.allowed) allowedCount++;
    events.push({
      index: i,
      atMs: req.atMs,
      key,
      allowed: res.allowed,
      remaining: res.remaining,
      retryAfterMs: Math.ceil(res.retryAfterMs),
    });
  }

  return {
    id,
    label,
    note,
    total: requests.length,
    allowedCount,
    rejectedCount: requests.length - allowedCount,
    peakPerSecond: computePeakPerSecond(events),
    events,
  };
}

function buildFourAlgorithmRows(
  requests: readonly ScenarioRequest[],
  options: { limit: number; windowMs: number; bucketCapacity: number; refillPerSecond: number },
): SimulatedRow[] {
  const { limit, windowMs, bucketCapacity, refillPerSecond } = options;
  const keyFn = (r: ScenarioRequest) => r.remoteAddress;
  return [
    replayRow(
      'fixed-window',
      'Fixed window',
      `${limit} / ${windowMs / 1_000}s counter`,
      requests,
      (clock) => new FixedWindowLimiter({ limit, windowMs }, clock),
      keyFn,
    ),
    replayRow(
      'sliding-log',
      'Sliding log',
      `Exact ${windowMs / 1_000}s rolling log`,
      requests,
      (clock) => new SlidingLogLimiter({ limit, windowMs }, clock),
      keyFn,
    ),
    replayRow(
      'sliding-window-counter',
      'Sliding window counter',
      'Weighted previous + current window',
      requests,
      (clock) => new SlidingWindowCounterLimiter({ limit, windowMs }, clock),
      keyFn,
    ),
    replayRow(
      'token-bucket',
      'Token bucket',
      `Capacity ${bucketCapacity}, refill ${refillPerSecond}/s`,
      requests,
      (clock) => new TokenBucketLimiter({ capacity: bucketCapacity, refillPerSecond }, clock),
      keyFn,
    ),
  ];
}

export const SCENARIO_IDS: readonly ScenarioId[] = [
  'boundary-burst',
  'steady-traffic',
  'page-load-burst',
  'spoofed-xff',
  'ipv6-rotation',
];

export function runScenario(scenario: ScenarioId): ScenarioReport {
  switch (scenario) {
    case 'boundary-burst': {
      const requests: ScenarioRequest[] = [
        ...Array.from({ length: 10 }, (_, i) => ({
          atMs: 9_500 + i * 50,
          remoteAddress: '198.51.100.7',
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          atMs: 10_000 + i * 50,
          remoteAddress: '198.51.100.7',
        })),
      ];
      return {
        id: 'boundary-burst',
        title: 'Boundary burst',
        kind: 'algorithm',
        policySummary: '10 requests per 10 s window · 20 requests fired between 9.50 s and 10.45 s',
        problem:
          'A fixed-window counter resets on the clock boundary. Sending 10 requests at 09.5 s and 10 more at 10.0 s lets all 20 pass inside one second—twice the configured rate.',
        solution:
          'Sliding log and sliding window counter look back across the boundary, and a token bucket drained at 09.95 s has not refilled by 10.0 s, so all three block the second half of the burst.',
        rows: buildFourAlgorithmRows(requests, {
          limit: 10,
          windowMs: 10_000,
          bucketCapacity: 10,
          refillPerSecond: 1,
        }),
      };
    }

    case 'steady-traffic': {
      const requests: ScenarioRequest[] = Array.from({ length: 24 }, (_, i) => ({
        atMs: i * 500,
        remoteAddress: '198.51.100.7',
      }));
      return {
        id: 'steady-traffic',
        title: 'Steady traffic',
        kind: 'algorithm',
        policySummary: '10 requests per 10 s (1/s average) · 24 requests spaced every 500 ms (2/s)',
        problem:
          'When a client sends steady traffic at twice the sustained rate (2 req/s against a 1 req/s quota), each algorithm paces requests differently once the initial quota is spent.',
        solution:
          'Window limiters pass the first 10 requests and pause until the 10 s window advances; the token bucket spends its initial 10-token reserve while simultaneously refilling 1 token/s.',
        rows: buildFourAlgorithmRows(requests, {
          limit: 10,
          windowMs: 10_000,
          bucketCapacity: 10,
          refillPerSecond: 1,
        }),
      };
    }

    case 'page-load-burst': {
      const requests: ScenarioRequest[] = [
        ...Array.from({ length: 20 }, (_, i) => ({
          atMs: i * 5,
          remoteAddress: '198.51.100.7',
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          atMs: 200 + i * 5,
          remoteAddress: '198.51.100.7',
        })),
      ];
      return {
        id: 'page-load-burst',
        title: 'Page load burst',
        kind: 'algorithm',
        policySummary:
          '2 req/s average rate · 20 parallel page assets at 0 ms, then 5 extra at 200 ms',
        problem:
          'Enforcing a 2 req/s average with a strict 1-second window (limit 2 per 1 s) rejects 18 of the 20 requests a browser fires when loading a page, even if the user stays idle afterwards.',
        solution:
          'A token bucket separates burst capacity (20 tokens) from refill rate (2 tokens/s): all 20 page assets pass immediately, while the 5 extra requests 200 ms later are rejected.',
        rows: buildFourAlgorithmRows(requests, {
          limit: 2,
          windowMs: 1_000,
          bucketCapacity: 20,
          refillPerSecond: 2,
        }),
      };
    }

    case 'spoofed-xff': {
      const requests: ScenarioRequest[] = Array.from({ length: 20 }, (_, i) => ({
        atMs: i * 100,
        remoteAddress: '198.51.100.7',
        xForwardedFor: `203.0.113.${i + 1}`,
      }));
      const hardenedResolve = createClientKeyResolver({ trustedProxies: ['10.0.0.1'] });
      return {
        id: 'spoofed-xff',
        title: 'Spoofed X-Forwarded-For',
        kind: 'key',
        policySummary:
          'Fixed window 10 / 10 s · 20 requests from 198.51.100.7 rotating X-Forwarded-For',
        problem:
          'If the server trusts X-Forwarded-For from any peer, a client connecting directly can send a new fake IP on every request and get a fresh quota each time.',
        solution:
          'Only parse X-Forwarded-For when the immediate socket peer is in the trusted proxy list, and pick the right-most non-trusted hop so client-prepended values are ignored.',
        rows: [
          replayRow(
            'naive-key',
            'Naive key (trusts X-Forwarded-For)',
            'Uses left-most XFF hop from any peer',
            requests,
            (clock) => new FixedWindowLimiter({ limit: 10, windowMs: 10_000 }, clock),
            (req) => resolveNaiveClientKey(req),
          ),
          replayRow(
            'resolved-key',
            'Resolved key (trusted proxies only)',
            'Ignores XFF from untrusted peer 198.51.100.7',
            requests,
            (clock) => new FixedWindowLimiter({ limit: 10, windowMs: 10_000 }, clock),
            (req) => hardenedResolve(req),
          ),
        ],
      };
    }

    case 'ipv6-rotation': {
      const requests: ScenarioRequest[] = Array.from({ length: 20 }, (_, i) => ({
        atMs: i * 100,
        remoteAddress: `2001:db8:abcd:42::${(i + 1).toString(16)}`,
      }));
      const hardenedResolve = createClientKeyResolver();
      return {
        id: 'ipv6-rotation',
        title: 'IPv6 rotation',
        kind: 'key',
        policySummary:
          'Fixed window 10 / 10 s · 20 requests rotating /128 addresses inside 2001:db8:abcd:42::/64',
        problem:
          'ISPs hand a single home or mobile subscriber an entire IPv6 /64 subnet (2^64 addresses). Keying rate limits by exact /128 address lets one client rotate addresses per request.',
        solution:
          'Normalise IPv6 client addresses to their /64 network prefix (2001:db8:abcd:42::/64) so every address inside the subscriber allocation shares one bucket.',
        rows: [
          replayRow(
            'naive-key',
            'Naive key (exact IPv6 /128)',
            'Each /128 host address gets its own bucket',
            requests,
            (clock) => new FixedWindowLimiter({ limit: 10, windowMs: 10_000 }, clock),
            (req) => resolveNaiveClientKey(req),
          ),
          replayRow(
            'resolved-key',
            'Resolved key (IPv6 /64 prefix)',
            'All /128 hosts map to 2001:db8:abcd:42::/64',
            requests,
            (clock) => new FixedWindowLimiter({ limit: 10, windowMs: 10_000 }, clock),
            (req) => hardenedResolve(req),
          ),
        ],
      };
    }
  }
}

export interface CustomSimulationInput {
  timeline: readonly number[];
  limit?: number;
  windowMs?: number;
}

export function runCustomTimeline(input: CustomSimulationInput): ScenarioReport {
  const limit = input.limit ?? 10;
  const windowMs = input.windowMs ?? 10_000;
  const sorted = [...input.timeline].sort((a, b) => a - b);
  const requests: ScenarioRequest[] = sorted.map((atMs) => ({
    atMs,
    remoteAddress: '198.51.100.7',
  }));
  const refillPerSecond = Math.max(1, Math.round((limit * 1_000) / windowMs));

  return {
    id: 'custom',
    title: 'Custom timeline',
    kind: 'algorithm',
    policySummary: `${limit} requests per ${windowMs / 1_000} s · ${requests.length} custom events`,
    problem: 'Custom request timestamps replayed deterministically against all four algorithms.',
    solution: 'Each limiter receives the exact same timestamps on an isolated ManualClock.',
    rows: buildFourAlgorithmRows(requests, {
      limit,
      windowMs,
      bucketCapacity: limit,
      refillPerSecond,
    }),
  };
}
