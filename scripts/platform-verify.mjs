/**
 * platform-verify — proves the cross-platform executable logic on both branches.
 * ==================================================================
 * AURA is developed on Linux. Everything Windows-specific in this
 * repository — PATH split by `;`, PATHEXT extension search, the `.cmd`
 * shims npm installs, the `cmd.exe` hand-off Node requires for them —
 * cannot be exercised by running the app here, and "it looks right" is not
 * a result this project accepts.
 *
 * So the platform-dependent logic in `exec/which.ts` is written as pure
 * functions over an injected platform, PATH, PATHEXT and file test. This
 * script drives BOTH branches with those injected, on whichever machine it
 * runs, and checks the answers against what each OS genuinely does.
 *
 * What this proves: the resolution and quoting rules are correct.
 * What it does NOT prove: that AURA runs on Windows. Only Windows can show
 * that, and this script never claims otherwise.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(os.tmpdir(), `aura-platform-verify-${process.pid}.mjs`);

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const section = (t) => console.log(`\n=== ${t} ===`);

/* A fake filesystem: the set of paths that exist as executables. */
const fakeFs = (files) => (candidate) => files.has(candidate);

/**
 * The same, modelling a Windows volume: NTFS is case-insensitive, and
 * PATHEXT is conventionally uppercase (`.EXE`) while the file on disk is
 * not (`git.exe`). A case-SENSITIVE fake here would fail a resolver that
 * is correct on the real OS, so the simulation has to match the OS.
 */
const fakeNtfs = (files) => {
  const lower = new Set([...files].map((f) => f.toLowerCase()));
  return (candidate) => lower.has(candidate.toLowerCase());
};

try {
  await build({
    entryPoints: [path.join(ROOT, 'packages/ai-service/src/exec/which.ts')],
    bundle: true, platform: 'node', format: 'esm', outfile: OUT, logLevel: 'silent',
  });
  const W = await import(pathToFileURL(OUT).href);

  /* ── 1. Windows resolution ───────────────────────────────────────── */
  section('1. WINDOWS EXECUTABLE RESOLUTION (simulated)');

  const winFiles = new Set([
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Users\\dev\\AppData\\Roaming\\npm\\npm.cmd',
    'C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.cmd',
    'C:\\Windows\\System32\\where.exe',
  ]);
  const winEnv = {
    platform: 'win32',
    pathEnv: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Users\\dev\\AppData\\Roaming\\npm',
    pathExt: '.COM;.EXE;.BAT;.CMD',
    isExecutableFile: fakeNtfs(winFiles),
  };

  check('1a. PATH is split on ";", not ":"',
    W.resolveExecutableWith('git', winEnv) === 'C:\\Program Files\\Git\\cmd\\git.exe',
    String(W.resolveExecutableWith('git', winEnv)));

  check('1b. a bare name resolves through PATHEXT to a real .exe',
    W.resolveExecutableWith('where', winEnv) === 'C:\\Windows\\System32\\where.exe',
    String(W.resolveExecutableWith('where', winEnv)));

  check('1c. an npm-installed tool resolves to its .cmd shim, not reported missing',
    W.resolveExecutableWith('opencode', winEnv) === 'C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.cmd',
    String(W.resolveExecutableWith('opencode', winEnv)));

  check('1d. npm itself resolves to npm.cmd',
    W.resolveExecutableWith('npm', winEnv) === 'C:\\Users\\dev\\AppData\\Roaming\\npm\\npm.cmd');

  check('1e. a genuinely absent tool still resolves to nothing',
    W.resolveExecutableWith('docker', winEnv) === null,
    'no invented path');

  check('1f. an already-suffixed name is not double-suffixed',
    W.resolveExecutableWith('git.exe', winEnv) === 'C:\\Program Files\\Git\\cmd\\git.exe');

  check('1g. PATHEXT order decides which of two candidates wins',
    W.resolveExecutableWith('tool', {
      ...winEnv,
      pathEnv: 'C:\\bin',
      isExecutableFile: fakeNtfs(new Set(['C:\\bin\\tool.exe', 'C:\\bin\\tool.cmd'])),
    }) === 'C:\\bin\\tool.exe', '.EXE precedes .CMD in PATHEXT');

  check('1h. a custom PATHEXT is honoured, not hardcoded',
    W.resolveExecutableWith('tool', {
      ...winEnv,
      pathEnv: 'C:\\bin',
      pathExt: '.CMD;.EXE',
      isExecutableFile: fakeNtfs(new Set(['C:\\bin\\tool.exe', 'C:\\bin\\tool.cmd'])),
    }) === 'C:\\bin\\tool.cmd');

  check('1i. quoted PATH entries (legal on Windows) are still searched',
    W.resolveExecutableWith('git', { ...winEnv, pathEnv: '"C:\\Program Files\\Git\\cmd"' })
      === 'C:\\Program Files\\Git\\cmd\\git.exe');

  check('1j. the current directory is NOT searched',
    W.resolveExecutableWith('git', {
      ...winEnv, pathEnv: 'C:\\Windows\\System32',
      isExecutableFile: fakeNtfs(new Set(['git.exe', '.\\git.exe'])),
    }) === null, 'a stray git.exe in the project folder cannot hijack a probe');

  /* ── 2. POSIX resolution ─────────────────────────────────────────── */
  section('2. POSIX EXECUTABLE RESOLUTION (simulated)');

  const posixEnv = {
    platform: 'posix',
    pathEnv: '/usr/bin:/usr/local/bin:/home/dev/.local/bin',
    isExecutableFile: fakeFs(new Set(['/usr/bin/git', '/home/dev/.local/bin/opencode'])),
  };

  check('2a. PATH is split on ":", not ";"',
    W.resolveExecutableWith('git', posixEnv) === '/usr/bin/git');
  check('2b. no extension is ever appended on POSIX',
    W.resolveExecutableWith('opencode', posixEnv) === '/home/dev/.local/bin/opencode');
  check('2c. PATHEXT is ignored on POSIX',
    W.resolveExecutableWith('git', { ...posixEnv, pathExt: '.EXE;.CMD' }) === '/usr/bin/git');
  check('2d. an absent tool resolves to nothing',
    W.resolveExecutableWith('docker', posixEnv) === null);
  check('2e. earlier PATH entries win',
    W.resolveExecutableWith('node', {
      ...posixEnv,
      isExecutableFile: fakeFs(new Set(['/usr/bin/node', '/usr/local/bin/node'])),
    }) === '/usr/bin/node');

  /* ── 3. the cmd.exe hand-off ─────────────────────────────────────── */
  section('3. .cmd SHIM HAND-OFF (simulated)');

  const t1 = W.spawnTargetFor('C:\\npm\\opencode.cmd', ['run', 'add a comment'], 'win32');
  check('3a. a .cmd shim is routed through the command interpreter',
    /cmd\.exe$/i.test(t1.file) && t1.args[0] === '/d' && t1.args[2] === '/c',
    `${t1.file} ${t1.args.slice(0, 3).join(' ')}`);
  check('3b. every argument is quoted individually, never joined into a line',
    t1.args.includes('"run"') && t1.args.includes('"add a comment"'),
    JSON.stringify(t1.args));

  const t2 = W.spawnTargetFor('C:\\Program Files\\Git\\cmd\\git.exe', ['status'], 'win32');
  check('3c. a real .exe is executed directly, with no interpreter in between',
    t2.file === 'C:\\Program Files\\Git\\cmd\\git.exe' && t2.args[0] === 'status');

  const t3 = W.spawnTargetFor('/usr/bin/git', ['status'], 'posix');
  check('3d. POSIX is untouched by any of this',
    t3.file === '/usr/bin/git' && t3.args.length === 1 && t3.args[0] === 'status');

  /* ── 4. the security property of the hand-off ────────────────────── */
  section('4. NO COMMAND INJECTION THROUGH THE INTERPRETER');

  for (const [label, evil] of [
    ['a chained command', 'x & calc.exe'],
    ['a piped command', 'x | whoami'],
    ['an output redirect', 'x > C:\\Windows\\evil.txt'],
    ['a caret escape', 'x ^& calc.exe'],
    ['a subshell', 'x && (calc.exe)'],
  ]) {
    const got = W.spawnTargetFor('C:\\npm\\opencode.cmd', ['run', evil], 'win32');
    const quoted = got.args[got.args.length - 1];
    check(`4. ${label} is neutralised by quoting, not executed — ${JSON.stringify(evil)}`,
      quoted === `"${evil}"` && !/^[^"]/.test(quoted), quoted);
  }

  for (const [label, evil] of [
    ['environment-variable expansion', 'read %USERPROFILE%\\secrets'],
    ['a quote that would end the quoting', 'say "hi" & calc'],
    ['an embedded newline', 'first\r\nsecond'],
  ]) {
    let threw = null;
    try { W.spawnTargetFor('C:\\npm\\opencode.cmd', ['run', evil], 'win32'); }
    catch (e) { threw = e; }
    check(`4. ${label} is REFUSED rather than guessed at — ${JSON.stringify(evil)}`,
      threw instanceof W.UnsafeArgumentError,
      threw ? threw.message.slice(0, 80) : 'NOT REFUSED');
  }

  check('4z. the same strings are ordinary data on POSIX (no interpreter, no refusal)',
    W.spawnTargetFor('/usr/bin/opencode', ['run', 'read %USERPROFILE% & calc'], 'posix')
      .args[1] === 'read %USERPROFILE% & calc',
    'passed through verbatim to execFile');

  /* ── 5. against this real machine ────────────────────────────────── */
  section('5. AGAINST THE REAL MACHINE');

  const realGit = W.resolveExecutable('git');
  let whichGit = null;
  try { whichGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim(); } catch { /* none */ }
  check('5a. the resolver agrees with the operating system about where git is',
    !!realGit && realGit === whichGit, `resolver=${realGit} which=${whichGit}`);

  check('5b. the resolved path is a real executable file',
    !!realGit && fs.statSync(realGit).isFile() && W.isExecutableFileOnDisk(realGit));

  check('5c. a name that is not installed resolves to nothing, not a guess',
    W.resolveExecutable('definitely-not-a-real-binary-xyz') === null);

  check('5d. a non-executable file is not mistaken for a program',
    W.isExecutableFileOnDisk(path.join(ROOT, 'package.json')) === false,
    'the execute bit is genuinely checked on POSIX');

  const spec = W.launchSpec('git', ['--version']);
  check('5e. launchSpec on this machine runs the real binary directly',
    spec.resolved === whichGit && spec.target.file === whichGit,
    `${spec.target.file} ${spec.target.args.join(' ')}`);

  const real = execFileSync(spec.target.file, spec.target.args, { encoding: 'utf8' }).trim();
  check('5f. and that spawn genuinely executes', /git version \d+\./.test(real), real);

  check('5g. an unresolvable name still falls back to the OS resolver on POSIX',
    W.launchSpec('definitely-not-a-real-binary-xyz', []).target.file === 'definitely-not-a-real-binary-xyz',
    'resolution never turns a findable tool into a missing one');
} catch (e) {
  console.log(`ERROR ${e.stack?.split('\n').slice(0, 3).join(' | ')}`);
  failed = true;
} finally {
  fs.rmSync(OUT, { force: true });
  console.log(`\nSCOPE: platform LOGIC verified on both branches from ${process.platform}. `
    + 'Windows RUNTIME is not verified by this script and is not claimed.');
  console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}
