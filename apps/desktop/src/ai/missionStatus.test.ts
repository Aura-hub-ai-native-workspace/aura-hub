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
    expect(view?.verdict?.text).toBe('Mission not verified.');
  });

  it('names the unverified step, never the raw criterion or task id', () => {
    // The exact unmet string the backend stored for a real missing-file run.
    const view = missionView({
      understanding: 'Inspect the project',
      objective: {
        accepted: false,
        unmet: ['The requested work was carried out and verified.: unverified tasks: implement'],
      },
      tasks: [task({
        taskId: 'implement',
        description: 'Inspect the requested files and report their contents',
        verified: false,
        worker: 'claude-code',
        verification: 'evidence-present',
      })],
      failureReason: 'objective-unaccepted',
    });
    expect(view?.verdict).toEqual({
      tone: 'bad',
      text: 'Mission not verified. Not verified: Inspect the requested files and report their contents.',
    });
    expect(view?.verdict?.text).not.toContain('carried out');
    expect(view?.verdict?.text).not.toContain('implement');
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

describe('missionView — process finished is not evidence found', () => {
  it('labels an exit-code-only task as process only, not verified', () => {
    const view = missionView({
      understanding: null,
      objective: null,
      tasks: [task({ taskId: 't1', verified: true, verification: 'exit-code' })],
      failureReason: null,
    });
    expect(view?.tasks[0].stateLabel).toBe('Finished (process only, no evidence checked)');
    expect(view?.tasks[0].tone).toBe('neutral');
  });

  it('labels a task whose evidence was found as done', () => {
    const view = missionView({
      understanding: null,
      objective: null,
      tasks: [task({ taskId: 't1', verified: true, verification: 'evidence-present' })],
      failureReason: null,
    });
    expect(view?.tasks[0].stateLabel).toBe('Done');
    expect(view?.tasks[0].tone).toBe('ok');
  });

  it('treats results without the verification field as before', () => {
    const view = missionView({
      understanding: null,
      objective: null,
      tasks: [task({ taskId: 't1', verified: true })],
      failureReason: null,
    });
    expect(view?.tasks[0].stateLabel).toBe('Done');
  });
});

describe('missionView — a stopped run', () => {
  // The shape the backend now settles a stopped run into (session agt-783c2ab7e0a9).
  const stopped = {
    understanding: 'Inspect two files in parallel',
    objective: { accepted: false, unmet: ['delegate-kilo: reported findings and made no modification.: unverified tasks: delegate-kilo'] },
    tasks: [
      task({ taskId: 'delegate-claude', description: 'inspect alpha/a.txt and report its contents', worker: 'claude-code', verified: true, verification: 'evidence-present' }),
      task({ taskId: 'delegate-kilo', description: 'inspect alpha/missing.txt and report its contents', worker: 'kilo-code', state: 'cancelled', verified: null, verification: 'evidence-present' }),
    ],
    failureReason: 'cancelled-by-user',
  };

  it('keeps the completed task as done and verified, by its worker', () => {
    const view = missionView(stopped);
    expect(view?.tasks[0]).toMatchObject({ stateLabel: 'Done', tone: 'ok', byline: 'by Claude Code' });
  });

  it('labels the interrupted task as stopped, not failed or done', () => {
    const view = missionView(stopped);
    expect(view?.tasks[1]).toMatchObject({ stateLabel: 'Stopped', tone: 'neutral', byline: 'by Kilo Code' });
  });

  it('says the mission was stopped and not verified', () => {
    expect(missionView(stopped)?.verdict).toEqual({
      tone: 'bad', text: 'Stopped before the mission finished. Mission not verified.',
    });
  });

  it('shows no internal ids or criteria anywhere it renders', () => {
    const view = missionView(stopped);
    const shown = JSON.stringify({ verdict: view?.verdict, tasks: view?.tasks.map(({ taskId: _id, ...rest }) => rest) });
    for (const internal of ['delegate-claude', 'delegate-kilo', 'claude-code', 'kilo-code', 'cancelled-by-user', 'unverified tasks']) {
      expect(shown).not.toContain(internal);
    }
  });
});
