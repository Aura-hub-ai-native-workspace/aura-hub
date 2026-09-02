/**
 * agent-delegate-verify — proves `agent.delegate` really drives OpenCode.
 * ==================================================================
 * Exercises the governed path end to end against a DISPOSABLE project:
 *
 *   agent.delegate → coding-agent requirement → OpenCode node
 *                  → real `opencode` binary → real edits → stdout/exit code
 *
 * The checks that matter most are the negative ones. It is easy to make a
 * capability that runs; the claims worth proving are that it CANNOT run
 * without approval, that `terminal.execute` still cannot launch an agent,
 * and that a caller cannot name an arbitrary executable.
 *
 * Nothing here is mocked. The agent genuinely edits files in the throwaway
 * project, and the AURA repository is checked before and after.
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

/** `extra.approve` walks the real approval flow; omit it to test the gate. */
const invoke = (capabilityId, input, extra = {}) => {
  const body = { capabilityId, input, context: { projectId: PROJECT, ...(extra.context ?? {}) } };
  return extra.approve ? approveAndRun(body) : post('/fabric/invoke', body);
};

const gitPorcelain = (dir) => execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();

try {
  /* ── fresh disposable project ─────────────────────────────────── */
  fs.rmSync(PROJECT_PATH, { recursive: true, force: true });
  fs.mkdirSync(`${PROJECT_PATH}/src`, { recursive: true });
  fs.writeFileSync(`${PROJECT_PATH}/README.md`, '# hub-exec-test\n\nDisposable. Safe to delete.\n');
  fs.writeFileSync(`${PROJECT_PATH}/package.json`, '{ "name": "hub-exec-test", "private": true, "type": "module" }\n');
  fs.writeFileSync(`${PROJECT_PATH}/src/calc.js`, 'export function add(a,b){return a+b}\n');
  execFileSync('git', ['-C', PROJECT_PATH, 'init', '-q']);
  execFileSync('git', ['-C', PROJECT_PATH, 'add', '-A']);
  execFileSync('git', ['-C', PROJECT_PATH, '-c', 'user.email=t@l', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  info(`disposable project reset: ${PROJECT_PATH}`);

  const auraBefore = gitPorcelain(AURA_REPO);

  /* ── 1. OpenCode is detected ──────────────────────────────────── */
  /**
   * A FULL scan, as the Workspace does. Deliberately not `{ids:['opencode']}`:
   * the server rebuilds its global `providedNodeCapabilities` from whatever
   * the scan covered (server.ts:126-130), so a targeted scan silently
   * narrows the set and denies unrelated capabilities like git.status
   * until the next full scan. That is a pre-existing defect, recorded
   * rather than worked around silently — see the report.
   */
  const scan = await post('/environment/scan', {});
  const oc = scan.results?.opencode;
  check('1. OpenCode is detected by the existing environment scan',
    oc?.present === true && !!oc.version, `version=${oc?.version} · ${oc?.detail}`);
  check('1b. detection reports coding-agent as provided',
    (scan.providedCapabilities ?? []).includes('coding-agent'),
    `${scan.found} node(s) present`);

  /* ── 2 + 3. the capability exists and requires coding-agent ───── */
  const caps = await api('/fabric/capabilities');
  const ad = caps.capabilities.find((c) => c.id === 'agent.delegate');
  check('2. agent.delegate exists in the manifest', !!ad, ad ? `risk=${ad.risk} supported=${ad.supported}` : '');
  check('3. agent.delegate requires coding-agent',
    ad?.requiresNodeCapability === 'coding-agent', `requiresNodeCapability=${ad?.requiresNodeCapability}`);
  check('3b. it has a real executor behind it', ad?.supported === true);

  /* ── 4. the gap system resolves OpenCode as the provider ──────── */
  const catalogue = (await api('/environment/catalog')).catalog;
  const providers = catalogue.filter((e) => (e.capabilities ?? []).includes('coding-agent')).map((e) => e.id);
  check('4. the catalogue identifies coding-agent providers, incl. OpenCode',
    providers.includes('opencode'), providers.join(', '));
  check('4b. coding-agent is satisfied, so agent.delegate is not reported as a gap',
    caps.providedNodeCapabilities.includes('coding-agent'));

  /* ── 5. blocked without approval ──────────────────────────────── */
  const blocked = await invoke('agent.delegate', { task: 'this must not run' });
  check('5. agent.delegate is blocked without approval',
    blocked.outcome === 'awaiting-approval' && blocked.attempts === 0,
    `outcome=${blocked.outcome} rule=${blocked.policy?.rule} attempts=${blocked.attempts}`);
  check('5b. the block is a non-configurable floor, not a risk default',
    blocked.policy?.rule === 'irreversible-floor',
    `policy.byRisk.high on this machine = ${caps.policy.byRisk.high}`);

  /* ── 6. approval is raised against the right mission/task ─────── */
  const gated = await invoke('agent.delegate', { task: 'this must not run either' },
    { context: { missionId: 'mission-verify-1', taskId: 'task-verify-1' } });
  const approvals = (await api('/fabric/approvals')).approvals ?? [];
  const mine = approvals.filter((a) => a.missionId === 'mission-verify-1' && a.taskId === 'task-verify-1');
  check('6. an approval request is raised for the correct mission/task',
    mine.length > 0 && mine.some((a) => a.items?.some((i) => i.capabilityId === 'agent.delegate')),
    `${mine.length} request(s) · outcome=${gated.outcome}`);

  /* ── 13. terminal.execute still cannot launch an agent ────────── */
  const viaTerminal = await invoke('terminal.execute', { command: 'opencode run "do something"' });
  check('13. terminal.execute still cannot execute OpenCode',
    viaTerminal.outcome === 'failed' && /not on the allow-list/.test(viaTerminal.detail ?? ''),
    viaTerminal.detail?.slice(0, 110));

  /* ── 14. arbitrary executables are rejected ───────────────────── */
  for (const [label, nodeId] of [
    ['absolute path', '/home/Groot/.opencode/bin/opencode'],
    ['relative path', '../../bin/sh'],
    ['unknown node', 'definitely-not-a-node'],
  ]) {
    const bad = await invoke('agent.delegate', { task: 'x', nodeId },
      { approve: true });
    check(`14. ${label} is rejected (${nodeId})`,
      bad.outcome !== 'succeeded', `outcome=${bad.outcome} · ${String(bad.detail).slice(0, 90)}`);
  }

  /* ── 7 + 8 + 9. approve, and the real agent runs ──────────────── */
  info('running the real OpenCode CLI — this takes a minute…');
  const started = Date.now();
  const run = await invoke(
    'agent.delegate',
    {
      task: 'Add a JSDoc comment block above the add function in src/calc.js describing its parameters and return value. Change nothing else.',
      nodeId: 'opencode',
    },
    { approve: true, context: { timeoutMs: 600000 } },
  );
  info(`outcome=${run.outcome} in ${Math.round((Date.now() - started) / 1000)}s`);
  check('7. approving it executes the real OpenCode CLI',
    run.outcome === 'succeeded', `${run.detail}`);
  check('7b. the run is attributed to the OpenCode node',
    run.output?.nodeId === 'opencode' && run.output?.agent === 'OpenCode',
    `nodeId=${run.output?.nodeId} agent=${run.output?.agent}`);
  info(`argv: ${JSON.stringify(run.output?.args)}`);

  const after = fs.readFileSync(`${PROJECT_PATH}/src/calc.js`, 'utf8');
  const dirty = gitPorcelain(PROJECT_PATH);
  check('8. the disposable project was really modified by OpenCode',
    dirty.length > 0 && after.includes('/**'),
    `git: "${dirty.replace(/\n/g, ' ')}"`);
  info(`calc.js now:\n${after.split('\n').map((l) => '        ' + l).join('\n')}`);

  check('9. stdout and exit code are captured',
    typeof run.output?.stdout === 'string' && run.output.stdout.length > 0 && run.output?.exitCode === 0,
    `exitCode=${run.output?.exitCode} stdout=${run.output?.stdout?.length} chars`);

  /* ── 10. terminal state + verification ────────────────────────── */
  check('10. the invocation reached a terminal state with real verification',
    ['succeeded', 'failed'].includes(run.outcome) && run.verification?.kind === 'exit-code',
    `outcome=${run.outcome} verification=${run.verification?.kind}/${run.verification?.passed}`);

  /* ── 11. only the OpenCode node is implicated ─────────────────── */
  const terminalProviders = catalogue
    .filter((e) => (e.capabilities ?? []).includes('terminal')).map((e) => e.id);
  check('11. activity maps to coding-agent providers only, not every terminal provider',
    !providers.includes('bash') && !providers.includes('zsh') && terminalProviders.includes('bash'),
    `coding-agent=[${providers.join(',')}] terminal=[${terminalProviders.join(',')}]`);
  check('11b. the executed node is named in the result, so work is attributable',
    run.output?.nodeId === 'opencode');

  /* ── 12. the AURA repo is untouched ───────────────────────────── */
  const auraAfter = gitPorcelain(AURA_REPO);
  check('12. the AURA Hub repository is completely untouched by the agent',
    auraAfter === auraBefore,
    auraAfter === auraBefore ? 'byte-identical git status before/after' : 'CHANGED');

  /* ── 15. existing capabilities still work ─────────────────────── */
  const still = {
    'git.status': await invoke('git.status', {}),
    'filesystem.read': await invoke('filesystem.read', { path: 'package.json' }),
    'terminal.execute': await invoke('terminal.execute', { command: 'node --version' }),
  };
  for (const [id, r] of Object.entries(still)) {
    check(`15. ${id} still works`, r.outcome === 'succeeded', `outcome=${r.outcome}`);
  }

  /* ── audit ────────────────────────────────────────────────────── */
  const audit = (await api('/fabric/audit')).audit ?? [];
  const delegated = audit.filter((a) => a.capabilityId === 'agent.delegate');
  check('16. the delegation is in the audit log',
    delegated.length > 0, `${delegated.length} agent.delegate record(s) of ${audit.length} total`);
} catch (e) {
  console.log(`ERROR ${e.message.split('\n')[0]}`);
  failed = true;
} finally {
  console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}
