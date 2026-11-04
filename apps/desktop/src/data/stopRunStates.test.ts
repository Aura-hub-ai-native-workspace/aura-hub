/**
 * Stopping a workflow run or an automation run tells the truth (F-24, paths 2
 * and 3).
 *
 * Workflow `stopRun` discarded the cancel's result (`.catch(() => null)`),
 * dropped the stream and set the run to "cancelled" regardless; automation
 * `cancelRun` fired and forgot. A failed or unanswered stop therefore looked
 * like a stopped run, and a run that finished first was relabelled.
 *
 * Here the real stores and the real clients run against a faked `fetch`, so
 * what the services really send is what is handled: both clients return the
 * body whatever the HTTP status, so a 409 or 404 arrives as `{ error }`.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../backend/backendSession', async (orig) => ({
  ...(await orig<typeof import('../backend/backendSession')>()),
  backendFetch: (url: string, init?: RequestInit) => fetch(url, init),
}));

import { applyRunEvent, useWorkflows, type RunState } from './useWorkflows';
import { useAutomation } from './useAutomation';

type Route = (url: string, init?: RequestInit) => unknown | Promise<unknown>;
let routes: { match: RegExp; method: string; respond: Route }[] = [];
const seen: { method: string; url: string }[] = [];

function on(method: string, match: RegExp, respond: Route) {
  routes.push({ method, match, respond });
}

beforeEach(() => {
  routes = [];
  seen.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    seen.push({ method, url: String(url) });
    const route = routes.find((r) => r.method === method && r.match.test(String(url)));
    if (!route) return new Response(JSON.stringify({ error: `unscripted ${method} ${url}` }), { status: 500 });
    const out = await route.respond(String(url), init);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { vi.useRealTimers(); });

/* ── workflow runs ──────────────────────────────────────────────────────── */

const CANCEL = /\/workflows\/wf1\/runs\/run1\/cancel$/;
const RECORD = /\/workflows\/wf1\/runs\/run1$/;
const cancelCalls = () => seen.filter((c) => c.method === 'POST' && CANCEL.test(c.url)).length;

function activeRun(extra: Partial<RunState> = {}): RunState {
  return { active: true, states: {}, logs: [], outputs: [], status: 'running', ms: 0, beats: {}, ...extra };
}

function startWorkflowRun(extra: Partial<RunState> = {}) {
  useWorkflows.setState({
    def: { id: 'wf1', name: 'wf', nodes: [], edges: [] } as never,
    runId: 'run1', run: activeRun(extra), serverRun: null,
  });
}
const wfRun = () => useWorkflows.getState().run!;

describe('workflow stopRun', () => {
  it('a request that fails leaves the run running and says why', async () => {
    startWorkflowRun();
    on('POST', CANCEL, () => new TypeError('Failed to fetch'));
    on('GET', RECORD, () => new TypeError('Failed to fetch'));
    await useWorkflows.getState().stopRun();
    expect(wfRun().active).toBe(true);
    expect(wfRun().status).toBe('running');                  // not "cancelled"
    expect(wfRun().stopping).toBe(false);
    expect(wfRun().stopNote).toMatch(/could not stop the run/i);
    expect(wfRun().stopNote).toMatch(/still running/i);
  });

  it('an engine that did not signal the run is a failure while the record still says running', async () => {
    startWorkflowRun();
    on('POST', CANCEL, () => ({ cancelled: false }));
    on('GET', RECORD, () => ({ id: 'run1', state: 'running' }));
    await useWorkflows.getState().stopRun();
    expect(wfRun().active).toBe(true);
    expect(wfRun().status).toBe('running');
    expect(wfRun().stopNote).toMatch(/did not stop/i);
  });

  it('a run that already succeeded keeps its real outcome', async () => {
    startWorkflowRun();
    on('POST', CANCEL, () => ({ error: 'that run already succeeded — there is nothing to cancel' }));
    on('GET', RECORD, () => ({ id: 'run1', state: 'succeeded' }));
    await useWorkflows.getState().stopRun();
    expect(wfRun().active).toBe(false);
    expect(wfRun().status).toBe('completed');                // not relabelled "cancelled"
    expect(wfRun().stopNote).toMatch(/already succeeded/i);
    expect(useWorkflows.getState().serverRun).toMatchObject({ id: 'run1', state: 'succeeded' });
  });

  it('a run that failed first stays failed', async () => {
    startWorkflowRun();
    on('POST', CANCEL, () => ({ error: 'that run already failed — there is nothing to cancel' }));
    on('GET', RECORD, () => ({ id: 'run1', state: 'failed' }));
    await useWorkflows.getState().stopRun();
    expect(wfRun().status).toBe('failed');
  });

  it('a stop the record confirms ends as cancelled', async () => {
    vi.useFakeTimers();
    startWorkflowRun();
    on('POST', CANCEL, () => ({ cancelled: true }));
    let reads = 0;
    on('GET', RECORD, () => ({ id: 'run1', state: ++reads < 3 ? 'running' : 'cancelled' }));
    const done = useWorkflows.getState().stopRun();
    await vi.advanceTimersByTimeAsync(0);
    expect(wfRun().stopping).toBe(true);                     // requested, not yet confirmed
    expect(wfRun().status).toBe('running');
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(wfRun().active).toBe(false);
    expect(wfRun().status).toBe('cancelled');
    expect(wfRun().stopping).toBe(false);
    expect(wfRun().stopNote).toBeUndefined();
  });

  it('a stop the engine never confirms is never reported as stopped', async () => {
    vi.useFakeTimers();
    startWorkflowRun();
    on('POST', CANCEL, () => ({ cancelled: true }));
    on('GET', RECORD, () => ({ id: 'run1', state: 'running' }));
    const done = useWorkflows.getState().stopRun();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(wfRun().active).toBe(true);
    expect(wfRun().status).toBe('running');
    expect(wfRun().stopping).toBe(true);
    expect(wfRun().stopNote).toMatch(/has not confirmed it yet/i);
  });

  it('a run that finishes while the stop is pending shows its own outcome', async () => {
    vi.useFakeTimers();
    startWorkflowRun();
    on('POST', CANCEL, () => ({ cancelled: true }));
    let reads = 0;
    on('GET', RECORD, () => ({ id: 'run1', state: ++reads < 2 ? 'running' : 'succeeded' }));
    const done = useWorkflows.getState().stopRun();
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(wfRun().status).toBe('completed');
    expect(wfRun().stopNote).toMatch(/already succeeded/i);
  });

  it('a repeated press while a request is in flight sends one request', async () => {
    startWorkflowRun();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    on('POST', CANCEL, async () => { await gate; return { error: 'that run already succeeded — there is nothing to cancel' }; });
    on('GET', RECORD, () => ({ id: 'run1', state: 'succeeded' }));
    const a = useWorkflows.getState().stopRun();
    const b = useWorkflows.getState().stopRun();
    const c = useWorkflows.getState().stopRun();
    expect(wfRun().stopping).toBe(true);
    release();
    await Promise.all([a, b, c]);
    expect(cancelCalls()).toBe(1);
  });

  describe("the run stream's own 'done' event settles a pending stop", () => {
    const done = (runState?: string, status: 'completed' | 'failed' = 'failed') => {
      const apply = applyRunEvent(useWorkflows.setState as never, useWorkflows.getState as never);
      apply({ type: 'done', status, ms: 5, runId: 'run1', ...(runState ? { runState } : {}) } as never);
    };

    it("the engine's 'cancelled' confirms it", () => {
      startWorkflowRun({ stopping: true });
      done('cancelled', 'failed');            // the stream folds cancelled into failed
      expect(wfRun().status).toBe('cancelled');
      expect(wfRun().active).toBe(false);
      expect(wfRun().stopping).toBe(false);
      expect(wfRun().stopNote).toBeUndefined();
      expect(wfRun().error).toBeUndefined();
    });

    it('any other real state means the run finished before the stop took effect', () => {
      startWorkflowRun({ stopping: true });
      done('succeeded', 'completed');
      expect(wfRun().status).toBe('completed');
      expect(wfRun().stopNote).toMatch(/finished before the stop took effect/i);
    });

    it('no runState claims neither: the stream status stands', () => {
      startWorkflowRun({ stopping: true });
      done(undefined, 'failed');
      expect(wfRun().status).toBe('failed');
      expect(wfRun().stopNote).toBeUndefined();
    });

    it('without a pending stop nothing is relabelled', () => {
      startWorkflowRun();
      done('cancelled', 'failed');
      expect(wfRun().status).toBe('failed');
    });
  });

  it('a run with no id yet cannot be stopped and says so', async () => {
    useWorkflows.setState({ def: { id: 'wf1', name: 'wf', nodes: [], edges: [] } as never, runId: null, run: activeRun(), serverRun: null });
    await useWorkflows.getState().stopRun();
    expect(cancelCalls()).toBe(0);
    expect(wfRun().active).toBe(true);
    expect(wfRun().stopNote).toMatch(/not reported its id yet/i);
  });

  it('does nothing when no run is active', async () => {
    useWorkflows.setState({ def: { id: 'wf1', name: 'wf', nodes: [], edges: [] } as never, runId: 'run1', run: activeRun({ active: false, status: 'completed' }), serverRun: null });
    await useWorkflows.getState().stopRun();
    expect(seen).toHaveLength(0);
  });
});

/* ── automation runs ────────────────────────────────────────────────────── */

const A_CANCEL = /\/automation\/rules\/rule1\/runs\/run1\/cancel$/;
const A_RUNS = /\/automation\/rules\/rule1\/runs$/;

describe('automation cancelRun', () => {
  beforeEach(() => { on('GET', A_RUNS, () => ({ runs: [] })); });

  it("confirms when the engine's record says cancelled", async () => {
    on('POST', A_CANCEL, () => ({ id: 'run1', ruleId: 'rule1', status: 'cancelled' }));
    const r = await useAutomation.getState().cancelRun('rule1', 'run1');
    expect(r.kind).toBe('confirmed');
  });

  it('reports a failed request instead of discarding it', async () => {
    on('POST', A_CANCEL, () => new TypeError('Failed to fetch'));
    const r = await useAutomation.getState().cancelRun('rule1', 'run1');
    expect(r.kind).toBe('failed');
    expect(r.message).toMatch(/still running/i);
  });

  it('reports a refusal from the engine', async () => {
    on('POST', A_CANCEL, () => ({ error: 'not found' }));
    const r = await useAutomation.getState().cancelRun('rule1', 'run1');
    expect(r.kind).toBe('failed');
  });

  it('reports a run that had already finished as that, from the 409', async () => {
    on('POST', A_CANCEL, () => ({ error: 'that run already completed — there is nothing to cancel' }));
    const r = await useAutomation.getState().cancelRun('rule1', 'run1');
    expect(r).toMatchObject({ kind: 'already-finished', state: 'completed' });
  });

  it('a refusal for a run that had in fact finished is reconciled with the run record', async () => {
    on('POST', A_CANCEL, () => ({ error: 'no such run' }));                       // an older service answers 404 for a finished run
    on('GET', /\/automation\/rules\/rule1\/runs\/run1$/, () => ({ id: 'run1', ruleId: 'rule1', status: 'failed' }));
    const r = await useAutomation.getState().cancelRun('rule1', 'run1');
    expect(r).toMatchObject({ kind: 'already-finished', state: 'failed' });
  });

  it('an already-cancelled run is reported as that', async () => {
    on('POST', A_CANCEL, () => ({ error: 'no such run' }));
    on('GET', /\/automation\/rules\/rule1\/runs\/run1$/, () => ({ id: 'run1', ruleId: 'rule1', status: 'cancelled' }));
    expect(await useAutomation.getState().cancelRun('rule1', 'run1')).toMatchObject({ kind: 'already-finished', state: 'cancelled' });
  });

  it('a refusal for a run that is still running stays a failure', async () => {
    on('POST', A_CANCEL, () => ({ error: 'engine busy' }));
    on('GET', /\/automation\/rules\/rule1\/runs\/run1$/, () => ({ id: 'run1', ruleId: 'rule1', status: 'running' }));
    const r = await useAutomation.getState().cancelRun('rule1', 'run1');
    expect(r.kind).toBe('failed');
    expect(r.message).toMatch(/engine busy/);
  });

  it('a transport failure does not go looking for the record', async () => {
    on('POST', A_CANCEL, () => new TypeError('Failed to fetch'));
    await useAutomation.getState().cancelRun('rule1', 'run1');
    expect(seen.some((c) => c.method === 'GET' && /\/runs\/run1$/.test(c.url))).toBe(false);
  });

  it('does not call a still-running record stopped', async () => {
    on('POST', A_CANCEL, () => ({ id: 'run1', ruleId: 'rule1', status: 'running' }));
    expect((await useAutomation.getState().cancelRun('rule1', 'run1')).kind).toBe('failed');
  });

  it('reloads the runs after every outcome so the list shows the real state', async () => {
    for (const body of [{ id: 'run1', status: 'cancelled' }, { error: 'not found' }, new TypeError('x')]) {
      seen.length = 0;
      routes = routes.filter((r) => r.method !== 'POST');
      on('POST', A_CANCEL, () => body);
      await useAutomation.getState().cancelRun('rule1', 'run1');
      expect(seen.some((c) => c.method === 'GET' && A_RUNS.test(c.url))).toBe(true);
    }
  });
});
