/**
 * useFabric — the Capability Fabric's state, read from the service.
 * ==================================================================
 * Two things live here, and neither is an authority:
 *
 *   • the capability catalogue (`GET /fabric/capabilities`) — the manifest
 *     as the *running* service holds it, including each capability's real
 *     risk, permission scopes, irreversibility and whether an executor
 *     exists. The Permission Envelope reads risk from here, never from a
 *     compile-time copy, so the two can never disagree.
 *
 *   • pending approvals (`GET /fabric/approvals`) — polled, and answered
 *     through `fabricClient.decide()`, which can name a request id and an
 *     answer but can never name a capability. There is exactly one
 *     approval store and it is on the service.
 *
 * This store grants nothing, decides nothing, and caches nothing across a
 * restart.
 */

import { create } from 'zustand';
import { fabricClient, type ApprovalRequest, type CapabilityCatalogue } from '../ai/fabricClient';

/** How often pending approvals are re-read while something is watching. */
const POLL_MS = 4000;

interface FabricState {
  catalogue: CapabilityCatalogue | null;
  /** null until the first attempt resolves. */
  reachable: boolean | null;
  loadingCatalogue: boolean;
  catalogueError: string | null;

  approvals: ApprovalRequest[];
  deciding: string | null;
  decideError: string | null;

  /** Number of live subscribers to the approval poll. */
  watchers: number;

  loadCatalogue: (force?: boolean) => Promise<void>;
  refreshApprovals: () => Promise<void>;
  decide: (id: string, granted: boolean, reason?: string) => Promise<void>;
  /** Start polling approvals; returns the matching stop function. */
  watchApprovals: () => () => void;
}

let timer: number | null = null;

export const useFabric = create<FabricState>((set, get) => ({
  catalogue: null,
  reachable: null,
  loadingCatalogue: false,
  catalogueError: null,
  approvals: [],
  deciding: null,
  decideError: null,
  watchers: 0,

  async loadCatalogue(force = false) {
    if (get().loadingCatalogue) return;
    if (get().catalogue && !force) return;
    set({ loadingCatalogue: true, catalogueError: null });
    try {
      const catalogue = await fabricClient.capabilities();
      set({ catalogue, reachable: true, loadingCatalogue: false });
    } catch (e) {
      // A missing catalogue is not "everything is fine" — the envelope
      // renders an explicit "risk unavailable" state off this.
      set({ catalogue: null, reachable: false, loadingCatalogue: false, catalogueError: (e as Error).message });
    }
  },

  async refreshApprovals() {
    try {
      const { approvals } = await fabricClient.approvals();
      set({ approvals: Array.isArray(approvals) ? approvals : [], reachable: true });
    } catch {
      set({ reachable: false });
    }
  },

  async decide(id, granted, reason) {
    set({ deciding: id, decideError: null });
    try {
      const res = await fabricClient.decide(id, granted, reason);
      // A 409 body carries the decision that already exists. That is the
      // answer the user wanted, so it is a success, not an error to retry.
      if (res.error && !res.approval) set({ decideError: res.error });
    } catch (e) {
      set({ decideError: (e as Error).message });
    } finally {
      set({ deciding: null });
      await get().refreshApprovals();
    }
  },

  watchApprovals() {
    set({ watchers: get().watchers + 1 });
    void get().refreshApprovals();
    if (timer === null) {
      timer = window.setInterval(() => void get().refreshApprovals(), POLL_MS);
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      const watchers = Math.max(0, get().watchers - 1);
      set({ watchers });
      if (watchers === 0 && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
  },
}));

/** Pending requests only — the inbox and the run view both want this. */
export const pendingApprovals = (list: ApprovalRequest[]): ApprovalRequest[] =>
  list.filter((a) => a.state === 'pending');
