/**
 * Agent Workspace v2 — AURA Private Search Gateway client.
 * =====================================================================
 * The typed UI-side handle to the privacy-controlled intermediary the
 * spec names (spec §7). Its job in this phase is narrow, and the code
 * enforces it:
 *
 *   1.  `probe()`   — asks the backend whether a gateway route exists.
 *                     Reports `GATEWAY_NOT_IMPLEMENTED` when it does
 *                     not. NEVER fabricates `ready`: the renderer has
 *                     no server route table to read, so only an
 *                     explicit backend `ready` frame can flip state.
 *
 *   2.  `search()`  — typed, returns the GATEWAY_NOT_IMPLEMENTED
 *                     reason in this phase. It is deliberately not a
 *                     fetch: a client-side fetch from this UI would
 *                     bypass the very redaction pipeline that is the
 *                     point of the gateway, so we refuse to do that
 *                     rather than ship a fake integration.
 *
 * What it is NOT:
 *   • Not a web crawler. The spec explicitly forbids a new crawler when
 *     one exists — here none is wired to public web, so there is
 *     nothing to reuse, and we say so.
 *   • Not a replacement for the private Tailscale model link. Public
 *     egress (when implemented) must live on a distinct backend route;
 *     this file touches no networking at all.
 *
 * The toggle state in the composer is UI-local. The moment the user
 * toggles it, the label says so — and the probe reports the truth
 * about whether the backend would honor it.
 */
import type { GatewayProbe, PrivateSearchGateway } from './types';

/**
 * Base URL — same resolution rule as the Central Agent client. This
 * client is a SEPARATE probe, so it resolves its own `BASE` instead of
 * importing from `centralAgentClient` (keeps the two seams independent;
 * a future gateway host can differ without touching the agent's).
 */
function gatewayBase(): string {
  const ENV = import.meta.env as unknown as Record<string, string | undefined>;
  if (ENV.VITE_AGENT_GW_URL) return ENV.VITE_AGENT_GW_URL.replace(/\/$/, '');
  // No separate public-web base is configured by default; the probe
  // will 404 or be refused, and we read that as NOT_IMPLEMENTED —
  // the honest reading of "no route for this yet".
  return ENV.VITE_AGENT_URL
    ? ENV.VITE_AGENT_URL.replace(/\/$/, '')
    : (import.meta.env.DEV ? '/agent-api' : 'http://127.0.0.1:4320');
}

const PROBE_TIMEOUT_MS = 2500;

async function doProbe(signal?: AbortSignal): Promise<GatewayProbe> {
  // `search/gateway` is the route the spec names. If the backend
  // hasn't added it, either:
  //   • 404 / 405 — no such route today  → NOT_IMPLEMENTED
  //   • fetch throws (network / CORS)   → also NOT_IMPLEMENTED — we
  //     must not report 'ready' on ambiguity, and a missing endpoint
  //     on the renderer's base is the same contract-level fact here.
  const base = gatewayBase();
  try {
    const res = await fetch(`${base}/search/gateway`, {
      method: 'GET',
      mode: 'cors',
      redirect: 'manual',
      signal,
      cache: 'no-store',
    });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as {
        ready?: boolean;
        endpoint?: string;
      } | null;
      if (body && body.ready === true) {
        return { state: 'ready', endpoint: body.endpoint ?? '' };
      }
      return { state: 'unavailable', reason: 'GATEWAY_NOT_IMPLEMENTED' };
    }
    if (res.status === 404 || res.status === 405) {
      return { state: 'unavailable', reason: 'GATEWAY_NOT_IMPLEMENTED' };
    }
    return { state: 'error', message: `probe status ${res.status}` };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { state: 'error', message: 'probe timed out' };
    }
    return { state: 'unavailable', reason: 'GATEWAY_NOT_IMPLEMENTED' };
  }
}

/**
 * The exported singleton. Consumers should treat `probe()` as the
 * ONLY authoritative availability answer — do not assume `ready`.
 *
 * The `search` method is intentionally typed as an async rejection in
 * this phase: calling it from the UI would be the moment we start
 * performing a public egress the backend hasn't redacted, which is
 * exactly the security hole §7 forbids. So the UI can't do that
 * accidentally: the only honest branch the method can take is
 * `{ ok: false, reason: 'GATEWAY_NOT_IMPLEMENTED' }`.
 */
export const privateSearchGateway: PrivateSearchGateway = {
  async probe(): Promise<GatewayProbe> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      return await doProbe(controller.signal);
    } finally {
      clearTimeout(t);
    }
  },

  async search(_query: string) {
    return {
      ok: false,
      reason:
        'GATEWAY_NOT_IMPLEMENTED — no backend route for public-web search ' +
        'is available yet. The renderer intentionally does not perform a ' +
        'client-side fetch, because that would be the egress path the ' +
        'gateway exists to redact. Enable it server-side and re-run this ' +
        'call; the typed contract is ready, and a successful probe() is ' +
        'the trigger that flips the UI to the enabled state.',
    } as const;
  },
};
