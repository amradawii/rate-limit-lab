import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/Clock.js';
import { createApp } from '../../src/http/app.js';

function setup() {
  const clock = new ManualClock();
  const app = createApp({
    clock,
    keyResolver: (c) => c.req.header('x-test-client') ?? 'default-client',
  });
  return { clock, app };
}

describe('GET /api/limited/:algorithm', () => {
  it('sets draft-09 RateLimit-Policy and RateLimit headers on allowed requests (edge case #7)', async () => {
    const { clock, app } = setup();
    clock.set(2_500);

    const res = await app.request('/api/limited/fixed-window');
    expect(res.status).toBe(200);
    expect(res.headers.get('RateLimit-Policy')).toBe('"default";q=10;w=10');
    expect(res.headers.get('RateLimit')).toBe('"default";r=9;t=8');
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(await res.json()).toEqual({ ok: true, algorithm: 'fixed-window' });
  });

  it('returns 429 with Retry-After and JSON details when the limit is exceeded', async () => {
    const { clock, app } = setup();
    clock.set(3_200);

    for (let i = 0; i < 10; i++) {
      const ok = await app.request('/api/limited/fixed-window');
      expect(ok.status).toBe(200);
    }

    const blocked = await app.request('/api/limited/fixed-window');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('RateLimit-Policy')).toBe('"default";q=10;w=10');
    expect(blocked.headers.get('RateLimit')).toBe('"default";r=0;t=7');
    expect(blocked.headers.get('Retry-After')).toBe('7');
    expect(await blocked.json()).toEqual({
      error: 'rate_limit_exceeded',
      algorithm: 'fixed-window',
      limit: 10,
      remaining: 0,
      resetMs: 6_800,
      retryAfterMs: 6_800,
      retryAfterSeconds: 7,
    });
  });

  it('supports all four algorithms and isolates state per algorithm and client', async () => {
    const { app } = setup();
    const algorithms = [
      'fixed-window',
      'sliding-log',
      'sliding-window-counter',
      'token-bucket',
    ] as const;

    for (const alg of algorithms) {
      const res = await app.request(`/api/limited/${alg}`, {
        headers: { 'x-test-client': 'alice' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('RateLimit')).toMatch(/^"default";r=9;t=\d+$/);
    }

    // Exhaust fixed-window for alice; bob and other algorithms remain available.
    for (let i = 0; i < 9; i++) {
      await app.request('/api/limited/fixed-window', { headers: { 'x-test-client': 'alice' } });
    }
    const aliceBlocked = await app.request('/api/limited/fixed-window', {
      headers: { 'x-test-client': 'alice' },
    });
    expect(aliceBlocked.status).toBe(429);

    const bobAllowed = await app.request('/api/limited/fixed-window', {
      headers: { 'x-test-client': 'bob' },
    });
    expect(bobAllowed.status).toBe(200);

    const aliceOtherAlg = await app.request('/api/limited/token-bucket', {
      headers: { 'x-test-client': 'alice' },
    });
    expect(aliceOtherAlg.status).toBe(200);
  });

  it('returns 404 for an unknown algorithm', async () => {
    const { app } = setup();
    const res = await app.request('/api/limited/leaky-bucket');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'unknown_algorithm' });
  });
});
