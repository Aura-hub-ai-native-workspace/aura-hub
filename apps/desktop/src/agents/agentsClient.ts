/**
 * The workspace's coding agents: setup progress, sign-in status, add and remove, from
 * the AI service (`/agents/*`), which runs AURA's one setup script.
 */
import { AI_BASE, backendFetch } from '../backend/backendSession';

export const AGENT_IDS = ['opencode', 'kilo-code', 'freebuff', 'claude-code', 'codex-cli', 'agy', 'pi'] as const;
/** The four agents a workspace starts with. */
export const DEFAULT_AGENTS: AgentId[] = ['opencode', 'kilo-code', 'claude-code', 'codex-cli'];
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentSetupEvent {
  agent: string;
  step: string;
  status: 'running' | 'done' | 'failed' | 'log';
  detail?: string;
}

export interface AgentStatus {
  id: AgentId;
  name: string;
  installed: boolean;
  version: string | null;
  mcpConnected: boolean;
  signedIn: boolean;
  /** How this agent signs in ("OpenCode Go", "Chrome", …), or "skipped". */
  signIn: string;
  hint: string | null;
  headless: boolean;
}

export async function fetchAgentStatus(): Promise<AgentStatus[]> {
  const res = await backendFetch(`${AI_BASE}/agents/status`);
  const body = (await res.json().catch(() => ({}))) as { agents?: AgentStatus[]; message?: string };
  if (!res.ok || !Array.isArray(body.agents)) throw new Error(body.message ?? `agent status failed (${res.status})`);
  return body.agents;
}

export interface AgentChoice { selected: AgentId[]; available: { id: AgentId; name: string; signIn: string }[] }

export async function fetchAgentChoice(): Promise<AgentChoice> {
  const res = await backendFetch(`${AI_BASE}/agents/list`);
  const body = (await res.json().catch(() => ({}))) as AgentChoice & { message?: string };
  if (!res.ok || !Array.isArray(body.selected)) throw new Error(body.message ?? `agent list failed (${res.status})`);
  return body;
}

/** Take an agent off the workspace (the program and its sign-in stay on the machine). */
export async function removeAgentFromWorkspace(id: AgentId): Promise<AgentId[]> {
  const res = await backendFetch(`${AI_BASE}/agents/remove`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
  });
  const body = (await res.json().catch(() => ({}))) as { selected?: AgentId[]; message?: string };
  if (!res.ok || !body.selected) throw new Error(body.message ?? `remove failed (${res.status})`);
  return body.selected;
}

/** Run setup (or add one agent); `onEvent` gets every step. Resolves when the stream ends. */
export async function runAgentSetup(onEvent: (e: AgentSetupEvent) => void, only?: AgentId[], add?: AgentId): Promise<void> {
  const res = await backendFetch(`${AI_BASE}/agents/${add ? 'add' : 'setup'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(add ? { id: add } : only ? { only } : {}),
  });
  if (!res.ok || !res.body) {
    onEvent({ agent: 'aura', step: 'setup', status: 'failed', detail: `setup could not start (${res.status})` });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') return;
      try { onEvent(JSON.parse(d) as AgentSetupEvent); } catch { /* skip a malformed line */ }
    }
  }
}

/** Where each agent stands after setup, from its events. */
export type RowState = 'waiting' | 'working' | 'ready' | 'failed';

export function reduceSetup(rows: Record<string, { state: RowState; detail: string }>, e: AgentSetupEvent) {
  if (!AGENT_IDS.includes(e.agent as AgentId)) return rows;
  const prev = rows[e.agent] ?? { state: 'waiting' as RowState, detail: '' };
  let next = prev;
  if (e.step === 'finished') next = { state: e.status === 'done' ? 'ready' : 'failed', detail: e.status === 'done' ? 'Ready' : prev.detail || 'Failed' };
  else if (e.status === 'failed') next = { state: 'failed', detail: e.detail ?? 'Failed' };
  else if (e.step === 'install' && e.status === 'running') next = { state: 'working', detail: 'Installing…' };
  else if (e.step === 'install' && e.status === 'done') next = { state: 'working', detail: e.detail === 'present' ? 'Already installed' : 'Installed' };
  else if (e.step === 'mcp') next = { state: 'working', detail: 'Connecting common-context…' };
  return next === prev ? rows : { ...rows, [e.agent]: next };
}

/** What the sign-in page shows for one agent. */
export function signInLabel(a: AgentStatus): string {
  if (!a.installed) return 'Not installed';
  if (a.signIn === 'skipped') return 'Skipped — sign in later';
  return a.signedIn ? 'Signed in' : `Not signed in · ${a.signIn}`;
}
