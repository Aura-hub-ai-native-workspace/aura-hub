/**
 * Redirects are not allowed to move inference somewhere else.
 *
 * ## Not the same thing as `net/ssrfGuard`
 *
 * That module is a DENY LIST: it refuses to talk to loopback, RFC1918 and
 * the other special-purpose ranges, because content AURA has read can talk
 * it into fetching a URL. Correct there, and exactly wrong here — a user
 * pointing AURA at Ollama on `127.0.0.1:11434` or `192.168.1.50:11434` is
 * the supported case, and the SSRF deny list would refuse both.
 *
 * This is a PIN instead: whatever destination the user configured is the
 * only one allowed, private or public. The two are complementary, and
 * neither replaces the other — hence the different name, so no future
 * caller reaches for whichever comes to hand.
 *
 * `fetch` follows redirects by default and says nothing about it. For a
 * self-hosted model server that is a real hole: AURA is pointed at an
 * address the user chose and trusts, and a 302 from that address — or from
 * anything able to answer in its place — would silently send the prompt,
 * and everything in it, to a different machine. The user would see a
 * working Hub and no indication that their code review is being read
 * somewhere they never configured.
 *
 * So redirects are handled manually and judged against the address the
 * user actually entered. A hop is allowed only when it lands on the same
 * protocol, the same host and the same port — which is to say, when it is
 * a path rewrite on the very server that was configured. Reverse proxies
 * do that routinely and legitimately. Everything else is refused, loudly,
 * and named for what it was.
 *
 * The comparison is always against the ORIGINAL destination, never the
 * previous hop, so a chain cannot walk away from where it started one
 * permissible-looking step at a time.
 */

export type RedirectRefusal =
  | 'cross-host'
  | 'cross-port'
  | 'downgrade'
  | 'protocol-change'
  | 'loop'
  | 'too-many'
  | 'no-location';

export class RedirectBlocked extends Error {
  readonly reason: RedirectRefusal;

  readonly from: string;

  readonly to: string;

  constructor(reason: RedirectRefusal, from: string, to: string, message: string) {
    super(message);
    this.name = 'RedirectBlocked';
    this.reason = reason;
    this.from = from;
    this.to = to;
  }
}

/** Port as the wire sees it: `URL.port` is empty for a scheme's default. */
function effectivePort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === 'https:' ? '443' : '80';
}

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Where a redirect wants to go, if it is allowed to go there.
 *
 * Throws `RedirectBlocked` otherwise. `origin` is the address the user
 * configured; `current` is only used to resolve a relative Location.
 */
export function assertSafeRedirect(origin: URL, current: URL, location: string): URL {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new RedirectBlocked('no-location', origin.toString(), location, `The server sent an unusable redirect target (${location}).`);
  }

  if (next.protocol !== origin.protocol) {
    if (origin.protocol === 'https:' && next.protocol === 'http:') {
      throw new RedirectBlocked('downgrade', origin.toString(), next.toString(),
        `The server tried to redirect from HTTPS to plain HTTP (${next.origin}). Refused — that would send prompts unencrypted.`);
    }
    throw new RedirectBlocked('protocol-change', origin.toString(), next.toString(),
      `The server tried to redirect to a different protocol (${next.protocol.replace(':', '')}). Refused.`);
  }

  if (next.hostname.toLowerCase() !== origin.hostname.toLowerCase()) {
    // Worth naming separately: a remote server pointing AURA back at the
    // user's own machine, or into their network, is the shape of an
    // attack rather than a misconfiguration.
    const inward = !isPrivateHost(origin.hostname) && isPrivateHost(next.hostname);
    throw new RedirectBlocked('cross-host', origin.toString(), next.toString(),
      inward
        ? `The server tried to redirect to a private address (${next.host}). Refused — a remote server must not redirect inference into your own network.`
        : `The server tried to redirect to a different host (${next.host}). Refused — inference stays on the server you configured.`);
  }

  if (effectivePort(next) !== effectivePort(origin)) {
    throw new RedirectBlocked('cross-port', origin.toString(), next.toString(),
      `The server tried to redirect to a different port (${next.host}). Refused — inference stays on the server you configured.`);
  }

  return next;
}

/**
 * `fetch`, with redirects judged rather than obeyed.
 *
 * Identical to `fetch` for any response that is not a 3xx, so the calling
 * code is unchanged for every ordinary request. A permitted hop is
 * followed by hand; a refused one throws `RedirectBlocked`.
 */
export async function pinnedFetch(
  url: string,
  init: RequestInit = {},
  maxHops = 3,
): Promise<Response> {
  const origin = new URL(url);
  let current = origin;
  const seen = new Set<string>([current.toString()]);

  for (let hop = 0; hop <= maxHops; hop += 1) {
    const res = await fetch(current.toString(), { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return res;

    const location = res.headers.get('location');
    if (!location) {
      throw new RedirectBlocked('no-location', origin.toString(), '',
        `The server answered ${res.status} without saying where to go. Refused.`);
    }
    const next = assertSafeRedirect(origin, current, location);
    if (seen.has(next.toString())) {
      throw new RedirectBlocked('loop', origin.toString(), next.toString(),
        `The server redirected in a loop (${next.pathname}). Refused.`);
    }
    seen.add(next.toString());
    current = next;
  }

  throw new RedirectBlocked('too-many', origin.toString(), current.toString(),
    `The server redirected more than ${maxHops} times. Refused.`);
}
