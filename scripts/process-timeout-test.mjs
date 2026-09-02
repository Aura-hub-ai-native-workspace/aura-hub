/**
 * process-timeout-test — regression tests for exit-status truthfulness.
 * ==================================================================
 * These exist because the shared spawn primitive used to report a killed
 * child as `exitCode: 0`. A ten-minute agent run that was cut short by its
 * timeout came back as "succeeded", which is the worst class of bug this
 * codebase can have: a confident wrong answer.
 *
 * Every case below drives the REAL primitive (bundled from source), not a
 * reimplementation of it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = '/home/Groot/aura-hub';
const out = path.join(mkdtempSync(path.join(tmpdir(), 'proc-test-')), 'process.mjs');

// Bundle the real module so the test cannot drift from the implementation.
execFileSync('npx', [
  'esbuild', `${ROOT}/packages/ai-service/src/exec/process.ts`,
  '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`,
], { cwd: ROOT, stdio: 'pipe' });

const { git, safeShell, safeShellWithCode, runAgent, AGENT_BINARIES, TIMEOUT_EXIT_CODE, resolveAgentBinary }
  = await import(out);

const dir = mkdtempSync(path.join(tmpdir(), 'proc-cwd-'));
writeFileSync(path.join(dir, 'x.txt'), 'hello\n');

// Fixtures as files, not `-e` one-liners: `parseCommand` rightly refuses
// shell metacharacters, and `=>` / `;` contain some.
writeFileSync(path.join(dir, 'slow.js'), 'setTimeout(function(){}, 60000)\n');
writeFileSync(path.join(dir, 'exit3.js'), 'process.exit(3)\n');
writeFileSync(path.join(dir, 'sigterm.js'), 'process.kill(process.pid, "SIGTERM")\n');
writeFileSync(path.join(dir, 'partial.js'), 'console.log("partial"); setTimeout(function(){}, 60000)\n');

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

/* ── 1. normal exit 0 → success ───────────────────────────────────── */
{
  const r = await safeShellWithCode('node --version', { cwd: dir });
  check('1. exit 0 reports code 0', r.code === 0 && !r.killed && !r.timedOut,
    `code=${r.code} out=${r.out.slice(0, 20)}`);
}

/* ── 2. normal non-zero exit → real code ──────────────────────────── */
{
  const r = await safeShellWithCode('node exit3.js', { cwd: dir });
  check('2. non-zero exit reports the REAL code, not 0 and not 1',
    r.code === 3 && !r.timedOut, `code=${r.code}`);
}

/* ── 3. timeout → 124, never 0 ────────────────────────────────────── */
{
  const r = await safeShellWithCode('node slow.js', { cwd: dir, timeoutMs: 600 });
  check('3. a timed-out process is a FAILURE, not exit 0',
    r.code !== 0, `code=${r.code}`);
  check('3b. timeout reports the deterministic 124', r.code === TIMEOUT_EXIT_CODE, `code=${r.code}`);
  check('3c. timeout is flagged and explained', r.timedOut === true && /timed out/i.test(r.out),
    `timedOut=${r.timedOut} out=${JSON.stringify(r.out)}`);
}

/* ── 4. signal termination → failure, signal preserved ────────────── */
{
  const r = await safeShellWithCode('node sigterm.js', { cwd: dir });
  check('4. signal termination is a failure with the signal preserved',
    r.code !== 0 && (r.signal === 'SIGTERM' || r.code === 143),
    `code=${r.code} signal=${r.signal}`);
}

/* ── 5. git: timeout must not read as clean ───────────────────────── */
{
  execFileSync('git', ['-C', dir, 'init', '-q']);
  const good = await git(['status', '--porcelain'], { cwd: dir });
  check('5. git status still works normally', good.code === 0, `code=${good.code}`);

  // Deliberately real work on a real repo: `git status` in an empty
  // directory can finish inside a 1ms window, which would make this a race
  // rather than a test. Walking thousands of commits with --stat cannot.
  const bad = await git(['log', '--stat', '-n', '5000'], { cwd: ROOT, timeoutMs: 2 });
  check('5b. a timed-out git is NOT reported as exit 0',
    bad.code !== 0 && bad.timedOut === true, `code=${bad.code} timedOut=${bad.timedOut}`);
}

/* ── 6. safeShell rejects rather than returning partial output ────── */
{
  let rejected = false;
  let message = '';
  try {
    await safeShell('node partial.js', { cwd: dir, timeoutMs: 600 });
  } catch (e) { rejected = true; message = e.message; }
  check('6. safeShell rejects a killed process instead of returning its partial output',
    rejected, message.slice(0, 60));
}

/* ── 7. the agent allow-list is separate and enforced ─────────────── */
{
  check('7. SAFE_BINARIES and AGENT_BINARIES are disjoint',
    !AGENT_BINARIES.has('git') && !AGENT_BINARIES.has('node') && AGENT_BINARIES.has('opencode'),
    `agents=[${[...AGENT_BINARIES].join(', ')}]`);

  for (const bad of ['/home/Groot/.opencode/bin/opencode', '../../bin/sh', 'sh', 'opencode; rm -rf /']) {
    const r = resolveAgentBinary(bad);
    check(`7b. rejected: ${JSON.stringify(bad)}`, r.ok === false, r.reason.slice(0, 70));
  }
  check('7c. accepted: "opencode"', resolveAgentBinary('opencode').ok === true);
}

/* ── 8. a timed-out AGENT is a failure ────────────────────────────── */
{
  // Real binary, real spawn, deliberately impossible deadline.
  const r = await runAgent('opencode', ['run', '--dir', dir, 'say hi'], { cwd: dir, timeoutMs: 1500 });
  check('8. a timed-out agent reports 124, never 0',
    r.code === TIMEOUT_EXIT_CODE && r.timedOut === true,
    `code=${r.code} timedOut=${r.timedOut}`);
}

console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
