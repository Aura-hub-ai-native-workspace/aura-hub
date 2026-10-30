/**
 * Destination policy for http.request (F-20), the Node twin of
 * backend/aura/executors/http_policy.py.
 *
 * Autonomous agents may read from loopback and private-network services (a
 * local model server is a supported setup) but may not change them: only GET
 * and HEAD reach those destinations. GET and HEAD are not claimed to be
 * side-effect free; they are the narrowest methods that keep read access.
 *
 * The check runs on the address actually connected to, so a name that
 * resolves to a private address, a mixed DNS answer, a rebinding answer or a
 * redirect cannot get around a check done on the URL text. Redirects are
 * followed by hand, and every hop is checked again.
 *
 * An explicitly user-initiated request (actor kind "human") is not limited
 * here. A missing or unknown actor is treated as autonomous.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const SAFE_METHODS = new Set(['GET', 'HEAD']);
const MAX_REDIRECTS = 5;

export class DestinationRefused extends Error {}

export function isAutonomous(actor: unknown): boolean {
  return !(typeof actor === 'object' && actor !== null && (actor as { kind?: unknown }).kind === 'human');
}

/** Cloud instance-metadata addresses. Refused for every actor. */
const METADATA = new Set(['169.254.169.254', '100.100.100.200', 'fd00:ec2::254']);

const NON_PUBLIC = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_PUBLIC.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  NON_PUBLIC.addSubnet(net6, prefix, 'ipv6');
}

/** Reduce an IPv4-mapped IPv6 address (either spelling) to its IPv4 form. */
function normalise(address: string): string {
  const bare = address.split('%')[0].toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return bare;
}

export function isMetadata(address: string): boolean {
  return METADATA.has(normalise(address));
}

export function isNonPublic(address: string): boolean {
  const ip = normalise(address);
  const family = net.isIP(ip);
  if (family === 0) return true; // not an address we can judge: treat as non-public
  return NON_PUBLIC.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export function checkAddress(address: string, method: string, autonomous: boolean): void {
  if (isMetadata(address)) throw new DestinationRefused('That address serves cloud instance metadata, so it is refused.');
  if (autonomous && isNonPublic(address) && !SAFE_METHODS.has(method.toUpperCase())) {
    throw new DestinationRefused(
      `An autonomous request may only use GET or HEAD against a local or private address; ${method.toUpperCase()} to ${address} was refused.`,
    );
  }
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) =>
  (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

export interface PolicedResponse { status: number; statusText: string; body: Buffer }

interface Options {
  method: string;
  body?: string;
  autonomous: boolean;
  signal: AbortSignal;
  maxBytes: number;
  resolve?: Resolver;
}

/** One request, no redirect handling; the connection goes to the checked address. */
async function once(url: URL, o: Options): Promise<PolicedResponse & { location?: string }> {
  const resolve = o.resolve ?? systemResolver;
  // Node does not call `lookup` for a literal address, so judge it here.
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) checkAddress(literal, o.method, o.autonomous);
  const lookup = (host: string, _opts: unknown, cb: (...a: unknown[]) => void) => {
    const wantAll = typeof _opts === 'object' && _opts !== null && (_opts as { all?: boolean }).all === true;
    resolve(host.replace(/^\[|\]$/g, '')).then((addresses) => {
      if (addresses.length === 0) throw new Error(`${host} did not resolve`);
      // Judge every answer before connecting to any.
      for (const a of addresses) checkAddress(a, o.method, o.autonomous);
      const family = (a: string) => (net.isIP(normalise(a)) === 6 ? 6 : 4);
      if (wantAll) cb(null, addresses.map((address) => ({ address, family: family(address) })));
      else cb(null, addresses[0], family(addresses[0]));
    }).catch((err) => cb(err));
  };
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolvePromise, reject) => {
    const req = lib.request(url, { method: o.method, lookup: lookup as never, signal: o.signal, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        if (size < o.maxBytes) { chunks.push(c); size += c.length; }
      });
      res.on('end', () => resolvePromise({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? '',
        body: Buffer.concat(chunks).subarray(0, o.maxBytes),
        location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** Make the request, following redirects by hand so each hop is checked. */
export async function policedRequest(urlText: string, o: Options): Promise<PolicedResponse> {
  let url = new URL(urlText);
  let { method, body } = o;
  for (let hop = 0; ; hop++) {
    const res = await once(url, { ...o, method, body });
    const redirect = [301, 302, 303, 307, 308].includes(res.status) && res.location;
    if (!redirect) return res;
    if (hop >= MAX_REDIRECTS) throw new DestinationRefused('Too many redirects.');
    const next = new URL(res.location as string, url);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new DestinationRefused('A redirect to a non-http(s) address was refused.');
    }
    // As fetch does: 303, and 301/302 after a POST, continue as a body-less GET.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      if (method !== 'HEAD') method = 'GET';
      body = undefined;
    }
    url = next;
  }
}
