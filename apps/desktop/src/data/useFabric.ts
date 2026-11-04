/**
 * useFabric — the Capability Fabric's catalogue, read from the service.
 * ==================================================================
 * The capability catalogue (`GET /fabric/capabilities`): the manifest as the
 * *running* service holds it, including each capability's real risk,
 * permission scopes, irreversibility and whether an executor exists. The
 * Permission Envelope reads risk from here, never from a compile-time copy,
 * so the two can never disagree.
 *
 * This store grants nothing, decides nothing, and caches nothing across a
 * restart. Work is either allowed by the service's policy and runs, or is
 * refused at once; there is no pending-decision state here.
 */

import { create } from 'zustand';
import { fabricClient, type CapabilityCatalogue } from '../ai/fabricClient';

interface FabricState {
  catalogue: CapabilityCatalogue | null;
  /** null until the first attempt resolves. */
  reachable: boolean | null;
  loadingCatalogue: boolean;
  catalogueError: string | null;
  loadCatalogue: (force?: boolean) => Promise<void>;
}

export const useFabric = create<FabricState>((set, get) => ({
  catalogue: null,
  reachable: null,
  loadingCatalogue: false,
  catalogueError: null,

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
}));
