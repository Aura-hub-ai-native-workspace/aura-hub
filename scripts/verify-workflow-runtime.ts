/**
 * Verification harness for the Workflow Runtime + Governance (Phase 5).
 *
 *   node scripts/run-ts.mjs scripts/verify-workflow-runtime.ts
 *
 * Exercises the runtime against a REAL Capability Fabric (real policy,
 * approval and audit machinery) with fakes ONLY at the side-effect
 * boundary (host permission resolution, executors, AI seam, approval
 * UI). Covers: the 18 required scenarios — manual run, multi-node,
 * input/output mapping, condition branch, failed node, skipped
 * downstream, retry, timeout, cancellation, approval pause, approval
 * resume, approval rejection, persistence, restart/resume, manifest
 * validation, governance path, audit events, no shell bypass — plus
 * secret redaction. Deterministic and self-contained: temp AURA_HOME,
 * cleaned up at the end.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WorkflowRuntime,
  WorkflowDefinitionStore,
  WorkflowRunStore,
  hasErrors,
  validateDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@aura/workflow';
import { CapabilityFabric, type ApprovalPersistence, type InvocationContext, type InvocationResult } from '@aura/capability-fabric';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); }
  else { failed += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const N = (id: string, type: WorkflowNode['type'], config: Record<string, unknown> = {}, governance: WorkflowNode['governance'] = undefined): WorkflowNode => ({
  id, type, x: 0, y: 0, config, ...(governance ? { governance } : {}),
});
const E = (from: string, fromPort: string, to: string, toPort = 'in'): WorkflowDefinition['edges'][number] => ({ id: `e-${from}-${to}`, from, fromPort, to, toPort });
const DEF = (id: string, nodes: WorkflowNode[], edges: WorkflowDefinition['edges'][number][]): WorkflowDefinition => ({
  schemaVersion: 1, id, name: id, description: '', projectId: 'proj-1', status: 'ready', version: 1,
  nodes, edges, settings: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function awaitStatus(get: () => string | undefined, want: string[], timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = get();
    if (s && want.includes(s)) return true;
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
}

/* ── fake side-effect boundary ─────────────────────────────────────── */

class SpyFabric extends CapabilityFabric {
  invocations = 0;
  lastInput: Record<string, unknown> | null = null;
  override async invoke(capabilityId: string, input: Record<string, unknown>, context: InvocationContext): Promise<InvocationResult> {
    this.invocations += 1;
    this.lastInput = input;
    return super.invoke(capabilityId, input, context);
  }
}

/** Shared approval persistence — survives a "process restart". */
function sharedApprovalPersistence(): { store: ApprovalPersistence; array: import('@aura/capability-fabric').ApprovalRequest[] } {
  const array: import('@aura/capability-fabric').ApprovalRequest[] = [];
  return { store: { load: () => array, save: (requests) => { array.length = 0; array.push(...requests); } }, array };
}

interface FabricRig {
  fabric: SpyFabric;
  requested: { summary: string }[];
  execResults: Record<string, () => Promise<{ ok: boolean; detail: string; output?: unknown }>>;
  aiOutput: Record<string, unknown>;
  approvalPersistence: ReturnType<typeof sharedApprovalPersistence>;
}

function makeFabric(approvalPersistence?: ReturnType<typeof sharedApprovalPersistence>): FabricRig {
  const execResults: FabricRig['execResults'] = {};
  const requested: FabricRig['requested'] = [];
  const aiOutput: FabricRig['aiOutput'] = {};
  const fabric = new SpyFabric({
    permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: false }),
    nodeAvailable: () => true,
    resolveNode: () => ({ ok: true, node: { id: 'node-a', name: 'Node A', capabilities: [] } }),
    requestApproval: async (request) => {
      requested.push({ summary: request.summary });
      return false;
    },
  });
  for (const capabilityId of ['git.status', 'git.commit', 'git.push', 'terminal.execute', 'http.request', 'filesystem.write', 'mission.create', 'mission.start', 'mission.approve', 'agent.delegate']) {
    const run = async () => {
      const r = execResults[capabilityId];
      if (!r) return { ok: false, detail: `executor for ${capabilityId} not registered in this test` };
      return r();
    };
    fabric.register({ capabilityId, run, supportsNode: () => true });
  }
  if (approvalPersistence) fabric.attachApprovalStore(approvalPersistence.store);
  return {
    fabric, requested, execResults, aiOutput,
    approvalPersistence: approvalPersistence ?? sharedApprovalPersistence(),
  };
}

const ok = (output?: unknown, detail = 'ok') => ({ ok: true, detail, output });

interface Harness {
  rig: FabricRig;
  definitions: WorkflowDefinitionStore;
  runs: WorkflowRunStore;
  runtime: WorkflowRuntime;
}

function harness(baseDir: string, approvalPersistence?: ReturnType<typeof sharedApprovalPersistence>): Harness {
  const rig = makeFabric(approvalPersistence);
  const ai: import('@aura/workflow').RuntimeHost['ai'] = {
    generate: async (req) => {
      const canned = rig.aiOutput[req.nodeType];
      if (canned === undefined) return { ok: false, error: `no canned output for ${req.nodeType}` };
      return { ok: true, output: canned };
    },
  };
  const missions: import('@aura/workflow').RuntimeHost['missions'] = {
    update: async (_missionId, note) => ({ ok: true, state: 'active', missionId: _missionId, updated: true, note: note.note ?? '' }),
    wait: async (_missionId, until) => ({ ok: true, state: until }),
  };
  const definitions = new WorkflowDefinitionStore({ baseDir });
  const runs = new WorkflowRunStore({ baseDir });
  const runtimeHost: import('@aura/workflow').RuntimeHost = {
    fabric: rig.fabric as unknown as import('@aura/capability-fabric').CapabilityFabric,
    ai,
    missions,
    projectPath: () => path.join(baseDir, 'projects', 'proj-1'),
    askApproval: async () => false,
    sleep,
  };
  const runtime = new WorkflowRuntime(runtimeHost, { definitions, runs });
  return { rig, definitions, runs, runtime };
}

function recordDef(definitions: WorkflowDefinitionStore, wf: WorkflowDefinition): void {
  definitions.record(wf);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-runtime-verify-'));
  process.env.AURA_HOME = tmp;
  console.log(`[verify] AURA_HOME=${tmp}`);

  /* ── 1. manual workflow execution ─────────────────────────────── */
  console.log('\n[1] manual workflow execution');
  {
    const h = harness(tmp);
    const wf = DEF('wf-manual', [N('t', 'manual'), N('ai', 'ask-aura', { prompt: 'Summarize' }), N('r', 'result')], [E('t', 'out', 'ai'), E('ai', 'out', 'r')]);
    recordDef(h.definitions, wf);
    h.rig.aiOutput['ask-aura'] = { answer: 'summary' };
    const run = await h.runtime.startRun('wf-manual', { inputs: { text: 'hello' } });
    check('run completed', run.status === 'completed', JSON.stringify(run.status));
    check('trigger node fired', run.nodeRuns.find((n) => n.nodeId === 't')?.status === 'success');
    check('ai node ran', run.nodeRuns.find((n) => n.nodeId === 'ai')?.status === 'success');
    check('result recorded', !!run.outputs['r'] && (run.outputs['r'] as { answer: string }).answer === 'summary', JSON.stringify(run.outputs));
  }

  /* ── 2. multi-node execution ──────────────────────────────────── */
  console.log('\n[2] multi-node execution');
  {
    const h = harness(tmp);
    const wf = DEF('wf-chain', [
      N('t', 'manual'), N('s', 'summarize'), N('g', 'generate', { instruction: 'Use {{nodes.s.out}}' }), N('r', 'result'),
    ], [E('t', 'out', 's'), E('s', 'out', 'g'), E('g', 'out', 'r')]);
    recordDef(h.definitions, wf);
    h.rig.aiOutput['summarize'] = 'SUM';
    h.rig.aiOutput['generate'] = 'GEN';
    const run = await h.runtime.startRun('wf-chain', { inputs: {} });
    check('chain completed', run.status === 'completed');
    check('all four nodes success', run.nodeRuns.every((n) => n.status === 'success'), JSON.stringify(run.nodeRuns.map((n) => [n.nodeId, n.status])));
    const gen = run.nodeRuns.find((n) => n.nodeId === 'g')!;
    check('generation got previous node output', (gen.inputs as { prompt: string }).prompt.includes('SUM'), JSON.stringify(gen.inputs));
  }

  /* ── 3. input/output mapping ──────────────────────────────────── */
  console.log('\n[3] input/output mapping');
  {
    const h = harness(tmp);
    h.rig.execResults['git.status'] = async () => ok({ status: 'clean' });
    const wf = DEF('wf-map', [
      N('t', 'manual'), N('c', 'capability', {
        capabilityId: 'git.status',
        inputMap: 'branch: {{input.text}}',
      }), N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-map', { inputs: { text: 'main' } });
    check('mapped run completed', run.status === 'completed');
    check('capability received mapped input', h.rig.fabric.lastInput?.branch === 'main', JSON.stringify(h.rig.fabric.lastInput));
    check('capability input recorded', (run.nodeRuns.find((n) => n.nodeId === 'c')!.inputs as { branch: string }).branch === 'main');
  }

  /* ── 4. condition branch ─────────────────────────────────────── */
  console.log('\n[4] condition branch');
  {
    const h = harness(tmp);
    const wf = DEF('wf-cond', [
      N('t', 'manual'),
      N('cond', 'condition', { op: 'equals', field: '{{input.text}}', value: '"go"' }),
      N('a', 'result'), N('b', 'result'),
    ], [E('t', 'out', 'cond'), E('cond', 'true', 'a'), E('cond', 'false', 'b')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-cond', { inputs: { text: 'go' } });
    check('branch run completed', run.status === 'completed');
    check('true branch ran', run.nodeRuns.find((n) => n.nodeId === 'a')?.status === 'success');
    check('false branch skipped', run.nodeRuns.find((n) => n.nodeId === 'b')?.status === 'skipped');
  }

  const AUTO_HTTP: import('@aura/capability-fabric').PolicyConfig = {
  byRisk: { low: 'auto-execute', medium: 'auto-execute', high: 'auto-execute' },
  overrides: {}, allowAutonomous: true,
};

  /* ── 5. failed node ───────────────────────────────────────────── */
  console.log('\n[5] failed node');
  {
    const h = harness(tmp);
    h.rig.execResults['http.request'] = async () => ({ ok: false, detail: 'connection refused' });
    h.rig.fabric.setPolicy(AUTO_HTTP);
    const wf = DEF('wf-fail', [
      N('t', 'manual'), N('c', 'capability', { capabilityId: 'http.request', inputMap: 'url: http://x' }),
    ], [E('t', 'out', 'c')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-fail', { inputs: {} });
    check('run failed', run.status === 'failed');
    check('error recorded', (run.error ?? '').includes('connection refused'), run.error ?? '');
    check('capability node failed', run.nodeRuns.find((n) => n.nodeId === 'c')?.status === 'failed');
  }

  /* ── 6. skipped downstream ────────────────────────────────────── */
  console.log('\n[6] skipped downstream');
  {
    const h = harness(tmp);
    h.rig.execResults['http.request'] = async () => ({ ok: false, detail: 'boom' });
    h.rig.fabric.setPolicy(AUTO_HTTP);
    const wf = DEF('wf-skip', [
      N('t', 'manual'), N('c', 'capability', { capabilityId: 'http.request', inputMap: 'url: http://x' }), N('d', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'd')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-skip', { inputs: {} });
    check('run failed', run.status === 'failed');
    check('downstream skipped, never executed', run.nodeRuns.find((n) => n.nodeId === 'd')?.status === 'skipped');
    check('downstream produced no output', run.outputs['d'] === undefined);
  }

  /* ── 7. retry ─────────────────────────────────────────────────── */
  console.log('\n[7] retry');
  {
    const h = harness(tmp);
    let calls = 0;
    h.rig.execResults['http.request'] = async () => { calls += 1; return calls < 3 ? { ok: false, detail: `fail ${calls}` } : ok({ status: 200 }); };
    h.rig.fabric.setPolicy(AUTO_HTTP);
    const wf = DEF('wf-retry', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'http.request', inputMap: 'url: http://x', retry: { maxAttempts: 4, delayMs: 1, backoffFactor: 1 } }),
    ], [E('t', 'out', 'c')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-retry', { inputs: {} });
    check('retried run completed', run.status === 'completed');
    check('executor called 3 times', calls === 3, String(calls));
    check('attempts recorded', run.nodeRuns.find((n) => n.nodeId === 'c')!.attempts === 3);
    const wf2 = DEF('wf-retry-node', [
      N('t', 'manual'),
      N('rc', 'retry', { maxAttempts: 3, delayMs: 1, backoffFactor: 1 }),
      N('c', 'capability', { capabilityId: 'http.request', inputMap: 'url: http://x' }),
      N('r', 'result'),
    ], [E('t', 'out', 'rc'), E('rc', 'out', 'c'), E('c', 'out', 'r')]);
    recordDef(h.definitions, wf2);
    calls = 0;
    const run2 = await h.runtime.startRun('wf-retry-node', { inputs: {} });
    check('retry control node completed', run2.status === 'completed', JSON.stringify(run2.status));
    check('retry control node retried', calls >= 2, String(calls));
  }

  /* ── 8. timeout ───────────────────────────────────────────────── */
  console.log('\n[8] timeout');
  {
    const h = harness(tmp);
    h.rig.execResults['http.request'] = async () => { await sleep(150); return ok({ status: 200 }); };
    h.rig.fabric.setPolicy(AUTO_HTTP);
    const wf = DEF('wf-timeout', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'http.request', inputMap: 'url: http://x', timeoutMs: 10 }),
    ], [E('t', 'out', 'c')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-timeout', { inputs: {} });
    check('timeout run failed', run.status === 'failed');
    check('timeout error recorded', (run.error ?? '').includes('timed out'), run.error ?? '');
  }

  /* ── 9. cancellation ──────────────────────────────────────────── */
  console.log('\n[9] cancellation');
  {
    const h = harness(tmp);
    const wf = DEF('wf-cancel', [
      N('t', 'manual'), N('d', 'delay', { ms: 10000 }), N('r', 'result'),
    ], [E('t', 'out', 'd'), E('d', 'out', 'r')]);
    recordDef(h.definitions, wf);
    const start = h.runtime.startRun('wf-cancel', { inputs: {} });
    await sleep(30);
    const run = await h.runtime.cancelRun((await h.runtime.listRuns())[0]!.runId);
    check('run cancelled', run?.status === 'cancelled', JSON.stringify(run?.status));
    await start;
  }

  /* ── 10. approval-required pause ──────────────────────────────── */
  console.log('\n[10] approval-required pause');
  {
    const h = harness(tmp);
    h.rig.execResults['git.commit'] = async () => ok({ commit: 'abc123' });
    const wf = DEF('wf-approve', [
      N('t', 'manual'), N('c', 'capability', { capabilityId: 'git.commit', inputMap: 'message: fix' }), N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-approve', { inputs: {} });
    check('run paused', run.status === 'paused', JSON.stringify(run.status));
    const c = run.nodeRuns.find((n) => n.nodeId === 'c')!;
    check('capability node approval-required', c.status === 'approval-required', c.status);
    check('request id recorded', !!c.approval?.requestId, JSON.stringify(c.approval));
    check('fabric holds one pending approval', h.rig.fabric.pendingApprovals().length === 1);
    check('downstream not run', run.nodeRuns.find((n) => n.nodeId === 'r')?.status === 'waiting');
  }

  /* ── 11. approval resume ──────────────────────────────────────── */
  console.log('\n[11] approval resume');
  {
    const h = harness(tmp);
    h.rig.execResults['git.commit'] = async () => ok({ commit: 'abc123' });
    const wf = DEF('wf-approve2', [
      N('t', 'manual'), N('c', 'capability', { capabilityId: 'git.commit', inputMap: 'message: fix' }), N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-approve2', { inputs: {} });
    const requestId = h.rig.fabric.pendingApprovals()[0]!.id;
    const decided = h.runtime.decideApproval(requestId, true, 'alice', 'looks fine');
    check('decision recorded by fabric', decided !== null && decided.state === 'granted');
    const settled = await awaitStatus(() => h.runtime.getRun(run.runId)?.status, ['completed', 'failed']);
    check('run completed after grant', settled && h.runtime.getRun(run.runId)!.status === 'completed');
    const c = h.runtime.getRun(run.runId)!.nodeRuns.find((n) => n.nodeId === 'c')!;
    check('capability executed', c.status === 'success');
    check('approval state granted on record', c.approval?.state === 'granted', JSON.stringify(c.approval));
    check('grant consumed (single-use)', h.rig.fabric.pendingApprovals().length === 0);
  }

  /* ── 12. approval rejection ───────────────────────────────────── */
  console.log('\n[12] approval rejection');
  {
    const h = harness(tmp);
    h.rig.execResults['git.commit'] = async () => ok({ commit: 'abc123' });
    const wf = DEF('wf-approve3', [
      N('t', 'manual'), N('c', 'capability', { capabilityId: 'git.commit', inputMap: 'message: fix' }), N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-approve3', { inputs: {} });
    const requestId = h.rig.fabric.pendingApprovals()[0]!.id;
    h.runtime.decideApproval(requestId, false, 'alice', 'not now');
    const settled = await awaitStatus(() => h.runtime.getRun(run.runId)?.status, ['completed', 'failed']);
    check('run failed after denial', settled && h.runtime.getRun(run.runId)!.status === 'failed');
    const c = h.runtime.getRun(run.runId)!.nodeRuns.find((n) => n.nodeId === 'c')!;
    check('capability node failed', c.status === 'failed', c.status);
    check('denial recorded', c.approval?.state === 'denied', JSON.stringify(c.approval));
    check('downstream skipped after denial', h.runtime.getRun(run.runId)!.nodeRuns.find((n) => n.nodeId === 'r')?.status === 'skipped');
  }

  /* ── 13. persistence ──────────────────────────────────────────── */
  console.log('\n[13] persistence');
  {
    const h = harness(tmp);
    const wf = DEF('wf-persist', [N('t', 'manual'), N('r', 'result')], [E('t', 'out', 'r')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-persist', { inputs: { text: 'x' } });
    const fromStore = h.runs.get('wf-persist', run.runId);
    check('run persisted', !!fromStore && fromStore.status === 'completed');
    check('node runs persisted', fromStore?.nodeRuns.length === 2);
    check('outputs persisted', (fromStore?.outputs['r'] as { text: string }).text === 'x');
    check('summary lists run', h.runs.list('wf-persist')[0]?.runId === run.runId);
  }

  /* ── 14. restart/resume ───────────────────────────────────────── */
  console.log('\n[14] restart/resume');
  {
    const persistence = sharedApprovalPersistence();
    const h1 = harness(tmp, persistence);
    h1.rig.execResults['git.commit'] = async () => ok({ commit: 'abc123' });
    const wf = DEF('wf-restart', [
      N('t', 'manual'), N('c', 'capability', { capabilityId: 'git.commit', inputMap: 'message: fix' }), N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    recordDef(h1.definitions, wf);
    const run = await h1.runtime.startRun('wf-restart', { inputs: {} });
    check('run parked before restart', run.status === 'paused');
    const requestId = h1.rig.fabric.pendingApprovals()[0]!.id;
    check('request persisted for restart', persistence.array.length === 1);

    // "restart": a brand-new fabric + runtime over the same stores.
    const h2 = harness(tmp, persistence);
    h2.rig.execResults['git.commit'] = async () => ok({ commit: 'abc123' });
    const resumed = await h2.runtime.resumeRun(run.runId);
    check('restart resumes to paused', resumed?.status === 'paused', JSON.stringify(resumed?.status));
    check('approval-required node preserved', resumed?.nodeRuns.find((n) => n.nodeId === 'c')?.status === 'approval-required');
    const granted = h2.runtime.decideApproval(requestId, true, 'alice');
    check('grant accepted by restarted fabric', granted !== null);
    const settled = await awaitStatus(() => h2.runtime.getRun(run.runId)?.status, ['completed', 'failed']);
    check('restarted run completed after grant', settled && h2.runtime.getRun(run.runId)!.status === 'completed');
    const c = h2.runtime.getRun(run.runId)!.nodeRuns.find((n) => n.nodeId === 'c')!;
    check('capability executed after restart', c.status === 'success');
    check('invocation correlated to same run/node', c.auditIds.length >= 1);
  }

  /* ── 15. capability manifest validation ───────────────────────── */
  console.log('\n[15] capability manifest validation');
  {
    const h = harness(tmp);
    const wf = DEF('wf-unknown-cap', [N('t', 'manual'), N('c', 'capability', { capabilityId: 'no.such.capability' })], [E('t', 'out', 'c')]);
    const issues = validateDefinition(wf, { knownCapabilities: h.definitions.knownCapabilities });
    check('validation flags unknown capability', hasErrors(issues), JSON.stringify(issues));
    let threw = false;
    try { recordDef(h.definitions, wf); await h.runtime.startRun('wf-unknown-cap', { inputs: {} }); } catch { threw = true; }
    check('startRun refuses invalid definition', threw);
  }

  /* ── 16. governance path ──────────────────────────────────────── */
  console.log('\n[16] governance path');
  {
    const h = harness(tmp);
    h.rig.execResults['git.status'] = async () => ok({ status: 'clean' });
    h.rig.execResults['http.request'] = async () => ok({ status: 200 });
    h.rig.execResults['terminal.execute'] = async () => ok({ exitCode: 0, stdout: 'done' });
    // Three independent branches from the trigger, each exercising a
    // different policy decision: auto-execute (low), ask-user (medium),
    // deny (override).
    const wf = DEF('wf-gov', [
      N('t', 'manual'),
      N('auto', 'capability', { capabilityId: 'git.status' }),
      N('ask', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: ls' }),
      N('deny', 'capability', { capabilityId: 'http.request', inputMap: 'url: http://x' }),
    ], [
      E('t', 'out', 'auto'), E('t', 'out', 'ask'), E('t', 'out', 'deny'),
    ]);
    recordDef(h.definitions, wf);
    h.rig.fabric.setPolicy({ byRisk: { low: 'auto-execute', medium: 'ask-user', high: 'require-approval' }, overrides: { 'http.request': 'deny' }, allowAutonomous: true });
    const run = await h.runtime.startRun('wf-gov', { inputs: {} });
    check('low risk auto-executed', run.nodeRuns.find((n) => n.nodeId === 'auto')?.status === 'success');
    check('auto node policy recorded', run.nodeRuns.find((n) => n.nodeId === 'auto')!.policy?.decision === 'auto-execute', JSON.stringify(run.nodeRuns.find((n) => n.nodeId === 'auto')!.policy));
    check('medium risk asked', run.nodeRuns.find((n) => n.nodeId === 'ask')?.status === 'approval-required');
    check('denied capability failed', run.nodeRuns.find((n) => n.nodeId === 'deny')?.status === 'failed');
    check('deny recorded in policy', run.nodeRuns.find((n) => n.nodeId === 'deny')!.policy?.decision === 'deny');
    check('run failed (deny branch), ask is moot', run.status === 'failed', JSON.stringify(run.status));
  }

  /* ── 17. audit events ─────────────────────────────────────────── */
  console.log('\n[17] audit events');
  {
    const h = harness(tmp);
    h.rig.execResults['git.status'] = async () => ok({ status: 'clean' });
    const wf = DEF('wf-audit', [N('t', 'manual'), N('c', 'capability', { capabilityId: 'git.status' })], [E('t', 'out', 'c')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-audit', { inputs: {} });
    const c = run.nodeRuns.find((n) => n.nodeId === 'c')!;
    const audit = h.rig.fabric.audit();
    const nodeRecord = audit.find((a) => a.invocationId === c.auditIds[0]);
    check('node linked to an audit record', !!nodeRecord);
    check('audit correlation ids set', nodeRecord?.missionId === `workflow:${run.runId}` && nodeRecord?.taskId === 'c', JSON.stringify({ m: nodeRecord?.missionId, t: nodeRecord?.taskId }));
    check('audit records auto-execute decision', nodeRecord?.decision === 'auto-execute');
    check('audit records outcome', nodeRecord?.outcome === 'succeeded');
    check('actor is the workflow agent', nodeRecord?.actor.id === `workflow:${run.runId}`);
  }

  /* ── 18. no shell bypass ──────────────────────────────────────── */
  console.log('\n[18] no shell bypass');
  {
    const runtimeDir = path.join('packages', 'workflow', 'src', 'runtime');
    const sources = fs.readdirSync(runtimeDir).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(runtimeDir, f), 'utf8'));
    // RegExp.exec() is safe — only flag process-spawning primitives.
    const forbidden = [/child_process/, /\bspawn\s*\(/, /\bexecFile\s*\(/, /\bfork\s*\(/, /new\s+Function\s*\(/, /\beval\s*\(/];
    for (const re of forbidden) {
      check(`runtime has no ${re.source}`, !sources.some((s) => re.test(s)));
    }
    const h = harness(tmp);
    h.rig.execResults['terminal.execute'] = async () => ok({ exitCode: 0, stdout: 'ran' });
    h.rig.fabric.setPolicy(AUTO_HTTP);
    const wf = DEF('wf-shell', [N('t', 'manual'), N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: whoami' })], [E('t', 'out', 'c')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-shell', { inputs: {} });
    check('terminal capability executed through fabric', run.nodeRuns.find((n) => n.nodeId === 'c')?.status === 'success');
    check('fabric invoke counted', h.rig.fabric.invocations === 1, String(h.rig.fabric.invocations));
    const nodeAudit = h.rig.fabric.audit().find((a) => a.invocationId === run.nodeRuns.find((n) => n.nodeId === 'c')!.auditIds[0]);
    check('shell invocation audited', !!nodeAudit && nodeAudit.capabilityId === 'terminal.execute');
  }

  /* ── 19. secret redaction ─────────────────────────────────────── */
  console.log('\n[19] secret redaction');
  {
    const h = harness(tmp);
    const wf = DEF('wf-secret', [N('t', 'manual'), N('r', 'result')], [E('t', 'out', 'r')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-secret', { inputs: { apiKey: 'sk-very-secret', token: 'tok-1', note: 'public' } });
    check('run inputs redacted', (run.inputs as { apiKey: string }).apiKey === '<redacted>', JSON.stringify(run.inputs));
    check('non-secret key untouched', (run.inputs as { note: string }).note === 'public');
    const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'workflow-runs', 'wf-secret', `${run.runId}.json`), 'utf8'));
    check('persisted JSON has no secret value', !JSON.stringify(persisted).includes('sk-very-secret') && !JSON.stringify(persisted).includes('tok-1'));
  }

  /* ── 20. human gate (approval node) ───────────────────────────── */
  console.log('\n[20] approval node gate');
  {
    const h = harness(tmp);
    const wf = DEF('wf-gate', [
      N('t', 'manual'), N('g', 'approval', { summary: 'Deploy to prod?' }),
      N('yes', 'result'), N('no', 'result'),
    ], [E('t', 'out', 'g'), E('g', 'approved', 'yes'), E('g', 'rejected', 'no')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('wf-gate', { inputs: {} });
    check('gate parks the run', run.status === 'paused');
    const resumed = await h.runtime.resumeRunDecision(run.runId, 'g', true, 'alice');
    check('approved branch ran', resumed?.status === 'completed' && resumed.nodeRuns.find((n) => n.nodeId === 'yes')?.status === 'success');
    check('rejected branch skipped', resumed?.nodeRuns.find((n) => n.nodeId === 'no')?.status === 'skipped');
    const gate = resumed!.nodeRuns.find((n) => n.nodeId === 'g')!;
    check('gate decision recorded', gate.approval?.state === 'granted' && gate.approval?.decidedBy === 'alice', JSON.stringify(gate.approval));
  }

  /* ── cleanup ──────────────────────────────────────────────────── */
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });