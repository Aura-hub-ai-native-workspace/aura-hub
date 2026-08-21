/**
 * fabric/executors — the real implementations behind the manifest.
 * ==================================================================
 * Every executor here delegates to something that already exists:
 * `exec/process` for spawning, `WorkspaceManager` for AURA's own
 * subsystems. Nothing is reimplemented — §8.2.
 *
 * Only capabilities registered here can actually run. Everything else in
 * the manifest resolves to `unsupported` at call time, which is how a
 * 30-entry capability list stays honest about a 14-executor reality.
 *
 * Verification is real where a read-back exists: a committed file is
 * confirmed by `git log`, a written file by reading it back, a command by
 * its exit code, an HTTP call by its status. Where no check exists the
 * executor omits `verify` and the Fabric reports "no mechanical check"
 * rather than a pass.
 */

import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Executor, ExecutorResult, Invocation, VerificationReport } from '@aura/capability-fabric';
import { git, parseCommand, resolveAgentBinary, runAgent, runInstaller, safeShellWithCode } from '../exec/process';
import { guardedFetch, BlockedAddressError } from '../net/ssrfGuard';
import { isPlan, planInstall } from '../exec/install';
import { catalogEntry } from '@aura/connected-environment';
import { probeNode } from '../environment';
import type { WorkspaceManager } from '../workspace';

const MAX_READ_BYTES = 512 * 1024;

const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const b = (v: unknown): boolean => v === true;

/** Resolve a caller path INSIDE a root; rejects traversal. */
function inside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`That path leaves the project directory: ${rel}`);
  }
  return abs;
}

/** The directory an invocation operates in, or a clear failure. */
function cwdOf(inv: Invocation): string {
  const cwd = inv.context.cwd;
  if (!cwd) throw new Error('No project directory is set for this invocation. Open a project first.');
  return cwd;
}

const ok = (detail: string, output?: unknown): ExecutorResult => ({ ok: true, detail, output });
const no = (detail: string, opts: { effectStarted?: boolean; output?: unknown } = {}): ExecutorResult => ({ ok: false, detail, ...opts });

/**
 * A refusal made BEFORE anything was spawned or written.
 *
 * `effectStarted: false` is a claim the Fabric relies on to decide whether
 * an irreversible capability may be retried automatically, so it is only
 * ever used where the code has demonstrably not acted yet — a missing
 * argument, an unresolved node, a binary that is not on the allow-list.
 * Never after a process has been started.
 */
const notStarted = (detail: string): ExecutorResult => ({ ok: false, detail, effectStarted: false });

const pass = (kind: VerificationReport['kind'], detail: string): VerificationReport =>
  ({ passed: true, kind, detail });
const fail = (kind: VerificationReport['kind'], detail: string): VerificationReport =>
  ({ passed: false, kind, detail });

/* ══════════════════════════════════════════════════════════════════
   Filesystem
   ══════════════════════════════════════════════════════════════════ */

const filesystemList: Executor = {
  capabilityId: 'filesystem.list',
  async run(inv) {
    const root = cwdOf(inv);
    const target = inside(root, s(inv.input.path, '.'));
    const entries = await readdir(target, { withFileTypes: true });
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    return ok(`${names.length} ${names.length === 1 ? 'entry' : 'entries'}.`, names);
  },
};

const filesystemRead: Executor = {
  capabilityId: 'filesystem.read',
  async run(inv) {
    const root = cwdOf(inv);
    const target = inside(root, s(inv.input.path));
    const info = await stat(target);
    if (info.size > MAX_READ_BYTES) {
      return no(`That file is ${Math.round(info.size / 1024)}KB, over the ${MAX_READ_BYTES / 1024}KB read limit. Read a narrower path.`);
    }
    const text = await readFile(target, 'utf8');
    return ok(`Read ${info.size} bytes.`, text);
  },
};

const filesystemWrite: Executor = {
  capabilityId: 'filesystem.write',
  async run(inv) {
    const root = cwdOf(inv);
    const target = inside(root, s(inv.input.path));
    const content = s(inv.input.content);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    return ok(`Wrote ${Buffer.byteLength(content)} bytes to ${path.relative(root, target)}.`, { path: target });
  },
  async verify(inv) {
    const root = cwdOf(inv);
    const target = inside(root, s(inv.input.path));
    const expected = s(inv.input.content);
    try {
      const actual = await readFile(target, 'utf8');
      return actual === expected
        ? pass('read-back', 'Read the file back and the contents match exactly.')
        : fail('read-back', 'The file exists but its contents differ from what was written.');
    } catch {
      return fail('read-back', 'The file could not be read back after writing.');
    }
  },
};

/* ══════════════════════════════════════════════════════════════════
   Terminal
   ══════════════════════════════════════════════════════════════════ */

const terminalExecute: Executor = {
  capabilityId: 'terminal.execute',
  async run(inv) {
    const cwd = cwdOf(inv);
    const command = s(inv.input.command);
    // Refuse before running, with the allow-list in the message, so the
    // refusal is actionable rather than a bare failure.
    const parsed = parseCommand(command);
    if (!parsed.ok) return no(parsed.reason);

    const { out, code } = await safeShellWithCode(command, { cwd, timeoutMs: inv.context.timeoutMs });
    return code === 0
      ? ok(`Exit code 0.`, { stdout: out, exitCode: code })
      : { ok: false, detail: `Exit code ${code}. ${out.slice(0, 400)}`, output: { stdout: out, exitCode: code } };
  },
  async verify(_inv, result) {
    const exit = (result.output as { exitCode?: number } | undefined)?.exitCode;
    return exit === 0
      ? pass('exit-code', 'The command exited 0.')
      : fail('exit-code', `The command exited ${exit ?? 'unknown'}.`);
  },
};

/* ══════════════════════════════════════════════════════════════════
   Coding agents
   ══════════════════════════════════════════════════════════════════ */

/**
 * How to ask each agent to do one task and then exit.
 *
 * Only agents whose CLI has actually been run and checked appear here.
 * Guessing a flag would produce the exact failure this file exists to
 * avoid — a capability that reports success while nothing happened — so an
 * installed agent with no verified entry is refused by name instead.
 *
 * `args` receives an already-confined absolute `cwd` and returns argv.
 * The task text is always the LAST element and is never concatenated into
 * a string, so it reaches `execFile` as a single opaque argument.
 */
interface AgentInvocation {
  args: (task: string, cwd: string, model?: string) => string[];
  verifiedAgainst: string;
}

const AGENT_INVOCATIONS: Record<string, AgentInvocation> = {
  // `opencode run` is the documented non-interactive mode: it performs the
  // work and exits, where the bare `opencode` command opens a TUI.
  // `--dir` pins it to the project directory.
  opencode: {
    args: (task, cwd, model) => ['run', '--dir', cwd, ...(model ? ['--model', model] : []), task],
    verifiedAgainst: 'OpenCode 1.18.16',
  },
};

/**
 * The agent binaries AURA has a VERIFIED non-interactive invocation for.
 *
 * Exported so the Context Fabric can report "present but not drivable"
 * without restating the list. This file stays the authority: a node being
 * on the agent allow-list is not the same as AURA being able to drive it,
 * and only the invocation table above knows the difference.
 */
export const drivableAgentBinaries = (): string[] => Object.keys(AGENT_INVOCATIONS);

const agentDelegate: Executor = {
  capabilityId: 'agent.delegate',

  /**
   * Which coding agents AURA can actually drive.
   *
   * Six catalogue entries declare `coding-agent`, but a node is only
   * usable if its binary is on the agent allow-list AND has a verified
   * non-interactive invocation. Declaring that here lets the Fabric route
   * around an unusable agent before policy, instead of choosing one and
   * failing at spawn time.
   */
  supportsNode(node) {
    const bin = node.binary;
    return !!bin && resolveAgentBinary(bin).ok && !!AGENT_INVOCATIONS[bin];
  },

  async run(inv) {
    /* Every refusal before the agent CLI is spawned is provably
       pre-execution: the agent never ran, so nothing it could have done
       has happened. These report `effectStarted: false` so a retry of
       this irreversible capability is allowed when the failure is
       transient. */
    // Confinement first: the agent runs in the project directory the
    // server resolved from the registry, never one the caller supplied.
    let cwd: string;
    try {
      cwd = cwdOf(inv);
    } catch (error) {
      return no((error as Error).message, { effectStarted: false });
    }
    const task = s(inv.input.task).trim();
    if (!task) return notStarted('No task was given for the agent to carry out.');
    const model = s(inv.input.model).trim() || undefined;

    /* The canonical AURA prompt — system rules + this project's context +
       the task — composed by the Fabric wiring before this executor was
       called (see `withCanonicalContext` in fabric/index.ts).

       This executor deliberately does NOT build it. Composing context here
       would mean a second collector reaching for the registry, the
       environment scan and the mission store, and a delegated agent could
       then be told something different from what Ask AURA was told about
       the same project. Absent ⇒ the agent gets the bare task, exactly as
       it did before Phase C. */
    const auraPrompt = s(inv.input.auraPrompt).trim();
    const payload = auraPrompt || task;

    /* Routing is the Fabric's job now (§22). This executor no longer
       searches the catalogue or probes anything: it is handed the node
       that policy was evaluated against, and refuses if it was not. */
    const node = inv.node;
    if (!node) {
      return notStarted('No coding-agent node was resolved for this call, so nothing was run.');
    }

    const bin = node.binary;
    if (!bin) {
      return notStarted(`${node.name} has no executable recorded in the catalogue, so it cannot be run.`);
    }
    // The allow-list is still enforced here, at the point of execution —
    // routing decides WHICH node, never whether its binary may be spawned.
    if (!resolveAgentBinary(bin).ok) {
      return notStarted(`${node.name} is not on the coding-agent allow-list, so it was not run.`);
    }
    const invocationSpec = AGENT_INVOCATIONS[bin];
    // A resolved node whose CLI has not been verified FAILS. It is never
    // silently swapped for one that would have worked — that substitution
    // is exactly what routing must not do.
    if (!invocationSpec) {
      return notStarted(
        `${node.name} is connected, but AURA has no verified non-interactive invocation for it yet, `
        + `so nothing was run. Verified today: ${Object.keys(AGENT_INVOCATIONS).join(', ')}.`,
      );
    }

    const target = { nodeId: node.id, name: node.name, bin, invocation: invocationSpec };
    // `payload` still travels as the LAST single argv element, never
    // concatenated into a shell string — the same guarantee the bare task
    // had. Adding context changes the content of that argument, not the
    // way it is passed.
    const args = target.invocation.args(payload, cwd, model);
    let res: Awaited<ReturnType<typeof runAgent>>;
    try {
      res = await runAgent(target.bin, args, { cwd, timeoutMs: inv.context.timeoutMs });
    } catch (e) {
      // `runAgent` rejects only when the spawn itself failed (binary
      // missing, arguments the OS refused) — the agent never started.
      return no(`${target.name} could not be run: ${(e as Error).message}`, { effectStarted: false });
    }

    // The agent ran — it may have read and edited files even if it
    // exited non-zero or was cut short. `effectStarted: true` from here
    // on: a missing success response is never proof nothing happened.
    // `nodeId` travels with the result so the work is attributable to the
    // agent that did it rather than to "some coding agent".
    /* The payload argument is now a multi-kilobyte prompt. Reporting it
       verbatim would push the whole of it into the executor result and
       from there into the audit record, which is meant to stay a readable
       trace of what ran — not a transcript of what was said. The shape of
       the invocation is preserved; the payload is summarised. */
    const reportedArgs = args.map((a) => (a === payload ? `<aura-prompt:${payload.length} chars>` : a));

    const output = {
      stdout: res.out,
      exitCode: res.code,
      nodeId: target.nodeId,
      agent: target.name,
      args: reportedArgs,
      contextInjected: auraPrompt.length > 0,
      timedOut: res.timedOut ?? false,
      signal: res.signal,
    };
    if (res.code === 0) return { ok: true, effectStarted: true, detail: `${target.name} completed the task. Exit code 0.`, output };
    // A run that was cut short is reported as cut short, not as a
    // generic failure — the operator needs to know it may be half-done.
    // A timeout is named as a timeout so the Fabric's transient
    // classifier sees it: an irreversible agent run that timed out must
    // reach the retry-governance gate, never a silent re-run.
    const why = res.timedOut
      ? `${target.name} timed out and was stopped. Its changes, if any, are partial.`
      : res.signal
        ? `${target.name} was terminated by ${res.signal}.`
        : `${target.name} exited ${res.code}.`;
    /* The process ran. Whatever it did to the repository, it did — a
       timeout in particular is the case where work is most likely to be
       half-finished. Reporting `effectStarted: true` is what stops the
       Fabric retrying an approved irreversible action on top of it. */
    return { ok: false, detail: `${why} ${res.out.slice(0, 400)}`.trim(), output, effectStarted: true };
  },
  async verify(_inv, result) {
    const exit = (result.output as { exitCode?: number } | undefined)?.exitCode;
    return exit === 0
      ? pass('exit-code', 'The agent exited 0.')
      : fail('exit-code', `The agent exited ${exit ?? 'unknown'}.`);
  },
};

/* ══════════════════════════════════════════════════════════════════
   Installation (§25)
   ══════════════════════════════════════════════════════════════════ */

/** The four honest answers an install can give. Never widened. */
type InstallOutcome = 'installed' | 'guided' | 'failed' | 'unverified';

interface InstallResult {
  installOutcome: InstallOutcome;
  nodeId: string;
  privilege: 'user' | 'root';
  requiresUserAction: boolean;
  command?: string;
  why?: string;
  exitCode?: number;
  timedOut?: boolean;
  stdout?: string;
  probe?: { present: boolean; version?: string; detail: string };
}

/**
 * Re-probe the node, bypassing the scan cache.
 *
 * `refresh: true` is mandatory here. The cached answer was taken before
 * the install and would happily report the tool still missing — or, worse,
 * still present after a failure. Verification must look at the machine as
 * it is now.
 */
const probeAfterInstall = (nodeId: string) => probeNode(nodeId, true);

const systemInstall: Executor = {
  capabilityId: 'system.install',

  async run(inv) {
    const nodeId = s(inv.input.nodeId).trim();
    if (!nodeId) return no('No node was named, so there is nothing to install.');

    // The catalogue is the only source of truth for what may be installed.
    // An id that is not in it is refused before anything else happens.
    const entry = catalogEntry(nodeId);
    if (!entry) {
      return no(`'${nodeId}' is not a node in AURA's catalogue, so there is nothing to install.`);
    }

    const plan = planInstall(entry);

    // No InstallSpec, or nothing verified for this machine. An honest
    // "AURA does not know how" — never a guessed package name.
    if (!isPlan(plan)) {
      return no(plan.reason);
    }

    /* ── root tier: AURA executes NOTHING (§25.3) ─────────────────── */
    if (plan.privilege === 'root') {
      const result: InstallResult = {
        installOutcome: 'guided',
        nodeId,
        privilege: 'root',
        requiresUserAction: true,
        command: plan.command,
        why: plan.why,
      };
      // `ok: false` satisfies the existing Fabric contract; the payload
      // carries the real answer. Callers branch on `installOutcome`, never
      // on `ok` — a guided handoff is not a failure (§25.1).
      return {
        ok: false,
        detail:
          `${entry.name} needs administrator rights to install, so AURA did not run anything. `
          + `Run this yourself, then re-scan: ${plan.command}`,
        output: result,
      };
    }

    /* ── user tier: governed, bounded, then VERIFIED ──────────────── */
    let res: Awaited<ReturnType<typeof runInstaller>>;
    try {
      // cwd is the user's home rather than a project: installing a global
      // tool is not project work, and pointing an installer at a project
      // root invites it to write lockfiles there. `os.homedir()` is the
      // fallback rather than `/`, because Windows does not set `HOME`.
      res = await runInstaller(plan.bin, plan.args, {
        cwd: process.env.HOME || os.homedir(),
        timeoutMs: inv.context.timeoutMs,
      });
    } catch (e) {
      return no(`${entry.name} could not be installed: ${(e as Error).message}`);
    }

    const base = {
      nodeId,
      privilege: 'user' as const,
      command: plan.command,
      exitCode: res.code,
      timedOut: res.timedOut ?? false,
      stdout: res.out.slice(0, 4000),
    };

    if (res.code !== 0) {
      const why = res.timedOut
        ? `The installer ran out of time and was stopped.`
        : res.signal
          ? `The installer was terminated by ${res.signal}.`
          : `The installer exited ${res.code}.`;
      const result: InstallResult = { ...base, installOutcome: 'failed', requiresUserAction: false, why };
      return { ok: false, detail: `${entry.name} was not installed. ${why} ${res.out.slice(0, 300)}`.trim(), output: result };
    }

    /**
     * Exit 0 is a claim. The probe is the evidence.
     *
     * An installer can succeed while leaving nothing runnable — wrong
     * package, a binary outside PATH, a partial write. Reporting that as
     * installed is exactly the confident-but-wrong failure this codebase
     * refuses, so a clean exit with no detectable tool is `unverified`.
     */
    const probe = await probeAfterInstall(nodeId);
    if (!probe.present) {
      const result: InstallResult = {
        ...base,
        installOutcome: 'unverified',
        requiresUserAction: true,
        why: `The installer finished without an error, but ${entry.name} still cannot be found on this machine.`,
        probe: { present: false, detail: probe.detail },
      };
      return {
        ok: false,
        detail:
          `${entry.name} reported a successful install, but AURA still cannot find it, so it is NOT `
          + `being reported as installed. ${probe.detail}`,
        output: result,
      };
    }

    const result: InstallResult = {
      ...base,
      installOutcome: 'installed',
      requiresUserAction: false,
      probe: { present: true, version: probe.version, detail: probe.detail },
    };
    return ok(
      `${entry.name} is installed and verified${probe.version ? ` (${probe.version})` : ''}.`,
      result,
    );
  },

  /**
   * Verification re-states the probe, and passes ONLY for `installed`.
   *
   * `guided` deliberately fails verification: nothing was installed, so
   * there is nothing to verify. The distinction the user sees comes from
   * `installOutcome`, not from this report.
   */
  async verify(_inv, result) {
    const out = result.output as InstallResult | undefined;
    if (!out) return fail('read-back', 'The installer returned no result to verify.');
    switch (out.installOutcome) {
      case 'installed':
        return pass('read-back', `A fresh probe found ${out.nodeId}${out.probe?.version ? ` ${out.probe.version}` : ''}.`);
      case 'guided':
        return fail('read-back', 'Nothing was installed — this needs administrator rights and is waiting on you.');
      case 'unverified':
        return fail('read-back', `The installer exited 0 but a fresh probe still cannot find ${out.nodeId}.`);
      case 'failed':
        return fail('read-back', out.why ?? 'The installer did not succeed.');
    }
  },
};

/* ══════════════════════════════════════════════════════════════════
   Git — all through the shared primitive
   ══════════════════════════════════════════════════════════════════ */

const gitStatus: Executor = {
  capabilityId: 'git.status',
  async run(inv) {
    const { out } = await git(['status', '--short', '--branch'], { cwd: cwdOf(inv) });
    return ok(out ? 'Working tree has changes.' : 'Working tree is clean.', out || 'clean');
  },
};

const gitDiff: Executor = {
  capabilityId: 'git.diff',
  async run(inv) {
    const args = ['diff', '--stat', '-p', '--no-color'];
    if (b(inv.input.staged)) args.splice(1, 0, '--cached');
    const { out } = await git(args, { cwd: cwdOf(inv) });
    const text = out.length > 60_000 ? `${out.slice(0, 60_000)}\n…(truncated)` : out;
    return ok(out ? 'Diff produced.' : 'No changes.', text || 'no changes');
  },
};

const gitBranch: Executor = {
  capabilityId: 'git.branch',
  async run(inv) {
    const cwd = cwdOf(inv);
    const name = s(inv.input.name).trim();
    if (!name) {
      const { out } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      return ok(`On branch ${out}.`, out);
    }
    const existing = await git(['rev-parse', '--verify', name], { cwd });
    const args = existing.code === 0 ? ['checkout', name] : ['checkout', '-b', name];
    const res = await git(args, { cwd });
    if (res.code !== 0) return no(res.out || 'Branch operation failed.');
    return ok(existing.code === 0 ? `Switched to ${name}.` : `Created and switched to ${name}.`, name);
  },
  async verify(inv) {
    const name = s(inv.input.name).trim();
    if (!name) return pass('read-back', 'Reported the current branch.');
    const { out } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cwdOf(inv) });
    return out === name
      ? pass('read-back', `HEAD is on ${name}.`)
      : fail('read-back', `Expected to be on ${name}, but HEAD is on ${out}.`);
  },
};

const gitCommit: Executor = {
  capabilityId: 'git.commit',
  async run(inv) {
    const cwd = cwdOf(inv);
    const message = s(inv.input.message).split('\n')[0].trim();
    if (!message) return no('A commit message is required.');
    const status = await git(['status', '--porcelain'], { cwd });
    if (!status.out) return ok('Nothing to commit — the working tree is clean.', { committed: false });
    await git(['add', '-A'], { cwd });
    const res = await git(['commit', '-m', message], { cwd });
    if (res.code !== 0) return no(res.out || 'The commit failed.');
    return ok(`Committed: ${message}`, { committed: true, message });
  },
  async verify(inv, result) {
    if ((result.output as { committed?: boolean } | undefined)?.committed === false) {
      return pass('read-back', 'Nothing needed committing, so there is nothing to verify.');
    }
    const message = s(inv.input.message).split('\n')[0].trim();
    const { out } = await git(['log', '-1', '--pretty=%s'], { cwd: cwdOf(inv) });
    return out === message
      ? pass('read-back', 'HEAD is the new commit.')
      : fail('read-back', `HEAD's subject is "${out}", not the message that was committed.`);
  },
};

/**
 * The real git push executor, exported so governed-execution verification
 * scripts can register the production implementation itself (never a
 * stand-in) on a disposable fixture. `allExecutors` remains the single
 * place a running service wires its capabilities.
 */
export const gitPush: Executor = {
  capabilityId: 'git.push',
  async run(inv) {
    // Everything before the push process is spawned is provably
    // pre-execution: a failure here means nothing reached the remote.
    let cwd: string;
    try {
      cwd = cwdOf(inv);
    } catch (error) {
      return no((error as Error).message, { effectStarted: false });
    }
    const remote = s(inv.input.remote, 'origin');
    let branch = s(inv.input.branch);
    if (!branch) {
      try {
        branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).out;
      } catch (error) {
        // The branch probe failed before any push could start.
        return no((error as Error).message, { effectStarted: false });
      }
    }
    // From here a push process is spawned. The push may reach the remote
    // even when the transport fails or times out afterwards, so the
    // honest attestation is "may have started" — a missing success
    // response is never proof that nothing happened.
    let res: Awaited<ReturnType<typeof git>>;
    try {
      res = await git(['push', remote, branch], { cwd });
    } catch (error) {
      return no((error as Error).message, { effectStarted: true });
    }
    return res.code === 0
      ? { ok: true, effectStarted: true, detail: `Pushed ${branch} to ${remote}.`, output: { remote, branch, exitCode: res.code } }
      : { ok: false, effectStarted: true, detail: res.out || 'The push failed.', output: { exitCode: res.code } };
  },
  async verify(_inv, result) {
    const exit = (result.output as { exitCode?: number } | undefined)?.exitCode;
    return exit === 0
      ? pass('exit-code', 'git push exited 0.')
      : fail('exit-code', `git push exited ${exit ?? 'unknown'}.`);
  },
};

/* ══════════════════════════════════════════════════════════════════
   Network
   ══════════════════════════════════════════════════════════════════ */

const MAX_HTTP_BYTES = 512 * 1024;

const httpRequest: Executor = {
  capabilityId: 'http.request',
  async run(inv) {
    const url = s(inv.input.url);
    if (!/^https?:\/\//i.test(url)) return no('Only http(s) URLs are allowed.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(inv.context.timeoutMs ?? 10_000, 30_000));
    try {
      /* Guarded at the resolver, and at every redirect hop. A URL that
         resolves to loopback, link-local or RFC1918 is refused before a
         connection is made - see `net/ssrfGuard.ts` for why that matters
         in a single-user app. */
      const res = await guardedFetch(url, {
        method: s(inv.input.method, 'GET').toUpperCase(),
        body: inv.input.body === undefined ? undefined : s(inv.input.body),
        signal: controller.signal,
      });
      const buf = await res.arrayBuffer();
      const text = Buffer.from(buf.slice(0, MAX_HTTP_BYTES)).toString('utf8');
      return ok(`${res.status} ${res.statusText}`, { status: res.status, text });
    } catch (error) {
      // Node surfaces DNS/socket failures as a bare "fetch failed" with the
      // real cause nested underneath. Propagating that code matters: the
      // Fabric's retry classifier keys off it, so swallowing it here
      // silently turns every transient network blip into a hard failure.
      /* A blocked address is a refusal, not a network failure. It is
         reported with the reason and NOT with a transient error code, so
         the Fabric's retry classifier does not retry a request that will
         be refused identically every time. */
      if (error instanceof BlockedAddressError) return no(error.message);
      const err = error as Error & { cause?: { code?: string } };
      const code = err.cause?.code;
      const reason = err.name === 'AbortError' ? 'timeout' : (code ?? err.message);
      return no(`The request did not complete: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  },
  async verify(_inv, result) {
    const status = (result.output as { status?: number } | undefined)?.status ?? 0;
    return status >= 200 && status < 400
      ? pass('http-status', `The endpoint answered ${status}.`)
      : fail('http-status', `The endpoint answered ${status}, which is not a success status.`);
  },
};

/* ══════════════════════════════════════════════════════════════════
   AURA internal — every one delegates to WorkspaceManager
   ══════════════════════════════════════════════════════════════════ */

function internalExecutors(manager: WorkspaceManager): Executor[] {
  return [
    {
      capabilityId: 'project.list',
      async run() {
        const projects = manager.listProjects();
        return ok(`${projects.length} ${projects.length === 1 ? 'project' : 'projects'} registered.`, projects);
      },
    },
    {
      capabilityId: 'project.create',
      async run(inv) {
        const name = s(inv.input.name).trim();
        if (!name) return no('A project name is required.');
        const parentPath = inv.input.parentPath === undefined ? undefined : s(inv.input.parentPath);
        const record = manager.createProject({ name, parentPath });
        return ok(`Created "${name}".`, record);
      },
      async verify(inv) {
        const name = s(inv.input.name).trim();
        return manager.listProjects().some((p) => p.name === name)
          ? pass('read-back', 'The project is in the registry.')
          : fail('read-back', 'The project is not in the registry after creation.');
      },
    },
    {
      capabilityId: 'project.open',
      async run(inv) {
        const record = manager.open(s(inv.input.projectId));
        return ok('Project opened.', record);
      },
      async verify(inv) {
        const current = manager.currentProject();
        return current && (current as { id?: string }).id === s(inv.input.projectId)
          ? pass('read-back', 'It is the active project.')
          : fail('read-back', 'The active project did not change.');
      },
    },
    {
      capabilityId: 'project.inspect',
      async run(inv) {
        const profile = manager.profile(s(inv.input.projectId));
        return profile ? ok('Profile read.', profile) : no('That project has no generated profile yet.');
      },
    },
    {
      capabilityId: 'mission.inspect',
      async run(inv) {
        const mission = manager.getMission(s(inv.input.projectId), s(inv.input.missionId));
        return mission ? ok('Mission read.', mission) : no('No mission with that id.');
      },
    },
    {
      capabilityId: 'mission.approve',
      async run(inv) {
        const record = manager.approveMission(s(inv.input.projectId), s(inv.input.missionId));
        return record ? ok('Plan approved.', record) : no('That mission could not be approved.');
      },
      async verify(inv) {
        const mission = manager.getMission(s(inv.input.projectId), s(inv.input.missionId)) as
          { approval?: { status?: string } } | null;
        return mission?.approval?.status === 'approved'
          ? pass('read-back', 'The mission records an approved plan.')
          : fail('read-back', 'The mission still does not record an approval.');
      },
    },
    {
      capabilityId: 'mission.create',
      async run(inv) {
        const projectId = s(inv.input.projectId);
        const text = s(inv.input.text);
        if (!text) return no('A mission description is required.');
        try {
          const record = await manager.runMissionCreation(projectId, text, () => {});
          return ok('Mission created.', record);
        } catch (e) {
          return no((e as Error).message || 'Mission creation failed.');
        }
      },
      async verify(inv) {
        const mission = manager.getMission(s(inv.input.projectId), s(inv.input.text).slice(0, 60));
        return mission
          ? pass('read-back', 'The mission is in the store.')
          : fail('read-back', 'The mission could not be found after creation.');
      },
    },
    {
      capabilityId: 'mission.start',
      async run(inv) {
        const result = manager.startMissionExecution(s(inv.input.projectId), s(inv.input.missionId));
        return result.ok ? ok('Mission execution started.', result.mission) : no(result.error ?? 'Could not start mission execution.');
      },
      async verify(inv) {
        const mission = manager.getMission(s(inv.input.projectId), s(inv.input.missionId)) as
          { execution?: { status?: string } } | null;
        return mission?.execution?.status === 'running'
          ? pass('read-back', 'The mission is executing.')
          : fail('read-back', 'The mission is not running after start.');
      },
    },
    {
      capabilityId: 'knowledge.graph',
      async run(inv) {
        const graph = manager.knowledgeGraph(s(inv.input.projectId));
        return ok('Knowledge graph read.', graph);
      },
    },
    {
      capabilityId: 'memory.search',
      async run(inv) {
        const items = manager.listEngineeringMemory(s(inv.input.projectId));
        const query = s(inv.input.query).toLowerCase();
        const matched = query
          ? (items as { title?: string; summary?: string }[]).filter((m) =>
              `${m.title ?? ''} ${m.summary ?? ''}`.toLowerCase().includes(query))
          : items;
        return ok(`${(matched as unknown[]).length} matching records.`, matched);
      },
    },
    {
      capabilityId: 'governance.audit',
      async run(inv) {
        const projectId = s(inv.input.projectId);
        const profile = manager.profile(projectId);
        if (!profile) return no('That project has no profile to audit yet.');
        return ok('Audit inputs collected.', { projectId, profile });
      },
    },
  ];
}

/* ══════════════════════════════════════════════════════════════════ */

/**
 * Late-bound `workflow.run` hook.
 *
 * The Fabric registers executors before the WorkflowBridge exists, and
 * the bridge cannot import the fabric (cycle). So the hook is stored at
 * module scope here and the bridge registers itself on construction.
 * The executor reads it at invocation time — a capability is never
 * half-wired.
 */
export interface WorkflowRunHook {
  runWorkflow(input: {
    workflowId: string;
    projectId?: string | null;
    inputs?: Record<string, string>;
  }): Promise<{ runId: string; status: 'running' | 'completed' | 'failed' | 'paused'; error?: string }>;
}

let workflowRunHook: WorkflowRunHook | null = null;

export function registerWorkflowRunHook(hook: WorkflowRunHook | null): void {
  workflowRunHook = hook;
}

const workflowRunExecutor: Executor = {
  capabilityId: 'workflow.run',
  async run(inv) {
    const hook = workflowRunHook;
    if (!hook) return no('workflow.run is not wired in this process');
    const workflowId = s(inv.input.workflowId);
    if (!workflowId) return no('workflowId is required');
    const projectId = s(inv.input.projectId) || null;
    const inputs = (inv.input.inputs ?? {}) as Record<string, string>;
    const res = await hook.runWorkflow({ workflowId, projectId, inputs });
    if (res.status === 'failed') return no(res.error ?? `child workflow ${workflowId} failed`);
    // A paused child is success for the parent node: the run parked at an
    // approval and is resumable via the approval API; correlation is
    // carried in the output so the audit trail connects both runs.
    return ok(`Child workflow ${res.status} (run ${res.runId}).`, { runId: res.runId, childStatus: res.status });
  },
};

/**
 * Every executor that genuinely works today. Capabilities absent from
 * this list (GitHub, browser) stay in the manifest so missions can plan
 * around them, and report `unsupported` when called.
 */
export function allExecutors(manager: WorkspaceManager): Executor[] {
  return [
    filesystemList, filesystemRead, filesystemWrite,
    terminalExecute,
    agentDelegate,
    systemInstall,
    gitStatus, gitDiff, gitBranch, gitCommit, gitPush,
    httpRequest,
    workflowRunExecutor,
    ...internalExecutors(manager),
  ];
}
