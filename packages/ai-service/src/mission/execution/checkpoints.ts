/**
 * Checkpoint lifecycle — the human gates of Mission Control v3.
 * ==================================================================
 * Four checkpoints shape every mission:
 *
 *   planning  → passes when the human approves the plan
 *   execution → becomes pending once execution starts; governs whether
 *               task proposals may be generated
 *   review    → opens when all tasks are resolved; requires an explicit
 *               human review pass before completion
 *   completion→ passes when the mission is finished and reindexed
 *
 * These are pure state transitions — `workspace.ts` calls them from the
 * HTTP surface and persists the result.
 */
import type { CheckpointKey, CheckpointState, CheckpointStatus, ExecutionStatus } from './types';

export const CHECKPOINT_LABELS: Record<CheckpointKey, string> = {
  planning: 'Plan approval',
  execution: 'Execution',
  review: 'Mission review',
  completion: 'Completion',
};

export const CHECKPOINT_ORDER: CheckpointKey[] = ['planning', 'execution', 'review', 'completion'];

export function emptyCheckpoints(): CheckpointState[] {
  return CHECKPOINT_ORDER.map((key) => ({ key, label: CHECKPOINT_LABELS[key], status: 'not-started' }));
}

/** The index of the first checkpoint that is not `passed`. */
export function nextCheckpoint(checkpoints: CheckpointState[]): CheckpointState | null {
  return checkpoints.find((c) => c.status !== 'passed') ?? null;
}

export function setCheckpoint(
  checkpoints: CheckpointState[],
  key: CheckpointKey,
  status: CheckpointStatus,
  note?: string,
): CheckpointState[] {
  const at = new Date().toISOString();
  return checkpoints.map((c) => (c.key === key ? { ...c, status, note: note ?? c.note, at: status === 'not-started' ? undefined : at } : c));
}

export function checkpointStatus(checkpoints: CheckpointState[], key: CheckpointKey): CheckpointStatus {
  return checkpoints.find((c) => c.key === key)?.status ?? 'not-started';
}

/** Execution status implied by the checkpoint lifecycle. */
export function statusFromCheckpoints(checkpoints: CheckpointState[], tasksDone: boolean, started: boolean): ExecutionStatus {
  const planning = checkpointStatus(checkpoints, 'planning');
  if (planning !== 'passed') return 'idle';
  if (checkpointStatus(checkpoints, 'completion') === 'passed') return 'completed';
  if (!started) return 'approved';
  if (checkpointStatus(checkpoints, 'review') === 'pending' && tasksDone) return 'reviewing';
  return 'running';
}
