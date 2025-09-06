import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/Clock.js';
import { TokenBucketLimiter } from '../../src/core/TokenBucketLimiter.js';

function setup(capacity = 10, refillPerSecond = 1) {
  const clock = new ManualClock();
  return { clock, limiter: new TokenBucketLimiter({ capacity, refillPerSecond }, clock) };
}

function fire(limiter: TokenBucketLimiter, n: number, key = 'a'): number {
  let allowed = 0;
  for (let i = 0; i < n; i++) if (limiter.consume(key).allowed) allowed++;
  return allowed;
}

describe('TokenBucketLimiter', () => {
  it('allows a burst up to capacity at once (edge case #3)', () => {
    const { limiter } = setup(20, 2);
    expect(fire(limiter, 20)).toBe(20); // a page loading 20 assets
    expect(limiter.consume('a')).toMatchObject({ allowed: false, remaining: 0 });
  });

  it('enforces the average rate over time', () => {
    const { clock, limiter } = setup(10, 5);
    let allowed = 0;
    for (let t = 0; t < 60_000; t += 10) {
      clock.set(t); // 100 requests per second, 20x the rate
      if (limiter.consume('a').allowed) allowed++;
    }
    // Initial burst of 10, then 5 per second: the last call is at 59 990 ms, which has earned
    // 299.95 tokens, so exactly 10 + 299 requests pass.
    expect(allowed).toBe(10 + 299);
  });

  it('refills partially and exactly', () => {
    const { clock, limiter } = setup(10, 1);
    fire(limiter, 10);
    clock.advance(1_500);
    expect(limiter.milliTokens('a')).toBe(0); // not refilled until the next call
    const result = limiter.consume('a');
    expect(result).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.milliTokens('a')).toBe(500);

    const rejected = limiter.consume('a');
    expect(rejected.retryAfterMs).toBe(500);
    expect(rejected.resetMs).toBe(9_500);
  });

  it('carries sub-millisecond time forward instead of losing it', () => {
    const { clock, limiter } = setup(10, 1);
    fire(limiter, 10);
    for (let i = 0; i < 8; i++) {
      clock.advance(0.25);
      limiter.consume('a'); // each call sees less than 1 ms
    }
    expect(limiter.milliTokens('a')).toBe(2); // 2 ms elapsed, 1 milli-token per ms
  });

  it('has no drift after 1 million calls with fractional clock steps', () => {
    const { clock, limiter } = setup(10, 3);
    let allowed = limiter.consume('a').allowed ? 1 : 0; // bucket created at t = 0
    for (let i = 0; i < 1_000_000; i++) {
      clock.advance(0.25); // exactly representable, so the clock itself is exact
      if (limiter.consume('a').allowed) allowed++;
    }
    // 250 s at 3 tokens per second on top of the initial 10: exactly 760, nothing lost or gained.
    expect(allowed).toBe(10 + 3 * 250);
    expect(Number.isInteger(limiter.milliTokens('a'))).toBe(true);
  });

  it('charges cost in tokens', () => {
    const { clock, limiter } = setup(10, 1);
    expect(limiter.consume('a', 7).remaining).toBe(3);
    const rejected = limiter.consume('a', 5);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBe(2_000);
    clock.advance(2_000);
    expect(limiter.consume('a', 5)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('never fills above capacity after a long idle period', () => {
    const { clock, limiter } = setup(10, 1);
    fire(limiter, 10);
    clock.advance(3_600_000);
    expect(fire(limiter, 15)).toBe(10);
  });

  it('exposes the time to refill from empty as its window', () => {
    expect(setup(10, 1).limiter.windowMs).toBe(10_000);
    expect(setup(10, 4).limiter.windowMs).toBe(2_500);
  });
});
