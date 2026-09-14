/**
 * What kind of place is this address, as far as the URL alone can say.
 *
 * Purely informational, and deliberately so: it tells a user typing an
 * address whether AURA read it as their own machine, something on their
 * network, or a server somewhere else — which is the difference between
 * "I mistyped the port" and "I mistyped the host". It decides nothing.
 * Reachability and whether an Ollama actually lives there are settled by
 * verification, not by this.
 *
 * It also refuses to overclaim. A hostname is not a location: `gpu-07`
 * could be the machine under the desk or a box in another country, and
 * DNS is not consulted here. Those are reported as unknown rather than
 * guessed, and an unknown classification never blocks anything.
 */
export type ConnectionKind = 'this-machine' | 'lan' | 'remote' | 'unknown' | 'invalid';

export interface DetectedConnection {
  kind: ConnectionKind;
  /** One line, shown under the address field. */
  label: string;
}

/** 127.0.0.0/8 — the whole loopback range, not just 127.0.0.1. */
function isLoopbackV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return false;
  return parts[0] === 127;
}

function isPrivateV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  if (m.slice(1).map(Number).some((n) => n > 255)) return false;
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 169 && b === 254) return true;          // link-local, still "on the network"
  return false;
}

function isPublicV4(host: string): boolean {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)
    && host.split('.').every((n) => Number(n) <= 255)
    && !isLoopbackV4(host) && !isPrivateV4(host);
}

export function detectConnection(raw: string): DetectedConnection {
  const value = (raw ?? '').trim();
  if (!value) return { kind: 'unknown', label: 'Enter the address of the machine where Ollama is running.' };

  // Mirror the normaliser: a bare host:port is a normal thing to paste.
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { kind: 'invalid', label: 'Enter a valid HTTP or HTTPS URL.' };
  }
  if (!url.hostname) return { kind: 'invalid', label: 'Enter a valid HTTP or HTTPS URL.' };

  // URL keeps IPv6 literals in brackets; compare without them.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || isLoopbackV4(host)) {
    return { kind: 'this-machine', label: 'This machine · Local Ollama' };
  }
  // Unique-local (fc00::/7) and link-local (fe80::/10) IPv6.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || isPrivateV4(host)) {
    return { kind: 'lan', label: 'Another machine · LAN server' };
  }
  if (isPublicV4(host)) {
    return { kind: 'remote', label: 'Remote server · public address' };
  }
  if (host.includes(':')) {
    // Any other IPv6 literal is globally routable.
    return { kind: 'remote', label: 'Remote server · public address' };
  }
  if (url.protocol === 'https:') {
    return { kind: 'remote', label: 'Remote server · HTTPS endpoint' };
  }
  // A plain hostname over http. It could be anything; say so rather than
  // inventing a location from a name.
  return { kind: 'unknown', label: 'Server location will be confirmed during verification' };
}
