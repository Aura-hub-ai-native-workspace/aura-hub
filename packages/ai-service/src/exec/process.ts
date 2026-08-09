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

export interface SpawnOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const GIT_TIMEOUT_MS = 20_000;
const SHELL_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export interface ProcessOutput {
  out: string;
  code: number;
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
        const code = (err as { code?: number } | null)?.code;
        resolve({ out: (stdout + (stderr ? `\n${stderr}` : '')).trim(), code: typeof code === 'number' ? code : 0 });
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
        if (err && !stdout && !stderr) return reject(new Error((err as Error).message));
        resolve((stdout + (stderr ? `\n${stderr}` : '')).trim());
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
        const out = (stdout + (stderr ? `\n${stderr}` : '')).trim();
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new Error(`${parsed.bin} is not installed`));
        }
        const code = (err as { code?: number } | null)?.code;
        resolve({ out, code: typeof code === 'number' ? code : 0 });
      },
    );
  });
}
