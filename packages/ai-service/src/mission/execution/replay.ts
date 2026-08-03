/**
 * Mission replay — frame-captured execution history.
 * ==================================================================
 * Every meaningful transition appends a point-in-time snapshot of the
 * whole execution (`ReplayFrame`). The UI replays these frames forward
 * like a video of the mission. Frames are bounded (`MAX_FRAMES`) so
 * long missions never grow their on-disk record without limit.
 */
import type { ExecutionStatus, ExecutionTaskStatus, CheckpointKey, CheckpointStatus, ReplayFrame } from './types';
import { genId } from '../../workflow/types';

export const MAX_FRAMES = 4000;

export interface SnapshotInput {
  executionStatus: ExecutionStatus;
  taskStates: Record<string, ExecutionTaskStatus>;
  checkpointStates: Record<CheckpointKey, CheckpointStatus>;
  batchIndex: number;
}

export function captureFrame(type: ReplayFrame['type'], input: SnapshotInput, existing: ReplayFrame[]): ReplayFrame[] {
  const frame: ReplayFrame = {
    id: genId('replay'),
    at: new Date().toISOString(),
    type,
    snapshot: {
      executionStatus: input.executionStatus,
      taskStates: { ...input.taskStates },
      checkpointStates: { ...input.checkpointStates },
      batchIndex: input.batchIndex,
      completedCount: Object.values(input.taskStates).filter((s) => s === 'completed').length,
      totalTasks: Object.keys(input.taskStates).length,
    },
  };
  const next = [...existing, frame];
  if (next.length > MAX_FRAMES) next.splice(0, next.length - MAX_FRAMES);
  return next;
}
