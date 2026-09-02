/**
 * agent-failure-recovery-test — the outcomes that must never lie.
 * ==================================================================
 * Success is the easy case. This covers the seven ways delegation can end
 * and asserts the one rule that matters:
 *
 *   AURA must never report "completed" for a process that timed out,
 *   exited non-zero, was refused, or could not be verified.
 *
 *   A  successful execution
 *   B  timeout
 *   C  non-zero exit
 *   D  invalid / unknown agent
 *   E  denied approval
 *   F  granted approval
 *   G  verification failure
 *
 * Everything runs against a disposable project with the REAL OpenCode CLI.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const API = process.env.HUB_API ?? 'http://localhost:4319';
const S = '/tmp/claude-1000/-home-Groot-aura-hub/615b7fbc-bd62-488e-a4fb-ca66447d02b9/scratchpad';
const PROJECT = 'hub-exec-test';
const PROJECT_PATH = `${S}/hub-exec-test`;
const AURA_REPO = '/home/Groot/aura-hub';

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const info = (m) => console.log(`      ${m}`);
const api = async (p) => (await fetch(`${API}${p}`)).json();
const post = async (p, body) =>
  (await fetch(`${API}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();


/**
 * Authorize the way a human does: ask, answer, resume.
 *
 * `/fabric/invoke` no longer accepts a grant in the request body — that
 * made every floor self-satisfiable by any local caller. The real path is
 * the one the UI takes: the invocation parks with an `approvalId`, a
 * person answers it through `/fabric/approvals/:id/decide`, and the
 * caller resumes by naming that approval. The grant is still single-use
 * and still matched against this capability, so this simulates the human
 * rather than routing around them.
 */
const approveAndRun = async (body) => {
  const parked = await post('/fabric/invoke', body);
  if (parked.outcome !== 'awaiting-approval' || !parked.approvalId) return parked;
  await post(`/fabric/approvals/${parked.approvalId}/decide`, { granted: true });
  return post('/fabric/invoke', {
    ...body,
    context: { ...(body.context ?? {}), resumeApprovalId: parked.approvalId },
  });
};

const invoke = (input, { approve = false, context = {} } = {}) => {
  const body = {
    capabilityId: 'agent.delegate',
    input,
    context: { projectId: PROJECT, ...context },
  };
  return approve ? approveAndRun(body) : post('/fabric/invoke', body);
};

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/**
 * The AURA repo's state, ignoring `graphify-out/`.
 *
 * AURA indexes whichever project is open and rewrites that directory on
 * its own — during this very run. Including it would make the check fail
 * on AURA's own housekeeping instead of on what it is actually asking:
 * did the delegated agent escape its project?
 */
const auraState = () =>
  git(AURA_REPO, 'status', '--porcelain')
    .split('\n').filter((l) => l && !l.includes('graphify-out/')).sort().join('\n');

/** The single rule: nothing that failed may read as success. */
const claimsSuccess = (r) =>
  r.outcome === 'succeeded' || /completed\.?$/i.test(String(r.detail ?? '').trim());

try {
  fs.rmSync(PROJECT_PATH, { recursive: true, force: true });
  fs.mkdirSync(`${PROJECT_PATH}/src`, { recursive: true });
  fs.writeFileSync(`${PROJECT_PATH}/README.md`, '# hub-exec-test\n\nDisposable.\n');
  fs.writeFileSync(`${PROJECT_PATH}/src/calc.js`, 'export function add(a,b){return a+b}\n');
  git(PROJECT_PATH, 'init', '-q');
  git(PROJECT_PATH, 'add', '-A');
  git(PROJECT_PATH, '-c', 'user.email=t@l', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const auraBefore = auraState();
  await post('/environment/scan', {});

  /* ── E. denied approval ───────────────────────────────────────── */
  const gated = await invoke({ task: 'must not run', nodeId: 'opencode' },
    { context: { missionId: 'm-fail', taskId: 't-deny' } });
  check('E1. an unapproved run is parked, not executed',
    gated.outcome === 'awaiting-approval' && gated.attempts === 0,
    `outcome=${gated.outcome} attempts=${gated.attempts}`);
  const pending = ((await api('/fabric/approvals')).approvals ?? [])
    .find((a) => a.taskId === 't-deny' && a.state === 'pending');
  check('E2. an approval request exists for that task', !!pending, pending?.id);

  if (pending) {
    const decided = await post(`/fabric/approvals/${pending.id}/decide`, { granted: false, reason: 'test denial' });
    const after = ((await api('/fabric/approvals')).approvals ?? []).find((a) => a.id === pending.id);
    check('E3. denying it records a refusal and runs nothing',
      (after?.state === 'denied' || decided.declined === true) && !claimsSuccess(decided),
      `state=${after?.state} declined=${decided.declined}`);
  }
  const cleanAfterDeny = git(PROJECT_PATH, 'status', '--porcelain');
  check('E4. the project is untouched after a denial', cleanAfterDeny === '', `git="${cleanAfterDeny}"`);

  /* ── D. invalid / unknown agent ───────────────────────────────── */
  const unknown = await invoke({ task: 'x', nodeId: 'not-a-real-agent' }, { approve: true });
  // Since §22 this is refused during ROUTING — `denied` before anything is
  // attempted — rather than failing inside the executor. Stronger, and the
  // assertion follows the behaviour rather than the other way round.
  check('D. an unknown agent is refused before execution and runs nothing',
    unknown.outcome === 'denied' && !claimsSuccess(unknown)
    && (unknown.attempts ?? 0) === 0 && /is not a connected node/.test(unknown.detail),
    `outcome=${unknown.outcome} attempts=${unknown.attempts} · ${String(unknown.detail).slice(0, 60)}`);

  /* ── B. timeout ───────────────────────────────────────────────── */
  info('B. forcing a timeout (2s deadline on a real agent run)…');
  const timedOut = await invoke(
    { task: 'Refactor every file in this project and write extensive documentation.', nodeId: 'opencode' },
    { approve: true, context: { timeoutMs: 2000 } },
  );
  check('B1. a timed-out agent is NOT reported as completed',
    !claimsSuccess(timedOut) && timedOut.outcome === 'failed',
    `outcome=${timedOut.outcome}`);
  check('B2. the timeout is named as a timeout, with exit 124',
    timedOut.output?.exitCode === 124 && timedOut.output?.timedOut === true
    && /ran out of time/i.test(timedOut.detail),
    `exitCode=${timedOut.output?.exitCode} timedOut=${timedOut.output?.timedOut}`);
  // A failed run is never VERIFIED. It reports `null` rather than `false`
  // because no check was run — the executor failed before verification.
  // Conflating "not checked" with "checked and failed" would itself be a
  // small lie, so the assertion is the one that matters: never `true`.
  check('B3. a timed-out run is never reported as verified',
    timedOut.verification?.passed !== true,
    `verification=${timedOut.verification?.kind}/${timedOut.verification?.passed}`);
  check('B4. the node is still attributable after a timeout',
    timedOut.output?.nodeId === 'opencode', `nodeId=${timedOut.output?.nodeId}`);

  /* ── C + G. non-zero exit → failure and failed verification ───── */
  info('C. forcing a non-zero exit (invalid model)…');
  const nonZero = await invoke(
    { task: 'say hi', nodeId: 'opencode', model: 'nope/does-not-exist' },
    { approve: true, context: { timeoutMs: 120000 } },
  );
  check('C1. a non-zero exit is a failure, never "completed"',
    !claimsSuccess(nonZero) && nonZero.outcome === 'failed', `outcome=${nonZero.outcome}`);
  check('C2. the real exit code is reported, not 0',
    typeof nonZero.output?.exitCode === 'number' && nonZero.output.exitCode !== 0
    && nonZero.output.timedOut === false,
    `exitCode=${nonZero.output?.exitCode} timedOut=${nonZero.output?.timedOut}`);
  check('G. a failed process is never reported as verified',
    nonZero.verification?.passed !== true,
    `verification=${nonZero.verification?.kind}/${nonZero.verification?.passed}`);

  /* ── A + F. approved, successful execution ────────────────────── */
  info('A/F. real approved execution…');
  const good = await invoke(
    { task: 'Add a JSDoc comment above the add function in src/calc.js. Change nothing else.', nodeId: 'opencode' },
    { approve: true, context: { timeoutMs: 600000, missionId: 'm-fail', taskId: 't-ok' } },
  );
  check('A/F1. an approved run executes and succeeds', good.outcome === 'succeeded', good.detail);
  check('A/F2. exit 0 with captured stdout',
    good.output?.exitCode === 0 && (good.output?.stdout ?? '').length > 0
    && good.output?.timedOut === false,
    `exitCode=${good.output?.exitCode} stdout=${good.output?.stdout?.length} chars`);
  check('A/F3. verification passes', good.verification?.passed === true);
  check('A/F4. attributed to OpenCode', good.output?.nodeId === 'opencode');
  const dirty = git(PROJECT_PATH, 'status', '--porcelain');
  check('A/F5. the disposable project really changed', dirty.includes('src/calc.js'), `git="${dirty}"`);

  /* ── the overarching rule ─────────────────────────────────────── */
  const failures = { B: timedOut, C: nonZero, D: unknown, E: gated };
  const liars = Object.entries(failures).filter(([, r]) => claimsSuccess(r)).map(([k]) => k);
  check('RULE. no failed/timed-out/denied run ever claims completion',
    liars.length === 0, liars.length ? `LIED: ${liars.join(', ')}` : 'all four reported honestly');

  /* ── audit completeness ───────────────────────────────────────── */
  const audit = (await api('/fabric/audit')).audit ?? [];
  const mine = audit.filter((a) => a.capabilityId === 'agent.delegate');
  const withNode = mine.filter((a) => a.nodeId);
  const sample = mine[mine.length - 1];
  check('AUDIT1. delegations are audited with actor, decision, rule, mission and task',
    mine.length > 0 && !!sample?.decisionRule && !!sample?.decision
    && !!sample?.actor?.kind && !!sample?.missionId && !!sample?.taskId,
    `${mine.length} record(s); actor=${sample?.actor?.kind} decision=${sample?.decision} rule=${sample?.decisionRule} mission=${sample?.missionId} task=${sample?.taskId}`);
  check('AUDIT2. nodeId is recorded where the executor named one',
    withNode.length > 0, `${withNode.length}/${mine.length} carry nodeId`);
  const secrets = JSON.stringify(audit).match(/sk-[A-Za-z0-9]{8,}|api[_-]?key["':\s]+[A-Za-z0-9]{12,}/gi);
  check('AUDIT3. no secrets appear in the audit log', !secrets, secrets ? 'FOUND SECRETS' : 'none found');

  /* ── the repository is untouched ──────────────────────────────── */
  check('SAFE. the delegated agent never touched the AURA repository',
    auraState() === auraBefore, 'source tree identical before/after (graphify index excluded — AURA rewrites it itself)');
} catch (e) {
  console.log(`ERROR ${e.message.split('\n')[0]}`);
  failed = true;
} finally {
  console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}
