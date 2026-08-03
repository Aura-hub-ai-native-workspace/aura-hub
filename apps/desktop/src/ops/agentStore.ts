/**
 * agentStore — the Autonomous Engineering Agent's state + persistence.
 * ==================================================================
 * The agent is an autonomous, but *always human-gated* improvement
 * loop. It observes real signals in Engineering Memory / Learning /
 * Diagnosis, reasons about them, plans an improvement, and requests
 * approval. Only after explicit human approval does it act — and the
 * only thing it ever does is create a real improvement mission through
 * Mission Control, whose own plan-approval + per-task-acceptance gates
 * stay intact. The agent never edits code directly.
 *
 * Every campaign carries a full reasoning trace and every transition
 * is written to the agent timeline, so all actions are explainable,
 * traceable, auditable and replayable.
 *
 * Persistence: campaigns + timeline are stored under `aura.ops.agent`
 * and survive restart. A campaign is deduplicated by a stable signal
 * key (the same signal never produces two campaigns while open).
 */
import { create } from 'zustand';

export type AgentSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AgentSignalKind =
  | 'repeated-bug'
  | 'unstable-module'
  | 'ai-rejection'
  | 'architecture-hotspot'
  | 'mission-bottleneck'
  | 'high-risk-prediction'
  | 'regression-risk';

export type AgentCampaignStatus =
  | 'observed'
  | 'planned'
  | 'awaiting-approval'
  | 'approved'
  | 'executing'
  | 'verifying'
  | 'verified'
  | 'failed'
  | 'dismissed';

export interface AgentVerifyTarget {
  /** What the campaign's success is measured against. */
  kind: 'mission-completion' | 'diagnosis-count';
  file?: string;
  missionId?: string;
  /** Baseline value captured at propose-time (e.g. diagnosis count). */
  before: number;
  /** Value re-measured at verify-time; pass iff within expected bound. */
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

export interface AgentCampaignInput {
  signalKey: string;
  kind: AgentSignalKind;
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
}

const KEY = 'aura.ops.agent';
const CAP = 200;

let seq = 0;
const nid = (p: string) => `${p}${Date.now().toString(36)}${(seq += 1).toString(36)}`;

function load(): { campaigns: AgentCampaign[]; timeline: AgentTimelineEntry[]; enabled: boolean } {
  if (typeof localStorage === 'undefined') return { campaigns: [], timeline: [], enabled: true };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { campaigns: [], timeline: [], enabled: true };
    const parsed = JSON.parse(raw) as { campaigns?: AgentCampaign[]; timeline?: AgentTimelineEntry[]; enabled?: boolean };
    return {
      campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns : [],
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
      enabled: parsed.enabled !== false,
    };
  } catch {
    return { campaigns: [], timeline: [], enabled: true };
  }
}

function persist(campaigns: AgentCampaign[], timeline: AgentTimelineEntry[], enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ campaigns, timeline, enabled }));
  } catch {
    /* storage full / blocked — agent stays in-memory this session */
  }
}

interface AgentState {
  enabled: boolean;
  campaigns: AgentCampaign[];
  timeline: AgentTimelineEntry[];
  /** Guards the execute pipeline — one mission at a time. */
  pipelineBusy: boolean;

  setEnabled: (enabled: boolean) => void;
  setPipelineBusy: (busy: boolean) => void;
  propose: (input: AgentCampaignInput) => AgentCampaign | null;
  setStatus: (id: string, status: AgentCampaignStatus, opts?: { note?: string; missionId?: string; memoryId?: string }) => void;
  approve: (id: string) => void;
  dismiss: (id: string) => void;
  setVerification: (id: string, pass: boolean, note: string, after?: number) => void;
  log: (campaignId: string, stage: string, label: string, detail: string, actor?: 'agent' | 'human' | 'system') => void;
  clear: () => void;
}

export const useAgentStore = create<AgentState>((set, get) => {
  const commit = (campaigns: AgentCampaign[], timeline: AgentTimelineEntry[], enabled: boolean) => {
    persist(campaigns.slice(0, CAP), timeline.slice(-500), enabled);
    return { campaigns: campaigns.slice(0, CAP), timeline: timeline.slice(-500) };
  };

  return {
    ...load(),
    pipelineBusy: false,

    setEnabled: (enabled) => set((s) => ({ enabled, ...commit(s.campaigns, s.timeline, enabled) })),

    setPipelineBusy: (busy) => set({ pipelineBusy: busy }),

    propose: (input) => {
      const { campaigns, timeline, enabled } = get();
      if (campaigns.some((c) => c.signalKey === input.signalKey && c.status !== 'dismissed')) return null;
      const now = new Date().toISOString();
      const campaign: AgentCampaign = {
        id: nid('campaign-'),
        status: 'observed',
        ...input,
        missionId: null,
        createdAt: now,
        updatedAt: now,
      };
      const tl = [...timeline, {
        id: nid('tl-'),
        campaignId: campaign.id,
        at: now,
        stage: 'observed',
        label: 'Signal observed',
        detail: input.signalLabel,
        actor: 'agent' as const,
      }];
      const next = { ...campaign, status: 'awaiting-approval' as const, updatedAt: new Date().toISOString() };
      tl.push({
        id: nid('tl-'),
        campaignId: next.id,
        at: new Date().toISOString(),
        stage: 'awaiting-approval',
        label: 'Approval requested',
        detail: input.plan,
        actor: 'agent' as const,
      });
      set({ ...commit([next, ...campaigns], tl, enabled) });
      return next;
    },

    setStatus: (id, status, opts) => {
      const { campaigns, timeline, enabled } = get();
      const now = new Date().toISOString();
      const updated = campaigns.map((c) =>
        c.id === id
          ? {
              ...c,
              status,
              updatedAt: now,
              approvedAt: status === 'approved' ? (c.approvedAt ?? now) : c.approvedAt,
              executedAt: status === 'executing' ? (c.executedAt ?? now) : c.executedAt,
              verifiedAt: status === 'verified' || status === 'failed' ? now : c.verifiedAt,
              missionId: opts?.missionId ?? c.missionId,
              memoryId: opts?.memoryId ?? c.memoryId,
              note: opts?.note ?? c.note,
            }
          : c,
      );
      set({ ...commit(updated, timeline, enabled) });
    },

    approve: (id) => {
      const { campaigns, timeline, enabled } = get();
      const now = new Date().toISOString();
      const updated = campaigns.map((c) =>
        c.id === id && c.status === 'awaiting-approval'
          ? { ...c, status: 'approved' as const, approvedAt: now, updatedAt: now }
          : c,
      );
      const tl = [...timeline, {
        id: nid('tl-'),
        campaignId: id,
        at: now,
        stage: 'approved',
        label: 'Approved by human',
        detail: 'The improvement plan was approved — the agent may create the improvement mission.',
        actor: 'human' as const,
      }];
      set({ ...commit(updated, tl, enabled) });
    },

    dismiss: (id) => {
      const { campaigns, timeline, enabled } = get();
      const now = new Date().toISOString();
      const updated = campaigns.map((c) =>
        c.id === id && (c.status === 'awaiting-approval' || c.status === 'planned')
          ? { ...c, status: 'dismissed' as const, updatedAt: now, note: 'Dismissed by the user' }
          : c,
      );
      const tl = [...timeline, {
        id: nid('tl-'),
        campaignId: id,
        at: now,
        stage: 'dismissed',
        label: 'Dismissed',
        detail: 'The user declined to proceed with this improvement.',
        actor: 'human' as const,
      }];
      set({ ...commit(updated, tl, enabled) });
    },

    setVerification: (id, pass, note, after) => {
      const { campaigns, timeline, enabled } = get();
      const now = new Date().toISOString();
      const updated = campaigns.map((c) => {
        if (c.id !== id) return c;
        return {
          ...c,
          status: (pass ? 'verified' : 'failed') as AgentCampaignStatus,
          updatedAt: now,
          verifiedAt: now,
          note,
          verify: c.verify ? { ...c.verify, after: after ?? c.verify.after } : c.verify,
        };
      });
      const tl = [...timeline, {
        id: nid('tl-'),
        campaignId: id,
        at: now,
        stage: pass ? 'verified' : 'failed',
        label: pass ? 'Verified' : 'Verification failed',
        detail: note,
        actor: 'system' as const,
      }];
      set({ ...commit(updated, tl, enabled) });
    },

    log: (campaignId, stage, label, detail, actor = 'agent') => {
      const { timeline, campaigns, enabled } = get();
      const now = new Date().toISOString();
      const entry: AgentTimelineEntry = { id: nid('tl-'), campaignId, at: now, stage, label, detail, actor };
      set({ ...commit(campaigns, [...timeline, entry], enabled) });
    },

    clear: () => {
      const { enabled } = get();
      set({ ...commit([], [], enabled) });
    },
  };
});

/* ── derived queue helpers (pure, used by the UI) ──────────────────── */

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
