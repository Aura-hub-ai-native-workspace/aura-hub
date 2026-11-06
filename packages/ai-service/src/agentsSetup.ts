/**
 * Runs AURA's one agent-setup script (`aura-agents.mjs`) for the desktop app.
 *
 * The script installs the six coding agents, connects the common-context MCP server to each and
 * reports who is signed in. It lives at `resources/setup/aura-agents.mjs` in the packaged app and
 * at `scripts/agents/aura-agents.mjs` in a checkout; it is always run with the same Node that runs
 * this service, so no system Node is needed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface AgentSetupEvent {
  agent: string;
  step: string;
  status: 'running' | 'done' | 'failed' | 'log';
  detail?: string;
}

export interface AgentStatus {
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  mcpConnected: boolean;
  signedIn: boolean;
  signIn: string;
  hint: string | null;
  headless: boolean;
}

/** Where the script is: explicit override, next to this bundle, or the repository copy. */
export function agentsScriptPath(): string | null {
  const candidates = [
    process.env.AURA_AGENTS_SCRIPT,
    path.join(path.dirname(process.argv[1] ?? ''), 'setup', 'aura-agents.mjs'),
  ];
  for (let dir = process.cwd(), i = 0; i < 6; i++, dir = path.dirname(dir)) {
    candidates.push(path.join(dir, 'scripts', 'agents', 'aura-agents.mjs'));
  }
  return candidates.find((p): p is string => !!p && fs.existsSync(p)) ?? null;
}

/** One JSON object per stdout line; anything else is passed on as a log line. */
function lines(onLine: (line: string) => void) {
  let buf = '';
  return (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

/** Agent ids the script knows; anything else is refused before a process starts. */
export const AGENT_IDS = ['opencode', 'kilo-code', 'freebuff', 'claude-code', 'codex-cli', 'agy', 'pi'] as const;
export const isAgentId = (x: unknown): x is string => typeof x === 'string' && (AGENT_IDS as readonly string[]).includes(x);

/** Run `setup --json` (or `add <id> --json`), calling `emit` for every step. Resolves with the exit code. */
export function runAgentSetup(
  emit: (e: AgentSetupEvent) => void,
  opts: { only?: string[]; add?: string; signal?: AbortSignal; script?: string | null } = {},
): Promise<number> {
  const script = opts.script ?? agentsScriptPath();
  if (!script) {
    emit({ agent: 'aura', step: 'setup', status: 'failed', detail: 'the agent setup script is missing from this install' });
    return Promise.resolve(1);
  }
  const args = opts.add
    ? [script, 'add', opts.add, '--json']
    : [script, 'setup', '--json', ...(opts.only?.length ? ['--only', opts.only.join(',')] : [])];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const onLine = (line: string) => {
      try {
        const e = JSON.parse(line) as AgentSetupEvent;
        if (e && typeof e.agent === 'string' && typeof e.step === 'string') return emit(e);
      } catch { /* not an event */ }
      emit({ agent: 'aura', step: 'setup', status: 'log', detail: line.slice(0, 300) });
    };
    child.stdout.on('data', lines(onLine));
    child.stderr.on('data', lines((l) => emit({ agent: 'aura', step: 'setup', status: 'log', detail: l.slice(0, 300) })));
    opts.signal?.addEventListener('abort', () => child.kill());
    child.on('error', (e) => { emit({ agent: 'aura', step: 'setup', status: 'failed', detail: e.message }); resolve(1); });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** `status --json`: who is installed, connected and signed in. */
export function agentStatus(script: string | null = agentsScriptPath()): Promise<AgentStatus[]> {
  if (!script) return Promise.reject(new Error('the agent setup script is missing from this install'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, 'status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim().split('\n').pop() ?? '');
        if (Array.isArray(parsed)) return resolve(parsed as AgentStatus[]);
      } catch { /* fall through */ }
      reject(new Error(`agent status failed (exit ${code}): ${err.trim().slice(0, 200)}`));
    });
  });
}

/** Run a short script command that prints one JSON line (list, remove). */
function runJson<T>(args: string[], script: string | null = agentsScriptPath()): Promise<T> {
  if (!script) return Promise.reject(new Error('the agent setup script is missing from this install'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      try { if (code === 0) return resolve(JSON.parse(out.trim().split('\n').pop() ?? '') as T); } catch { /* fall through */ }
      reject(new Error(`agents ${args[0]} failed (exit ${code}): ${err.trim().slice(0, 200)}`));
    });
  });
}

export interface AgentChoice { selected: string[]; available: { id: string; name: string; signIn: string }[] }
export const listAgentChoice = () => runJson<AgentChoice>(['list']);
export const removeAgent = (id: string) => runJson<{ selected: string[] }>(['remove', id]);
