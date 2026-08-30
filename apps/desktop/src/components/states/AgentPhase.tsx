/**
 * AgentPhase — what an agent is doing, in words a person can act on.
 * ==================================================================
 * A trace is a ledger of beats; a reader needs a phase. This maps the
 * REAL signals — the node's state, the *kinds* of beats that have
 * arrived, and the stop reason — onto the six phases the product speaks:
 *
 *   PLANNING → EXECUTING → OBSERVING → WAITING FOR YOU → COMPLETED / STOPPED
 *
 * Two hard rules, both from the agent contract:
 *
 *   • No chain-of-thought. Phases derive from beat KINDS and states,
 *     never from beat text — the component cannot leak reasoning even
 *     by accident, because it never reads it.
 *   • Never collapse the endings. A bound, a refusal, a cancellation and
 *     a failure are different facts (see STOP_SENTENCE in agent/types);
 *     the badge keeps them apart with the same tones the chips use.
 *
 * "Waiting for you" is a phase, not a failure: an agent parked on an
 * approval is the governance layer working, and the badge must not read
 * as an error while a person decides.
 */

import { cn } from '@aura/core';
import type { StatusTone } from '@aura/core';
import type { NodeState } from '../../ai/aiClient';
import type { AgentStopReason, BeatKind } from '../../screens/workflows/agent/types';

export type AgentPhase =
  | 'planning'
  | 'executing'
  | 'observing'
  | 'waiting-for-you'
  | 'denied'
  | 'completed'
  | 'stopped';

export interface PhaseVocab {
  label: string;
  tone: StatusTone;
  /** True while the agent is still moving. */
  active?: boolean;
}

export const AGENT_PHASE: Record<AgentPhase, PhaseVocab> = {
  planning: { label: 'Planning', tone: 'info', active: true },
  executing: { label: 'Executing', tone: 'info', active: true },
  observing: { label: 'Observing', tone: 'neutral', active: true },
  'waiting-for-you': { label: 'Waiting for you', tone: 'attention', active: true },
  denied: { label: 'Denied by policy', tone: 'attention' },
  completed: { label: 'Completed', tone: 'positive' },
  stopped: { label: 'Stopped', tone: 'critical' },
};

const lastBeat = (kinds: BeatKind[] | undefined): BeatKind | undefined =>
  kinds && kinds.length ? kinds[kinds.length - 1] : undefined;

/** Which phase the reasoning-side beats represent. */
const THINKING_BEATS: BeatKind[] = ['intent', 'plan', 'proposal'];

export interface AgentPhaseInput {
  /** The node record's state — the engine's own answer. */
  nodeState: NodeState;
  /** Beat kinds that have arrived, oldest first. Absent while queued. */
  beatKinds?: BeatKind[];
  /** The stop reason, once the ledger has one. */
  stopReason?: AgentStopReason;
}

/**
 * Derive the phase. The order of checks is the contract:
 * a terminal state outranks beats (the engine's verdict is final), the
 * approval park outranks activity (a parked agent is waiting, not busy),
 * and the last beat wins among reasoning kinds.
 */
export function agentPhaseOf({ nodeState, beatKinds, stopReason }: AgentPhaseInput): AgentPhase {
  /* 1 — the engine's terminal answers, in their own words. */
  if (nodeState === 'awaiting-approval') return 'waiting-for-you';
  if (nodeState === 'denied' || stopReason === 'denied') return 'denied';
  if (nodeState === 'succeeded' || stopReason === 'completed') return 'completed';
  if (stopReason && stopReason !== 'awaiting-approval') return 'stopped';
  if (nodeState === 'failed' || nodeState === 'cancelled' || nodeState === 'timed-out') return 'stopped';
  if (nodeState === 'skipped' || nodeState === 'queued') return 'planning';

  /* 2 — live reasoning: the latest beat says where the loop is. */
  const last = lastBeat(beatKinds);
  if (last === 'permission' || last === 'decision' || last === 'intervention') return 'waiting-for-you';
  if (last === 'execution') return 'executing';
  if (last === 'observation') return 'observing';
  if (last && THINKING_BEATS.includes(last)) return 'planning';

  /* 3 — running with no beats yet: it is reasoning about the task. */
  return 'planning';
}


const TONE_CLASSES: Record<StatusTone, string> = {
  positive: 'bg-positive/10 text-positive dark:bg-positive/15',
  attention: 'bg-attention/12 text-attention dark:bg-attention/15',
  critical: 'bg-danger/10 text-danger dark:bg-danger/15',
  info: 'bg-accent-50 text-accent-700 dark:bg-accent/15 dark:text-accent-200',
  neutral: 'bg-surface-active text-text-muted',
};

export function AgentPhaseBadge({
  phase,
  label,
  tone,
  className,
}: {
  phase: AgentPhase;
  label?: string;
  tone?: StatusTone;
  className?: string;
}) {
  const vocab = AGENT_PHASE[phase];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide',
        TONE_CLASSES[tone ?? vocab.tone],
        className,
      )}
    >
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-current', vocab.active && 'animate-pulse')}
        aria-hidden
      />
      {label ?? vocab.label}
    </span>
  );
}
