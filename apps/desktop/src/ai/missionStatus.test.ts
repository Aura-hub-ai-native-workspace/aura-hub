/**
 * missionStatus — the finished-run view must tell the truth.
 *
 * The two rules that matter most: a finished worker is not a verified
 * mission, and no internal id or enum name reaches the user.
 */
import { describe, expect, it } from 'vitest';
import { failureReasonText, missionView, workerName } from './missionStatus';
import type { AgentTaskStatus } from './centralAgentClient';

const task = (over: Partial<AgentTaskStatus> & { taskId: string }): AgentTaskStatus => ({
  description: `Step ${over.taskId}`,
  state: 'done',
  verified: true,
  worker: null,
  dependsOn: [],
  ...over,
});

describe('missionView — no detail, no panel', () => {
  it('returns null for a plain conversational answer', () => {
    expect(missionView({ understanding: null, objective: null, tasks: [], failureReason: null })).toBeNull();
  });
});

describe('missionView — a finished worker is not a verified mission', () => {
  it('shows the task done while the mission verdict says not verified', () => {
    const view = missionView({
      understanding: 'Add a parser',
      objective: { accepted: false, unmet: ['parser handles empty input'] },
      tasks: [task({ taskId: 't1', description: 'Write parser', worker: 'claude-code' })],
      failureReason: 'objective-unaccepted',
    });
    expect(view?.tasks[0].stateLabel).toBe('Done');
    expect(view?.tasks[0].tone).toBe('ok');
    expect(view?.verdict?.tone).toBe('bad');
    expect(view?.verdict?.text).toContain('Mission not verified');
    expect(view?.verdict?.text).toContain('parser handles empty input');
  });

  it('confirms verification only when every criterion is met', () => {
    const view = missionView({
      understanding: 'Add a parser',
      objective: { accepted: true, unmet: [] },
      tasks: [task({ taskId: 't1' })],
      failureReason: null,
    });
    expect(view?.verdict).toEqual({
      tone: 'ok',
      text: 'Mission verified: every acceptance criterion is met.',
    });
  });

  it('does not invent a verdict when the plan declared no criteria', () => {
    const view = missionView({
      understanding: 'Run tests',
      objective: null,
      tasks: [task({ taskId: 't1' })],
      failureReason: null,
    });
    expect(view?.verdict).toBeNull();
  });

  it('flags a task that finished without verification', () => {
    const view = missionView({
      understanding: null,
      objective: null,
      tasks: [task({ taskId: 't1', verified: false })],
      failureReason: null,
    });
    expect(view?.tasks[0].stateLabel).toBe('Finished, not verified');
    expect(view?.tasks[0].tone).toBe('bad');
  });
});

describe('missionView — partial failure and dependencies', () => {
  it('shows the failed step, the waiting step, and the failure in words', () => {
    const view = missionView({
      understanding: 'Ship the feature',
      objective: null,
      tasks: [
        task({ taskId: 't1', description: 'Write code', state: 'failed', verified: false }),
        task({ taskId: 't2', description: 'Write tests', state: 'pending', dependsOn: ['t1'] }),
      ],
      failureReason: 'task-failed',
    });
    expect(view?.tasks[0].stateLabel).toBe('Failed');
    expect(view?.tasks[1].stateLabel).toBe('Waiting');
    expect(view?.tasks[1].waitingOn).toBe('Write code');
    expect(view?.verdict?.text).toBe('A task failed, so the rest of the plan did not run.');
  });

  it('marks a task that never started as not started when nothing blocks it', () => {
    const view = missionView({
      understanding: null,
      objective: null,
      tasks: [task({ taskId: 't1', state: 'pending' })],
      failureReason: null,
    });
    expect(view?.tasks[0].stateLabel).toBe('Not started');
  });

  it('reports refusal by policy as a refusal, not a generic failure', () => {
    const view = missionView({
      understanding: null,
      objective: null,
      tasks: [task({ taskId: 't1', state: 'denied', verified: null })],
      failureReason: 'action-denied',
    });
    expect(view?.tasks[0].stateLabel).toBe('Refused by policy');
    expect(view?.verdict?.text).toBe('An action was refused by policy, so the run stopped.');
  });
});

describe('missionView — no raw identifiers reach the user', () => {
  it('never prints task ids, backend states or reason codes', () => {
    const view = missionView({
      understanding: 'Refactor the module',
      objective: { accepted: false, unmet: ['tests pass'] },
      tasks: [
        task({ taskId: 'tsk-alpha-1', description: 'Refactor', worker: 'kilo-code', state: 'timed-out', verified: null }),
        task({ taskId: 'tsk-beta-2', description: 'Review', state: 'pending', dependsOn: ['tsk-alpha-1'] }),
      ],
      failureReason: 'timed-out',
    });
    // taskId is a React key only and is never rendered; check what is shown.
    const shown = JSON.stringify({
      understanding: view?.understanding,
      verdict: view?.verdict,
      tasks: view?.tasks.map(({ taskId: _id, ...rest }) => rest),
    });
    const everything = shown;
    expect(everything).not.toContain('tsk-alpha-1');
    expect(everything).not.toContain('timed-out');
    expect(everything).not.toContain('objective-unaccepted');
    expect(everything).not.toContain('task-failed');
    expect(everything).not.toContain('kilo-code');
    expect(view?.tasks[0].byline).toBe('by Kilo Code');
  });
});

describe('worker and reason names', () => {
  it('humanises known workers and leaves unknown ones readable', () => {
    expect(workerName('claude-code')).toBe('Claude Code');
    expect(workerName('kilo-code')).toBe('Kilo Code');
    expect(workerName('my_custom-worker')).toBe('my custom worker');
    expect(workerName(null)).toBeNull();
  });

  it('gives an honest sentence for an unknown failure reason', () => {
    expect(failureReasonText('some-new-reason')).toBe('The run did not finish as planned.');
    expect(failureReasonText(null)).toBeNull();
  });
});
