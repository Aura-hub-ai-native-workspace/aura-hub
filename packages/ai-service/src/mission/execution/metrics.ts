/**
 * Mission metrics — deterministic derivation of execution health.
 * ==================================================================
 * Pure function: `computeMetrics(execution, dag)` → `MissionMetrics`.
 * Every number is derived from real state (task runtime statuses,
 * critical path, batch index, elapsed time) — nothing is fabricated.
 */
import type { MissionExecution, MissionMetrics, ExecutionTaskStatus } from './types';

const COUNT_LABELS: { key: keyof Pick<MissionMetrics, 'tasksQueued' | 'tasksWaiting' | 'tasksBlocked' | 'tasksRunning' | 'tasksReview' | 'tasksCompleted' | 'tasksRejected' | 'tasksFailed' | 'tasksCancelled'>; statuses: ExecutionTaskStatus[] }[] = [
  { key: 'tasksQueued', statuses: ['queued', 'paused', 'retrying'] },
  { key: 'tasksWaiting', statuses: ['waiting'] },
  { key: 'tasksBlocked', statuses: ['blocked', 'rollback'] },
  { key: 'tasksRunning', statuses: ['running'] },
  { key: 'tasksReview', statuses: ['review'] },
  { key: 'tasksCompleted', statuses: ['completed'] },
  { key: 'tasksRejected', statuses: ['rejected'] },
  { key: 'tasksFailed', statuses: ['failed'] },
  { key: 'tasksCancelled', statuses: ['cancelled'] },
];

export function computeMetrics(execution: MissionExecution, statuses: Record<string, ExecutionTaskStatus>): MissionMetrics {
  const total = Object.keys(statuses).length;
  const counts: Record<string, number> = { tasksQueued: 0, tasksWaiting: 0, tasksBlocked: 0, tasksRunning: 0, tasksReview: 0, tasksCompleted: 0, tasksRejected: 0, tasksFailed: 0, tasksCancelled: 0 };
  for (const s of Object.values(statuses)) {
    const group = COUNT_LABELS.find((g) => g.statuses.includes(s));
    if (group) counts[group.key] = (counts[group.key] ?? 0) + 1;
  }

  const criticalPath = execution.dag?.criticalPath ?? [];
  const criticalDone = criticalPath.filter((id) => statuses[id] === 'completed').length;
  const criticalTotalMinutes = criticalPath.reduce(
    (acc, id) => acc + (execution.dag?.nodes.find((n) => n.id === id)?.estimatedDurationMinutes ?? 0),
    0,
  );

  const elapsedMinutes = (() => {
    const start = execution.startedAt ? new Date(execution.startedAt).getTime() : 0;
    if (!start) return 0;
    const end = execution.completedAt ? new Date(execution.completedAt).getTime() : Date.now();
    return Math.max(0, Math.round((end - start) / 60000));
  })();

  const batches = execution.dag?.batches ?? [];
  const currentBatch = Math.max(0, Math.min(execution.batchIndex, Math.max(0, batches.length - 1)));
  const remainingMinutes = batches
    .slice(currentBatch)
    .flat()
    .filter((id) => statuses[id] !== 'completed' && statuses[id] !== 'rejected' && statuses[id] !== 'cancelled')
    .reduce((acc, id) => acc + (execution.dag?.nodes.find((n) => n.id === id)?.estimatedDurationMinutes ?? 0), 0);

  return {
    tasksTotal: total,
    tasksQueued: counts.tasksQueued ?? 0,
    tasksWaiting: counts.tasksWaiting ?? 0,
    tasksBlocked: counts.tasksBlocked ?? 0,
    tasksRunning: counts.tasksRunning ?? 0,
    tasksReview: counts.tasksReview ?? 0,
    tasksCompleted: counts.tasksCompleted ?? 0,
    tasksRejected: counts.tasksRejected ?? 0,
    tasksFailed: counts.tasksFailed ?? 0,
    tasksCancelled: counts.tasksCancelled ?? 0,
    completion: total === 0 ? 0 : Math.round((counts.tasksCompleted ?? 0) / total * 100),
    criticalPathLength: criticalPath.length,
    criticalPathDone: criticalDone,
    criticalPathTotal: criticalTotalMinutes,
    parallelBatches: batches.length,
    currentBatch: execution.batchIndex,
    estimatedRemainingMinutes: remainingMinutes,
    elapsedMinutes,
    throughput: elapsedMinutes === 0 ? 0 : Math.round(((counts.tasksCompleted ?? 0) / elapsedMinutes) * 100) / 100,
  };
}
