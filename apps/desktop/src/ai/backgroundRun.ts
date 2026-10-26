/**
 * Following a Workspace run that the server accepted in the background.
 *
 * `POST /agent/sessions` answers `started` at once and the run continues on
 * the server. Its terminal result is the session's `lastResult`, available
 * only once `orchestrationState` has left `running`. Progress arrives on the
 * event stream; this module decides when the run has truly settled, so the
 * chat neither treats `started` as an outcome nor stops listening early.
 *
 * Pure apart from the injected `getSession` / `sleep` / `now`, so the
 * lifecycle can be tested without a server.
 */
import type { AgentResult, AgentSession } from './centralAgentClient';

/** How long the UI keeps waiting before it stops and says so. The run itself
 * is not cancelled by this; the person can still Stop it or check back. */
export const DEFAULT_RUN_WAIT_MS = 30 * 60 * 1000;

const DEFAULT_INTERVAL_MS = 1000;
const MAX_BACKOFF_MS = 10_000;

export type RunWait =
  | { kind: 'settled'; result: AgentResult }
  | { kind: 'cancelled' }
  | { kind: 'timeout'; elapsedMs: number };

export interface WaitForRunOptions {
  sessionId: string;
  getSession: (sessionId: string) => Promise<AgentSession>;
  signal: AbortSignal;
  /** Called with each non-terminal snapshot, so the message can show progress. */
  onProgress?: (session: AgentSession, elapsedMs: number) => void;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  /** Resolves after `ms`, or earlier when `signal` aborts. Never rejects. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** True for the submit answer that means "accepted and running", which is
 * not an outcome. */
export function isStartedResult(
  result: { status?: string | null; outcome?: string | null } | null | undefined,
): boolean {
  return !!result && (result.status === 'started' || result.outcome === 'started');
}

/** The run's terminal result, or null while it is still in flight. */
export function settledResultOf(
  session: Pick<AgentSession, 'lastResult' | 'orchestrationState'> | null | undefined,
): AgentResult | null {
  if (!session) return null;
  const result = session.lastResult;
  if (!result || isStartedResult(result)) return null;
  if (session.orchestrationState === 'running') return null;
  return result;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Wait for a background run to settle.
 *
 * - Settled: resolves with the run's own terminal result (completed, failed,
 *   denied, awaiting-approval, cancelled, …). Nothing is inferred from events.
 * - Transient errors (network blips, a backend restart) do not end the wait:
 *   polling backs off and resumes, which is the reconnection path.
 * - Cancelled: the caller aborted; the wait stops without a result.
 * - Timeout: the UI's ceiling was reached; the run may still be going.
 */
export async function waitForRun(opts: WaitForRunOptions): Promise<RunWait> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_WAIT_MS;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const started = now();
  let failures = 0;

  for (;;) {
    if (opts.signal.aborted) return { kind: 'cancelled' };
    try {
      const session = await opts.getSession(opts.sessionId);
      failures = 0;
      const settled = settledResultOf(session);
      if (settled) return { kind: 'settled', result: settled };
      opts.onProgress?.(session, now() - started);
    } catch {
      if (opts.signal.aborted) return { kind: 'cancelled' };
      failures += 1;
    }
    const elapsed = now() - started;
    if (elapsed >= timeoutMs) return { kind: 'timeout', elapsedMs: elapsed };
    const backoff = failures === 0 ? interval : Math.min(interval * 2 ** Math.min(failures, 4), MAX_BACKOFF_MS);
    await sleep(backoff, opts.signal);
  }
}
