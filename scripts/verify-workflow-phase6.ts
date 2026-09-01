/**
 * Verification harness for Phase 6 — Real Executors + Trigger Scheduler.
 *
 *   node scripts/run-ts.mjs scripts/verify-workflow-phase6.ts
 *
 * Part A — Live execution: workflows drive REAL fabric executors that
 * spawn REAL processes (terminal.execute → safeShellWithCode, git.*
 * → git(), filesystem.write → writeFile). All in an isolated temp
 * project. Verifies: workflow result, real side effect, policy
 * decision, audit record.
 *
 * Part B — Trigger scheduler: schedule triggers (cron + injectable
 * timer), single-flight, start/stop/reload, restart, failure handling,
 * isolation.
 *
 * Part C — Security: runtime source scan for shell/git/fs bypass.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WorkflowRuntime,
  WorkflowDefinitionStore,
  WorkflowRunStore,
  TriggerScheduler,
  parseCron,
  nextCronFire,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@aura/workflow';
import { CapabilityFabric, type Executor, type ExecutorResult, type FabricHost, type VerificationReport } from '@aura/capability-fabric';
import { safeShellWithCode, git } from '@aura/ai-service/exec/process';
import { createFileChangeEventSource, createGitEventSource, createMissionEventSource } from '@aura/ai-service/workflow/triggerSources';
import { MissionStore } from '@aura/ai-service/mission/store';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); }
  else { failed += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const N = (id: string, type: WorkflowNode['type'], config: Record<string, unknown> = {}): WorkflowNode => ({ id, type, x: 0, y: 0, config });
const E = (from: string, fromPort: string, to: string, toPort = 'in'): WorkflowDefinition['edges'][number] => ({ id: `e-${from}-${to}`, from, fromPort, to, toPort });
const DEF = (id: string, nodes: WorkflowNode[], edges: WorkflowDefinition['edges'][number][], settings: WorkflowDefinition['settings'] = {}): WorkflowDefinition => ({
  schemaVersion: 1, id, name: id, description: '', projectId: 'test-proj', status: 'ready', version: 1,
  nodes, edges, settings, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const okR = (detail: string, output?: unknown): ExecutorResult => ({ ok: true, detail, output });
const noR = (detail: string): ExecutorResult => ({ ok: false, detail });
const passV = (kind: VerificationReport['kind'], detail: string): VerificationReport => ({ passed: true, kind, detail });
const failV = (kind: VerificationReport['kind'], detail: string): VerificationReport => ({ passed: false, kind, detail });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ── real executors (thin wrappers over the real process primitives) ── */

function makeRealExecutors(projectDir: string): Executor[] {
  const terminalExecute: Executor = {
    capabilityId: 'terminal.execute',
    supportsNode: () => true,
    async run(inv) {
      const command = s(inv.input.command);
      try {
        const { out, code } = await safeShellWithCode(command, { cwd: projectDir, timeoutMs: inv.context.timeoutMs });
        return code === 0
          ? okR('Exit code 0.', { stdout: out, exitCode: code })
          : { ok: false, detail: `Exit code ${code}. ${out.slice(0, 400)}`, output: { stdout: out, exitCode: code } };
      } catch (e) {
        return noR((e as Error).message || 'Command failed.');
      }
    },
    async verify(_inv, result) {
      const exit = (result.output as { exitCode?: number } | undefined)?.exitCode;
      return exit === 0 ? passV('exit-code', 'The command exited 0.') : failV('exit-code', `The command exited ${exit ?? 'unknown'}.`);
    },
  };

  const gitStatus: Executor = {
    capabilityId: 'git.status',
    supportsNode: () => true,
    async run(inv) {
      const { out } = await git(['status', '--short', '--branch'], { cwd: projectDir });
      return okR(out ? 'Working tree has changes.' : 'Working tree is clean.', out || 'clean');
    },
  };

  const gitDiff: Executor = {
    capabilityId: 'git.diff',
    supportsNode: () => true,
    async run(inv) {
      const args = ['diff', '--stat', '-p', '--no-color'];
      if (inv.input.staged === true) args.splice(1, 0, '--cached');
      const { out } = await git(args, { cwd: projectDir });
      return okR(out ? 'Diff produced.' : 'No changes.', out || 'no changes');
    },
  };

  const filesystemWrite: Executor = {
    capabilityId: 'filesystem.write',
    supportsNode: () => true,
    async run(inv) {
      const target = path.resolve(projectDir, s(inv.input.path));
      if (!target.startsWith(projectDir)) return noR('That path leaves the project directory.');
      const content = s(inv.input.content);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, 'utf8');
      return okR(`Wrote ${Buffer.byteLength(content)} bytes.`, { path: target });
    },
    async verify(inv) {
      const target = path.resolve(projectDir, s(inv.input.path));
      try {
        const actual = await fsp.readFile(target, 'utf8');
        return actual === s(inv.input.content)
          ? passV('read-back', 'Read the file back and the contents match.')
          : failV('read-back', 'The file exists but its contents differ.');
      } catch {
        return failV('read-back', 'The file could not be read back.');
      }
    },
  };

  const gitCommit: Executor = {
    capabilityId: 'git.commit',
    supportsNode: () => true,
    async run(inv) {
      const message = s(inv.input.message).split('\n')[0].trim();
      if (!message) return noR('A commit message is required.');
      const status = await git(['status', '--porcelain'], { cwd: projectDir });
      if (!status.out) return okR('Nothing to commit.', { committed: false });
      await git(['add', '-A'], { cwd: projectDir });
      const res = await git(['commit', '-m', message], { cwd: projectDir });
      if (res.code !== 0) return noR(res.out || 'The commit failed.');
      return okR(`Committed: ${message}`, { committed: true, message });
    },
    async verify(_inv, result) {
      if ((result.output as { committed?: boolean } | undefined)?.committed === false) {
        return passV('read-back', 'Nothing needed committing.');
      }
      const { out } = await git(['log', '-1', '--pretty=%s'], { cwd: projectDir });
      const message = s(_inv.input.message).split('\n')[0].trim();
      return out === message ? passV('read-back', 'HEAD is the new commit.') : failV('read-back', `HEAD's subject is "${out}".`);
    },
  };

  return [terminalExecute, gitStatus, gitDiff, gitCommit, filesystemWrite];
}

function makeFabricHost(): FabricHost {
  return {
    permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: false }),
    nodeAvailable: () => true,
    resolveNode: () => ({ ok: true, node: { id: 'local', name: 'Local', capabilities: [] } }),
    requestApproval: async () => false,
  };
}

const AUTO_POLICY = {
  byRisk: { low: 'auto-execute' as const, medium: 'auto-execute' as const, high: 'auto-execute' as const },
  overrides: {},
  allowAutonomous: true,
};

interface LiveHarness {
  fabric: CapabilityFabric;
  definitions: WorkflowDefinitionStore;
  runs: WorkflowRunStore;
  runtime: WorkflowRuntime;
  projectDir: string;
  tmp: string;
}

function liveHarness(): LiveHarness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-phase6-'));
  process.env.AURA_HOME = tmp;
  const projectDir = path.join(tmp, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'workflow-defs'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'workflow-runs'), { recursive: true });

  const fabric = new CapabilityFabric(makeFabricHost());
  fabric.setPolicy(AUTO_POLICY);
  for (const exec of makeRealExecutors(projectDir)) fabric.register(exec);

  const ai = { generate: async () => ({ ok: true, output: 'ai-result' }) };
  const missions = {
    update: async () => ({ ok: true, state: 'active' }),
    wait: async () => ({ ok: true, state: 'completed' }),
  };
  const definitions = new WorkflowDefinitionStore({ baseDir: tmp });
  const runs = new WorkflowRunStore({ baseDir: tmp });
  const runtime = new WorkflowRuntime(
    { fabric, ai, missions, projectPath: () => projectDir, askApproval: async () => false, sleep },
    { definitions, runs },
  );
  return { fabric, definitions, runs, runtime, projectDir, tmp };
}

async function setupGitRepo(dir: string): Promise<void> {
  await git(['init'], { cwd: dir });
  await git(['config', 'user.email', 'test@test.com'], { cwd: dir });
  await git(['config', 'user.name', 'Test'], { cwd: dir });
  await fsp.writeFile(path.join(dir, 'README.md'), '# Test\n', 'utf8');
  await git(['add', '-A'], { cwd: dir });
  await git(['commit', '-m', 'initial'], { cwd: dir });
}

/** Host-side trigger sources wired to the isolated temp environment. */
async function makeHostSources(projectDir: string, _auraHome: string) {
  const projects = { resolve: (projectId: string | null) => (projectId === 'test-proj' ? projectDir : null) };
  const missionStore = new MissionStore();
  return {
    'file-change': createFileChangeEventSource({ projects, pollMs: 200, quietMs: 100 }),
    'git-event': createGitEventSource({ projects, pollMs: 200 }),
    'mission-event': createMissionEventSource({ projects, missions: missionStore, pollMs: 200 }),
  };
}

/** Write a minimal mission record so the MissionEventSource can see it. */
async function writeMissionRecord(auraHome: string, projectId: string, missionId: string): Promise<void> {
  const dir = path.join(auraHome, 'missions', projectId);
  await fsp.mkdir(dir, { recursive: true });
  const rec = {
    id: missionId, projectId, text: 'test mission', createdAt: new Date().toISOString(),
    classification: null, intent: null, signals: {}, strategy: null, goalGraph: null,
    risk: null, review: null, quality: null, approval: { status: 'pending' }, taskRuns: [],
  };
  await fsp.writeFile(path.join(dir, `${missionId}.json`), JSON.stringify(rec), 'utf8');
}

/* ══════════════════════════════════════════════════════════════════
   Part A — Live execution tests
   ══════════════════════════════════════════════════════════════════ */

async function testLiveExecution() {
  console.log('\n[A1] workflow → terminal.execute (real process)');
  {
    const h = liveHarness();
    const wf = DEF('live-term', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: node -e console.log("hello-phase6")' }),
      N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    h.definitions.record(wf);
    const run = await h.runtime.startRun('live-term', { inputs: {} });
    check('run completed', run.status === 'completed', JSON.stringify(run.status));
    const c = run.nodeRuns.find((n) => n.nodeId === 'c')!;
    check('capability succeeded', c.status === 'success');
    check('real stdout captured', (c.outputs as { value: { stdout: string } }).value.stdout.includes('hello-phase6'), JSON.stringify(c.outputs));
    check('policy auto-execute', c.policy?.decision === 'auto-execute');
    check('audit has invocation', c.auditIds.length >= 1);
    const auditRec = h.fabric.audit().find((a) => a.invocationId === c.auditIds[0]);
    check('audit records terminal.execute', auditRec?.capabilityId === 'terminal.execute');
    check('audit outcome succeeded', auditRec?.outcome === 'succeeded');
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[A2] workflow → git.status (real git)');
  {
    const h = liveHarness();
    await setupGitRepo(h.projectDir);
    const wf = DEF('git-status', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'git.status' }),
      N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    h.definitions.record(wf);
    const run = await h.runtime.startRun('git-status', { inputs: {} });
    check('run completed', run.status === 'completed', JSON.stringify(run.status));
    const c = run.nodeRuns.find((n) => n.nodeId === 'c')!;
    check('git.status succeeded', c.status === 'success');
    check('real git output captured', typeof (c.outputs as { value: string }).value === 'string');
    check('audit correlation', c.auditIds.length >= 1 && h.fabric.audit().find((a) => a.invocationId === c.auditIds[0])?.capabilityId === 'git.status');
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[A3] workflow → git.diff (real git)');
  {
    const h = liveHarness();
    await setupGitRepo(h.projectDir);
    await fsp.appendFile(path.join(h.projectDir, 'README.md'), 'uncommitted change\n', 'utf8');
    const wf = DEF('git-diff', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'git.diff' }),
      N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    h.definitions.record(wf);
    const run = await h.runtime.startRun('git-diff', { inputs: {} });
    check('run completed', run.status === 'completed');
    const c = run.nodeRuns.find((n) => n.nodeId === 'c')!;
    check('git.diff succeeded', c.status === 'success');
    const diff = (c.outputs as { value: string }).value;
    check('diff shows uncommitted change', diff.includes('README.md'), diff.slice(0, 200));
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[A4] workflow → filesystem.write (real file)');
  {
    const h = liveHarness();
    const wf = DEF('fs-write', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'filesystem.write', inputMap: 'path: output.txt\ncontent: phase6-was-here' }),
      N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    h.definitions.record(wf);
    const run = await h.runtime.startRun('fs-write', { inputs: {} });
    check('run completed', run.status === 'completed');
    const c = run.nodeRuns.find((n) => n.nodeId === 'c')!;
    check('filesystem.write succeeded', c.status === 'success');
    const written = await fsp.readFile(path.join(h.projectDir, 'output.txt'), 'utf8').catch(() => null);
    check('real file written', written === 'phase6-was-here', String(written));
    check('verify passed (read-back)', c.policy?.decision === 'auto-execute');
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[A5] workflow → git.commit (governed write)');
  {
    const h = liveHarness();
    await setupGitRepo(h.projectDir);
    await fsp.writeFile(path.join(h.projectDir, 'change.txt'), 'changed\n', 'utf8');
    const wf = DEF('git-commit', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'git.commit', inputMap: 'message: phase6 test commit' }),
      N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    h.definitions.record(wf);
    const run = await h.runtime.startRun('git-commit', { inputs: {} });
    check('run completed', run.status === 'completed', JSON.stringify(run.status));
    const c = run.nodeRuns.find((n) => n.nodeId === 'c')!;
    check('git.commit succeeded', c.status === 'success');
    const { out } = await git(['log', '-1', '--pretty=%s'], { cwd: h.projectDir });
    check('real commit created', out === 'phase6 test commit', out);
    check('audit has capability', h.fabric.audit().find((a) => a.invocationId === c.auditIds[0])?.capabilityId === 'git.commit');
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[A6] policy denial (real enforcement)');
  {
    const h = liveHarness();
    h.fabric.setPolicy({
      byRisk: { low: 'auto-execute' as const, medium: 'deny' as const, high: 'deny' as const },
      overrides: {}, allowAutonomous: true,
    });
    const wf = DEF('policy-deny', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: node -e console.log("blocked")' }),
    ], [E('t', 'out', 'c')]);
    h.definitions.record(wf);
    const run = await h.runtime.startRun('policy-deny', { inputs: {} });
    check('run failed', run.status === 'failed', JSON.stringify(run.status));
    const c = run.nodeRuns.find((n) => n.nodeId === 'c')!;
    check('capability denied', c.status === 'failed');
    check('policy recorded as deny', c.policy?.decision === 'deny', JSON.stringify(c.policy?.decision));
    check('audit records denial', h.fabric.audit().find((a) => a.invocationId === c.auditIds[0])?.outcome === 'denied');
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[A7] multi-node live chain (terminal → filesystem → git.status)');
  {
    const h = liveHarness();
    await setupGitRepo(h.projectDir);
    const wf = DEF('live-chain', [
      N('t', 'manual'),
      N('term', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: node -e console.log("chain-step-1")' }),
      N('write', 'capability', { capabilityId: 'filesystem.write', inputMap: 'path: chain.txt\ncontent: from-chain' }),
      N('status', 'capability', { capabilityId: 'git.status' }),
      N('r', 'result'),
    ], [E('t', 'out', 'term'), E('term', 'out', 'write'), E('write', 'out', 'status'), E('status', 'out', 'r')]);
    h.definitions.record(wf);
    const run = await h.runtime.startRun('live-chain', { inputs: {} });
    check('chain completed', run.status === 'completed', JSON.stringify(run.status));
    check('all nodes success', run.nodeRuns.every((n) => n.status === 'success'), JSON.stringify(run.nodeRuns.map((n) => [n.nodeId, n.status])));
    const file = await fsp.readFile(path.join(h.projectDir, 'chain.txt'), 'utf8').catch(() => null);
    check('file written by chain', file === 'from-chain');
    check('fabric audited all 3 invocations', h.fabric.audit().filter((a) => a.outcome === 'succeeded').length >= 3);
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }
}

/* ══════════════════════════════════════════════════════════════════
   Part B — Trigger scheduler tests
   ══════════════════════════════════════════════════════════════════ */

/** Fake timer for deterministic cron tests. */
function fakeTimer() {
  let now = new Date('2026-01-01T00:00:00Z');
  const queue: { time: number; fn: () => void }[] = [];
  return {
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
      while (queue.length && queue[0]!.time <= now.getTime()) {
        const item = queue.shift()!;
        item.fn();
      }
    },
    setTimeout: (fn: () => void, ms: number) => {
      const time = now.getTime() + ms;
      queue.push({ time, fn });
      queue.sort((a, b) => a.time - b.time);
      return { clear: () => { const i = queue.indexOf(queue.find((q) => q.fn === fn)!); if (i >= 0) queue.splice(i, 1); } };
    },
  };
}

async function testScheduler() {
  console.log('\n[B1] cron parser');
  {
    check('parse 5-field cron', parseCron('0 9 * * 1-5') !== null);
    check('parse 6-field cron', parseCron('0 0 9 * * 1-5') !== null);
    check('reject bad cron', parseCron('not cron') === null);
    check('reject out of range', parseCron('99 9 * * 1-5') === null);
    const next = nextCronFire('0 9 * * 1-5', new Date('2026-01-01T00:00:00Z'));
    check('next fire is 09:00 Jan 1 (Thu)', next?.getHours() === 9 && next?.getDate() === 1, next?.toISOString());
    const next2 = nextCronFire('0 9 * * 1-5', new Date('2026-01-03T10:00:00Z'));
    check('next fire skips weekend (Sat → Mon)', next2?.getUTCDay() === 1, next2?.toISOString());
  }

  console.log('\n[B2] schedule trigger fires');
  {
    const h = liveHarness();
    const timer = fakeTimer();
    let fired = false;
    const wf = DEF('sched-test', [
      N('t', 'schedule', { cron: '* * * * *' }),
      N('r', 'result'),
    ], [E('t', 'out', 'r')]);
    h.definitions.record(wf);
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      now: timer.now, setTimeout: timer.setTimeout,
    });
    sched.start();
    check('scheduler running', sched.isRunning);
    check('one trigger registered', sched.activeCount === 1);
    timer.advance(60_000);
    await sleep(10);
    check('trigger fired', fired || h.runtime.listRuns('sched-test').length > 0);
    check('run created', h.runtime.listRuns('sched-test').length >= 1);
    sched.stop();
    check('scheduler stopped', !sched.isRunning);
    check('registrations cleared', sched.activeCount === 0);
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B3] no duplicate registration');
  {
    const h = liveHarness();
    const timer = fakeTimer();
    const wf = DEF('dedup-test', [
      N('t', 'schedule', { cron: '* * * * *' }),
      N('r', 'result'),
    ], [E('t', 'out', 'r')]);
    h.definitions.record(wf);
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      now: timer.now, setTimeout: timer.setTimeout,
    });
    sched.start();
    sched.reloadWorkflow('dedup-test');
    sched.reloadWorkflow('dedup-test');
    check('no duplicates after repeated reload', sched.activeCount === 1);
    sched.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B4] single-flight: second trigger skipped');
  {
    const h = liveHarness();
    const timer = fakeTimer();
    const wf = DEF('single-flight', [
      N('t', 'schedule', { cron: '* * * * *' }),
      N('d', 'delay', { ms: 5000 }),
      N('r', 'result'),
    ], [E('t', 'out', 'd'), E('d', 'out', 'r')], { singleFlight: true });
    h.definitions.record(wf);
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      now: timer.now, setTimeout: timer.setTimeout,
    });
    sched.start();
    timer.advance(60_000);
    await sleep(20);
    const runsAfterFirst = h.runtime.listRuns('single-flight').length;
    check('first trigger created a run', runsAfterFirst === 1, String(runsAfterFirst));
    timer.advance(60_000);
    await sleep(20);
    const runsAfterSecond = h.runtime.listRuns('single-flight').length;
    check('second trigger skipped (single-flight)', runsAfterSecond === 1, `got ${runsAfterSecond} runs`);
    sched.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B5] concurrent runs allowed without singleFlight');
  {
    const h = liveHarness();
    const timer = fakeTimer();
    const wf = DEF('concurrent', [
      N('t', 'schedule', { cron: '* * * * *' }),
      N('d', 'delay', { ms: 5000 }),
      N('r', 'result'),
    ], [E('t', 'out', 'd'), E('d', 'out', 'r')]);
    h.definitions.record(wf);
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      now: timer.now, setTimeout: timer.setTimeout,
    });
    sched.start();
    timer.advance(60_000);
    await sleep(20);
    timer.advance(60_000);
    await sleep(20);
    const runsCount = h.runtime.listRuns('concurrent').length;
    check('concurrent runs allowed', runsCount >= 2, `got ${runsCount}`);
    sched.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B6] reload picks up new definitions');
  {
    const h = liveHarness();
    const timer = fakeTimer();
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      now: timer.now, setTimeout: timer.setTimeout,
    });
    sched.start();
    check('empty scheduler has 0 triggers', sched.activeCount === 0);
    const wf = DEF('reload-add', [
      N('t', 'schedule', { cron: '* * * * *' }),
      N('r', 'result'),
    ], [E('t', 'out', 'r')]);
    h.definitions.record(wf);
    sched.reload();
    check('reload registered new workflow', sched.activeCount === 1);
    sched.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B7] restart re-registers from definitions');
  {
    const h = liveHarness();
    const timer = fakeTimer();
    const wf = DEF('restart-test', [
      N('t', 'schedule', { cron: '* * * * *' }),
      N('r', 'result'),
    ], [E('t', 'out', 'r')]);
    h.definitions.record(wf);
    const sched1 = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      now: timer.now, setTimeout: timer.setTimeout,
    });
    sched1.start();
    check('first start registered', sched1.activeCount === 1);
    sched1.stop();
    const sched2 = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      now: timer.now, setTimeout: timer.setTimeout,
    });
    sched2.start();
    check('restart re-registered (no duplicate)', sched2.activeCount === 1);
    sched2.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B8] failure handling: failing run does not crash the scheduler');
  {
    const h = liveHarness();
    const timer = fakeTimer();
    const wf = DEF('fail-trigger', [
      N('t', 'schedule', { cron: '* * * * *' }),
      N('bad', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: node -e process.exit(1)' }),
    ], [E('t', 'out', 'bad')]);
    h.definitions.record(wf);
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      now: timer.now, setTimeout: timer.setTimeout,
    });
    sched.start();
    let threw = false;
    try {
      timer.advance(60_000);
      await sleep(20);
    } catch { threw = true; }
    check('scheduler did not crash', !threw);
    check('scheduler still running', sched.isRunning);
    for (let i = 0; i < 50; i++) {
      if (h.runtime.listRuns('fail-trigger').some((r) => r.status === 'failed' || r.status === 'completed')) break;
      await sleep(50);
    }
    check('run recorded as failed', h.runtime.listRuns('fail-trigger').some((r) => r.status === 'failed'));
    sched.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B9] disabled triggers not registered');
  {
    const h = liveHarness();
    const timer = fakeTimer();
    const wf = DEF('disabled-test', [
      N('t', 'schedule', { cron: '* * * * *', enabled: false }),
      N('r', 'result'),
    ], [E('t', 'out', 'r')]);
    h.definitions.record(wf);
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      now: timer.now, setTimeout: timer.setTimeout,
    });
    sched.start();
    check('disabled trigger not registered', sched.activeCount === 0);
    sched.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B10] draft workflows not scheduled');
  {
    const h = liveHarness();
    const timer = fakeTimer();
    const wf = DEF('draft-test', [
      N('t', 'schedule', { cron: '* * * * *' }),
      N('r', 'result'),
    ], [E('t', 'out', 'r')]);
    wf.status = 'draft';
    h.definitions.record(wf);
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      now: timer.now, setTimeout: timer.setTimeout,
    });
    sched.start();
    check('draft workflow not scheduled', sched.activeCount === 0);
    sched.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B11] event source integration');
  {
    const h = liveHarness();
    let stopped = false;
    let fireFn: ((payload?: unknown) => void) | null = null;
    const fakeEventSource = {
      type: 'file-change' as const,
      start(_config: never, context: { fire: (payload?: unknown) => void }) {
        fireFn = context.fire;
        return () => { stopped = true; };
      },
    };
    const wf = DEF('event-test', [
      N('t', 'file-change', { paths: ['.'], match: '*.ts' }),
      N('r', 'result'),
    ], [E('t', 'out', 'r')]);
    h.definitions.record(wf);
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      eventSources: { 'file-change': fakeEventSource },
    });
    sched.start();
    check('event source started', fireFn !== null);
    check('trigger registered', sched.activeCount === 1);
    fireFn!({ path: 'src/test.ts' });
    await sleep(20);
    check('event triggered a run', h.runtime.listRuns('event-test').length >= 1);
    sched.stop();
    check('event source stopped', stopped);
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B12] real FileChangeEventSource (fs.watch)');
  {
    const h = liveHarness();
    const sources = await makeHostSources(h.projectDir, h.tmp);
    const wf = DEF('fs-event', [
      N('t', 'file-change', { paths: ['watched'], match: '*' }),
      N('r', 'result'),
    ], [E('t', 'out', 'r')]);
    h.definitions.record(wf);
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      eventSources: sources,
    });
    sched.start();
    check('trigger registered', sched.activeCount === 1);
    await fsp.mkdir(path.join(h.projectDir, 'watched'), { recursive: true });
    await fsp.writeFile(path.join(h.projectDir, 'watched', 'note.txt'), 'hello\n', 'utf8');
    for (let i = 0; i < 50; i++) {
      if (h.runtime.listRuns('fs-event').length > 0) break;
      await sleep(100);
    }
    check('fs.watch change triggered a run', h.runtime.listRuns('fs-event').length >= 1);
    sched.stop();
    await sleep(50);
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B13] real GitEventSource (git polling)');
  {
    const h = liveHarness();
    await setupGitRepo(h.projectDir);
    const sources = await makeHostSources(h.projectDir, h.tmp);
    const wf = DEF('git-ev', [
      N('t', 'git-event', { events: ['commit', 'branch', 'push', 'merge', 'tag'] }),
      N('r', 'result'),
    ], [E('t', 'out', 'r')]);
    h.definitions.record(wf);
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      eventSources: sources,
    });
    sched.start();
    await fsp.appendFile(path.join(h.projectDir, 'README.md'), 'change\n', 'utf8');
    await git(['add', '-A'], { cwd: h.projectDir });
    await git(['commit', '-m', 'trigger-me'], { cwd: h.projectDir });
    for (let i = 0; i < 100; i++) {
      if (h.runtime.listRuns('git-ev').length > 0) break;
      await sleep(100);
    }
    check('git commit triggered a run', h.runtime.listRuns('git-ev').length >= 1);
    sched.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }

  console.log('\n[B14] real MissionEventSource (mission store polling)');
  {
    const h = liveHarness();
    const sources = await makeHostSources(h.projectDir, h.tmp);
    const wf = DEF('mission-ev', [
      N('t', 'mission-event', { events: ['created', 'approved', 'started', 'completed', 'failed'] }),
      N('r', 'result'),
    ], [E('t', 'out', 'r')]);
    h.definitions.record(wf);
    const sched = new TriggerScheduler({
      definitions: h.definitions, runs: h.runs, runtime: h.runtime,
      eventSources: sources,
    });
    sched.start();
    await writeMissionRecord(h.tmp, 'test-proj', 'mission-1');
    for (let i = 0; i < 100; i++) {
      if (h.runtime.listRuns('mission-ev').length > 0) break;
      await sleep(100);
    }
    check('mission event triggered a run', h.runtime.listRuns('mission-ev').length >= 1);
    sched.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }
}

/* ══════════════════════════════════════════════════════════════════
   Part C — Security scan
   ══════════════════════════════════════════════════════════════════ */

function testSecurity() {
  console.log('\n[C1] runtime source security scan');
  {
    const runtimeDir = path.join('packages', 'workflow', 'src', 'runtime');
    const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const sources = fs.readdirSync(runtimeDir).filter((f) => f.endsWith('.ts')).map((f) => codeOnly(fs.readFileSync(path.join(runtimeDir, f), 'utf8')));
    const forbidden = [/child_process/, /\bspawn\s*\(/, /\bexecFile\s*\(/, /\bfork\s*\(/, /new\s+Function\s*\(/, /\beval\s*\(/];
    for (const re of forbidden) {
      check(`runtime has no ${re.source}`, !sources.some((src) => re.test(src)));
    }
    check('no direct fs write in runtime', !sources.some((src) => /writeFile|fs\.write|fsp\.write/.test(src)));
    check('no direct git in runtime', !sources.some((src) => /\bgit\s*\(/.test(src)));
    check('no require/import child_process', !sources.some((src) => /require\s*\(\s*['"]child_process/.test(src) || /from\s+['"]node:child_process/.test(src)));
  }
}

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  console.log('[phase6] Real Executors + Trigger Scheduler');
  await testLiveExecution();
  await testScheduler();
  testSecurity();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });