/**
 * runViews — pure derivations over a Central Agent event frame list.
 * =====================================================================
 * Extracted from `useAgentRun` so the ONE workspace pipeline (the
 * conversation store `useWorkspaceConversations`, which owns the
 * transcript and the single SSE subscription) can feed the SAME views
 * to the execution timeline. No second submission, no competing
 * runtime: every view here is a fold over frames the backend actually
 * emitted on the store's own session.
 *
 * Nothing in this module knows React. Same input frames → same output,
 * so the store, the timeline and any future consumer agree by
 * construction.
 */
import type { AgentEventFrame } from '../../ai/centralAgentClient';

export interface PlanTask {
  id: string;
  description: string;
  role: string;
  dependsOn: string[];
  conditional: boolean;
  state: string;
  verified: boolean | null;
  detail: string;
  worker: string;
  lifecycle: string;
}

export interface Handoff {
  from: string;
  to: string;
  toWorker: string;
  invocations: string[];
}

export interface ObjectiveState {
  text: string;
  expected: string;
  acceptance: string[];
  accepted: boolean | null;
  unmet: string[];
}

export interface GovernedAction {
  key: string;
  tool: string;
  actionType: string;
  target: string;
  decision: string;
  reason: string;
  worker: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

const blankPlanTask = (id: string): PlanTask => ({
  id, description: '', role: '', dependsOn: [], conditional: false,
  state: 'pending', verified: null, detail: '', worker: '', lifecycle: 'IDLE',
});

/** The plan AURA derived, with per-task state folded from later frames. */
export function derivePlan(events: AgentEventFrame[]): PlanTask[] {
  const order: string[] = [];
  const byId = new Map<string, PlanTask>();
  const take = (id: string) => {
    if (!byId.has(id)) { order.push(id); byId.set(id, blankPlanTask(id)); }
    return byId.get(id)!;
  };
  for (const f of events) {
    const p = f.payload ?? {};
    if (f.type === 'plan.created') {
      const rows = Array.isArray(p.plan) ? (p.plan as Record<string, unknown>[]) : [];
      for (const row of rows) {
        const id = str(row.id);
        if (!id) continue;
        byId.set(id, {
          ...take(id),
          description: str(row.description),
          role: str(row.role),
          dependsOn: Array.isArray(row.dependsOn) ? row.dependsOn.map(str) : [],
          conditional: row.conditional === true,
        });
      }
      if (rows.length === 0 && Array.isArray(p.tasks)) {
        for (const raw of p.tasks as unknown[]) take(str(raw));
      }
    }
    if (f.type === 'invocation.observed' && p.taskId) {
      const id = str(p.taskId);
      byId.set(id, {
        ...take(id),
        state: str(p.state) || take(id).state,
        verified: typeof p.verified === 'boolean' ? p.verified : take(id).verified,
        detail: str(p.detail) || take(id).detail,
      });
    }
    if (f.type === 'worker.lifecycle' && p.taskId) {
      const id = str(p.taskId);
      const prev = take(id);
      byId.set(id, {
        ...prev,
        worker: str(p.worker) || str(p.nodeId) || prev.worker,
        lifecycle: str(p.lifecycle) || prev.lifecycle,
        state: str(p.state) || prev.state,
        verified: typeof p.verified === 'boolean' ? p.verified : prev.verified,
      });
    }
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

/** The user's objective, and whether AURA accepted it — both from the backend. */
export function deriveObjective(events: AgentEventFrame[]): ObjectiveState {
  const out: ObjectiveState = {
    text: '', expected: '', acceptance: [], accepted: null, unmet: [],
  };
  for (const f of events) {
    const p = f.payload ?? {};
    if (f.type === 'plan.created') {
      out.text = str(p.objective) || out.text;
      out.expected = str(p.expectedOutcome) || out.expected;
      if (Array.isArray(p.acceptance)) out.acceptance = p.acceptance.map(str);
    }
    if (f.type === 'verification.completed') {
      if (typeof p.objectiveAccepted === 'boolean') out.accepted = p.objectiveAccepted;
      if (Array.isArray(p.unmet)) out.unmet = p.unmet.map(str);
    }
  }
  return out;
}

/** Verified results AURA passed from one worker to the next, from recorded lineage. */
export function deriveHandoffs(events: AgentEventFrame[]): Handoff[] {
  const byTask = new Map<string, string>();
  const out: Handoff[] = [];
  for (const f of events) {
    if (f.type !== 'worker.lifecycle') continue;
    const p = f.payload ?? {};
    const id = str(p.taskId);
    const worker = str(p.worker) || str(p.nodeId);
    if (id && worker) byTask.set(id, worker);
    const consumed = Array.isArray(p.consumedFrom) ? p.consumedFrom.map(str) : [];
    const deps = Array.isArray(p.dependsOn) ? p.dependsOn.map(str) : [];
    if (consumed.length === 0 || deps.length === 0) continue;
    for (const from of deps) {
      const key = `${from}->${id}`;
      if (out.some((h) => `${h.from}->${h.to}` === key)) continue;
      out.push({ from, to: id, toWorker: worker, invocations: consumed });
    }
  }
  return out.map((h) => ({ ...h, from: byTask.get(h.from) ? `${h.from} (${byTask.get(h.from)})` : h.from }));
}

/** Governed tool actions the backend reported, in stream order. */
export function deriveActions(events: AgentEventFrame[]): GovernedAction[] {
  const out: GovernedAction[] = [];
  events.forEach((f, i) => {
    if (f.type !== 'worker.action') return;
    const p = f.payload ?? {};
    if (p.summary) return;
    out.push({
      key: `${i}-${str(p.sequence)}`,
      tool: str(p.tool),
      actionType: str(p.actionType),
      target: str(p.target) || str(p.command),
      decision: str(p.decision),
      reason: str(p.reason),
      worker: str(p.workerNodeId),
    });
  });
  return out;
}
