/** The backend's goal loop: one goal per project, worked on until it is met or stopped. */
import { AGENT_BASE, backendFetch } from '../backend/backendSession';

export type GoalMode = 'until-achieved' | 'keep-improving';
export type GoalState = 'running' | 'waiting' | 'achieved' | 'stopped';

export interface GoalCycle {
  n: number;
  sessionId?: string;
  outcome?: string | null;
  failureReason?: string | null;
  summary?: string;
  kind: 'achieved' | 'wait' | 'replan';
  endedAt?: string;
}

export interface Goal {
  goalId: string;
  goal: string;
  projectPath: string;
  mode: GoalMode;
  state: GoalState;
  /** Only the latest cycles are kept in detail; these totals cover all of them. */
  cycles: GoalCycle[];
  stats?: { cycles: number; achieved: number; wait: number; replan: number };
  currentSessionId: string | null;
  nextAttemptAt: string | null;
  note: string | null;
  createdAt: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await backendFetch(`${AGENT_BASE}${path}`, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

export const listGoals = () => call<{ goals: Goal[] }>('/goals').then((r) => r.goals);
export const startGoal = (goal: string, projectPath: string, mode: GoalMode) =>
  call<{ goal: Goal }>('/goals', post({ goal, projectPath, mode })).then((r) => r.goal);
export const stopGoal = (goalId: string) =>
  call<{ goal: Goal }>(`/goals/${encodeURIComponent(goalId)}/stop`, post({})).then((r) => r.goal);

/** The goal to show for a project: the active one, else the most recent. */
export function goalForProject(goals: Goal[], projectPath: string): Goal | null {
  const mine = goals.filter((g) => g.projectPath === projectPath);
  return mine.find((g) => g.state === 'running' || g.state === 'waiting') ?? mine[0] ?? null;
}

export function goalStatusText(goal: Goal): string {
  const n = goal.stats?.cycles ?? goal.cycles.length;
  const cycles = `${n.toLocaleString('en-US')} cycle${n === 1 ? '' : 's'}`;
  switch (goal.state) {
    case 'running': return goal.currentSessionId ? `Working · cycle ${n + 1}` : `Working · ${cycles} so far`;
    case 'waiting': return goal.note ? `Waiting · ${goal.note}` : 'Waiting to retry';
    case 'achieved': return `Done · ${goal.note ?? cycles}`;
    default: return `Stopped · ${cycles}`;
  }
}

export function cycleText(c: GoalCycle): string {
  const result = c.kind === 'achieved' ? 'met the goal' : c.kind === 'wait' ? 'will retry' : 're-planning';
  const why = c.failureReason ? ` (${c.failureReason})` : '';
  return `Cycle ${c.n}: ${c.outcome ?? 'ended'}${why}, ${result}`;
}
