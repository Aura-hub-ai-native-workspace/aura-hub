/**
 * exec/session - the single LONG-LIVED child-process primitive.
 * ==================================================================
 * `exec/process.ts` is the one-shot primitive: spawn, wait, settle, done.
 * Its `settle()` is the only place an exit code, a signal or a timeout is
 * interpreted, and that stays true - this module does not reimplement it
 * and does not copy it.
 *
 * What it adds is the other shape of child process, which one-shot
 * execution genuinely cannot express: a process that stays up and is
 * spoken to. An MCP server over stdio and a browser under CDP are both
 * that shape. Neither can be a `runFile` call, because the interesting
 * part happens between spawn and exit.
 *
 * -- Why here, and why one --------------------------------------------
 * Invariant 3 says one process primitive. The intent behind it is that
 * exit status, signals and timeouts are decided in exactly one place -
 * they used to be decided wrongly in several, and a timed-out run read as
 * a clean exit 0. That intent is preserved: `exec/` remains the only
 * directory that spawns, and there is exactly ONE long-lived session
 * primitive, here, rather than one inside the MCP client and another
 * inside the browser driver.
 *
 * -- What it deliberately does NOT do ----------------------------------
 * It does not carry an allow-list. `SAFE_BINARIES`, `AGENT_BINARIES` and
 * `INSTALLER_BINARIES` are three disjoint lists and stay three; adding a
 * fourth general-purpose one here would be the merge that invariant 8
 * forbids, dressed up as a new file.
 *
 * Instead, every caller must supply an `authority` - a sentence naming
 * what authorised this specific process to exist. The MCP driver's
 * authority is "the user registered this server in ~/.aura/mcp/servers.json";
 * the browser driver's is "AURA is launching the browser profile it owns".
 * The authority is recorded and surfaced. A caller that cannot name one
 * has no business starting a long-lived process.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { launchSpec, spawnFlags } from './which';

export interface SessionOptions {
  /** What authorised this process to exist. Recorded, never inferred. */
  authority: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Milliseconds of silence after which the session is considered dead. */
  idleTimeoutMs?: number;
  /** Hard cap on buffered stderr, so a chatty server cannot exhaust memory. */
  maxStderrBytes?: number;
}

export interface SessionExit {
  code: number | null;
  signal: string | null;
  /** Whatever the process said on stderr, bounded. */
  stderr: string;
}

const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_MAX_STDERR = 64 * 1024;
/** A line longer than this is a protocol violation, not a message. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * One long-lived child process, spoken to in newline-delimited messages.
 *
 * Newline framing is what both protocols this serves actually use
 * (MCP stdio is newline-delimited JSON-RPC; the CDP HTTP endpoints are
 * separate). A protocol that needs different framing gets a different
 * reader on the same session rather than a second session class.
 */
export class ProcessSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private readonly lineHandlers: ((line: string) => void)[] = [];
  private exitPromise: Promise<SessionExit> | null = null;
  private exited: SessionExit | null = null;
  private lastActivity = Date.now();

  constructor(
    readonly bin: string,
    readonly args: readonly string[],
    readonly options: SessionOptions,
  ) {}

  get running(): boolean {
    return this.child !== null && this.exited === null;
  }

  get exit(): SessionExit | null {
    return this.exited;
  }

  /**
   * Start the process.
   *
   * Resolution goes through `exec/which`'s `launchSpec`, the same way
   * `exec/process.ts` does, so a Windows `.cmd` shim and a PATHEXT lookup
   * behave identically for a long-lived process and a one-shot one.
   */
  start(): void {
    if (this.child) throw new Error('This session has already been started.');
    const { target } = launchSpec(this.bin, [...this.args]);
    const child = spawn(target.file, target.args, {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...spawnFlags(target),
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.lastActivity = Date.now();
      this.stdoutBuffer += chunk;
      if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
        /* No newline in 8MB is not a slow message, it is a peer that is
           not speaking the protocol. Drop the buffer rather than grow
           without bound, and say so on stderr where it will be seen. */
        this.stderrBuffer += `\n[aura] discarded ${this.stdoutBuffer.length} bytes of unframed output\n`;
        this.stdoutBuffer = '';
        return;
      }
      let index = this.stdoutBuffer.indexOf('\n');
      while (index >= 0) {
        const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, '');
        this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
        if (line.length) for (const h of this.lineHandlers) h(line);
        index = this.stdoutBuffer.indexOf('\n');
      }
    });

    const maxStderr = this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.lastActivity = Date.now();
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-maxStderr);
    });

    this.exitPromise = new Promise<SessionExit>((resolve) => {
      const settle = (code: number | null, signal: string | null) => {
        if (this.exited) return;
        this.exited = { code, signal, stderr: this.stderrBuffer };
        resolve(this.exited);
      };
      child.on('exit', settle);
      child.on('error', (err) => {
        this.stderrBuffer = (this.stderrBuffer + `\n[aura] ${(err as Error).message}\n`).slice(-maxStderr);
        settle(null, null);
      });
    });
  }

  /** Receive every complete line the process writes to stdout. */
  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  /** Send one newline-terminated message. */
  write(line: string): void {
    if (!this.child || this.exited) {
      throw new Error(`The ${this.bin} session is not running${this.exited ? ` (it exited with code ${this.exited.code})` : ''}.`);
    }
    this.lastActivity = Date.now();
    this.child.stdin.write(line.endsWith('\n') ? line : `${line}\n`);
  }

  /** Whether the process has been silent longer than its idle timeout. */
  get idle(): boolean {
    return Date.now() - this.lastActivity > (this.options.idleTimeoutMs ?? DEFAULT_IDLE_MS);
  }

  /** The most recent bounded stderr. Useful when a peer dies mid-protocol. */
  get stderr(): string {
    return this.stderrBuffer;
  }

  /**
   * Stop the process: politely, then not.
   *
   * SIGTERM first so a server can flush and close its own resources;
   * SIGKILL after the grace period, because a session that ignores
   * SIGTERM is a session that would otherwise outlive AURA.
   */
  async stop(graceMs = 3000): Promise<SessionExit> {
    if (!this.child || !this.exitPromise) return { code: null, signal: null, stderr: this.stderrBuffer };
    if (this.exited) return this.exited;
    try {
      this.child.stdin.end();
    } catch { /* already closed */ }
    this.child.kill('SIGTERM');
    const killer = setTimeout(() => {
      try {
        this.child?.kill('SIGKILL');
      } catch { /* already gone */ }
    }, graceMs);
    try {
      return await this.exitPromise;
    } finally {
      clearTimeout(killer);
    }
  }

  /** Resolves when the process exits, however it exits. */
  waitForExit(): Promise<SessionExit> {
    return this.exitPromise ?? Promise.resolve({ code: null, signal: null, stderr: this.stderrBuffer });
  }
}
