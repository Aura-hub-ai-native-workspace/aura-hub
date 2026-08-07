/**
 * statusStore — the live vitals behind the status bar.
 * ------------------------------------------------------------------
 * One polling store that aggregates real public state: backend health,
 * provider status, index (knowledge) status, the open project's git
 * branch (from real mission signals), mission activity, memory count
 * and pending diagnoses. Every slot is fed by a real API call.
 */
import { create } from 'zustand';
import { aiClient, type HealthResult, type IndexStatus, type ProviderStatus } from '../ai/aiClient';
import { missionClient } from '../ai/missionClient';
import { diagnosisClient } from '../ai/diagnosisClient';
import { useWorkspace } from '../data/useWorkspace';

interface StatusState {
  reachable: boolean | null;
  health: HealthResult | null;
  provider: ProviderStatus | null;
  index: IndexStatus | null;
  gitBranch: string | null;
  activeMissions: number;
  reviewingMissions: number;
  memoryCount: number;
  pendingDiagnoses: number;
  lastUpdatedAt: string | null;
  refresh: () => Promise<void>;
}

let inflight: Promise<void> | null = null;

export const useStatusStore = create<StatusState>((set) => ({
  reachable: null,
  health: null,
  provider: null,
  index: null,
  gitBranch: null,
  activeMissions: 0,
  reviewingMissions: 0,
  memoryCount: 0,
  pendingDiagnoses: 0,
  lastUpdatedAt: null,

  async refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      const ws = useWorkspace.getState();
      try {
        const health = await aiClient.health();
        let provider: ProviderStatus | null = null;
        try {
          const prov = await aiClient.getProviders();
          provider = prov.status;
        } catch {
          provider = null;
        }
        set({ health, provider, index: health.index ?? null, reachable: true });
      } catch {
        set({ reachable: false });
        return;
      }

      const openId = ws.openId;
      let gitBranch: string | null = null;
      try {
        if (openId) {
          const res = await missionClient.list(openId);
          const latest = [...res.missions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          if (latest) {
            const record = await missionClient.get(openId, latest.id);
            if (!('error' in record)) {
              const gs = record.signals.gitStatus;
              if (gs.available) gitBranch = gs.branch;
            }
          }
        }
      } catch {
        gitBranch = null;
      }

      let memoryCount = 0;
      try {
        if (openId) {
          const res = await aiClient.listMemory(openId);
          memoryCount = res.items.length;
        }
      } catch {
        memoryCount = 0;
      }

      let activeMissions = 0;
      let reviewingMissions = 0;
      try {
        const dash = await missionClient.dashboard();
        activeMissions = dash.totals.active;
        reviewingMissions = dash.totals.reviewing;
      } catch {
        /* keep previous */
      }

      let pendingDiagnoses = 0;
      try {
        if (openId) {
          const res = await diagnosisClient.list(openId);
          pendingDiagnoses = res.diagnoses.filter((d) => d.decision.status === 'pending').length;
        }
      } catch {
        /* keep previous */
      }

      set({ gitBranch, memoryCount, activeMissions, reviewingMissions, pendingDiagnoses, lastUpdatedAt: new Date().toISOString() });
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  },
}));
