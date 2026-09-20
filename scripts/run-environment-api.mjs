#!/usr/bin/env node
/**
 * run-environment-api — cross-platform launcher for the Python backend.
 * ==================================================================
 * `npm run environment:api` used to be `python3 scripts/...`, which does
 * not exist on Windows (no `python3` shim on this machine at all — only
 * `python.exe` and the `py` launcher). Rather than hard-coding a different
 * name per OS, this picks the first interpreter that can actually run the
 * backend, mirroring `service.rs::python_candidates` precedence:
 *
 *   1. `AURA_PYTHON` — an explicit answer always wins.
 *   2. platform names from PATH (`python.exe`/`python3.exe` on Windows,
 *      `python3`/`python` elsewhere).
 *   3. Windows only: the `py -3` launcher (covers Store-shim machines
 *      where neither `python.exe` nor `python3.exe` is on PATH).
 *
 * A candidate wins only if `serve_central_agent_api.py --check` exits 0
 * with it — a path existing is not evidence it can import Starlette, so
 * the check the desktop shell itself uses decides here too. Extra argv
 * (port, `--check`) is forwarded verbatim.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'scripts', 'serve_central_agent_api.py');
const EXTRA_ARGS = process.argv.slice(2);

function candidates() {
  const list = [];
  if (process.env.AURA_PYTHON) list.push({ cmd: process.env.AURA_PYTHON, prefix: [] });
  if (process.platform === 'win32') {
    list.push({ cmd: 'python.exe', prefix: [] }, { cmd: 'python3.exe', prefix: [] });
  } else {
    list.push({ cmd: 'python3', prefix: [] }, { cmd: 'python', prefix: [] });
  }
  if (process.platform === 'win32') list.push({ cmd: 'py', prefix: ['-3'] });
  return list;
}

function canRun({ cmd, prefix }) {
  try {
    const r = spawnSync(cmd, [...prefix, ENTRY, '--check'], {
      cwd: ROOT,
      stdio: 'ignore',
      timeout: 30000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

const winner = candidates().find(canRun);
if (!winner) {
  console.error(
    'No Python interpreter on PATH can run the AURA backend '
    + '(needs Starlette, uvicorn, Pydantic). Set AURA_PYTHON to one that can, '
    + 'e.g. AURA_PYTHON=C:\\Python314\\python.exe npm run environment:api',
  );
  process.exit(1);
}

const child = spawn(winner.cmd, [...winner.prefix, ENTRY, ...EXTRA_ARGS], {
  cwd: ROOT,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
