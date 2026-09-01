/**
 * node-policy-verify — per-node governance (§23).
 * ==================================================================
 * Proves node identity is an input to the EXISTING policy engine, and —
 * more importantly — that it can only ever restrict.
 *
 * The load-bearing claim is negative: a node rule saying "OpenCode is
 * allowed" must NOT mean "OpenCode may skip approval". The engine is
 * escalate-only (§23.1), so an allow contributes no relaxation. Several
 * checks below exist specifically to catch a regression that made node
 * policy a fast path.
 *
 * Policy is mutated through the real `POST /fabric/policy` route and
 * restored afterwards. Real OpenCode, disposable project.
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

const invoke = (capabilityId, input, { nodeId, approve = false, context = {} } = {}) => {
  const body = {
    capabilityId, input,
    context: { projectId: PROJECT, ...(nodeId ? { nodeId } : {}), ...context },
  };
  return approve ? approveAndRun(body) : post('/fabric/invoke', body);
};

const setPolicy = (patch) => post('/fabric/policy', patch);
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const auraState = () =>
  git(AURA_REPO, 'status', '--porcelain')
    .split('\n').filter((l) => l && !l.includes('graphify-out/')).sort().join('\n');
const ranNothing = (r) => r.outcome !== 'succeeded' && (r.attempts ?? 0) === 0;

let original = null;

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

  original = (await api('/fabric/capabilities')).policy;
  info(`policy before: byRisk.high=${original.byRisk.high} allowAutonomous=${original.allowAutonomous}`);

  /* ── A. explicitly allowed → still gated, still executes ─────── */
  await setPolicy({ nodeOverrides: { 'agent.delegate@opencode': 'auto-execute' } });
  const aGate = await invoke('agent.delegate', { task: 'must still be gated' }, { nodeId: 'opencode' });
  check('A1. an explicit node ALLOW does not skip approval',
    aGate.outcome === 'awaiting-approval' && aGate.policy?.rule === 'irreversible-floor',
    `outcome=${aGate.outcome} rule=${aGate.policy?.rule}`);

  info('A2. real execution after approval…');
  const aRun = await invoke(
    'agent.delegate',
    { task: 'Add a JSDoc comment above the add function in src/calc.js. Change nothing else.' },
    { nodeId: 'opencode', approve: true, context: { timeoutMs: 600000, missionId: 'm-pol', taskId: 't-a' } },
  );
  check('A2. an allowed node executes for real after approval',
    aRun.outcome === 'succeeded' && aRun.output?.nodeId === 'opencode',
    `${aRun.detail}`);
  check('A3. the disposable project really changed',
    git(PROJECT_PATH, 'status', '--porcelain').includes('src/calc.js'));

  /* ── B. explicitly denied → refused before execution ─────────── */
  await setPolicy({ nodeOverrides: { 'agent.delegate@opencode': 'deny' } });
  const cleanBefore = git(PROJECT_PATH, 'status', '--porcelain');
  const b = await invoke('agent.delegate', { task: 'must not run' },
    { nodeId: 'opencode', approve: true, context: { timeoutMs: 600000 } });
  check('B1. an explicitly denied node is refused',
    b.outcome === 'denied' && ranNothing(b), `outcome=${b.outcome} attempts=${b.attempts}`);
  check('B2. the denial names the node rule',
    b.policy?.rule === 'node-override:agent.delegate@opencode', `rule=${b.policy?.rule}`);
  check('B3. the reason explains why, in plain language',
    /OpenCode is not permitted/i.test(b.policy?.reason ?? ''), `"${b.policy?.reason}"`);
  check('B4. the project is unchanged by a denied call',
    git(PROJECT_PATH, 'status', '--porcelain') === cleanBefore);
  check('L. a denied execution produces no node activity',
    !b.output?.nodeId, `output.nodeId=${b.output?.nodeId ?? 'none'}`);

  /* ── E. capability allowed, node denied → denied ─────────────── */
  await setPolicy({ overrides: { 'agent.delegate': 'auto-execute' }, nodeOverrides: { 'agent.delegate@opencode': 'deny' } });
  const e = await invoke('agent.delegate', { task: 'x' }, { nodeId: 'opencode', approve: true });
  check('E. capability permissive + node denied → denied',
    e.outcome === 'denied' && ranNothing(e), `outcome=${e.outcome} rule=${e.policy?.rule}`);

  /* ── F. node allowed, capability denied → denied ─────────────── */
  await setPolicy({ overrides: { 'agent.delegate': 'deny' }, nodeOverrides: { 'agent.delegate@opencode': 'auto-execute' } });
  const f = await invoke('agent.delegate', { task: 'x' }, { nodeId: 'opencode', approve: true });
  check('F. node permissive + capability denied → denied',
    f.outcome === 'denied' && ranNothing(f), `outcome=${f.outcome} rule=${f.policy?.rule}`);

  /* ── H. irreversible floor cannot be bypassed ────────────────── */
  await setPolicy({
    overrides: { 'agent.delegate': 'auto-execute' },
    nodeOverrides: { 'agent.delegate@opencode': 'auto-execute', '@opencode': 'auto-execute' },
    nodeAllowlists: { 'agent.delegate': ['opencode'] },
    allowAutonomous: true,
  });
  const h = await invoke('agent.delegate', { task: 'must still be gated' }, { nodeId: 'opencode' });
  check('H. the irreversible floor survives every permissive setting',
    h.outcome === 'awaiting-approval' && h.policy?.rule === 'irreversible-floor' && h.attempts === 0,
    `outcome=${h.outcome} rule=${h.policy?.rule}`);

  /* ── G. approval still required for a high-risk allowed node ─── */
  check('G. an allowed high-risk node still requires approval',
    h.policy?.decision === 'require-approval' && h.policy?.risk === 'high',
    `decision=${h.policy?.decision} risk=${h.policy?.risk}`);

  /* ── node-wide rule applies across capabilities ──────────────── */
  await setPolicy({ overrides: {}, nodeOverrides: { '@git': 'deny' }, nodeAllowlists: {} });
  const nodeWide = await invoke('git.status', {}, { nodeId: 'git' });
  check('N. a node-wide rule applies to every capability on that node',
    nodeWide.outcome === 'denied' && nodeWide.policy?.rule === 'node-override:@git',
    `outcome=${nodeWide.outcome} rule=${nodeWide.policy?.rule}`);

  /* ── more specific beats broader (in the escalating direction) ─ */
  await setPolicy({ nodeOverrides: { '@git': 'ask-user', 'git.status@git': 'deny' } });
  const specific = await invoke('git.status', {}, { nodeId: 'git' });
  check('O. the more specific node rule wins when it is stricter',
    specific.outcome === 'denied' && specific.policy?.rule === 'node-override:git.status@git',
    `rule=${specific.policy?.rule}`);

  /* ── allowlist: unknown/untrusted node denied ────────────────── */
  await setPolicy({ nodeOverrides: {}, nodeAllowlists: { 'git.status': ['definitely-not-git'] } });
  const notListed = await invoke('git.status', {}, { nodeId: 'git' });
  check('C. a node outside the allowlist is denied',
    notListed.outcome === 'denied' && notListed.policy?.rule === 'node-not-allowlisted:git.status',
    `rule=${notListed.policy?.rule}`);
  check('C2. the allowlist denial explains itself',
    /not on the list/i.test(notListed.policy?.reason ?? ''), `"${notListed.policy?.reason}"`);

  await setPolicy({ nodeAllowlists: { 'git.status': ['git'] } });
  const listed = await invoke('git.status', {}, { nodeId: 'git' });
  check('C3. a node on the allowlist proceeds normally',
    listed.outcome === 'succeeded', `outcome=${listed.outcome}`);

  /* ── D. node without the capability (routing, before policy) ─── */
  const d = await invoke('git.status', {}, { nodeId: 'opencode' });
  check('D. a node lacking the capability is still refused by routing',
    d.outcome === 'denied' && d.policy?.rule === 'node-lacks-capability', `rule=${d.policy?.rule}`);

  /* ── I. rules apply only to the selected node ────────────────── */
  await setPolicy({ nodeAllowlists: {}, nodeOverrides: { 'agent.delegate@cursor': 'deny' } });
  const i = await invoke('agent.delegate', { task: 'must still be gated' }, { nodeId: 'opencode' });
  check('I. a rule against another agent does not affect OpenCode',
    i.outcome === 'awaiting-approval' && i.policy?.rule === 'irreversible-floor',
    `outcome=${i.outcome} rule=${i.policy?.rule}`);

  /* ── J. no node selected → unchanged behaviour ───────────────── */
  await setPolicy({ nodeOverrides: {}, nodeAllowlists: {}, overrides: {} });
  const j = await invoke('agent.delegate', { task: 'must still be gated' });
  check('J. with no node requested, behaviour is unchanged',
    j.outcome === 'awaiting-approval' && j.policy?.rule === 'irreversible-floor',
    `outcome=${j.outcome} rule=${j.policy?.rule}`);
  const jTerm = await invoke('terminal.execute', { command: 'node --version' });
  check('J2. node-free capabilities are unaffected', jTerm.outcome === 'succeeded', `outcome=${jTerm.outcome}`);

  /* ── K + M. audit and attribution ────────────────────────────── */
  const audit = (await api('/fabric/audit')).audit ?? [];
  // The EXECUTION record, not the first record for this task.
  //
  // A real approval leaves two entries behind: the invocation that parked
  // asking the question, and the one that ran after it was answered. That
  // is a fuller trail than the single entry a body-supplied grant used to
  // leave, and `find` would take the parked one — which by design carries
  // no `executedNodeId`, because nothing executed.
  const ok = audit
    .filter((r) => r.taskId === 't-a' && r.capabilityId === 'agent.delegate')
    .find((r) => r.outcome !== 'awaiting-approval');
  const denied = audit.find((r) => r.decisionRule === 'node-override:agent.delegate@opencode');
  check('K1. audit records capability, nodes, decision, rule, actor, mission/task',
    !!ok && ok.requestedNodeId === 'opencode' && ok.executedNodeId === 'opencode'
    && !!ok.decision && !!ok.decisionRule && !!ok.actor?.kind && ok.missionId === 'm-pol',
    ok ? `requested=${ok.requestedNodeId} executed=${ok.executedNodeId} rule=${ok.decisionRule} actor=${ok.actor?.kind}` : 'missing');
  check('K2. a node-denied call is audited with the node rule and no execution',
    !!denied && denied.requestedNodeId === 'opencode' && !denied.executedNodeId,
    denied ? `requested=${denied.requestedNodeId} executed=${denied.executedNodeId ?? 'none'}` : 'missing');
  check('M. an approved execution is attributed to exactly the executed node',
    ok?.executedNodeId === 'opencode' && aRun.output?.nodeId === 'opencode');

  // `\b` before `sk-` matters: without it this matches the tail of every
  // `task-<id>` in the log ("ta|sk-msnz8gfr") and reports a leak that is
  // really just an identifier. A key never appears mid-word like that.
  const secrets = JSON.stringify(audit).match(/\bsk-[A-Za-z0-9]{8,}|api[_-]?key["':\s]+[A-Za-z0-9]{12,}/gi);
  check('K3. no secrets or policy internals leak into audit reasons', !secrets, secrets ? `FOUND ${secrets.join(',')}` : 'none');

  /* ── safety ──────────────────────────────────────────────────── */
  check('SAFE. the AURA repository is untouched throughout',
    auraState() === auraBefore, 'source tree identical (graphify index excluded)');
} catch (e) {
  console.log(`ERROR ${e.message.split('\n')[0]}`);
  failed = true;
} finally {
  if (original) {
    // Leave the machine as we found it — this suite edits real policy.
    await setPolicy({
      byRisk: original.byRisk,
      overrides: original.overrides ?? {},
      nodeOverrides: {},
      nodeAllowlists: {},
      allowAutonomous: original.allowAutonomous,
    }).catch(() => {});
    const restored = (await api('/fabric/capabilities')).policy;
    console.log(`      policy restored: byRisk.high=${restored.byRisk.high} nodeOverrides=${JSON.stringify(restored.nodeOverrides ?? {})}`);
  }
  console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}
