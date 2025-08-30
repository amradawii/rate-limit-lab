import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/Clock.js';
import { SlidingWindowCounterLimiter } from '../../src/core/SlidingWindowCounterLimiter.js';

function setup(limit = 10, windowMs = 10_000) {
  const clock = new ManualClock();
  return { clock, limiter: new SlidingWindowCounterLimiter({ limit, windowMs }, clock) };
}

function fire(limiter: SlidingWindowCounterLimiter, n: number, key = 'a'): number {
  let allowed = 0;
  for (let i = 0; i < n; i++) if (limiter.consume(key).allowed) allowed++;
  return allowed;
}

function maxInRollingWindow(times: number[], windowMs: number): number {
  let max = 0;
  for (const t of times) {
    max = Math.max(max, times.filter((u) => u > t - windowMs && u <= t).length);
  }
  return max;
}

describe('SlidingWindowCounterLimiter', () => {
  it('behaves like a plain counter inside the first window', () => {
    const { limiter } = setup();
    expect(fire(limiter, 15)).toBe(10);
    expect(limiter.consume('a')).toMatchObject({ allowed: false, remaining: 0 });
  });

  it('weights the previous window by the time left in the current one', () => {
    const { clock, limiter } = setup();
    fire(limiter, 10); // previous window full
    clock.set(15_000); // halfway through the next window: estimate = 10 × 0.5 = 5
    expect(fire(limiter, 10)).toBe(5);

    const rejected = limiter.consume('a');
    expect(rejected.allowed).toBe(false);
    // Room for 1 more once previous × left / W <= 10 - 5 - 1 = 4, i.e. left <= 4 000 ms.
    expect(rejected.retryAfterMs).toBe(1_000);
    clock.advance(999);
    expect(limiter.consume('a').allowed).toBe(false);
    clock.advance(1);
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('forgets everything after two idle windows', () => {
    const { clock, limiter } = setup();
    fire(limiter, 10);
    clock.set(20_000);
    expect(fire(limiter, 15)).toBe(10);
  });

  it('mostly prevents the window boundary burst (edge case #1)', () => {
    const { clock, limiter } = setup(100, 60_000);
    clock.set(59_000);
    const late = fire(limiter, 100);

    // Try 100 more spread over the first second of the next window.
    let early = 0;
    for (let i = 0; i < 100; i++) {
      clock.set(60_000 + i * 10);
      if (limiter.consume('a').allowed) early++;
    }

    expect(late).toBe(100);
    expect(early).toBeLessThanOrEqual(2); // fixed window: 100
  });

  it('stays close to the limit with evenly spread traffic', () => {
    const limit = 100;
    const windowMs = 10_000;
    const { clock, limiter } = setup(limit, windowMs);
    const allowedAt: number[] = [];
    for (let t = 0; t < 60_000; t += 25) {
      clock.set(t); // 4× the allowed rate
      if (limiter.consume('a').allowed) allowedAt.push(t);
    }
    const max = maxInRollingWindow(allowedAt, windowMs);
    expect(max).toBeGreaterThanOrEqual(limit * 0.95);
    expect(max).toBeLessThanOrEqual(limit * 1.05);
  });

  it('DOCUMENTED BOUND: adversarial timing can approach, but not reach, 2x the limit', () => {
    const limit = 100;
    const windowMs = 60_000;
    const { clock, limiter } = setup(limit, windowMs);
    const allowedAt: number[] = [];

    clock.set(59_999); // whole previous window packed into its last millisecond
    for (let i = 0; i < limit; i++) if (limiter.consume('a').allowed) allowedAt.push(59_999);
    for (let t = 60_000; t < 120_000; t += 100) {
      clock.set(t); // then spread across the current window
      if (limiter.consume('a').allowed) allowedAt.push(t);
    }

    const max = maxInRollingWindow(allowedAt, windowMs);
    expect(max).toBeGreaterThan(limit * 1.9);
    expect(max).toBeLessThan(limit * 2);
  });

  it('uses constant memory per key, whatever the traffic (edge case #2)', () => {
    const { limiter } = setup(100, 60_000);
    fire(limiter, 10_000);
    expect(limiter.storedEntries()).toBe(2);
  });
});
