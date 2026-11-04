/**
 * What Stop does to the five automation actions that used to ignore the abort
 * signal (governance audit, security review, docs review, knowledge update,
 * save memory). A Stop can only be observed at an `await`, so each action checks
 * the signal right after its awaits and before any write; the policies pinned here:
 *   - a cancelled governance audit persists NO snapshot (the next audit diffs against it);
 *   - a cancelled knowledge update leaves the live graph and the index on disk exactly as they were;
 *   - a cancelled report returns a failed ActionResult that says what was and was not done
 *     (the engine keeps the run `cancelled`; first terminal state wins);
 *   - an action that has already finished is not affected by a later abort.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FullStackKnowledgeEngine } from '@aura/knowledge-fullstack';
import { getEngineeringAudit, getSecurityReport, getDocumentationHealth, OperationCancelled, npmAuditCommand } from '@aura/governance';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aura-cancel-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  for (let i = 0; i < 6; i++) { mkdirSync(path.join(root, `pkg${i}`), { recursive: true }); writeFileSync(path.join(root, `pkg${i}`, 'package.json'), `{"name":"old${i}","version":"1.0.0"}`); }
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'README.md'), '# demo\n');
  writeFileSync(path.join(root, 'package.json'), '{"name":"demo","version":"1.0.0"}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const aborted = () => { const c = new AbortController(); c.abort(); return c.signal; };
const entityIds = (e: FullStackKnowledgeEngine) => e.graph().entities.map((x) => x.id).sort();

describe('knowledge update (update-knowledge)', () => {
  it('a Stop mid-update leaves the live graph and the index as they were, and a later update still works', async () => {
    const idx = path.join(root, '.idx');
    const engine = new FullStackKnowledgeEngine(root, { indexDir: idx });
    await engine.analyze();
    const before = entityIds(engine);
    const onDisk = readdirSync(idx).sort();
    // change every source file so the update has real work to do
    const later = new Date(Date.now() + 5000);
    for (let i = 0; i < 6; i++) { const f = path.join(root, `pkg${i}`, 'package.json'); writeFileSync(f, `{"name":"new${i}","version":"2.0.0"}`); utimesSync(f, later, later); }
    const ac = new AbortController();
    let seen = 0;
    await expect(engine.update({ signal: ac.signal, onProgress: (p: { phase: string }) => { if (p.phase === 'analyze' && ++seen === 3) ac.abort(); } } as never)).rejects.toThrow(/cancel/i);
    expect(entityIds(engine)).toEqual(before);            // no half-updated graph visible to searches
    expect(readdirSync(idx).sort()).toEqual(onDisk);      // and nothing new was written
    const delta = await engine.update();                  // the abandoned attempt did not poison the next one
    expect(delta.filesModified).toBe(6);                  // all six, not just the ones the abandoned attempt never reached
    expect(entityIds(engine)).not.toEqual(before);
    expect(engine.graph().entities.some((e) => e.name === 'new0')).toBe(true);
    expect(engine.graph().entities.some((e) => e.name === 'old0')).toBe(false);
  });
});

describe('governance reports', () => {
  it('an already-cancelled report stops before doing any work', async () => {
    await expect(getSecurityReport({ projectPath: root, signal: aborted() })).rejects.toBeInstanceOf(OperationCancelled);
    await expect(getDocumentationHealth({ projectPath: root, signal: aborted() })).rejects.toBeInstanceOf(OperationCancelled);
    await expect(getEngineeringAudit({ projectPath: root, signal: aborted() })).rejects.toBeInstanceOf(OperationCancelled);
  });

  it('a cancelled audit persists NO snapshot; an uncancelled one does', async () => {
    const snaps = path.join(root, '.aura', 'governance', 'audits');
    const ac = new AbortController();
    const p = getEngineeringAudit({ projectPath: root, signal: ac.signal });
    ac.abort();                                           // lands at the first await after the call starts
    await expect(p).rejects.toBeInstanceOf(OperationCancelled);
    expect(existsSync(snaps)).toBe(false);
    await getEngineeringAudit({ projectPath: root });     // control: the write is real when nothing cancels it
    expect(readdirSync(snaps).length).toBe(1);
  });

  it('an audit cancelled at its FINAL check (just before the snapshot write) writes nothing', async () => {
    const snaps = path.join(root, '.aura', 'governance', 'audits');
    // A signal that counts how often the audit reads it, and can flip on the Nth read.
    const probe = (abortAt: number) => {
      let reads = 0;
      const signal = { get aborted() { reads += 1; return abortAt > 0 && reads >= abortAt; }, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
      return { signal, reads: () => reads };
    };
    const full = probe(0);
    await getEngineeringAudit({ projectPath: root, signal: full.signal });          // uncancelled run: count the reads
    const total = full.reads();
    expect(total).toBeGreaterThan(8);
    rmSync(path.join(root, '.aura'), { recursive: true, force: true });
    const last = probe(total);                                                       // abort at exactly the last read
    await expect(getEngineeringAudit({ projectPath: root, signal: last.signal })).rejects.toBeInstanceOf(OperationCancelled);
    expect(existsSync(snaps)).toBe(false);                                           // nothing persisted for an abandoned report
  });
});

describe('npm audit command', () => {
  it('is platform correct: plain `npm` on POSIX, a shell-run npm.cmd with fixed arguments on Windows', () => {
    expect(npmAuditCommand('linux')).toEqual({ file: 'npm', shell: false });
    expect(npmAuditCommand('darwin')).toEqual({ file: 'npm', shell: false });
    expect(npmAuditCommand('win32')).toEqual({ file: 'npm.cmd', shell: true });
  });
});

// ── through the real runtime: what the run and the action record ───────────────
import { createAutomationRuntime } from './automation';
import type { AutomationRun } from '@aura/automation';

describe('Stop through the automation runtime', () => {
  const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  // Poll instead of sleeping a fixed amount: a Stop must be *observed* to end the action, and
  // a loaded machine can take well over 200 ms to get there. The deadline is the assertion —
  // if the action never leaves its in-flight state, the status check below fails.
  const until = async (done: () => boolean, deadlineMs = 10_000) => {
    const end = Date.now() + deadlineMs;
    while (!done() && Date.now() < end) await tick(25);
  };
  let home: string; let prevHome: string | undefined;
  beforeEach(() => { prevHome = process.env.AURA_HOME; home = mkdtempSync(path.join(tmpdir(), 'aura-rt-')); process.env.AURA_HOME = home; });
  afterEach(() => { if (prevHome === undefined) delete process.env.AURA_HOME; else process.env.AURA_HOME = prevHome; rmSync(home, { recursive: true, force: true }); });

  function runtime(extra: { update?: (o: { signal?: AbortSignal }) => Promise<unknown>; added?: number[] } = {}) {
    const host = {
      projectPath: () => root,
      pipelineFor: () => ({ fullstack: { update: extra.update ?? (async () => ({ filesAdded: 0, filesModified: 0, filesDeleted: 0 })) } }),
      memoryFor: () => ({ add: () => { extra.added?.push(1); return { id: 'm1', kind: 'decision' }; } }),
      diagnoses: {},
    } as never;
    const rt = createAutomationRuntime(host);
    const mk = (chain: Array<{ id: string; action: string }>) => rt.store.createRule({
      name: 'R', enabled: true, trigger: { type: 'mission-completed', projectId: 'p' }, conditions: [],
      chain: chain.map((c) => ({ ...c, label: c.action, config: {}, continueOnError: false })) as never,
      retry: { maxAttempts: 1, delayMs: 1, backoffFactor: 1 },
    });
    const fire = () => rt.engine.handleEvent({ type: 'mission-completed', projectId: 'p', projectPath: root, at: new Date().toISOString(), payload: {} }) as AutomationRun;
    return { rt, mk, fire };
  }

  it.each(['run-security-review', 'run-docs-review', 'run-governance-audit'])('%s: a Stop ends it at the next await; the run stays cancelled; the action says what was not done', async (action) => {
    const { rt, mk, fire } = runtime();
    const rule = mk([{ id: 'a1', action }]);
    const run = fire();
    expect(rt.engine.cancelRun(rule.id, run.id)?.status).toBe('cancelled');
    await until(() => rt.store.getRun(rule.id, run.id)!.actions[0]?.status === 'failed');
    const stored = rt.store.getRun(rule.id, run.id)!;
    expect(stored.status).toBe('cancelled');                              // not rewritten as failed by the action's failure
    expect(stored.actions[0].status).toBe('failed');
    expect(stored.actions[0].error).toMatch(/stopped before it finished/);
    expect(stored.cancellation?.phase).toBe('complete');                  // it returned: nothing of this run is executing
    expect(rt.store.getRun(rule.id, run.id)!.timeline.filter((t) => t.type === 'cancelled')).toHaveLength(1);
    if (action === 'run-governance-audit') expect(existsSync(path.join(root, '.aura', 'governance', 'audits'))).toBe(false);
  });

  it('a Stop during update-knowledge delivers the signal; the handler reports the index was left untouched', async () => {
    let received: AbortSignal | undefined;
    const { rt, mk, fire } = runtime({
      update: (o) => new Promise((_, reject) => { received = o.signal; o.signal!.addEventListener('abort', () => reject(Object.assign(new Error('Update cancelled'), { name: 'AbortError' })), { once: true }); }),
    });
    const rule = mk([{ id: 'a1', action: 'update-knowledge' }]);
    const run = fire();
    await tick();
    expect(received).toBeDefined();
    rt.engine.cancelRun(rule.id, run.id);
    await tick();
    const stored = rt.store.getRun(rule.id, run.id)!;
    expect(received!.aborted).toBe(true);
    expect(stored.status).toBe('cancelled');
    expect(stored.actions[0].error).toMatch(/index on disk and the live graph were left as they were/);
    expect(stored.cancellation?.phase).toBe('complete');
  });

  it('a Stop before the next action starts means save-memory never runs and nothing is saved', async () => {
    const added: number[] = [];
    const { rt, mk, fire } = runtime({ added });
    const rule = mk([{ id: 'a1', action: 'run-docs-review' }, { id: 'a2', action: 'save-memory' }]);
    const run = fire();
    rt.engine.cancelRun(rule.id, run.id);
    await tick(250);
    const stored = rt.store.getRun(rule.id, run.id)!;
    expect(added).toEqual([]);
    expect(stored.actions[1].status).not.toBe('completed');
    expect(stored.status).toBe('cancelled');
  });

  it('an action that finished before the Stop is untouched by it; a repeated Stop does nothing', async () => {
    const added: number[] = [];
    const { rt, mk, fire } = runtime({ added });
    const rule = mk([{ id: 'a1', action: 'save-memory' }]);
    const run = fire();
    await tick();
    expect(added).toEqual([1]);                                           // the write happened and cannot be undone by a Stop
    expect(rt.engine.cancelRun(rule.id, run.id)).toBeNull();              // already completed
    expect(rt.engine.cancelRun(rule.id, run.id)).toBeNull();
    expect(rt.store.getRun(rule.id, run.id)!.status).toBe('completed');
  });
});
