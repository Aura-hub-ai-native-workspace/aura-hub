/**
 * planProgress — what the chat says while its plan is being built.
 * ------------------------------------------------------------------
 * Folds the Planner's own mission events (stage starts and the 5-second
 * heartbeat that reports real elapsed time and characters received) into the
 * draft shown in chat. Nothing here is estimated: no percentage, no invented
 * stage. A field is shown only after an event carrying it arrived.
 */
import type { MissionEvent } from './missionClient';

export type PlanStage = 'context' | 'plan' | 'check';

export interface BuildingDraft {
  status: 'building';
  stage?: PlanStage;
  elapsedMs?: number;
  receivedChars?: number;
}

const STAGES = new Set<string>(['context', 'plan', 'check']);

export function foldPlanEvent(draft: BuildingDraft, e: MissionEvent): BuildingDraft {
  if (e.type === 'stage' && e.status === 'start' && STAGES.has(e.stage)) {
    return { ...draft, stage: e.stage as PlanStage };
  }
  if (e.type === 'progress') {
    return { ...draft, stage: 'plan', elapsedMs: e.elapsedMs, receivedChars: e.receivedChars ?? 0 };
  }
  return draft;
}

export function planProgressText(d: BuildingDraft): string {
  if (!d.stage) return 'Starting…';
  if (d.stage === 'context') return 'Reading the project…';
  if (d.stage === 'check') return 'Checking the plan…';
  if (d.elapsedMs === undefined) return 'Writing the plan — waiting for the model…';
  const s = Math.round(d.elapsedMs / 1000);
  return d.receivedChars
    ? `Writing the plan — the model has written ${d.receivedChars.toLocaleString()} characters so far (${s}s).`
    : `Writing the plan — waiting for the model's first words (${s}s).`;
}
