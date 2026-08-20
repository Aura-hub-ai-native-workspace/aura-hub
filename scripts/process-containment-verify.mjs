/**
 * process-containment-verify — a timeout means the work stopped.
 * ==================================================================
 * `exec/process.ts` bounded every spawn with `execFile`'s own `timeout`
 * and `signal`. Both signal ONE pid. A tool that forks — a package
 * manager fetching, a build spawning a compiler, a script backgrounding a
 * server — kept running after AURA reported that the action had ended.
 * That is worse than having no timeout, because the caller was told
 * something untrue and then acted on it.
 *
 * The primitive now spawns `detached` on POSIX, so the child's pid is its
 * process group id and `kill(-pid)` reaches everything it started; on
 * Windows the tree is walked by `taskkill /T`. SIGTERM first, SIGKILL
 * after a grace period, so a tool that ignores SIGTERM cannot hold a
 * timeout open forever.
 *
 *   [A] a child that forks is fully dead after a timeout
 *   [B] cancellation reaches the grandchild too, and quickly
 *   [C] the reason is reported honestly — timed out, cancelled, or exited
 *   [D] leaving the service's process group does not mean outliving it
 *
 * The NEGATIVE CONTROL in [A] is the old mechanism, run side by side:
 * the same fork, bounded by `execFile`'s `timeout` instead, and its
 * grandchild is still alive afterwards. Without that, "no survivors"
 * could just mean the fixture never forked.
 *
 * Usage: node scripts/process-containment-verify.mjs
 * POSIX only for the group assertions; on Windows the taskkill path is
 * reported NOT VERIFIED rather than assumed.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'containment-'));

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const skip = (n, why) => console.log(`SKIP  ${n} — NOT VERIFIED: ${why}`);
const section = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bundle the real primitive and import it — no reimplementation here. */
const outFile = path.join(work, 'process.mjs');
execFile;
const { execFileSync } = await import('node:child_process');
execFileSync('npx', [
  'esbuild', path.join(ROOT, 'packages/ai-service/src/exec/process.ts'),
  '--bundle', '--platform=node', '--format=esm', `--outfile=${outFile}`,
], { cwd: ROOT, stdio: 'pipe' });
const proc = await import(outFile);

/**
 * A fixture that forks and then waits.
 *
 * The grandchild is spawned `detached` and `unref`'d — deliberately the
 * hardest case, because that is precisely the shape that survived before:
 * it is in no group AURA knows about unless AURA kills the group its
 * parent leads.
 */
function fixture(name) {
  const pidFile = path.join(work, `${name}.pid`);
  const script = path.join(work, `${name}.js`);
  writeFileSync(script, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const grandchild = spawn(process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'],
  { detached: true, stdio: 'ignore' });
grandchild.unref();
fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
setInterval(() => {}, 1000);
`);
  return { script, pidFile };
}

/** Wait for the fixture to report its grandchild, then read the pid. */
async function grandchildPid(pidFile, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await sleep(50);
  }
  return null;
}

/** Is that pid still running? `signal 0` asks without sending anything. */
function running(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Poll until the pid is gone, or give up. Returns how long it took. */
async function waitGone(pid, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!running(pid)) return Date.now() - t0;
    await sleep(50);
  }
  return null;
}

/** Nothing this suite starts is allowed to outlive it. */
const started = [];
const reap = () => { for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };

try {
  if (process.platform === 'win32') {
    skip('all group assertions', 'process groups are POSIX; the taskkill path needs a Windows runner');
  }

  /* ══ [A] TIMEOUT ═════════════════════════════════════════════════ */
  section('[A] A child that forks is fully dead after a timeout');

  const a = fixture('timeout');
  const t0 = Date.now();
  const result = await proc.safeShellWithCode(`node ${a.script}`, { cwd: work, timeoutMs: 1500 });
  const elapsed = Date.now() - t0;

  const pidA = await grandchildPid(a.pidFile, 1000);
  if (pidA) started.push(pidA);
  check('A1  the fixture really did fork a grandchild', pidA !== null, `pid ${pidA}`);

  check('A2  the timeout was reported as a timeout, not as success',
    result.code === 124 && result.timedOut === true,
    `code=${result.code} timedOut=${result.timedOut}`);
  check('A3  and it returned close to the deadline, not at the child’s own pace',
    elapsed < 8000, `${elapsed}ms for a 1500ms timeout`);

  if (process.platform !== 'win32' && pidA) {
    const gone = await waitGone(pidA, 6000);
    check('A4  the grandchild is gone, not orphaned', gone !== null,
      gone !== null ? `died ${gone}ms after the timeout` : 'STILL RUNNING');
  } else if (!pidA) {
    check('A4  the grandchild is gone, not orphaned', false, 'no grandchild pid to check');
  } else {
    skip('A4  the grandchild is gone, not orphaned', 'POSIX-only assertion');
  }

  /* NEGATIVE CONTROL — the mechanism this replaced. Same fixture, bounded
     by execFile's own `timeout`, which signals one pid. */
  {
    const b = fixture('control');
    await new Promise((resolve) => {
      execFile(process.execPath, [b.script], { cwd: work, timeout: 1500 }, () => resolve());
    });
    const pidB = await grandchildPid(b.pidFile, 1000);
    if (pidB) started.push(pidB);
    await sleep(1000);
    const survived = pidB !== null && running(pidB);
    check('A5  NEGATIVE CONTROL — the old single-pid timeout leaves the grandchild alive',
      survived, survived ? `pid ${pidB} still running` : 'CONTROL DID NOT LEAK — the fixture may not have forked');
    if (pidB) { try { process.kill(pidB, 'SIGKILL'); } catch { /* gone */ } }
  }

  /* ══ [B] CANCELLATION ════════════════════════════════════════════ */
  section('[B] Cancellation reaches the grandchild, and quickly');

  const c = fixture('cancel');
  const ac = new AbortController();
  const pending = proc.safeShellWithCode(`node ${c.script}`, { cwd: work, timeoutMs: 120_000, signal: ac.signal });
  const pidC = await grandchildPid(c.pidFile, 10_000);
  if (pidC) started.push(pidC);
  check('B1  the fixture is running with a grandchild', pidC !== null && running(pidC), `pid ${pidC}`);

  const cancelAt = Date.now();
  ac.abort();
  const cancelled = await pending;
  check('B2  cancelling returns rather than waiting out the 120s timeout',
    Date.now() - cancelAt < 5000, `${Date.now() - cancelAt}ms`);
  check('B3  and is reported as cancelled, not as a timeout and not as success',
    cancelled.killed === true && cancelled.timedOut !== true && cancelled.code !== 0,
    `code=${cancelled.code} timedOut=${cancelled.timedOut} out=${JSON.stringify(cancelled.out.slice(-40))}`);

  if (process.platform !== 'win32' && pidC) {
    const gone = await waitGone(pidC, 5000);
    check('B4  the grandchild stops within the grace period', gone !== null,
      gone !== null ? `died ${gone}ms after cancel` : 'STILL RUNNING');
  } else {
    skip('B4  the grandchild stops within the grace period', 'POSIX-only assertion');
  }

  /* ══ [C] HONEST CAUSES ═══════════════════════════════════════════ */
  section('[C] The three endings stay distinguishable');

  const clean = await proc.safeShellWithCode('node -e process.exit(0)', { cwd: work, timeoutMs: 10_000 });
  check('C1  a clean exit is still 0', clean.code === 0 && !clean.killed,
    `code=${clean.code}`);

  const bad = await proc.safeShellWithCode('node -e process.exit(7)', { cwd: work, timeoutMs: 10_000 });
  check('C2  a real exit code is preserved, not flattened to 1',
    bad.code === 7, `code=${bad.code}`);

  check('C3  a timeout says so in the output', /timed out/.test(result.out), JSON.stringify(result.out.slice(-40)));
  check('C4  a cancellation says something different', /cancelled/.test(cancelled.out));
  check('C5  the two are not the same code', result.code !== cancelled.code,
    `timeout=${result.code} cancel=${cancelled.code}`);

  /* ══ [D] SHUTDOWN ════════════════════════════════════════════════ */
  section('[D] Leaving the service process group does not mean outliving it');

  const d = fixture('shutdown');
  const running_d = proc.safeShellWithCode(`node ${d.script}`, { cwd: work, timeoutMs: 120_000 });
  const pidD = await grandchildPid(d.pidFile, 10_000);
  if (pidD) started.push(pidD);

  check('D1  the primitive knows what it has running',
    typeof proc.liveChildCount === 'function' && proc.liveChildCount() >= 1,
    `${proc.liveChildCount?.()} live`);

  const signalled = proc.terminateAllChildren();
  check('D2  shutdown signals every live tree', signalled >= 1, `${signalled} tree(s)`);
  await running_d;

  if (process.platform !== 'win32' && pidD) {
    const gone = await waitGone(pidD, 5000);
    check('D3  including the grandchildren', gone !== null,
      gone !== null ? `died ${gone}ms after shutdown` : 'STILL RUNNING');
  } else {
    skip('D3  including the grandchildren', 'POSIX-only assertion');
  }

  check('D4  and nothing is left registered', proc.liveChildCount() === 0,
    `${proc.liveChildCount()} live`);

  const src = fs.readFileSync(path.join(ROOT, 'packages/ai-service/src/server.ts'), 'utf8');
  check('D5  the service calls it on close, before the socket goes',
    src.indexOf('terminateAllChildren()') > 0 &&
    src.indexOf('terminateAllChildren()') < src.indexOf('server.close(() => r())'),
    'a shutdown that hangs on a socket still contains the work');
} catch (err) {
  console.error(`\nFATAL  ${err?.stack ?? err}`);
  failed = true;
} finally {
  reap();
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* leave it */ }
}

console.log(failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
