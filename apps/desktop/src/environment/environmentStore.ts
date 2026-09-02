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
  appendLog,
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
import { environmentClient, type InstallResponse } from './environmentClient';
import type { InvocationResultView } from '../ai/fabricClient';

interface EnvironmentState {
  nodes: EnvironmentNode[];
  /** A scan is in flight. */
  scanning: boolean;
  lastScanAt: string | null;
  /** Node ids with a connect/disconnect/install in flight. */
  busy: string[];

  scan: (refresh?: boolean) => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => void;
  setNodePermissions: (id: string, partial: Partial<NodePermissions>) => void;
  /** Direct human install — bypasses Fabric approval gate. AI path remains via fabricClient.invoke('system.install'). */
  install: (id: string) => Promise<InvocationResultView>;
  /** Governed AI install (kept for model-initiated). */
  installGoverned?: (id: string) => Promise<InvocationResultView>;
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

    try {
      const response = await environmentClient.connectDirect(id);
      const probeResult = response.result;
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? applyConnect(n, probeResult) : n)),
        busy: s.busy.filter((b) => b !== id),
      }));
    } catch {
      // Fallback to probe-only if direct endpoint unavailable
      try {
        const { transportFor } = await import('./transports');
        const n = get().nodes.find((x) => x.id === id);
        if (n) {
          const result = await transportFor(n.entry).connect(n.entry);
          set((s) => ({
            nodes: s.nodes.map((x) => (x.id === id ? applyConnect(x, result) : x)),
            busy: s.busy.filter((b) => b !== id),
          }));
          return;
        }
      } catch {}
      set((s) => ({ busy: s.busy.filter((b) => b !== id) }));
    }
  },

  disconnect: (id) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? applyDisconnect(n) : n)) }));
  },

  setNodePermissions: (id, partial) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? withPermissions(n, partial) : n)) }));
  },

  install: async (id) => {
    const node = get().nodes.find((n) => n.id === id);
    if (!node) {
      return { invocationId: '', outcome: 'unsupported', detail: 'That node is not in the catalog.' };
    }
    if (get().busy.includes(id) || node.health.status === 'installing') {
      return { invocationId: '', outcome: 'unsupported', detail: 'An install is already in progress for this node.' };
    }
    if (!node.entry.install) {
      return {
        invocationId: '',
        outcome: 'unsupported',
        detail: `AURA has no verified way to install ${node.entry.name}, so it will not guess at one. See ${node.entry.homepage} for the project's own instructions.`,
      };
    }

    // Mark installing and busy before anything leaves the machine.
    set((s) => ({
      busy: [...s.busy, id],
      nodes: s.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              health: {
                status: 'installing',
                detail: 'Installation is running — AURA will look for it again when this finishes.',
                checkedAt: new Date().toISOString(),
                version: n.health.version,
              },
              log: appendLog(n.log, 'info', `Install requested for ${n.entry.name}.`),
            }
          : n,
      ),
    }));

    let direct: InstallResponse | null = null;
    let detailForFailure = '';
    try {
      direct = await environmentClient.install(id);
    } catch (e) {
      detailForFailure = (e as Error).message || 'The install request did not complete.';
      // Re-probe honestly before reporting the transport failure.
      try {
        const probeResult = await environmentClient.probe(id, true);
        set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? applyProbe(n, probeResult) : n)) }));
      } catch {
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id
              ? {
                  ...n,
                  health: { status: 'not-installed', detail: detailForFailure, checkedAt: new Date().toISOString() },
                  log: appendLog(n.log, 'error', detailForFailure),
                }
              : n,
          ),
        }));
      }
      set((s) => ({ busy: s.busy.filter((b) => b !== id) }));
      return { invocationId: '', outcome: 'failed', detail: detailForFailure };
    }

    // Direct human install succeeded in reaching the service — now apply verification.
    // The service already probed, but we do a second honest re-probe for UI consistency
    // (service probe is evidence; this second probe confirms registry update).
    if (direct && direct.probe) {
      // Use service-provided probe evidence
      const probeResult = {
        present: direct.probe.present,
        detail: direct.probe.detail,
        version: direct.probe.version,
        latencyMs: direct.probe.latencyMs,
      };
      set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? applyProbe(n, probeResult) : n)) }));
    } else {
      try {
        const probeResult = await environmentClient.probe(id, true);
        set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? applyProbe(n, probeResult) : n)) }));
      } catch {
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id
              ? {
                  ...n,
                  health: {
                    status: 'not-installed',
                    detail: direct?.detail || 'Installation finished, but the follow-up check did not complete. Scan again.',
                    checkedAt: new Date().toISOString(),
                    version: n.health.version,
                  },
                }
              : n,
          ),
        }));
      }
    }

    set((s) => ({ busy: s.busy.filter((b) => b !== id) }));

    // Map direct installOutcome to InvocationResultView for existing UI branches
    // NodeCard branches on output.installOutcome, never on ok/outcome alone.
    if (!direct) {
      return { invocationId: '', outcome: 'failed', detail: detailForFailure || 'Install did not complete.' };
    }
    if (direct.installOutcome === 'unavailable') {
      return { invocationId: '', outcome: 'unsupported', detail: direct.detail || direct.why || 'Install unavailable.' };
    }
    if (direct.installOutcome === 'guided') {
      return {
        invocationId: '',
        outcome: 'succeeded',
        detail: direct.detail || direct.why || '',
        output: direct as unknown as Record<string, unknown>,
      };
    }
    if (direct.installOutcome === 'installed') {
      return {
        invocationId: '',
        outcome: 'succeeded',
        detail: direct.detail || '',
        output: direct as unknown as Record<string, unknown>,
      };
    }
    // failed / unverified
    return {
      invocationId: '',
      outcome: 'failed',
      detail: direct.detail || direct.why || 'Install failed.',
      output: direct as unknown as Record<string, unknown>,
    };
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
