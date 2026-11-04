/**
 * The Planner: goal → structured, editable plan → explicit handoff.
 *
 * Pinned here:
 *  · a short goal naming one file is planned without any model call, and
 *    the plan targets THAT file (the old pipeline planned "review README.md"
 *    for "Add a short NOTES.md file");
 *  · a real planning run makes exactly one model call, with the Planner's
 *    own budget and no silent retries — the old pipeline made up to four
 *    calls on the 30 s interactive timeout, retried twice each;
 *  · a failed run keeps the goal and is retried in place;
 *  · edits are validated and versioned; a stale editor cannot overwrite;
 *  · the handoff carries the actual tasks and is idempotent per revision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home = '';
let project = '';
const realHome = process.env.AURA_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-planner-test-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-planner-proj-'));
  fs.writeFileSync(path.join(project, 'README.md'), '# demo\n');
  process.env.AURA_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.AURA_HOME;
  else process.env.AURA_HOME = realHome;
});

vi.mock('./signals', () => ({
  gatherMissionSignals: async () => ({
    health: null, healthIssues: [], architectureLayers: [], hotspots: [], changeVelocity: 0,
    verificationScore: 0, verificationRecommendations: [], securityFindings: [],
    buildStatus: { available: false, reason: 'test' }, gitStatus: { available: false, reason: 'test' },
    recentCommits: [], technicalDebt: [], openMissions: [],
    dependencySummary: { total: 0, pinnedExact: 0, looseRange: 0 },
  }),
}));

const { runMissionCreation, PLAN_CALL, PLAN_HEARTBEAT_MS } = await import('./orchestrator');
const { MissionStore } = await import('./store');
const {
  AURA_WORKER, applyPlanEdit, decideHandoff, namedFiles, simplePlan, toWorkspacePlan, validatePlan,
} = await import('./planner');

type GenerateArgs = [{ system?: string; user: string; json?: boolean; timeoutMs?: number; maxRetries?: number }, AbortSignal?];

function fakeManager(reply: () => { ok: true; text: string; usage: unknown } | { ok: false; error: { type: string; message: string; retryable: boolean } }) {
  const generate = vi.fn(async (..._args: GenerateArgs) => reply());
  return { manager: { pipeline: { generate, modelLabel: () => 'Test · tiny' } } as never, generate };
}

const MODEL_PLAN = JSON.stringify({
  goals: [{ id: 'g1', focusAreaId: 'scope', title: 'Calculator', rationale: 'asked', relatedEvidence: [], priority: 'high' }],
  tasks: [
    { id: 'a', goalId: 'g1', focusAreaId: 'scope', title: 'Core arithmetic', description: 'add/sub/mul/div', kind: 'file-operation', targetFile: 'src/calc.py', mode: 'new-file', priority: 'high', dependencies: [], estimatedDurationMinutes: 20, confidence: 0.8, risk: 'low', owner: 'ai', automationLevel: 'automatic', files: [] },
    { id: 'b', goalId: 'g1', focusAreaId: 'scope', title: 'Tests', description: 'cover division by zero', kind: 'file-operation', targetFile: 'tests/test_calc.py', mode: 'new-file', priority: 'medium', dependencies: ['a'], estimatedDurationMinutes: 15, confidence: 0.8, risk: 'low', owner: 'ai', automationLevel: 'automatic', files: ['src/calc.py'] },
  ],
});

describe('planning a goal', () => {
  it('plans a short one-file goal without a model call, targeting that file', async () => {
    const { manager, generate } = fakeManager(() => { throw new Error('must not be called'); });
    const store = new MissionStore();
    const events: string[] = [];
    const rec = await runMissionCreation(manager, store, 'p1', project, 'Add a short NOTES.md file',
      (e) => { if (e.type === 'stage') events.push(`${e.stage}:${e.status}`); });
    expect(generate).not.toHaveBeenCalled();
    expect(rec.error).toBeUndefined();
    expect(rec.planning?.path).toBe('deterministic');
    const tasks = rec.goalGraph!.tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ targetFile: 'NOTES.md', mode: 'new-file', worker: AURA_WORKER, title: 'Create NOTES.md' });
    expect(rec.planIssues).toEqual([]);
    expect(events).toEqual(['context:start', 'context:done', 'plan:start', 'plan:done', 'check:start', 'check:done']);
    // Saved, and reopens with its contents.
    expect(store.get('p1', rec.id)?.goalGraph?.tasks[0].targetFile).toBe('NOTES.md');
  });

  it('a larger goal makes exactly one model call with the Planner budget', async () => {
    const { manager, generate } = fakeManager(() => ({ ok: true, text: MODEL_PLAN, usage: {} }));
    const rec = await runMissionCreation(manager, new MissionStore(), 'p1', project, 'Make a calculator app with tests', () => {});
    expect(generate).toHaveBeenCalledTimes(1);
    const req = generate.mock.calls[0][0];
    expect(req).toMatchObject({ json: true, timeoutMs: PLAN_CALL.timeoutMs, maxRetries: 0, stream: true });
    expect(rec.planning).toMatchObject({ path: 'model', model: 'Test · tiny' });
    const [a, b] = rec.goalGraph!.tasks;
    expect(b.dependencies).toEqual([a.id]);
    expect(b.files).toEqual(['src/calc.py']);
    expect(rec.quality).toBeNull();
    expect(rec.review).toBeNull();
  });

  it('reports real elapsed time against the real deadline while the model call runs', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const generate = vi.fn(() => new Promise<{ ok: true; text: string; usage: unknown }>((r) => { release = () => r({ ok: true, text: MODEL_PLAN, usage: {} }); }));
      const manager = { pipeline: { generate, modelLabel: () => 'Test · tiny' } } as never;
      const beats: { elapsedMs: number; deadlineMs: number; receivedChars: number }[] = [];
      const run = runMissionCreation(manager, new MissionStore(), 'p1', project, 'Make a calculator app with tests',
        (e) => { if (e.type === 'progress') beats.push({ elapsedMs: e.elapsedMs, deadlineMs: e.deadlineMs, receivedChars: e.receivedChars }); });
      await vi.advanceTimersByTimeAsync(PLAN_HEARTBEAT_MS * 3 + 10);
      expect(beats.length).toBe(3);
      expect(beats[2].elapsedMs).toBeGreaterThanOrEqual(PLAN_HEARTBEAT_MS * 3);
      expect(beats[0].deadlineMs).toBe(PLAN_CALL.timeoutMs);
      release();
      await run;
      const before = beats.length;
      await vi.advanceTimersByTimeAsync(PLAN_HEARTBEAT_MS * 2);
      expect(beats.length).toBe(before);   // the heartbeat stops with the call
    } finally { vi.useRealTimers(); }
  });

  it('a plan cut off by the output limit says so instead of "invalid JSON"', async () => {
    const { manager } = fakeManager(() => ({ ok: true, text: '{"goals":[{"id":"g1","title":"x"', usage: {}, finishReason: 'length' } as never));
    const rec = await runMissionCreation(manager, new MissionStore(), 'p1', project, 'Make a calculator app with tests', () => {});
    expect(rec.goalGraph).toBeNull();
    expect(rec.error).toContain('whole output budget');
    expect(rec.error).toContain('2048 tokens');
    expect(rec.error).not.toContain('valid JSON');
  });

  it('a failed planning call keeps the goal and is retried in place', async () => {
    let fail = true;
    const { manager } = fakeManager(() => (fail
      ? { ok: false, error: { type: 'timeout', message: 'The request to Ollama timed out.', retryable: true } }
      : { ok: true, text: MODEL_PLAN, usage: {} }));
    const store = new MissionStore();
    const failed = await runMissionCreation(manager, store, 'p1', project, 'Make a calculator app with tests', () => {});
    expect(failed.error).toBe('Planning failed: The request to Ollama timed out.');
    expect(failed.goalGraph).toBeNull();
    fail = false;
    const retried = await runMissionCreation(manager, store, 'p1', project, failed.text, () => {}, undefined, failed.id);
    expect(retried.id).toBe(failed.id);
    expect(retried.error).toBeUndefined();
    expect(retried.goalGraph!.tasks).toHaveLength(2);
    expect(store.list('p1')).toHaveLength(1);
  });
});

describe('plan rules', () => {
  it('finds the files a goal names', () => {
    expect(namedFiles('Add a short NOTES.md file')).toEqual(['NOTES.md']);
    expect(namedFiles('update src/app.ts and docs/README.md')).toEqual(['src/app.ts', 'docs/README.md']);
    expect(namedFiles('make a calculator app')).toEqual([]);
  });

  it('keeps the lightweight path to genuinely simple goals', () => {
    expect(simplePlan('Make a calculator app', project)).toBeNull();
    expect(simplePlan('Update README.md and then add CHANGELOG.md', project)).toBeNull();
    const edit = simplePlan('Improve README.md', project)!;
    expect(edit.tasks[0]).toMatchObject({ targetFile: 'README.md', mode: 'diff', title: 'Update README.md' });
  });

  it('reports what blocks a handoff, and what is only a warning', () => {
    const graph = applyPlanEdit(null, [
      { id: 'a', title: 'Write it', targetFile: 'a.md', dependencies: ['b'] },
      { id: 'b', title: 'Then this', targetFile: 'b.md', dependencies: ['a'] },
      { id: 'c', title: 'Think', targetFile: null },
    ]);
    const issues = validatePlan(graph, 'Add NOTES.md');
    expect(issues.find((i) => i.message.includes('loop'))?.blocksHandoff).toBe(true);
    // A task with no target file is fine: a connected coding agent is selected for it when the plan is sent.
    expect(issues.find((i) => i.taskId === 'c')).toBeUndefined();
    // A deliverable the REQUEST names, that no task targets or even
    // mentions, BLOCKS. A plan states its own acceptance criteria, so a
    // plan that ignores what was asked for can still satisfy itself — and
    // then report a verified mission for work nobody did.
    expect(issues.find((i) => i.message.includes('NOTES.md'))?.blocksHandoff).toBe(true);
  });

  it('does not block when a task mentions the file the request names', () => {
    // "Write tests for src/app.js" names a file no task will write: the
    // test task mentions it, so the plan addresses the request.
    const graph = applyPlanEdit(null, [
      { id: 'a', title: 'Write the tests', targetFile: 'tests/app.test.js', description: 'Cover src/app.js' },
    ]);
    const issues = validatePlan(graph, 'Write tests for src/app.js');
    expect(issues.find((i) => i.message.includes('src/app.js'))).toBeUndefined();
  });

  it('blocks a plan that ignores every deliverable the request names', () => {
    const graph = applyPlanEdit(null, [
      { id: 'a', title: 'Create API endpoints', targetFile: 'src/api/add.js' },
    ]);
    const issues = validatePlan(graph, 'Create src/math.js and tests/math.test.js');
    const blocking = issues.filter((i) => i.blocksHandoff);
    expect(blocking.some((i) => i.message.includes('src/math.js'))).toBe(true);
    expect(blocking.some((i) => i.message.includes('tests/math.test.js'))).toBe(true);
  });

  it('refuses paths outside the project when a plan is edited', () => {
    expect(() => applyPlanEdit(null, [{ title: 'x', targetFile: '../../etc/passwd' }])).toThrow(/inside the project/);
    expect(() => applyPlanEdit(null, [{ title: 'x', targetFile: '/etc/passwd' }])).toThrow(/inside the project/);
  });
});

describe('handoff to Workspace', () => {
  const record = () => {
    const graph = applyPlanEdit(null, [
      { id: 'impl', title: 'Implement', description: 'do it', targetFile: 'src/a.py', dependencies: [] },
      { id: 'test', title: 'Test', description: 'check it', targetFile: null, files: ['tests/t.py'], dependencies: ['impl'], worker: 'claude-code' },
    ]);
    return { id: 'mission-1', text: 'Build A', revision: 3, goalGraph: graph, handoffs: [] } as never;
  };
  let n = 0;
  const fresh = () => { n += 1; return { id: `handoff-${n}`, sessionId: `agt-00000000000${n}` }; };

  it('carries the actual tasks, files, dependencies and workers', () => {
    const plan = toWorkspacePlan(record());
    expect(plan).toMatchObject({ source: 'planner', planId: 'mission-1', revision: 3, goal: 'Build A' });
    expect(plan.tasks).toEqual([
      { id: 'impl', title: 'Implement', description: 'do it', targetFile: 'src/a.py', files: [], dependsOn: [], worker: null, expectedOutput: '', verification: '', requires: [] },
      { id: 'test', title: 'Test', description: 'check it', targetFile: null, files: ['tests/t.py'], dependsOn: ['impl'], worker: 'claude-code', expectedOutput: '', verification: '', requires: [] },
    ]);
  });

  it('is idempotent per revision, and refuses a stale revision', () => {
    const rec = record() as { handoffs: unknown[] };
    const first = decideHandoff(rec as never, 3, fresh, 'now');
    expect(first.ok && first.duplicate).toBe(false);
    if (!first.ok) throw new Error('unexpected');
    rec.handoffs = first.handoffs;
    const again = decideHandoff(rec as never, 3, fresh, 'later');
    expect(again.ok && again.duplicate).toBe(true);
    expect(again.ok && again.handoff.sessionId).toBe(first.handoff.sessionId);
    const stale = decideHandoff(rec as never, 2, fresh, 'later');
    expect(stale).toMatchObject({ ok: false, status: 409 });
  });

  it('retrying a handoff that failed to start reuses its session', () => {
    const rec = record() as { handoffs: unknown[] };
    rec.handoffs = [{ id: 'h1', revision: 3, sessionId: 'agt-aaaaaaaaaaaa', status: 'failed', at: 'x' }];
    const retry = decideHandoff(rec as never, 3, fresh, 'now');
    expect(retry.ok && retry.duplicate).toBe(false);
    expect(retry.ok && retry.handoff).toMatchObject({ id: 'h1', sessionId: 'agt-aaaaaaaaaaaa', status: 'reserved' });
  });

  it('sends a task with no target file: Laya selects a connected coding agent for it at run time', () => {
    const graph = applyPlanEdit(null, [{ id: 'x', title: 'Build the audio engine', targetFile: null }]);
    const out = decideHandoff({ id: 'm', text: 'g', revision: 1, goalGraph: graph } as never, 1, fresh, 'now');
    expect(out).toMatchObject({ ok: true });
  });
});

describe('plan context budget', () => {
  it('keeps the head of an oversized context (goal and decisions come first) and says it cut', async () => {
    const { boundPlanContext, PLAN_CONTEXT_CHARS } = await import('./goalGraph');
    const long = `[goal] build X\n[decision] use SQLite\n${'filler line\n'.repeat(1000)}[late note] unimportant`;
    const out = boundPlanContext(long);
    expect(out.length).toBeLessThan(PLAN_CONTEXT_CHARS + 120);
    expect(out).toContain('[goal] build X');
    expect(out).toContain('[decision] use SQLite');
    expect(out).not.toContain('[late note]');
    expect(out).toContain('omitted');
    expect(boundPlanContext('[goal] short')).toBe('[goal] short');
  });
});
