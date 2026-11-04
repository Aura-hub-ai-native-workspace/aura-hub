/**
 * The Planner's task editor rules that must hold whatever the UI looks like:
 * a task never moves above something it depends on, and Send to Workspace
 * stays unavailable for a plan Workspace could not carry out.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MissionRecord } from '../../ai/missionClient';

vi.mock('../../workspace/useWorkers', () => ({
  useWorkerStore: (sel: (s: unknown) => unknown) => sel({ workers: [], refresh: () => Promise.resolve() }),
}));

const { canMove, moved, PlanView } = await import('./PlanView');

const t = (id: string, dependencies: string[] = []) => ({ id, dependencies });

describe('reordering', () => {
  const tasks = [t('a'), t('b', ['a']), t('c'), t('d', ['c', 'b'])];
  it('never lets a task pass something it depends on, or that depends on it', () => {
    expect(canMove(tasks, 1, -1)).toBe(false); // b depends on a
    expect(canMove(tasks, 0, 1)).toBe(false);  // a is depended on by b
    expect(canMove(tasks, 3, -1)).toBe(false); // d depends on c
    expect(canMove(tasks, 1, 1)).toBe(true);   // b and c are independent
    expect(canMove(tasks, 0, -1)).toBe(false); // no room above the first
    expect(canMove(tasks, 3, 1)).toBe(false);  // none below the last
  });
  it('swaps only when allowed', () => {
    expect(moved(tasks, 1, 1).map((x) => x.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(moved(tasks, 1, -1)).toBe(tasks); // refused: same array back
  });
});

function plan(tasks: Partial<MissionRecord['goalGraph'] extends infer G ? (G extends { tasks: (infer T)[] } ? T : never) : never>[], extra: Partial<MissionRecord> = {}): MissionRecord {
  return {
    id: 'm1', projectId: 'p', text: 'Add a short NOTES.md file', createdAt: '2026-10-20T00:00:00Z', revision: 2,
    classification: null, intent: null, strategy: null, risk: null, review: null, quality: null,
    signals: {} as never, approval: { status: 'approved' }, taskRuns: [],
    goalGraph: { goals: [], tasks: tasks.map((x, i) => ({
      id: `t${i}`, goalId: 'g', focusAreaId: 'f', title: 'Create NOTES.md', description: '', kind: 'file-operation',
      targetFile: 'NOTES.md', mode: 'new-file', priority: 'medium', dependencies: [], estimatedDurationMinutes: 5,
      confidence: 0.9, risk: 'low', owner: 'ai', automationLevel: 'automatic', status: 'pending', worker: 'aura', ...x })) as never },
    ...extra,
  } as MissionRecord;
}

const planner = (mission: MissionRecord, handoff = { phase: 'idle', message: null }) => ({
  active: mission, creating: false, saving: false, error: null, issues: null, run: null, handoff,
  replan: () => undefined, savePlan: () => undefined, sendToWorkspace: () => undefined,
}) as never;

/** The opening tag of the Send to Workspace button, whatever its attribute order. */
const sendButton = (html: string): string => {
  const at = html.indexOf('data-testid="send-to-workspace"');
  return html.slice(html.lastIndexOf('<button', at), html.indexOf('>', at) + 1);
};

describe('PlanView', () => {
  it('shows the plan, its acceptance criteria, history and context, with Send to Workspace at the bottom', () => {
    const html = renderToStaticMarkup(<PlanView planner={planner(plan([{ expectedOutput: 'NOTES.md exists' }], {
      acceptance: ['NOTES.md exists'],
      context: { text: 'Decision: keep it short', scope: 'p', records: 3, sources: [{ title: 'Why notes', url: 'https://example.test/n' }] },
      history: [{ revision: 1, at: '2026-10-19T00:00:00Z', acceptance: [], tasks: [{ id: 't0', title: 'Old title', description: '', targetFile: null, files: [], dependencies: [] }] }],
    }))} />);
    expect(html).toContain('Acceptance criteria');
    expect(html).toContain('What this plan is based on (3 saved notes, 1 source)');
    expect(html).toContain('Decision: keep it short');
    expect(html).toContain('href="https://example.test/n"');
    expect(html).toContain('Earlier versions (1)');
    expect(html).toContain('Old title');
    expect(html).toContain('Send to Workspace');
    expect(html.indexOf('Acceptance criteria')).toBeLessThan(html.indexOf('Send to Workspace'));
    expect(html).not.toMatch(/Mission Control|Approve Plan/);
  });

  it('does not demand a target file: a connected coding agent is selected when the plan is sent', () => {
    const html = renderToStaticMarkup(<PlanView planner={planner(plan([{ targetFile: null, worker: 'aura' }]))} />);
    expect(sendButton(html)).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(html).not.toContain('needs a target file');
    expect(html).toContain('Laya selects a connected coding agent');
  });

  it('still disables Send for a plan with no tasks, and says why', () => {
    const html = renderToStaticMarkup(<PlanView planner={planner(plan([]))} />);
    expect(sendButton(html)).toMatch(/\sdisabled(=|\s|>)/);
    expect(html).toContain('Add at least one task');
  });

  it('is enabled for an actionable plan', () => {
    const html = renderToStaticMarkup(<PlanView planner={planner(plan([{}]))} />);
    expect(sendButton(html)).not.toMatch(/\sdisabled(=|\s|>)/);
  });
});
