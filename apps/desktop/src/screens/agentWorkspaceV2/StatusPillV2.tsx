/**
 * Agent Workspace v2 — timeline status vocabulary + pill.
 * =====================================================================
 * The 11 states of spec §5, each with its own color and dot. Active
 * (in-flight) states breathe; settled states never do — a pulsing dot
 * on a finished card reads as work still happening.
 *
 * The mapping from backend vocabulary (task state, outcome) to these
 * 11 lives in `timelineModel.ts`; this file is purely presentational.
 */
import { cn } from '@aura/core';
import type { V2Status } from './types';

export const V2_STATUS_LABEL: Record<V2Status, string> = {
  planning: 'Planning',
  queued: 'Queued',
  analyzing: 'Analyzing',
  coding: 'Coding',
  researching: 'Researching',
  executing: 'Executing',
  'waiting-for-approval': 'Waiting for approval',
  verifying: 'Verifying',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Border / background / ink classes per status. */
const STYLE: Record<V2Status, string> = {
  planning: 'border-[rgba(122,92,255,0.5)] bg-[rgba(122,92,255,0.14)] text-neon-violet',
  queued: 'border-line bg-[rgba(13,19,38,0.55)] text-text-muted',
  analyzing: 'border-[rgba(255,181,71,0.5)] bg-[rgba(255,181,71,0.12)] text-neon-warning',
  coding: 'border-[rgba(77,124,255,0.55)] bg-[rgba(77,124,255,0.14)] text-neon-blue',
  researching: 'border-[rgba(122,92,255,0.5)] bg-[rgba(122,92,255,0.14)] text-neon-violet',
  executing: 'border-[rgba(32,211,255,0.5)] bg-[rgba(32,211,255,0.12)] text-neon-cyan',
  'waiting-for-approval': 'border-[rgba(255,181,71,0.55)] bg-[rgba(255,181,71,0.14)] text-neon-warning',
  verifying: 'border-[rgba(32,211,255,0.5)] bg-[rgba(32,211,255,0.12)] text-neon-cyan',
  completed: 'border-[rgba(31,211,138,0.5)] bg-[rgba(31,211,138,0.12)] text-neon-success',
  failed: 'border-[rgba(255,93,122,0.55)] bg-[rgba(255,93,122,0.12)] text-neon-danger',
  cancelled: 'border-[rgba(255,181,71,0.5)] bg-[rgba(255,181,71,0.1)] text-neon-warning',
};

const DOT: Record<V2Status, string> = {
  planning: 'bg-neon-violet',
  queued: 'bg-text-subtle',
  analyzing: 'bg-neon-warning',
  coding: 'bg-neon-blue',
  researching: 'bg-neon-violet',
  executing: 'bg-neon-cyan',
  'waiting-for-approval': 'bg-neon-warning',
  verifying: 'bg-neon-cyan',
  completed: 'bg-neon-success',
  failed: 'bg-neon-danger',
  cancelled: 'bg-neon-warning',
};

/** States that represent active work — their dots breathe. */
const LIVE: readonly V2Status[] = [
  'planning', 'analyzing', 'coding', 'researching', 'executing', 'verifying',
];

export function V2StatusPill({ status, live }: { status: V2Status; live?: boolean }) {
  const isLive = live ?? LIVE.includes(status);
  return (
    <span
      data-testid="v2-status-pill"
      data-status={status}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold tracking-wide',
        STYLE[status],
      )}
    >
      <span
        aria-hidden
        className={cn('h-1.5 w-1.5 rounded-full', DOT[status], isLive && 'aura-breathe')}
      />
      {V2_STATUS_LABEL[status]}
    </span>
  );
}
