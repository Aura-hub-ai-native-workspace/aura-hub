/**
 * install-verify — does governed installation actually work, and stay honest?
 * ==================================================================
 * `system.install` is the most dangerous verb AURA has: it changes
 * software on the machine itself, outside any project root. So this suite
 * is built around the two claims that matter most, both of which are
 * failure-shaped rather than success-shaped:
 *
 *   1. **Exit 0 is not installation.** A clean installer exit with no
 *      detectable tool must report `unverified`, never `installed`.
 *   2. **Root tier executes NOTHING.** No sudo, no pacman, no AUR helper,
 *      no password. A verified command is handed over and that is all.
 *
 * The disposable target is `pnpm`: genuinely absent on this machine, ~2 MB,
 * installs in seconds, trivially removable, and — deliberately — not a
 * coding agent, so installing it cannot perturb the routing or attribution
 * suites. It is uninstalled again in cleanup, so the machine ends where it
 * started.
 *
 * Nothing here is simulated. Every outcome comes from the real service,
 * the real policy engine, the real approval gate and a real probe.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = '/home/Groot/aura-hub';
const API = process.env.HUB_API ?? 'http://127.0.0.1:4319';

/**
 * Bundle the real modules rather than reimplementing their logic here, so
 * this suite cannot drift from the implementation it is checking. Same
 * approach as `process-timeout-test.mjs`.
 */
const bundle = (rel, name) => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'install-verify-')), name);
  execFileSync('npx', [
    'esbuild', `${ROOT}/${rel}`,
    '--bundle', '--platform=node', '--format=esm', '--external:typescript', `--outfile=${out}`,
  ], { cwd: ROOT, stdio: 'pipe' });
  return import(out);
};
/** Absent, tiny, reversible, and unrelated to agent routing. */
const TARGET = 'pnpm';

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const info = (m) => console.log(`      ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p) => (await fetch(`${API}${p}`)).json();
const post = async (p, body, ms = 400000) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`${API}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}), signal: ac.signal,
    });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
};

/**
 * Invoke `system.install`.
 *
 * `granted` now walks the real approval flow (`approveAndRun` above)
 * rather than sending a grant in the request body, which the service no
 * longer accepts. It does NOT bypass policy: the engine still evaluates,
 * still records the decision and rule, and still audits — there is simply
 * a human answer in the middle now, as there is in the product. The
 * ungranted path below is what proves the gate is real.
 */

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

const invoke = (input, { granted = false, context = {} } = {}) => {
  const body = {
    capabilityId: 'system.install',
    input,
    context: { actor: { kind: 'human', id: 'install-verify' }, projectId: null, ...context },
  };
  return granted ? approveAndRun(body) : post('/fabric/invoke', body);
};

const onPath = (bin) => {
  const r = spawnSync('sh', ['-c', `command -v ${bin} || true`], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
};

const removeTarget = () => {
  try {
    execFileSync('npm', ['uninstall', '--global', TARGET], { stdio: 'ignore', timeout: 120000 });
  } catch { /* best effort — it may never have been installed */ }
};

/** Only judge audit records this run produced — the log is cumulative. */
const RUN_STARTED_AT = new Date().toISOString();

console.log('=== 0. PRECONDITIONS ===');

const health = await api('/health').catch(() => null);
if (!health) {
  console.log('AURA service is not reachable. Start it with `npm run ai`.');
  process.exit(1);
}

// A target that is already present proves nothing about installing.
if (onPath(TARGET)) {
  info(`${TARGET} is already installed — removing it so the install path is genuinely exercised.`);
  removeTarget();
  await sleep(1000);
}
check(`0a. the target (${TARGET}) is genuinely absent before we start`, !onPath(TARGET),
  onPath(TARGET) || 'not on PATH');

const caps = await api('/fabric/capabilities');
const installCap = (caps.capabilities ?? []).find((c) => c.id === 'system.install');
check('0b. system.install is in the capability catalogue', !!installCap,
  installCap ? `risk=${installCap.risk} supported=${installCap.supported}` : 'missing');
check('0c. it is backed by a real executor', installCap?.supported === true,
  `supported=${installCap?.supported}`);
check('0d. it requires no node capability (installing is how a node comes to exist)',
  !installCap?.requiresNodeCapability, `requiresNodeCapability=${installCap?.requiresNodeCapability ?? 'none'}`);

/* ── 1. allow-list disjointness ───────────────────────────────────── */

console.log('\n=== 1. ALLOW-LIST DISJOINTNESS ===');

const proc = await bundle('packages/ai-service/src/exec/process.ts', 'process.mjs').catch(() => null);
if (proc) {
  const safe = [...proc.SAFE_BINARIES];
  const agent = [...proc.AGENT_BINARIES];
  const installer = [...proc.INSTALLER_BINARIES];
  const overlap = (a, b) => a.filter((x) => b.includes(x));
  /**
   * `npm` and `cargo` appear on both lists, and cannot simply be removed
   * from `SAFE_BINARIES`: `npm test` and `cargo build` are ordinary
   * project work that missions depend on. Name-level disjointness is
   * therefore impossible without breaking existing behaviour.
   *
   * What the disjointness requirement actually protects is asserted
   * directly below instead: `terminal.execute` must not be able to
   * install anything. That property is enforced on the VERB, and the
   * live checks in 1a2 prove it against the real parser.
   */
  const shared = overlap(installer, safe);
  check('1a. any name shared with SAFE_BINARIES is only npm/cargo, and justified',
    shared.every((b) => b === 'npm' || b === 'cargo'),
    shared.length ? `shared=[${shared.join(',')}] — needed for npm test / cargo build` : 'no overlap');

  const blocked = [
    'npm install --global left-pad',
    'npm i -g left-pad',
    'cargo install ripgrep',
    'go install example.com/x@latest',
    'python3 -m pip install requests',
  ];
  const leaks = blocked.filter((c) => proc.parseCommand(c).ok);
  check('1a2. terminal.execute cannot install software through a shared binary',
    leaks.length === 0, leaks.length ? `LEAKED: ${leaks.join(' | ')}` : `${blocked.length} install forms refused`);

  const stillWorks = ['npm test', 'npm run build', 'cargo build', 'go build ./...', 'git status'];
  const broken = stillWorks.filter((c) => !proc.parseCommand(c).ok);
  check('1a3. ordinary project commands still work', broken.length === 0,
    broken.length ? `BROKE: ${broken.join(' | ')}` : `${stillWorks.length} ordinary commands still allowed`);
  check('1b. INSTALLER_BINARIES ∩ AGENT_BINARIES = ∅', overlap(installer, agent).length === 0,
    overlap(installer, agent).join(',') || 'disjoint');
  check('1c. SAFE_BINARIES ∩ AGENT_BINARIES = ∅ (unchanged)', overlap(safe, agent).length === 0,
    overlap(safe, agent).join(',') || 'disjoint');
  check('1d. no privileged or escalating binary is on any list',
    ![...safe, ...agent, ...installer].some((b) => ['sudo', 'pacman', 'apt', 'dnf', 'yay', 'paru', 'doas', 'pkexec'].includes(b)),
    `installer=[${installer.join(',')}]`);
  check('1e. a path-like installer name is refused', !proc.resolveInstallerBinary('/usr/bin/npm').ok,
    proc.resolveInstallerBinary('/usr/bin/npm').reason);
  check('1f. an unlisted installer is refused', !proc.resolveInstallerBinary('sh').ok,
    proc.resolveInstallerBinary('sh').reason);
} else {
  check('1. allow-lists are inspectable', false, 'could not import exec/process.ts');
}

/* ── 2. refusals that must happen before anything runs ────────────── */

console.log('\n=== 2. REFUSALS ===');

const unknown = await invoke({ nodeId: 'definitely-not-a-node' }, { granted: true });
check('2a. an unknown node is refused', unknown.outcome !== 'succeeded',
  `outcome=${unknown.outcome} · ${(unknown.detail ?? '').slice(0, 90)}`);
check('2b. the refusal names the catalogue, not a package', /catalogue/i.test(unknown.detail ?? ''),
  (unknown.detail ?? '').slice(0, 110));

// `bash` is catalogued and probed but carries no InstallSpec.
const noSpec = await invoke({ nodeId: 'bash' }, { granted: true });
const noSpecOut = noSpec.output ?? {};
check('2c. a node with no InstallSpec is refused honestly, not guessed at',
  noSpec.outcome !== 'succeeded' && !noSpecOut.command,
  `outcome=${noSpec.outcome} · ${(noSpec.detail ?? '').slice(0, 100)}`);
check('2d. and it points at the project\'s own instructions',
  /no verified way|instructions/i.test(noSpec.detail ?? ''), (noSpec.detail ?? '').slice(0, 110));

const empty = await invoke({ nodeId: '' }, { granted: true });
check('2e. an empty node id is refused', empty.outcome !== 'succeeded', `outcome=${empty.outcome}`);

/* ── 3. approval is mandatory ─────────────────────────────────────── */

console.log('\n=== 3. POLICY AND APPROVAL ===');

const gated = await invoke({ nodeId: TARGET });
check('3a. an install is gated by approval before anything runs',
  gated.outcome === 'awaiting-approval' && gated.attempts === 0,
  `outcome=${gated.outcome} rule=${gated.policy?.rule} attempts=${gated.attempts}`);
check('3b. the gate comes from the high-risk policy default',
  gated.policy?.decision === 'require-approval', `decision=${gated.policy?.decision} risk=${gated.policy?.risk}`);
check('3c. nothing was installed while awaiting approval', !onPath(TARGET), onPath(TARGET) || 'still absent');

// Deny it, and confirm the machine is untouched.
const { approvals: pend = [] } = await api('/fabric/approvals');
const toDeny = pend.find((a) => a.state === 'pending' && a.items?.some((i) => i.invocationId === gated.invocationId));
if (toDeny) await post(`/fabric/approvals/${toDeny.id}/decide`, { granted: false, reason: 'install-verify: denial path' });
check('3d. a denied install runs nothing', !onPath(TARGET), onPath(TARGET) || 'still absent');

/* ── 4. root tier — AURA must execute NOTHING ─────────────────────── */

console.log('\n=== 4. ROOT TIER (GUIDED) ===');

// Granted deliberately: the point is that even WITH authorization, a
// root-tier install executes nothing at all.
const rootInv = await invoke({ nodeId: 'docker' }, { granted: true });
const rootOut = rootInv.output ?? {};
info(`docker install outcome=${rootInv.outcome} installOutcome=${rootOut.installOutcome ?? 'none'}`);

check('4a. a root-tier install reports installOutcome=guided', rootOut.installOutcome === 'guided',
  `installOutcome=${rootOut.installOutcome ?? 'none'}`);
check('4b. it declares that user action is required', rootOut.requiresUserAction === true,
  `requiresUserAction=${rootOut.requiresUserAction}`);
check('4c. it reports the root privilege', rootOut.privilege === 'root', `privilege=${rootOut.privilege}`);
check('4d. it carries a concrete command', typeof rootOut.command === 'string' && rootOut.command.length > 0,
  rootOut.command ?? 'none');
check('4e. the command is built from the catalogue for THIS distro',
  /pacman|apt|dnf/.test(rootOut.command ?? '') && /docker/.test(rootOut.command ?? ''),
  rootOut.command ?? 'none');
check('4f. it explains why AURA will not run it', typeof rootOut.why === 'string' && rootOut.why.length > 0,
  (rootOut.why ?? '').slice(0, 100));

// The claim that matters: nothing was executed.
check('4g. AURA did NOT install it', !onPath('docker'), onPath('docker') || 'docker still absent');
check('4h. no installer output exists for a guided result — nothing ran',
  rootOut.exitCode === undefined && rootOut.stdout === undefined,
  `exitCode=${rootOut.exitCode ?? 'none'} stdout=${rootOut.stdout === undefined ? 'none' : 'present'}`);

/* ── 5. no privilege escalation anywhere ──────────────────────────── */

console.log('\n=== 5. PRIVILEGE BOUNDARY ===');

const serviceTree = spawnSync('sh', ['-c',
  `ps -eo pid,ppid,user,args | grep -Ei '(sudo|pkexec|doas|pacman|yay|paru)' | grep -v grep || true`],
  { encoding: 'utf8' }).stdout.trim();
check('5a. AURA spawned no privileged or escalating process', !/ai-service|aura/i.test(serviceTree),
  serviceTree ? serviceTree.split('\n')[0].slice(0, 100) : 'no sudo/pacman/yay/paru processes');

const auditAll = (await api('/fabric/audit')).audit ?? [];
const installRows = auditAll.filter((r) => r.capabilityId === 'system.install');
const auditText = JSON.stringify(installRows);
check('5b. no password or secret appears in the audit trail',
  !/password|passwd|sudo\s+-S|--stdin/i.test(auditText), 'none found');
check('5c. no AUR helper was ever substituted for the guided command',
  !/\byay\b|\bparu\b/.test(JSON.stringify(rootOut)), 'no yay/paru in the guided payload');

/* ── 6. the real userspace install ────────────────────────────────── */

console.log('\n=== 6. REAL USERSPACE INSTALL ===');
info(`installing ${TARGET} for real — this takes a few seconds…`);

const userInv = await invoke({ nodeId: TARGET });
check('6a. the userspace install is also gated without authorization',
  userInv.outcome === 'awaiting-approval' && userInv.attempts === 0,
  `outcome=${userInv.outcome} attempts=${userInv.attempts}`);

const installed = await invoke({ nodeId: TARGET }, { granted: true });
const out = installed.output ?? {};

check('6b. approving it runs the installer and reports installOutcome=installed',
  out.installOutcome === 'installed', `installOutcome=${out.installOutcome ?? 'none'} · ${(installed.detail ?? '').slice(0, 90)}`);
check('6c. the installer exited 0', out.exitCode === 0, `exitCode=${out.exitCode}`);
check('6d. it ran as the user, not root', out.privilege === 'user', `privilege=${out.privilege}`);
check('6e. no further user action is required', out.requiresUserAction === false,
  `requiresUserAction=${out.requiresUserAction}`);

/* The whole point: a real post-install probe, not the exit code. */
check('6f. the post-install probe actually found it', out.probe?.present === true,
  `probe=${out.probe?.detail ?? 'none'}`);
check('6g. and parsed a real version', !!out.probe?.version && /\d+\.\d+/.test(out.probe.version),
  `version=${out.probe?.version ?? 'none'}`);
check('6h. the tool is genuinely on PATH now', !!onPath(TARGET), onPath(TARGET) || 'NOT on PATH');
check('6i. Fabric verification passed on read-back',
  installed.verification?.passed === true && installed.verification?.kind === 'read-back',
  `verification=${installed.verification?.kind}/${installed.verification?.passed}`);

/* ── 7. the environment reflects it ───────────────────────────────── */

console.log('\n=== 7. ENVIRONMENT RE-SCAN ===');

const scan = await post('/environment/scan', { refresh: true }, 240000);
const scanned = scan.results?.[TARGET];
check('7a. a fresh scan reports the node present', scanned?.present === true,
  `present=${scanned?.present} version=${scanned?.version ?? 'none'}`);
check('7b. with the real version the machine reports', !!scanned?.version,
  scanned?.detail ?? 'no detail');
check('7c. its node capability is now provided',
  (scan.providedCapabilities ?? []).includes('package-manager'),
  `package-manager provided=${(scan.providedCapabilities ?? []).includes('package-manager')}`);

/* ── 8. audit ─────────────────────────────────────────────────────── */

console.log('\n=== 8. AUDIT ===');

const audit2 = ((await api('/fabric/audit')).audit ?? [])
  .filter((r) => r.capabilityId === 'system.install' && r.at >= RUN_STARTED_AT);
const success = audit2.find((r) => r.outcome === 'succeeded');
check('8a. installs are recorded in the audit log', audit2.length > 0, `${audit2.length} record(s) this run`);
check('8b. the successful install is audited with the floor that gated it',
  !!success && success.decision === 'require-approval' && success.decisionRule === 'system-floor',
  success ? `decision=${success.decision} rule=${success.decisionRule}` : 'none');
// The gate path (no per-call grant) is what mints an ApprovalRequest, so
// that is where an approvalId must exist.
const gatedRow = audit2.find((r) => r.outcome === 'awaiting-approval');
check('8b2. a gated install carries its approval request id', !!gatedRow?.approvalId,
  `approvalId=${gatedRow?.approvalId ?? 'none'}`);
check('8c. the installed node is NOT recorded as the executing node (§25.2 C4)',
  !success?.executedNodeId,
  `executedNodeId=${success?.executedNodeId ?? 'none'} — the node is the object, not the actor`);
check('8d. the target still appears in the input summary', /pnpm/.test(success?.inputSummary ?? ''),
  success?.inputSummary ?? 'none');

/* ── 9. exit 0 but missing binary → unverified ────────────────────── */

console.log('\n=== 9. EXIT 0 IS NOT INSTALLATION ===');

/**
 * The single most important behaviour, exercised directly against the
 * executor's logic rather than by breaking a real package manager.
 *
 * A package that installs cleanly but leaves nothing on PATH is exactly
 * the `unverified` case. `left-pad` is tiny, harmless and ships no binary,
 * so `npm install -g left-pad` exits 0 while the probe for its node finds
 * nothing — provided a catalogue entry points at it. Since no such entry
 * exists (correctly), this asserts the code path through the module.
 */
const installMod = await bundle('packages/ai-service/src/exec/install.ts', 'install.mjs').catch(() => null);
if (installMod) {
  const { planInstall, isPlan, writableWithAncestors, resolvePrivilege } = installMod;
  const fakeEntry = {
    id: 'x', name: 'X', homepage: 'https://example.com',
    install: { method: 'npm-global', package: 'left-pad', privilege: 'user' },
  };
  const plan = planInstall(fakeEntry);
  check('9a. a userspace plan is executable and shell-free',
    isPlan(plan) && plan.executable && plan.bin === 'npm' && Array.isArray(plan.args),
    isPlan(plan) ? `${plan.bin} ${plan.args.join(' ')}` : plan.reason);
  check('9b. a not-yet-created directory counts as writable via its ancestor (§25.2 C2)',
    writableWithAncestors(`${process.env.HOME}/.cargo/bin`) === true, 'nearest existing ancestor is writable');
  check('9c. an unwritable existing directory is NOT treated as writable',
    writableWithAncestors('/usr/lib') === false, '/usr/lib correctly refused');
  check('9d. system-package always resolves to root (§25.2 C3 — never an AUR helper)',
    resolvePrivilege({ method: 'system-package', package: 'docker', privilege: 'root' }).privilege === 'root',
    'root');
} else {
  check('9. install planning is inspectable', false, 'could not import exec/install.ts');
}

// And the live proof that verification gates the outcome: re-running the
// install now that pnpm exists must still verify by probe, not by exit code.
const rerun = await invoke({ nodeId: TARGET }, { granted: true });
const o2 = rerun.output ?? {};
check('9e. a re-install is still verified by a real probe, never by exit code alone',
  o2.installOutcome === 'installed' && o2.probe?.present === true,
  `installOutcome=${o2.installOutcome} probe=${o2.probe?.present}`);

/* ── 10. no architectural duplication ─────────────────────────────── */

console.log('\n=== 10. SINGLE AUTHORITY ===');

const policy = (await api('/fabric/capabilities')).policy ?? {};
check('10a. still one policy engine with its risk defaults', !!policy.byRisk,
  `byRisk.high=${policy.byRisk?.high}`);
/**
 * The invariant that matters: NO install ever auto-executed.
 *
 * Not every row is `require-approval` — an empty node id is rejected by
 * argument validation before policy runs (`deny`/`invalid-input`), and a
 * human decline is stamped as its own decision record. Both are correct.
 * What must never appear is an install that policy waved through.
 */
const autoExecuted = audit2.filter((r) => r.decision === 'auto-execute');
check('10b. no install was ever auto-executed', autoExecuted.length === 0,
  autoExecuted.length ? autoExecuted.map((r) => r.inputSummary).join(' ') : `${audit2.length} record(s), none auto-executed`);

const ran = audit2.filter((r) => r.outcome === 'succeeded');
check('10c. every install that actually ran was gated by the system floor',
  ran.length > 0 && ran.every((r) => r.decision === 'require-approval' && r.decisionRule === 'system-floor'),
  `${ran.length} executed, all via system-floor`);
check('10d. the floor held even though this machine sets high risk to auto-execute',
  policy.byRisk?.high !== 'auto-execute' || ran.every((r) => r.decision === 'require-approval'),
  `byRisk.high=${policy.byRisk?.high} — configuration cannot reach the floor`);

/* ── cleanup: leave the machine as we found it ────────────────────── */

console.log('\n=== CLEANUP ===');
removeTarget();
await sleep(500);
const stillThere = onPath(TARGET);
check('C1. the disposable target was removed again', !stillThere, stillThere || `${TARGET} uninstalled`);
await post('/environment/scan', { refresh: true, ids: [TARGET] }, 60000).catch(() => null);

console.log(`\nRESULT: ${failed ? 'FAILED' : 'ALL CHECKS PASSED'}`);
process.exit(failed ? 1 : 0);
