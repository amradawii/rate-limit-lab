import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await createApp().request('/api/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
