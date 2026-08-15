/**
 * ApprovalGate — the human authorization surface for a gated task.
 * ------------------------------------------------------------------
 * Renders one service-side `ApprovalRequest`. It holds **no approval
 * state of its own**: `state`, `decidedBy` and `consumedAt` all live on
 * the request in the service, this only shows what is there and posts an
 * answer back. That is what makes a refresh harmless — the component is
 * rebuilt from the service's list, not from anything remembered here.
 *
 * The five things a person needs in order to answer honestly are all
 * required to be on screen: which capability, against what target, at
 * what risk, why it is being asked, and what happens either way.
 */
import { useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import type { ApprovalRequest } from '../../ai/fabricClient';
import { RISK_TONE } from './missionMeta';

export interface ApprovalGateProps {
  request: ApprovalRequest;
  busy?: boolean;
  onDecide: (id: string, granted: boolean, reason?: string) => void;
}

export function ApprovalGate({ request, busy, onDecide }: ApprovalGateProps) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const item = request.items[0];
  if (!item) return null;

  const settled = request.state !== 'pending';

  return (
    <div className="mt-2 rounded-lg border border-attention/40 bg-attention/5 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Icon name="shield" size={13} className="text-attention" />
        <span className="text-[12px] font-semibold text-text">Authorization required</span>
        <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text-muted">{item.capabilityId}</code>
        <Badge tone={RISK_TONE[item.risk]}>{item.risk} risk</Badge>
        {item.irreversible && <Badge tone="critical">irreversible</Badge>}
        {settled && <Badge tone="neutral">{request.state}</Badge>}
      </div>

      {request.target && (
        <p className="mt-1.5 text-[11.5px] text-text">
          <span className="text-text-subtle">Target: </span>{request.target}
        </p>
      )}
      <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">{request.summary}</p>
      {item.detail && <p className="mt-0.5 text-[10.5px] text-text-subtle">{item.detail}</p>}

      <dl className="mt-2 space-y-1 text-[10.5px]">
        {request.onAccept && (
          <div className="flex gap-1.5">
            <dt className="shrink-0 font-semibold text-positive">Approve</dt>
            <dd className="text-text-muted">{request.onAccept}</dd>
          </div>
        )}
        {request.onDecline && (
          <div className="flex gap-1.5">
            <dt className="shrink-0 font-semibold text-text-subtle">Decline</dt>
            <dd className="text-text-muted">{request.onDecline}</dd>
          </div>
        )}
      </dl>

      {request.rule && (
        <p className="mt-1.5 text-[10px] text-text-subtle">Gate opened by policy rule <code>{request.rule}</code></p>
      )}

      {!settled && (
        declining ? (
          <div className="mt-2 space-y-2">
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you declining? (recorded in the audit trail)"
              className="w-full rounded border border-line bg-canvas px-2 py-1 text-[11.5px] text-text outline-none focus:border-accent"
            />
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDeclining(false)}>Cancel</Button>
              <Button size="sm" variant="secondary" loading={busy} onClick={() => onDecide(request.id, false, reason.trim() || undefined)}>
                Confirm decline
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDeclining(true)}>Decline</Button>
            <Button size="sm" variant="primary" icon="check" loading={busy} onClick={() => onDecide(request.id, true)}>
              Approve and run
            </Button>
          </div>
        )
      )}
    </div>
  );
}
