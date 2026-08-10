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
  return new Promise((resolve, reject) => {
    const child = execFile(
      resolved.bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? AGENT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, signal: opts.signal },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new Error(`${resolved.bin} is not installed`));
        }
        resolve(settle(err, stdout, stderr, opts.timeoutMs ?? AGENT_TIMEOUT_MS));
      },
    );
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
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, signal: opts.signal },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('git is not installed'));
        resolve(settle(err, stdout, stderr, opts.timeoutMs ?? GIT_TIMEOUT_MS));
      },
    );
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
  return { ok: true, bin, args: parts.slice(1), reason: '' };
}

/** Allow-listed, argument-only execution. No shell interpretation. */
export function safeShell(command: string, opts: SpawnOptions): Promise<string> {
  const parsed = parseCommand(command);
  if (!parsed.ok) return Promise.reject(new Error(parsed.reason));
  return new Promise((resolve, reject) => {
    execFile(
      parsed.bin,
      parsed.args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? SHELL_TIMEOUT_MS, maxBuffer: MAX_BUFFER, signal: opts.signal },
      (err, stdout, stderr) => {
        const settled = settle(err, stdout, stderr, opts.timeoutMs ?? SHELL_TIMEOUT_MS);
        // A killed process is a failure even when it printed something
        // first — returning its partial output as the value would let a
        // caller treat a truncated run as a completed one.
        if (settled.killed) return reject(new Error(settled.out));
        if (err && !stdout && !stderr) return reject(new Error((err as Error).message));
        resolve(settled.out);
      },
    );
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
  return new Promise((resolve, reject) => {
    execFile(
      parsed.bin,
      parsed.args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? SHELL_TIMEOUT_MS, maxBuffer: MAX_BUFFER, signal: opts.signal },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new Error(`${parsed.bin} is not installed`));
        }
        resolve(settle(err, stdout, stderr, opts.timeoutMs ?? SHELL_TIMEOUT_MS));
      },
    );
  });
}
