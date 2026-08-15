/**
 * retry-governance-verify — the production-gate suite for the retry
 * architecture fix.
 * ==================================================================
 *   node scripts/run-ts.mjs scripts/retry-governance-verify.mjs
 *
 * Proves the single invariant the release gate was stopped on:
 *
 *   An irreversible capability is never automatically executed again
 *   after its effect may have started without fresh human authorization.
 *
 * Coverage (§6 of the blocker brief), all deterministic, temp-AURA_HOME
 * only:
 *
 *   1  reversible + transient            → automatic retries
 *   2  irreversible + effectStarted=false → automatic retries
 *   3  irreversible + effectStarted=true  → DOES NOT retry
 *   4  irreversible + effectStarted=undefined → DOES NOT retry
 *   5  withheld retry becomes awaiting-approval
 *   6  approval request is persisted
 *   7  approval rule is irreversible-retry
 *   8  denied retry never reaches the executor
 *   9  granted retry executes exactly once
 *  10  correlation IDs remain intact
 *  11  audit contains the retry governance decision
 *  12  no prompt/secrets are persisted
 *  13  no capability id is hardcoded in retry logic
 *  14  the retry decision reads CapabilityDescriptor.irreversible
 *  15  NEGATIVE CONTROL — the OLD retry loop re-executes a started
 *      irreversible effect; the new one executes it once and parks it
 *  16  workflow node-level withRetry respects the invariant
 *  17  the workflow retry control node respects the invariant
 *  18  workflow park → human grant → exactly one more execution
 *  19  workflow deny → the executor never runs again
 *  20  security/architecture scan: one Fabric, no bypass primitives
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CapabilityFabric, CAPABILITY_MANIFEST } from '@aura/capability-fabric';
import { WorkflowRuntime, WorkflowDefinitionStore, WorkflowRunStore } from '@aura/workflow';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 6000, step = 20) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

/* ── governed fabric rig ─────────────────────────────────────────── */

const AUTO_POLICY = {
  byRisk: { low: 'auto-execute', medium: 'auto-execute', high: 'auto-execute' },
  overrides: {},
  allowAutonomous: true,
};

class SpyFabric extends CapabilityFabric {
  invocations = 0;
  async invoke(capabilityId, input, context) {
    this.invocations += 1;
    return super.invoke(capabilityId, input, context);
  }
}

/**
 * A governed fabric with scriptable executors and the production host
 * semantics: `requestApproval` grants exactly what THIS call's
 * `approvedCapabilities` covers — and nothing else. The Fabric strips
 * the per-invocation grant before asking about a retry-withhold, so a
 * retry of an uncertain irreversible effect is never auto-granted here,
 * exactly as in production.
 */
function makeRig() {
  const execResults = {};
  const executed = {};
  const approvals = [];
  const approvalStore = {
    load: () => approvals,
    save: (requests) => {
      approvals.length = 0;
      approvals.push(...requests);
    },
  };
  const fabric = new SpyFabric({
    permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: false }),
    nodeAvailable: () => true,
    resolveNode: () => ({ ok: true, node: { id: 'node-a', name: 'Node A', capabilities: [] } }),
    requestApproval: async (request, context) => {
      const approved = new Set(context.approvedCapabilities ?? []);
      return request.items.every((item) => approved.has(item.capabilityId));
    },
  });
  fabric.setPolicy(AUTO_POLICY);
  fabric.attachApprovalStore(approvalStore);
  for (const id of ['http.request', 'git.push', 'agent.delegate']) {
    fabric.register({
      capabilityId: id,
      supportsNode: () => true,
      run: async () => {
        executed[id] = (executed[id] ?? 0) + 1;
        const script = execResults[id];
        if (!script) return { ok: false, detail: `no executor script for ${id}` };
        return script();
      },
    });
  }
  return { fabric, execResults, executed, approvals };
}

/** Invocation context: workflow-correlated, with a per-call grant for git.push. */
const ctx = (extra = {}) => ({
  actor: { kind: 'agent', id: 'test-agent' },
  projectId: 'proj-1',
  missionId: 'mission-1',
  taskId: 'task-1',
  approvedCapabilities: ['git.push'],
  ...extra,
});

/* ── workflow harness ────────────────────────────────────────────── */

const N = (id, type, config = {}) => ({ id, type, x: 0, y: 0, config });
const E = (from, fromPort, to, toPort = 'in') => ({ id: `e-${from}-${to}`, from, fromPort, to, toPort });
const DEF = (id, nodes, edges, settings = {}) => ({
  schemaVersion: 1, id, name: id, description: '', projectId: 'proj-1', status: 'ready', version: 1,
  nodes, edges, settings, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

function workflowHarness(baseDir, rig) {
  const definitions = new WorkflowDefinitionStore({ baseDir });
  const runs = new WorkflowRunStore({ baseDir });
  const runtime = new WorkflowRuntime(
    {
      fabric: rig.fabric,
      ai: { generate: async () => ({ ok: true, output: { text: 'ai' } }) },
      missions: { update: async () => ({ ok: true }), wait: async () => ({ ok: true, state: 'completed' }) },
      projectPath: () => path.join(baseDir, 'project'),
      askApproval: async () => false,
      sleep,
    },
    { definitions, runs },
  );
  return { definitions, runs, runtime };
}

/* ══════════════════════════════════════════════════════════════════
   1. reversible + transient → automatic retries
   ══════════════════════════════════════════════════════════════════ */

async function testReversibleRetries() {
  console.log('\n[1] reversible + transient → retries');
  const rig = makeRig();
  let calls = 0;
  rig.execResults['http.request'] = async () => {
    calls += 1;
    return calls < 3
      ? { ok: false, detail: `request timed out (attempt ${calls})` }
      : { ok: true, detail: '200 OK', output: { status: 200 } };
  };
  const result = await rig.fabric.invoke('http.request', { url: 'http://x' }, ctx({ approvedCapabilities: [] }));
  check('retries to success', result.outcome === 'succeeded' && calls === 3, `outcome=${result.outcome} calls=${calls}`);
  check('result records attempts', result.attempts === 3, `attempts=${result.attempts}`);
}

/* ══════════════════════════════════════════════════════════════════
   2. irreversible + effectStarted=false → automatic retries (proven safe)
   ══════════════════════════════════════════════════════════════════ */

async function testIrreversibleProvenNotStartedRetries() {
  console.log('\n[2] irreversible + effectStarted=false → retries');
  const rig = makeRig();
  let calls = 0;
  rig.execResults['git.push'] = async () => {
    calls += 1;
    return calls < 3
      ? { ok: false, detail: 'timed out before the push could start', effectStarted: false }
      : { ok: true, effectStarted: true, detail: 'Pushed main to origin.', output: { exitCode: 0 } };
  };
  const result = await rig.fabric.invoke('git.push', { branch: 'main' }, ctx());
  check('retries to success', result.outcome === 'succeeded' && calls === 3, `outcome=${result.outcome} calls=${calls}`);
  check('no approval was asked (proven-safe retries stay automatic)', rig.fabric.pendingApprovals().length === 0);
  check('result effectStarted reported', result.effectStarted === true, String(result.effectStarted));
  check('result marks the capability irreversible', result.irreversible === true, String(result.irreversible));
}

/* ══════════════════════════════════════════════════════════════════
   3. irreversible + effectStarted=true → NO automatic retry
   ══════════════════════════════════════════════════════════════════ */

async function testIrreversibleStartedNoRetry() {
  console.log('\n[3] irreversible + effectStarted=true → does NOT retry');
  const rig = makeRig();
  let calls = 0;
  rig.execResults['git.push'] = async () => {
    calls += 1;
    return { ok: false, detail: 'timed out mid-push', effectStarted: true };
  };
  const result = await rig.fabric.invoke('git.push', { branch: 'main' }, ctx());
  check('executor ran exactly once', calls === 1, `calls=${calls}`);
  check('no automatic retry happened', result.attempts === 1, `attempts=${result.attempts}`);
  check('invocation parked as awaiting-approval', result.outcome === 'awaiting-approval', result.outcome);
  const pending = rig.fabric.pendingApprovals();
  check('a pending approval request exists', pending.length === 1, `pending=${pending.length}`);
  check('approval rule is irreversible-retry', pending[0]?.rule === 'irreversible-retry', pending[0]?.rule);
  check('approval was persisted to the store', rig.approvals.some((a) => a.id === pending[0]?.id));
  check('approval summary explains the uncertain effect',
    /may already have taken effect/.test(pending[0]?.summary ?? '') && /required before another execution/.test(pending[0]?.summary ?? ''),
    pending[0]?.summary);
  check('parked result carries the execution-state attestation', result.effectStarted === true, String(result.effectStarted));
  check('parked result marks the capability irreversible', result.irreversible === true, String(result.irreversible));
  return { rig, calls: () => calls, result };
}

/* ══════════════════════════════════════════════════════════════════
   4. irreversible + effectStarted=undefined → NO automatic retry
   ══════════════════════════════════════════════════════════════════ */

async function testIrreversibleUnknownNoRetry() {
  console.log('\n[4] irreversible + effectStarted=undefined → does NOT retry');
  const rig = makeRig();
  let calls = 0;
  rig.execResults['git.push'] = async () => {
    calls += 1;
    return { ok: false, detail: 'timed out mid-push' }; // unknown — never treated as safe
  };
  const result = await rig.fabric.invoke('git.push', { branch: 'main' }, ctx());
  check('executor ran exactly once (unknown ≠ safe)', calls === 1, `calls=${calls}`);
  check('invocation parked as awaiting-approval', result.outcome === 'awaiting-approval', result.outcome);
  check('result effectStarted is undefined (unknown, not false)', result.effectStarted === undefined, String(result.effectStarted));
}

/* ══════════════════════════════════════════════════════════════════
   5. correlation IDs remain intact through the governance pause
   ══════════════════════════════════════════════════════════════════ */

async function testCorrelationIds() {
  console.log('\n[5] correlation IDs remain intact');
  const rig = makeRig();
  rig.execResults['git.push'] = async () => ({ ok: false, detail: 'timed out mid-push', effectStarted: true });
  const result = await rig.fabric.invoke('git.push', { branch: 'main' }, ctx());
  const pending = rig.fabric.pendingApprovals()[0];
  check('approval request carries mission/task correlation',
    pending?.missionId === 'mission-1' && pending?.taskId === 'task-1',
    JSON.stringify({ m: pending?.missionId, t: pending?.taskId }));
  check('approval request references this invocation',
    pending?.items[0]?.invocationId === result.invocationId,
    `${pending?.items[0]?.invocationId} vs ${result.invocationId}`);
  const audit = rig.fabric.audit().find((a) => a.invocationId === result.invocationId);
  check('audit record carries mission/task correlation',
    audit?.missionId === 'mission-1' && audit?.taskId === 'task-1',
    JSON.stringify({ m: audit?.missionId, t: audit?.taskId }));
  check('audit record carries the same invocation id', audit?.invocationId === result.invocationId);
}

/* ══════════════════════════════════════════════════════════════════
   6. audit contains the retry governance decision
   ══════════════════════════════════════════════════════════════════ */

async function testAuditDecision() {
  console.log('\n[6] audit contains the retry governance decision');
  const rig = makeRig();
  rig.execResults['git.push'] = async () => ({ ok: false, detail: 'timed out mid-push', effectStarted: true });
  const result = await rig.fabric.invoke('git.push', { branch: 'main' }, ctx());
  const audit = rig.fabric.audit().find((a) => a.invocationId === result.invocationId);
  check('audit records retry withheld', audit?.retry?.withheld === true, JSON.stringify(audit?.retry));
  check('audit records the rule', audit?.retry?.rule === 'irreversible-retry', audit?.retry?.rule);
  check('audit records the effect state', audit?.retry?.effectStarted === true, String(audit?.retry?.effectStarted));
  check('audit decisionRule is irreversible-retry', audit?.decisionRule === 'irreversible-retry', audit?.decisionRule);
  check('audit outcome is awaiting-approval', audit?.outcome === 'awaiting-approval', audit?.outcome);
}

/* ══════════════════════════════════════════════════════════════════
   7. denied retry never reaches the executor
   ══════════════════════════════════════════════════════════════════ */

async function testDeniedRetry() {
  console.log('\n[7] denied retry never reaches the executor');
  const rig = makeRig();
  let calls = 0;
  rig.execResults['git.push'] = async () => {
    calls += 1;
    return { ok: false, detail: 'timed out mid-push', effectStarted: true };
  };
  const result = await rig.fabric.invoke('git.push', { branch: 'main' }, ctx());
  const requestId = rig.fabric.pendingApprovals()[0].id;
  const decided = rig.fabric.decideApproval(requestId, false, 'user', 'do not retry');
  check('denial recorded', decided?.state === 'denied');
  check('executor count unchanged after denial', calls === 1, `calls=${calls}`);
  check('invocation result stayed parked', result.outcome === 'awaiting-approval');
  // The execution record and the decision record share the approvalId; the
  // DECISION record is the one carrying approvalDecision.
  const audit = rig.fabric.audit().find((a) => a.approvalId === requestId && a.approvalDecision === 'denied');
  check('denial written to the audit trail', !!audit && audit.decidedBy === 'user', JSON.stringify(audit));
}

/* ══════════════════════════════════════════════════════════════════
   8. granted retry executes exactly once
   ══════════════════════════════════════════════════════════════════ */

async function testGrantedRetry() {
  console.log('\n[8] granted retry executes exactly once');
  const rig = makeRig();
  let calls = 0;
  rig.execResults['git.push'] = async () => {
    calls += 1;
    return calls === 1
      ? { ok: false, detail: 'timed out mid-push', effectStarted: true }
      : { ok: true, effectStarted: true, detail: 'Pushed main to origin.', output: { exitCode: 0 } };
  };
  await rig.fabric.invoke('git.push', { branch: 'main' }, ctx());
  const requestId = rig.fabric.pendingApprovals()[0].id;
  check('parked after one execution', calls === 1, `calls=${calls}`);
  rig.fabric.decideApproval(requestId, true, 'user', 'push is fine');
  check('grant alone does not execute anything', calls === 1, `calls=${calls}`);
  const resumed = await rig.fabric.invoke('git.push', { branch: 'main' }, ctx());
  check('re-invocation after grant succeeds', resumed.outcome === 'succeeded', resumed.outcome);
  check('granted retry executed exactly one more time', calls === 2, `calls=${calls}`);
  check('grant is single-use (no pending request remains)', rig.fabric.pendingApprovals().length === 0);
  const audit = rig.fabric.audit().filter((a) => a.outcome === 'succeeded');
  check('the granted execution is audited', audit.length === 1, String(audit.length));
}

/* ══════════════════════════════════════════════════════════════════
   9. no prompt/secrets are persisted by the governance pause
   ══════════════════════════════════════════════════════════════════ */

async function testNoSecretsPersisted() {
  console.log('\n[9] no prompt/secrets are persisted');
  const rig = makeRig();
  rig.execResults['git.push'] = async () => ({ ok: false, detail: 'timed out mid-push', effectStarted: true });
  await rig.fabric.invoke('git.push', {
    branch: 'main',
    apiKey: 'sk-super-secret-123',
    token: 'tok-super-secret-456',
    prompt: 'a long prompt body that must never be persisted anywhere',
  }, ctx());
  const persisted = JSON.stringify(rig.approvals);
  check('no apiKey value persisted', !persisted.includes('sk-super-secret-123'));
  check('no token value persisted', !persisted.includes('tok-super-secret-456'));
  check('no prompt body persisted', !persisted.includes('a long prompt body that must never be persisted'));
  const auditText = JSON.stringify(rig.fabric.audit());
  check('no apiKey value in the audit trail', !auditText.includes('sk-super-secret-123'));
  check('no prompt body in the audit trail', !auditText.includes('a long prompt body that must never be persisted'));
}

/* ══════════════════════════════════════════════════════════════════
   10. structural: no capability id hardcoded; the decision reads the
       descriptor — so future irreversible capabilities inherit it
   ══════════════════════════════════════════════════════════════════ */

function testStructuralScans() {
  console.log('\n[10] structural scans');
  const root = path.resolve(import.meta.dirname, '..');
  const fabricSrc = fs.readFileSync(path.join(root, 'packages/capability-fabric/src/fabric.ts'), 'utf8');

  // The retry logic must key off the descriptor, never off a capability
  // id — a future irreversible capability gets the same gate for free.
  const manifestIds = CAPABILITY_MANIFEST.map((c) => c.id);
  const hardcoded = manifestIds.filter((id) => fabricSrc.includes(`'${id}'`) || fabricSrc.includes(`"${id}"`));
  check('no capability id is hardcoded in fabric.ts retry logic', hardcoded.length === 0, hardcoded.join(', '));
  check('retry decision reads CapabilityDescriptor.irreversible', /\.irreversible\b/.test(fabricSrc));

  // The workflow runtime's retry logic must be equally id-free.
  const wfExecSrc = fs.readFileSync(path.join(root, 'packages/workflow/src/runtime/executors.ts'), 'utf8');
  const bodyOf = (src, name) => {
    const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`, 'm'));
    return m ? m[0] : '';
  };
  const retryLogic = `${bodyOf(wfExecSrc, 'withRetry')}\n${bodyOf(wfExecSrc, 'runRetryNode')}`;
  const irreversibleIds = CAPABILITY_MANIFEST.filter((c) => c.irreversible).map((c) => c.id);
  const hardcodedWf = irreversibleIds.filter((id) => retryLogic.includes(`'${id}'`) || retryLogic.includes(`"${id}"`));
  check('no capability id is hardcoded in workflow retry logic', hardcodedWf.length === 0, hardcodedWf.join(', '));

  // One governed path: the retry decision lives in the Fabric, and the
  // workflow runtime delegates — it never mints its own approval request.
  const wfRuntimeFiles = fs.readdirSync(path.join(root, 'packages/workflow/src/runtime'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => fs.readFileSync(path.join(root, 'packages/workflow/src/runtime', f), 'utf8'))
    .join('\n');
  check('workflow runtime never builds an ApprovalRequest',
    !/\bnew\s+ApprovalRequest\b/.test(wfRuntimeFiles) && !/attachApprovalStore/.test(wfRuntimeFiles));
  check('workflow runtime delegates decisions to the ONE Fabric',
    /decideApproval/.test(wfRuntimeFiles) && !/new\s+ApprovalPersistence/.test(wfRuntimeFiles));

  // No bypass primitives in the retry-governance code.
  const bypass = /child_process|\bspawn\s*\(|\bexecFile\s*\(|\bfork\s*\(|new\s+Function\s*\(|\beval\s*\(/;
  check('fabric.ts has no process/eval bypass primitives', !bypass.test(fabricSrc));
  const retryGov = `${bodyOf(wfExecSrc, 'withRetry')}\n${bodyOf(wfExecSrc, 'runRetryNode')}`;
  check('workflow retry logic has no bypass primitives', !bypass.test(retryGov));
}

/* ══════════════════════════════════════════════════════════════════
   11. NEGATIVE CONTROL — old loop re-executes a started irreversible
       effect; the new implementation executes it once and parks it
   ══════════════════════════════════════════════════════════════════ */

async function testNegativeControl() {
  console.log('\n[11] negative control — the bug this gate exists to prevent');
  // The OLD rule was "transient → retry", with no regard for whether the
  // effect had started. Reconstructed here as the production gate found
  // it: a started irreversible effect + transient timeout → retried.
  const TRANSIENT = /\b(timeout|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|429|503|temporarily)\b/i;
  const oldRetryLoop = (run, maxAttempts = 3) => {
    let attempts = 0;
    let last;
    while (attempts < maxAttempts) {
      attempts += 1;
      last = run();
      if (last.ok) break;
      if (attempts >= maxAttempts || !TRANSIENT.test(last.detail)) break;
    }
    return { attempts, last };
  };
  let oldCalls = 0;
  const startedEffect = () => {
    oldCalls += 1;
    return { ok: false, detail: 'timed out mid-push', effectStarted: true };
  };
  const old = oldRetryLoop(startedEffect);
  check('OLD logic retried the started irreversible effect (bug reproduced)',
    oldCalls >= 2, `calls=${oldCalls}`);

  // The NEW implementation with the identical executor script.
  const rig = makeRig();
  let calls = 0;
  rig.execResults['git.push'] = async () => {
    calls += 1;
    return { ok: false, detail: 'timed out mid-push', effectStarted: true };
  };
  const first = await rig.fabric.invoke('git.push', { branch: 'main' }, ctx());
  check('NEW logic executes the effect exactly once', calls === 1, `calls=${calls}`);
  check('NEW logic parks instead of retrying', first.outcome === 'awaiting-approval', first.outcome);

  // Even after a human grant, it runs exactly once more — and, still
  // failing with an uncertain effect, parks again rather than looping.
  const requestId = rig.fabric.pendingApprovals()[0].id;
  rig.fabric.decideApproval(requestId, true, 'user');
  const second = await rig.fabric.invoke('git.push', { branch: 'main' }, ctx());
  check('after a human grant it executes exactly one more time', calls === 2, `calls=${calls}`);
  check('it parks again instead of auto-retrying the second failure', second.outcome === 'awaiting-approval' && calls === 2, `outcome=${second.outcome} calls=${calls}`);
  check('a second, fresh approval question is asked', rig.fabric.pendingApprovals().length === 1 && rig.fabric.pendingApprovals()[0].id !== requestId);
}

/* ══════════════════════════════════════════════════════════════════
   12. workflow node-level withRetry respects the invariant
   ══════════════════════════════════════════════════════════════════ */

async function testWorkflowWithRetry() {
  console.log('\n[12] workflow withRetry respects the irreversible-effect invariant');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-retry-gov-'));
  const rig = makeRig();
  rig.execResults['git.push'] = async () => ({
    ok: false, detail: 'remote rejected: update is not fast-forward', effectStarted: true,
  });
  const h = workflowHarness(home, rig);
  const wf = DEF('wf-irr-retry', [
    N('t', 'manual'),
    N('c', 'capability', {
      capabilityId: 'git.push',
      inputMap: 'branch: main',
      retry: { maxAttempts: 5, delayMs: 1, backoffFactor: 1 },
    }),
  ], [E('t', 'out', 'c')]);
  h.definitions.record(wf);
  const run = await h.runtime.startRun('wf-irr-retry', { inputs: {}, approvedCapabilities: ['git.push'] });
  check('run failed (no automatic re-run)', run.status === 'failed', run.status);
  check('executor ran exactly once despite retry config', rig.executed['git.push'] === 1, JSON.stringify(rig.executed));
  check('node recorded the failure', run.nodeRuns.find((n) => n.nodeId === 'c')?.status === 'failed');
  fs.rmSync(home, { recursive: true, force: true });
}

/* ══════════════════════════════════════════════════════════════════
   13. the workflow retry control node respects the invariant
   ══════════════════════════════════════════════════════════════════ */

async function testWorkflowRetryNode() {
  console.log('\n[13] workflow retry control node respects the invariant');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-retry-gov-'));
  const rig = makeRig();
  rig.execResults['git.push'] = async () => ({
    ok: false, detail: 'remote rejected: update is not fast-forward', effectStarted: true,
  });
  const h = workflowHarness(home, rig);
  const wf = DEF('wf-retry-node-irr', [
    N('t', 'manual'),
    N('rc', 'retry', { maxAttempts: 3, delayMs: 1, backoffFactor: 1 }),
    N('c', 'capability', { capabilityId: 'git.push', inputMap: 'branch: main' }),
    N('r', 'result'),
  ], [E('t', 'out', 'rc'), E('rc', 'out', 'c'), E('rc', 'failed', 'r')]);
  h.definitions.record(wf);
  const run = await h.runtime.startRun('wf-retry-node-irr', { inputs: {}, approvedCapabilities: ['git.push'] });
  check('retry node did not retry the started effect', rig.executed['git.push'] === 1, JSON.stringify(rig.executed));
  const rc = run.nodeRuns.find((n) => n.nodeId === 'rc');
  check('retry node fired the failed port immediately', rc?.firedPort === 'failed', `port=${rc?.firedPort} status=${rc?.status}`);
  // The retry node routed the failure to its failed port, and the subtree
  // node stayed failed in the record — the run settles failed (pre-existing
  // run-status semantics, unchanged by this fix). What matters for the
  // invariant: the effect was NEVER re-run.
  check('the subtree effect was never re-run', rig.executed['git.push'] === 1, JSON.stringify(rig.executed));
  fs.rmSync(home, { recursive: true, force: true });
}

/* ══════════════════════════════════════════════════════════════════
   14. workflow: park at the Fabric gate → grant → exactly one execution
   ══════════════════════════════════════════════════════════════════ */

async function testWorkflowGrant() {
  console.log('\n[14] workflow grant executes exactly once');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-retry-gov-'));
  const rig = makeRig();
  let calls = 0;
  rig.execResults['git.push'] = async () => {
    calls += 1;
    return calls === 1
      ? { ok: false, detail: 'timed out mid-push', effectStarted: true }
      : { ok: true, effectStarted: true, detail: 'Pushed main to origin.', output: { exitCode: 0 } };
  };
  const h = workflowHarness(home, rig);
  const wf = DEF('wf-irr-gate', [
    N('t', 'manual'),
    N('c', 'capability', { capabilityId: 'git.push', inputMap: 'branch: main' }),
  ], [E('t', 'out', 'c')]);
  h.definitions.record(wf);
  const run = await h.runtime.startRun('wf-irr-gate', { inputs: {}, approvedCapabilities: ['git.push'] });
  check('run parked at the gate', run.status === 'paused', run.status);
  check('executor ran once before parking', calls === 1, String(calls));
  const node = run.nodeRuns.find((n) => n.nodeId === 'c');
  check('node is approval-required', node?.status === 'approval-required', node?.status);
  check('the gate is the Fabric irreversible-retry request',
    rig.fabric.pendingApprovals()[0]?.rule === 'irreversible-retry' && node?.approval?.requestId === rig.fabric.pendingApprovals()[0]?.id);
  const requestId = node?.approval?.requestId;
  h.runtime.decideApproval(requestId, true, 'user', 'go');
  const settled = await until(() => h.runtime.getRun(run.runId)?.status === 'completed');
  check('grant resumes and completes the run', settled, `status=${h.runtime.getRun(run.runId)?.status}`);
  check('granted retry executed exactly one more time', calls === 2, String(calls));
  check('grant consumed (single-use)', rig.fabric.pendingApprovals().length === 0);
  fs.rmSync(home, { recursive: true, force: true });
}

/* ══════════════════════════════════════════════════════════════════
   15. workflow: deny → the executor never runs again
   ══════════════════════════════════════════════════════════════════ */

async function testWorkflowDeny() {
  console.log('\n[15] workflow deny → the executor never runs again');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-retry-gov-'));
  const rig = makeRig();
  let calls = 0;
  rig.execResults['git.push'] = async () => {
    calls += 1;
    return { ok: false, detail: 'timed out mid-push', effectStarted: true };
  };
  const h = workflowHarness(home, rig);
  const wf = DEF('wf-irr-deny', [
    N('t', 'manual'),
    N('c', 'capability', { capabilityId: 'git.push', inputMap: 'branch: main' }),
  ], [E('t', 'out', 'c')]);
  h.definitions.record(wf);
  const run = await h.runtime.startRun('wf-irr-deny', { inputs: {}, approvedCapabilities: ['git.push'] });
  const requestId = run.nodeRuns.find((n) => n.nodeId === 'c')?.approval?.requestId;
  h.runtime.decideApproval(requestId, false, 'user', 'no');
  const settled = await until(() => h.runtime.getRun(run.runId)?.status === 'failed');
  check('denial fails the run', settled, `status=${h.runtime.getRun(run.runId)?.status}`);
  check('node failed deterministically', h.runtime.getRun(run.runId)?.nodeRuns.find((n) => n.nodeId === 'c')?.status === 'failed');
  check('executor never ran again after the parked attempt', calls === 1, String(calls));
  fs.rmSync(home, { recursive: true, force: true });
}

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  console.log('retry-governance-verify — the production-gate retry suite');
  await testReversibleRetries();
  await testIrreversibleProvenNotStartedRetries();
  await testIrreversibleStartedNoRetry();
  await testIrreversibleUnknownNoRetry();
  await testCorrelationIds();
  await testAuditDecision();
  await testDeniedRetry();
  await testGrantedRetry();
  await testNoSecretsPersisted();
  testStructuralScans();
  await testNegativeControl();
  await testWorkflowWithRetry();
  await testWorkflowRetryNode();
  await testWorkflowGrant();
  await testWorkflowDeny();

  console.log(`\nretry-governance-verify: ${passed} passed · ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

await main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
