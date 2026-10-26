import { startupVerdict, type ServiceStartup } from '../backend/backendSession';

/**
 * Waiting for AURA's local service on the first screen.
 *
 * A late service is the normal case and is waited for, with backoff. A
 * service the shell could not start or prove never arrives, so the wait
 * ends there with the shell's reason instead of spinning forever.
 */
export interface ServicePollDeps<R> {
  /** The request the screen needs. Rejects while the service is unavailable. */
  request: () => Promise<R>;
  /** The shell's startup verdict for the service. */
  startup: () => Promise<ServiceStartup | null>;
  onReady: (result: R) => void;
  onWaiting: (message: string) => void;
  onFailed: (message: string) => void;
  /** Schedules the next attempt and returns a cancel function. */
  schedule: (next: () => void, ms: number) => () => void;
}

export const WAITING_MESSAGE = 'Waiting for AURA’s local service to finish starting…';

/** Starts polling; returns a stop function for unmount. */
export function pollForService<R>(deps: ServicePollDeps<R>): () => void {
  let alive = true;
  let attempt = 0;
  let cancel: () => void = () => undefined;

  const ask = async () => {
    if (!alive) return;
    let result: R;
    try {
      result = await deps.request();
    } catch (err) {
      if (!alive) return;
      const verdict = startupVerdict(await deps.startup(), err);
      if (!alive) return;
      if (verdict.kind === 'failed') {
        deps.onFailed(verdict.message);
        return;
      }
      attempt += 1;
      deps.onWaiting(WAITING_MESSAGE);
      cancel = deps.schedule(() => { void ask(); }, Math.min(500 * attempt, 3000));
      return;
    }
    if (alive) deps.onReady(result);
  };

  void ask();
  return () => { alive = false; cancel(); };
}
