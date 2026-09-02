/**
 * node-routing-verify — first-class node routing (§22).
 * ==================================================================
 * Proves that node selection now happens in the governed contract rather
 * than inside an executor, and that routing can only ever *narrow* what
 * runs — never substitute, never bypass a gate.
 *
 * The negative cases carry the weight: an unknown node, a disconnected
 * node, a node without the capability, and a connected node whose CLI has
 * no verified invocation must all be refused BEFORE anything executes.
 *
 * Real service, real catalogue, real OpenCode for the execution case.
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

/** `nodeId` goes on the CONTEXT — it is routing intent, not an argument. */

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
    capabilityId,
    input,
    context: { projectId: PROJECT, ...(nodeId ? { nodeId } : {}), ...context },
  };
  return approve ? approveAndRun(body) : post('/fabric/invoke', body);
};

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const auraState = () =>
  git(AURA_REPO, 'status', '--porcelain')
    .split('\n').filter((l) => l && !l.includes('graphify-out/')).sort().join('\n');

/** Nothing that was refused may have run. */
const ranNothing = (r) => r.outcome !== 'succeeded' && (r.attempts ?? 0) === 0;

try {
  fs.rmSync(PROJECT_PATH, { recursive: true, force: true });
  fs.mkdirSync(`${PROJECT_PATH}/src`, { recursive: true });
  fs.writeFileSync(`${PROJECT_PATH}/README.md`, '# hub-exec-test\n\nDisposable.\n');
  fs.writeFileSync(`${PROJECT_PATH}/src/calc.js`, 'export function add(a,b){return a+b}\n');
  git(PROJECT_PATH, 'init', '-q');
  git(PROJECT_PATH, 'add', '-A');
  git(PROJECT_PATH, '-c', 'user.email=t@l', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const auraBefore = auraState();

  const scan = await post('/environment/scan', {});
  const catalogue = (await api('/environment/catalog')).catalog;
  const agents = catalogue.filter((e) => (e.capabilities ?? []).includes('coding-agent')).map((e) => e.id);
  const presentAgents = agents.filter((id) => scan.results?.[id]?.present);
  info(`coding-agent nodes in catalogue: ${agents.join(', ')}`);
  info(`…of which present on this machine: ${presentAgents.join(', ') || '(none)'}`);

  /* ── A. explicit selection executes that node ─────────────────── */
  info('A. explicit OpenCode selection, real execution…');
  const a = await invoke(
    'agent.delegate',
    { task: 'Add a JSDoc comment above the add function in src/calc.js. Change nothing else.' },
    { nodeId: 'opencode', approve: true, context: { timeoutMs: 600000, missionId: 'm-route', taskId: 't-a' } },
  );
  check('A1. explicitly selected OpenCode executes', a.outcome === 'succeeded', a.detail);
  check('A2. the executed node is OpenCode', a.output?.nodeId === 'opencode', `nodeId=${a.output?.nodeId}`);
  check('A3. real exit code and stdout captured',
    a.output?.exitCode === 0 && (a.output?.stdout ?? '').length > 0,
    `exit=${a.output?.exitCode} stdout=${a.output?.stdout?.length} chars`);
  check('A4. verification passed', a.verification?.passed === true);
  const dirty = git(PROJECT_PATH, 'status', '--porcelain');
  check('A5. the disposable project really changed', dirty.includes('src/calc.js'), `git="${dirty}"`);
  info(`argv: ${JSON.stringify(a.output?.args)}`);

  /* ── B. unknown node rejected before execution ────────────────── */
  const b = await invoke('agent.delegate', { task: 'x' }, { nodeId: 'no-such-node', approve: true });
  check('B. an unknown node is rejected before execution',
    b.outcome === 'denied' && b.policy?.rule === 'unknown-node' && ranNothing(b),
    `outcome=${b.outcome} rule=${b.policy?.rule} attempts=${b.attempts}`);

  /* ── C. disconnected node rejected before execution ───────────── */
  const absent = agents.find((id) => !scan.results?.[id]?.present) ?? 'cursor';
  const c = await invoke('agent.delegate', { task: 'x' }, { nodeId: absent, approve: true });
  check(`C. a disconnected node (${absent}) is rejected before execution`,
    c.outcome === 'denied' && ranNothing(c),
    `outcome=${c.outcome} rule=${c.policy?.rule}`);

  /* ── D. node lacking the capability rejected ──────────────────── */
  // `git` is genuinely present but provides source-control, not coding-agent.
  const d = await invoke('agent.delegate', { task: 'x' }, { nodeId: 'git', approve: true });
  check('D. a present node lacking the capability is rejected',
    d.outcome === 'denied' && d.policy?.rule === 'node-lacks-capability' && ranNothing(d),
    `outcome=${d.outcome} rule=${d.policy?.rule}`);

  /* ── E. several agents catalogued, explicit pick runs only it ─── */
  check('E. several coding agents exist in the catalogue', agents.length > 1, `${agents.length} agents`);
  check('E2. explicit selection ran exactly the requested node',
    a.output?.nodeId === 'opencode' && a.output?.agent === 'OpenCode',
    `executed=${a.output?.nodeId}`);

  /* ── F. no node selected → backward-compatible execution ──────── */
  info('F. no node selected — deterministic resolution…');
  const f = await invoke(
    'agent.delegate',
    { task: 'Append the line "// routed" to the end of src/calc.js and change nothing else.' },
    { approve: true, context: { timeoutMs: 600000 } },
  );
  check('F1. omitting the node still executes (existing behaviour preserved)',
    f.outcome === 'succeeded', f.detail);
  check('F2. and it is still attributed to a specific node',
    typeof f.output?.nodeId === 'string' && f.output.nodeId.length > 0, `nodeId=${f.output?.nodeId}`);

  /* ── G. deterministic when several could serve ────────────────── */
  const g1 = await invoke('agent.delegate', { task: 'echo one' }, { approve: true, context: { timeoutMs: 8000 } });
  const g2 = await invoke('agent.delegate', { task: 'echo two' }, { approve: true, context: { timeoutMs: 8000 } });
  check('G. unselected resolution is deterministic, never arbitrary',
    g1.output?.nodeId === g2.output?.nodeId,
    `${g1.output?.nodeId} == ${g2.output?.nodeId} (first present provider in catalogue order)`);

  /* ── H. resolved node with no verified CLI must NOT substitute ── */
  // Every present coding-agent node other than OpenCode: selecting it must
  // fail rather than quietly running OpenCode instead.
  const others = presentAgents.filter((id) => id !== 'opencode');
  if (others.length === 0) {
    info(`H. only OpenCode is installed, so the substitution case is exercised via a present non-agent node (C/D above)`);
    check('H. a requested node is never replaced by a different one',
      b.outcome === 'denied' && c.outcome === 'denied' && d.outcome === 'denied'
      && ![b, c, d].some((r) => r.output?.nodeId),
      'unknown / disconnected / unsuitable all denied, none executed elsewhere');
  } else {
    const h = await invoke('agent.delegate', { task: 'x' }, { nodeId: others[0], approve: true });
    check(`H. requesting ${others[0]} fails rather than substituting OpenCode`,
      h.outcome !== 'succeeded' && h.output?.nodeId !== 'opencode',
      `outcome=${h.outcome} executed=${h.output?.nodeId ?? 'none'}`);
  }

  /* ── I. approval still mandatory ──────────────────────────────── */
  const i = await invoke('agent.delegate', { task: 'must not run' },
    { nodeId: 'opencode', context: { missionId: 'm-route', taskId: 't-gate' } });
  check('I. routing does not bypass approval',
    i.outcome === 'awaiting-approval' && i.policy?.rule === 'irreversible-floor' && i.attempts === 0,
    `outcome=${i.outcome} rule=${i.policy?.rule} attempts=${i.attempts}`);

  /* ── J. audit records requested AND executed ──────────────────── */
  const audit = (await api('/fabric/audit')).audit ?? [];
  const routed = audit.filter((r) => r.capabilityId === 'agent.delegate');
  const explicit = routed.find((r) => r.requestedNodeId === 'opencode' && r.executedNodeId === 'opencode');
  const implicit = routed.find((r) => !r.requestedNodeId && r.executedNodeId);
  const refused = routed.find((r) => r.requestedNodeId === 'no-such-node');
  check('J1. audit records the requested and executed node together',
    !!explicit, explicit ? `requested=${explicit.requestedNodeId} executed=${explicit.executedNodeId}` : 'missing');
  check('J2. an unrequested run records only what executed',
    !!implicit, implicit ? `requested=${implicit.requestedNodeId ?? 'none'} executed=${implicit.executedNodeId}` : 'missing');
  check('J3. a refused route is recorded with the node that was asked for',
    !!refused && !refused.executedNodeId,
    refused ? `requested=${refused.requestedNodeId} executed=${refused.executedNodeId ?? 'none'}` : 'missing');

  /* ── L. existing capabilities unaffected ──────────────────────── */
  const still = {
    'git.status': await invoke('git.status', {}),
    'filesystem.read': await invoke('filesystem.read', { path: 'README.md' }),
    'terminal.execute': await invoke('terminal.execute', { command: 'node --version' }),
  };
  for (const [id, r] of Object.entries(still)) {
    check(`L. ${id} still works with no node requested`, r.outcome === 'succeeded', `outcome=${r.outcome}`);
  }
  // A node-bound capability routed explicitly to its real provider.
  const gitRouted = await invoke('git.status', {}, { nodeId: 'git' });
  check('L2. git.status routed explicitly to the git node still works',
    gitRouted.outcome === 'succeeded', `outcome=${gitRouted.outcome}`);
  const gitWrong = await invoke('git.status', {}, { nodeId: 'opencode' });
  check('L3. git.status routed to a node without source-control is refused',
    gitWrong.outcome === 'denied' && gitWrong.policy?.rule === 'node-lacks-capability',
    `outcome=${gitWrong.outcome} rule=${gitWrong.policy?.rule}`);

  /* ── safety ───────────────────────────────────────────────────── */
  check('SAFE. the AURA repository is untouched throughout',
    auraState() === auraBefore, 'source tree identical (graphify index excluded)');
} catch (e) {
  console.log(`ERROR ${e.message.split('\n')[0]}`);
  failed = true;
} finally {
  console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}
