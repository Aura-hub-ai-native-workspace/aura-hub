/**
 * install-ux-verify — a click is consent; a request is a request.
 * ==================================================================
 * Clicking "Install" used to raise an approval the same person then had
 * to go and answer in Mission Control. The floor was not wrong — a
 * `system.modify` capability should never run silently — but the channel
 * was: the UI expressed a decision the user had already made as a
 * *request* for permission to make it.
 *
 * This suite proves the correction did exactly two things and nothing
 * more:
 *
 *   · a deliberate user action, attested by the window's own token,
 *     satisfies the ONE floor that exists to obtain the user's consent;
 *   · everything else — every other floor, every model-initiated call,
 *     every operator override — is governed exactly as it was.
 *
 * The load-bearing checks are the negative ones. Section [B] proves the
 * body-supplied grant that used to satisfy any floor is gone, and
 * section [C] proves an irreversible action is still gated even for a
 * direct click. A regression making this a general fast path passes [A]
 * and fails those.
 *
 * Runs its own service on a disposable AURA_HOME and a private port, so
 * it touches nothing the developer is using and installs no software.
 *
 *   node scripts/install-ux-verify.mjs
 *   AURA_INSTALL_LIVE=1 node scripts/install-ux-verify.mjs   (also does a
 *       real userspace `npm i -g pnpm` — mutates this machine)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'apps/desktop/src-tauri/resources/ai-service.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-install-ux-'));

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const skip = (n, why) => console.log(`SKIP  ${n} — ${why}`);
const info = (m) => console.log(`      ${m}`);
const section = (t) => console.log(`\n${t}`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const count = (hay, re) => (hay.match(re) ?? []).length;

let child = null;
let API = '';
let TOKEN = null;

/** POST /fabric/invoke. `token` null = an ordinary governed request. */
const invoke = async (capabilityId, input, { token = null, approvedCapabilities, context = {} } = {}) => {
  const res = await fetch(`${API}/fabric/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-aura-ui': token } : {}) },
    body: JSON.stringify({
      capabilityId, input, context,
      ...(approvedCapabilities ? { approvedCapabilities } : {}),
    }),
  });
  return res.json();
};
const approvals = async () => (await (await fetch(`${API}/fabric/approvals`)).json()).approvals ?? [];
const audit = async () => (await (await fetch(`${API}/fabric/audit`)).json()).audit ?? [];

try {
  if (!fs.existsSync(BUNDLE)) {
    console.error('Service bundle missing. Run: node scripts/build-service-bundle.mjs');
    process.exit(1);
  }

  const port = await freePort();
  API = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [BUNDLE, '--none'], {
    env: { ...process.env, AI_PORT: String(port), AURA_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${API}/health`)).ok) { up = true; break; } } catch { /* not listening */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) throw new Error('service did not start');
  info(`service on ${API}, AURA_HOME=${HOME}`);

  /* ══ [A] The attested channel ═════════════════════════════════ */
  section('[A] A direct user action is recognised — and only from the real channel');

  const tokenFile = path.join(HOME, 'ui-token');
  check('A1  the service minted a UI token', fs.existsSync(tokenFile));
  TOKEN = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : null;
  check('A2  the token is 32 random bytes', !!TOKEN && /^[0-9a-f]{64}$/.test(TOKEN), TOKEN ? `${TOKEN.slice(0, 8)}…` : 'absent');

  if (process.platform !== 'win32') {
    const mode = fs.statSync(tokenFile).mode & 0o777;
    check('A3  the token file is 0600', mode === 0o600, `mode ${mode.toString(8)}`);
  } else {
    skip('A3  the token file is 0600', 'POSIX modes do not exist on Windows');
  }

  const direct = await invoke('system.install', { nodeId: 'terraform' }, { token: TOKEN });
  check('A4  a click is not sent to an approval queue', direct.outcome !== 'awaiting-approval', `outcome ${direct.outcome}`);
  check('A5  policy recorded it as a direct user action', direct.policy?.rule === 'user-direct', `rule ${direct.policy?.rule}`);

  const noToken = await invoke('system.install', { nodeId: 'terraform' });
  check('A6  NEGATIVE — the same call with no token is still gated',
    noToken.outcome === 'awaiting-approval' && noToken.policy?.rule === 'system-floor',
    `outcome ${noToken.outcome}, rule ${noToken.policy?.rule}`);

  const badToken = await invoke('system.install', { nodeId: 'terraform' }, { token: 'f'.repeat(64) });
  check('A7  NEGATIVE — a forged token of the right shape is rejected',
    badToken.outcome === 'awaiting-approval' && badToken.policy?.rule === 'system-floor',
    `outcome ${badToken.outcome}, rule ${badToken.policy?.rule}`);

  /* ══ [B] The self-granted approval is gone ════════════════════ */
  section('[B] A caller can no longer approve itself');

  const selfGrant = await invoke('system.install', { nodeId: 'terraform' }, { approvedCapabilities: ['system.install'] });
  check('B1  a body-supplied grant does not satisfy system-floor',
    selfGrant.outcome === 'awaiting-approval' && selfGrant.policy?.rule === 'system-floor',
    `outcome ${selfGrant.outcome}, rule ${selfGrant.policy?.rule}`);

  const selfGrantAgent = await invoke('agent.delegate', { task: 'noop' }, { approvedCapabilities: ['agent.delegate'] });
  check('B2  a body-supplied grant does not satisfy irreversible-floor',
    selfGrantAgent.outcome === 'awaiting-approval' && selfGrantAgent.policy?.rule === 'irreversible-floor',
    `outcome ${selfGrantAgent.outcome}, rule ${selfGrantAgent.policy?.rule}`);

  const serverSrc = read('packages/ai-service/src/server.ts');
  check('B3  /fabric/invoke no longer reads approvedCapabilities from the body',
    !/approvedCapabilities:\s*Array\.isArray\(b\.approvedCapabilities\)/.test(serverSrc));

  /* ══ [C] Every other floor still holds ════════════════════════ */
  section('[C] A click satisfies the consent floor and nothing else');

  const irreversibleDirect = await invoke('agent.delegate', { task: 'noop' }, { token: TOKEN });
  check('C1  an irreversible action is still gated for a direct click',
    irreversibleDirect.outcome === 'awaiting-approval' && irreversibleDirect.policy?.rule === 'irreversible-floor',
    `outcome ${irreversibleDirect.outcome}, rule ${irreversibleDirect.policy?.rule}`);

  const policySrc = read('packages/capability-fabric/src/policy.ts');
  // Count only executable guards: prose in the surrounding comments names
  // `!userDirect` too, and a doc edit must not move a security assertion.
  const policyCode = policySrc
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
  check('C2  exactly two rules consult the initiator (system-floor + autonomy switch)',
    count(policyCode, /!userDirect/g) === 2, `${count(policyCode, /!userDirect/g)} guards in code`);
  check('C3  the irreversible floor has no initiator escape',
    /if \(capability\.irreversible\) \{/.test(policySrc) && !/capability\.irreversible[^)]*userDirect/.test(policySrc));
  check('C4  initiator is set by the transport, never read from the body',
    /initiator: isUserDirect\(req\)/.test(serverSrc) && !/raw\.initiator|b\.initiator/.test(serverSrc));

  /* ══ [D] No mission, no approval ══════════════════════════════ */
  section('[D] Clicking Install creates no mission and no approval request');

  const before = await approvals();
  const clicked = await invoke('system.install', { nodeId: 'terraform' }, { token: TOKEN });
  const after = await approvals();
  check('D1  the click raised no approval request', after.length === before.length, `${before.length} → ${after.length}`);
  check('D2  the click produced a real result, not a gate', clicked.outcome !== 'awaiting-approval', `outcome ${clicked.outcome}`);

  const beforeGoverned = await approvals();
  await invoke('system.install', { nodeId: 'terraform' });
  const afterGoverned = await approvals();
  check('D3  NEGATIVE — a governed request DOES raise one (the counter works)',
    afterGoverned.length > beforeGoverned.length, `${beforeGoverned.length} → ${afterGoverned.length}`);

  const dash = await (await fetch(`${API}/missions/dashboard`)).json();
  const missionCount = Array.isArray(dash.missions) ? dash.missions.length : 0;
  check('D4  no mission was created by any of the above', missionCount === 0, `${missionCount} missions`);

  const inspectorSrc = read('apps/desktop/src/environment/NodeInspector.tsx');
  const panelSrc = inspectorSrc.slice(inspectorSrc.indexOf('function InstallPanel'));
  // The word "Mission Control" appears in the panel's own explanation of
  // the bug it fixes, so match on *navigation*, not on prose.
  const panelCode = panelSrc
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
  check('D5  the install panel performs no navigation at all',
    !/navigate|useNavigate|setScreen|openProjectDetail|href=|router/i.test(panelCode));
  check('D6  the install panel imports no mission module',
    !/from '.*mission/i.test(inspectorSrc));

  /* ══ [E] The installer really runs ════════════════════════════ */
  section('[E] The install executes, and stops at the OS privilege boundary');

  check('E1  the executor ran and produced an InstallResult',
    !!clicked.output && typeof clicked.output === 'object' && 'installOutcome' in clicked.output,
    clicked.output ? `installOutcome ${clicked.output.installOutcome}` : 'no output');
  check('E2  a root-tier install is handed to the user, not escalated',
    clicked.output?.installOutcome === 'guided' && clicked.output?.privilege === 'root',
    `${clicked.output?.installOutcome} / ${clicked.output?.privilege}`);
  check('E3  the command is shown so the user can run it themselves',
    typeof clicked.output?.command === 'string' && clicked.output.command.length > 0, clicked.output?.command);
  // `attempts` counts executor runs, and the executor DID run — it planned,
  // saw root privilege and refused. What must be true is that nothing was
  // executed, which the payload states and the machine confirms.
  check('E4  the root-tier plan was handed back, not run',
    clicked.output?.requiresUserAction === true && /^sudo /.test(clicked.output?.command ?? ''),
    `requiresUserAction ${clicked.output?.requiresUserAction}`);
  const probe = await (await fetch(`${API}/environment/probe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'terraform', refresh: true }),
  })).json();
  check('E4b RUNTIME — the tool is still absent, so nothing was installed',
    probe?.result?.present === false, `present ${probe?.result?.present}`);

  const trail = await audit();
  const directRecords = trail.filter((r) => r.capabilityId === 'system.install' && r.decisionRule === 'user-direct');
  check('E5  the direct action is in the audit trail, labelled as such',
    directRecords.length >= 2, `${directRecords.length} user-direct records`);
  check('E6  governed and direct records are distinguishable',
    trail.some((r) => r.decisionRule === 'system-floor') && directRecords.length > 0);

  if (process.env.AURA_INSTALL_LIVE === '1') {
    const live = await invoke('system.install', { nodeId: 'pnpm' }, { token: TOKEN });
    check('E7  LIVE — a userspace install runs and verifies by read-back',
      live.output?.installOutcome === 'installed', `installOutcome ${live.output?.installOutcome}`);
  } else {
    skip('E7  a userspace install completes end to end',
      'would install software on this machine — set AURA_INSTALL_LIVE=1 to run it');
  }

  /* ══ [F] The UI reports state honestly ════════════════════════ */
  section('[F] Progress, success and failure are all visible in place');

  check('F1  there is an Installing… state', /Installing \$\{node\.entry\.name\}…/.test(inspectorSrc));
  check('F2  failure offers a retry', /data-testid="node-install-retry"/.test(inspectorSrc));
  check('F3  retry covers error, failed and unverified',
    /retryable\s*=[\s\S]{0,200}?!!error[\s\S]{0,120}?'failed'[\s\S]{0,60}?'unverified'/.test(inspectorSrc));
  check('F4  success refreshes the environment automatically',
    /installOutcome === 'installed'\) void rescan\(true\)/.test(inspectorSrc));
  check('F5  NEGATIVE — a guided or unverified result does NOT refresh',
    count(inspectorSrc, /void rescan\(/g) === 1, `${count(inspectorSrc, /void rescan\(/g)} rescan call sites`);
  check('F6  the user is no longer told to scan again by hand',
    !/Scan again to bring it onto the canvas/.test(inspectorSrc));

  /* ══ [G] One installation authority ═══════════════════════════ */
  section('[G] No second installer was created');

  const executorsSrc = read('packages/ai-service/src/fabric/executors.ts');
  const manifestSrc = read('packages/capability-fabric/src/manifest.ts');
  const installSrc = read('packages/ai-service/src/exec/install.ts');
  const libSrc = read('apps/desktop/src-tauri/src/lib.rs');

  check('G1  exactly one system.install executor', count(executorsSrc, /capabilityId: 'system\.install'/g) === 1);
  check('G2  exactly one system.install capability definition', count(manifestSrc, /id: 'system\.install'/g) === 1);
  check('G3  exactly one install planner', count(installSrc, /export function planInstall/g) === 1);
  // The planner does spawn once — `npm config get prefix`, a read-only
  // probe used to decide whether a userspace install is even possible.
  // What must never appear is an install verb.
  const plannerSpawns = installSrc.match(/execFileSync\(/g) ?? [];
  check('G4  the planner spawns only the npm prefix probe',
    plannerSpawns.length === 1 && /npm config get prefix|'config', 'get', 'prefix'/.test(installSrc),
    `${plannerSpawns.length} spawn site(s)`);
  check('G4b the planner never runs an install verb',
    !/execFileSync\([^)]*['"](install|add|-S|-Sy)['"]/.test(installSrc));
  const uiTokenFn = (libSrc.match(/fn ui_token\(\)[\s\S]*?\n\}/) ?? [''])[0];
  check('G5  the Rust shell gained a token reader, not an installer',
    /fn ui_token\(\)/.test(libSrc) &&
    !/Command|spawn|install/i.test(uiTokenFn) &&
    /read_to_string/.test(uiTokenFn),
    `${uiTokenFn.split('\n').length} lines, read-only`);

  const fabricClientSrc = read('apps/desktop/src/ai/fabricClient.ts');
  check('G6  invokeAsUser is a separate, deliberate method',
    /invokeAsUser: async \(/.test(fabricClientSrc) && /invoke: \(/.test(fabricClientSrc));

  const uiCallers = fs
    .readdirSync(path.join(ROOT, 'apps/desktop/src'), { recursive: true })
    .filter((f) => typeof f === 'string' && /\.tsx?$/.test(f))
    .filter((f) => read(path.join('apps/desktop/src', f)).includes('invokeAsUser('));
  check('G7  only the install button uses the direct channel',
    uiCallers.length === 1 && uiCallers[0].endsWith('NodeInspector.tsx'), uiCallers.join(', ') || 'none');
} catch (e) {
  check('suite completed', false, e.message);
} finally {
  if (child) child.kill('SIGTERM');
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(failed ? '\nINSTALL UX: FAIL' : '\nINSTALL UX: PASS');
process.exit(failed ? 1 : 0);
