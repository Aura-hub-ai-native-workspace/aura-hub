/**
 * autoProvision — the Workspace connects what the machine already has.
 * ==================================================================
 * Nobody should have to wire up their own tools by hand. When the Workspace
 * opens, installed AI workers and developer tools are placed in the free
 * slots and connected, one at a time. This module only DECIDES; the store
 * actions do the work, and the backend still gives every verdict (a worker
 * is "connected" only when the backend's readiness proof says so).
 *
 * Placing is a layout edit and costs nothing. Connecting a worker runs the
 * backend's own readiness check, so it is attempted once per worker per
 * app session and never repeated on its own after a failure.
 */

import type { EnvironmentNode } from '@aura/connected-environment';
import type { WorkerDescriptor } from '../ai/workerClient';

/** Developer tools worth keeping in the three tool slots, most useful first. */
export const PREFERRED_TOOLS = ['git', 'node', 'python', 'docker', 'github-cli', 'pnpm', 'rust', 'go', 'vscode'];

export interface AutoPlan {
  /** Workers to put into free worker slots, in order. */
  placeWorkers: string[];
  /** Tools to put into free tool slots, in order. */
  placeTools: string[];
  /** The one worker to connect now, if any. */
  connectWorker: string | null;
  /** The one tool to connect now, if any. */
  connectTool: string | null;
}

const usable = (w: WorkerDescriptor) => w.installed && w.invocable;

export function planAutoProvision(input: {
  workers: WorkerDescriptor[];
  workerIds: (string | null)[];
  freeWorkerSlots: number;
  nodes: EnvironmentNode[];
  placedTools: string[];
  freeToolSlots: number;
  /** Workers and tools already attempted this session. */
  attempted: ReadonlySet<string>;
  /** Anything being connected right now makes this a no-connect round. */
  busy: boolean;
}): AutoPlan {
  const { workers, workerIds, nodes, placedTools, attempted, busy } = input;

  const placeWorkers = workers
    .filter((w) => usable(w) && !workerIds.includes(w.id))
    .map((w) => w.id)
    .slice(0, input.freeWorkerSlots);

  const toolOk = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return !!n && (n.health.status === 'available' || n.health.status === 'connected') && n.entry.transport === 'local-process';
  };
  const placeTools = PREFERRED_TOOLS
    .filter((id) => toolOk(id) && !placedTools.includes(id))
    .slice(0, input.freeToolSlots);

  const placedWorkerSet = new Set([...workerIds.filter((x): x is string => !!x), ...placeWorkers]);
  const connectWorker = busy
    ? null
    // A worker waiting for the owner's approval is never connected on its own.
    : workers.find((w) => usable(w) && !w.connected && w.reason !== 'BILLING_POLICY' && placedWorkerSet.has(w.id) && !attempted.has(`worker:${w.id}`))?.id ?? null;

  const allTools = [...placedTools, ...placeTools];
  const connectTool = busy
    ? null
    : allTools.find((id) => {
        const n = nodes.find((x) => x.id === id);
        return !!n && !n.connected && toolOk(id) && !attempted.has(`tool:${id}`);
      }) ?? null;

  return { placeWorkers, placeTools, connectWorker, connectTool };
}
