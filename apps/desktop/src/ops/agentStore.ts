/**
 * agentStore — the renderer's VIEW of the agent that runs in the service.
 * ==================================================================
 * The agent itself is `packages/ai-service/src/engineering/agent.ts`. It
 * used to be `apps/desktop/src/ops/agentEngine.ts`: a 30-second tick in
 * the renderer, not Fabric-routed, with its state in `localStorage`. It
 * stopped existing when the window closed, which is a strange property
 * for an autonomous agent to have.
 *
 * What is left here is a client and a cache:
 *
 *   • state comes from `GET /agent` and is kept live by the Event Spine
 *     (`agent.campaign`, `agent.timeline`, `agent.enabled`), so a
 *     campaign proposed while nobody was looking is on screen the moment
 *     someone is;
 *   • approve/dismiss are POSTs. A human's answer is the only thing that
 *     has ever made the agent act, and it still is — it just travels to
 *     where the agent lives now.
 *
 * The exported names are unchanged, so `AgentCenter.tsx` reads as before.
 */

import { create } from 'zustand';
import { subscribeToSpine } from '../events/spineClient';

const ENV = import.meta.env as unknown as Record<string, string | undefined>;
const BASE = ENV.VITE_AI_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:4319';

export type AgentSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AgentSignalKind =
  | 'repeated-bug' | 'unstable-module' | 'ai-rejection' | 'architecture-hotspot'
  | 'mission-bottleneck' | 'high-risk-prediction' | 'regression-risk';

export type AgentCampaignStatus =
  | 'observed' | 'planned' | 'awaiting-approval' | 'approved'
  | 'executing' | 'verifying' | 'verified' | 'failed' | 'dismissed';

export interface AgentVerifyTarget {
  /** What the campaign's success is measured against. */
  kind: 'mission-completion' | 'diagnosis-count';
  file?: string;
  missionId?: string;
  /** Baseline value captured at propose-time. */
  before: number;
  /** Value re-measured at verify-time; pass iff within the expected bound. */
  after?: number;
}

export interface AgentReasoningStep {
  kind: 'observed' | 'reasoned' | 'planned';
  label: string;
  detail: string;
}

export interface AgentCampaign {
  id: string;
  status: AgentCampaignStatus;
  kind: AgentSignalKind;
  /** Stable dedupe key — the same real signal never spawns two open campaigns. */
  signalKey: string;
  projectId: string | null;
  target: string;
  signalLabel: string;
  severity: AgentSeverity;
  rationale: string;
  plan: string;
  expectedOutcome: string;
  evidence: string[];
  reasoning: AgentReasoningStep[];
  verify: AgentVerifyTarget | null;
  missionId: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  executedAt?: string;
  verifiedAt?: string;
  note?: string;
  memoryId?: string;
}

export interface AgentTimelineEntry {
  id: string;
  campaignId: string;
  at: string;
  stage: string;
  label: string;
  detail: string;
  actor: 'agent' | 'human' | 'system';
}

interface AgentState {
  enabled: boolean;
  campaigns: AgentCampaign[];
  timeline: AgentTimelineEntry[];
  /** True once the service has answered at least once. */
  loaded: boolean;
  /** Set when the service could not be reached. */
  error: string | null;

  refresh: () => Promise<void>;
  setEnabled: (enabled: boolean) => void;
  approve: (id: string) => void;
  dismiss: (id: string) => void;
  /** Ask the service to run one observation pass now. */
  observe: () => void;
  clear: () => void;
  applyCampaign: (campaign: AgentCampaign) => void;
  applyTimeline: (entry: AgentTimelineEntry) => void;
}

const TIMELINE_CAP = 200;

async function post(path: string, body?: unknown): Promise<Response | null> {
  try {
    return await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  enabled: true,
  campaigns: [],
  timeline: [],
  loaded: false,
  error: null,

  async refresh() {
    try {
      const res = await fetch(`${BASE}/agent`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { enabled: boolean; campaigns: AgentCampaign[]; timeline: AgentTimelineEntry[] };
      set({
        enabled: body.enabled,
        campaigns: body.campaigns ?? [],
        timeline: body.timeline ?? [],
        loaded: true,
        error: null,
      });
    } catch (e) {
      // The cache keeps what it had. An unreachable service is not an
      // agent with no campaigns, and showing it as one would tell the
      // user nothing needs their attention when something might.
      set({ error: (e as Error).message });
    }
  },

  setEnabled(enabled) {
    // Optimistic, then reconciled by the `agent.enabled` spine event —
    // the toggle must feel immediate, and the service stays the truth.
    set({ enabled });
    void post('/agent/enabled', { enabled });
  },

  approve(id) {
    void post(`/agent/campaigns/${encodeURIComponent(id)}/approve`).then(() => get().refresh());
  },

  dismiss(id) {
    void post(`/agent/campaigns/${encodeURIComponent(id)}/dismiss`).then(() => get().refresh());
  },

  observe() {
    void post('/agent/observe').then(() => get().refresh());
  },

  /**
   * "Clear" now means "stop proposing", not "erase the record".
   *
   * The campaign timeline is the agent's accountability trail — what it
   * proposed, what a human decided, what it then did. Deleting that from
   * a button would remove the only evidence of an autonomous actor's
   * behaviour, so this disables the agent instead.
   */
  clear() {
    get().setEnabled(false);
  },

  applyCampaign(campaign) {
    set((s) => {
      const index = s.campaigns.findIndex((c) => c.id === campaign.id);
      if (index === -1) return { campaigns: [campaign, ...s.campaigns] };
      const next = s.campaigns.slice();
      next[index] = campaign;
      return { campaigns: next };
    });
  },

  applyTimeline(entry) {
    set((s) => (
      s.timeline.some((t) => t.id === entry.id)
        ? s
        : { timeline: [entry, ...s.timeline].slice(0, TIMELINE_CAP) }
    ));
  },
}));

/**
 * Keep the view in step with the agent. Started once by `App.tsx`.
 *
 * This is what replaces `startAgentEngine()`: the window no longer runs
 * the agent, it watches it.
 */
export function startAgentSync(): () => void {
  void useAgentStore.getState().refresh();
  return subscribeToSpine(['agent'], (e) => {
    const change = e.payload as
      | { type: 'campaign'; campaign: AgentCampaign }
      | { type: 'timeline'; entry: AgentTimelineEntry }
      | { type: 'enabled'; enabled: boolean }
      | { type: 'notification' };
    if (change.type === 'campaign') useAgentStore.getState().applyCampaign(change.campaign);
    else if (change.type === 'timeline') useAgentStore.getState().applyTimeline(change.entry);
    else if (change.type === 'enabled') useAgentStore.setState({ enabled: change.enabled });
  });
}
/* ── pure queue selectors (presentation over the fetched state) ──── */

export function approvalQueue(campaigns: AgentCampaign[]): AgentCampaign[] {
  return campaigns.filter((c) => c.status === 'awaiting-approval');
}

export function actionQueue(campaigns: AgentCampaign[]): AgentCampaign[] {
  return campaigns.filter((c) => c.status === 'approved' || c.status === 'executing');
}

export function verificationQueue(campaigns: AgentCampaign[]): AgentCampaign[] {
  return campaigns.filter((c) => c.status === 'verifying');
}

export function agentStatusSummary(campaigns: AgentCampaign[]): {
  waiting: number;
  active: number;
  verifying: number;
  verified: number;
  failed: number;
} {
  const s = { waiting: 0, active: 0, verifying: 0, verified: 0, failed: 0 };
  for (const c of campaigns) {
    if (c.status === 'awaiting-approval') s.waiting += 1;
    else if (c.status === 'approved' || c.status === 'executing') s.active += 1;
    else if (c.status === 'verifying') s.verifying += 1;
    else if (c.status === 'verified') s.verified += 1;
    else if (c.status === 'failed') s.failed += 1;
  }
  return s;
}

export const AGENT_SIGNAL_META: Record<AgentSignalKind, { label: string; icon: string; tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral' }> = {
  'repeated-bug': { label: 'Repeated bug', icon: 'bug', tone: 'critical' },
  'unstable-module': { label: 'Unstable module', icon: 'activity', tone: 'attention' },
  'ai-rejection': { label: 'AI proposal rejection', icon: 'eye-off', tone: 'attention' },
  'architecture-hotspot': { label: 'Architecture hotspot', icon: 'architecture', tone: 'critical' },
  'mission-bottleneck': { label: 'Mission bottleneck', icon: 'deploy', tone: 'attention' },
  'high-risk-prediction': { label: 'High-risk prediction', icon: 'clipboard', tone: 'attention' },
  'regression-risk': { label: 'Regression risk', icon: 'refresh', tone: 'critical' },
};
