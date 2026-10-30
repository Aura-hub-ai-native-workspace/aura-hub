/**
 * Automation run lifecycle in the TypeScript engine: the first terminal state
 * wins (F-29).
 *
 * This is the engine the desktop app talks to. It had the same flaws as its
 * Python port: `cancelRun` treated only completed and cancelled as finished, so
 * a FAILED run was rewritten as "cancelled"; every retry attempt reset the run's
 * status, so a Stop during a retry wait was silently undone and the run carried
 * on; a failure arriving after a Stop replaced "cancelled" with "failed" and
 * emitted a second, contradictory `done` event.
 *
 * Contract pinned here (the Python twin is
 * backend/tests/automation/test_automation_lifecycle.py):
 *   - completed, failed, cancelled are terminal; the first one reached wins;
 *   - a Stop on a finished run does nothing;
 *   - a Stop on an active run cancels it; the in-flight action keeps its own
 *     outcome on its own state, and that outcome cannot change the run;
 *   - exactly one `done` event per run, naming the run's final status;
 *   - the persisted record always agrees with the last event.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutomationEngine, AutomationStore } from '@aura/automation';
import type { AutomationRun, AutomationRunEvent } from '@aura/automation';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.AURA_HOME;
  home = mkdtempSync(path.join(tmpdir(), 'aura-lifecycle-'));
  process.env.AURA_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.AURA_HOME; else process.env.AURA_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

type Result = { ok: boolean; summary?: string; error?: string };

/** A handler that stays in flight until released, then returns `result`. */
function gated(result: Result) {
  let release!: () => void;
  let entered!: () => void;
  const enteredP = new Promise<void>((r) => { entered = r; });
  const releaseP = new Promise<void>((r) => { release = r; });
  const calls: number[] = [];
  const handler = async () => { calls.push(1); entered(); await releaseP; return result; };
  return { handler, entered: enteredP, release, calls };
}

function harness(handler: (...a: never[]) => Promise<Result>, opts: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const events: AutomationRunEvent[] = [];
  const store = new AutomationStore();
  const engine = new AutomationEngine({
    store, emit: (e) => events.push(e), sleep: opts.sleep ?? (async () => undefined),
    actions: { 'run-workflow': handler as never },
  });
  const rule = store.createRule({
    name: 'R', enabled: true, trigger: { type: 'mission-completed', projectId: 'p' }, conditions: [],
    chain: [{ id: 'a1', action: 'run-workflow', label: 'Run', config: { workflowId: 'wf-1' }, continueOnError: false }],
    retry: { maxAttempts: opts.maxAttempts ?? 1, delayMs: 1, backoffFactor: 1 },
  });
  const fire = () => engine.handleEvent({ type: 'mission-completed', projectId: 'p', projectPath: '/p', at: new Date().toISOString(), payload: {} }) as AutomationRun;
  const persisted = (run: AutomationRun) => store.getRun(rule.id, run.id)!;
  const dones = (run: AutomationRun) => events.filter((e) => e.type === 'done' && e.runId === run.id).map((e) => (e as { status: string }).status);
  const lastRunEventStatus = (run: AutomationRun) => {
    const statuses = events.filter((e) => e.type === 'run' && (e as { run: AutomationRun }).run.id === run.id).map((e) => (e as { run: AutomationRun }).run.status);
    return statuses[statuses.length - 1];
  };
  const cancel = (run: AutomationRun) => engine.cancelRun(rule.id, run.id);
  return { engine, store, rule, events, fire, persisted, dones, lastRunEventStatus, cancel };
}

describe('cancelling an active run', () => {
  it('cancels it once, and the late result changes nothing', async () => {
    const g = gated({ ok: true, summary: 'late success' });
    const h = harness(g.handler);
    const run = h.fire();
    await g.entered;
    const cancelled = h.cancel(run);
    expect(cancelled?.status).toBe('cancelled');
    g.release();
    await tick();
    expect(h.persisted(run).status).toBe('cancelled');                      // not "completed"
    expect(h.dones(run)).toEqual(['cancelled']);                            // one done, and it is the truth
    expect(h.lastRunEventStatus(run)).toBe('cancelled');
    expect(h.persisted(run).actions[0].status).toBe('completed');           // the action kept its own outcome
    const timeline = h.persisted(run).timeline.map((t) => t.type);
    expect(timeline.filter((t) => t === 'cancelled')).toHaveLength(1);
    expect(timeline).not.toContain('completed');
  });
});

describe('a failure is never rewritten as a cancellation', () => {
  it('a failed run cannot be cancelled afterwards', async () => {
    const h = harness(async () => ({ ok: false, error: 'ETIMEDOUT' }));
    const run = h.fire();
    await tick();
    expect(h.persisted(run).status).toBe('failed');
    const before = JSON.stringify(h.persisted(run));
    expect(h.cancel(run)).toBeNull();                                       // F-29: used to flip it
    expect(JSON.stringify(h.persisted(run))).toBe(before);
    expect(h.persisted(run).error).toBe('ETIMEDOUT');
    expect(h.dones(run)).toEqual(['failed']);
    expect(h.persisted(run).timeline.map((t) => t.type)).not.toContain('cancelled');
  });

  it('a completed run cannot be cancelled afterwards', async () => {
    const h = harness(async () => ({ ok: true }));
    const run = h.fire();
    await tick();
    expect(h.cancel(run)).toBeNull();
    expect(h.persisted(run).status).toBe('completed');
    expect(h.dones(run)).toEqual(['completed']);
  });

  it('a Stop then a failure stays cancelled, with one done event (cancellation first)', async () => {
    const g = gated({ ok: false, error: 'worker crashed' });
    const h = harness(g.handler);
    const run = h.fire();
    await g.entered;
    expect(h.cancel(run)?.status).toBe('cancelled');
    g.release();                                                            // the action fails afterwards
    await tick();
    const stored = h.persisted(run);
    expect(stored.status).toBe('cancelled');
    expect(stored.error).toBeUndefined();                                   // not "failed"
    expect(stored.actions[0].status).toBe('failed');                        // the action's own failure is kept
    expect(stored.actions[0].error).toBe('worker crashed');
    expect(h.dones(run)).toEqual(['cancelled']);                            // no second, contradictory done
  });

  it('a failure then a Stop stays failed (failure first)', async () => {
    const h = harness(async () => ({ ok: false, error: 'disk full' }));
    const run = h.fire();
    await tick();
    expect(h.cancel(run)).toBeNull();
    expect(h.persisted(run).status).toBe('failed');
    expect(h.dones(run)).toEqual(['failed']);
  });
});

describe('cancellation racing with completion', () => {
  it('a Stop then a completion stays cancelled', async () => {
    const g = gated({ ok: true });
    const h = harness(g.handler);
    const run = h.fire();
    await g.entered;
    expect(h.cancel(run)?.status).toBe('cancelled');
    g.release();
    await tick();
    expect(h.persisted(run).status).toBe('cancelled');
    expect(h.dones(run)).toEqual(['cancelled']);
  });

  it('a completion then a Stop stays completed', async () => {
    const h = harness(async () => ({ ok: true }));
    const run = h.fire();
    await tick();
    expect(h.cancel(run)).toBeNull();
    expect(h.persisted(run).status).toBe('completed');
    expect(h.dones(run)).toEqual(['completed']);
  });
});

describe('repeated and unknown stops', () => {
  it('cancel once however many times Stop is pressed', async () => {
    const g = gated({ ok: true });
    const h = harness(g.handler);
    const run = h.fire();
    await g.entered;
    const results = [h.cancel(run), h.cancel(run), h.cancel(run)];
    expect(results[0]?.status).toBe('cancelled');
    expect(results[1]).toBeNull();
    expect(results[2]).toBeNull();
    g.release();
    await tick();
    expect(h.dones(run)).toHaveLength(1);
    expect(h.persisted(run).timeline.filter((t) => t.type === 'cancelled')).toHaveLength(1);
  });

  it('an unknown run is nothing', () => {
    const h = harness(async () => ({ ok: true }));
    expect(h.engine.cancelRun(h.rule.id, 'run-nope')).toBeNull();
  });
});

describe('retries', () => {
  it('a Stop during a retry wait is not undone', async () => {
    let waiting!: () => void;
    const waitingP = new Promise<void>((r) => { waiting = r; });
    let wake!: () => void;
    const wakeP = new Promise<void>((r) => { wake = r; });
    let attempts = 0;
    const h = harness(async () => { attempts += 1; return { ok: false, error: 'flaky' }; }, {
      maxAttempts: 3, sleep: async () => { waiting(); await wakeP; },
    });
    const run = h.fire();
    await waitingP;                                                         // first attempt failed, retry pending
    expect(h.persisted(run).status).toBe('running');                        // active; "retrying" starts with the next attempt
    expect(h.cancel(run)?.status).toBe('cancelled');
    wake();
    await tick();
    expect(attempts).toBe(1);                                               // no second attempt after the Stop
    expect(h.persisted(run).status).toBe('cancelled');                      // not "retrying", not "failed"
    expect(h.dones(run)).toEqual(['cancelled']);
  });

  it('a retry does not overwrite a paused run', async () => {
    const seen: string[] = [];
    let attempts = 0;
    let box: ReturnType<typeof harness> | undefined;
    // The handler runs synchronously inside fire(), before the caller has the
    // run, so it finds the run in the store.
    const current = () => box!.store.getRun(box!.rule.id, box!.store.listRuns(box!.rule.id)[0].id)!;
    const h = harness(async () => {
      attempts += 1;
      seen.push(current().status);
      if (attempts === 1) box!.engine.pauseRule(box!.rule.id);
      return { ok: false, error: 'flaky' };
    }, { maxAttempts: 2 });
    box = h;
    h.fire();
    await tick(60);
    expect(attempts).toBe(2);
    expect(seen[0]).toBe('running');
    expect(seen[1]).toBe('paused');                                         // the second attempt did not reset it
  });
});

describe('persistence and events agree', () => {
  it.each([['cancel-first', 'cancelled'], ['complete-first', 'completed'], ['fail-first', 'failed']] as const)(
    '%s: the stored record, the events and the done event name one outcome', async (kind, expected) => {
      const g = gated(kind === 'fail-first' ? { ok: false, error: 'x' } : { ok: true });
      const h = harness(g.handler);
      const run = h.fire();
      await g.entered;
      if (kind === 'cancel-first') { h.cancel(run); g.release(); } else { g.release(); await tick(); h.cancel(run); }
      await tick();
      expect(h.persisted(run).status).toBe(expected);
      expect(h.dones(run)).toEqual([expected]);
      expect(h.lastRunEventStatus(run)).toBe(expected);
      const terminal = h.persisted(run).timeline.map((t) => t.type).filter((t) => ['completed', 'failed', 'cancelled'].includes(t));
      expect(terminal).toEqual([expected]);                                 // one terminal timeline entry, the true one
    });
});

describe('what a Stop achieved: cancellation phase', () => {
  it('an action mid-flight => winding-down, then complete once it returns; both persisted and emitted', async () => {
    const g = gated({ ok: true, summary: 'late' });
    const h = harness(g.handler);
    const run = h.fire();
    await g.entered;
    const r = h.cancel(run)!;
    expect(r.status).toBe('cancelled');                                     // acknowledged at once
    expect(r.cancellation).toEqual({ phase: 'winding-down', actionId: 'a1', label: 'Run' });
    expect(h.persisted(run).cancellation?.phase).toBe('winding-down');      // the stored record says residual work exists
    g.release();
    await tick();
    expect(h.persisted(run).cancellation).toEqual({ phase: 'complete', actionId: 'a1', label: 'Run' });
    expect(h.persisted(run).status).toBe('cancelled');
    const last = h.events.filter((e) => e.type === 'run' && (e as { run: AutomationRun }).run.id === run.id).pop() as { run: AutomationRun };
    expect(last.run.cancellation?.phase).toBe('complete');                  // the UI is told when it finished
    expect(h.persisted(run).timeline.map((t) => t.message).join('|')).toMatch(/winding down/);
  });

  it('a failing in-flight action also ends the phase, and does not turn the run failed', async () => {
    const g = gated({ ok: false, error: 'boom' });
    const h = harness(g.handler);
    const run = h.fire();
    await g.entered;
    h.cancel(run);
    g.release();
    await tick();
    expect(h.persisted(run).status).toBe('cancelled');
    expect(h.persisted(run).cancellation?.phase).toBe('complete');
  });

  it('nothing mid-flight (retry wait) => complete immediately', async () => {
    let waiting!: () => void; const waitingP = new Promise<void>((r) => { waiting = r; });
    let wake!: () => void; const wakeP = new Promise<void>((r) => { wake = r; });
    const h = harness(async () => ({ ok: false, error: 'flaky' }), { maxAttempts: 3, sleep: async () => { waiting(); await wakeP; } });
    const run = h.fire();
    await waitingP;
    expect(h.cancel(run)?.cancellation).toEqual({ phase: 'complete' });
    wake(); await tick();
    expect(h.persisted(run).cancellation).toEqual({ phase: 'complete' });
  });

  it('repeated Stop leaves the phase alone; a finished run never gains one', async () => {
    const g = gated({ ok: true });
    const h = harness(g.handler);
    const run = h.fire();
    await g.entered;
    h.cancel(run); expect(h.cancel(run)).toBeNull();
    expect(h.persisted(run).cancellation?.phase).toBe('winding-down');
    g.release(); await tick();
    expect(h.cancel(run)).toBeNull();
    expect(h.persisted(run).cancellation?.phase).toBe('complete');

    const done = harness(async () => ({ ok: true }));
    const r2 = done.fire(); await tick();
    expect(done.cancel(r2)).toBeNull();
    expect(done.persisted(r2).cancellation).toBeUndefined();
  });

  it('the abort signal reaches the handler, and a cooperative one stops early', async () => {
    let seen = false;
    let entered!: () => void; const enteredP = new Promise<void>((r) => { entered = r; });
    const store = new AutomationStore();
    const events: AutomationRunEvent[] = [];
    const engine = new AutomationEngine({
      store, emit: (e) => events.push(e), sleep: async () => undefined,
      actions: {
        'run-workflow': (async (ctx: { signal?: AbortSignal }) => {
          entered();
          await new Promise<void>((r) => ctx.signal!.addEventListener('abort', () => { seen = true; r(); }, { once: true }));
          return { ok: false, error: 'aborted' };
        }) as never,
      },
    });
    const rule = store.createRule({ name: 'C', enabled: true, trigger: { type: 'mission-completed', projectId: 'p' }, conditions: [],
      chain: [{ id: 'a1', action: 'run-workflow', label: 'Run', config: {}, continueOnError: false }], retry: { maxAttempts: 1, delayMs: 1, backoffFactor: 1 } });
    const run = engine.handleEvent({ type: 'mission-completed', projectId: 'p', projectPath: '/p', at: new Date().toISOString(), payload: {} }) as AutomationRun;
    await enteredP;
    engine.cancelRun(rule.id, run.id);
    await tick();
    expect(seen).toBe(true);
    expect(store.getRun(rule.id, run.id)!.cancellation?.phase).toBe('complete');   // it honoured the signal and returned
  });
});
