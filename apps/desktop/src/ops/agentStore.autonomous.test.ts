/**
 * The Agent Center runs its campaigns autonomously under policy. A proposal is
 * queued to run; nothing waits for a person. Campaigns saved while the human
 * approval queue existed are queued the same way when they load.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCampaignInput } from './agentStore';

const KEY = 'aura.ops.agent';

/* The test environment has no browser storage; an in-memory stand-in is enough
   for the store's persistence, and is installed before the store is imported. */
const memory = new Map<string, string>();
const storage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, String(v)); },
  removeItem: (k: string) => { memory.delete(k); },
  clear: () => { memory.clear(); },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

const input = (over: Partial<AgentCampaignInput> = {}): AgentCampaignInput => ({
  signalKey: 'pattern:repeated-bug:src/a.ts',
  kind: 'repeated-bug',
  projectId: 'p1',
  target: 'src/a.ts',
  signalLabel: 'Repeated bug in a.ts',
  severity: 'high',
  rationale: 'The same bug keeps coming back.',
  plan: 'Fix the bug and add a regression check.',
  expectedOutcome: 'No new diagnoses for a.ts.',
  evidence: ['diagnosis-1'],
  reasoning: [],
  verify: null,
  ...over,
} as AgentCampaignInput);

async function freshStore() {
  vi.resetModules();
  return (await import('./agentStore')).useAgentStore;
}

describe('a proposal runs under policy; nothing waits for a person', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('a new proposal is queued to run, with no approval state or step', async () => {
    const store = await freshStore();
    const campaign = store.getState().propose(input());
    expect(campaign).not.toBeNull();
    expect(campaign!.status).toBe('approved');
    const stages = store.getState().timeline.filter((t) => t.campaignId === campaign!.id).map((t) => t.stage);
    expect(stages).toContain('approved');
    expect(stages.join(' ')).not.toMatch(/approval/);
  });

  it('a saved proposal from the old approval queue loads queued, not waiting', async () => {
    storage.setItem(KEY, JSON.stringify({
      enabled: true,
      timeline: [],
      campaigns: [{ id: 'c1', status: 'awaiting-approval', signalKey: 'k', projectId: 'p1', kind: 'repeated-bug', target: 't', signalLabel: 's', severity: 'high', rationale: '', plan: '', expectedOutcome: '', evidence: [], reasoning: [], verify: null, missionId: null, createdAt: 'x', updatedAt: 'x' }],
    }));
    const store = await freshStore();
    expect(store.getState().campaigns[0].status).toBe('approved');
  });

  it('the store exposes no approve action and no waiting count', async () => {
    const store = await freshStore();
    const state = store.getState() as unknown as Record<string, unknown>;
    expect(state.approve).toBeUndefined();
    const { agentStatusSummary } = await import('./agentStore');
    expect(Object.keys(agentStatusSummary([]))).not.toContain('waiting');
  });
});
