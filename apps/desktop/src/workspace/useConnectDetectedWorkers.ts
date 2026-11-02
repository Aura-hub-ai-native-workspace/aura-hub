import { useEffect } from 'react';
import { useWorkerStore } from './useWorkers';
import { done } from './useAutoProvision';
import { nextWorkerToConnect } from './autoProvision';

/**
 * Connects the AI workers this machine already has, wherever the person is.
 *
 * Home chat and the Workspace both answer through connected workers. The
 * Workspace used to be the only place that connected them, so a first
 * question on Home found nobody to answer. Each worker is tried once per app
 * session, one at a time, and a failed attempt is not repeated on its own;
 * the backend's readiness proof still decides whether it counts as connected.
 */
export function useConnectDetectedWorkers(): void {
  const workers = useWorkerStore((s) => s.workers);
  const connecting = useWorkerStore((s) => s.connecting);
  const refresh = useWorkerStore((s) => s.refresh);
  const connect = useWorkerStore((s) => s.connect);


  // The backends are still starting when the app opens, so the first read can fail or come back
  // empty. Read again every few seconds until it works, for a bounded time; never forever.
  useEffect(() => {
    let tries = 0;
    void refresh();
    const timer = setInterval(() => {
      const st = useWorkerStore.getState();
      if (st.workers.length > 0 && !st.error) { clearInterval(timer); return; }
      if (++tries >= 20) { clearInterval(timer); return; }
      void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const next = nextWorkerToConnect(workers, connecting, done);
    if (!next) return;
    done.add(`worker:${next}`);
    void connect(next);
  }, [workers, connecting, connect]);
}
