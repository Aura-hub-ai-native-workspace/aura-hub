/**
 * AgentPhaseStrip — where the agent is, in the product's six phases.
 * =====================================================================
 *   INTENT → PLAN → PERMISSION → EXECUTION → VERIFICATION → RESULT
 *
 * Driven ONLY by real signals: the backend's SSE event types and the
 * terminal result's outcome. There is no timer-driven "progress" and no
 * inference from text — a phase lights up because an event said so, and
 * never in an order the events did not state.
 *
 * COMPLETED ≠ VERIFIED here too: RESULT lights on any terminal outcome;
 * whether it reads as success is the result card's business.
 */

import { cn } from '@aura/core';
import type { AgentResult } from '../../ai/centralAgentClient';

export type LifecycleSignal =
  | 'idle'
  | 'intent'
  | 'plan'
  | 'permission'
  | 'execution'
  | 'verification'
  | 'result';

const ORDER: LifecycleSignal[] = [
  'intent', 'plan', 'permission', 'execution', 'verification', 'result',
];

const LABELS: Record<LifecycleSignal, string> = {
  idle: 'Idle',
  intent: 'Intent',
  plan: 'Plan',
  permission: 'Permission',
  execution: 'Execution',
  verification: 'Verification',
  result: 'Result',
};

/**
 * Map one real event type onto the phase it demonstrates. Event types are
 * the backend's vocabulary (`docs/AURA_CENTRAL_AGENT_API.md`); unknown
 * types map to nothing — they never guess a phase.
 */
export function signalForEvent(type: string): LifecycleSignal | null {
  switch (type) {
    case 'session.started':
    case 'intent.compiled':
      return 'intent';
    case 'intent.clarification-needed':
      return 'permission'; // the agent is waiting on YOU to shape intent
    case 'plan.created':
    case 'capability.discovery':
    case 'authority.checked':
    case 'workflow.compiled':
    case 'workflow.validated':
      return 'plan';
    case 'approval.required':
      return 'permission';
    case 'execution.started':
    case 'invocation.observed':
      return 'execution';
    case 'verification.completed':
      return 'verification';
    case 'result.ready':
    case 'agent.failed':
    case 'agent.cancelled':
      return 'result';
    default:
      return null;
  }
}

/** Highest reached phase from the events actually seen. */
export function phaseFromEvents(types: Iterable<string>): LifecycleSignal {
  let reached: LifecycleSignal = 'intent';
  for (const t of types) {
    const s = signalForEvent(t);
    if (s && ORDER.indexOf(s) > ORDER.indexOf(reached)) reached = s;
  }
  return reached;
}

/** Terminal result → the strip's final resting phase. */
export function phaseForResult(outcome: AgentResult['outcome']): LifecycleSignal {
  if (outcome === 'awaiting-approval' || outcome === 'needs-clarification') return 'permission';
  if (outcome === 'denied') return 'permission';
  // completed / failed / timeout / cancelled all REACHED verification or
  // stopped short honestly; the strip shows reach, not sentiment.
  return 'result';
}

export function AgentPhaseStrip({
  current,
  outcome,
}: {
  current: LifecycleSignal;
  outcome?: AgentResult['outcome'];
}) {
  const terminal =
    outcome !== undefined &&
    outcome !== 'awaiting-approval' &&
    outcome !== 'needs-clarification';
  const currentIndex = ORDER.indexOf(current);

  return (
    <ol
      className="flex flex-wrap items-center gap-x-1 gap-y-1"
      aria-label="Agent lifecycle"
    >
      {ORDER.map((phase, i) => {
        const reached = i <= currentIndex;
        const isCurrent = i === currentIndex && !terminal;
        return (
          <li key={phase} className="flex items-center gap-1">
            {i > 0 && (
              <span
                aria-hidden
                className={cn('h-px w-4', reached ? 'bg-accent/50' : 'bg-line')}
              />
            )}
            <span
              aria-current={isCurrent ? 'step' : undefined}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide',
                isCurrent && 'bg-accent/12 text-accent dark:bg-accent/15',
                reached && !isCurrent && 'text-text-muted',
                !reached && 'text-text-subtle/60',
              )}
            >
              {isCurrent && (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
              )}
              {LABELS[phase]}
            </span>
          </li>
        );
      })}
      <li className="sr-only">
        {terminal
          ? `Finished at ${LABELS[current]}.`
          : `Currently in ${LABELS[current]}.`}
      </li>
    </ol>
  );
}
