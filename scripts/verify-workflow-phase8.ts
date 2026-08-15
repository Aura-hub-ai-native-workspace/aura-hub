/**
 * Verification harness for Phase 8 — Production Hardening + Operational
 * Reliability.
 *
 *   node scripts/run-ts.mjs scripts/verify-workflow-phase8.ts
 *
 * Coverage (A–J):
 *   A — crash/restart recovery: recoverInterruptedRuns settles stale
 *       running/queued runs, preserves approval-gate runs as paused, and
 *       terminal runs never re-execute
 *   B — approval durability: approve/deny after a simulated restart,
 *       duplicate decision, stale decision, unknown run/node
 *   C — duplicate-trigger protection: webhook singleFlight, scheduler
 *       singleFlight, concurrent runs without it
 *   D — concurrency semantics: singleFlight blocking across restart
 *   E — graceful shutdown: idempotent shutdown, no new runs, scheduler
 *       cannot be resurrected
 *   F — scheduler hardening: start/stop/reload idempotency, a failing
 *       workflow never kills the scheduler, deleted definitions are
 *       fire-proof
 *   G — persistence corruption: malformed/wrong-schema/missing-field
 *       records are skipped, never crash list(), never overwritten,
 *       never interpreted as empty/new
 *   H — run state machine: terminal runs cannot be re-entered; approval
 *       gates cannot be bypassed
 *   I — failure injection: executor failure, transient+retry, permanent
 *       failure, timeout, approval denial, cancellation, missing
 *       capability, malformed workflow, restart-during-pause
 *   J — security scan: the runtime execution layer has no shell/process
 *       bypass (no child_process/spawn/execFile/fork/eval/new Function)
 *
 * Everything runs in an isolated AURA_HOME temp dir. Failures print
 * FAIL; a non-zero exit is only produced for genuine test failures.
 * Results are reported honestly — environment-dependent checks (E1/F2)
 * are marked NOT VERIFIED rather than passed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WorkflowRuntime,
  WorkflowDefinitionStore,
  WorkflowRunStore,
  TriggerScheduler,
  hasErrors,
  validateDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRun,
} from '@aura/workflow';
import { CapabilityFabric, type ApprovalPersistence, type InvocationContext, type InvocationResult } from '@aura/capability-fabric';
import { WorkspaceManager } from '@aura/ai-service/workspace';
import { WorkflowBridge } from '@aura/ai-service/workflowBridge';
import { createApprovalStore } from '@aura/ai-service/fabric/approvalStore';

let passed = 0;
let failed = 0;
let notVerified = 0;

function check(name: string, cond: boolean, detail = ''): boolean {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); return true; }
  failed += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); return false;
}

function unverified(name: string, detail = ''): void {
  notVerified += 1;
  console.log(`  ??  ${name} NOT VERIFIED${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(fn: () => boolean | Promise<boolean>, ms = 15_000, step = 120): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

const AUTO_POLICY = {
  byRisk: { low: 'auto-execute' as const, medium: 'auto-execute' as const, high: 'auto-execute' as const },
  overrides: {},
  allowAutonomous: true,
};

const REQUIRE_POLICY = {
  byRisk: { low: 'require-approval' as const, medium: 'require-approval' as const, high: 'require-approval' as const },
  overrides: {},
  allowAutonomous: true,
};

let seq = 0;
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aura-phase8-${++seq}-`));
  process.env.AURA_HOME = dir;
  return dir;
}

const N = (id: string, type: WorkflowNode['type'], config: Record<string, unknown> = {}, governance?: WorkflowNode['governance']): WorkflowNode => ({
  id, type, x: 0, y: 0, config, ...(governance ? { governance } : {}),
});
const E = (from: string, fromPort: string, to: string, toPort = 'in'): WorkflowDefinition['edges'][number] => ({ id: `e-${from}-${to}`, from, fromPort, to, toPort });
const DEF = (id: string, nodes: WorkflowNode[], edges: WorkflowDefinition['edges'][number][], settings: WorkflowDefinition['settings'] = {}): WorkflowDefinition => ({
  schemaVersion: 1, id, name: id, description: '', projectId: 'proj-1', status: 'ready', version: 1,
  nodes, edges, settings, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

/* ── shared fake side-effect boundary (Phase 5 pattern) ─────────── */

class SpyFabric extends CapabilityFabric {
  invocations = 0;
  lastCapabilityId: string | null = null;
  override async invoke(capabilityId: string, input: Record<string, unknown>, context: InvocationContext): Promise<InvocationResult> {
    this.invocations += 1;
    this.lastCapabilityId = capabilityId;
    return super.invoke(capabilityId, input, context);
  }
}

interface FabricRig {
  fabric: SpyFabric;
  execResults: Record<string, () => Promise<{ ok: boolean; detail: string; output?: unknown }>>;
  /** Per-capability EXECUTOR runs (a parked fabric call is not an execution). */
  executed: Record<string, number>;
  approvalPersistence: { store: ApprovalPersistence; array: import('@aura/capability-fabric').ApprovalRequest[] };
}

/**
 * Build a governed fabric. `persistence` may be shared across simulated
 * process restarts — the SAME array is the approval store that survives,
 * exactly like the on-disk `createApprovalStore` in production.
 */
function makeRig(policy: unknown = AUTO_POLICY, persistence?: FabricRig['approvalPersistence']): FabricRig {
  const execResults: FabricRig['execResults'] = {};
  const executed: FabricRig['executed'] = {};
  const array: import('@aura/capability-fabric').ApprovalRequest[] = persistence?.array ?? [];
  const approvalPersistence = persistence ?? { store: { load: () => array, save: (requests) => { array.length = 0; array.push(...requests); } }, array };
  const fabric = new SpyFabric({
    permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: false }),
    nodeAvailable: () => true,
    resolveNode: () => ({ ok: true, node: { id: 'node-a', name: 'Node A', capabilities: [] } }),
    requestApproval: async () => false,
  });
  fabric.setPolicy(policy as never);
  for (const capabilityId of ['terminal.execute', 'git.status', 'git.commit', 'http.request', 'filesystem.write', 'mission.start', 'agent.delegate']) {
    const run = async () => {
      executed[capabilityId] = (executed[capabilityId] ?? 0) + 1;
      const r = execResults[capabilityId];
      if (!r) return { ok: false, detail: `executor for ${capabilityId} not registered in this test` };
      return r();
    };
    fabric.register({ capabilityId, run, supportsNode: () => true });
  }
  fabric.attachApprovalStore(approvalPersistence.store);
  return { fabric, execResults, executed, approvalPersistence };
}

const okR = (output?: unknown, detail = 'ok') => ({ ok: true, detail, output });

interface Harness {
  rig: FabricRig;
  definitions: WorkflowDefinitionStore;
  runs: WorkflowRunStore;
  runtime: WorkflowRuntime;
  home: string;
}

function harness(baseDir: string, policy: unknown = AUTO_POLICY, persistence?: FabricRig['approvalPersistence']): Harness {
  const rig = makeRig(policy, persistence);
  const ai = { generate: async () => ({ ok: true, output: { text: 'ai' } }) };
  const missions = {
    update: async () => ({ ok: true, state: 'active' }),
    wait: async () => ({ ok: true, state: 'completed' }),
  };
  const definitions = new WorkflowDefinitionStore({ baseDir });
  const runs = new WorkflowRunStore({ baseDir });
  const runtime = new WorkflowRuntime(
    {
      fabric: rig.fabric as unknown as CapabilityFabric,
      ai,
      missions,
      projectPath: () => path.join(baseDir, 'project'),
      askApproval: async () => false,
      sleep,
    },
    { definitions, runs },
  );
  return { rig, definitions, runs, runtime, home: baseDir };
}

function recordDef(definitions: WorkflowDefinitionStore, wf: WorkflowDefinition): void {
  definitions.record(wf);
}

/** A full run record shaped like a crashed process left behind. */
function plantRun(home: string, workflowId: string, runId: string, status: WorkflowRun['status'], nodeRuns: WorkflowRun['nodeRuns'] = []): void {
  const runs = new WorkflowRunStore({ baseDir: home });
  const now = new Date().toISOString();
  runs.record({
    schemaVersion: 1,
    runId,
    workflowId,
    workflowVersion: 1,
    projectId: 'proj-1',
    triggerId: 't',
    status,
    startedAt: now,
    nodeRuns,
    inputs: {},
    outputs: {},
    auditIds: [],
    createdAt: now,
  });
}

const approvalNode = (nodeId: string, requestId: string): WorkflowRun['nodeRuns'][number] => ({
  nodeId, status: 'approval-required', attempts: 1, logs: [],
  approval: { requestId, state: 'pending' }, auditIds: [],
});

/* ══════════════════════════════════════════════════════════════════
   A — crash / restart recovery
   ══════════════════════════════════════════════════════════════════ */

async function testRecovery() {
  console.log('\n[A1] recoverInterruptedRuns: stale running → failed, stale queued → failed');
  {
    const home = tmpHome();
    plantRun(home, 'g1', 'g1-running', 'running');
    plantRun(home, 'g1', 'g1-queued', 'queued');
    plantRun(home, 'g1', 'g1-paused', 'paused');
    plantRun(home, 'g1', 'g1-completed', 'completed');
    plantRun(home, 'g1', 'g1-failed', 'failed');
    plantRun(home, 'g1', 'g1-cancelled', 'cancelled');

    const runs = new WorkflowRunStore({ baseDir: home });
    // A fresh bridge (no live controllers) = the recovery authority.
    const manager = new WorkspaceManager({});
    const fabric = new CapabilityFabric({
      permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: false }),
      nodeAvailable: () => true,
      resolveNode: () => ({ ok: true, node: { id: 'n', name: 'N', capabilities: [] } }),
      requestApproval: async () => false,
    });
    fabric.setPolicy(AUTO_POLICY as never);
    const bridge = new WorkflowBridge({ fabric, manager, baseDir: home, schedule: false });

    const r1 = bridge.runs.get('g1', 'g1-running');
    const r2 = bridge.runs.get('g1', 'g1-queued');
    check('stale running marked failed', r1?.status === 'failed' && r1?.error === 'interrupted by process restart', JSON.stringify(r1?.status));
    check('stale queued marked failed', r2?.status === 'failed');
    check('paused survives recovery untouched', bridge.runs.get('g1', 'g1-paused')?.status === 'paused');
    check('completed survives recovery untouched', bridge.runs.get('g1', 'g1-completed')?.status === 'completed');
    check('failed survives recovery untouched', bridge.runs.get('g1', 'g1-failed')?.status === 'failed');
    check('cancelled survives recovery untouched', bridge.runs.get('g1', 'g1-cancelled')?.status === 'cancelled');
  }

  console.log('\n[A2] a crash-window run parked at an approval gate recovers to paused, not failed');
  {
    const home = tmpHome();
    const requestId = 'apr-crash-window';
    plantRun(home, 'g2', 'g2-run', 'running', [approvalNode('c', requestId)]);
    const manager = new WorkspaceManager({});
    const fabric = new CapabilityFabric({
      permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: false }),
      nodeAvailable: () => true,
      resolveNode: () => ({ ok: true, node: { id: 'n', name: 'N', capabilities: [] } }),
      requestApproval: async () => false,
    });
    fabric.setPolicy(REQUIRE_POLICY as never);
    fabric.attachApprovalStore(createApprovalStore());
    const bridge = new WorkflowBridge({ fabric, manager, baseDir: home, schedule: false });
    const run = bridge.runs.get('g2', 'g2-run');
    check('approval-gate run recovers to paused', run?.status === 'paused', `got ${run?.status}`);
    check('gate identity preserved on the node', run?.nodeRuns.find((n) => n.nodeId === 'c')?.approval?.requestId === requestId);
  }

  console.log('\n[A3] a completed run never re-executes: resumeRun returns it as-is');
  {
    const home = tmpHome();
    const h = harness(home);
    h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
    const wf = DEF('g3', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' }),
    ], [E('t', 'out', 'c')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('g3', { inputs: {} });
    const invocationsBefore = h.rig.fabric.invocations;
    const resumed = await h.runtime.resumeRun(run.runId);
    check('resumeRun on completed returns the run as-is', resumed?.status === 'completed');
    check('no re-execution after completion', h.rig.fabric.invocations === invocationsBefore, `${h.rig.fabric.invocations} vs ${invocationsBefore}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
   B — approval durability
   ══════════════════════════════════════════════════════════════════ */

async function testApprovalDurability() {
  console.log('\n[B1] approve after a simulated restart resumes exactly once');
  {
    const home = tmpHome();
    const persistence = makeRig(REQUIRE_POLICY).approvalPersistence;
    // "Process 1": park a run at the gate, then drop the stack undecided.
    let requestId = '';
    let runId = '';
    {
      const h = harness(home, REQUIRE_POLICY, persistence);
      h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
      const wf = DEF('b1', [N('t', 'manual'), N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' })], [E('t', 'out', 'c')]);
      recordDef(h.definitions, wf);
      const run = await h.runtime.startRun('b1', { inputs: {} });
      runId = run.runId;
      check('run parked at the gate', run.status === 'paused', `got ${run.status}`);
      requestId = h.rig.fabric.pendingApprovals()[0]!.id;
      check('approval persisted for the restart', h.rig.approvalPersistence.array.length === 1);
      check('executor never ran before the decision', h.rig.executed['terminal.execute'] === undefined, JSON.stringify(h.rig.executed));
    }
    // "Process 2": a fresh stack over the SAME home + shared approvals.
    {
      const h = harness(home, REQUIRE_POLICY, persistence);
      h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
      const resumed = await h.runtime.resumeRun(runId);
      check('restart resumes the parked run to paused', resumed?.status === 'paused');
      const granted = h.runtime.decideApproval(requestId, true, 'alice', 'restart approve');
      check('decision accepted by the restarted stack', granted !== null);
      const settled = await until(() => h.runtime.getRun(runId)?.status === 'completed');
      check('run completed after restart approve', settled, `status=${h.runtime.getRun(runId)?.status}`);
      check('executor ran exactly once across both processes', h.rig.executed['terminal.execute'] === 1, JSON.stringify(h.rig.executed));
    }
  }

  console.log('\n[B2] deny after a simulated restart fails the node deterministically');
  {
    const home = tmpHome();
    const persistence = makeRig(REQUIRE_POLICY).approvalPersistence;
    let requestId = '';
    let runId = '';
    {
      const h = harness(home, REQUIRE_POLICY, persistence);
      h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
      const wf = DEF('b2', [N('t', 'manual'), N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' })], [E('t', 'out', 'c')]);
      recordDef(h.definitions, wf);
      const run = await h.runtime.startRun('b2', { inputs: {} });
      runId = run.runId;
      requestId = h.rig.fabric.pendingApprovals()[0]!.id;
    }
    const h = harness(home, REQUIRE_POLICY, persistence);
    h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
    await h.runtime.resumeRun(runId);
    h.runtime.decideApproval(requestId, false, 'alice', 'no');
    const settled = await until(() => ['completed', 'failed'].includes(h.runtime.getRun(runId)?.status ?? ''));
    const run = h.runtime.getRun(runId)!;
    check('run failed after restart deny', settled && run.status === 'failed', `status=${run.status}`);
    check('node failed deterministically', run.nodeRuns.find((n) => n.nodeId === 'c')?.status === 'failed');
    check('denial recorded on the node', run.nodeRuns.find((n) => n.nodeId === 'c')?.approval?.state === 'denied');
    check('executor never ran (denied before execution)', h.rig.executed['terminal.execute'] === undefined, JSON.stringify(h.rig.executed));
  }

  console.log('\n[B3] a duplicate approval decision is a no-op');
  {
    const home = tmpHome();
    const h = harness(home, REQUIRE_POLICY);
    h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
    const wf = DEF('b3', [N('t', 'manual'), N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' })], [E('t', 'out', 'c')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('b3', { inputs: {} });
    const requestId = h.rig.fabric.pendingApprovals()[0]!.id;
    const first = h.runtime.decideApproval(requestId, true, 'alice');
    const second = h.runtime.decideApproval(requestId, true, 'mallory', 'double click');
    check('first decision granted', first?.state === 'granted');
    check('duplicate decision returns null', second === null, JSON.stringify(second));
    await until(() => h.runtime.getRun(run.runId)?.status === 'completed');
    check('exactly one execution from one grant', h.rig.executed['terminal.execute'] === 1, JSON.stringify(h.rig.executed));
  }

  console.log('\n[B4] stale decision for an unknown request is a no-op');
  {
    const home = tmpHome();
    const h = harness(home, REQUIRE_POLICY);
    const decision = h.runtime.decideApproval('apr-does-not-exist', true, 'alice');
    check('unknown request → null, no crash', decision === null);
  }

  console.log('\n[B5] approval for an unknown run / unknown node is handled safely');
  {
    const home = tmpHome();
    const h = harness(home, REQUIRE_POLICY);
    h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
    const wf = DEF('b5', [N('t', 'manual'), N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' })], [E('t', 'out', 'c')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('b5', { inputs: {} });
    const resumeUnknownNode = await h.runtime.resumeRunDecision(run.runId, 'no-such-node', true, 'alice');
    check('unknown node gate → no-op, run unchanged', resumeUnknownNode !== null && resumeUnknownNode.nodeRuns.find((n) => n.nodeId === 'c')?.status === 'approval-required');
  }
}

/* ══════════════════════════════════════════════════════════════════
   C — duplicate trigger protection
   ══════════════════════════════════════════════════════════════════ */

async function testDuplicateTriggers() {
  console.log('\n[C1] webhook singleFlight: a duplicate delivery folds into the active run');
  {
    const home = tmpHome();
    const manager = new WorkspaceManager({});
    const rig = makeRig(REQUIRE_POLICY);
    rig.fabric.attachApprovalStore(createApprovalStore());
    const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: false });
    const wf = DEF('c1', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' }),
    ], [E('t', 'out', 'c')], { singleFlight: true });
    bridge.definitions.record(wf);

    const first = await bridge.startTriggered('c1', { triggerPayload: { event: 'push' } });
    check('first webhook created a parked run', first.status === 'paused', JSON.stringify(first));
    const second = await bridge.startTriggered('c1', { triggerPayload: { event: 'push' } });
    check('duplicate webhook folded into the SAME run', second.runId === first.runId, `${second.runId} vs ${first.runId}`);
    check('no second run record was created', bridge.listRuns('c1', { limit: 100 }).length === 1, JSON.stringify(bridge.listRuns('c1', { limit: 100 })));
  }

  console.log('\n[C2] without singleFlight, concurrent runs are allowed');
  {
    const home = tmpHome();
    const manager = new WorkspaceManager({});
    const rig = makeRig(REQUIRE_POLICY);
    rig.fabric.attachApprovalStore(createApprovalStore());
    const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: false });
    const wf = DEF('c2', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' }),
    ], [E('t', 'out', 'c')]);
    bridge.definitions.record(wf);

    const first = await bridge.startTriggered('c2');
    const second = await bridge.startTriggered('c2');
    check('two distinct runs created', first.runId !== second.runId, `${first.runId} == ${second.runId}`);
    check('two run records exist', bridge.listRuns('c2', { limit: 100 }).length === 2, JSON.stringify(bridge.listRuns('c2', { limit: 100 })));
  }

  console.log('\n[C3] a manual start is deliberately NOT single-flighted');
  {
    const home = tmpHome();
    const manager = new WorkspaceManager({});
    const rig = makeRig(REQUIRE_POLICY);
    rig.fabric.attachApprovalStore(createApprovalStore());
    const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: false });
    const wf = DEF('c3', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' }),
    ], [E('t', 'out', 'c')], { singleFlight: true });
    bridge.definitions.record(wf);
    const first = await bridge.startManual('c3');
    const second = await bridge.startManual('c3');
    check('two manual runs despite singleFlight (explicit user act)', first.runId !== second.runId);
  }

  console.log('\n[C4] scheduler singleFlight: fire twice while active → one run');
  {
    const home = tmpHome();
    const manager = new WorkspaceManager({});
    const rig = makeRig(REQUIRE_POLICY);
    rig.fabric.attachApprovalStore(createApprovalStore());
    const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: true, eventSourcePollMs: 600_000 });
    const wf = DEF('c4', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' }),
    ], [E('t', 'out', 'c')], { singleFlight: true });
    bridge.definitions.record(wf);
    bridge.startScheduler();
    const first = await bridge.startTriggered('c4', { triggerPayload: { cron: 'x' } });
    const second = await bridge.startTriggered('c4', { triggerPayload: { cron: 'x' } });
    check('scheduler-path duplicate folded into the active run', second.runId === first.runId);
    bridge.shutdown();
  }
}

/* ══════════════════════════════════════════════════════════════════
   D — concurrency semantics
   ══════════════════════════════════════════════════════════════════ */

async function testConcurrency() {
  console.log('\n[D1] singleFlight blocks while a paused run exists — across a restart');
  {
    const home = tmpHome();
    // Process 1 parks a run.
    let firstRunId = '';
    {
      const manager = new WorkspaceManager({});
      const rig = makeRig(REQUIRE_POLICY);
      rig.fabric.attachApprovalStore(createApprovalStore());
      const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: false });
      const wf = DEF('d1', [
        N('t', 'manual'),
        N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' }),
      ], [E('t', 'out', 'c')], { singleFlight: true });
      bridge.definitions.record(wf);
      const run = await bridge.startManual('d1');
      firstRunId = run.runId;
      check('run parked before restart', run.status === 'paused');
    }
    // Process 2: recovery keeps the paused run; singleFlight still blocks.
    {
      const manager = new WorkspaceManager({});
      const rig = makeRig(REQUIRE_POLICY);
      rig.fabric.attachApprovalStore(createApprovalStore());
      const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: false });
      check('paused run survived recovery', bridge.runs.get('d1', firstRunId)?.status === 'paused');
      const fired = await bridge.startTriggered('d1');
      check('restarted process folds the trigger into the surviving run', fired.runId === firstRunId, `${fired.runId} vs ${firstRunId}`);
    }
  }

  console.log('\n[D2] the guard is in-process, not distributed — documented, not claimed');
  {
    // The scheduler docs state singleFlight is a local guard. Assert the
    // boundary honestly: two INDEPENDENT processes (fresh bridges over
    // different homes) cannot see each other's runs.
    const homeA = tmpHome();
    const homeB = tmpHome();
    const make = (home: string) => {
      const manager = new WorkspaceManager({});
      const rig = makeRig(REQUIRE_POLICY);
      rig.fabric.attachApprovalStore(createApprovalStore());
      const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: false });
      const wf = DEF('d2', [
        N('t', 'manual'),
        N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' }),
      ], [E('t', 'out', 'c')], { singleFlight: true });
      bridge.definitions.record(wf);
      return bridge;
    };
    const a = make(homeA);
    const b = make(homeB);
    const runA = await a.startManual('d2');
    const runB = await b.startManual('d2');
    check('independent processes are not mutually single-flighted (expected — no distributed lock)', runA.runId !== runB.runId);
  }
}

/* ══════════════════════════════════════════════════════════════════
   E — graceful shutdown
   ══════════════════════════════════════════════════════════════════ */

async function testShutdown() {
  console.log('\n[E1] bridge.shutdown() is idempotent');
  {
    const home = tmpHome();
    const manager = new WorkspaceManager({});
    const rig = makeRig(AUTO_POLICY);
    rig.fabric.attachApprovalStore(createApprovalStore());
    const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: true, eventSourcePollMs: 600_000 });
    bridge.startScheduler();
    check('scheduler running before shutdown', bridge.scheduler?.isRunning === true);
    bridge.shutdown();
    bridge.shutdown();
    check('scheduler stopped after shutdown', bridge.scheduler?.isRunning === false);
    check('registrations cleared after shutdown', bridge.scheduler?.activeCount === 0);
  }

  console.log('\n[E2] no new runs are accepted after shutdown begins');
  {
    const home = tmpHome();
    const manager = new WorkspaceManager({});
    const rig = makeRig(AUTO_POLICY);
    rig.fabric.attachApprovalStore(createApprovalStore());
    const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: false });
    const wf = DEF('e2', [N('t', 'manual'), N('r', 'result')], [E('t', 'out', 'r')]);
    bridge.definitions.record(wf);
    bridge.shutdown();
    let threw = false;
    try { await bridge.startManual('e2'); } catch { threw = true; }
    check('startManual after shutdown throws', threw);
    let threwTrigger = false;
    try { await bridge.startTriggered('e2'); } catch { threwTrigger = true; }
    check('startTriggered after shutdown throws', threwTrigger);
  }

  console.log('\n[E3] the scheduler cannot be resurrected after shutdown');
  {
    const home = tmpHome();
    const manager = new WorkspaceManager({});
    const rig = makeRig(AUTO_POLICY);
    rig.fabric.attachApprovalStore(createApprovalStore());
    const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: true, eventSourcePollMs: 600_000 });
    const wf = DEF('e3', [N('t', 'manual'), N('r', 'result')], [E('t', 'out', 'r')]);
    bridge.definitions.record(wf);
    bridge.startScheduler();
    bridge.shutdown();
    bridge.startScheduler();
    check('startScheduler after shutdown is a no-op', bridge.scheduler?.isRunning === false, `isRunning=${bridge.scheduler?.isRunning}`);
  }

  console.log('\n[E4] a paused run survives shutdown and is resumable by a fresh process');
  {
    const home = tmpHome();
    let runId = '';
    let requestId = '';
    {
      const manager = new WorkspaceManager({});
      const rig = makeRig(REQUIRE_POLICY);
      rig.fabric.attachApprovalStore(createApprovalStore());
      const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: false });
      const wf = DEF('e4', [
        N('t', 'manual'),
        N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' }),
      ], [E('t', 'out', 'c')]);
      bridge.definitions.record(wf);
      const run = await bridge.startManual('e4');
      runId = run.runId;
      requestId = bridge.pendingApprovals()[0]!.id;
      bridge.shutdown();
      check('paused run record persisted through shutdown', bridge.runs.get('e4', runId)?.status === 'paused');
    }
    // Fresh process resumes and completes.
    {
      const manager = new WorkspaceManager({});
      const rig = makeRig(REQUIRE_POLICY);
      rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
      rig.fabric.attachApprovalStore(createApprovalStore());
      const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: false });
      bridge.runtime.resumeRun(runId);
      bridge.decideApproval(requestId, true, 'alice', 'after shutdown');
      const settled = await until(() => bridge.getRun(runId)?.status === 'completed');
      check('fresh process resumed and completed the run', settled, `status=${bridge.getRun(runId)?.status}`);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
   F — scheduler hardening
   ══════════════════════════════════════════════════════════════════ */

async function testSchedulerHardening() {
  console.log('\n[F1] start/stop/reload are idempotent; no duplicate registration');
  {
    const home = tmpHome();
    const manager = new WorkspaceManager({});
    const rig = makeRig(AUTO_POLICY);
    rig.fabric.attachApprovalStore(createApprovalStore());
    const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: true, eventSourcePollMs: 600_000 });
    const wf = DEF('f1', [
      N('sc', 'schedule', { cron: '0 9 * * *' }),
      N('r', 'result'),
    ], [E('sc', 'out', 'r')]);
    bridge.definitions.record(wf);
    bridge.startScheduler();
    bridge.startScheduler();
    check('start twice → one registration', bridge.scheduler?.activeCount === 1, `count=${bridge.scheduler?.activeCount}`);
    bridge.stopScheduler();
    bridge.stopScheduler();
    check('stop twice → zero registrations, no crash', bridge.scheduler?.activeCount === 0);
    bridge.startScheduler();
    check('restart re-registers exactly once', bridge.scheduler?.activeCount === 1);
    bridge.scheduler?.reload();
    check('reload keeps exactly one registration', bridge.scheduler?.activeCount === 1);
    bridge.shutdown();
  }

  console.log('\n[F2] a failing workflow never kills the scheduler');
  {
    const home = tmpHome();
    const manager = new WorkspaceManager({});
    const rig = makeRig(AUTO_POLICY);
    rig.fabric.attachApprovalStore(createApprovalStore());
    // The failing workflow's capability node fails at runtime.
    rig.execResults['http.request'] = async () => ({ ok: false, detail: 'connection refused (deterministic)' });
    const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: true, eventSourcePollMs: 600_000 });
    const failing = DEF('f2-fail', [
      N('sc', 'schedule', { cron: '0 9 * * *' }),
      N('c', 'capability', { capabilityId: 'http.request', inputMap: 'url: http://x' }),
    ], [E('sc', 'out', 'c')]);
    const healthy = DEF('f2-ok', [
      N('sc', 'schedule', { cron: '0 9 * * *' }),
      N('r', 'result'),
    ], [E('sc', 'out', 'r')]);
    bridge.definitions.record(failing);
    bridge.definitions.record(healthy);
    bridge.startScheduler();
    check('both workflows registered', bridge.scheduler?.activeCount === 2, `count=${bridge.scheduler?.activeCount}`);

    // Fire the failing workflow's schedule node directly (as the scheduler
    // would): a workflow failure must not take the scheduler down.
    const failRun = await bridge.startTriggered('f2-fail', { triggerPayload: { cron: 'fire' } });
    check('failing run recorded', !!failRun.runId);
    const okRun = await bridge.startTriggered('f2-ok', { triggerPayload: { cron: 'fire' } });
    check('healthy workflow still fires after a sibling failure', !!okRun.runId);
    check('scheduler still alive and fully registered', bridge.scheduler?.isRunning === true && bridge.scheduler?.activeCount === 2);
    bridge.shutdown();
  }

  console.log('\n[F3] a deleted definition cannot be fired (fire is a no-op)');
  {
    const home = tmpHome();
    const manager = new WorkspaceManager({});
    const rig = makeRig(AUTO_POLICY);
    rig.fabric.attachApprovalStore(createApprovalStore());
    const bridge = new WorkflowBridge({ fabric: rig.fabric, manager, baseDir: home, schedule: false });
    const wf = DEF('f3', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' }),
    ], [E('t', 'out', 'c')]);
    bridge.definitions.record(wf);
    bridge.definitions.remove('f3');
    let threw = false;
    try { await bridge.startTriggered('f3'); } catch { threw = true; }
    check('triggering a deleted definition throws cleanly', threw);
  }
}

/* ══════════════════════════════════════════════════════════════════
   G — persistence corruption
   ══════════════════════════════════════════════════════════════════ */

async function testPersistenceCorruption() {
  console.log('\n[G1] malformed run records are skipped — never a crash, never "empty/new"');
  {
    const home = tmpHome();
    const runsDir = path.join(home, 'workflow-runs', 'g1');
    fs.mkdirSync(runsDir, { recursive: true });
    // Not valid JSON at all.
    fs.writeFileSync(path.join(runsDir, 'truncated.json'), '{ "runId": "trunc", ');
    // Valid JSON, wrong shape (an array, not a run).
    fs.writeFileSync(path.join(runsDir, 'wrong-schema.json'), JSON.stringify([1, 2, 3]));
    // A real run alongside.
    const h = harness(home);
    const wf = DEF('g1', [N('t', 'manual'), N('r', 'result')], [E('t', 'out', 'r')]);
    recordDef(h.definitions, wf);
    await h.runtime.startRun('g1', { inputs: {} });

    const runs = new WorkflowRunStore({ baseDir: home });
    const list = runs.list('g1', { limit: 100 });
    check('corrupt files skipped without crashing list()', list.length === 1, JSON.stringify(list.map((r) => r.runId)));
    const truncated = runs.get('g1', 'trunc');
    check('truncated record reads as absent, not as a new run', truncated === null);
    check('corrupt file not overwritten by reads', fs.readFileSync(path.join(runsDir, 'truncated.json'), 'utf8').includes('"trunc"'));
  }

  console.log('\n[G2] a record missing startedAt does not crash the sort (Phase 8 fix)');
  {
    const home = tmpHome();
    const runsDir = path.join(home, 'workflow-runs', 'g2');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'no-started.json'), JSON.stringify({
      schemaVersion: 1, runId: 'no-started', workflowId: 'g2', workflowVersion: 1, projectId: null,
      triggerId: null, status: 'failed', nodeRuns: [], inputs: {}, outputs: {}, auditIds: [], createdAt: new Date().toISOString(),
    }));
    const runs = new WorkflowRunStore({ baseDir: home });
    const list = runs.list('g2', { limit: 100 });
    check('missing startedAt record still listed (sorted safely)', list.length === 1 && list[0]!.runId === 'no-started');
    const stats = runs.stats('g2');
    check('stats tolerate the missing timestamp', stats.runs === 1);
  }

  console.log('\n[G3] malformed definitions are skipped, never interpreted as new');
  {
    const home = tmpHome();
    const defsDir = path.join(home, 'workflow-defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(path.join(defsDir, 'broken.workflow.json'), '{ not json');
    fs.writeFileSync(path.join(defsDir, 'wrong.workflow.json'), JSON.stringify({ name: 'no id no nodes' }));
    const defs = new WorkflowDefinitionStore({ baseDir: home });
    const list = defs.list();
    check('malformed definition files skipped without crashing', list.length === 0, JSON.stringify(list));
  }
}

/* ══════════════════════════════════════════════════════════════════
   H — run state machine
   ══════════════════════════════════════════════════════════════════ */

async function testStateMachine() {
  console.log('\n[H1] terminal runs cannot be re-entered: completed/cancelled/failed return as-is');
  {
    const home = tmpHome();
    const h = harness(home);
    h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
    h.rig.execResults['http.request'] = async () => ({ ok: false, detail: 'nope' });

    const wfOk = DEF('h1-ok', [N('t', 'manual'), N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' })], [E('t', 'out', 'c')]);
    const wfFail = DEF('h1-fail', [N('t', 'manual'), N('c', 'capability', { capabilityId: 'http.request', inputMap: 'url: http://x' })], [E('t', 'out', 'c')]);
    recordDef(h.definitions, wfOk);
    recordDef(h.definitions, wfFail);

    const completed = await h.runtime.startRun('h1-ok', { inputs: {} });
    const resumed = await h.runtime.resumeRun(completed.runId);
    check('completed stays completed on resume', resumed?.status === 'completed');

    const failed = await h.runtime.startRun('h1-fail', { inputs: {} });
    const resumedFailed = await h.runtime.resumeRun(failed.runId);
    check('failed stays failed on resume', resumedFailed?.status === 'failed');
  }

  console.log('\n[H2] approval-required cannot silently become success');
  {
    const home = tmpHome();
    const h = harness(home, REQUIRE_POLICY);
    h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
    const wf = DEF('h2', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' }),
      N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('h2', { inputs: {} });
    check('run parked (no auto-approval)', run.status === 'paused');
    check('capability node approval-required', run.nodeRuns.find((n) => n.nodeId === 'c')?.status === 'approval-required');
    check('downstream never ran', run.nodeRuns.find((n) => n.nodeId === 'r')?.status === 'waiting');
    check('executor never invoked', h.rig.executed['terminal.execute'] === undefined, JSON.stringify(h.rig.executed));
  }

  console.log('\n[H3] a cancelled run cannot be resumed into running');
  {
    const home = tmpHome();
    const h = harness(home);
    const wf = DEF('h3', [N('t', 'manual'), N('d', 'delay', { ms: 10000 })], [E('t', 'out', 'd')]);
    recordDef(h.definitions, wf);
    const start = h.runtime.startRun('h3', { inputs: {} });
    await sleep(30);
    const cancelled = await h.runtime.cancelRun(h.runtime.listRuns('h3')[0]!.runId);
    check('run cancelled', cancelled?.status === 'cancelled');
    await start;
    const resumed = await h.runtime.resumeRun(cancelled!.runId);
    check('cancelled stays cancelled on resume', resumed?.status === 'cancelled');
  }
}

/* ══════════════════════════════════════════════════════════════════
   I — failure injection
   ══════════════════════════════════════════════════════════════════ */

async function testFailureInjection() {
  console.log('\n[I1] executor permanent failure → run failed, downstream skipped');
  {
    const home = tmpHome();
    const h = harness(home);
    h.rig.execResults['http.request'] = async () => ({ ok: false, detail: 'connection refused (deterministic)' });
    const wf = DEF('i1', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'http.request', inputMap: 'url: http://x' }),
      N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('i1', { inputs: {} });
    check('run failed', run.status === 'failed');
    check('error surfaced', (run.error ?? '').includes('connection refused'), run.error ?? '');
    check('downstream skipped', run.nodeRuns.find((n) => n.nodeId === 'r')?.status === 'skipped');
  }

  console.log('\n[I2] transient failure + retry → succeeds, attempts recorded');
  {
    const home = tmpHome();
    const h = harness(home);
    let calls = 0;
    h.rig.execResults['http.request'] = async () => {
      calls += 1;
      return calls < 3 ? { ok: false, detail: `transient ${calls}` } : okR({ status: 200 });
    };
    const wf = DEF('i2', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'http.request', inputMap: 'url: http://x', retry: { maxAttempts: 4, delayMs: 1, backoffFactor: 1 } }),
    ], [E('t', 'out', 'c')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('i2', { inputs: {} });
    check('retried run completed', run.status === 'completed', JSON.stringify(run.status));
    check('attempts recorded on the node', run.nodeRuns.find((n) => n.nodeId === 'c')!.attempts === 3, String(run.nodeRuns.find((n) => n.nodeId === 'c')!.attempts));
  }

  console.log('\n[I3] timeout → run failed with the timeout error');
  {
    const home = tmpHome();
    const h = harness(home);
    h.rig.execResults['http.request'] = async () => { await sleep(150); return okR({ status: 200 }); };
    const wf = DEF('i3', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'http.request', inputMap: 'url: http://x', timeoutMs: 10 }),
    ], [E('t', 'out', 'c')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('i3', { inputs: {} });
    check('timeout run failed', run.status === 'failed');
    check('timeout error recorded', (run.error ?? '').includes('timed out'), run.error ?? '');
  }

  console.log('\n[I4] approval denial → run failed, node failed');
  {
    const home = tmpHome();
    const h = harness(home, REQUIRE_POLICY);
    h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
    const wf = DEF('i4', [
      N('t', 'manual'),
      N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' }),
      N('r', 'result'),
    ], [E('t', 'out', 'c'), E('c', 'out', 'r')]);
    recordDef(h.definitions, wf);
    const run = await h.runtime.startRun('i4', { inputs: {} });
    const requestId = h.rig.fabric.pendingApprovals()[0]!.id;
    h.runtime.decideApproval(requestId, false, 'alice', 'not now');
    const settled = await until(() => ['completed', 'failed'].includes(h.runtime.getRun(run.runId)?.status ?? ''));
    check('run failed after denial', settled && h.runtime.getRun(run.runId)?.status === 'failed');
    check('denied node failed', h.runtime.getRun(run.runId)?.nodeRuns.find((n) => n.nodeId === 'c')?.status === 'failed');
  }

  console.log('\n[I5] cancellation → run cancelled, no further nodes');
  {
    const home = tmpHome();
    const h = harness(home);
    const wf = DEF('i5', [N('t', 'manual'), N('d', 'delay', { ms: 10000 }), N('r', 'result')], [E('t', 'out', 'd'), E('d', 'out', 'r')]);
    recordDef(h.definitions, wf);
    const start = h.runtime.startRun('i5', { inputs: {} });
    await sleep(30);
    const cancelled = await h.runtime.cancelRun(h.runtime.listRuns('i5')[0]!.runId);
    check('run cancelled', cancelled?.status === 'cancelled');
    await start;
    check('downstream never ran', h.runtime.getRun(cancelled!.runId)?.nodeRuns.find((n) => n.nodeId === 'r')?.status === 'waiting' || h.runtime.getRun(cancelled!.runId)?.nodeRuns.find((n) => n.nodeId === 'r')?.status === 'skipped');
  }

  console.log('\n[I6] missing capability → run fails with a clear error, never a silent success');
  {
    const home = tmpHome();
    const h = harness(home);
    const wf = DEF('i6', [N('t', 'manual'), N('c', 'capability', { capabilityId: 'no.such.capability' })], [E('t', 'out', 'c')]);
    const issues = validateDefinition(wf, { knownCapabilities: h.definitions.knownCapabilities });
    check('validation flags the unknown capability', hasErrors(issues));
    let threw = false;
    try { recordDef(h.definitions, wf); await h.runtime.startRun('i6', { inputs: {} }); } catch { threw = true; }
    check('startRun refuses the invalid definition', threw);
  }

  console.log('\n[I7] restart during pause resumes exactly once (gate + grant held)');
  {
    const home = tmpHome();
    const persistence = makeRig(REQUIRE_POLICY).approvalPersistence;
    let runId = '';
    let requestId = '';
    {
      const h = harness(home, REQUIRE_POLICY, persistence);
      h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
      const wf = DEF('i7', [N('t', 'manual'), N('c', 'capability', { capabilityId: 'terminal.execute', inputMap: 'command: true' })], [E('t', 'out', 'c')]);
      recordDef(h.definitions, wf);
      const run = await h.runtime.startRun('i7', { inputs: {} });
      runId = run.runId;
      requestId = h.rig.fabric.pendingApprovals()[0]!.id;
    }
    const h = harness(home, REQUIRE_POLICY, persistence);
    h.rig.execResults['terminal.execute'] = async () => okR({ exitCode: 0 });
    await h.runtime.resumeRun(runId);
    h.runtime.decideApproval(requestId, true, 'alice');
    const settled = await until(() => h.runtime.getRun(runId)?.status === 'completed');
    check('restart-during-pause completed', settled, `status=${h.runtime.getRun(runId)?.status}`);
    check('exactly one execution', h.rig.executed['terminal.execute'] === 1, JSON.stringify(h.rig.executed));
  }
}

/* ══════════════════════════════════════════════════════════════════
   J — security scan
   ══════════════════════════════════════════════════════════════════ */

function testSecurityScan(): void {
  console.log('\n[J1] the runtime execution layer has no shell/process bypass');
  const root = path.resolve(import.meta.dirname, '..');
  const targets = [
    'packages/workflow/src/runtime/runtime.ts',
    'packages/workflow/src/runtime/scheduler.ts',
    'packages/workflow/src/runtime/executors.ts',
    'packages/workflow/src/runtime/triggerScheduler.ts',
    'packages/workflow/src/runtime/cron.ts',
    'packages/ai-service/src/workflowBridge.ts',
    'packages/ai-service/src/fabric/index.ts',
  ];
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/\/\/.*$/gm, '');
  const bypass = /(child_process|spawnSync|execSync|spawn\(|fork\(|new Function|(?<![.\w])eval\s*\(|shell:\s*true|fs\.(writeFile|appendFile|mkdir|rm|rmSync|unlink)|git\()/;
  for (const rel of targets) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    const hits = stripComments(src).split('\n').map((l, i) => ({ l, i })).filter(({ l }) => bypass.test(l));
    check(`no bypass patterns in ${rel}`, hits.length === 0, hits.map((x) => `line ${x.i + 1}: ${x.l.trim().slice(0, 90)}`).join(' ; '));
  }
}

/* ══════════════════════════════════════════════════════════════════
   Environment-dependent checks (E1/F2) — honest reporting only
   ══════════════════════════════════════════════════════════════════ */

async function testEnvironmentDependent() {
  console.log('\n[E1] real OpenCode agent execution');
  // The opencode binary is present on this machine, but a governed agent
  // run needs a provider credential the sandbox does not carry. The Phase
  // 7 suite already exercised this end-to-end; it is re-marked honestly.
  const opencode = fs.existsSync('/home/Groot/.npm-global/bin/opencode') || process.env.PATH?.split(':').some((p) => fs.existsSync(path.join(p, 'opencode')));
  if (!opencode) {
    unverified('real OpenCode execution', 'no opencode binary on PATH');
  } else {
    unverified('real OpenCode execution', 'binary present but no provider credential in this environment — Phase 7 E1 covers the governed path');
  }

  console.log('\n[F2] provider-backed mission.create');
  unverified('provider-backed mission.create', 'no AI provider credential in this environment — the fabric path is covered deterministically elsewhere');
}

/* ══════════════════════════════════════════════════════════════════
   Main
   ══════════════════════════════════════════════════════════════════ */

async function main(): Promise<void> {
  console.log('Phase 8 verification — production hardening + operational reliability');
  await testRecovery();
  await testApprovalDurability();
  await testDuplicateTriggers();
  await testConcurrency();
  await testShutdown();
  await testSchedulerHardening();
  await testPersistenceCorruption();
  await testStateMachine();
  await testFailureInjection();
  testSecurityScan();
  await testEnvironmentDependent();

  console.log(`\nPhase 8: ${passed} passed · ${failed} failed · ${notVerified} not verified`);
  process.exitCode = failed > 0 ? 1 : 0;
}

await main();
