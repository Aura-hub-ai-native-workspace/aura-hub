/**
 * ApprovalsInbox — everything waiting on a human decision.
 * ==================================================================
 * This is a *placement*, not a second approval system. Each item renders
 * through `missions/ApprovalGate` — the same component Mission Control
 * uses, with the same five required facts — and every decision goes to
 * `POST /fabric/approvals/:id/decide` (Fabric) or
 * `POST /agent/sessions/{sid}/approve` (Agent, routed by the owning
 * sessionId the service parks on the request). Nothing here can name a
 * capability, and an agent item with no session is refused rather than
 * guessed.
 *
 * Ordering is by consequence, not by arrival: irreversible first, then
 * high risk, then the rest. Someone with ten pending requests must be
 * able to find the one that matters in about a second.
 */

import { useMemo, useState } from 'react';
import { Badge, Icon } from '@aura/ui';
import { centralAgentClient } from '../../ai/centralAgentClient';
import type { ApprovalRequest, RiskLevel } from '../../ai/fabricClient';
import { pendingApprovals, useFabric } from '../../data/useFabric';
import { useAgentApprovals } from '../../data/useAgentApprovals';
import { ApprovalGate } from '../missions/ApprovalGate';
import { decisionTarget } from './approvalRouting';

const RISK_WEIGHT: Record<RiskLevel, number> = { high: 3, medium: 2, low: 1 };

/** Consequence-first ordering. */
function rank(a: ApprovalRequest): number {
  const item = a.items[0];
  if (!item) return 0;
  return (item.irreversible ? 100 : 0) + RISK_WEIGHT[item.risk] * 10;
}

/** Tag for source differentiation. */
type ApprovalSource = 'fabric' | 'agent';

export function ApprovalsInbox() {
  const fabricApprovals = useFabric((s) => s.approvals);
  const fabricDeciding = useFabric((s) => s.deciding);
  const fabricDecideError = useFabric((s) => s.decideError);
  const fabricDecide = useFabric((s) => s.decide);
  const fabricReachable = useFabric((s) => s.reachable);
  const { approvals: agentApprovals, loading: agentLoading, error: agentError, refetch: refetchAgent } = useAgentApprovals();
  const [agentDeciding, setAgentDeciding] = useState<string | null>(null);
  const [agentDecideError, setAgentDecideError] = useState<string | null>(null);

  /** Decide through the owning ledger. Agent items need their session —
   * answering against a hardcoded or guessed session could spend another
   * session's grant, so unroutable items fail closed with a reason. */
  async function decideItem(
    a: ApprovalRequest & { source: ApprovalSource },
    granted: boolean,
    reason?: string,
  ): Promise<void> {
    const target = decisionTarget(a);
    if (target.kind === 'fabric') {
      await fabricDecide(a.id, granted, reason);
      return;
    }
    if (target.kind === 'unroutable') {
      setAgentDecideError(target.reason);
      return;
    }
    setAgentDeciding(a.id);
    setAgentDecideError(null);
    try {
      await centralAgentClient.approve(target.sessionId, a.id, granted, reason);
      await refetchAgent();
    } catch (e) {
      setAgentDecideError(e instanceof Error ? e.message : 'Agent decision failed.');
    } finally {
      setAgentDeciding(null);
    }
  }

  // Unify approvals from both sources
  const fabricPending = useMemo(
    () => pendingApprovals(fabricApprovals).map((a) => ({ ...a, source: 'fabric' as ApprovalSource })),
    [fabricApprovals],
  );

  const agentPending = useMemo(
    // Agent-ledger items share the ApprovalRequest shape's required fields
    // after normalization in useAgentApprovals; cast at this one seam.
    () => ((agentApprovals as unknown) as ApprovalRequest[])
      .filter((a) => a.state === 'pending')
      .map((a) => ({ ...a, source: 'agent' as ApprovalSource })),
    [agentApprovals],
  );

  const allPending = useMemo(
    () => [...fabricPending, ...agentPending].sort((a, b) => rank(b) - rank(a) || a.requestedAt.localeCompare(b.requestedAt)),
    [fabricPending, agentPending],
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <header className="mb-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">Approvals</h2>
            <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-text-muted">
              Actions the Capability Fabric or Agent stopped for a human decision. Approving here resumes the work that asked;
              declining records the reason in the audit trail.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {agentLoading && <span className="text-[11px] text-text-muted">Loading agent approvals…</span>}
            {agentError && <span className="text-[11px] text-danger">Agent approvals unavailable</span>}
          </div>
        </div>
      </header>

      {fabricDecideError && (
        <div className="mb-4 rounded-xl border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
          {fabricDecideError}
        </div>
      )}
      {agentDecideError && (
        <div className="mb-4 rounded-xl border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
          {agentDecideError}
        </div>
      )}

      {(fabricReachable === false || agentError) && (
        <div className="mb-4 space-y-2">
          {fabricReachable === false && (
            <div className="rounded-xl border border-attention/40 bg-attention/5 px-4 py-3">
              <div className="flex items-center gap-2">
                <Icon name="bell" size={13} className="text-attention" />
                <span className="text-[12px] font-semibold text-text">Workflow service unreachable</span>
              </div>
              <p className="mt-1 text-[11.5px] text-text-muted">
                Fabric approvals cannot be read. Start the service with{' '}
                <code className="rounded bg-surface-active px-1">npm run ai</code>.
              </p>
            </div>
          )}
          {agentError && (
            <div className="rounded-xl border border-attention/40 bg-attention/5 px-4 py-3">
              <div className="flex items-center gap-2">
                <Icon name="spark" size={13} className="text-attention" />
                <span className="text-[12px] font-semibold text-text">Central Agent approvals unavailable</span>
              </div>
              <p className="mt-1 text-[11.5px] text-text-muted">{agentError}</p>
            </div>
          )}
        </div>
      )}

      {allPending.length === 0 ? (
        <div className="py-10 text-center">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-text-subtle">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3 7 7" />
            <path d="M9 12l2 2 4-4" />
          </svg>
          <h3 className="mt-3 text-[15px] font-semibold text-text">Nothing waiting on you</h3>
          <p className="mt-1 text-[13px] text-text-muted max-w-md mx-auto">
            When a governed action or agent tool needs authorization, it appears here.
            Decide it here or in the run that raised it — same decision, same record.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {allPending.map((a) => (
            <div key={a.id} className="rounded-xl border border-line bg-canvas p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-semibold text-text">{a.summary}</span>
                <Badge tone={a.source === 'agent' ? 'info' : 'neutral'}>
                  {a.source === 'agent' ? 'Agent' : 'Fabric'}
                </Badge>
                {a.missionId && <Badge tone="info">from a mission</Badge>}
                <span className="ml-auto text-[10.5px] text-text-subtle">
                  {new Date(a.requestedAt).toLocaleString()}
                </span>
              </div>
              <ApprovalGate
                request={a}
                busy={a.source === 'fabric' ? fabricDeciding === a.id : agentDeciding === a.id}
                onDecide={(_id, granted, reason) => void decideItem(a, granted, reason)}
              />
            </div>
          ))}
        </div>
      )}

      <p className="mt-6 text-[10.5px] leading-relaxed text-text-subtle">
        Only requests still awaiting a decision are listed: the service's approvals endpoint returns pending requests
        and nothing else, so a decided one leaves this list rather than moving to a history section. What was decided,
        by whom and why lives in the Capability Fabric's audit trail.
      </p>
      <p className="mt-2 text-[10.5px] leading-relaxed text-text-subtle">
        Requests reach this list from anywhere the Fabric gates an action — a workflow's governed node, an agent step
        asking for a tool, or a mission task. Answering one here is the same decision as answering it inside the run
        that raised it; there is one approval store per source and this is a unified view onto them.
      </p>
    </div>
  );
}
