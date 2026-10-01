import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import type { AgentEventFrame } from '../../../ai/centralAgentClient';

/**
 * MissionStageStrip — a 7-stage pipeline progress indicator.
 *
 * Each stage becomes 'done' only when a real backend event proves it.
 * No timers, no interpolation. A stage that has not been seen stays
 * pending — the strip never pretends a stage finished.
 *
 * Driven entirely by AgentEventFrame types from the existing SSE bus.
 */

type StageState = 'pending' | 'active' | 'done' | 'failed';

interface Stage {
  id: string;
  label: string;
  icon: string;
}

const STAGES: Stage[] = [
  { id: 'plan',      label: 'Plan',      icon: 'clipboard' },
  { id: 'workers',   label: 'Workers',   icon: 'cpu' },
  { id: 'exec-plan', label: 'Exec Plan', icon: 'deploy' },
  { id: 'execution', label: 'Execute',   icon: 'command' },
  { id: 'verify',    label: 'Verify',    icon: 'shield' },
  { id: 'evidence',  label: 'Evidence',  icon: 'file' },
  { id: 'done',      label: 'Done',      icon: 'spark' },
];

/** Derive stage states from the events AURA actually emitted. */
export function deriveStageMap(
  events: AgentEventFrame[],
  outcome: string | null,
): Record<string, StageState> {
  const states: Record<string, StageState> = {};
  for (const s of STAGES) states[s.id] = 'pending';

  const types = new Set(events.map((e) => e.type));

  if (types.has('plan.created') || types.has('intent.compiled'))
    states['plan'] = 'done';
  if (types.has('worker.lifecycle') || types.has('capability.discovery'))
    states['workers'] = 'done';
  if (types.has('execution.started') || types.has('workflow.compiled') || types.has('workflow.validated'))
    states['exec-plan'] = 'done';
  if (types.has('invocation.observed'))
    states['execution'] = 'done';
  if (types.has('verification.completed'))
    states['verify'] = 'done';
  if (types.has('result.ready'))
    states['evidence'] = 'done';

  const terminal = outcome != null && outcome !== 'awaiting-approval';
  if (terminal) {
    states['done'] = outcome === 'completed' ? 'done' : 'failed';
  }

  // Activate the next pending stage when work is in flight
  if (!terminal) {
    const order = STAGES.map((s) => s.id);
    let lastDone = -1;
    for (let i = 0; i < order.length; i++) {
      if (states[order[i]] === 'done') lastDone = i;
    }
    const nextIdx = lastDone + 1;
    if (nextIdx < order.length && states[order[nextIdx]] === 'pending') {
      states[order[nextIdx]] = 'active';
    }
  }

  return states;
}

export function MissionStageStrip({
  events,
  outcome,
}: {
  events: AgentEventFrame[];
  outcome: string | null;
}) {
  const stageMap = deriveStageMap(events, outcome);

  return (
    <nav
      data-testid="mission-stage-strip"
      aria-label="Mission pipeline stages"
      className="flex items-center gap-0.5 overflow-x-auto rounded-xl border border-[rgba(125,146,255,0.18)] bg-[rgba(9,13,26,0.55)] px-3 py-2"
    >
      {STAGES.map((stage, i) => {
        const state = stageMap[stage.id] ?? 'pending';
        return (
          <div key={stage.id} className="flex items-center gap-0.5">
            <StageNode stage={stage} state={state} />
            {i < STAGES.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  'mx-0.5 h-px w-5 shrink-0 transition-colors',
                  state === 'done'
                    ? 'bg-[rgba(31,211,138,0.4)]'
                    : 'bg-[rgba(125,146,255,0.15)]',
                )}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}

function StageNode({ stage, state }: { stage: Stage; state: StageState }) {
  const stateAriaLabel =
    state === 'active' ? ' (current)' :
    state === 'done' ? ' (done)' :
    state === 'failed' ? ' (failed)' : '';
  return (
    <div
      data-testid={`stage-${stage.id}`}
      data-state={state}
      aria-label={`${stage.label}${stateAriaLabel}`}
      className="flex min-w-[48px] flex-col items-center gap-0.5"
    >
      <span
        className={cn(
          'grid h-6 w-6 place-items-center rounded-md border transition-all',
          state === 'done' &&
            'border-[rgba(31,211,138,0.45)] bg-[rgba(31,211,138,0.12)] text-neon-success',
          state === 'active' &&
            'border-[rgba(32,211,255,0.55)] bg-[rgba(32,211,255,0.12)] text-neon-cyan',
          state === 'failed' &&
            'border-[rgba(255,93,122,0.45)] bg-[rgba(255,93,122,0.1)] text-neon-danger',
          state === 'pending' &&
            'border-[rgba(125,146,255,0.18)] bg-[rgba(13,19,38,0.4)] text-text-subtle',
        )}
      >
        <Icon name={stage.icon as never} size={11} />
      </span>
      <span
        className={cn(
          'text-[9px] font-semibold tracking-wide',
          state === 'done' && 'text-neon-success',
          state === 'active' && 'text-neon-cyan',
          state === 'failed' && 'text-neon-danger',
          state === 'pending' && 'text-text-subtle',
        )}
      >
        {stage.label}
      </span>
    </div>
  );
}
