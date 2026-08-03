/**
 * Execution DAG — deterministic ordering machinery for Mission Control v3.
 * ==================================================================
 * Consumes ONLY the already-computed plan (`goalGraph.tasks` from the
 * `MissionRecord`): dependencies, priorities, risk and durations that
 * planning already produced. Nothing here re-runs planning and nothing
 * here invents facts about the codebase.
 *
 * Responsibilities:
 *   • validate the task graph (cycle detection)
 *   • compute topological depth + parallel batches (auto-ordering)
 *   • compute the critical path (longest duration dependency chain)
 *   • map planning task states onto the runtime state machine
 */
import type { ExecutionTaskStatus, ExecutionDag, DagNode, DagEdge } from './types';
import { PLANNING_TO_RUNTIME } from './types';
import type { MissionTask } from '../types';

export interface DagInput {
  tasks: MissionTask[];
  getRuntimeStatus?: (taskId: string) => ExecutionTaskStatus | null;
}

const DEP_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const RISK_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** Topological sort (Kahn's algorithm) with tie-breaking for determinism. */
function topoSort(tasks: MissionTask[], blockedBy: Map<string, Set<string>>): { order: string[]; hasCycle: boolean; cycle: string[] } {
  const indeg = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();
  for (const t of tasks) {
    indeg.set(t.id, 0);
    dependents.set(t.id, new Set());
  }
  for (const t of tasks) {
    for (const dep of blockedBy.get(t.id) ?? []) {
      indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
      dependents.get(dep)?.add(t.id);
    }
  }
  const ready: string[] = tasks.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id);
  const byPriority = new Map<string, number>();
  for (const t of tasks) byPriority.set(t.id, DEP_WEIGHT[t.priority] ?? 1);
  ready.sort((a, b) => (byPriority.get(b) ?? 1) - (byPriority.get(a) ?? 1));

  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    const deps = dependents.get(id) ?? new Set();
    for (const d of deps) {
      const next = (indeg.get(d) ?? 1) - 1;
      indeg.set(d, next);
      if (next === 0) {
        const insertAt = ready.findIndex((r) => (byPriority.get(r) ?? 1) < (byPriority.get(d) ?? 1));
        if (insertAt < 0) ready.push(d);
        else ready.splice(insertAt, 0, d);
      }
    }
  }
  if (order.length === tasks.length) return { order, hasCycle: false, cycle: [] };
  const remaining = new Set(tasks.map((t) => t.id).filter((id) => !order.includes(id)));
  return { order, hasCycle: true, cycle: [...remaining] };
}

/**
 * Build the execution DAG for a mission's plan.
 *
 * `getRuntimeStatus` lets callers overlay current execution state onto
 * the graph; when omitted the plan's own task status is mapped through
 * `PLANNING_TO_RUNTIME`.
 */
export function buildDag(input: DagInput): ExecutionDag {
  const { tasks } = input;
  const statusOf = (id: string): ExecutionTaskStatus =>
    input.getRuntimeStatus?.(id) ?? PLANNING_TO_RUNTIME[tasks.find((t) => t.id === id)?.status ?? 'pending'];

  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const blockedBy = new Map<string, Set<string>>();
  for (const t of tasks) {
    const deps = new Set<string>();
    for (const d of t.dependencies) {
      if (byId.has(d)) deps.add(d);
    }
    blockedBy.set(t.id, deps);
  }

  const { order, hasCycle, cycle } = topoSort(tasks, blockedBy);

  // Depth = longest dependency chain. Batch = depth, so a node with no
  // deps is batch 0, its direct dependents batch 1, etc. — the engine's
  // auto-ordering runs one batch at a time.
  const depth = new Map<string, number>();
  const batch = new Map<string, number>();
  for (const id of order) {
    const deps = blockedBy.get(id) ?? new Set();
    let d = 0;
    for (const dep of deps) d = Math.max(d, (depth.get(dep) ?? 0) + 1);
    depth.set(id, d);
    batch.set(id, d);
  }

  // Critical path — longest total-duration chain. Handles cycles by
  // treating cyclic nodes as a single stub (they get depth 0 edges).
  const criticalPath: string[] = [];
  let criticalDurationMinutes = 0;
  {
    const longest = new Map<string, number>();
    const parent = new Map<string, string | null>();
    for (const id of order) {
      const deps = blockedBy.get(id) ?? new Set();
      let best = 0;
      let bestParent: string | null = null;
      for (const dep of deps) {
        const via = (longest.get(dep) ?? 0) + (byId.get(dep)?.estimatedDurationMinutes ?? 0);
        if (via > best) { best = via; bestParent = dep; }
      }
      longest.set(id, best);
      parent.set(id, bestParent);
      const total = best + (byId.get(id)?.estimatedDurationMinutes ?? 0);
      if (total > criticalDurationMinutes) criticalDurationMinutes = total;
    }
    const end = [...order].reduce((acc, id) => ((longest.get(id) ?? 0) > (longest.get(acc) ?? 0) ? id : acc), order[0]);
    let cur: string | null = end;
    while (cur) {
      criticalPath.unshift(cur);
      cur = parent.get(cur) ?? null;
    }
  }

  const nodes: DagNode[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    targetFile: t.targetFile,
    priority: t.priority,
    risk: t.risk,
    owner: t.owner,
    estimatedDurationMinutes: t.estimatedDurationMinutes,
    depth: depth.get(t.id) ?? 0,
    batch: batch.get(t.id) ?? 0,
    dependencies: [...(blockedBy.get(t.id) ?? [])],
    blockedBy: [...(blockedBy.get(t.id) ?? [])],
    status: statusOf(t.id),
  }));

  const edges: DagEdge[] = [];
  for (const t of tasks) {
    for (const dep of blockedBy.get(t.id) ?? []) {
      edges.push({ from: dep, to: t.id, kind: 'dependency' });
    }
  }

  // Batch grouping in auto-execution order (ties broken by priority).
  const batchMap = new Map<number, string[]>();
  for (const id of order) {
    const b = batch.get(id) ?? 0;
    const arr = batchMap.get(b) ?? [];
    arr.push(id);
    batchMap.set(b, arr);
  }
  const batches = [...batchMap.keys()].sort((a, b) => a - b).map((b) => batchMap.get(b) ?? []);

  // Failure of a high-risk critical task blocks its whole subtree until
  // a human resolves it — surface that as explicit `block` edges.
  for (const t of tasks) {
    if (t.risk !== 'high') continue;
    const deps = blockedBy.get(t.id) ?? new Set();
    for (const d of deps) {
      const parent = byId.get(d);
      if (parent && parent.risk === 'high') {
        edges.push({ from: d, to: t.id, kind: 'block' });
      }
    }
  }

  return {
    nodes,
    edges,
    criticalPath,
    criticalDurationMinutes,
    batches,
    hasCycle,
    cycle,
  };
}

/** Which tasks are runnable right now (deps satisfied, not terminal). */
export function runnableTaskIds(dag: ExecutionDag, statusOf: (id: string) => ExecutionTaskStatus): string[] {
  const status = new Map(dag.nodes.map((n) => [n.id, statusOf(n.id)] as const));
  return dag.nodes
    .filter((n) => {
      if (status.get(n.id) !== 'queued' && status.get(n.id) !== 'waiting') return false;
      return n.dependencies.every((dep) => status.get(dep) === 'completed');
    })
    .sort((a, b) => a.batch - b.batch || (DEP_WEIGHT[b.priority] ?? 1) - (DEP_WEIGHT[a.priority] ?? 1) || RISK_WEIGHT[a.risk] - RISK_WEIGHT[b.risk])
    .map((n) => n.id);
}

