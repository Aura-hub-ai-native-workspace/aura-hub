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

import { execFile } from 'node:child_process';
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
function runFile(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeout: number; signal?: AbortSignal },
  done: (err: unknown, stdout: string, stderr: string) => void,
) {
  const { target } = launchSpec(bin, args);
  return execFile(
    target.file,
    target.args,
    { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: MAX_BUFFER, signal: opts.signal, ...spawnFlags(target) },
    (err, stdout, stderr) => done(err, stdout, stderr),
  );
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
      child = runFile(resolved.bin, args, { cwd: opts.cwd, timeout, signal: opts.signal }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new Error(`${resolved.bin} is not installed`));
        }
        resolve(settle(err, stdout, stderr, timeout));
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
      child = runFile(resolved.bin, args, { cwd: opts.cwd, timeout, signal: opts.signal }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new Error(`${resolved.bin} is not installed`));
        }
        resolve(settle(err, stdout, stderr, timeout));
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
): ProcessOutput {
  const out = (stdout + (stderr ? `\n${stderr}` : '')).trim();
  if (!err) return { out, code: 0 };

  const e = err as { code?: number | string; killed?: boolean; signal?: string };
  const signal = typeof e.signal === 'string' ? e.signal : undefined;

  // Node sets `killed` when IT killed the child, which for these callers
  // only happens on timeout.
  if (e.killed === true) {
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
      runFile('git', args, { cwd: opts.cwd, timeout, signal: opts.signal }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('git is not installed'));
        resolve(settle(err, stdout, stderr, timeout));
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
      runFile(parsed.bin, parsed.args, { cwd: opts.cwd, timeout, signal: opts.signal }, (err, stdout, stderr) => {
        const settled = settle(err, stdout, stderr, timeout);
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
      runFile(parsed.bin, parsed.args, { cwd: opts.cwd, timeout, signal: opts.signal }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new Error(`${parsed.bin} is not installed`));
        }
        resolve(settle(err, stdout, stderr, timeout));
      });
    } catch (e) {
      reject(e as Error);
    }
  });
}
