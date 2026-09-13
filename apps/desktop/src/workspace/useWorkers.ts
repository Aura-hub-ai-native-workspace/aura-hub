/**
 * useWorkers — the renderer's live view of AURA's real AI workers.
 *
 * A thin host around `workerClient`. It holds no opinion about whether a
 * worker is connected: that word belongs to the backend, which earns it
 * by proving a real dispatch and a real, correlated response. This hook
 * only remembers what the backend last said, plus which connect attempt
 * is currently in flight.
 */
import { create } from 'zustand';
import {
  workerClient,
  type WorkerDescriptor,
  type WorkerReadinessProof,
} from '../ai/workerClient';

interface WorkerState {
  workers: WorkerDescriptor[];
  loading: boolean;
  /** Worker ids with a readiness handshake in flight. */
  connecting: string[];
  error: string | null;
  /** The last proof the backend returned, keyed by worker id. */
  proofs: Record<string, WorkerReadinessProof | null>;
  refresh: () => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
}

export const useWorkerStore = create<WorkerState>((set, get) => ({
  workers: [],
  loading: false,
  connecting: [],
  error: null,
  proofs: {},

  refresh: async () => {
    set({ loading: true });
    const res = await workerClient.list();
    set({
      workers: res.workers,
      loading: false,
      // An unreachable service is reported, never rendered as "no
      // workers" — those are different facts and the user needs to know
      // which one they are looking at.
      error: res.error ?? null,
    });
  },

  connect: async (id) => {
    if (get().connecting.includes(id)) return;
    set((s) => ({ connecting: [...s.connecting, id], error: null }));
    const res = await workerClient.connect(id);
    set((s) => ({
      connecting: s.connecting.filter((w) => w !== id),
      proofs: { ...s.proofs, [id]: res.proof ?? null },
      error: res.error ?? null,
      // The descriptor the backend returns already carries the verdict;
      // substituting our own would be a second source of truth.
      workers: res.worker
        ? s.workers.map((w) => (w.id === id ? res.worker! : w))
        : s.workers,
    }));
  },

  disconnect: async (id) => {
    const res = await workerClient.disconnect(id);
    if (!res.ok) {
      set({ error: res.error ?? 'the worker could not be disconnected' });
      return;
    }
    await get().refresh();
  },
}));

/** Counts for the rail summary. Derived, never stored. */
export function workerReadiness(workers: WorkerDescriptor[]) {
  return {
    connected: workers.filter((w) => w.connected).length,
    governed: workers.filter((w) => w.governance === 'FULLY_GOVERNED').length,
    installed: workers.filter((w) => w.installed && !w.connected).length,
    missing: workers.filter((w) => !w.installed).length,
    total: workers.length,
  };
}
