import { useCallback, useEffect, useState } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import { centralAgentClient } from '../../../ai/centralAgentClient';
import { GlassCard } from './GlassCard';

/**
 * ApprovalRequestCard — the human decision, inside the run that needs it.
 *
 * The neon workspace could park a run and then offer no way to answer it:
 * AgentRunPanel rendered `awaiting-approval` as a status and stopped
 * there, so the only way forward was another surface. This card closes
 * that gap using the SAME ledger every other surface spends —
 * `centralAgentClient.approve` — and adds no approval state of its own.
 *
 * What it shows is what the ledger holds. The capability, target and risk
 * come from the agent's own pending-approval record; the worker and task
 * come from the parked plan row. When the ledger has not yet published
 * the detail, the card says so rather than inventing a plausible action —
 * an approval prompt that describes the wrong thing is worse than one
 * that admits it is still loading.
 *
 * A decision is single-use. The backend refuses a replay with 409, and
 * that refusal is surfaced verbatim instead of being retried.
 */

interface ApprovalItem {
  capabilityId: string;
  title: string;
  detail: string;
  risk: string;
  irreversible: boolean;
}

const RISK_TONE: Record<string, string> = {
  high: 'text-neon-danger',
  medium: 'text-neon-warning',
  low: 'text-neon-success',
};

export function ApprovalRequestCard({
  sessionId,
  approvalId,
  worker,
  taskId,
  taskDescription,
  scopePaths,
  busy,
  onDecided,
}: {
  sessionId: string;
  approvalId: string;
  /** Worker AURA selected for the parked task, from worker.lifecycle. */
  worker: string;
  taskId: string;
  taskDescription: string;
  /** Declared task scope, when the plan stated one. */
  scopePaths: string[];
  busy: boolean;
  onDecided: (result: unknown) => void;
}) {
  const [items, setItems] = useState<ApprovalItem[] | null>(null);
  const [summary, setSummary] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read the ledger record behind this id. No polling: the id is already
  // known, and the record does not change until this decision spends it.
  useEffect(() => {
    let cancelled = false;
    centralAgentClient
      .pendingApprovals()
      .then((res) => {
        if (cancelled) return;
        const row = (res.approvals ?? []).find((a) => a.id === approvalId);
        setItems(row ? row.items ?? [] : []);
        setSummary(row?.summary ?? '');
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [approvalId]);

  const decide = useCallback(
    async (granted: boolean) => {
      if (deciding) return;
      setDeciding(true);
      setError(null);
      try {
        const res = await centralAgentClient.approve(
          sessionId,
          approvalId,
          granted,
          granted ? 'approved in the workspace' : 'denied in the workspace',
        );
        onDecided(res.result);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'the decision did not reach AURA');
      } finally {
        setDeciding(false);
      }
    },
    [sessionId, approvalId, deciding, onDecided],
  );

  const disabled = deciding || busy;

  return (
    <GlassCard className="p-3" tint="amber" data-testid="agent-approval" data-approval-id={approvalId}>
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md border border-[rgba(255,181,71,0.5)] bg-[rgba(255,181,71,0.12)] text-neon-warning">
          <Icon name="shield" size={13} />
        </span>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-neon-warning">
          Approval required
        </p>
      </div>

      <dl className="space-y-1 text-[12px]">
        <Row label="Worker" value={worker || 'not yet assigned'} />
        <Row label="Task" value={taskId} hint={taskDescription} />
        {items === null && <Row label="Action" value="reading the approval record…" />}
        {items?.length === 0 && (
          <Row label="Action" value="the ledger did not publish a detail for this request" />
        )}
        {items?.map((it) => (
          <div key={it.capabilityId + it.title} className="flex gap-2">
            <dt className="w-[68px] shrink-0 text-text-subtle">Action</dt>
            <dd className="min-w-0 flex-1 text-text">
              <span className="font-medium">{it.capabilityId}</span>
              {it.title && <span className="text-text-muted"> — {it.title}</span>}
              {it.detail && (
                <span className="block truncate text-[11px] text-text-muted">{it.detail}</span>
              )}
              <span className={cn('text-[11px]', RISK_TONE[it.risk] ?? 'text-text-subtle')}>
                {it.risk} risk{it.irreversible ? ' · irreversible' : ''}
              </span>
            </dd>
          </div>
        ))}
        <Row
          label="Scope"
          value={scopePaths.length > 0 ? scopePaths.join(', ') : 'no scope was declared for this task'}
        />
      </dl>

      {summary && <p className="mt-2 text-[11px] text-text-muted">{summary}</p>}

      {error && (
        <p role="alert" className="mt-2 text-[11.5px] text-neon-danger" data-testid="agent-approval-error">
          {error}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void decide(true)}
          disabled={disabled}
          data-testid="agent-approve"
          className="neon-focus flex-1 rounded-md border border-[rgba(31,211,138,0.5)] bg-[rgba(31,211,138,0.12)] px-3 py-1.5 text-[12px] font-semibold text-neon-success transition-colors hover:bg-[rgba(31,211,138,0.2)] disabled:opacity-50"
        >
          {deciding ? 'Recording…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={() => void decide(false)}
          disabled={disabled}
          data-testid="agent-deny"
          className="neon-focus flex-1 rounded-md border border-[rgba(255,93,122,0.5)] bg-[rgba(255,93,122,0.1)] px-3 py-1.5 text-[12px] font-semibold text-neon-danger transition-colors hover:bg-[rgba(255,93,122,0.18)] disabled:opacity-50"
        >
          Deny
        </button>
      </div>

      <p className="mt-2 text-[10.5px] text-text-subtle">
        Nothing has run. This decision is single-use and is spent by the Fabric itself.
      </p>
    </GlassCard>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-[68px] shrink-0 text-text-subtle">{label}</dt>
      <dd className="min-w-0 flex-1 text-text">
        {value}
        {hint && <span className="block truncate text-[11px] text-text-muted">{hint}</span>}
      </dd>
    </div>
  );
}
