import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/Clock.js';
import { FixedWindowLimiter } from '../../src/core/FixedWindowLimiter.js';
import { KeyStore } from '../../src/core/KeyStore.js';
import type { RateLimiter } from '../../src/core/RateLimiter.js';
import { SlidingLogLimiter } from '../../src/core/SlidingLogLimiter.js';
import { SlidingWindowCounterLimiter } from '../../src/core/SlidingWindowCounterLimiter.js';
import { TokenBucketLimiter } from '../../src/core/TokenBucketLimiter.js';

interface Entry {
  expiresAt: number;
}

function setup(maxKeys = 3, sweepIntervalMs = 100) {
  const clock = new ManualClock();
  const store = new KeyStore<Entry>(clock, (e, now) => e.expiresAt <= now, {
    maxKeys,
    sweepIntervalMs,
  });
  const add = (key: string, expiresAt: number) => store.getOrCreate(key, () => ({ expiresAt }));
  return { clock, store, add };
}

describe('KeyStore', () => {
  it('evicts an idle key only after its state has expired', () => {
    const { clock, store, add } = setup(10, 1);
    add('a', 1_000);

    clock.set(999);
    add('b', 5_000); // sweep due, but 'a' has not expired yet
    expect(store.has('a')).toBe(true);

    clock.set(1_000);
    add('b', 5_000);
    expect(store.has('a')).toBe(false);
    expect(store.size).toBe(1);
  });

  it('enforces the size cap under key rotation (edge case #8)', () => {
    const { store, add } = setup(3);
    for (let i = 0; i < 10_000; i++) add(`attacker-${i}`, Infinity);
    expect(store.size).toBe(3);
  });

  it('evicts expired keys before falling back to least recently used', () => {
    const { clock, store, add } = setup(3);
    add('a', 10_000); // least recently used, still active
    add('b', 50); // more recent, but expires soon
    add('c', 10_000);

    clock.set(100); // sweep due
    add('d', 10_000);

    expect(store.has('a')).toBe(true);
    expect(store.has('b')).toBe(false);
    expect(store.size).toBe(3);
  });

  it('evicts the least recently used key when nothing has expired', () => {
    const { store, add } = setup(3);
    add('a', Infinity);
    add('b', Infinity);
    add('c', Infinity);
    add('a', Infinity); // touch: 'b' is now the least recently used
    add('d', Infinity);

    expect(['a', 'b', 'c', 'd'].filter((k) => store.has(k))).toEqual(['a', 'c', 'd']);
  });

  it('keeps an active key while a flood of new keys passes through', () => {
    const { store, add } = setup(3);
    for (let i = 0; i < 1_000; i++) {
      add('active-user', Infinity);
      add(`attacker-${i}`, Infinity);
    }
    expect(store.has('active-user')).toBe(true);
  });

  it('sweeps at most once per interval', () => {
    const { clock, store, add } = setup(10, 100);
    add('a', 10);
    clock.set(50);
    add('b', 1_000);
    expect(store.has('a')).toBe(true); // expired, but no sweep due yet
    clock.set(100);
    add('b', 1_000);
    expect(store.has('a')).toBe(false);
  });

  it('peek does not change recency', () => {
    const { store, add } = setup(2);
    add('a', Infinity);
    add('b', Infinity);
    store.peek('a');
    add('c', Infinity);
    expect(store.has('a')).toBe(false);
  });
});

describe('limiters forget a key exactly when its state is fully restored', () => {
  const keys = { maxKeys: 100, sweepIntervalMs: 1 };
  const cases: [string, (c: ManualClock) => RateLimiter, number][] = [
    ['fixed window', (c) => new FixedWindowLimiter({ limit: 5, windowMs: 1_000, keys }, c), 1_000],
    ['sliding log', (c) => new SlidingLogLimiter({ limit: 5, windowMs: 1_000, keys }, c), 1_000],
    // The current window's count still weighs on the next window.
    [
      'sliding window counter',
      (c) => new SlidingWindowCounterLimiter({ limit: 5, windowMs: 1_000, keys }, c),
      2_000,
    ],
    // 1 token used, refilled at 5 per second.
    [
      'token bucket',
      (c) => new TokenBucketLimiter({ capacity: 5, refillPerSecond: 5, keys }, c),
      200,
    ],
  ];

  it.each(cases)('%s', (_name, create, expiresAt) => {
    const clock = new ManualClock();
    const limiter = create(clock);
    limiter.consume('a');

    clock.set(expiresAt - 1);
    limiter.consume('probe');
    expect(limiter.trackedKeys()).toBe(2);

    clock.set(expiresAt);
    limiter.consume('probe');
    expect(limiter.trackedKeys()).toBe(1);
    expect(limiter.consume('a').remaining).toBe(4); // a fresh key: same result as before eviction
  });
});
