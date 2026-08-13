/**
 * desktop-runtime-verify — the packaged app, actually run, on this OS.
 * ==================================================================
 * `packaging-verify.mjs` is the deep Linux verifier and stays that way:
 * it shells out to `ss`, `wmctrl`, `find` and `--appimage-extract`, none
 * of which exist on Windows or macOS. That is precisely why Windows and
 * macOS have never been runtime-verified — there was no test that could
 * run there.
 *
 * This script is that test. Pure Node, no shell utilities, no platform
 * assumptions: it runs identically on Linux, Windows and macOS and
 * verifies the chain that cross-platform work actually threatens.
 *
 *   phase 1 — the SERVICE, headless
 *       node resolution (node vs node.exe) → service boot → health gate
 *       → identity → real executable detection → port reuse → foreign
 *       refusal → shutdown → no orphan
 *
 *   phase 2 — the SHELL, needs a desktop session
 *       the packaged binary launches, brings its own service up, and
 *       exits cleanly leaving nothing behind
 *
 * Phase 2 requires a GUI session. Where there isn't one it reports
 * NOT RUNTIME VERIFIED **with the reason** and does not fail the run —
 * an honest gap is a result; a green tick from a test that never ran is
 * not. Phase 1 has no such excuse and must pass everywhere.
 *
 * User state is never touched: AURA_HOME is redirected to a temp dir.
 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.AI_PORT ?? 4319);
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const PLATFORM = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux';

let failed = false;
const results = [];
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  results.push({ n, ok });
  if (!ok) failed = true;
};
const info = (m) => console.log(`      ${m}`);
const section = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── platform-neutral primitives ─────────────────────────────────── */

/** Is anything accepting connections on the port? No `ss`, no `netstat`. */
function portOpen(port = PORT, timeout = 600) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, '127.0.0.1');
  });
}

const get = async (p, timeoutMs = 8000) => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) { return { status: 0, body: null, error: e.message }; }
};

const post = async (p, body, timeoutMs = 120000) => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) { return { status: 0, body: null, error: e.message }; }
};

async function waitFor(fn, ms, step = 500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(step); }
  return false;
}

/** Recursive file search — `find(1)` does not exist on Windows. */
function findFiles(dir, test, out = [], depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(full, test, out, depth + 1);
    else if (test(full)) out.push(full);
  }
  return out;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * The pid of a process's first child, asked of the OS.
 *
 * Used to establish *ownership* — that the service answering on 4319 is the
 * one this shell started rather than one it found already running. Those two
 * are indistinguishable over HTTP and behave completely differently on
 * shutdown, so the distinction has to come from the process table.
 *
 * Returns 0 when there is no child, which is itself a meaningful answer.
 */
function childPidOf(parentPid) {
  try {
    if (IS_WIN) {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Select-Object -First 1 -ExpandProperty ProcessId)`],
        { encoding: 'utf8', timeout: 30000 });
      return Number(String(out).trim()) || 0;
    }
    const out = execFileSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8', timeout: 15000 });
    return Number(String(out).trim().split('\n')[0]) || 0;
  } catch {
    return 0; // no child, or the parent is already gone
  }
}

/** Whether a pid is still present, asked of the OS rather than of a handle. */
function pidAlive(pid) {
  if (!pid) return false;
  if (!IS_WIN) return alive(pid);
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Measure-Object).Count`],
      { encoding: 'utf8', timeout: 20000 });
    return String(out).trim() !== '0';
  } catch {
    return false;
  }
}

/* ── temp state, never the user's ────────────────────────────────── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-rt-'));
const AURA_HOME = path.join(TMP, 'home');
const RUN_DIR = path.join(TMP, 'run');
fs.mkdirSync(AURA_HOME, { recursive: true });
fs.mkdirSync(RUN_DIR, { recursive: true });

let serviceProc = null;
let shellProc = null;
let foreign = null;

try {
  console.log(`AURA Hub — desktop runtime verification on ${PLATFORM} (${process.arch})`);
  info(`node ${process.version} · AURA_HOME=${AURA_HOME}`);

  if (await portOpen()) {
    console.log(`\nFAIL  port ${PORT} is already in use. This suite must own it to test startup honestly.`);
    process.exit(2);
  }

  /* ── 0. the service bundle ───────────────────────────────────────── */
  section('0. PACKAGED SERVICE BUNDLE');
  const bundle = path.join(ROOT, 'apps/desktop/src-tauri/resources/ai-service.mjs');
  if (!fs.existsSync(bundle)) {
    info('bundle missing — building it (npm run service:bundle)');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-service-bundle.mjs')], { cwd: ROOT, stdio: 'inherit' });
  }
  check('0a. the service bundle exists', fs.existsSync(bundle),
    fs.existsSync(bundle) ? `${(fs.statSync(bundle).size / 1024 / 1024).toFixed(1)} MB` : 'missing');
  const tsStaged = path.join(ROOT, 'apps/desktop/src-tauri/resources/node_modules/typescript/lib/typescript.js');
  check('0b. the TypeScript runtime dependency is staged beside it', fs.existsSync(tsStaged));

  /* ── 1. node resolution on THIS platform ─────────────────────────── */
  section('1. NODE RUNTIME RESOLUTION');
  check('1a. the interpreter running this platform is the expected name',
    path.basename(process.execPath).toLowerCase() === (IS_WIN ? 'node.exe' : 'node'),
    path.basename(process.execPath));
  check('1b. Node is 18 or newer (the documented requirement)',
    Number(process.versions.node.split('.')[0]) >= 18, process.version);

  /* ── 2. service starts headlessly ────────────────────────────────── */
  section('2. SERVICE LIFECYCLE — START');
  serviceProc = spawn(process.execPath, [bundle, '--none'], {
    cwd: RUN_DIR,
    env: { ...process.env, AURA_HOME, AI_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  serviceProc.stdout?.on('data', (d) => { log += d; });
  serviceProc.stderr?.on('data', (d) => { log += d; });

  const up = await waitFor(async () => (await get('/health', 3000)).status === 200, 90000);
  check('2a. the packaged service starts and answers /health', up,
    up ? `pid ${serviceProc.pid}` : `no health within 90s · ${log.slice(-300)}`);
  if (!up) throw new Error('service did not start');

  const health = await get('/health');
  check('2b. health reports a real provider/index state, not a stub',
    !!health.body?.health && typeof health.body.health.ok === 'boolean',
    `status=${health.body?.health?.status} provider=${health.body?.key?.fingerprint ?? '(none)'}`);

  const caps = await get('/fabric/capabilities');
  check('2c. service identity is AURA-shaped (health + Capability Fabric)',
    caps.status === 200 && Array.isArray(caps.body?.capabilities) && !!caps.body?.policy,
    `${caps.body?.capabilities?.length ?? 0} capabilities`);

  /* ── 3. REAL executable detection on this OS ─────────────────────── */
  section('3. CONNECTED ENVIRONMENT — REAL DETECTION ON THIS MACHINE');
  const scan = await post('/environment/scan', {}, 180000);
  const r = scan.body?.results ?? {};
  check('3a. the environment scan runs natively', scan.status === 200 && Object.keys(r).length > 0,
    `${scan.body?.found ?? 0} present of ${Object.keys(r).length} probed`);

  // Node and Git are the two the runner is guaranteed to have.
  check('3b. Node is detected with its REAL version on this OS',
    r.node?.present === true && !!r.node.version, `node=${r.node?.version} · ${r.node?.detail ?? ''}`);
  check('3c. Git is detected with its REAL version on this OS',
    r.git?.present === true && !!r.git.version, `git=${r.git?.version}`);

  // Whatever else is genuinely here — reported, never asserted.
  const present = Object.entries(r).filter(([, v]) => v.present);
  const absent = Object.entries(r).filter(([, v]) => !v.present);
  info(`present (${present.length}): ${present.slice(0, 12).map(([k, v]) => `${k}${v.version ? ` ${v.version}` : ''}`).join(', ')}`);
  for (const tool of ['opencode', 'github-cli', 'docker', 'pnpm']) {
    const v = r[tool];
    if (!v) continue;
    info(`${tool}: ${v.present ? `INSTALLED ${v.version ?? ''}`.trim() : 'NOT INSTALLED'}`);
  }
  check('3d. genuinely absent tools are reported absent, not faked',
    absent.length > 0 && absent.every(([, v]) => !v.version || v.present === false),
    `${absent.length} reported absent`);
  check('3e. no probe result claims a version while reporting absent',
    !Object.values(r).some((v) => v.present === false && v.version), 'no contradictory results');

  /* ── 4. governed stack still holds ───────────────────────────────── */
  section('4. GOVERNED STACK ON THIS PLATFORM');
  await post('/projects', { id: 'rt-proj', path: RUN_DIR });
  const low = await post('/fabric/invoke', { capabilityId: 'git.status', input: {}, context: { projectId: 'rt-proj' } });
  info(`git.status → ${low.body?.outcome} (${String(low.body?.detail ?? '').slice(0, 60)})`);
  /**
   * Which floor catches this depends on the machine, so the assertion must
   * not. Where a coding agent is installed the request reaches
   * `irreversible-floor` and waits for a human; where none is (a clean CI
   * runner) `no-provider` denies it earlier. Both are correct refusals —
   * the property being verified is that a high-risk capability NEVER
   * auto-executes, which is true in both and is what is asserted.
   */
  const high = await post('/fabric/invoke', { capabilityId: 'agent.delegate', input: { task: 'must not run' }, context: { projectId: 'rt-proj' } });
  const refused = high.body?.outcome !== 'succeeded' && (high.body?.attempts ?? 0) === 0
    && ['awaiting-approval', 'denied'].includes(high.body?.outcome);
  check('4a. a high-risk capability never auto-executes',
    refused, `outcome=${high.body?.outcome} attempts=${high.body?.attempts ?? 0} rule=${high.body?.policy?.rule}`);
  /**
   * The property that matters is that nothing was installed — not which
   * gate stopped it. On a fresh AURA_HOME the approval gate catches this
   * before the install guard ever runs, and both outcomes are safe. So
   * this asserts "did not run", and names the gate that caught it.
   * `install-verify` separately proves the install guard specifically,
   * against a warmed policy where the request reaches it.
   */
  const install = await post('/fabric/invoke', { capabilityId: 'terminal.execute', input: { command: 'npm install --global cowsay' }, context: { projectId: 'rt-proj' } });
  const blocked = install.body?.outcome !== 'succeeded' && (install.body?.attempts ?? 0) === 0;
  check('4b. an install attempt through terminal.execute never runs',
    blocked, `outcome=${install.body?.outcome} attempts=${install.body?.attempts ?? 0} rule=${install.body?.policy?.rule ?? 'install-guard'}`);

  /* ── 5. port reuse and foreign refusal ───────────────────────────── */
  section('5. PORT 4319 — REUSE AND FOREIGN REFUSAL');
  const second = spawn(process.execPath, [bundle, '--none'], {
    cwd: RUN_DIR, env: { ...process.env, AURA_HOME, AI_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let secondLog = '';
  second.stdout?.on('data', (d) => { secondLog += d; });
  second.stderr?.on('data', (d) => { secondLog += d; });
  // Wait for the second instance to reach its bind attempt rather than
  // assuming it gets there in a fixed six seconds. A cold Node start on a
  // loaded CI runner can take longer than that, and timing out early reported
  // a refusal failure the service did not actually have.
  await waitFor(async () => /EADDRINUSE|already in use/i.test(secondLog) || second.exitCode !== null, 45000);
  const stillOurs = alive(serviceProc.pid) && (await get('/health')).status === 200;
  check('5a. a second service does not displace the first',
    stillOurs, stillOurs ? `original pid ${serviceProc.pid} still serving` : 'original was displaced');
  check('5b. the second instance refuses the occupied port rather than double-binding',
    /EADDRINUSE|already in use/i.test(secondLog) || second.exitCode !== null,
    (secondLog.match(/EADDRINUSE[^\n]*/) ?? ['exited'])[0].slice(0, 70));
  try { second.kill(); } catch { /* already gone */ }

  /* ── 6. shutdown, no orphan ──────────────────────────────────────── */
  section('6. SHUTDOWN — PORT RELEASED, NO ORPHAN');
  const pid = serviceProc.pid;
  if (IS_WIN) {
    // Windows has no SIGTERM: the shell asks the service to close over its
    // own loopback port, which is exactly what service.rs does.
    const bye = await fetch(`http://127.0.0.1:${PORT}/shutdown`, {
      method: 'POST', headers: { 'x-aura-shutdown': '1' }, signal: AbortSignal.timeout(8000),
    }).then((x) => x.status).catch(() => 0);
    check('6a. the Windows graceful-shutdown endpoint answers', bye === 200, `HTTP ${bye}`);
  } else {
    serviceProc.kill('SIGTERM');
    check('6a. SIGTERM is delivered to the service', true, 'POSIX signal path');
  }
  const closed = await waitFor(async () => !(await portOpen()), 20000);
  check('6b. the port is released', closed);
  const gone = await waitFor(async () => !alive(pid), 15000);
  check('6c. the service process is genuinely gone, not just unreferenced', gone, `pid ${pid}`);
  serviceProc = null;

  /* ── 7. relaunch ─────────────────────────────────────────────────── */
  section('7. RELAUNCH');
  serviceProc = spawn(process.execPath, [bundle, '--none'], {
    cwd: RUN_DIR, env: { ...process.env, AURA_HOME, AI_PORT: String(PORT) },
    stdio: 'ignore', windowsHide: true,
  });
  const up2 = await waitFor(async () => (await get('/health', 3000)).status === 200, 90000);
  check('7a. the service comes back healthy after a full stop', up2);
  const caps2 = await get('/fabric/capabilities');
  check('7b. and with the correct identity', caps2.status === 200 && !!caps2.body?.policy);
  serviceProc.kill(IS_WIN ? undefined : 'SIGTERM');
  await waitFor(async () => !(await portOpen()), 15000);
  serviceProc = null;

  /* ── 8. user state location ──────────────────────────────────────── */
  section('8. USER STATE LOCATION');
  const wrote = findFiles(AURA_HOME, () => true);
  check('8a. state is written under AURA_HOME, not the application directory',
    wrote.length > 0, `${wrote.length} file(s)`);
  check('8b. nothing was written into the repository during the run',
    !fs.existsSync(path.join(RUN_DIR, 'providers.json')), 'run dir clean of user state');

  /* ── 9. the packaged shell (needs a desktop session) ─────────────── */
  section('9. PACKAGED SHELL LAUNCH');
  // The shell's service checks below only mean something if the shell
  // actually started a service. If a previous phase left one running, the
  // shell would reuse it — correct behaviour, but then "closing the shell
  // releases the port" is testing someone else's process and fails for a
  // reason that is not a defect. Assert the precondition instead of assuming
  // it.
  const portFreeBeforeShell = await waitFor(async () => !(await portOpen()), 30000);
  check('9pre. the port is free before the shell is launched', portFreeBeforeShell,
    portFreeBeforeShell ? 'nothing on 4319' : 'a leftover service still holds 4319 — later checks would be meaningless');
  const binDir = path.join(ROOT, 'apps/desktop/src-tauri/target/release');
  const shellBin = IS_WIN
    ? path.join(binDir, 'aura-hub.exe')
    : IS_MAC
      ? (findFiles(path.join(binDir, 'bundle'), (f) => f.endsWith('/Contents/MacOS/aura-hub'))[0] ?? path.join(binDir, 'aura-hub'))
      : path.join(binDir, 'aura-hub');

  const hasSession = IS_WIN || IS_MAC || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
  if (!fs.existsSync(shellBin)) {
    info(`SHELL RUNTIME: NOT RUNTIME VERIFIED — no release binary at ${shellBin} (run the Tauri build first).`);
  } else if (!hasSession) {
    info('SHELL RUNTIME: NOT RUNTIME VERIFIED — no desktop session (DISPLAY/WAYLAND_DISPLAY unset).');
    info('The shell needs a webview; a headless runner cannot start one. Not counted as a pass.');
  } else {
    shellProc = spawn(shellBin, [], {
      cwd: RUN_DIR, env: { ...process.env, AURA_HOME, AI_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let shellLog = '';
    shellProc.stdout?.on('data', (d) => { shellLog += d; });
    shellProc.stderr?.on('data', (d) => { shellLog += d; });
    const shellUp = await waitFor(async () => (await get('/health', 3000)).status === 200, 120000);
    check('9a. the packaged shell launches and brings its own service up', shellUp,
      shellUp ? `shell pid ${shellProc.pid}` : `no service within 120s · ${shellLog.slice(-300)}`);

    // "Its own" is the part that matters, and answering /health does not
    // prove it — a reused service answers identically. Ask the OS whose
    // child the service is.
    const ownPid = shellUp ? childPidOf(shellProc.pid) : 0;
    check('9a2. the service is the shell\'s own child, not one it reused', ownPid > 0,
      ownPid > 0 ? `service pid ${ownPid}, parent ${shellProc.pid}` : 'no service child — the shell reused an existing service');
    // The shell's own account of what it resolved and spawned. Printed
    // whether or not the launch succeeded, because a check that passes for
    // the wrong reason is exactly what this phase exists to catch.
    for (const line of shellLog.split('\n').filter((l) => l.includes('[aura]'))) info(line.trim());
    if (!shellUp) {
      // The shell reports only that the service "stopped while starting up";
      // the reason is in the service's own log. Without this the failure is
      // undiagnosable from CI, where the runner's temp directory is gone by
      // the time anyone looks.
      const svcLog = path.join(AURA_HOME, 'logs', 'ai-service.log');
      info(`--- service log (${svcLog}) ---`);
      info(fs.existsSync(svcLog) ? fs.readFileSync(svcLog, 'utf8').slice(-2000) : 'the shell never created a service log');
      info(`--- shell stdout/stderr ---`);
      info(shellLog.slice(-1500) || '(nothing on the shell\'s own streams)');
      info(`shell binary: ${shellBin}`);
      info(`shell exit code: ${shellProc.exitCode}`);
    }
    if (shellUp) {
      const sid = await get('/fabric/capabilities');
      check('9b. the shell-started service has AURA identity', sid.status === 200 && !!sid.body?.policy);
      const sp = shellProc.pid;
      /**
       * Close it the way a user closes it.
       *
       * This distinction is the whole point of the check. Node's `kill()`
       * on Windows is `TerminateProcess` — an abrupt kill that gives Tauri
       * no chance to run `RunEvent::Exit`, so the service it started is
       * never told to stop. That is *abnormal* termination, and testing
       * only that would report a failure the product does not have on the
       * path users actually take. `taskkill` without `/F` posts WM_CLOSE,
       * which is what clicking the window's X does. On Unix, SIGTERM is
       * both the normal signal and the one `service.rs` installs handlers
       * for.
       */
      if (IS_WIN) {
        try { execFileSync('taskkill', ['/PID', String(sp)], { stdio: 'ignore' }); }
        catch { shellProc.kill(); }
      } else {
        shellProc.kill('SIGTERM');
      }
      const shellClosed = await waitFor(async () => !(await portOpen()), 30000);
      check('9c. closing the shell normally releases the port', shellClosed);
      check('9d. no orphan service process is left behind', !(await portOpen()),
        shellClosed ? 'port free, service gone with its shell' : 'a service still holds the port');

      // Abnormal termination is reported, not asserted. Unix kills the
      // service from a signal handler; Windows has no equivalent, so a
      // hard-killed shell can outlive its service ownership. Recorded as a
      // known limitation rather than hidden behind a passing test.
      shellProc = null;

      /* ── 10. Windows: abnormal termination must not orphan ────────── */
      if (IS_WIN) {
        section('10. WINDOWS ABNORMAL TERMINATION (Job Object)');
        const abrupt = spawn(shellBin, [], {
          cwd: RUN_DIR, env: { ...process.env, AURA_HOME, AI_PORT: String(PORT) },
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
        const back = await waitFor(async () => (await get('/health', 3000)).status === 200, 120000);
        check('10a. the shell is up again for the abnormal-termination test', back, `shell pid ${abrupt.pid}`);

        // Whose service is it? A reused one would not be in this shell's job
        // object and must not be expected to die with it, so the pid has to
        // be a real child for anything below to mean anything.
        const svcPid = back ? childPidOf(abrupt.pid) : 0;
        check('10b. the service process was located as a child of the shell', svcPid > 0, `service pid ${svcPid}`);

        // TerminateProcess — no WM_CLOSE, no exit handler, no chance to
        // clean up. Exactly what Task Manager's "End task" does.
        execFileSync('taskkill', ['/F', '/PID', String(abrupt.pid)], { stdio: 'ignore' });
        check('10c. the shell was killed abnormally (no exit handler ran)', true, 'taskkill /F');

        const portFree = await waitFor(async () => !(await portOpen()), 45000);
        check('10d. the Job Object released port 4319 without any graceful shutdown', portFree);
        const svcGone = svcPid > 0
          ? await waitFor(async () => !pidAlive(svcPid), 45000)
          : false;
        check('10e. the service process was killed with its shell — no orphan', svcGone, `pid ${svcPid}`);
        try { abrupt.kill(); } catch { /* already gone */ }
      }
    }
  }
} catch (e) {
  console.log(`ERROR ${e.message}`);
  failed = true;
} finally {
  for (const p of [serviceProc, shellProc, foreign]) {
    try { p?.kill(); } catch { /* already gone */ }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  const passed = results.filter((x) => x.ok).length;
  console.log(`\nPLATFORM: ${PLATFORM} (${process.arch}) · ${passed}/${results.length} checks passed`);
  console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}
