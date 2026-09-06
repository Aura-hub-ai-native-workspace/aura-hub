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
import path from 'node:path';
import type { Executor, ExecutorResult, Invocation, VerificationReport } from '@aura/capability-fabric';
import { git, parseCommand, resolveAgentBinary, runAgent, safeShellWithCode } from '../exec/process';
import { catalogEntry } from '@aura/connected-environment';
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
const no = (detail: string): ExecutorResult => ({ ok: false, detail });

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
 * How much context may ride along with a task.
 *
 * The whole brief reaches the CLI as ONE argv element, and Windows caps a
 * command line at 32,767 characters. Staying well under that keeps the
 * same call working on every platform rather than failing only on one.
 */
const MAX_CONTEXT_CHARS = 12_000;

/**
 * Compose the brief an agent actually receives: AURA's context, then the
 * task, fenced so the agent can tell orientation from instruction.
 *
 * Truncation is announced in the text itself. An agent that silently
 * received half its context would reason confidently from a fragment.
 */
function withContext(task: string, rawContext: string): string {
  const context = rawContext.trim();
  if (!context) return task;
  const body = context.length > MAX_CONTEXT_CHARS
    ? `${context.slice(0, MAX_CONTEXT_CHARS)}\n[context truncated by AURA at ${MAX_CONTEXT_CHARS} characters]`
    : context;
  return `${body}\n\n<TASK>\n${task}\n</TASK>`;
}

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
    // Confinement first: the agent runs in the project directory the
    // server resolved from the registry, never one the caller supplied.
    const cwd = cwdOf(inv);
    const task = s(inv.input.task).trim();
    if (!task) return no('No task was given for the agent to carry out.');
    const model = s(inv.input.model).trim() || undefined;
    // Context is CONSUMED, never composed here. The caller supplies an
    // already-rendered AURA context contract; this executor only decides
    // how to hand it to the CLI. Assembling repository understanding in
    // this file would create a second one beside Repository Intelligence.
    const brief = withContext(task, s(inv.input.context));

    /* Routing is the Fabric's job now (§22). This executor no longer
       searches the catalogue or probes anything: it is handed the node
       that policy was evaluated against, and refuses if it was not. */
    const node = inv.node;
    if (!node) {
      return no('No coding-agent node was resolved for this call, so nothing was run.');
    }

    const bin = node.binary;
    if (!bin) {
      return no(`${node.name} has no executable recorded in the catalogue, so it cannot be run.`);
    }
    // The allow-list is still enforced here, at the point of execution —
    // routing decides WHICH node, never whether its binary may be spawned.
    if (!resolveAgentBinary(bin).ok) {
      return no(`${node.name} is not on the coding-agent allow-list, so it was not run.`);
    }
    const invocationSpec = AGENT_INVOCATIONS[bin];
    // A resolved node whose CLI has not been verified FAILS. It is never
    // silently swapped for one that would have worked — that substitution
    // is exactly what routing must not do.
    if (!invocationSpec) {
      return no(
        `${node.name} is connected, but AURA has no verified non-interactive invocation for it yet, `
        + `so nothing was run. Verified today: ${Object.keys(AGENT_INVOCATIONS).join(', ')}.`,
      );
    }

    const target = { nodeId: node.id, name: node.name, bin, invocation: invocationSpec };
    const args = target.invocation.args(brief, cwd, model);
    let res: Awaited<ReturnType<typeof runAgent>>;
    try {
      res = await runAgent(target.bin, args, { cwd, timeoutMs: inv.context.timeoutMs });
    } catch (e) {
      return no(`${target.name} could not be run: ${(e as Error).message}`);
    }

    // `nodeId` travels with the result so the work is attributable to the
    // agent that did it rather than to "some coding agent".
    const output = {
      stdout: res.out,
      exitCode: res.code,
      nodeId: target.nodeId,
      agent: target.name,
      args,
      timedOut: res.timedOut ?? false,
      signal: res.signal,
    };
    if (res.code === 0) return ok(`${target.name} completed the task. Exit code 0.`, output);
    // A run that was cut short is reported as cut short, not as a
    // generic failure — the operator needs to know it may be half-done.
    const why = res.timedOut
      ? `${target.name} ran out of time and was stopped. Its changes, if any, are partial.`
      : res.signal
        ? `${target.name} was terminated by ${res.signal}.`
        : `${target.name} exited ${res.code}.`;
    return { ok: false, detail: `${why} ${res.out.slice(0, 400)}`.trim(), output };
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
 * Where the canonical Python Environment backend answers.
 *
 * Fixed loopback, never caller input — so no SSRF surface: the node id
 * travels in the JSON body, never in the URL. Approval has already
 * happened in the Fabric before either executor below runs; this only
 * executes the trusted plan via the single Python executor.
 */
const PYTHON_ENV_BASE =
  process.env.AURA_ENVIRONMENT_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:4320';

async function callPythonEnvironment(
  path: '/environment/install' | '/environment/uninstall',
  nodeId: string,
  timeoutMs?: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs ?? 300_000, 330_000));
  try {
    const res = await fetch(`${PYTHON_ENV_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: nodeId }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const systemInstall: Executor = {
  capabilityId: 'system.install',

  async run(inv) {
    const nodeId = s(inv.input.nodeId).trim();
    if (!nodeId) return no('No node was named, so there is nothing to install.');

    // The catalogue is the only source of truth for what may be installed.
    // An id that is not in it is refused before anything else happens —
    // and before any network call leaves this process.
    const entry = catalogEntry(nodeId);
    if (!entry) {
      return no(`'${nodeId}' is not a node in AURA's catalogue, so there is nothing to install.`);
    }

    // Approved by the Fabric before reaching here. Execution itself lives
    // in exactly one place — the Python Environment API — so this never
    // duplicates the installer, the probe, or their guarantees. Exit 0 is
    // still only a claim there; only its probe can report `installed`.
    let status: number;
    let body: Record<string, unknown>;
    try {
      const r = await callPythonEnvironment('/environment/install', nodeId, inv.context.timeoutMs);
      status = r.status;
      body = r.body;
    } catch {
      return no(
        `The Python Environment API is not answering, so ${entry.name} was not installed. `
        + 'Start it with `npm run environment:api` and try again.',
      );
    }
    const outcome = (body as { installOutcome?: string }).installOutcome;
    if (!outcome) {
      return no(`${entry.name} was not installed. The environment backend answered ${status} without an install result.`);
    }
    if (outcome === 'installed') {
      return ok(
        (body as { detail?: string }).detail || `${entry.name} is installed and verified.`,
        body as unknown as InstallResult,
      );
    }
    // `guided` is an honest handoff, not a failure of this executor — but
    // the Fabric contract reports non-installed outcomes as not-ok while
    // the payload carries the real answer (§25.1).
    return {
      ok: false,
      detail: (body as { detail?: string }).detail || `${entry.name} was not installed.`,
      output: body as unknown as InstallResult,
    };
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

type UninstallOutcome = 'uninstalled' | 'guided' | 'failed' | 'unverified';

interface UninstallResult {
  uninstallOutcome: UninstallOutcome;
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

const systemUninstall: Executor = {
  capabilityId: 'system.uninstall',

  async run(inv) {
    const nodeId = s(inv.input.nodeId).trim();
    if (!nodeId) return no('No node was named, so there is nothing to uninstall.');
    const entry = catalogEntry(nodeId);
    if (!entry) {
      return no(`'${nodeId}' is not a node in AURA's catalogue, so there is nothing to uninstall.`);
    }
    // Approved by the Fabric before reaching here. Execution itself lives
    // in exactly one place — the Python Environment API — so this never
    // duplicates the uninstaller, the probe, or their guarantees.
    let status: number;
    let body: Record<string, unknown>;
    try {
      const r = await callPythonEnvironment('/environment/uninstall', nodeId, inv.context.timeoutMs);
      status = r.status;
      body = r.body;
    } catch {
      return no(
        `The Python Environment API is not answering, so ${entry.name} was not uninstalled. `
        + 'Start it with `npm run environment:api` and try again.',
      );
    }
    const outcome = (body as { uninstallOutcome?: string }).uninstallOutcome;
    if (!outcome) {
      return no(`${entry.name} was not uninstalled. The environment backend answered ${status} without an uninstall result.`);
    }
    if (outcome === 'uninstalled') {
      return ok(
        (body as { detail?: string }).detail || `${entry.name} is removed and verified as absent.`,
        body as unknown as UninstallResult,
      );
    }
    return {
      ok: false,
      detail: (body as { detail?: string }).detail || `${entry.name} was not uninstalled.`,
      output: body as unknown as UninstallResult,
    };
  },

  async verify(_inv, result) {
    const out = result.output as UninstallResult | undefined;
    if (!out) return fail('read-back', 'The uninstaller returned no result to verify.');
    switch (out.uninstallOutcome) {
      case 'uninstalled':
        return pass('read-back', `A fresh probe no longer finds ${out.nodeId}.`);
      case 'guided':
        return fail('read-back', 'Nothing was removed — this needs administrator rights and is waiting on you.');
      case 'unverified':
        return fail('read-back', `The uninstaller exited 0 but a fresh probe still finds ${out.nodeId}.`);
      case 'failed':
        return fail('read-back', out.why ?? 'The uninstaller did not succeed.');
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

const gitPush: Executor = {
  capabilityId: 'git.push',
  async run(inv) {
    const cwd = cwdOf(inv);
    const remote = s(inv.input.remote, 'origin');
    const branch = s(inv.input.branch) || (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).out;
    const res = await git(['push', remote, branch], { cwd });
    return res.code === 0
      ? ok(`Pushed ${branch} to ${remote}.`, { remote, branch, exitCode: res.code })
      : { ok: false, detail: res.out || 'The push failed.', output: { exitCode: res.code } };
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
      const res = await fetch(url, {
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
      /**
       * `workflow.run` — the Fabric delegating to the Workflow Engine.
       *
       * The capability has existed in the manifest since the first
       * release and has had no executor, which meant nothing governed
       * could start a workflow: a mission could not, and neither could a
       * direct `/fabric/invoke`. This closes that.
       *
       * Note what it does NOT do. It does not execute a graph — it calls
       * `startWorkflowRun`, the same single entry point the Run button
       * and the Automation Engine use. There is no second workflow
       * executor here, only a door into the existing one. And it passes
       * no `approvedCapabilities`, so the nodes INSIDE the workflow are
       * governed on their own terms: authorizing "run this workflow" is
       * not authorizing everything the workflow contains.
       */
      capabilityId: 'workflow.run',
      async run(inv) {
        const workflowId = s(inv.input.workflowId);
        const projectId = s(inv.input.projectId);
        const wf = manager.workflows.get(workflowId);
        if (!wf) return no(`No workflow is stored under "${workflowId}".`);
        const started = await manager.startWorkflowRun(wf, {
          projectId,
          trigger: { kind: 'mission', missionId: inv.context.missionId ?? 'none', taskId: inv.context.taskId ?? 'none' },
          actor: inv.context.actor,
        }, () => {});
        const { run, result } = started;
        const detail = `${wf.name} — ${result.runState}, ${Object.keys(run.nodes).length} nodes, run ${run.id}.`;
        // A parked run is not a failure: it is the policy engine working
        // inside the workflow. It is reported as such rather than being
        // flattened into "did not succeed".
        if (result.runState === 'succeeded' || result.runState === 'awaiting-approval') {
          return ok(detail, { runId: run.id, versionId: run.versionId, runState: result.runState, outputs: result.outputs });
        }
        return { ok: false, detail, output: { runId: run.id, versionId: run.versionId, runState: result.runState } };
      },
      async verify(_inv, result) {
        // Read-back: the run record must exist and must not be mid-flight.
        const runId = (result.output as { runId?: string } | undefined)?.runId;
        if (!runId) return fail('read-back', 'The run reported no id, so it cannot be read back.');
        const run = manager.workflowRuns.find(runId);
        if (!run) return fail('read-back', 'No durable record exists for that run.');
        return run.state === 'running' || run.state === 'queued'
          ? fail('read-back', `The run record still says ${run.state}, which cannot be true once this returned.`)
          : pass('read-back', `Run ${run.id} is recorded as ${run.state} against version ${run.versionId}.`);
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
 * Hook for delegating workflow execution to the bridge.
 * Used by WorkflowBridge to intercept workflow.run capability invocations.
 */
export interface WorkflowRunHook {
  runWorkflow(input: { workflowId: string; projectId?: string | null; inputs?: Record<string, string> }): Promise<{ runId: string; status: string; error?: string }>;
}

/** Register a hook for workflow.run capability delegation. */
export function registerWorkflowRunHook(hook: WorkflowRunHook): void {
  // Currently a no-op stub; the bridge calls this at startup to register itself.
  void hook;
}

/* ══════════════════════════════════════════════════════════════════ */

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
    systemUninstall,
    gitStatus, gitDiff, gitBranch, gitCommit, gitPush,
    httpRequest,
    ...internalExecutors(manager),
  ];
}
