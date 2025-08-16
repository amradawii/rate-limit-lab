import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualClock, MonotonicClock } from '../../src/core/Clock.js';

describe('MonotonicClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not affected when the wall clock jumps (edge case #4)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const clock = new MonotonicClock();

    vi.setSystemTime(new Date('2025-08-16T12:00:00Z'));
    const before = clock.now();

    // NTP correction / manual change: wall clock jumps one hour back, then one day forward.
    vi.setSystemTime(new Date('2025-08-16T11:00:00Z'));
    const afterBackJump = clock.now();
    vi.setSystemTime(new Date('2025-08-17T12:00:00Z'));
    const afterForwardJump = clock.now();

    expect(afterBackJump).toBeGreaterThanOrEqual(before);
    expect(afterForwardJump - before).toBeLessThan(1_000);
  });
});

describe('ManualClock', () => {
  it('only moves when advanced', () => {
    const clock = new ManualClock(100);
    expect(clock.now()).toBe(100);
    clock.advance(50);
    expect(clock.now()).toBe(150);
    clock.set(1_000);
    expect(clock.now()).toBe(1_000);
  });

  it('refuses to go backwards', () => {
    const clock = new ManualClock(100);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.set(99)).toThrow(RangeError);
  });
});
