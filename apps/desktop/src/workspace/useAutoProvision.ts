import { useEffect } from 'react';
import { useWorkerStore } from './useWorkers';
import { useHubStore } from './hubStore';
import { useEnvironmentStore } from '../environment/environmentStore';
import { planAutoProvision } from './autoProvision';

/** What was already placed or attempted since the app started. Never repeated on its own. */
const done = new Set<string>();

/**
 * Keeps the Workspace connected to what the machine has: installed AI
 * workers and developer tools go into the free slots and are connected one
 * at a time. A slot the person empties is not refilled during the same
 * session, and a failed connection is not retried by itself.
 */
export function useAutoProvision(): void {
  const workers = useWorkerStore((s) => s.workers);
  const connectingWorkers = useWorkerStore((s) => s.connecting);
  const connectWorker = useWorkerStore((s) => s.connect);
  const nodes = useEnvironmentStore((s) => s.nodes);
  const lastScanAt = useEnvironmentStore((s) => s.lastScanAt);
  const envBusy = useEnvironmentStore((s) => s.busy);
  const connectTool = useEnvironmentStore((s) => s.connect);
  const workerIds = useHubStore((s) => s.workerIds);
  const placed = useHubStore((s) => s.placed);

  useEffect(() => {
    if (workers.length === 0 && !lastScanAt) return;
    const hub = useHubStore.getState();
    const plan = planAutoProvision({
      workers,
      workerIds,
      freeWorkerSlots: workerIds.filter((x) => x === null).length,
      nodes,
      placedTools: placed.map((p) => p.nodeId),
      freeToolSlots: Math.max(0, 3 - placed.length),
      attempted: done,
      busy: connectingWorkers.length > 0 || envBusy.length > 0,
    });
    for (const id of plan.placeWorkers) {
      if (done.has(`placed:worker:${id}`)) continue;
      const slot = hub.firstFreeWorkerSlot();
      if (slot === null) break;
      done.add(`placed:worker:${id}`);
      hub.placeWorkerAt(slot, id);
    }
    for (const id of plan.placeTools) {
      if (done.has(`placed:tool:${id}`)) continue;
      done.add(`placed:tool:${id}`);
      hub.add(id);
    }
    if (plan.connectWorker) {
      done.add(`worker:${plan.connectWorker}`);
      void connectWorker(plan.connectWorker);
    } else if (plan.connectTool) {
      done.add(`tool:${plan.connectTool}`);
      void connectTool(plan.connectTool);
    }
  }, [workers, workerIds, nodes, placed, lastScanAt, connectingWorkers, envBusy, connectWorker, connectTool]);
}
