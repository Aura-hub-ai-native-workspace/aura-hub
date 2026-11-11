/**
 * ApprovalRequestModal — answering an approval that belongs to no mission.
 * ------------------------------------------------------------------
 * The Fabric raises an approval for anything gated, but only ONE surface
 * could ever answer one: `ApprovalGate` inside Mission Control's task
 * list. That is fine for a task's approval and useless for the rest —
 * `system.install`, the capability that installs a node such as OpenCode,
 * has no mission and no task, so its request had nowhere to be answered.
 * The notification fired, the click did nothing, and the install waited
 * on an answer that no screen could give.
 *
 * So this is the same gate, mounted app-level. It adds no authority: the
 * request comes from `fabricClient.approvals()`, the answer goes to
 * `fabricClient.decide()`, and the policy, the risk and the audit all stay
 * where they already are. It renders `ApprovalGate` rather than a second
 * approval UI, so the five things a person needs in order to answer are
 * the same five things Mission Control shows.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '@aura/core';
import { fabricClient, type ApprovalRequest } from '../ai/fabricClient';
import { ApprovalGate } from '../screens/missions/ApprovalGate';

export function ApprovalRequestModal() {
  const pendingApprovalId = useAppStore((s) => s.pendingApprovalId);
  const setPendingApprovalId = useAppStore((s) => s.setPendingApprovalId);
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    setPendingApprovalId(null);
    setRequest(null);
    setError(null);
  }, [setPendingApprovalId]);

  /* The request is fetched, never passed in. A notification can outlive the
     request it points at — decided in another window, or expired — and the
     honest answer then is to say so rather than render a stale gate. */
  useEffect(() => {
    if (!pendingApprovalId) return;
    let cancelled = false;
    setError(null);
    setRequest(null);
    void fabricClient
      .approvals()
      .then((res) => {
        if (cancelled) return;
        const found = (res.approvals ?? []).find((r) => r.id === pendingApprovalId);
        if (found) setRequest(found);
        else setError('This request is no longer waiting — it may already have been answered.');
      })
      .catch(() => {
        if (!cancelled) setError('Could not reach the AI service to load this request.');
      });
    return () => { cancelled = true; };
  }, [pendingApprovalId]);

  useEffect(() => {
    if (!pendingApprovalId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pendingApprovalId, close]);

  const decide = useCallback((id: string, granted: boolean, reason?: string) => {
    setBusy(true);
    /* A 409 means someone already answered it. That is the outcome the user
       wanted, so it closes like a success rather than surfacing an error. */
    void fabricClient
      .decide(id, granted, reason)
      .then(close)
      .catch(() => setError('The decision could not be recorded. The request is still waiting.'))
      .finally(() => setBusy(false));
  }, [close]);

  if (!pendingApprovalId) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Authorization required"
      data-testid="approval-request-modal"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface p-4 shadow-xl">
        {request
          ? <ApprovalGate request={request} busy={busy} onDecide={decide} />
          : <p className="px-1 py-6 text-center text-[12px] text-text-muted">{error ?? 'Loading request…'}</p>}
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={close}
            className="rounded-md px-2.5 py-1 text-[12px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
