import { cn } from '@aura/core';

export type StepStatus =
  | 'idle'
  | 'planning'
  | 'analyzing'
  | 'coding'
  | 'generating'
  | 'executing'
  | 'completed'
  | 'failed';

const STYLE: Record<StepStatus, string> = {
  idle: 'border-white/10 bg-white/5 text-text-muted',
  planning: 'border-[rgba(122,92,255,0.5)] bg-[rgba(122,92,255,0.14)] text-[#b7a6ff]',
  analyzing: 'border-[rgba(255,181,71,0.5)] bg-[rgba(255,181,71,0.12)] text-neon-warning',
  coding: 'border-[rgba(77,124,255,0.55)] bg-[rgba(77,124,255,0.14)] text-[#8fb0ff]',
  generating: 'border-[rgba(122,92,255,0.5)] bg-[rgba(122,92,255,0.14)] text-[#b7a6ff]',
  executing: 'border-[rgba(32,211,255,0.5)] bg-[rgba(32,211,255,0.12)] text-neon-cyan',
  completed: 'border-[rgba(31,211,138,0.5)] bg-[rgba(31,211,138,0.12)] text-neon-success',
  failed: 'border-[rgba(255,93,122,0.55)] bg-[rgba(255,93,122,0.12)] text-neon-danger',
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
};

/** Luminous status pill with live dot while work is in flight. */
export function StatusPill({ status, live }: { status: StepStatus; live?: boolean }) {
  const isLive = live ?? (status !== 'idle' && status !== 'completed' && status !== 'failed');
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
