/**
 * Cooperative cancellation for the governance reports.
 *
 * A Stop can only be OBSERVED at an `await`: it is delivered by an event on the
 * same loop that is running the report, so synchronous stretches (the per-file
 * regex loops) run to their end first. Checks therefore go immediately after
 * each await, and before any write, so a cancelled report stops at the next
 * safe boundary and never persists a result the caller has abandoned.
 *
 * What this does NOT do: interrupt a synchronous stretch, undo an earlier
 * write, or kill a subprocess's own children (`execFile`'s signal ends the
 * process it started).
 */
export class OperationCancelled extends Error {
  constructor(what: string) {
    super(`${what} cancelled`);
    this.name = 'OperationCancelled';
  }
}

export function throwIfAborted(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted) throw new OperationCancelled(what);
}

/** True for the error this module throws and for the platform's own abort errors. */
export function isCancellation(e: unknown): boolean {
  const n = (e as { name?: string; code?: string } | null);
  return n?.name === 'OperationCancelled' || n?.name === 'AbortError' || n?.code === 'ABORT_ERR';
}
