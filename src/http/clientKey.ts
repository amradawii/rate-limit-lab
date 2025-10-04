import { isIP } from 'node:net';
import type { Context } from 'hono';

export interface ClientKeyOptions {
  /** Direct or upstream proxy IPs that are trusted to append to `X-Forwarded-For`. */
  trustedProxies?: Iterable<string>;
}

export interface RequestAddressInfo {
  /** Immediate TCP peer address from the socket. */
  remoteAddress: string;
  /** Raw `X-Forwarded-For` header, if sent. */
  xForwardedFor?: string | undefined;
}

function cleanIpToken(raw: string): string {
  let token = raw.trim();
  if (token.startsWith('[') && token.includes(']')) {
    token = token.slice(1, token.indexOf(']'));
  }
  const zoneIndex = token.indexOf('%');
  if (zoneIndex !== -1) {
    token = token.slice(0, zoneIndex);
  }
  return token;
}

/** Parses an IPv6 address into 8 16-bit words, handling `::` and embedded IPv4 suffixes. */
function parseIpv6Words(ip: string): number[] | undefined {
  let working = ip.toLowerCase();

  // Convert trailing embedded IPv4 (e.g. ::ffff:192.0.2.1) into two 16-bit hex words.
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const v4Part = working.slice(lastColon + 1);
    if (isIP(v4Part) !== 4) return undefined;
    const octets = v4Part.split('.').map(Number);
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    working = `${working.slice(0, lastColon)}:${high}:${low}`;
  }

  const doubleColonParts = working.split('::');
  if (doubleColonParts.length > 2) return undefined;

  const parseSide = (side: string): number[] =>
    side === '' ? [] : side.split(':').map((g) => Number.parseInt(g, 16));

  let words: number[];
  if (doubleColonParts.length === 2) {
    const left = parseSide(doubleColonParts[0]!);
    const right = parseSide(doubleColonParts[1]!);
    const missing = 8 - left.length - right.length;
    if (missing < 1) return undefined;
    words = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    words = parseSide(working);
    if (words.length !== 8) return undefined;
  }

  if (words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return undefined;
  return words;
}

/**
 * Normalises an IP into a canonical host address for exact proxy comparison:
 * - IPv4 and IPv4-mapped IPv6 (`::ffff:a.b.c.d`) -> `a.b.c.d`
 * - IPv6 -> 8 lowercase hex words (`2001:db8:0:0:0:0:0:1`)
 * Returns `undefined` if `raw` is not a valid IP.
 */
export function normalizeIp(raw: string): string | undefined {
  const token = cleanIpToken(raw);
  const version = isIP(token);
  if (version === 4) {
    return token.split('.').map(Number).join('.');
  }
  if (version === 6) {
    const words = parseIpv6Words(token);
    if (!words) return undefined;
    // IPv4-mapped IPv6: 0:0:0:0:0:ffff:w6:w7
    if (
      words[0] === 0 &&
      words[1] === 0 &&
      words[2] === 0 &&
      words[3] === 0 &&
      words[4] === 0 &&
      words[5] === 0xffff
    ) {
      const a = (words[6]! >> 8) & 0xff;
      const b = words[6]! & 0xff;
      const c = (words[7]! >> 8) & 0xff;
      const d = words[7]! & 0xff;
      return `${a}.${b}.${c}.${d}`;
    }
    return words.map((w) => w.toString(16)).join(':');
  }
  return undefined;
}

/**
 * Converts a client IP into a rate-limit bucket key:
 * - IPv4 (including IPv4-mapped IPv6) -> `a.b.c.d`
 * - IPv6 -> `/64` network prefix (`w0:w1:w2:w3::/64`) so rotating host addresses inside a
 *   single `/64` allocation shares one limit (edge case #6).
 */
export function ipToClientKey(raw: string): string {
  const token = cleanIpToken(raw);
  const version = isIP(token);
  if (version === 4) {
    return token.split('.').map(Number).join('.');
  }
  if (version === 6) {
    const words = parseIpv6Words(token);
    if (!words) return 'invalid-ip';
    if (
      words[0] === 0 &&
      words[1] === 0 &&
      words[2] === 0 &&
      words[3] === 0 &&
      words[4] === 0 &&
      words[5] === 0xffff
    ) {
      const a = (words[6]! >> 8) & 0xff;
      const b = words[6]! & 0xff;
      const c = (words[7]! >> 8) & 0xff;
      const d = words[7]! & 0xff;
      return `${a}.${b}.${c}.${d}`;
    }
    return `${words
      .slice(0, 4)
      .map((w) => w.toString(16))
      .join(':')}::/64`;
  }
  return 'invalid-ip';
}

/**
 * Resolves the rate-limit key for a request (edge cases #5 and #6):
 * 1. Only trusts `X-Forwarded-For` when the immediate socket peer is in `trustedProxies`.
 * 2. Walks `X-Forwarded-For` right-to-left and picks the right-most non-trusted hop.
 * 3. Groups IPv6 addresses by `/64` and normalises IPv4-mapped IPv6 to IPv4.
 */
export function createClientKeyResolver(
  options: ClientKeyOptions = {},
): (req: RequestAddressInfo) => string {
  const trusted = new Set<string>();
  for (const proxy of options.trustedProxies ?? []) {
    const norm = normalizeIp(proxy);
    if (!norm) throw new RangeError(`Invalid trusted proxy IP: ${proxy}`);
    trusted.add(norm);
  }

  return ({ remoteAddress, xForwardedFor }) => {
    const peerNorm = normalizeIp(remoteAddress);
    if (!peerNorm) return 'invalid-ip';

    let chosenRaw = remoteAddress;
    if (trusted.has(peerNorm) && xForwardedFor) {
      const hops = xForwardedFor
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h.length > 0);

      for (let i = hops.length - 1; i >= 0; i--) {
        const hop = hops[i]!;
        const hopNorm = normalizeIp(hop);
        if (!hopNorm) break; // Stop walking if an untrusted client injected garbage.
        chosenRaw = hop;
        if (!trusted.has(hopNorm)) break;
      }
    }

    return ipToClientKey(chosenRaw);
  };
}

/**
 * Naive key resolver used by the simulator to contrast with `createClientKeyResolver`:
 * blindly trusts the left-most `X-Forwarded-For` entry and uses exact IPv6 addresses.
 */
export function resolveNaiveClientKey({
  remoteAddress,
  xForwardedFor,
}: RequestAddressInfo): string {
  if (xForwardedFor) {
    const first = xForwardedFor.split(',')[0]?.trim();
    if (first) return cleanIpToken(first).toLowerCase();
  }
  return cleanIpToken(remoteAddress).toLowerCase();
}

/** Adapts a `RequestAddressInfo` resolver to a Hono context. */
export function createHonoKeyResolver(options: ClientKeyOptions = {}): (c: Context) => string {
  const resolve = createClientKeyResolver(options);
  return (c) => {
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming;
    const remoteAddress = incoming?.socket?.remoteAddress ?? '127.0.0.1';
    return resolve({
      remoteAddress,
      xForwardedFor: c.req.header('x-forwarded-for'),
    });
  };
}
