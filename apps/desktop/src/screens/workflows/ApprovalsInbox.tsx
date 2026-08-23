/**
 * ApprovalsInbox — everything waiting on a human decision.
 * ==================================================================
 * This is a *placement*, not a second approval system. Each item renders
 * through `missions/ApprovalGate` — the same component Mission Control
 * uses, with the same five required facts — and every decision goes to
 * `POST /fabric/approvals/:id/decide`, which derives the grant from the
 * request the service stored. Nothing here can name a capability.
 *
 * Ordering is by consequence, not by arrival: irreversible first, then
 * high risk, then the rest. Someone with ten pending requests must be
 * able to find the one that matters in about a second.
 */

import { useEffect, useMemo } from 'react';
import { Badge, Icon } from '@aura/ui';
import type { ApprovalRequest, RiskLevel } from '../../ai/fabricClient';
import { pendingApprovals, useFabric } from '../../data/useFabric';
import { ApprovalGate } from '../missions/ApprovalGate';
import { EmptyState } from '../../components/EmptyState';

const RISK_WEIGHT: Record<RiskLevel, number> = { high: 3, medium: 2, low: 1 };

/** Consequence-first ordering. */
function rank(a: ApprovalRequest): number {
  const item = a.items[0];
  if (!item) return 0;
  return (item.irreversible ? 100 : 0) + RISK_WEIGHT[item.risk] * 10;
}

export function ApprovalsInbox() {
  const approvals = useFabric((s) => s.approvals);
  const deciding = useFabric((s) => s.deciding);
  const decideError = useFabric((s) => s.decideError);
  const reachable = useFabric((s) => s.reachable);
  const decide = useFabric((s) => s.decide);
  const watch = useFabric((s) => s.watchApprovals);

  useEffect(() => watch(), [watch]);

  const pending = useMemo(
    () => pendingApprovals(approvals).sort((a, b) => rank(b) - rank(a) || a.requestedAt.localeCompare(b.requestedAt)),
    [approvals],
  );
  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <header className="mb-5">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">Approvals</h2>
        <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-text-muted">
          Actions the Capability Fabric stopped for a human decision. Approving here resumes the work that asked;
          declining records the reason in the audit trail.
        </p>
      </header>

      {reachable === false && (
        <div className="mb-4 rounded-xl border border-attention/40 bg-attention/5 px-4 py-3">
          <div className="flex items-center gap-2">
            <Icon name="bell" size={13} className="text-attention" />
            <span className="text-[12px] font-semibold text-text">The local service is not answering</span>
          </div>
          <p className="mt-1 text-[11.5px] text-text-muted">
            Pending approvals cannot be read. This list is not empty because there is nothing waiting — it is empty
            because AURA cannot see. Start the service with <code className="rounded bg-surface-active px-1">npm run ai</code>.
          </p>
        </div>
      )}

      {decideError && (
        <div className="mb-4 rounded-xl border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
          {decideError}
        </div>
      )}

      {pending.length === 0 && reachable !== false ? (
        <EmptyState
          icon="shield"
          title="Nothing is waiting on you"
          description="When a governed action needs authorization, it appears here and in the run that raised it."
        />
      ) : (
        <div className="space-y-3">
          {pending.map((a) => (
            <div key={a.id} className="rounded-xl border border-line bg-canvas p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-semibold text-text">{a.summary}</span>
                {a.missionId && <Badge tone="info">from a mission</Badge>}
                <span className="ml-auto text-[10.5px] text-text-subtle">
                  {new Date(a.requestedAt).toLocaleString()}
                </span>
              </div>
              <ApprovalGate request={a} busy={deciding === a.id} onDecide={decide} />
            </div>
          ))}
        </div>
      )}

      <p className="mt-6 text-[10.5px] leading-relaxed text-text-subtle">
        Only requests still awaiting a decision are listed: the service's approvals endpoint returns pending requests
        and nothing else, so a decided one leaves this list rather than moving to a history section. What was decided,
        by whom and why lives in the Capability Fabric's audit trail.{' '}
      </p>
      <p className="mt-2 text-[10.5px] leading-relaxed text-text-subtle">
        Requests reach this list from anywhere the Fabric gates an action — a workflow's governed node, an agent step
        asking for a tool, or a mission task. Answering one here is the same decision as answering it inside the run
        that raised it; there is one approval store and this is a view onto it.
      </p>
    </div>
  );
}
