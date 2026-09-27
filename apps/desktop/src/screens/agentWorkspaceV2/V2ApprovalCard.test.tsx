/**
 * V2ApprovalCard — a parked v2 run never strands the user.
 *
 * The v2 right timeline takes no input by design, so when a run parks
 * on an approval the decision surface must live in the LEFT panel.
 * This card reuses the EXISTING ApprovalGate against the EXISTING
 * ledger: `resolveV2Approval` maps a parked id to its request from
 * the pending list first, then the decided list, else null (rendered
 * as an honest "no longer available" note, never infinite loading).
 * Decisions go through `centralAgentClient.approve` (single-use,
 * server-spent) and resume the run via `onDecided`.
 *
 * Rendered with `renderToStaticMarkup`; the resolver is pure and
 * pinned directly. Run with `npm run test:front` from the repo root.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { AgentApprovalRow } from '../../ai/agentApprovals';
import { V2ApprovalCard, resolveV2Approval } from './V2ApprovalCard';

function row(over: Partial<AgentApprovalRow> = {}): AgentApprovalRow {
  return {
    id: 'apr-v2-1',
    state: 'pending',
    summary: 'Delegate to coding agent needs your go-ahead.',
    requestedAt: '2026-09-27T00:00:00Z',
    items: [{
      invocationId: 'inv-1',
      capabilityId: 'agent.delegate',
      title: 'Delegate to coding agent',
      detail: 'build the catalog page',
      risk: 'high',
      irreversible: true,
    }],
    ...over,
  };
}

describe('resolveV2Approval', () => {
  it('prefers the pending record for a live question', () => {
    const req = resolveV2Approval([row()], [row({ state: 'granted' })], 'apr-v2-1');
    expect(req).not.toBeNull();
    expect(req!.state).toBe('pending');
    expect(req!.items[0].capabilityId).toBe('agent.delegate');
  });

  it('falls back to the settled record for a spent id', () => {
    const req = resolveV2Approval([], [row({ state: 'denied' })], 'apr-v2-1');
    expect(req).not.toBeNull();
    expect(req!.state).toBe('denied');
  });

  it('returns null for an unknown id (card shows unavailable, not loading)', () => {
    expect(resolveV2Approval([], [], 'apr-nope')).toBeNull();
    expect(resolveV2Approval([row({ id: 'apr-other' })], [], 'apr-nope')).toBeNull();
  });

  it('fails closed on malformed rows', () => {
    expect(resolveV2Approval([{ id: 'apr-v2-1' } as AgentApprovalRow], [], 'apr-v2-1')).toBeNull();
  });
});

describe('V2ApprovalCard shell', () => {
  it('renders nothing without a parked approval', () => {
    const markup = renderToStaticMarkup(
      <V2ApprovalCard sessionId="agt-aaaaaaaaaaaa" approvalId={null} onDecided={vi.fn()} />,
    );
    expect(markup).toBe('');
  });

  it('shows loading (with the id for correlation) while resolving', () => {
    const markup = renderToStaticMarkup(
      <V2ApprovalCard sessionId="agt-aaaaaaaaaaaa" approvalId="apr-v2-1" onDecided={vi.fn()} />,
    );
    expect(markup).toContain('data-testid="v2-approval"');
    expect(markup).toContain('data-approval-id="apr-v2-1"');
    expect(markup).toContain('Loading the authorization details');
  });
});
