import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/core/Clock.js';
import { createApp } from '../../src/http/app.js';
import {
  createClientKeyResolver,
  ipToClientKey,
  normalizeIp,
  resolveNaiveClientKey,
} from '../../src/http/clientKey.js';

describe('clientKey', () => {
  it('ignores spoofed X-Forwarded-For when the direct peer is untrusted (edge case #5)', () => {
    const resolve = createClientKeyResolver({ trustedProxies: ['10.0.0.1'] });

    // Attacker connects directly (not through 10.0.0.1) and rotates X-Forwarded-For on every call.
    const keys = new Set(
      ['1.1.1.1', '2.2.2.2', '3.3.3.3'].map((spoofed) =>
        resolve({ remoteAddress: '198.51.100.7', xForwardedFor: spoofed }),
      ),
    );
    expect([...keys]).toEqual(['198.51.100.7']);
  });

  it('picks the right-most untrusted hop behind a chain of trusted proxies (edge case #5)', () => {
    const resolve = createClientKeyResolver({
      trustedProxies: ['10.0.0.1', '10.0.0.2'],
    });

    // Client 198.51.100.7 sends spoofed "203.0.113.99" to proxy 10.0.0.2 -> proxy 10.0.0.1.
    // X-Forwarded-For arrives as: "203.0.113.99, 198.51.100.7, 10.0.0.2" from peer 10.0.0.1.
    const key = resolve({
      remoteAddress: '10.0.0.1',
      xForwardedFor: '203.0.113.99, 198.51.100.7, 10.0.0.2',
    });
    expect(key).toBe('198.51.100.7');
  });

  it('stops walking X-Forwarded-For if an untrusted hop injects a malformed entry', () => {
    const resolve = createClientKeyResolver({ trustedProxies: ['10.0.0.1'] });

    const key = resolve({
      remoteAddress: '10.0.0.1',
      xForwardedFor: '1.2.3.4, not-an-ip',
    });
    expect(key).toBe('10.0.0.1');
  });

  it('groups all IPv6 addresses inside the same /64 prefix into one key (edge case #6)', () => {
    const resolve = createClientKeyResolver();

    const rotated = [
      '2001:db8:abcd:0042::1',
      '2001:0db8:abcd:42:dead:beef:cafe:1234',
      '2001:db8:abcd:42:ffff:ffff:ffff:ffff',
    ].map((remoteAddress) => resolve({ remoteAddress }));

    expect(new Set(rotated).size).toBe(1);
    expect(rotated[0]).toBe('2001:db8:abcd:42::/64');

    // A different /64 subnet gets a different key.
    expect(resolve({ remoteAddress: '2001:db8:abcd:43::1' })).toBe('2001:db8:abcd:43::/64');
  });

  it('normalises IPv4-mapped IPv6 addresses for both proxy matching and client keys', () => {
    const resolve = createClientKeyResolver({ trustedProxies: ['10.0.0.1'] });

    // Dual-stack socket reports peer 10.0.0.1 as ::ffff:10.0.0.1 and client as ::ffff:198.51.100.7.
    const key = resolve({
      remoteAddress: '::ffff:10.0.0.1',
      xForwardedFor: '::ffff:198.51.100.7',
    });
    expect(key).toBe('198.51.100.7');
    expect(normalizeIp('0:0:0:0:0:ffff:c633:6407')).toBe('198.51.100.7');
    expect(ipToClientKey('0:0:0:0:0:ffff:c633:6407')).toBe('198.51.100.7');
  });

  it('contrasts naive resolution with hardened resolution', () => {
    expect(
      resolveNaiveClientKey({
        remoteAddress: '198.51.100.7',
        xForwardedFor: '1.1.1.1, 198.51.100.7',
      }),
    ).toBe('1.1.1.1');
    expect(resolveNaiveClientKey({ remoteAddress: '2001:db8:abcd:42::99' })).toBe(
      '2001:db8:abcd:42::99',
    );
  });

  it('rejects invalid trusted proxy configuration', () => {
    expect(() => createClientKeyResolver({ trustedProxies: ['not-an-ip'] })).toThrow(RangeError);
  });

  it('enforces a shared limit across IPv6 /64 rotation and spoofed XFF in the HTTP app', async () => {
    const clock = new ManualClock();
    const app = createApp({ clock, trustedProxies: ['10.0.0.1'] });

    // 10 requests rotating across different /128 addresses inside one /64 and spoofing XFF.
    for (let i = 1; i <= 10; i++) {
      const res = await app.request(
        '/api/limited/fixed-window',
        { headers: { 'x-forwarded-for': `203.0.113.${i}, 2001:db8:1:2::${i.toString(16)}` } },
        { incoming: { socket: { remoteAddress: '::ffff:10.0.0.1' } } },
      );
      expect(res.status).toBe(200);
    }

    // 11th request with yet another /128 in the same /64 and another spoofed XFF is blocked.
    const blocked = await app.request(
      '/api/limited/fixed-window',
      { headers: { 'x-forwarded-for': '192.0.2.99, 2001:db8:1:2:cafe::beef' } },
      { incoming: { socket: { remoteAddress: '::ffff:10.0.0.1' } } },
    );
    expect(blocked.status).toBe(429);
  });
});
