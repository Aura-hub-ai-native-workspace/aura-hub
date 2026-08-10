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
import { CATALOG } from '@aura/connected-environment';
import type { Executor, ExecutorResult, Invocation, VerificationReport } from '@aura/capability-fabric';
import { git, parseCommand, resolveAgentBinary, runAgent, safeShellWithCode } from '../exec/process';
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

interface AgentTarget {
  nodeId: string;
  name: string;
  bin: string;
  invocation: AgentInvocation;
}

/**
 * Find an installed coding agent, using the environment detection that
 * already exists.
 *
 * The candidate set comes from the catalogue (`coding-agent`), presence
 * comes from the same `probeNode` the Workspace shows the user, and the
 * binary name comes from that entry's own probe. Nothing is hardcoded and
 * nothing is taken from the caller, so this cannot be pointed at an
 * arbitrary executable.
 */
async function resolveAgent(preferredNodeId?: string): Promise<{ target?: AgentTarget; reason: string }> {
  const candidates = CATALOG.filter((e) => e.capabilities.includes('coding-agent') && !!e.probe);
  const ordered = preferredNodeId
    ? candidates.filter((e) => e.id === preferredNodeId)
    : candidates;

  if (preferredNodeId && ordered.length === 0) {
    return { reason: `'${preferredNodeId}' is not a known coding-agent node.` };
  }

  const seen: string[] = [];
  for (const entry of ordered) {
    const bin = entry.probe!.command;
    const invocation = AGENT_INVOCATIONS[bin];
    // Refuse rather than improvise for an agent whose CLI we have not
    // verified — see AGENT_INVOCATIONS.
    if (!invocation) { seen.push(`${entry.name} (no verified invocation)`); continue; }
    if (!resolveAgentBinary(bin).ok) { seen.push(`${entry.name} (not on the agent allow-list)`); continue; }

    const probe = await probeNode(entry.id);
    if (!probe.present) { seen.push(`${entry.name} (not installed)`); continue; }

    return { target: { nodeId: entry.id, name: entry.name, bin, invocation }, reason: '' };
  }
  return {
    reason: `No usable coding agent was found. Checked: ${seen.join(', ') || 'nothing in the catalogue'}.`,
  };
}

const agentDelegate: Executor = {
  capabilityId: 'agent.delegate',
  async run(inv) {
    // Confinement first: the agent runs in the project directory the
    // server resolved from the registry, never one the caller supplied.
    const cwd = cwdOf(inv);
    const task = s(inv.input.task).trim();
    if (!task) return no('No task was given for the agent to carry out.');
    const model = s(inv.input.model).trim() || undefined;

    // `nodeId` narrows which agent runs; it can never widen the set,
    // because the candidates come from the catalogue either way.
    const { target, reason } = await resolveAgent(s(inv.input.nodeId).trim() || undefined);
    if (!target) return no(reason);

    const args = target.invocation.args(task, cwd, model);
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
 * Every executor that genuinely works today. Capabilities absent from
 * this list (GitHub, browser) stay in the manifest so missions can plan
 * around them, and report `unsupported` when called.
 */
export function allExecutors(manager: WorkspaceManager): Executor[] {
  return [
    filesystemList, filesystemRead, filesystemWrite,
    terminalExecute,
    agentDelegate,
    gitStatus, gitDiff, gitBranch, gitCommit, gitPush,
    httpRequest,
    ...internalExecutors(manager),
  ];
}
