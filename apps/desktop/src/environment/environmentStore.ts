/**
 * environmentStore — the live Connected Environment.
 * ==================================================================
 * A thin host around `@aura/connected-environment`. Every transition is
 * computed by a pure function from that package; this store's only jobs
 * are holding the result and driving the transport.
 *
 * It holds **no mission state**. Missions live in Mission Control v3
 * (`MissionRecord`, served by the local service and surfaced by
 * `screens/missions/`), and capability gaps for a live mission are
 * derived by the Capability Fabric from that record — never from a
 * second copy kept here. See docs/CONSOLIDATION_MAP.md.
 *
 * Nothing persists. A relaunch starts from an unmeasured environment and
 * scans, because a cached "Docker is connected" that is no longer true
 * would be exactly the kind of confident wrong answer this architecture
 * exists to avoid.
 */

import { useMemo } from 'react';
import { create } from 'zustand';
import {
  applyConnect,
  applyDisconnect,
  applyProbe,
  createEnvironment,
  environmentSummary,
  findGaps,
  setPermissions as withPermissions,
  type CapabilityGap,
  type CapabilityRequirement,
  type EnvironmentNode,
  type NodePermissions,
} from '@aura/connected-environment';
import { environmentClient } from './environmentClient';
import { transportFor } from './transports';

interface EnvironmentState {
  nodes: EnvironmentNode[];
  /** A scan is in flight. */
  scanning: boolean;
  lastScanAt: string | null;
  /** Node ids with a connect/disconnect in flight. */
  busy: string[];

  scan: (refresh?: boolean) => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => void;
  setNodePermissions: (id: string, partial: Partial<NodePermissions>) => void;
}

export const useEnvironmentStore = create<EnvironmentState>((set, get) => ({
  nodes: createEnvironment(),
  scanning: false,
  lastScanAt: null,
  busy: [],

  scan: async (refresh = false) => {
    if (get().scanning) return;
    set({ scanning: true });
    const response = await environmentClient.scan(undefined, refresh);
    set((s) => ({
      nodes: s.nodes.map((node) => {
        const result = response.results[node.id];
        return result ? applyProbe(node, result) : node;
      }),
      scanning: false,
      lastScanAt: response.scannedAt,
    }));
  },

  connect: async (id) => {
    const node = get().nodes.find((n) => n.id === id);
    if (!node || get().busy.includes(id)) return;
    set((s) => ({ busy: [...s.busy, id] }));

    const result = await transportFor(node.entry).connect(node.entry);

    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? applyConnect(n, result) : n)),
      busy: s.busy.filter((b) => b !== id),
    }));
  },

  disconnect: (id) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? applyDisconnect(n) : n)) }));
  },

  setNodePermissions: (id, partial) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? withPermissions(n, partial) : n)) }));
  },
}));

/* ── selectors ──────────────────────────────────────────────────── */

/**
 * `environmentSummary` builds a fresh object, so it must be computed
 * *outside* the selector — a selector returning a new object on every
 * call breaks `useSyncExternalStore`'s snapshot caching.
 */
export function useEnvironmentSummary() {
  const nodes = useEnvironmentStore((s) => s.nodes);
  return useMemo(() => environmentSummary(nodes), [nodes]);
}

/**
 * Live capability gaps for an arbitrary requirement list. The caller owns
 * the requirements — for a real mission they come from the Fabric reading
 * the authoritative `MissionRecord`, so connecting a node re-derives the
 * gaps with no mission state duplicated into this store.
 */
export function useCapabilityGaps(required: CapabilityRequirement[]): CapabilityGap[] {
  const nodes = useEnvironmentStore((s) => s.nodes);
  const key = required.map((r) => `${r.capability}:${(r.taskIds ?? []).join(',')}`).join('|');
  // `key` collapses the requirement list to a primitive so a caller passing
  // a freshly-built array each render does not re-run the scan.
  return useMemo(() => findGaps(required, nodes), [key, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
}
