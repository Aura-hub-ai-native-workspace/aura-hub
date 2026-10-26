/**
 * Instance ownership for the Node AI service. The same contract as the
 * Python backend (backend/aura/api/instance_guard.py): a backend proves it was
 * launched by the desktop instance that is connecting, and refuses requests
 * that do not carry the launch token.
 *
 *  - `GET /instance/proof?challenge=<c>` → HMAC-SHA256(token, "aura-instance-proof:" + c)
 *  - every other path except `/health` requires `x-aura-instance-token`.
 *
 * Without a configured token the guard is inert (a developer running the
 * service by hand). The desktop shell never accepts such a service, because
 * it cannot prove ownership of one it did not launch.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOKEN_ENV = 'AURA_INSTANCE_TOKEN';
export const TOKEN_HEADER = 'x-aura-instance-token';
export const PROOF_PATH = '/instance/proof';
/** Headers a browser may send to this service. The token header must be
 * allowed here, or every request carrying it fails its CORS preflight. */
export const CORS_ALLOW_HEADERS = `content-type, ${TOKEN_HEADER}`;
const OPEN_PATHS = new Set(['/health', PROOF_PATH]);
const CHALLENGE = /^[A-Za-z0-9]{16,128}$/;
const PROOF_PREFIX = 'aura-instance-proof:';

export function configuredToken(env: NodeJS.ProcessEnv = process.env): string {
  return (env[TOKEN_ENV] ?? '').trim();
}

export function proofFor(token: string, challenge: string): string {
  return createHmac('sha256', token).update(PROOF_PREFIX + challenge).digest('hex');
}

export function tokenMatches(presented: string | string[] | undefined, token: string): boolean {
  if (!token || typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type GuardDecision =
  | { kind: 'open' }
  | { kind: 'proof'; status: number; body: Record<string, unknown> }
  | { kind: 'refused'; status: 401; body: Record<string, unknown> };

/** Decide what to do with one request before any route sees it. */
export function decide(
  method: string,
  pathname: string,
  headers: Record<string, string | string[] | undefined>,
  token: string,
  challenge: string | null,
): GuardDecision {
  if (pathname === PROOF_PATH) {
    if (method !== 'GET' || challenge === null || !CHALLENGE.test(challenge)) {
      return { kind: 'proof', status: 400, body: { error: 'a challenge of 16-128 letters and digits is required' } };
    }
    return { kind: 'proof', status: 200, body: { backend: 'node', proof: token ? proofFor(token, challenge) : null } };
  }
  if (!token || method === 'OPTIONS' || OPEN_PATHS.has(pathname)) return { kind: 'open' };
  if (tokenMatches(headers[TOKEN_HEADER], token)) return { kind: 'open' };
  return {
    kind: 'refused',
    status: 401,
    body: {
      error: 'instance-token-required',
      message: 'This backend did not present the token of the instance it belongs to. The request was refused.',
    },
  };
}
