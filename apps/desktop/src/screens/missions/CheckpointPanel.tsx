/**
 * CheckpointPanel — the mission's four human gates, drawn as a stepper:
 *   planning → execution → review → completion.
 * The planning gate owns the Approve/Reject Plan controls; the review
 * gate owns the Pass/Reject mission review controls. Nothing proceeds
 * past a gate until a human passes it.
 */
import { useState } from 'react';
import { Button, Icon } from '@aura/ui';
import type { IconName } from '@aura/ui';
import type { CheckpointState, ExecutionStatus, MissionApproval } from '../../ai/missionClient';
import { fmtClock } from './missionMeta';

const CP_ICON: Record<string, IconName> = {
  planning: 'shield', execution: 'activity', review: 'eye', completion: 'check',
};

const CP_COLOR: Record<string, string> = {
  'not-started': 'var(--line-strong)',
  pending: 'var(--accent)',
  passed: 'var(--positive)',
  failed: 'var(--danger)',
  skipped: 'var(--text-subtle)',
};

export function CheckpointPanel({
  checkpoints, executionStatus, approval, onApprove, onRejectPlan, onReview,
}: {
  checkpoints: CheckpointState[];
  executionStatus: ExecutionStatus;
  approval: MissionApproval;
  onApprove: () => void;
  onRejectPlan: () => void;
  onReview: (pass: boolean, note?: string) => void;
}) {
  const [note, setNote] = useState('');
  const activeKey = executionStatus === 'reviewing' ? 'review' : executionStatus === 'running' || executionStatus === 'paused' ? 'execution' : executionStatus === 'completed' ? 'completion' : 'planning';

  return (
    <div className="rounded-xl border border-line bg-canvas p-4">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-text">Mission checkpoints</span>
        <span className="text-[11px] text-text-subtle">{checkpoints.filter((c) => c.status === 'passed').length}/{checkpoints.length} passed</span>
      </div>

      <ol className="mt-4 grid grid-cols-4 gap-1">
        {checkpoints.map((cp, i) => {
          const color = CP_COLOR[cp.status] ?? 'var(--line-strong)';
          const active = cp.key === activeKey && (cp.status === 'pending' || cp.status === 'not-started');
          return (
            <li key={cp.key} className="relative">
              <div className="flex flex-col items-center gap-1.5">
                <span className="grid h-9 w-9 place-items-center rounded-full border bg-surface" style={{ borderColor: color, color, boxShadow: active ? `0 0 0 4px ${color}22` : undefined }}>
                  {cp.status === 'passed' ? <Icon name="check" size={15} /> : <Icon name={CP_ICON[cp.key]} size={15} />}
                </span>
                <div className="text-center">
                  <div className="text-[10.5px] font-medium text-text">{cp.label}</div>
                  <div className="text-[9.5px] text-text-subtle">{cp.at ? fmtClock(cp.at) : cp.status === 'passed' ? 'passed' : cp.status}</div>
                </div>
                {cp.note && <p className="text-center text-[9.5px] leading-tight text-text-muted">{cp.note}</p>}
              </div>
              {i < checkpoints.length - 1 && (
                <span className="absolute left-1/2 top-[18px] h-px w-full bg-line" style={{ background: cp.status === 'passed' ? 'var(--positive)' : 'var(--line)' }} />
              )}
            </li>
          );
        })}
      </ol>

      {executionStatus === 'idle' && approval.status === 'pending' && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-accent/25 bg-accent/5 px-3 py-2">
          <span className="text-[11.5px] text-text-muted">Review the plan, then approve it before any task can run.</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={onRejectPlan}>Reject Plan</Button>
            <Button size="sm" variant="primary" icon="check" onClick={onApprove}>Approve Plan</Button>
          </div>
        </div>
      )}

      {executionStatus === 'reviewing' && (
        <div className="mt-4 rounded-lg border border-line bg-surface p-3">
          <div className="flex items-center gap-2">
            <Icon name="eye" size={14} className="text-accent" />
            <span className="text-[12px] font-medium text-text">Mission review checkpoint</span>
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional notes on what was delivered…"
            rows={2}
            className="mt-2 w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-text outline-none transition-colors focus:border-accent"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => onReview(false, note || undefined)}>Reject</Button>
            <Button size="sm" variant="primary" icon="check" onClick={() => onReview(true, note || undefined)}>Pass Review</Button>
          </div>
        </div>
      )}
    </div>
  );
}
