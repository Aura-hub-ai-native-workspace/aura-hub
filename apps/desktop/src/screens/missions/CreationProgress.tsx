/**
 * CreationProgress — the planner's real stages while a plan is being made.
 * Each row reflects a stage event the service actually emitted; nothing
 * advances on a timer.
 */
import { Icon } from '@aura/ui';
import type { CreationStage } from './useMissions';

const STAGES: { key: Exclude<CreationStage, 'idle' | 'done' | 'error'>; label: string; detail: string }[] = [
  { key: 'context', label: 'Reading the project', detail: 'Real signals: structure, hotspots, git state, open plans.' },
  { key: 'plan', label: 'Writing the plan', detail: 'Directly for a one-file goal; otherwise one model call. On a local model this can take a few minutes.' },
  { key: 'check', label: 'Checking the plan', detail: 'Dependencies, loops, and the files the goal names.' },
];

export function CreationProgress({ stage, waiting }: { stage: CreationStage; waiting?: { elapsedMs: number; deadlineMs: number; receivedChars: number } | null }) {
  const current = STAGES.findIndex((s) => s.key === stage);
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="w-full max-w-sm space-y-2.5" aria-live="polite">
        {STAGES.map((s, i) => {
          const state = i < current ? 'done' : i === current ? 'active' : 'waiting';
          return (
            <div key={s.key} className="flex items-start gap-2.5">
              <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${state === 'done' ? 'border-positive text-positive' : state === 'active' ? 'border-accent text-accent' : 'border-line text-text-subtle'}`}>
                {state === 'done' ? <Icon name="check" size={11} /> : <span className={`h-1.5 w-1.5 rounded-full ${state === 'active' ? 'aura-live bg-accent' : 'bg-line-strong'}`} />}
              </span>
              <div>
                <div className={`text-[12.5px] ${state === 'waiting' ? 'text-text-subtle' : 'font-medium text-text'}`}>{s.label}</div>
                {state === 'active' && <div className="text-[11px] text-text-muted">{s.detail}</div>}
                {state === 'active' && s.key === 'plan' && waiting && (
                  <div className="text-[11px] text-text-muted">{waiting.receivedChars > 0
                      ? `The model is writing: ${waiting.receivedChars.toLocaleString()} characters so far (${Math.round(waiting.elapsedMs / 1000)}s).`
                      : `Waiting for the model's first words: ${Math.round(waiting.elapsedMs / 1000)}s. It stops waiting if the model stays silent.`}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
