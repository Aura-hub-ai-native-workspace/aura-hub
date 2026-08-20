/**
 * The SSRF guard - a resolver-level deny list for outbound HTTP.
 * ==================================================================
 * `workflow/nodes.ts` carried a comment arguing that an IP deny list
 * "would be solving a threat model that doesn't apply", because AURA is a
 * single-user local desktop app with no multi-tenant boundary.
 *
 * That reasoning is right about tenancy and wrong about the threat. The
 * attacker here is not another tenant; it is the CONTENT. AURA reads web
 * pages, tool output and repository files, and a model that has just read
 * an attacker-authored page can be induced to request a URL. When that
 * URL is `http://169.254.169.254/latest/meta-data/iam/...` the response
 * is cloud credentials; when it is `http://127.0.0.1:4319/...` it is
 * AURA's own unauthenticated local API. Neither needs a second tenant to
 * be a problem - it needs one persuasive paragraph in a README.
 *
 * The deny list is therefore about what a URL may RESOLVE TO, not about
 * who is asking.
 *
 * -- What this actually stops -----------------------------------------
 *   Direct requests to loopback, link-local, RFC1918 and the other
 *   special-purpose ranges, in IPv4 and IPv6, by literal or by name.
 *
 *   REDIRECTS to any of the above. This is the part a naive check misses:
 *   `fetch` follows redirects by default, so a perfectly public URL can
 *   answer 302 and land on the metadata service. `guardedFetch` follows
 *   redirects manually and re-checks every hop.
 *
 * -- What it does not stop, stated plainly -----------------------------
 *   DNS rebinding. The name is resolved and checked, and then Node's
 *   `fetch` resolves it again when it connects. A name that answers
 *   public on the first lookup and private on the second slips through
 *   that window. Closing it properly needs a custom connector that dials
 *   the address this module already validated, which is an undici-level
 *   change; it is named here rather than papered over, because a guard
 *   whose limits are undocumented gets trusted for things it does not do.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

export class BlockedAddressError extends Error {
  readonly code = 'BLOCKED_ADDRESS' as const;
  constructor(readonly host: string, readonly address: string, readonly range: string) {
    super(`${host} resolves to ${address}, which is in the ${range} range. AURA does not make outbound requests to addresses on this machine or on the local network — that is how a page AURA read talks it into reading a cloud metadata service or AURA's own API.`);
    this.name = 'BlockedAddressError';
  }
}

interface Range {
  name: string;
  matches(address: string): boolean;
}

const v4 = (address: string): number[] | null => {
  if (net.isIPv4(address) !== true) return null;
  return address.split('.').map((n) => Number(n));
};

/**
 * IPv4 special-purpose ranges. Every one of these is either this
 * machine, this network, or a magic address with a documented meaning
 * that is never a legitimate target for an agent's HTTP request.
 */
const V4_RANGES: Range[] = [
  { name: 'loopback (127.0.0.0/8)', matches: (a) => v4(a)?.[0] === 127 },
  { name: 'this-network (0.0.0.0/8)', matches: (a) => v4(a)?.[0] === 0 },
  { name: 'private (10.0.0.0/8)', matches: (a) => v4(a)?.[0] === 10 },
  { name: 'carrier-grade NAT (100.64.0.0/10)', matches: (a) => { const o = v4(a); return !!o && o[0] === 100 && o[1] >= 64 && o[1] <= 127; } },
  { name: 'private (172.16.0.0/12)', matches: (a) => { const o = v4(a); return !!o && o[0] === 172 && o[1] >= 16 && o[1] <= 31; } },
  { name: 'private (192.168.0.0/16)', matches: (a) => { const o = v4(a); return !!o && o[0] === 192 && o[1] === 168; } },
  { name: 'link-local, including cloud metadata (169.254.0.0/16)', matches: (a) => { const o = v4(a); return !!o && o[0] === 169 && o[1] === 254; } },
  { name: 'benchmarking (198.18.0.0/15)', matches: (a) => { const o = v4(a); return !!o && o[0] === 198 && (o[1] === 18 || o[1] === 19); } },
  { name: 'multicast (224.0.0.0/4)', matches: (a) => { const o = v4(a); return !!o && o[0] >= 224 && o[0] <= 239; } },
  { name: 'reserved (240.0.0.0/4)', matches: (a) => { const o = v4(a); return !!o && o[0] >= 240; } },
];

/** IPv6, including the mapped and translated forms of the ranges above. */
function v6Range(address: string): string | null {
  if (net.isIPv6(address) !== true) return null;
  const a = address.toLowerCase().split('%')[0];
  if (a === '::1') return 'IPv6 loopback (::1)';
  if (a === '::') return 'IPv6 unspecified (::)';
  if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return 'IPv6 link-local (fe80::/10)';
  if (a.startsWith('fc') || a.startsWith('fd')) return 'IPv6 unique-local (fc00::/7)';
  if (a.startsWith('ff')) return 'IPv6 multicast (ff00::/8)';
  /* ::ffff:127.0.0.1 and 64:ff9b::/96 carry a v4 address inside a v6 one.
     Checking the embedded address is not pedantry: it is the standard way
     a v4 deny list is bypassed. */
  const embedded = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const hit = V4_RANGES.find((r) => r.matches(embedded[1]));
    if (hit) return `IPv4-in-IPv6 ${hit.name}`;
  }
  return null;
}

/** The range this address falls in, or null when it is a fine target. */
export function blockedRange(address: string): string | null {
  const v4hit = V4_RANGES.find((r) => r.matches(address));
  if (v4hit) return v4hit.name;
  return v6Range(address);
}

/**
 * Resolve a URL's host and refuse it if ANY address it resolves to is on
 * the deny list.
 *
 * Any, not all: a name with one public and one loopback address is a name
 * whose connection could go either way, and "it worked the first time" is
 * not a security property.
 */
export async function assertResolvableAndAllowed(url: string): Promise<{ host: string; addresses: string[] }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are allowed; "${parsed.protocol}" is not.`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  /* A literal address needs no resolver, and must not get one: looking up
     "127.0.0.1" would be a no-op that reads like a check. */
  if (net.isIP(host)) {
    const range = blockedRange(host);
    if (range) throw new BlockedAddressError(host, host, range);
    return { host, addresses: [host] };
  }

  let records: { address: string }[];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`${host} could not be resolved: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  if (records.length === 0) throw new Error(`${host} resolved to no addresses.`);
  for (const r of records) {
    const range = blockedRange(r.address);
    if (range) throw new BlockedAddressError(host, r.address, range);
  }
  return { host, addresses: records.map((r) => r.address) };
}

export interface GuardedFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Redirect hops to follow. Each one is re-checked. */
  maxRedirects?: number;
}

/**
 * `fetch`, with every hop checked.
 *
 * Redirects are followed MANUALLY. That is the whole reason this wrapper
 * exists rather than a single check before a normal `fetch`: with
 * automatic redirects, checking the first URL proves nothing about where
 * the request ends up, and a 302 to the metadata service is one line in
 * an attacker's response.
 */
export async function guardedFetch(url: string, opts: GuardedFetchOptions = {}): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertResolvableAndAllowed(current);
    const res = await fetch(current, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: opts.signal,
      redirect: 'manual',
    });
    if (res.status < 300 || res.status > 399) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    const next = new URL(location, current).toString();
    if (hop === maxRedirects) {
      throw new Error(`${url} redirected more than ${maxRedirects} times; the chain was not followed further.`);
    }
    current = next;
  }
  /* Unreachable: the loop either returns or throws. Present so the
     function has no implicit undefined path. */
  throw new Error(`${url} could not be fetched.`);
}
