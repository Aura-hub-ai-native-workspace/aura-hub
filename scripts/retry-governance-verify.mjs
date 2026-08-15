/**
 * retry-governance-verify — the two findings the P1-5 real-agent run
 * exposed.
 * ==================================================================
 * FIX 1  Audit context attribution.
 *   The real run proved a canonical prompt reached OpenCode, but the
 *   audit record could not say so — `contextInjected` existed only on the
 *   executor's result. Diagnosing a bad delegation after the fact could
 *   not answer "did it run briefed or bare?".
 *
 * FIX 2  Irreversible retry governance.
 *   The same run showed `attempts: 2`: the recovery loop automatically
 *   re-ran an irreversible, approval-gated capability after a transient
 *   failure. It was harmless there only because attempt 1 did no work. A
 *   transient error says the TRANSPORT failed; it never proves the EFFECT
 *   did not happen. A delegated agent that times out is precisely the case
 *   where the repository may already be half-rewritten.
 *
 * Both are driven against the REAL CapabilityFabric with stub executors,
 * so the governed pipeline — policy, approval, audit — is the real one.
 *
 * Usage: node scripts/retry-governance-verify.mjs
 * Needs no service, no browser and no agent.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

const out = path.join(mkdtempSync(path.join(tmpdir(), 'retry-gov-')), 'fabric.mjs');
execFileSync('npx', [
  'esbuild', `${ROOT}/packages/capability-fabric/src/index.ts`,
  '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`,
], { cwd: ROOT, stdio: 'pipe' });

const { CapabilityFabric } = await import(out);

/* ── a host that grants inline, so the gate is exercised not bypassed ── */
const makeHost = () => ({
  permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: false }),
  nodeAvailable: () => null,
  requestApproval: async (_req, ctx) => (ctx.approvedCapabilities ?? []).includes(_req.items[0].capabilityId),
});

/**
 * Register a synthetic capability so the rule is exercised through
 * METADATA (`irreversible`) rather than a capability id. If the Fabric
 * ever special-cased `agent.delegate`, these would not behave.
 */
function fabricWith(capability, executor) {
  const f = new CapabilityFabric(makeHost());
  f.describeCapability = undefined;
  f.register(executor);
  return f;
}

/* The Fabric resolves descriptors from its manifest, so exercise the real
   manifest entries: `terminal.execute` (reversible) and `agent.delegate`
   (irreversible). The metadata — not the id — is what the rule reads. */
const TRANSIENT = 'The request timed out.';

/** An executor that fails N times then succeeds, recording every call. */
function countingExecutor(capabilityId, failures, opts = {}) {
  const calls = [];
  return {
    executor: {
      capabilityId,
      async run(inv) {
        calls.push(inv.id);
        if (calls.length <= failures) {
          return { ok: false, detail: TRANSIENT, ...(opts.effectStarted !== undefined ? { effectStarted: opts.effectStarted } : {}) };
        }
        return { ok: true, detail: 'done', output: { contextInjected: opts.contextInjected === true, nodeId: 'stub' } };
      },
    },
    calls,
  };
}

const ctx = (extra = {}) => ({
  actor: { kind: 'human', id: 'test' },
  projectId: 'p1',
  cwd: '/tmp',
  missionId: 'm1',
  taskId: 't1',
  approvedCapabilities: ['agent.delegate', 'terminal.execute'],
  ...extra,
});

/* ══════════════════════════════════════════════════════════════════
   FIX 2 — retry governance
   ══════════════════════════════════════════════════════════════════ */

/* ── 1. reversible + transient → retry allowed ────────────────────── */
{
  const { executor, calls } = countingExecutor('terminal.execute', 1);
  const f = fabricWith(null, executor);
  const r = await f.invoke('terminal.execute', { command: 'ls' }, ctx());
  check('1. a REVERSIBLE capability is retried after a transient failure',
    calls.length === 2 && r.outcome === 'succeeded',
    `attempts=${r.attempts} calls=${calls.length} outcome=${r.outcome}`);
}

/* ── 2. irreversible + transient + PROVEN not started → retry ─────── */
{
  const { executor, calls } = countingExecutor('agent.delegate', 1, { effectStarted: false });
  const f = fabricWith(null, executor);
  const r = await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx());
  check('2. an IRREVERSIBLE capability retries only when proven not started',
    calls.length === 2 && r.outcome === 'succeeded',
    `calls=${calls.length} outcome=${r.outcome}`);
}

/* ── 3. irreversible + transient AFTER execution → NO retry ───────── */
{
  const { executor, calls } = countingExecutor('agent.delegate', 99, { effectStarted: true });
  const f = fabricWith(null, executor);
  const r = await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx());
  check('3. THE FINDING — an irreversible effect that STARTED is not retried',
    calls.length === 1, `calls=${calls.length}`);
  check('3b. it becomes an explicit governed state, not a plain failure',
    r.outcome === 'awaiting-approval', `outcome=${r.outcome}`);
  check('3c. and says why, in the operator\'s terms',
    /may already have taken effect/i.test(r.detail), r.detail.slice(0, 120));
}

/* ── 4. irreversible + transient + UNKNOWN state → NO retry ───────── */
{
  const { executor, calls } = countingExecutor('agent.delegate', 99); // no effectStarted
  const f = fabricWith(null, executor);
  const r = await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx());
  check('4. UNKNOWN execution state is treated as started, so no retry',
    calls.length === 1 && r.outcome === 'awaiting-approval',
    `calls=${calls.length} outcome=${r.outcome}`);
}

/* ── 5. a new approval can explicitly authorize another attempt ───── */
{
  const { executor, calls } = countingExecutor('agent.delegate', 1, { effectStarted: true });
  const f = fabricWith(null, executor);

  const first = await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx());
  check('5a. the first attempt stops for a decision',
    first.outcome === 'awaiting-approval' && calls.length === 1);

  const pending = f.pendingApprovals().filter((a) => a.id.startsWith('apr-retry-'));
  check('5b. a retry approval is recorded through the existing approval store',
    pending.length === 1 && pending[0].rule === 'irreversible-retry',
    pending.length ? `${pending[0].id} rule=${pending[0].rule}` : 'none');
  check('5c. the request states the real consequence of saying yes',
    /repeat or compound/i.test(pending[0]?.onAccept ?? ''), pending[0]?.onAccept?.slice(0, 90));

  // Re-invoking with a grant is what authorizes another attempt.
  const second = await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx());
  check('5d. an explicitly authorized re-invocation does run again',
    calls.length === 2 && second.outcome === 'succeeded',
    `calls=${calls.length} outcome=${second.outcome}`);
}

/* ── 6. a denied retry does not execute again ─────────────────────── */
{
  const { executor, calls } = countingExecutor('agent.delegate', 99, { effectStarted: true });
  const f = fabricWith(null, executor);
  await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx());
  const after = calls.length;
  // No grant this time — the gate refuses before the executor is reached.
  const denied = await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx({ approvedCapabilities: [] }));
  check('6. a DENIED retry never reaches the executor',
    calls.length === after && denied.outcome === 'awaiting-approval',
    `calls=${calls.length} outcome=${denied.outcome}`);
}

/* ── 7. every invocation is still audited ─────────────────────────── */
{
  const { executor } = countingExecutor('agent.delegate', 99, { effectStarted: true });
  const f = fabricWith(null, executor);
  await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx());
  const audit = f.audit();
  check('7. the withheld-retry invocation is audited', audit.length === 1);
  const a = audit[0];
  check('7b. with its correlation ids intact',
    a.invocationId && a.capabilityId === 'agent.delegate' && a.missionId === 'm1' && a.taskId === 't1'
    && a.actor?.id === 'test' && a.outcome === 'awaiting-approval',
    `outcome=${a.outcome}`);
}

/* ── 8. NEGATIVE CONTROL — the old rule would have re-run it ──────── */
{
  // The removed rule: retry on ANY transient failure, regardless of
  // whether the irreversible effect had begun.
  const legacyMayRetry = (detail) => /\b(timeout|timed out|429|503)\b/i.test(detail);

  let legacyCalls = 0;
  let attempts = 0;
  const MAX = 3;
  while (attempts < MAX) {
    attempts += 1;
    legacyCalls += 1;
    const res = { ok: false, detail: TRANSIENT, effectStarted: true };
    if (res.ok) break;
    if (attempts >= MAX || !legacyMayRetry(res.detail)) break;
  }
  check('8. NEGATIVE CONTROL — the old rule re-runs an irreversible effect',
    legacyCalls === 3,
    `the approved-once action would have executed ${legacyCalls} times`);
}

/* ══════════════════════════════════════════════════════════════════
   FIX 1 — audit context attribution
   ══════════════════════════════════════════════════════════════════ */

/* ── A. agent WITH context → audit.contextInjected === true ───────── */
{
  const { executor } = countingExecutor('agent.delegate', 0, { contextInjected: true });
  const f = fabricWith(null, executor);
  const r = await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx());
  const a = f.audit()[0];
  check('A. an agent that received context is audited as contextInjected=true',
    a.contextInjected === true && r.outcome === 'succeeded',
    `contextInjected=${a.contextInjected}`);
}

/* ── B. agent WITHOUT context → false ─────────────────────────────── */
{
  const { executor } = countingExecutor('agent.delegate', 0, { contextInjected: false });
  const f = fabricWith(null, executor);
  await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx());
  const a = f.audit()[0];
  check('B. an agent that ran bare is audited as contextInjected=false',
    a.contextInjected === false, `contextInjected=${a.contextInjected}`);
}

/* ── B2. nothing ran → undefined, never a misleading false ────────── */
{
  const { executor } = countingExecutor('agent.delegate', 0, { contextInjected: true });
  const f = fabricWith(null, executor);
  await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx({ approvedCapabilities: [] }));
  const a = f.audit()[0];
  check('B2. an invocation that never executed reports no attribution at all',
    a.contextInjected === undefined && a.outcome === 'awaiting-approval',
    `contextInjected=${a.contextInjected}`);
}

/* ── C. the audit never carries the prompt ────────────────────────── */
{
  const bigPrompt = 'X'.repeat(5000);
  const executor = {
    capabilityId: 'agent.delegate',
    async run() { return { ok: true, detail: 'done', output: { contextInjected: true, nodeId: 'stub' } }; },
  };
  const f = fabricWith(null, executor);
  await f.invoke('agent.delegate', { agent: 'opencode', task: 'x', auraPrompt: bigPrompt }, ctx());
  const blob = JSON.stringify(f.audit()[0]);
  check('C. the full prompt is NOT persisted in the audit record',
    !blob.includes(bigPrompt) && !blob.includes('XXXXXXXXXX'),
    `record is ${blob.length} bytes`);
  check('C2. and the record stays small enough to read',
    blob.length < 2000, `${blob.length} bytes`);
}

/* ── D. the rest of the audit contract is unchanged ───────────────── */
{
  const { executor } = countingExecutor('agent.delegate', 0, { contextInjected: true });
  const f = fabricWith(null, executor);
  await f.invoke('agent.delegate', { agent: 'opencode', task: 'x' }, ctx());
  const a = f.audit()[0];
  const required = ['invocationId', 'capabilityId', 'actor', 'missionId', 'taskId', 'outcome', 'verified', 'durationMs', 'risk', 'decision', 'decisionRule'];
  const missing = required.filter((k) => a[k] === undefined);
  check('D. every existing audit field survives', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : required.join(', '));
  check('D2. verification is still recorded', a.verified !== undefined);
}

/* ── E. the rule is metadata-driven, not id-driven ────────────────── */
{
  const src = (await import('node:fs')).readFileSync(path.join(ROOT, 'packages/capability-fabric/src/fabric.ts'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check('E. no capability id is special-cased in the retry rule',
    !stripped.includes("'agent.delegate'") && !stripped.includes('"agent.delegate"'));
  check('E2. the decision reads capability metadata',
    stripped.includes('capability.irreversible'));
}

console.log(failed ? '\nFAILED' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
