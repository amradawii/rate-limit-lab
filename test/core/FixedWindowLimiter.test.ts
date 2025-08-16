import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/Clock.js';
import { FixedWindowLimiter } from '../../src/core/FixedWindowLimiter.js';

function setup(limit = 10, windowMs = 10_000) {
  const clock = new ManualClock();
  return { clock, limiter: new FixedWindowLimiter({ limit, windowMs }, clock) };
}

function fire(limiter: FixedWindowLimiter, n: number, key = 'a'): number {
  let allowed = 0;
  for (let i = 0; i < n; i++) if (limiter.consume(key).allowed) allowed++;
  return allowed;
}

describe('FixedWindowLimiter', () => {
  it('allows up to the limit inside one window, then rejects', () => {
    const { limiter } = setup();
    expect(fire(limiter, 10)).toBe(10);

    const rejected = limiter.consume('a');
    expect(rejected).toEqual({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetMs: 10_000,
      retryAfterMs: 10_000,
    });
  });

  it('reports remaining and time to reset', () => {
    const { clock, limiter } = setup();
    clock.advance(2_500);
    const result = limiter.consume('a', 3);
    expect(result).toMatchObject({ allowed: true, remaining: 7, resetMs: 7_500, retryAfterMs: 0 });
  });

  it('resets exactly at the window boundary', () => {
    const { clock, limiter } = setup();
    fire(limiter, 10);
    clock.set(9_999);
    expect(limiter.consume('a').allowed).toBe(false);
    clock.set(10_000);
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('keeps keys independent', () => {
    const { limiter } = setup();
    fire(limiter, 10, 'a');
    expect(limiter.consume('b').allowed).toBe(true);
  });

  it('does not count rejected requests', () => {
    const { clock, limiter } = setup();
    fire(limiter, 25);
    clock.set(10_000);
    expect(limiter.consume('a').remaining).toBe(9);
  });

  it('KNOWN WEAKNESS: lets 2x the limit through around a window boundary (edge case #1)', () => {
    const { clock, limiter } = setup(100, 60_000);
    clock.set(59_000); // 00:59
    const late = fire(limiter, 100);
    clock.set(60_000); // 01:00
    const early = fire(limiter, 100);

    expect(late + early).toBe(200); // 200 requests in one second with a "100 per minute" limit
  });

  it('rejects invalid configuration and costs', () => {
    const clock = new ManualClock();
    expect(() => new FixedWindowLimiter({ limit: 0, windowMs: 1_000 }, clock)).toThrow(RangeError);
    expect(() => new FixedWindowLimiter({ limit: 1, windowMs: 1.5 }, clock)).toThrow(RangeError);
    const { limiter } = setup();
    expect(() => limiter.consume('a', 0)).toThrow(RangeError);
    expect(() => limiter.consume('a', 11)).toThrow(RangeError);
  });
});
