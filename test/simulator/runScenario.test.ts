import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { runScenario, type ScenarioId } from '../../src/simulator/runScenario.js';

function countsByRow(scenario: ScenarioId): Record<string, { allowed: number; peak: number }> {
  const report = runScenario(scenario);
  return Object.fromEntries(
    report.rows.map((r) => [r.id, { allowed: r.allowedCount, peak: r.peakPerSecond }]),
  );
}

describe('runScenario', () => {
  it('boundary-burst: fixed window allows 20 (2x burst), sliding and token bucket allow 10', () => {
    expect(countsByRow('boundary-burst')).toEqual({
      'fixed-window': { allowed: 20, peak: 20 },
      'sliding-log': { allowed: 10, peak: 10 },
      'sliding-window-counter': { allowed: 10, peak: 10 },
      'token-bucket': { allowed: 10, peak: 10 },
    });
  });

  it('steady-traffic: throttles 24 requests spaced every 500 ms (2/s vs 1/s quota)', () => {
    expect(countsByRow('steady-traffic')).toEqual({
      'fixed-window': { allowed: 14, peak: 2 },
      'sliding-log': { allowed: 14, peak: 2 },
      'sliding-window-counter': { allowed: 11, peak: 2 },
      'token-bucket': { allowed: 21, peak: 2 },
    });
  });

  it('page-load-burst: strict 2/s windows allow 2 of 25; token bucket allows the 20-asset burst', () => {
    expect(countsByRow('page-load-burst')).toEqual({
      'fixed-window': { allowed: 2, peak: 2 },
      'sliding-log': { allowed: 2, peak: 2 },
      'sliding-window-counter': { allowed: 2, peak: 2 },
      'token-bucket': { allowed: 20, peak: 20 },
    });
  });

  it('spoofed-xff: naive key allows all 20 spoofed requests; resolved key caps at 10', () => {
    expect(countsByRow('spoofed-xff')).toEqual({
      'naive-key': { allowed: 20, peak: 10 },
      'resolved-key': { allowed: 10, peak: 10 },
    });
  });

  it('ipv6-rotation: naive /128 key allows all 20 rotated addresses; /64 key caps at 10', () => {
    expect(countsByRow('ipv6-rotation')).toEqual({
      'naive-key': { allowed: 20, peak: 10 },
      'resolved-key': { allowed: 10, peak: 10 },
    });
  });
});

describe('POST /api/simulate', () => {
  it('returns the deterministic scenario report for a named scenario', async () => {
    const app = createApp();
    const res = await app.request('/api/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'boundary-burst' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; rows: { id: string; allowedCount: number }[] };
    expect(body.id).toBe('boundary-burst');
    expect(body.rows.map((r) => [r.id, r.allowedCount])).toEqual([
      ['fixed-window', 20],
      ['sliding-log', 10],
      ['sliding-window-counter', 10],
      ['token-bucket', 10],
    ]);
  });

  it('replays a custom timeline across all four algorithms', async () => {
    const app = createApp();
    const res = await app.request('/api/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timeline: [0, 10, 20, 30, 40, 50],
        limit: 3,
        windowMs: 1_000,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; rows: { allowedCount: number }[] };
    expect(body.id).toBe('custom');
    expect(body.rows.every((r) => r.allowedCount === 3)).toBe(true);
  });

  it('returns 400 on unknown scenario or malformed payload', async () => {
    const app = createApp();
    const unknown = await app.request('/api/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'non-existent' }),
    });
    expect(unknown.status).toBe(400);

    const invalid = await app.request('/api/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(invalid.status).toBe(400);
  });
});
