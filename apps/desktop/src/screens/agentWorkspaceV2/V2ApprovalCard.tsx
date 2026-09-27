import { useCallback, useEffect, useState } from 'react';
import { centralAgentClient } from '../../ai/centralAgentClient';
import { agentApprovalToRequest, type AgentApprovalRow } from '../../ai/agentApprovals';
import type { ApprovalRequest } from '../../ai/fabricClient';
import { ApprovalGate } from '../missions/ApprovalGate';

/**
 * Resolve one approval id against both ledger lists. Pending wins
 * (a live question outranks its history); a spent id resolves to its
 * settled record; anything else is null — the card says the record
 * is gone instead of loading forever. Pure, so it is unit-tested.
 */
export function resolveV2Approval(
  approvals: AgentApprovalRow[],
  decided: AgentApprovalRow[],
  approvalId: string,
): ApprovalRequest | null {
  const row =
    approvals.find((r) => r.id === approvalId) ??
    decided.find((r) => r.id === approvalId);
  return row ? agentApprovalToRequest(row) : null;
}

/**
 * V2ApprovalCard — the approval handoff for Agent Workspace v2.
 *
 * A v2 run that requires approval must never strand the user: the run
 * parks server-side and the timeline says "waiting", but without a
 * decision surface the work is stuck. This card closes that gap by
 * reusing the EXISTING approval interface (`ApprovalGate`) against
 * the EXISTING ledger (`centralAgentClient.pendingApprovals`), inside
 * the LEFT user-interaction panel — the right panel takes no input
 * by design, so the gate lives where the composer lives.
 *
 * Resolution contract (same tri-state as the neon workspace):
 *   • undefined — not yet asked → "Loading…" (transient only);
 *   • request   — pending or settled → the existing gate, which shows
 *                 Approve/Decline for pending and a state badge after;
 *   • null      — asked and the ledger has no such record → an honest
 *                 "no longer available" note, never infinite loading.
 * Decisions go through `centralAgentClient.approve` (single-use,
 * server-spent) and the resumed result flows back into the run via
 * `onDecided`, so the timeline keeps filling from the same stream.
 */
export function V2ApprovalCard({
  sessionId,
  approvalId,
  onDecided,
}: {
  sessionId: string | null;
  approvalId: string | null;
  onDecided: (next: unknown) => void;
}) {
  const [request, setRequest] = useState<ApprovalRequest | null | undefined>(undefined);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!approvalId) {
      setRequest(undefined);
      return;
    }
    // No in-flight guard here by design: React StrictMode mounts,
    // unmounts and remounts in dev, and a ref-based guard would treat
    // the remount as a duplicate and block the only real resolution
    // forever. Ledger reads are idempotent, so overlapping fetches
    // converge instead of corrupting.
    let cancelled = false;
    void (async () => {
      try {
        const res = await centralAgentClient.pendingApprovals();
        if (cancelled) return;
        setRequest(resolveV2Approval(res.approvals ?? [], res.decided ?? [], approvalId));
      } catch {
        // Ledger unreachable: stay undefined so the card keeps
        // "Loading…" and a later approval id retries — writing null
        // here would misreport a dead backend as a settled record.
        if (!cancelled) setRequest(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [approvalId]);

  const decide = useCallback(
    async (id: string, granted: boolean, reason?: string) => {
      if (!sessionId || deciding) return;
      setDeciding(true);
      setError(null);
      try {
        const res = await centralAgentClient.approve(sessionId, approvalId ?? id, granted, reason);
        onDecided(res.result);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'the decision did not reach AURA');
      } finally {
        setDeciding(false);
      }
    },
    [sessionId, approvalId, deciding, onDecided],
  );

  if (!approvalId) return null;

  return (
    <div data-testid="v2-approval" data-approval-id={approvalId}>
      {request === undefined && (
        <p className="px-1 text-[12px] text-text-subtle">Loading the authorization details…</p>
      )}
      {request === null && (
        <p className="px-1 text-[12px] text-text-subtle" data-testid="v2-approval-unavailable">
          This authorization record is no longer available — it was decided, consumed, or cleared
          by a restart. Nothing is waiting on you here; send the request again if the work still
          needs doing.
        </p>
      )}
      {request && (
        <ApprovalGate request={request} busy={deciding || !sessionId} onDecide={decide} />
      )}
      {error && (
        <p role="alert" className="mt-2 text-[11.5px] text-ws-bad" data-testid="v2-approval-error">
          {error}
        </p>
      )}
    </div>
  );
}
