/**
 * Cancelling or timing out an agent run ends its whole process tree.
 *
 * `execFile`'s `timeout` and `signal` options signal ONE process. An agent CLI
 * (or a build it starts) routinely forks workers; they were left running after
 * Stop or a timeout, still holding ports, file locks and the project directory,
 * while the run was reported as cancelled. `runAgent` now starts the child as the
 * leader of its own process group (POSIX) and sweeps that group on abort or
 * timeout; on Windows it uses `taskkill /T` (not executable from this test).
 *
 * The agent here is a stand-in named like an allow-listed agent so the real
 * allow-list is exercised, not bypassed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgent } from './process';

const posix = process.platform !== 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(pred: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}

let dir: string;
let oldPath: string | undefined;
const grandchildren: number[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'aura-tree-'));
  oldPath = process.env.PATH;
  const bin = path.join(dir, 'opencode');
  // Forks a long-lived grandchild, records its pid, then waits on it.
  writeFileSync(bin, `#!/bin/sh\nsleep 300 &\necho $! > "${dir}/grandchild.pid"\nwait\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
});
afterEach(() => {
  process.env.PATH = oldPath;
  for (const pid of grandchildren.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(dir, { recursive: true, force: true });
});

const grandchildPid = async () => {
  const file = path.join(dir, 'grandchild.pid');
  await until(() => existsSync(file) && readFileSync(file, 'utf8').trim() !== '');
  const pid = Number(readFileSync(file, 'utf8').trim());
  grandchildren.push(pid);
  return pid;
};

describe.skipIf(!posix)('process-tree termination (POSIX)', () => {
  it('Stop (abort) ends the agent AND the processes it started', async () => {
    const ac = new AbortController();
    const run = runAgent('opencode', [], { cwd: dir, timeoutMs: 60_000, signal: ac.signal });
    const pid = await grandchildPid();
    expect(alive(pid)).toBe(true);                       // it really is running before Stop
    ac.abort();
    await run;
    expect(await until(() => !alive(pid))).toBe(true);   // F: it used to survive the Stop
  });

  it('a timeout ends the agent AND the processes it started', async () => {
    const run = runAgent('opencode', [], { cwd: dir, timeoutMs: 700 });
    const pid = await grandchildPid();
    const res = await run;
    expect(res.timedOut).toBe(true);                      // the verdict is unchanged
    expect(res.code).toBe(124);
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it('a run that finishes normally is not disturbed afterwards', async () => {
    writeFileSync(path.join(dir, 'opencode'), '#!/bin/sh\necho done\n');
    const res = await runAgent('opencode', [], { cwd: dir, timeoutMs: 10_000 });
    expect(res.code).toBe(0);
    expect(res.out).toContain('done');
  });

  it('an already-aborted signal ends the run and the tree without leaving anything behind', async () => {
    const ac = new AbortController();
    ac.abort();
    const run = runAgent('opencode', [], { cwd: dir, timeoutMs: 60_000, signal: ac.signal });
    const res = await run;                                  // settles as before (an abort is not an exit 0)
    expect(res.code).not.toBe(0);
    const file = path.join(dir, 'grandchild.pid');
    if (existsSync(file) && readFileSync(file, 'utf8').trim()) {
      const pid = Number(readFileSync(file, 'utf8').trim());
      grandchildren.push(pid);
      expect(await until(() => !alive(pid))).toBe(true);
    }
  });

  it('aborting after the run finished is harmless', async () => {
    writeFileSync(path.join(dir, 'opencode'), '#!/bin/sh\necho done\n');
    const ac = new AbortController();
    const res = await runAgent('opencode', [], { cwd: dir, timeoutMs: 10_000, signal: ac.signal });
    expect(res.code).toBe(0);
    ac.abort();                                             // the listener was removed on close; no stray group kill
    await sleep(50);
    expect(res.out).toContain('done');
  });
});
