/**
 * The renderer's only route to AURA's local backends.
 *
 * A port answering is not evidence that AURA is behind it, so no request
 * leaves this module until the desktop shell has proved that the backend on
 * that port was launched with this launch's identity (see
 * apps/desktop/src-tauri/src/instance.rs). Once proved, every request carries
 * the launch token in a header. A backend that refuses that token is treated
 * as not ours until the next check.
 *
 * Two backends, two kinds: `ai` is the Node service (AI_BASE); `python` is the
 * canonical Python backend, reached through AGENT_BASE and ENVIRONMENT_BASE.
 * A URL that is not under one of those bases is refused outright.
 *
 * Outside the desktop shell there is no way to prove identity, so every
 * backend is refused there. That is deliberate.
 */

const ENV = import.meta.env as unknown as Record<string, string | undefined>;

/** The Node AI service (projects, conversations, workflows). */
export const AI_BASE = ENV.VITE_AI_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:4319';
/** The Python backend, as the Central Agent sees it. */
export const AGENT_BASE =
  ENV.VITE_AGENT_URL?.replace(/\/$/, '') ??
  (import.meta.env.DEV ? '/agent-api' : 'http://127.0.0.1:4320');
/** The Python backend, as the environment inventory sees it. */
export const ENVIRONMENT_BASE =
  ENV.VITE_ENVIRONMENT_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:4320';

/** Must match `TOKEN_HEADER` in backend/aura/api/instance_guard.py. */
export const TOKEN_HEADER = 'x-aura-instance-token';

export type BackendKind = 'ai' | 'python';

export const IDENTITY_MISMATCH = 'Backend identity mismatch — connection refused.';

type Verdict = { verified: true; token: string } | { verified: false; reason: string };

/** The last answer per backend. `null` until the first check. */
const verdicts: Record<BackendKind, Verdict | null> = { ai: null, python: null };

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeRef: Invoke | null | undefined;

async function getInvoke(): Promise<Invoke | null> {
  if (invokeRef !== undefined) return invokeRef;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    invokeRef = null;
    return invokeRef;
  }
  try {
    const mod = await import('@tauri-apps/api/core');
    invokeRef = mod.invoke as Invoke;
  } catch {
    invokeRef = null;
  }
  return invokeRef;
}

/** Which backend a URL addresses, or null when it addresses neither. */
export function kindOfUrl(url: string): BackendKind | null {
  const within = (base: string) =>
    url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`);
  if (within(AI_BASE)) return 'ai';
  if (within(AGENT_BASE) || within(ENVIRONMENT_BASE)) return 'python';
  return null;
}

export class BackendRefusedError extends Error {
  readonly kind: BackendKind;
  constructor(kind: BackendKind, reason: string) {
    super(`${IDENTITY_MISMATCH} ${reason}`.trim());
    this.name = 'BackendRefusedError';
    this.kind = kind;
  }
}

const NO_SHELL = "AURA's desktop shell is not running, so this backend's identity cannot be verified.";

interface WireEndpoint {
  port: number;
  verified: boolean;
  token: string;
  reason: string;
}

/**
 * Ask the shell whether each backend is ours, now. Runs the check again on
 * every call, so a reconnect or retry repeats it rather than trusting an
 * earlier answer.
 */
export async function refreshBackendSession(): Promise<BackendSessionView> {
  const invoke = await getInvoke();
  if (!invoke) {
    verdicts.ai = { verified: false, reason: NO_SHELL };
    verdicts.python = { verified: false, reason: NO_SHELL };
    return backendSessionView();
  }
  try {
    const session = await invoke<{ ai: WireEndpoint; python: WireEndpoint }>('backend_session');
    verdicts.ai = fromWire(session.ai);
    verdicts.python = fromWire(session.python);
  } catch {
    const reason = "AURA's desktop shell did not answer the identity check.";
    verdicts.ai = { verified: false, reason };
    verdicts.python = { verified: false, reason };
  }
  return backendSessionView();
}

function fromWire(e: WireEndpoint): Verdict {
  if (e.verified && e.token) return { verified: true, token: e.token };
  return { verified: false, reason: e.reason || 'the identity check did not pass' };
}

export interface BackendSessionView {
  ai: { ok: boolean; message: string };
  python: { ok: boolean; message: string };
}

export function backendSessionView(): BackendSessionView {
  const view = (v: Verdict | null) =>
    v?.verified
      ? { ok: true, message: '' }
      : { ok: false, message: v ? `${IDENTITY_MISMATCH} ${v.reason}` : 'Not checked yet.' };
  return { ai: view(verdicts.ai), python: view(verdicts.python) };
}

/**
 * Prove ownership of ONE backend, now. This is what gates a request: the
 * answer is never taken from an earlier check. The cached verdict is updated
 * as a side effect, for the status display only.
 */
async function verifyNow(kind: BackendKind): Promise<Verdict> {
  const invoke = await getInvoke();
  let verdict: Verdict;
  if (!invoke) {
    verdict = { verified: false, reason: NO_SHELL };
  } else {
    try {
      verdict = fromWire(await invoke<WireEndpoint>('backend_verify', { kind }));
    } catch {
      verdict = { verified: false, reason: "AURA's desktop shell did not answer the identity check." };
    }
  }
  verdicts[kind] = verdict;
  return verdict;
}

/** The shell's own startup verdict for one backend (`service_status`). */
export interface ServiceStartup {
  /** `starting` | `ready` | `failed`. `failed` is final for this launch. */
  state: string;
  message: string;
  port?: number;
}

/**
 * Ask the shell how starting this backend went. Null outside the shell, or
 * when the shell cannot answer: the caller then has no verdict, not a pass.
 */
export async function serviceStartup(kind: BackendKind): Promise<ServiceStartup | null> {
  const invoke = await getInvoke();
  if (!invoke) return null;
  try {
    return await invoke<ServiceStartup>(kind === 'ai' ? 'service_status' : 'environment_backend_status');
  } catch {
    return null;
  }
}

export type StartupVerdict = { kind: 'waiting' } | { kind: 'failed'; message: string };

/**
 * Whether a screen waiting on a backend should keep waiting.
 *
 * A refused request alone cannot say: a backend that has not finished
 * starting is refused too. The shell can. Once it reports `failed` (for
 * example, another program already held the port, so AURA never started its
 * own service there) waiting can never end, so the screen must stop and say
 * why. A refusal for identity is named as such.
 */
export function startupVerdict(startup: ServiceStartup | null, error: unknown): StartupVerdict {
  if (startup?.state !== 'failed') return { kind: 'waiting' };
  const reason = startup.message.trim() || 'AURA could not start its local service.';
  return {
    kind: 'failed',
    message: error instanceof BackendRefusedError ? `${IDENTITY_MISMATCH} ${reason}` : reason,
  };
}

/**
 * Send a request to one of AURA's backends. Ownership is proved immediately
 * before the request, every time. A backend that is not ours is refused before
 * the network, and the launch token is never sent to it.
 */
export async function backendFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const kind = kindOfUrl(url);
  if (!kind) {
    throw new Error(`Refusing to send a request outside AURA's backends: ${url}`);
  }
  const verdict = await verifyNow(kind);
  if (!verdict.verified) {
    throw new BackendRefusedError(kind, verdict.reason);
  }
  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, verdict.token);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    // A backend that refuses this launch's token is not this instance's.
    // Stop trusting it until the next check, rather than retrying into it.
    const body = await res.clone().json().catch(() => null) as { error?: string } | null;
    if (body?.error === 'instance-token-required') {
      verdicts[kind] = { verified: false, reason: 'it refused this launch’s token.' };
    }
  }
  return res;
}
