import { describe, expect, it } from 'vitest';
import type { AgentResult, AgentSession } from './centralAgentClient';
import { isStartedResult, settledResultOf, waitForRun } from './backgroundRun';

const result = (over: Partial<AgentResult>): AgentResult => ({
  understanding: null, objectiveAccepted: null, unmetAcceptance: [], tasks: [],
  status: 'completed', outcome: 'completed', summary: 'done',
  performed: [], verified: [], evidence: null, failureReason: null, runId: null,
  sources: [], research: null, nextActions: [], model: null, modelFailure: null,
  unsupportedClaims: [], recorded: [], ...over,
} as AgentResult);

const session = (over: Partial<AgentSession>): AgentSession => ({
  sessionId: 'agt-1', state: 'planning', createdAt: '', updatedAt: '',
  messages: [], lastResult: null, eventCount: 0, orchestrationState: 'running', ...over,
} as AgentSession);

/** A controllable clock and sleep: time only advances when the loop sleeps. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number, signal: AbortSignal) => {
      sleeps.push(ms);
      t += ms;
      if (signal.aborted) return;
    },
    sleeps,
  };
}

describe('isStartedResult', () => {
  it('treats the accepted-and-running answer as an outcome-less state', () => {
    expect(isStartedResult({ status: 'started', outcome: 'started' })).toBe(true);
    expect(isStartedResult({ status: 'completed', outcome: 'completed' })).toBe(false);
    expect(isStartedResult(null)).toBe(false);
  });
});

/** The submit answer for a run that was accepted and is still running. */
const startedAnswer = () => ({ ...result({}), status: 'started', outcome: 'started' }) as unknown as AgentResult;

describe('settledResultOf', () => {
  it('is null while the orchestration is still running', () => {
    expect(settledResultOf(session({ lastResult: result({}), orchestrationState: 'running' }))).toBeNull();
  });

  it('is null while the only recorded result is the started answer', () => {
    expect(settledResultOf(session({
      orchestrationState: 'completed',
      lastResult: startedAnswer(),
    }))).toBeNull();
  });

  it('returns the run\'s own terminal result once it has settled', () => {
    const done = result({ outcome: 'completed' });
    expect(settledResultOf(session({ orchestrationState: 'completed', lastResult: done }))).toBe(done);
  });
});

describe('waitForRun', () => {
  it('stays active while the run is in flight, reporting progress, then completes', async () => {
    const clock = fakeClock();
    const snapshots = [
      session({ state: 'planning', lastResult: null }),
      session({ state: 'executing', lastResult: null }),
      session({ state: 'verifying', lastResult: null }),
      session({ state: 'completed', orchestrationState: 'completed', lastResult: result({ outcome: 'completed' }) }),
    ];
    const progress: string[] = [];
    let calls = 0;
    const outcome = await waitForRun({
      sessionId: 'agt-1',
      getSession: async () => snapshots[Math.min(calls++, snapshots.length - 1)],
      signal: new AbortController().signal,
      onProgress: (s) => progress.push(s.state),
      now: clock.now, sleep: clock.sleep,
    });
    expect(outcome).toEqual({ kind: 'settled', result: expect.objectContaining({ outcome: 'completed' }) });
    expect(progress).toEqual(['planning', 'executing', 'verifying']);
    expect(calls).toBe(4);
  });

  it('reports a failed run as failed, never as completed', async () => {
    const clock = fakeClock();
    const outcome = await waitForRun({
      sessionId: 'agt-2',
      getSession: async () => session({
        state: 'failed', orchestrationState: 'failed',
        lastResult: result({ status: 'failed', outcome: 'failed', failureReason: 'orchestration-crashed', summary: 'boom' }),
      }),
      signal: new AbortController().signal,
      now: clock.now, sleep: clock.sleep,
    });
    expect(outcome.kind).toBe('settled');
    if (outcome.kind === 'settled') {
      expect(outcome.result.outcome).toBe('failed');
      expect(outcome.result.failureReason).toBe('orchestration-crashed');
    }
  });

  it('keeps waiting through transient failures and backs off, then recovers (reconnection)', async () => {
    const clock = fakeClock();
    let calls = 0;
    const outcome = await waitForRun({
      sessionId: 'agt-3',
      getSession: async () => {
        calls += 1;
        if (calls <= 3) throw new Error('connection reset');
        return session({ orchestrationState: 'completed', lastResult: result({ outcome: 'completed' }) });
      },
      signal: new AbortController().signal,
      intervalMs: 1000,
      now: clock.now, sleep: clock.sleep,
    });
    expect(outcome.kind).toBe('settled');
    expect(clock.sleeps.slice(0, 3)).toEqual([2000, 4000, 8000]);
  });

  it('restores an already-settled run on the first poll (session restoration)', async () => {
    const clock = fakeClock();
    let calls = 0;
    const outcome = await waitForRun({
      sessionId: 'agt-4',
      getSession: async () => {
        calls += 1;
        return session({ orchestrationState: 'completed', lastResult: result({ outcome: 'completed' }) });
      },
      signal: new AbortController().signal,
      now: clock.now, sleep: clock.sleep,
    });
    expect(outcome.kind).toBe('settled');
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('stops without a result when the caller cancels', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    let calls = 0;
    const outcome = await waitForRun({
      sessionId: 'agt-5',
      getSession: async () => {
        calls += 1;
        if (calls === 2) controller.abort();
        return session({ lastResult: null });
      },
      signal: controller.signal,
      now: clock.now, sleep: clock.sleep,
    });
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(calls).toBe(2);
  });

  it('stops with a timeout, without claiming the run ended, once the ceiling passes', async () => {
    const clock = fakeClock();
    const outcome = await waitForRun({
      sessionId: 'agt-6',
      getSession: async () => session({ lastResult: null }),
      signal: new AbortController().signal,
      timeoutMs: 5000, intervalMs: 1000,
      now: clock.now, sleep: clock.sleep,
    });
    expect(outcome.kind).toBe('timeout');
    if (outcome.kind === 'timeout') expect(outcome.elapsedMs).toBeGreaterThanOrEqual(5000);
  });
});
