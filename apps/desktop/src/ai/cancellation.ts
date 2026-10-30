/**
 * What a Stop actually did — four states that must never be confused.
 *
 *   requested         the service holds the request; the run has not been seen
 *                     to stop yet. Never shown as "stopped".
 *   confirmed         the service's own record says the run is cancelled.
 *   already-finished  the run ended (succeeded, failed or was already
 *                     cancelled) before the stop could take effect. Its real
 *                     outcome is shown, not "cancelled".
 *   failed            the request did not land, or the service did not signal
 *                     the run. Nothing changed: the run is still running.
 *
 * The three Stop buttons used to discard the request's result
 * (`.catch(() => null)` / `void`) and then show "cancelled" regardless. A
 * failed or unanswered cancel therefore looked like a stopped run.
 *
 * Both service clients return the response body whatever the HTTP status, so a
 * refusal arrives as `{ error }`, not as a thrown error; a thrown error is a
 * transport failure. Both are handled here.
 */

export type CancelResult =
  | { kind: 'requested'; message: string }
  | { kind: 'confirmed'; message: string }
  | { kind: 'already-finished'; message: string; state: string }
  | { kind: 'failed'; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A run record's own state, when it is a finished one. */
export function finishedState(record: unknown): string | null {
  const raw = isObject(record) ? (record.state ?? record.status) : null;
  return typeof raw === 'string' && ['succeeded', 'completed', 'failed', 'cancelled', 'timed-out'].includes(raw) ? raw : null;
}

export function describeTransportFailure(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/failed to fetch|networkerror|load failed|connection refused/i.test(msg)) {
    return 'AURA could not be reached.';
  }
  return msg || 'The request failed.';
}

export function cancelTransportFailure(e: unknown): CancelResult {
  return { kind: 'failed', message: `Could not stop the run: ${describeTransportFailure(e)} It is still running.` };
}

/**
 * The service's answer to a workflow-run cancel: `{ cancelled: boolean }`, or
 * `{ error }` (409 "already succeeded", 404 "not found").
 */
export function classifyWorkflowCancel(res: unknown): CancelResult {
  if (isObject(res) && typeof res.error === 'string') {
    if (/already\b.*nothing to cancel/i.test(res.error)) {
      const state = /already (\w[\w-]*)/i.exec(res.error)?.[1] ?? 'finished';
      return { kind: 'already-finished', state, message: `The run had already ${state} before the stop took effect.` };
    }
    return { kind: 'failed', message: `Could not stop the run: ${res.error} It is still running.` };
  }
  if (isObject(res) && res.cancelled === true) {
    return { kind: 'requested', message: 'Stop requested. Waiting for the engine to confirm.' };
  }
  return { kind: 'failed', message: 'The engine did not stop this run. It may still be running.' };
}

/**
 * The service's answer to an automation-run cancel: the run record (its status
 * is the engine's own account), or `{ error }`.
 */
export function classifyAutomationCancel(res: unknown): CancelResult {
  if (isObject(res) && typeof res.error === 'string') {
    if (/already\b.*nothing to cancel/i.test(res.error)) {
      const state = /already (\w[\w-]*)/i.exec(res.error)?.[1] ?? 'finished';
      return { kind: 'already-finished', state, message: `The run had already ${state}, so there was nothing to stop.` };
    }
    return { kind: 'failed', message: `Could not stop the run: ${res.error} It may still be running.` };
  }
  if (isObject(res) && res.status === 'cancelled') {
    // Acknowledged is not the same as stopped: an action that was running when the
    // Stop arrived may still be working, and nothing it already did is undone.
    const c = isObject(res.cancellation) ? res.cancellation : null;
    if (c && c.phase === 'winding-down') {
      const what = typeof c.label === 'string' && c.label ? `"${c.label}"` : 'An action';
      return { kind: 'requested', message: `Cancelled: nothing further will start. ${what} was already running and is still winding down; what it already did is not undone.` };
    }
    return { kind: 'confirmed', message: c && c.phase === 'complete' ? 'The engine recorded this run as cancelled and nothing of it is still running.' : 'The engine recorded this run as cancelled.' };
  }
  const status = isObject(res) && typeof res.status === 'string' ? res.status : null;
  if (status && ['completed', 'failed'].includes(status)) {
    return { kind: 'already-finished', state: status, message: `The run had already ${status}, so there was nothing to stop.` };
  }
  return { kind: 'failed', message: 'The engine did not report this run as stopped. It may still be running.' };
}

/**
 * An automation Stop that came back as a refusal ("no such run", or any other
 * error) is checked against the run's own record before the person is told it
 * is "still running": a run that had already finished is reported with its real
 * state. A record that is not finished leaves the failure as it was.
 */
export function reconcileAutomationCancel(result: CancelResult, record: unknown): CancelResult {
  if (result.kind !== 'failed') return result;
  const state = isObject(record) && typeof record.status === 'string' ? record.status : null;
  if (state === 'completed' || state === 'failed') {
    return { kind: 'already-finished', state, message: `The run had already ${state}, so there was nothing to stop.` };
  }
  if (state === 'cancelled') {
    return { kind: 'already-finished', state, message: 'The run was already cancelled.' };
  }
  return result;
}
