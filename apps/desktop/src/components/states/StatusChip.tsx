/**
 * StatusChip — one vocabulary for every state a run can be in.
 * ==================================================================
 * Workflow runs, node records, automation runs and action records each
 * have their own state strings on the wire. To the reader they are one
 * question — "what is happening to my work?" — and this component is the
 * one place that answers it, so a state never means two things on two
 * screens and a tone never drifts per surface.
 *
 * The canonical vocabulary lives HERE. The per-domain label tables in
 * `screens/workflows/runs.ts` encode domain nuance (a superseded
 * awaiting-approval leg reads "Continued") and stay there; where that
 * nuance applies, the caller passes `label`/`tone` explicitly and this
 * component renders it rather than re-deriving it.
 *
 * Active states (running, retrying, queued) carry a pulsing dot — the one
 * piece of motion a list of runs is allowed, because it answers "is this
 * moving or stuck?" without a refresh.
 */

import { cn } from '@aura/core';
import type { StatusTone } from '@aura/core';

/** The tone classes mirror `Badge`, so chips and badges sit together. */
const TONE_CLASSES: Record<StatusTone, string> = {
  positive: 'bg-positive/10 text-positive dark:bg-positive/15',
  attention: 'bg-attention/12 text-attention dark:bg-attention/15',
  critical: 'bg-danger/10 text-danger dark:bg-danger/15',
  info: 'bg-accent-50 text-accent-700 dark:bg-accent/15 dark:text-accent-200',
  neutral: 'bg-surface-active text-text-muted',
};

export interface StatusVocab {
  label: string;
  tone: StatusTone;
  /** True when the state is still moving — the dot pulses. */
  active?: boolean;
}

/**
 * Every state string the app renders, from all three vocabularies
 * (`RunState` + `NodeState`, `AutomationRunStatus`, `RunActionStatus`).
 * Synonyms across domains (succeeded/completed) tone identically, so a
 * workflow run and the automation run that started it read as the same
 * outcome even though their engines spell it differently.
 */
export const STATUS_VOCAB: Record<string, StatusVocab> = {
  /* workflow run + node states */
  queued: { label: 'Queued', tone: 'neutral', active: true },
  running: { label: 'Running', tone: 'info', active: true },
  'awaiting-approval': { label: 'Waiting for you', tone: 'attention', active: true },
  succeeded: { label: 'Succeeded', tone: 'positive' },
  failed: { label: 'Failed', tone: 'critical' },
  cancelled: { label: 'Cancelled', tone: 'attention' },
  'timed-out': { label: 'Timed out', tone: 'critical' },
  // Denial is the policy engine working, not the workflow breaking.
  denied: { label: 'Denied by policy', tone: 'attention' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  /* automation run + action states */
  paused: { label: 'Paused', tone: 'neutral' },
  retrying: { label: 'Retrying', tone: 'attention', active: true },
  completed: { label: 'Completed', tone: 'positive' },
  pending: { label: 'Pending', tone: 'neutral', active: true },
  /* schedule health, surfaced on Home and the automation library */
  missed: { label: 'Missed while closed', tone: 'attention' },
  error: { label: 'Error', tone: 'critical' },
};

export interface StatusChipProps {
  /** A state string from any of the run/action vocabularies. */
  state: string;
  /** Override the derived label (e.g. "Continued" for a superseded leg). */
  label?: string;
  /** Override the derived tone. */
  tone?: StatusTone;
  /** Force the pulse on/off; defaults to the vocabulary's `active`. */
  pulse?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function StatusChip({ state, label, tone, pulse, size = 'md', className }: StatusChipProps) {
  const vocab = STATUS_VOCAB[state] ?? { label: state, tone: 'neutral' as StatusTone };
  const resolvedTone = tone ?? vocab.tone;
  const pulsing = pulse ?? vocab.active ?? false;
  return (
    <span
      // The state is announced as text; role="status" would make screen
      // readers re-announce every chip in a list on every render.
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium tracking-wide',
        size === 'sm' ? 'px-2 py-0.5 text-[10.5px]' : 'px-2.5 py-0.5 text-[11px]',
        TONE_CLASSES[resolvedTone],
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-current', pulsing && 'animate-pulse')} aria-hidden />
      {label ?? vocab.label}
    </span>
  );
}
