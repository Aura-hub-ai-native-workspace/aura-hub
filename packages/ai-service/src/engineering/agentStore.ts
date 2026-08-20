/**
 * agentStore — the autonomous agent's state, on disk.
 * ==================================================================
 * Was `apps/desktop/src/ops/agentStore.ts`, a zustand store persisted to
 * `localStorage` under `aura.ops.agent`. That made the agent's entire
 * memory — every open campaign, every approval it was waiting on, every
 * timeline entry proving what it did and why — a property of one browser
 * profile in one window. Close the window and the agent forgot it had
 * asked you anything.
 *
 * Same state machine, same dedupe-by-signal-key rule, same timeline.
 * Written atomically to `<AURA_HOME>/agent/state.json`, so it outlives
 * the window, the renderer, and the service process.
 */

import { homePath, readJsonFile, writeJsonFile } from '../persist';

export type AgentSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AgentSignalKind =
  | 'repeated-bug' | 'unstable-module' | 'ai-rejection' | 'architecture-hotspot'
  | 'mission-bottleneck' | 'high-risk-prediction' | 'regression-risk';

export type AgentCampaignStatus =
  | 'observed' | 'planned' | 'awaiting-approval' | 'approved'
  | 'executing' | 'verifying' | 'verified' | 'failed' | 'dismissed';

export interface AgentVerifyTarget {
  kind: 'mission-completion' | 'diagnosis-count';
  file?: string;
  missionId?: string;
  /** Baseline captured at propose-time. */
  before: number;
  /** Re-measured at verify-time; pass iff within the expected bound. */
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

export interface AgentState {
  enabled: boolean;
  campaigns: AgentCampaign[];
  timeline: AgentTimelineEntry[];
}

/** Timeline entries kept. The same cap the browser store used. */
const TIMELINE_CAP = 200;

const STATE_FILE = () => homePath('agent', 'state.json');

let seq = 0;
function nid(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Change notifications, so the spine can publish what moved. */
export type AgentChange =
  | { type: 'campaign'; campaign: AgentCampaign }
  | { type: 'timeline'; entry: AgentTimelineEntry }
  | { type: 'enabled'; enabled: boolean };

export class AgentStore {
  private state: AgentState;
  private listeners = new Set<(change: AgentChange) => void>();

  constructor() {
    const loaded = readJsonFile<Partial<AgentState>>(STATE_FILE(), {});
    this.state = {
      // An agent that silently re-enables itself after a crash would be a
      // governance problem, so an explicit `false` survives; a missing
      // file is a first run, and the shipped default is on-but-gated
      // (nothing runs before a human approves a campaign).
      enabled: loaded.enabled !== false,
      campaigns: Array.isArray(loaded.campaigns) ? loaded.campaigns : [],
      timeline: Array.isArray(loaded.timeline) ? loaded.timeline : [],
    };
  }

  onChange(listener: (change: AgentChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private announce(change: AgentChange): void {
    for (const fn of this.listeners) {
      try { fn(change); } catch { /* a listener's failure is not the agent's */ }
    }
  }

  private persist(): void {
    writeJsonFile(STATE_FILE(), this.state);
  }

  snapshot(): AgentState {
    return {
      enabled: this.state.enabled,
      campaigns: this.state.campaigns.map((c) => ({ ...c })),
      timeline: this.state.timeline.map((t) => ({ ...t })),
    };
  }

  get enabled(): boolean { return this.state.enabled; }

  setEnabled(enabled: boolean): void {
    if (this.state.enabled === enabled) return;
    this.state.enabled = enabled;
    this.persist();
    this.announce({ type: 'enabled', enabled });
  }

  campaigns(): AgentCampaign[] { return this.state.campaigns.map((c) => ({ ...c })); }

  get(id: string): AgentCampaign | null {
    return this.state.campaigns.find((c) => c.id === id) ?? null;
  }

  /**
   * Enqueue a campaign for human approval.
   *
   * Refuses (returns null) when the same signal already has a campaign —
   * the rule that stops a re-observed signal from producing a second
   * request for the same decision.
   */
  propose(input: AgentCampaignInput): AgentCampaign | null {
    if (this.state.campaigns.some((c) => c.signalKey === input.signalKey)) return null;
    const now = new Date().toISOString();
    const campaign: AgentCampaign = {
      ...input,
      id: nid('camp'),
      status: 'awaiting-approval',
      missionId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.campaigns = [campaign, ...this.state.campaigns];
    this.persist();
    this.announce({ type: 'campaign', campaign });
    this.log(campaign.id, 'propose', 'Improvement proposed', campaign.signalLabel, 'agent');
    return { ...campaign };
  }

  setStatus(
    id: string,
    status: AgentCampaignStatus,
    opts: { note?: string; missionId?: string } = {},
  ): AgentCampaign | null {
    const campaign = this.state.campaigns.find((c) => c.id === id);
    if (!campaign) return null;
    campaign.status = status;
    campaign.updatedAt = new Date().toISOString();
    if (opts.note !== undefined) campaign.note = opts.note;
    if (opts.missionId !== undefined) campaign.missionId = opts.missionId;
    if (status === 'approved') campaign.approvedAt = campaign.updatedAt;
    if (status === 'executing') campaign.executedAt = campaign.updatedAt;
    if (status === 'verified' || status === 'failed') campaign.verifiedAt = campaign.updatedAt;
    this.persist();
    this.announce({ type: 'campaign', campaign: { ...campaign } });
    return { ...campaign };
  }

  /** The human's yes. Nothing the agent does happens before this. */
  approve(id: string, by = 'user'): AgentCampaign | null {
    const campaign = this.state.campaigns.find((c) => c.id === id);
    if (!campaign || campaign.status !== 'awaiting-approval') return null;
    this.log(id, 'approve', 'Approved by human', 'The improvement mission may now be created.', 'human');
    return this.setStatus(id, 'approved', { note: `Approved by ${by}.` });
  }

  dismiss(id: string): AgentCampaign | null {
    const campaign = this.state.campaigns.find((c) => c.id === id);
    if (!campaign) return null;
    this.log(id, 'dismiss', 'Dismissed by human', 'The proposal was declined; nothing runs.', 'human');
    return this.setStatus(id, 'dismissed');
  }

  setVerification(id: string, pass: boolean, note: string, after?: number): AgentCampaign | null {
    const campaign = this.state.campaigns.find((c) => c.id === id);
    if (!campaign) return null;
    if (campaign.verify) campaign.verify = { ...campaign.verify, after };
    this.log(id, 'verify', pass ? 'Verified' : 'Not verified', note, 'agent');
    return this.setStatus(id, pass ? 'verified' : 'failed', { note });
  }

  log(campaignId: string, stage: string, label: string, detail: string, actor: AgentTimelineEntry['actor'] = 'agent'): AgentTimelineEntry {
    const entry: AgentTimelineEntry = {
      id: nid('tl'), campaignId, at: new Date().toISOString(), stage, label, detail, actor,
    };
    this.state.timeline = [entry, ...this.state.timeline].slice(0, TIMELINE_CAP);
    this.persist();
    this.announce({ type: 'timeline', entry });
    return entry;
  }

  openCampaignCount(): number {
    return this.state.campaigns.filter((c) =>
      c.status === 'awaiting-approval' || c.status === 'approved' || c.status === 'executing' || c.status === 'verifying',
    ).length;
  }

  signalKeys(): Set<string> {
    return new Set(this.state.campaigns.map((c) => c.signalKey));
  }
}
