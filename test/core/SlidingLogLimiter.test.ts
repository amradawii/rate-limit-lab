import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/Clock.js';
import { SlidingLogLimiter } from '../../src/core/SlidingLogLimiter.js';

function setup(limit = 10, windowMs = 10_000) {
  const clock = new ManualClock();
  return { clock, limiter: new SlidingLogLimiter({ limit, windowMs }, clock) };
}

function fire(limiter: SlidingLogLimiter, n: number, key = 'a'): number {
  let allowed = 0;
  for (let i = 0; i < n; i++) if (limiter.consume(key).allowed) allowed++;
  return allowed;
}

describe('SlidingLogLimiter', () => {
  it('allows up to the limit, then rejects with the time until the oldest entry expires', () => {
    const { clock, limiter } = setup();
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('a').allowed).toBe(true);
      clock.advance(100);
    }
    // Entries at 0, 100, ..., 900. Now = 1000. Oldest expires at 10 000.
    expect(limiter.consume('a')).toEqual({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetMs: 9_900,
      retryAfterMs: 9_000,
    });
  });

  it('prevents the window boundary burst (edge case #1)', () => {
    const { clock, limiter } = setup(100, 60_000);
    clock.set(59_000);
    const late = fire(limiter, 100);
    clock.set(60_000);
    const early = fire(limiter, 100);

    expect(late).toBe(100);
    expect(early).toBe(0);

    clock.set(118_999); // still inside the rolling window of the burst at 59 000
    expect(limiter.consume('a').allowed).toBe(false);
    clock.set(119_000);
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('never allows more than the limit in any rolling window, and rejects only when full', () => {
    const limit = 10;
    const windowMs = 1_000;
    const { clock, limiter } = setup(limit, windowMs);
    const allowedAt: number[] = [];

    // Deterministic irregular traffic: gaps of 0..149 ms over ~30 s.
    let seed = 42;
    for (let i = 0; i < 400; i++) {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      clock.advance(seed % 150);
      const now = clock.now();
      const inWindow = allowedAt.filter((t) => t > now - windowMs).length;
      const { allowed } = limiter.consume('a');
      if (allowed) allowedAt.push(now);
      // Exact: allowed if and only if the rolling window has room.
      expect(allowed).toBe(inWindow < limit);
    }

    for (const t of allowedAt) {
      const count = allowedAt.filter((u) => u > t - windowMs && u <= t).length;
      expect(count).toBeLessThanOrEqual(limit);
    }
  });

  it('prunes timestamps once they leave the window', () => {
    const { clock, limiter } = setup();
    fire(limiter, 10);
    expect(limiter.storedEntries()).toBe(10);

    clock.advance(10_000);
    limiter.consume('a');
    expect(limiter.storedEntries()).toBe(1);
  });

  it('caps memory per key at the limit, even under a flood (edge case #2)', () => {
    const { limiter } = setup(100, 60_000);
    fire(limiter, 10_000);
    expect(limiter.storedEntries()).toBe(100);
  });

  it('logs one entry per unit of cost', () => {
    const { limiter } = setup();
    expect(limiter.consume('a', 4).remaining).toBe(6);
    expect(limiter.consume('a', 7).allowed).toBe(false);
    expect(limiter.consume('a', 6).remaining).toBe(0);
  });
});
