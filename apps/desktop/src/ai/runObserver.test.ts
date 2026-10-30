import { describe, expect, it } from 'vitest';
import type { AgentEventFrame, ExecutionReport } from './centralAgentClient';
import { completionLine, EMPTY_RUN, foldRunEvent, seedFromReport, unfinishedCheckState, type RunView } from './runObserver';

let n = 0;
const frame = (type: string, payload: Record<string, unknown> = {}, seq: number | null = ++n): AgentEventFrame =>
  ({ type, at: `2026-10-20T10:00:${String(n % 60).padStart(2, '0')}Z`, sessionId: 'agt-1', payload, seq });
const fold = (frames: AgentEventFrame[], from: RunView = EMPTY_RUN) => frames.reduce(foldRunEvent, from);

describe('the run view is built only from reported events', () => {
  const frames = [
    frame('plan.received', { goal: 'Add notes', tasks: [{ id: 'a', title: 'Write NOTES.md', dependsOn: [] }, { id: 'b', title: 'Add a test', dependsOn: ['a'] }] }),
    frame('plan.created', { objective: 'Add notes', plan: [{ id: 'task-1', sourceId: 'a', description: 'x', dependsOn: [] }, { id: 'task-2', sourceId: 'b', description: 'y', dependsOn: ['task-1'] }] }),
    frame('task.state', { taskId: 'task-1', state: 'running' }),
    frame('files.changed', { taskId: 'task-1', worker: 'codex', changes: [{ path: 'NOTES.md', op: 'created' }], total: 1, complete: true }),
    frame('task.state', { taskId: 'task-1', state: 'verified', worker: 'codex', verified: true }),
    frame('task.state', { taskId: 'task-2', state: 'blocked', detail: 'needs pnpm' }),
  ];

  it('keeps one checklist row per task, matched across the Planner id and the canonical id', () => {
    const v = fold(frames);
    expect(v.checklist.map((c) => [c.taskId, c.title, c.state])).toEqual([
      ['task-1', 'Write NOTES.md', 'verified'],
      ['task-2', 'Add a test', 'blocked'],
    ]);
    expect(v.checklist[1].dependsOn).toEqual(['task-1']);
    expect(v.checklist[0].worker).toBe('codex');
  });

  it('lists observed files and the workers seen', () => {
    const v = fold(frames);
    expect(v.files).toEqual([{ path: 'NOTES.md', op: 'created', taskId: 'task-1', worker: 'codex' }]);
    expect(v.workers).toEqual(['codex']);
  });

  it('shows a replayed frame once (reconnect overlap)', () => {
    const once = fold(frames);
    const twice = fold(frames, once);
    expect(twice).toBe(once); // every frame already seen: the very same view comes back
    expect(twice.timeline).toHaveLength(once.timeline.length);
    expect(twice.files).toHaveLength(1);
  });

  it('records tool setup, reuse, blocks and handoffs as reported', () => {
    const v = fold([
      frame('tool.provisioning', { nodeId: 'pnpm', name: 'pnpm', stage: 'installing' }),
      frame('tool.provisioning', { nodeId: 'pnpm', name: 'pnpm', stage: 'installed' }),
      frame('tool.provisioning', { nodeId: 'git', name: 'Git', stage: 'present' }),
      frame('tool.provisioning', { nodeId: 'docker', name: 'Docker', stage: 'blocked', reason: 'needs administrator rights' }),
      frame('worker.handoff', { taskId: 'task-2', fromWorker: 'codex', toWorker: 'claude-code', reason: 'quota exhausted' }),
    ]);
    expect(v.toolsInstalled.map((t) => t.nodeId)).toEqual(['pnpm']);
    expect(v.toolsReused.map((t) => t.nodeId)).toEqual(['git']);
    expect(v.toolsBlocked.map((t) => t.nodeId)).toEqual(['docker']);
    expect(v.handoffs).toEqual([{ taskId: 'task-2', from: 'codex', to: 'claude-code', reason: 'quota exhausted' }]);
  });

  it('says it is waiting when another worker holds the project', () => {
    const v = fold([frame('worker.queued', { taskId: 't', waitingFor: { worker: 'codex' }, reason: 'another worker is editing this project; one at a time' })]);
    expect(v.waitingFor).toBe('codex');
    expect(v.timeline[0].tone).toBe('warn');
  });
});

const report = (over: Partial<ExecutionReport>): ExecutionReport => ({
  outcome: 'completed', workCompleted: [], unfinished: [], filesChanged: [], testsObserved: [], toolsInstalled: [], toolsReused: [],
  verificationEvidence: [], errors: [], handoffs: [], limitations: [], ...over,
});

describe('recovery and the completion line', () => {
  it('rebuilds the view from a stored report after a reload', () => {
    const v = seedFromReport('agt-1', report({
      workCompleted: [{ taskId: 'task-1', description: 'Write NOTES.md', worker: 'codex' }],
      unfinished: [{ taskId: 'task-2', description: 'Add a test', state: 'blocked', detail: 'needs pnpm' }],
      filesChanged: [{ path: 'NOTES.md', op: 'created', taskId: 'task-1', worker: 'codex', verified: true }],
    }));
    expect(v.finished).toBe(true);
    expect(v.checklist.map((c) => c.state)).toEqual(['verified', 'blocked']);
    expect(v.files).toHaveLength(1);
  });
  it('never calls partial success complete', () => {
    const partial = seedFromReport('s', report({ outcome: 'completed', workCompleted: [{ taskId: 'a', description: 'a', worker: null }], unfinished: [{ taskId: 'b', description: 'b', state: 'failed', detail: '' }] }));
    expect(completionLine(partial)).toEqual({ tone: 'warn', text: 'Partly done, not complete: 1 verified, 1 unfinished.' });
    const none = seedFromReport('s', report({ outcome: 'failed', unfinished: [{ taskId: 'b', description: 'b', state: 'failed', detail: '' }] }));
    expect(completionLine(none)?.tone).toBe('bad');
    const full = seedFromReport('s', report({ workCompleted: [{ taskId: 'a', description: 'a', worker: null }] }));
    expect(completionLine(full)?.tone).toBe('ok');
    expect(completionLine(EMPTY_RUN)).toBeNull();
  });
});

describe('an unfinished task is labelled by what actually happened, never as failed by default', () => {
  it('a task that never started is pending, not failed', () => {
    expect(unfinishedCheckState('pending')).toBe('pending');
    expect(unfinishedCheckState('ready')).toBe('pending');
    expect(unfinishedCheckState(undefined)).toBe('pending');
  });

  it('a task that really failed stays failed', () => {
    expect(unfinishedCheckState('failed')).toBe('failed');
    expect(unfinishedCheckState('timed-out')).toBe('failed');
  });

  it('refused and blocked work reads as blocked, cancelled as cancelled, running as running', () => {
    expect(unfinishedCheckState('denied')).toBe('blocked');
    expect(unfinishedCheckState('blocked')).toBe('blocked');
    expect(unfinishedCheckState('cancelled')).toBe('cancelled');
    expect(unfinishedCheckState('running')).toBe('running');
  });

  it('a parked (legacy awaiting) task in a restored report is pending, never failed', () => {
    const v = seedFromReport('s', report({
      outcome: 'failed',
      unfinished: [{ taskId: 'write-stop1', description: 'Write stop1.md', state: 'awaiting-approval', detail: '' }],
    }));
    const item = v.checklist.find((c) => c.taskId === 'write-stop1');
    expect(item?.state).toBe('pending');
  });
});
