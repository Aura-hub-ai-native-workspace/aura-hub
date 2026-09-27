import { cn } from '@aura/core';

/**
 * Every status this workspace can honestly show.
 *
 * The first eight are the mission timeline's original vocabulary. The
 * rest were added for the AURA Agent run, and each one restates a state
 * the backend actually reports — a parked task, a denied invocation, a
 * task that ran but did not verify. None of them is a presentation-only
 * mood: if AURA cannot tell the difference, neither can this pill.
 */
export type StepStatus =
  | 'idle'
  | 'planning'
  | 'analyzing'
  | 'coding'
  | 'generating'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'waiting'
  | 'awaiting-approval'
  | 'correcting'
  | 'verifying'
  | 'verified'
  | 'unverified'
  | 'denied'
  | 'skipped'
  | 'cancelled';

const STYLE: Record<StepStatus, string> = {
  idle: 'border-line bg-white/5 text-text-muted',
  planning: 'border-[rgba(122,92,255,0.5)] bg-[rgba(122,92,255,0.14)] text-ws-ink-violet',
  analyzing: 'border-[rgba(255,181,71,0.5)] bg-[rgba(255,181,71,0.12)] text-ws-warn',
  coding: 'border-[rgba(77,124,255,0.55)] bg-[rgba(77,124,255,0.14)] text-ws-ink-blue',
  generating: 'border-[rgba(122,92,255,0.5)] bg-[rgba(122,92,255,0.14)] text-ws-ink-violet',
  executing: 'border-[rgba(32,211,255,0.5)] bg-[rgba(32,211,255,0.12)] text-ws-ink-blue',
  completed: 'border-[rgba(31,211,138,0.5)] bg-[rgba(31,211,138,0.12)] text-ws-ok',
  failed: 'border-[rgba(255,93,122,0.55)] bg-[rgba(255,93,122,0.12)] text-ws-bad',
  waiting: 'border-line bg-white/5 text-text-muted',
  'awaiting-approval': 'border-[rgba(255,181,71,0.55)] bg-[rgba(255,181,71,0.14)] text-ws-warn',
  correcting: 'border-[rgba(255,181,71,0.5)] bg-[rgba(255,181,71,0.1)] text-ws-warn',
  verifying: 'border-[rgba(32,211,255,0.5)] bg-[rgba(32,211,255,0.12)] text-ws-ink-blue',
  verified: 'border-[rgba(31,211,138,0.5)] bg-[rgba(31,211,138,0.12)] text-ws-ok',
  unverified: 'border-[rgba(255,181,71,0.55)] bg-[rgba(255,181,71,0.12)] text-ws-warn',
  denied: 'border-[rgba(255,93,122,0.55)] bg-[rgba(255,93,122,0.12)] text-ws-bad',
  skipped: 'border-line bg-white/5 text-text-muted',
  cancelled: 'border-[rgba(255,181,71,0.5)] bg-[rgba(255,181,71,0.1)] text-ws-warn',
};

const DOT: Record<StepStatus, string> = {
  idle: 'bg-text-subtle',
  planning: 'bg-neon-violet',
  analyzing: 'bg-neon-warning',
  coding: 'bg-neon-blue',
  generating: 'bg-neon-violet',
  executing: 'bg-neon-cyan',
  completed: 'bg-neon-success',
  failed: 'bg-neon-danger',
  waiting: 'bg-text-subtle',
  'awaiting-approval': 'bg-neon-warning',
  correcting: 'bg-neon-warning',
  verifying: 'bg-neon-cyan',
  verified: 'bg-neon-success',
  unverified: 'bg-neon-warning',
  denied: 'bg-neon-danger',
  skipped: 'bg-text-subtle',
  cancelled: 'bg-neon-warning',
};

export const STATUS_LABEL: Record<StepStatus, string> = {
  idle: 'Idle',
  planning: 'Planning',
  analyzing: 'Analyzing',
  coding: 'Coding',
  generating: 'Generating',
  executing: 'Executing',
  completed: 'Completed',
  failed: 'Failed',
  waiting: 'Waiting',
  'awaiting-approval': 'Awaiting approval',
  correcting: 'Correcting',
  verifying: 'Verifying',
  verified: 'Verified',
  unverified: 'Not verified',
  denied: 'Denied',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

/** Luminous status pill with live dot while work is in flight. */
export function StatusPill({ status, live }: { status: StepStatus; live?: boolean }) {
  // Settled states never breathe: a pulsing dot on a finished task reads
  // as work still happening.
  const SETTLED: StepStatus[] = [
    'idle', 'completed', 'failed', 'verified', 'unverified', 'denied',
    'skipped', 'cancelled', 'waiting', 'awaiting-approval',
  ];
  const isLive = live ?? !SETTLED.includes(status);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold tracking-wide',
        STYLE[status],
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', DOT[status], isLive && 'aura-breathe')} />
      {STATUS_LABEL[status]}
    </span>
  );
}
