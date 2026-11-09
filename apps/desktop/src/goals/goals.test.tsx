import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GoalControls } from './GoalControls';
import { cycleText, goalForProject, goalStatusText, type Goal } from './goalClient';

const goal = (over: Partial<Goal>): Goal => ({
  goalId: 'goal-a', goal: 'Ship it', projectPath: '/p', mode: 'until-achieved', state: 'running',
  cycles: [], currentSessionId: null, nextAttemptAt: null, note: null, createdAt: '2026-11-09T00:00:00Z',
  ...over,
});

describe('goal controls', () => {
  it('shows the active goal of this project before an older one', () => {
    const goals = [goal({ goalId: 'goal-old', state: 'achieved' }), goal({ goalId: 'goal-now' }),
      goal({ goalId: 'goal-other', projectPath: '/q' })];
    expect(goalForProject(goals, '/p')?.goalId).toBe('goal-now');
    expect(goalForProject(goals, '/none')).toBeNull();
  });

  it('describes progress in plain words', () => {
    expect(goalStatusText(goal({ currentSessionId: 'agt-1', cycles: [{ n: 1, kind: 'replan' }] }))).toBe('Working · cycle 2');
    expect(goalStatusText(goal({ state: 'waiting', note: 'waiting 60 s before the next attempt' })))
      .toBe('Waiting · waiting 60 s before the next attempt');
    expect(goalStatusText(goal({ state: 'stopped', cycles: [{ n: 1, kind: 'replan' }] }))).toBe('Stopped · 1 cycle');
    // Months-long goals keep only recent cycles; the count comes from the totals.
    expect(goalStatusText(goal({ state: 'stopped', cycles: [{ n: 4312, kind: 'replan' }],
      stats: { cycles: 4312, achieved: 1, wait: 40, replan: 4271 } }))).toBe('Stopped · 4,312 cycles');
    expect(cycleText({ n: 2, outcome: 'failed', failureReason: 'no-model', kind: 'wait' }))
      .toBe('Cycle 2: failed (no-model), will retry');
  });

  it('renders a closed Goal button', () => {
    const html = renderToStaticMarkup(<GoalControls projectPath="/p" />);
    expect(html).toContain('data-testid="goal-controls"');
    expect(html).toContain('>Goal</button>');
  });
});
