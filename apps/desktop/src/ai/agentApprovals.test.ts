/**
 * agentApprovals — the workspace gate reads the agent's own ledger.
 *
 * A parked agent approval must resolve to a renderable request through
 * the agent ledger (:4320), never through the workflow ledger. Rows
 * that lack what the gate renders resolve to null and the gate stays
 * hidden; unknown states or risks fail closed rather than guessing.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { describe, expect, it } from 'vitest';
import { agentApprovalToRequest, type AgentApprovalRow } from './agentApprovals';

function row(over: Partial<AgentApprovalRow> = {}): AgentApprovalRow {
  return {
    id: 'apr-1',
    state: 'pending',
    summary: 'Run the coding worker',
    requestedAt: '2026-09-21T00:00:00Z',
    items: [{
      invocationId: 'inv-1',
      capabilityId: 'agent.delegate',
      title: 'Delegate',
      detail: 'research task',
      risk: 'high',
      irreversible: false,
    }],
    ...over,
  };
}

describe('agentApprovalToRequest', () => {
  it('maps a complete agent row to the gate request', () => {
    const req = agentApprovalToRequest(row());
    expect(req).not.toBeNull();
    expect(req!.id).toBe('apr-1');
    expect(req!.state).toBe('pending');
    expect(req!.requestedAt).toBe('2026-09-21T00:00:00Z');
    expect(req!.items[0].capabilityId).toBe('agent.delegate');
    expect(req!.items[0].risk).toBe('high');
  });

  it('returns null when the row lacks items or a capability', () => {
    expect(agentApprovalToRequest(row({ items: [] }))).toBeNull();
    expect(agentApprovalToRequest(row({ items: undefined }))).toBeNull();
    expect(agentApprovalToRequest(row({ items: [{ capabilityId: '' }] }))).toBeNull();
  });

  it('returns null when requestedAt or summary is missing', () => {
    expect(agentApprovalToRequest(row({ requestedAt: undefined }))).toBeNull();
    expect(agentApprovalToRequest(row({ summary: undefined as unknown as string }))).toBeNull();
  });

  it('fails closed on unknown state or risk instead of guessing', () => {
    expect(agentApprovalToRequest(row({ state: 'mysterious' }))).toBeNull();
    expect(agentApprovalToRequest(row({ items: [{ capabilityId: 'agent.delegate', risk: 'extreme' }] }))).toBeNull();
  });

  it('passes settled states through so the gate shows the outcome', () => {
    expect(agentApprovalToRequest(row({ state: 'granted' }))!.state).toBe('granted');
    expect(agentApprovalToRequest(row({ state: 'denied' }))!.state).toBe('denied');
  });
});
