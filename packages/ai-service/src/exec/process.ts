/**
 * exec/process — the single process-spawn primitive.
 * ==================================================================
 * Extracted verbatim from `workflow/nodes.ts`, which had the only
 * hardened spawn implementation in the repository (allow-listed binary,
 * no shell interpretation, bounded timeout and buffer, abortable). The
 * Workflow Engine now imports from here rather than owning a private
 * copy, so the Capability Fabric and the Workflow Engine share ONE
 * governed path to a child process instead of two that could drift.
 *
 * Behaviour is unchanged from the original. The only differences are:
 *   • the project root and abort signal arrive as plain arguments rather
 *     than inside a workflow-specific `RunCtx`, so a non-workflow caller
 *     can use it;
 *   • `SAFE_BINARIES` and `parseCommand` are exported, so the Fabric can
 *     answer "would this be allowed?" *before* asking the user to approve
 *     it, rather than discovering the refusal after the fact.
 *
 * Nothing here decides whether an action is *permitted* — that is the
 * policy engine's job. This module only guarantees that whatever runs,
 * runs safely bounded.
 */

import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { launchSpec, spawnFlags } from './which';

/**
 * Spawn an allow-listed binary by name, on whichever OS is running.
 *
 * Every spawn in this module goes through here rather than calling
 * `execFile(name, …)` directly. The name is resolved to a real file first
 * (`exec/which`), which is what makes Windows work at all: PATH is split
 * with `;` there, executables carry a PATHEXT extension, and an
 * npm-installed tool is a `.cmd` shim that Node will not spawn without
 * routing it through the command interpreter.
 *
 * On Unix the resolved path is the same program the OS would have found,
 * so behaviour is unchanged; when resolution fails there, the bare name is
 * still handed to `execFile` so the OS resolver stays the authority and no
 * tool it can find is ever reported missing by us.
 */
/**
 * Why a termination happened. `null` means the child ended on its own.
 *
 * Node cannot tell us this. `execFile` reports a killed child with a
 * signal and no numeric code, which looks identical whether the timeout
 * fired, the caller cancelled, or something outside AURA sent a signal.
 * Once AURA does the killing itself — which it must, to reach the
 * grandchildren — the reason has to be carried out of band, or `settle`
 * goes back to guessing.
 */
type TerminationCause = 'timeout' | 'abort' | null;

/** How long a child gets to exit on SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * Every child this module has spawned and not yet reaped.
 *
 * Needed because `detached: true` puts a child in its own process group,
 * which is exactly what makes the group killable — and also what stops it
 * from dying with the service. Tracking them here is how that trade is
 * paid for: {@link terminateAllChildren} runs on shutdown, so leaving the
 * service's process group does not mean outliving the service.
 */
const live = new Set<ChildProcess>();

/**
 * Kill a child AND everything it started.
 *
 * `child.kill()` signals one pid. A build tool that spawns a compiler, a
 * package manager that spawns a fetcher, a script that backgrounds a
 * server — all of those survive it, and a timeout that leaves the work
 * still running is worse than no timeout at all, because the caller has
 * been told the action ended.
 *
 * POSIX: the child was spawned `detached`, so its pid is its process
 * group id and `kill(-pid)` reaches the whole group. If that fails — the
 * group is already gone, or the child never got one — fall back to the
 * single pid rather than doing nothing.
 *
 * Windows has no process group of that kind, so the tree is walked by
 * `taskkill /T`, which is the documented way to end a process and its
 * descendants. `/F` because this path is only reached once AURA has
 * already decided the work must stop.
 */
function descendantsOf(rootPid: number): number[] {
  const childrenOf = new Map<number, number[]>();
  const add = (ppid: number, pid: number) => {
    const list = childrenOf.get(ppid);
    if (list) list.push(pid); else childrenOf.set(ppid, [pid]);
  };

  if (process.platform === 'linux') {
    // /proc directly: no spawn, so terminating never depends on being able
    // to start another process — which is exactly the state a runaway tree
    // can put a machine in.
    let names: string[];
    try { names = readdirSync('/proc'); } catch { return []; }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try { stat = readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; }
      // `comm` is parenthesised and may itself contain spaces and
      // parentheses, so the fields after it are found from the LAST ')'.
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const after = stat.slice(close + 2).split(' ');
      const ppid = Number(after[1]);
      if (Number.isInteger(ppid)) add(ppid, Number(name));
    }
  } else {
    // BSD/macOS: ask ps once. Failure here means no descendants are found,
    // which degrades to the group kill rather than to an exception.
    let table = '';
    try {
      table = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000 });
    } catch { return []; }
    for (const line of table.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) add(ppid, pid);
    }
  }

  const found: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    for (const child of childrenOf.get(queue.shift() as number) ?? []) {
      if (seen.has(child)) continue;   // a cycle cannot happen, but a stale table can lie
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * Kill a child AND everything it started.
 *
 * `child.kill()` signals one pid. A build tool that spawns a compiler, a
 * package manager that spawns a fetcher, a script that backgrounds a
 * server — all of those survive it, and a timeout that leaves the work
 * still running is worse than no timeout at all, because the caller has
 * been told the action ended.
 *
 * Two mechanisms, because one is not enough:
 *
 *   the process GROUP — the child is spawned `detached`, so its pid is
 *   its own process group id and `kill(-pid)` reaches every descendant
 *   that stayed in that group. This is the cheap, complete answer for the
 *   ordinary case.
 *
 *   the descendant WALK — a grandchild that was itself spawned detached
 *   leads a NEW group, and the group kill does not reach it. That is not
 *   an exotic shape; it is what a daemonising tool does on purpose. The
 *   pids are therefore collected from the process table as well.
 *
 * The walk has to happen while the parent is still alive: once it exits,
 * its children are reparented to init and the link AURA would have
 * followed is gone. {@link terminateTree} snapshots first for that reason,
 * and passes the snapshot into both the SIGTERM and the SIGKILL pass.
 *
 * Windows has no process group of this kind, so the tree is walked by
 * `taskkill /T`, the documented way to end a process and its descendants.
 * `/F` because this path is only reached once AURA has already decided
 * the work must stop.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals, descendants: readonly number[]): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    // Best effort by design: the process may already be gone, and failing
    // to kill something that no longer exists is not an error.
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => { /* reaped, or already gone */ });
    } catch { /* nothing else to try on Windows */ }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
  for (const descendant of descendants) {
    if (descendant === pid) continue;
    try { process.kill(descendant, signal); } catch { /* already gone */ }
  }
}

/** Whether the child is still running, without asking the OS twice. */
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/**
 * Ask the tree to stop, then make it stop.
 *
 * SIGTERM first, so a well-behaved tool can flush and clean up; SIGKILL
 * after the grace period, so a tool that ignores SIGTERM cannot hold a
 * timeout open indefinitely. The escalation timer is unref'd and cleared
 * on exit, so a child that goes quietly costs nothing.
 */
function terminateTree(child: ChildProcess): void {
  if (!alive(child) || !child.pid) return;
  // Snapshot the descendants BEFORE signalling anything: the moment the
  // child exits, whatever it started is reparented to init and can no
  // longer be found by following pids down from here.
  const descendants = process.platform === 'win32' ? [] : descendantsOf(child.pid);
  killTree(child, 'SIGTERM', descendants);
  const escalate = setTimeout(() => {
    // Re-walk as well: a tool given its grace period may have started
    // something new with it. The snapshot is what guarantees the original
    // tree is reachable; the re-walk is what catches the addition.
    const now = alive(child) && child.pid ? descendantsOf(child.pid) : [];
    killTree(child, 'SIGKILL', [...new Set([...descendants, ...now])]);
  }, KILL_GRACE_MS);
  escalate.unref?.();
  child.once('exit', () => clearTimeout(escalate));
}

/**
 * Stop every tree this module has running. Called on service shutdown.
 *
 * Returns how many were signalled, so a caller can report the number
 * rather than assume it.
 */
export function terminateAllChildren(): number {
  let n = 0;
  for (const child of live) { terminateTree(child); n += 1; }
  return n;
}

/** How many children are running right now. For verification, not logic. */
export function liveChildCount(): number {
  return live.size;
}

/**
 * Spawn an allow-listed binary by name, on whichever OS is running.
 *
 * Every spawn in this module goes through here rather than calling
 * `execFile(name, …)` directly. The name is resolved to a real file first
 * (`exec/which`), which is what makes Windows work at all: PATH is split
 * with `;` there, executables carry a PATHEXT extension, and an
 * npm-installed tool is a `.cmd` shim that Node will not spawn without
 * routing it through the command interpreter.
 *
 * On Unix the resolved path is the same program the OS would have found,
 * so behaviour is unchanged; when resolution fails there, the bare name is
 * still handed to `execFile` so the OS resolver stays the authority and no
 * tool it can find is ever reported missing by us.
 *
 * ── Containment ─────────────────────────────────────────────────────
 * The timeout and the abort signal are enforced HERE rather than handed
 * to `execFile`, because Node's versions of both signal a single pid. A
 * child that has forked survives them, so a timed-out install used to
 * leave the install still running while the caller was told it had ended,
 * and a cancellation reached the process AURA started but nothing that
 * process had started.
 *
 * The cost is `detached: true`, which takes the child out of the service's
 * own group — so it no longer dies when the service does.
 * {@link terminateAllChildren} is the other half of that trade.
 */
function runFile(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeout: number; signal?: AbortSignal },
  done: (err: unknown, stdout: string, stderr: string, cause: TerminationCause) => void,
) {
  const { target } = launchSpec(bin, args);
  let cause: TerminationCause = null;
  let timer: NodeJS.Timeout;

  const onAbort = () => { cause = 'abort'; terminateTree(child); };

  const child = execFile(
    target.file,
    target.args,
    {
      cwd: opts.cwd,
      maxBuffer: MAX_BUFFER,
      // Deliberately no `timeout` and no `signal`: both are enforced below
      // over the whole group. Passing them here as well would race AURA's
      // own kill and report the wrong cause for the same event.
      ...(process.platform === 'win32' ? {} : { detached: true }),
      ...spawnFlags(target),
    },
    (err, stdout, stderr) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      live.delete(child);
      done(err, stdout, stderr, cause);
    },
  );
  live.add(child);

  timer = setTimeout(() => { cause = 'timeout'; terminateTree(child); }, opts.timeout);
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  return child;
}

/**
 * Binaries the safe shell will spawn. Deliberately small: a command that
 * is not on this list is refused with the list in the message, so the
 * refusal is actionable rather than mysterious.
 */
export const SAFE_BINARIES = new Set([
  'git', 'ls', 'pwd', 'node', 'npm', 'npx', 'wc', 'du', 'grep', 'find', 'cargo', 'python3', 'go',
]);

/**
 * Coding agents `agent.delegate` may launch. **Deliberately separate from
 * `SAFE_BINARIES`** and never merged into it.
 *
 * The separation is the security property, not a tidiness preference. An
 * agent rewrites files on its own judgement, which is a categorically
 * larger grant than running `npm test`. Keeping the lists apart means:
 *
 *   • `terminal.execute` can never launch an agent — not through a crafted
 *     command, not by accident, not if this list grows;
 *   • either grant can be revoked without touching the other.
 *
 * Entries are bare binary names, resolved on PATH. Absolute paths are
 * rejected by `resolveAgentBinary` so no caller can point execution at an
 * arbitrary executable.
 */
export const AGENT_BINARIES = new Set([
  'opencode', 'claude', 'codex', 'gemini', 'qwen', 'cursor-agent',
]);

/**
 * Installers `system.install` may launch (§25.4). A **third** allow-list,
 * disjoint from both of the above and never merged into either.
 *
 * The disjointness is load-bearing in two directions:
 *
 *   • merged into `SAFE_BINARIES`, medium-risk `terminal.execute` could
 *     install arbitrary software;
 *   • merged into `AGENT_BINARIES`, a delegated coding agent could.
 *
 * Note what is absent: `sudo`, `pacman`, `apt`, `dnf`, `yay`, `paru`.
 * Root-tier installs are never executed by AURA (§25.3), so no privileged
 * or privilege-escalating binary appears here — and an AUR helper is
 * privilege-escalating despite running as the user, because it calls
 * `sudo pacman` itself (§25.2 C3).
 */
export const INSTALLER_BINARIES = new Set([
  'npm', 'pipx', 'cargo', 'gh',
]);

/**
 * Decide whether a binary may be launched as an installer.
 *
 * Same shape and same guarantees as `resolveAgentBinary`: anything
 * path-like is refused before the list is consulted, so a caller must name
 * an installer and can never locate one.
 */
export function resolveInstallerBinary(bin: string): ResolvedAgent {
  const name = (bin ?? '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, bin: name, reason: 'An installer must be named, not given as a path.' };
  }
  if (!INSTALLER_BINARIES.has(name)) {
    return {
      ok: false,
      bin: name,
      reason: `'${name}' is not on the installer allow-list (${[...INSTALLER_BINARIES].join(', ')}).`,
    };
  }
  return { ok: true, bin: name, reason: '' };
}

/**
 * Run an installer with pre-built arguments.
 *
 * Arguments arrive as an array from the catalogue's `InstallSpec` and go
 * straight to `execFile` — never joined into a string, never shell-parsed.
 * stdin is closed immediately for the same reason it is for agents: an
 * installer that stops to ask a question would otherwise hang until the
 * timeout. A prompt AURA cannot answer must fail fast, not stall.
 */
export function runInstaller(bin: string, args: string[], opts: SpawnOptions): Promise<ProcessOutput> {
  const resolved = resolveInstallerBinary(bin);
  if (!resolved.ok) return Promise.reject(new Error(resolved.reason));
  const timeout = opts.timeoutMs ?? INSTALL_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = runFile(resolved.bin, args, { cwd: opts.cwd, timeout, signal: opts.signal }, (err, stdout, stderr, cause) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new Error(`${resolved.bin} is not installed`));
        }
        resolve(settle(err, stdout, stderr, timeout, cause));
      });
    } catch (e) {
      // An argument the platform's command interpreter would rewrite. The
      // install does not happen, and the caller is told why.
      return reject(e as Error);
    }
    child.stdin?.end();
  });
}

export interface ResolvedAgent {
  ok: boolean;
  bin: string;
  /** Why it was refused. Empty when `ok`. */
  reason: string;
}

/**
 * Decide whether a binary name may be launched as a coding agent.
 *
 * Rejects anything path-like before consulting the list: a caller must
 * name an agent, never locate one. This is what stops
 * `/home/someone/evil.sh` — or a relative `../../x` — from ever reaching
 * `execFile`, regardless of what the catalogue or the client claims.
 */
export function resolveAgentBinary(bin: string): ResolvedAgent {
  const name = (bin ?? '').trim();
  if (!name) return { ok: false, bin: '', reason: 'No agent binary was named.' };
  if (name.includes('/') || name.includes('\\') || /[;&|<>`$]/.test(name)) {
    return { ok: false, bin: name, reason: 'An agent must be named, not given as a path.' };
  }
  if (!AGENT_BINARIES.has(name)) {
    return {
      ok: false, bin: name,
      reason: `'${name}' is not on the coding-agent allow-list (${[...AGENT_BINARIES].join(', ')}).`,
    };
  }
  return { ok: true, bin: name, reason: '' };
}

/**
 * Run a coding agent with pre-built arguments.
 *
 * Arguments arrive as an array and are passed straight to `execFile` — they
 * are never joined into a string, so a task description containing shell
 * metacharacters is data, not syntax. Agents think for a long time, hence
 * the much larger default timeout.
 */
export function runAgent(bin: string, args: string[], opts: SpawnOptions): Promise<ProcessOutput> {
  const resolved = resolveAgentBinary(bin);
  if (!resolved.ok) return Promise.reject(new Error(resolved.reason));
  const timeout = opts.timeoutMs ?? AGENT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = runFile(resolved.bin, args, { cwd: opts.cwd, timeout, signal: opts.signal }, (err, stdout, stderr, cause) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new Error(`${resolved.bin} is not installed`));
        }
        resolve(settle(err, stdout, stderr, timeout, cause));
      });
    } catch (e) {
      // The task text carried something cmd.exe would reinterpret. Refusing
      // is the only honest option: a rewritten task is not the task asked for.
      return reject(e as Error);
    }
    /**
     * Close the agent's stdin immediately.
     *
     * `execFile` leaves stdin as an open pipe. A CLI that reads stdin —
     * which coding agents do, to accept piped context — then waits for
     * input a headless caller will never send, and the run hangs until the
     * timeout kills it. Signalling EOF up front is what makes
     * "non-interactive" actually non-interactive. Verified: the identical
     * argv completes in ~97s with stdin closed and hangs indefinitely
     * without.
     */
    child.stdin?.end();
  });
}

export interface SpawnOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const GIT_TIMEOUT_MS = 20_000;
const SHELL_TIMEOUT_MS = 30_000;
/** Agents plan, read and edit across several model round-trips. */
const AGENT_TIMEOUT_MS = 10 * 60_000;
/** Installers fetch over the network and may compile. Bounded, not generous. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export interface ProcessOutput {
  out: string;
  code: number;
  /** Killed rather than exited — timeout, or a signal from outside. */
  killed?: boolean;
  /** The signal that ended it, when the OS reported one. */
  signal?: string;
  /** Killed specifically because it exceeded its timeout. */
  timedOut?: boolean;
}

/** Conventional status for "ran out of time" (matches `timeout(1)`). */
export const TIMEOUT_EXIT_CODE = 124;
/** POSIX convention: a process ended by signal N reports 128 + N. */
const SIGNAL_EXIT_BASE = 128;
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
};

/**
 * Turn `execFile`'s callback into a truthful result.
 * ------------------------------------------------------------------
 * This is the one place exit status is decided, because it is the one
 * place it was previously decided wrongly. `execFile` reports a killed
 * child with a *signal* and no numeric `code`; the old
 * `typeof code === 'number' ? code : 0` therefore turned every timeout
 * into a clean exit 0, and a run that was cut short read as success.
 *
 * The rules now, for every caller:
 *   • exited 0            → 0
 *   • exited non-zero     → that code
 *   • killed by timeout   → 124, `timedOut`
 *   • killed by signal    → 128 + signal, `killed` + `signal`
 *   • errored otherwise   → 1, never 0
 *
 * A non-zero code is never invented for a process that genuinely
 * succeeded, and 0 is never reported for one that did not.
 */
function settle(
  err: unknown,
  stdout: string,
  stderr: string,
  timeoutMs: number,
  cause: TerminationCause = null,
): ProcessOutput {
  const out = (stdout + (stderr ? `\n${stderr}` : '')).trim();
  if (!err) return { out, code: 0 };

  const e = err as { code?: number | string; killed?: boolean; signal?: string };
  const signal = typeof e.signal === 'string' ? e.signal : undefined;

  /* AURA's own termination is authoritative over anything inferred from
     the exit status. It has to be: once the kill goes to the process
     group rather than through Node's `timeout` option, `e.killed` is
     false and the child looks like it was terminated from outside —
     which is a different fact about the world, and the one thing this
     function exists to stop reporting wrongly. */
  if (cause === 'abort') {
    return {
      out: `${out}${out ? '\n' : ''}[cancelled${signal ? ` (${signal})` : ''}]`,
      code: SIGNAL_EXIT_BASE + (SIGNAL_NUMBERS[signal ?? 'SIGTERM'] ?? 0),
      killed: true,
      signal,
    };
  }

  // Node sets `killed` when IT killed the child; AURA sets `cause` when it
  // did the killing itself. Either way, the child ran out of time.
  if (cause === 'timeout' || e.killed === true) {
    return {
      out: `${out}${out ? '\n' : ''}[timed out after ${timeoutMs}ms${signal ? ` (${signal})` : ''}]`,
      code: TIMEOUT_EXIT_CODE,
      killed: true,
      timedOut: true,
      signal,
    };
  }

  if (signal) {
    return {
      out: `${out}${out ? '\n' : ''}[terminated by ${signal}]`,
      code: SIGNAL_EXIT_BASE + (SIGNAL_NUMBERS[signal] ?? 0),
      killed: true,
      signal,
    };
  }

  if (typeof e.code === 'number') return { out, code: e.code };

  // An error with no numeric status is still a failure. Reporting 0 here
  // is what produced false successes before.
  return { out: out || String((err as Error).message ?? 'failed'), code: 1 };
}

/** Real `git` in a project directory. */
export function git(args: string[], opts: SpawnOptions): Promise<ProcessOutput> {
  const timeout = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    try {
      runFile('git', args, { cwd: opts.cwd, timeout, signal: opts.signal }, (err, stdout, stderr, cause) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('git is not installed'));
        resolve(settle(err, stdout, stderr, timeout, cause));
      });
    } catch (e) {
      reject(e as Error);
    }
  });
}

export interface ParsedCommand {
  ok: boolean;
  bin: string;
  args: string[];
  /** Why it was refused. Empty when `ok`. */
  reason: string;
}

/**
 * Decide whether a command line is runnable, without running it. Exported
 * so the Fabric can refuse — or warn — before an approval prompt is put
 * in front of the user.
 */
export function parseCommand(command: string): ParsedCommand {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, bin: '', args: [], reason: 'No command was given.' };
  if (/[;&|<>`$\\]/.test(trimmed)) {
    return { ok: false, bin: '', args: [], reason: 'Shell operators are not allowed — pass a single command with plain arguments.' };
  }
  const parts = trimmed.split(/\s+/);
  const bin = parts[0];
  if (!SAFE_BINARIES.has(bin)) {
    return {
      ok: false, bin, args: [],
      reason: `'${bin}' is not on the allow-list (${[...SAFE_BINARIES].join(', ')}).`,
    };
  }
  const installing = installSubcommand(bin, parts.slice(1));
  if (installing) {
    return {
      ok: false, bin, args: [],
      reason:
        `Installing software is not something this can do. '${installing}' changes what is installed on `
        + `this machine, which goes through system.install — where it is gated by approval and verified `
        + `by a real probe.`,
    };
  }
  return { ok: true, bin, args: parts.slice(1), reason: '' };
}

/**
 * Is this allow-listed command actually an INSTALL in disguise?
 *
 * `npm` and `cargo` are on `SAFE_BINARIES` because `npm test` and
 * `cargo build` are ordinary project work. They are also how software gets
 * installed, which means the binary name alone cannot separate "run the
 * tests" from "add a global package" — and without this guard,
 * `terminal.execute` (medium risk, ask-user) could install anything, side-
 * stepping the `system-floor` entirely.
 *
 * So the separation between the two grants is enforced on the verb rather
 * than only on the binary. `SAFE_BINARIES` and `INSTALLER_BINARIES` do
 * share two names; what they do not share is the ability to install.
 */
function installSubcommand(bin: string, args: string[]): string | null {
  const sub = args.find((a) => !a.startsWith('-'));
  if (!sub) return null;
  const verb = `${bin} ${sub}`;
  switch (bin) {
    case 'npm':
      // `npm install` inside a project is legitimate; `-g`/`--global` is
      // what reaches outside it. `npm ci` is project-local by definition.
      return /^(install|i|add)$/.test(sub) && args.some((a) => a === '-g' || a === '--global')
        ? `${verb} --global`
        : null;
    case 'cargo':
      return sub === 'install' ? verb : null;
    case 'go':
      return sub === 'install' ? verb : null;
    case 'python3':
      // `python3 -m pip install ...`
      return args.includes('pip') && args.includes('install') ? 'python3 -m pip install' : null;
    default:
      return null;
  }
}

/** Allow-listed, argument-only execution. No shell interpretation. */
export function safeShell(command: string, opts: SpawnOptions): Promise<string> {
  const parsed = parseCommand(command);
  if (!parsed.ok) return Promise.reject(new Error(parsed.reason));
  const timeout = opts.timeoutMs ?? SHELL_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    try {
      runFile(parsed.bin, parsed.args, { cwd: opts.cwd, timeout, signal: opts.signal }, (err, stdout, stderr, cause) => {
        const settled = settle(err, stdout, stderr, timeout, cause);
        // A killed process is a failure even when it printed something
        // first — returning its partial output as the value would let a
        // caller treat a truncated run as a completed one.
        if (settled.killed) return reject(new Error(settled.out));
        if (err && !stdout && !stderr) return reject(new Error((err as Error).message));
        resolve(settled.out);
      });
    } catch (e) {
      reject(e as Error);
    }
  });
}

/**
 * Like `safeShell`, but surfaces the exit code instead of rejecting — the
 * Fabric verifies `terminal.execute` by exit code, so it needs the number,
 * not an exception.
 */
export function safeShellWithCode(command: string, opts: SpawnOptions): Promise<ProcessOutput> {
  const parsed = parseCommand(command);
  if (!parsed.ok) return Promise.reject(new Error(parsed.reason));
  const timeout = opts.timeoutMs ?? SHELL_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    try {
      runFile(parsed.bin, parsed.args, { cwd: opts.cwd, timeout, signal: opts.signal }, (err, stdout, stderr, cause) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new Error(`${parsed.bin} is not installed`));
        }
        resolve(settle(err, stdout, stderr, timeout, cause));
      });
    } catch (e) {
      reject(e as Error);
    }
  });
}
