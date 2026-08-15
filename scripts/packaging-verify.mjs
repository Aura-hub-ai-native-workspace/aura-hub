/**
 * packaging-verify — does the PACKAGED application actually work?
 * ==================================================================
 * "Electron compiled" / "cargo finished" is not evidence. This suite
 * launches the real bundled artifact and drives it, because every
 * interesting packaging bug lives in the gap between "it builds" and
 * "it runs somewhere that isn't the repository":
 *
 *   • resources resolved from the packaged tree, not the source tree
 *   • a service started by the app itself, not by a developer
 *   • a PATH a desktop launcher gives a GUI process, not a login shell
 *   • user state under ~/.aura, not inside the installed app
 *   • no orphaned service after the window closes
 *
 * The application is launched from OUTSIDE the repository with a
 * deliberately hostile environment (minimal PATH, unset npm/dev vars) so
 * that any surviving dependency on the developer's shell shows up here
 * rather than on a user's machine.
 *
 * Nothing here is simulated. If the artifact is missing, this fails —
 * it never falls back to testing the dev tree and calling it packaging.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = '/home/Groot/aura-hub';
const PORT = Number(process.env.AURA_VERIFY_PORT ?? 4319);
const BUNDLE_DIR = `${REPO}/apps/desktop/src-tauri/target/release/bundle`;

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const info = (m) => console.log(`      ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, ms = 4000) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: ac.signal });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    return { status: 0, body: null, error: e.message };
  } finally {
    clearTimeout(t);
  }
};
const post = async (p, body, ms = 240000) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}), signal: ac.signal,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    return { status: 0, body: null, error: e.message };
  } finally {
    clearTimeout(t);
  }
};

const portOwners = () => {
  const r = spawnSync('ss', ['-ltnp', `sport = :${PORT}`], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
};
const pidsOnPort = () => {
  const out = portOwners();
  return [...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
};

/* ── 0. the artifact must exist ───────────────────────────────────── */

console.log('=== 0. PACKAGED ARTIFACT ===');

const appImages = existsSync(`${BUNDLE_DIR}/appimage`)
  ? execFileSync('find', [`${BUNDLE_DIR}/appimage`, '-name', '*.AppImage', '-type', 'f'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
  : [];
const debs = existsSync(`${BUNDLE_DIR}/deb`)
  ? execFileSync('find', [`${BUNDLE_DIR}/deb`, '-name', '*.deb', '-type', 'f'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
  : [];

check('0a. an AppImage was produced', appImages.length > 0, appImages[0] ?? 'none found');
check('0b. a .deb was produced', debs.length > 0, debs[0] ?? 'none found');
if (appImages[0]) info(`AppImage size: ${(statSync(appImages[0]).size / 1024 / 1024).toFixed(1)} MB`);

if (!appImages.length) {
  console.log('\nRESULT: FAILED (no packaged artifact to test — run `npm run desktop:build`)');
  process.exit(1);
}
const APPIMAGE = appImages[0];

/* ── 1. the packaged binary must carry its own service ────────────── */

console.log('\n=== 1. PACKAGED RESOURCES ===');

// Extract rather than trust the build log: the question is what is inside
// the shipped file, not what the build intended to put there.
const extractDir = mkdtempSync(path.join(tmpdir(), 'aura-appimage-'));
const extract = spawnSync(APPIMAGE, ['--appimage-extract'], { cwd: extractDir, encoding: 'utf8', timeout: 120000 });
const squash = path.join(extractDir, 'squashfs-root');
check('1a. the AppImage extracts', extract.status === 0 && existsSync(squash),
  extract.status === 0 ? '' : (extract.stderr ?? '').slice(0, 120));

const findIn = (root, name) => {
  const r = spawnSync('find', [root, '-name', name, '-type', 'f'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim().split('\n').filter(Boolean);
};
const packagedService = existsSync(squash) ? findIn(squash, 'ai-service.mjs') : [];
check('1b. the AI service is packaged inside the artifact', packagedService.length > 0,
  packagedService[0]?.replace(squash, '…') ?? 'not found');

// A packaged app that ships the developer's secrets or projects is a
// serious defect, so look rather than assume.
const leaked = existsSync(squash)
  ? [...findIn(squash, '.env'), ...findIn(squash, '*.pem'), ...findIn(squash, 'policy.json')]
  : [];
check('1c. no secrets or user state were bundled', leaked.length === 0,
  leaked.length ? leaked.join(' ') : 'no .env / keys / policy in the bundle');

/**
 * Exactly one `node_modules` is legitimate: the staged TypeScript runtime
 * the service genuinely imports (see build-service-bundle.mjs). Anything
 * else would be a development tree that leaked into the package, so this
 * asserts the specific allowed path rather than the absence of the name.
 */
const nodeModuleDirs = existsSync(squash)
  ? spawnSync('find', [squash, '-name', 'node_modules', '-type', 'd'], { encoding: 'utf8' })
      .stdout.trim().split('\n').filter(Boolean)
  : [];
const unexpectedModules = nodeModuleDirs.filter((d) => !d.endsWith('/resources/node_modules'));
check('1d. no development tree was packaged', unexpectedModules.length === 0,
  unexpectedModules.length
    ? unexpectedModules.map((d) => d.replace(squash, '…')).join(' ')
    : `only the staged runtime dependency (${nodeModuleDirs.length} node_modules)`);

const stagedPkgs = existsSync(`${squash}/usr/lib/AURA Hub/resources/node_modules`)
  ? spawnSync('ls', [`${squash}/usr/lib/AURA Hub/resources/node_modules`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
  : [];
check('1e. only the declared runtime dependency is staged',
  stagedPkgs.length === 1 && stagedPkgs[0] === 'typescript', stagedPkgs.join(', ') || 'none');

/* ── 2. launch from outside the repo, with a hostile environment ──── */

console.log('\n=== 2. LAUNCH OUTSIDE THE REPOSITORY ===');

const before = pidsOnPort();
if (before.length) {
  console.log(`\nA service is already listening on ${PORT} (pid ${before.join(',')}).`);
  console.log('This suite must own the port to test startup honestly. Stop it and re-run.');
  process.exit(1);
}

const runDir = mkdtempSync(path.join(tmpdir(), 'aura-run-'));
const auraHome = mkdtempSync(path.join(tmpdir(), 'aura-home-'));

/**
 * The environment a desktop launcher actually provides: no npm_*, no
 * NODE_*, no repo cwd, and a PATH that does NOT include the user's tool
 * directories. If AURA still finds its tools from here, the PATH seeding
 * in the shell works; if it only worked from a developer shell, this is
 * where that shows.
 */
const launchEnv = {
  HOME: process.env.HOME,
  USER: process.env.USER,
  DISPLAY: process.env.DISPLAY ?? ':0',
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`,
  XAUTHORITY: process.env.XAUTHORITY ?? '',
  PATH: '/usr/bin:/bin',
  AURA_HOME: auraHome,
  AI_PORT: String(PORT),
};

info(`cwd     : ${runDir} (outside the repository)`);
info(`PATH    : ${launchEnv.PATH} (deliberately minimal)`);
info(`AURA_HOME: ${auraHome}`);

const app = spawn(APPIMAGE, [], {
  cwd: runDir,
  env: launchEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let appOut = '';
app.stdout.on('data', (d) => { appOut += d; });
app.stderr.on('data', (d) => { appOut += d; });

let appExited = null;
app.on('exit', (code, signal) => { appExited = signal ?? code; });

/* ── 3. the service must come up, started by the app ──────────────── */

console.log('\n=== 3. SERVICE LIFECYCLE ===');

let ready = false;
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  const h = await api('/health');
  if (h.status === 200 && h.body?.health) { ready = true; break; }
  if (appExited !== null) break;
  await sleep(1000);
}

check('3a. the packaged application started its own AI service', ready,
  ready ? `healthy on ${PORT}` : `not healthy${appExited !== null ? ` — app exited (${appExited})` : ''}${appOut ? `: ${appOut.slice(0, 200)}` : ''}`);

if (!ready) {
  console.log(`\napp output:\n${appOut.slice(0, 2000)}`);
  try { process.kill(-app.pid, 'SIGKILL'); } catch { /* already gone */ }
  console.log('\nRESULT: FAILED');
  process.exit(1);
}

const servicePids = pidsOnPort();
check('3b. the service is a child of the packaged app, not a leftover',
  servicePids.length > 0 && !servicePids.some((p) => before.includes(p)),
  `pid ${servicePids.join(',')}`);

/**
 * The window is configured hidden and shown only after the health gate,
 * so a real mapped window is evidence that the gate opened AND that the
 * renderer loaded far enough to be displayed.
 *
 * Note the ordering claim this can and cannot make: it proves the window
 * appeared after health, because health was already observed above.
 */
/**
 * Matched by OWNING PROCESS, not by title.
 *
 * Title matching is unsafe on a real desktop: any browser tab or editor
 * showing the words "AURA Hub" produces a window that looks like a pass.
 * The question is whether the process we launched mapped a window, so ask
 * exactly that — `wmctrl -lp` reports each window's pid.
 */
const windowsOf = (pid) =>
  (spawnSync('wmctrl', ['-lp'], { encoding: 'utf8' }).stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => Number(f[2]) === pid);

let auraWindow = null;
const winDeadline = Date.now() + 30000;
while (Date.now() < winDeadline) {
  const own = windowsOf(app.pid);
  if (own.length) { auraWindow = own[0]; break; }
  await sleep(1000);
}
check('3d. the launched process maps a real application window', !!auraWindow,
  auraWindow ? `pid=${app.pid} title="${auraWindow.slice(4).join(' ')}"` : `no window owned by pid ${app.pid}`);
check('3e. the window is titled as AURA Hub',
  !!auraWindow && auraWindow.slice(4).join(' ').includes('AURA Hub'),
  auraWindow ? auraWindow.slice(4).join(' ') : 'n/a');

const health = await api('/health');
check('3c. health reports a real provider/index state', !!health.body?.index,
  `index=${health.body?.index?.phase ?? 'none'} provider=${health.body?.key?.fingerprint ?? 'none'}`);

/* ── 4. the governed stack must work from the packaged app ────────── */

console.log('\n=== 4. GOVERNED STACK ===');

const caps = await api('/fabric/capabilities');
check('4a. the Capability Fabric answers', caps.status === 200 && Array.isArray(caps.body?.capabilities),
  `${caps.body?.capabilities?.length ?? 0} capabilities`);
check('4b. the policy engine is present with its risk defaults', !!caps.body?.policy?.byRisk,
  `byRisk.high=${caps.body?.policy?.byRisk?.high} allowAutonomous=${caps.body?.policy?.allowAutonomous}`);

const scan = await post('/environment/scan', { refresh: true }, 180000);
const results = scan.body?.results ?? {};
const probed = Object.keys(results);
// `present` is the probe's own verdict — a binary that answered a version
// check. Nothing here infers presence from the catalogue.
const present = probed.filter((id) => results[id]?.present);
check('4c. the environment scan runs in the packaged app', scan.status === 200 && probed.length > 0,
  `${probed.length} catalogue entries probed`);
check('4d. real installed tools were detected', present.length > 0,
  `${present.length} present, e.g. ${present.slice(0, 8).join(', ')}`);

/**
 * The PATH question, asked precisely. OpenCode lives in ~/.opencode/bin,
 * which is NOT in the minimal PATH this app was launched with — so its
 * detection is only possible if the desktop shell seeded PATH for the
 * service. This is the check that would have caught a packaged app whose
 * Connected Environment silently went dark.
 */
const opencode = results.opencode;
check('4e. a tool outside the launcher PATH is still detected (PATH seeding works)',
  !!opencode?.present,
  `opencode present=${!!opencode?.present}${opencode?.version ? ` ${opencode.version}` : ''} — ${(opencode?.detail ?? '').slice(0, 90)}`);

check('4f. detection reports real parsed versions, not placeholders',
  !!results.git?.version && /\d+\.\d+/.test(results.git.version), `git=${results.git?.version ?? 'none'}`);

check('4g. a genuinely absent tool is reported absent, not faked',
  Object.entries(results).some(([, r]) => r?.present === false),
  `${probed.length - present.length} reported absent`);

/* ── 5. governed execution end to end ─────────────────────────────── */

console.log('\n=== 5. GOVERNED EXECUTION ===');

/**
 * A capability needs somewhere to act. The packaged app starts with an
 * empty project registry (correctly — it is a fresh AURA_HOME), so give
 * it a real, disposable project first. That also makes this a test of
 * project confinement: the invocation acts inside the registered project,
 * not in whatever directory the app happened to be launched from.
 */
const projectPath = path.join(runDir, 'packaged-project');
execFileSync('mkdir', ['-p', path.join(projectPath, 'src')]);
execFileSync('git', ['-C', projectPath, 'init', '-q']);
execFileSync('sh', ['-c', `echo 'export const add=(a,b)=>a+b' > ${projectPath}/src/calc.js`]);

const created = await post('/projects', { path: projectPath, name: 'packaged-project' });
const projectId = created.body?.project?.id ?? created.body?.id;
check('5a. the packaged app can register a real project', !!projectId,
  projectId ? `${projectId} → ${projectPath}` : JSON.stringify(created.body).slice(0, 140));

const inv = await post('/fabric/invoke', {
  capabilityId: 'git.status',
  input: {},
  context: { actor: { kind: 'human', id: 'packaging-verify' }, projectId },
});
check('5a2. a low-risk capability really executes in the packaged app',
  inv.body?.outcome === 'succeeded',
  `outcome=${inv.body?.outcome ?? inv.error} detail=${(inv.body?.detail ?? '').slice(0, 110)}`);
/**
 * Attribution is read from the AUDIT record, not from executor output.
 *
 * Only executors that drive a named node self-report one (agent.delegate
 * does); for the rest the Fabric records the node it resolved and actually
 * ran on. `executedNodeId` is the field that means "this node did the
 * work" — see §22/§23 — so that is what a packaging test should assert.
 */
const invAudit = ((await api('/fabric/audit')).body?.audit ?? [])
  .find((r) => r.invocationId === inv.body?.invocationId);
check('5b. execution is attributed to the real node that performed it',
  invAudit?.executedNodeId === 'git',
  `executedNodeId=${invAudit?.executedNodeId ?? 'none'} requested=${invAudit?.requestedNodeId ?? 'none'} rule=${inv.body?.policy?.rule}`);

const gated = await post('/fabric/invoke', {
  capabilityId: 'agent.delegate',
  input: { task: 'packaging verification — must be gated, never executed' },
  context: { actor: { kind: 'human', id: 'packaging-verify' }, projectId, nodeId: 'opencode' },
});
check('5c. a high-risk capability is still gated by approval in the packaged app',
  gated.body?.outcome === 'awaiting-approval' && gated.body?.attempts === 0,
  `outcome=${gated.body?.outcome} rule=${gated.body?.policy?.rule} attempts=${gated.body?.attempts}`);
check('5d. the gate is the non-configurable floor, not a risk default',
  gated.body?.policy?.rule === 'irreversible-floor', `rule=${gated.body?.policy?.rule}`);

const approvals = await api('/fabric/approvals');
check('5e. the approval request was recorded',
  (approvals.body?.approvals ?? []).some((a) => a.state === 'pending'),
  `${(approvals.body?.approvals ?? []).length} request(s)`);

const audit = await api('/fabric/audit');
const auditRows = audit.body?.audit ?? [];
check('5f. the audit log records the packaged app\'s invocations',
  auditRows.some((r) => r.capabilityId === 'git.status'),
  `${auditRows.length} record(s)`);

/* ── 6. user state stays outside the installation ─────────────────── */

console.log('\n=== 6. USER STATE LOCATION ===');

const wroteHome = existsSync(auraHome) && spawnSync('find', [auraHome, '-type', 'f'], { encoding: 'utf8' }).stdout.trim();
check('6a. state is written under AURA_HOME, not the app directory', !!wroteHome,
  wroteHome ? `${wroteHome.split('\n').length} file(s) under ${auraHome}` : 'nothing written');

const wroteIntoBundle = spawnSync('find', [squash, '-newer', APPIMAGE, '-type', 'f'], { encoding: 'utf8' }).stdout.trim();
check('6b. nothing was written into the extracted application tree', !wroteIntoBundle,
  wroteIntoBundle ? wroteIntoBundle.split('\n').slice(0, 3).join(' ') : 'installation tree untouched');

const logFile = path.join(auraHome, 'logs', 'ai-service.log');
check('6c. the service log lives under AURA_HOME', existsSync(logFile),
  existsSync(logFile) ? `${(statSync(logFile).size / 1024).toFixed(1)} KB` : 'no log written');

/* ── 7. no renderer escape hatch ──────────────────────────────────── */

console.log('\n=== 7. RENDERER CONFINEMENT ===');

const conf = JSON.parse(readFileSync(`${REPO}/apps/desktop/src-tauri/tauri.conf.json`, 'utf8'));
const capsFile = JSON.parse(readFileSync(`${REPO}/apps/desktop/src-tauri/capabilities/default.json`, 'utf8'));
const libRs = readFileSync(`${REPO}/apps/desktop/src-tauri/src/lib.rs`, 'utf8');

// The webview has no Node runtime at all in this shell, so the relevant
// question is which Rust commands the renderer may call.
const exposed = [...libRs.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?fn\s+(\w+)/g)].map((m) => m[1]);
info(`commands exposed to the renderer: ${exposed.join(', ')}`);
check('7a. no shell/exec command is exposed to the renderer',
  !exposed.some((c) => /shell|exec|spawn|command|run_/i.test(c)), exposed.join(', '));
/**
 * Process spawning must be unreachable from the renderer. Checked by
 * where the capability lives, not by a keyword: `Command::new` may exist
 * in the service supervisor (it has to — it starts the service), but it
 * must not appear in any function the renderer can invoke.
 */
const serviceRs = readFileSync(`${REPO}/apps/desktop/src-tauri/src/service.rs`, 'utf8');
const commandBlocks = libRs.split('#[tauri::command]').slice(1);
const spawnInExposed = commandBlocks.filter((b) => /Command::new|std::process/.test(b));
check('7b. no renderer-invokable command can spawn a process',
  spawnInExposed.length === 0,
  spawnInExposed.length ? 'a #[tauri::command] contains a spawn' : `${commandBlocks.length} commands, none spawn`);

// And the one spawn that does exist must run a resolved interpreter, never
// something a caller supplied.
const spawnsResolvedOnly = /Command::new\(&node\)/.test(serviceRs)
  && (serviceRs.match(/Command::new/g) ?? []).length === 1;
check('7b2. the only process the shell starts is the resolved Node interpreter',
  spawnsResolvedOnly, `${(serviceRs.match(/Command::new/g) ?? []).length} spawn site(s) in service.rs`);

// Every filesystem command must pass through the confinement guard —
// checked per command body, not by asking whether the guard exists at all.
const fsCommands = commandBlocks.filter((b) => /fn\s+code_\w+/.test(b));
const unguarded = fsCommands.filter((b) => !/resolve_within_root/.test(b));
check('7c. every filesystem command is root-confined',
  fsCommands.length > 0 && unguarded.length === 0,
  `${fsCommands.length} fs command(s), ${unguarded.length} unguarded`);
check('7d. the capability ACL grants only core defaults',
  JSON.stringify(capsFile.permissions) === JSON.stringify(['core:default']),
  JSON.stringify(capsFile.permissions));
check('7e. the window is not shown before the service is ready',
  conf.app.windows[0].visible === false, `visible=${conf.app.windows[0].visible}`);

/* ── 8. port conflict handling ────────────────────────────────────── */

console.log('\n=== 8. PORT CONFLICT ===');

// A second instance must find AURA already there and reuse it rather than
// starting a competing service.
const secondPidsBefore = pidsOnPort();
const second = spawn(APPIMAGE, [], { cwd: runDir, env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let secondOut = '';
second.stdout.on('data', (d) => { secondOut += d; });
second.stderr.on('data', (d) => { secondOut += d; });
await sleep(15000);
const secondPidsAfter = pidsOnPort();
check('8a. a second instance reuses the running service instead of starting another',
  secondPidsAfter.length === secondPidsBefore.length
  && secondPidsAfter.every((p) => secondPidsBefore.includes(p)),
  `owners before=[${secondPidsBefore.join(',')}] after=[${secondPidsAfter.join(',')}]`);
info(secondOut ? `second instance said: ${secondOut.slice(0, 160).replace(/\n/g, ' ')}` : 'second instance printed nothing');
try { process.kill(second.pid, 'SIGTERM'); } catch { /* gone */ }
await sleep(2000);
check('8b. closing the second instance leaves the first service running',
  (await api('/health')).status === 200, 'service still healthy');

/* ── 9. shutdown leaves nothing behind ────────────────────────────── */

console.log('\n=== 9. SHUTDOWN ===');

const pidsBeforeQuit = pidsOnPort();

/**
 * Signal ONLY the shell, never the process group.
 *
 * Killing the group would take the service down directly, and this check
 * would then pass even if the shell's shutdown path did nothing at all —
 * the test would be proving its own signal rather than the application's
 * behaviour. Signalling just the shell means the service survives unless
 * the shell genuinely takes it down.
 */
try { process.kill(app.pid, 'SIGTERM'); } catch { /* gone */ }

let gone = false;
const quitDeadline = Date.now() + 30000;
while (Date.now() < quitDeadline) {
  await sleep(1000);
  if (pidsOnPort().length === 0) { gone = true; break; }
}
check('9a. quitting the app shuts its service down', gone,
  gone ? 'port released' : `still held by pid ${pidsOnPort().join(',')}`);

const survivors = pidsBeforeQuit.filter((p) => {
  try { process.kill(p, 0); return true; } catch { return false; }
});
check('9b. no orphaned service process is left behind', survivors.length === 0,
  survivors.length ? `orphans: ${survivors.join(',')}` : 'none');

const healthAfter = await api('/health', 2000);
check('9c. the service is genuinely gone, not just unreferenced',
  healthAfter.status === 0, `status=${healthAfter.status}`);

/* ── 8c. a FOREIGN process on the port ────────────────────────────── */

/**
 * The dangerous case, and the reason the shell fingerprints rather than
 * probes. Something else owns 4319. AURA must not adopt it (it would be
 * sending project paths and capability invocations to an unknown local
 * server), and must not kill it (it was here first). It must refuse and
 * say why.
 *
 * The impostor deliberately answers `/health` with a 200 and JSON, which
 * is exactly what a naive "is the port alive?" check would accept.
 */
console.log('\n=== 8c. FOREIGN PROCESS ON THE PORT ===');

const impostorSrc = path.join(runDir, 'impostor.mjs');
execFileSync('sh', ['-c',
  `cat > ${impostorSrc} <<'EOF'
import http from 'node:http';
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ health: { ok: true }, service: 'definitely-not-aura' }));
}).listen(${PORT}, '127.0.0.1');
EOF`]);

const impostor = spawn(process.execPath, [impostorSrc], { cwd: runDir, stdio: 'ignore', detached: true });
await sleep(3000);
const impostorPid = impostor.pid;
check('8c1. the impostor holds the port', pidsOnPort().includes(impostorPid),
  `pid ${impostorPid} on ${PORT}`);

const blocked = spawn(APPIMAGE, [], { cwd: runDir, env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let blockedOut = '';
blocked.stdout.on('data', (d) => { blockedOut += d; });
blocked.stderr.on('data', (d) => { blockedOut += d; });
await sleep(25000);

let impostorAlive = true;
try { process.kill(impostorPid, 0); } catch { impostorAlive = false; }
check('8c2. AURA did NOT kill the process that owned the port', impostorAlive,
  impostorAlive ? `pid ${impostorPid} still running` : 'the impostor was killed — unacceptable');

check('8c3. AURA did not attach to the unidentified service',
  pidsOnPort().length === 1 && pidsOnPort()[0] === impostorPid,
  `port owners: [${pidsOnPort().join(',')}]`);

check('8c4. AURA reported the conflict in plain language',
  /in use by another program/i.test(blockedOut),
  blockedOut.replace(/\n/g, ' ').match(/AURA Hub: .{0,150}/)?.[0] ?? (blockedOut.slice(0, 150) || '(no output)'));

try { process.kill(blocked.pid, 'SIGTERM'); } catch { /* gone */ }
try { process.kill(impostorPid, 'SIGTERM'); } catch { /* gone */ }
await sleep(3000);

/* ── cleanup ──────────────────────────────────────────────────────── */

try { rmSync(extractDir, { recursive: true, force: true }); } catch { /* best effort */ }
try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ }
try { rmSync(auraHome, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\nRESULT: ${failed ? 'FAILED' : 'ALL CHECKS PASSED'}`);
process.exit(failed ? 1 : 0);
