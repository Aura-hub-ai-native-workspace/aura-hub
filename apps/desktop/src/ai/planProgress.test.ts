import { describe, expect, it } from 'vitest';
import { foldPlanEvent, planProgressText, type BuildingDraft } from './planProgress';

const start: BuildingDraft = { status: 'building' };
const stage = (s: string) => ({ type: 'stage', stage: s, status: 'start', at: 't' }) as never;
const beat = (elapsedMs: number, receivedChars: number) => ({ type: 'progress', stage: 'plan', elapsedMs, deadlineMs: 480000, receivedChars }) as never;

describe('chat plan progress shows only what the Planner reported', () => {
  it('says nothing specific before any event, and invents no percentage', () => {
    expect(planProgressText(start)).toBe('Starting…');
    expect(planProgressText({ ...start, stage: 'plan', elapsedMs: 40_000, receivedChars: 1200 })).not.toMatch(/%/);
  });
  it('follows the real stages', () => {
    let d = foldPlanEvent(start, stage('context'));
    expect(planProgressText(d)).toBe('Reading the project…');
    d = foldPlanEvent(d, stage('plan'));
    expect(planProgressText(d)).toContain('waiting for the model');
    d = foldPlanEvent(d, stage('check'));
    expect(planProgressText(d)).toBe('Checking the plan…');
  });
  it('reports real elapsed time and characters from the heartbeat', () => {
    let d = foldPlanEvent(foldPlanEvent(start, stage('plan')), beat(5000, 0));
    expect(planProgressText(d)).toContain("first words (5s)");
    d = foldPlanEvent(d, beat(55_000, 2766));
    expect(planProgressText(d)).toBe('Writing the plan — the model has written 2,766 characters so far (55s).');
  });
  it('ignores events it does not understand', () => {
    expect(foldPlanEvent({ ...start, stage: 'plan' }, { type: 'signals', signals: {} } as never)).toEqual({ ...start, stage: 'plan' });
    expect(foldPlanEvent(start, stage('mystery'))).toEqual(start);
  });
});
