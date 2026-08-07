/**
 * Mission Control v3 — Execution Domain types.
 * ==================================================================
 * Planning (Mission Control v2's 9 stages) produces a `MissionRecord`
 * whose `goalGraph` is the executable plan. Everything in this module
 * describes what happens AFTER approval: a per-task runtime state
 * machine, a deterministic execution DAG (dependencies/blocks/critical
 * path/parallel batches/auto-ordering), a checkpoint lifecycle, a
 * canonical mission timeline, an activity feed, and replay frames.
 *
 * The execution engine is a pure state machine over this data — it
 * never re-runs planning and it never touches the real filesystem.
 * Side effects (generating task proposals, writing accepted diffs to
 * disk) are injected from `workspace.ts`, which keeps execution as
 * human-gated as before: the plan must be approved before any task
 * runs, and every diff is written only after an explicit per-task
 * Accept.
 *
 * These types are imported (type-only) by `mission/types.ts`, so this
 * file deliberately re-declares nothing and imports only what it needs.
 */
import type {
  MissionCategory,
  TaskKind,
  TaskMode,
  TaskPriority,
  TaskRisk,
  TaskStatus,
} from '../types';

/* ── Task runtime state machine ───────────────────────────────────── */
/**
 * A task's state DURING execution. This is richer than the planning
 * `TaskStatus` (pending/proposed/accepted/rejected/done/error) because
 * it must also model ordering (waiting/blocked/queued) and runtime
 * conditions (running/paused/retrying/failed/rollback/cancelled).
 */
export type ExecutionTaskStatus =
  | 'queued'      // deps resolved, eligible to run in the current batch
  | 'waiting'     // deps exist but are not all completed yet
  | 'blocked'     // an unsatisfiable dependency / failed dep / unmet checkpoint
  | 'running'     // proposal generation in progress
  | 'paused'      // execution paused mid-run
  | 'review'      // proposal generated — awaiting human Accept/Reject
  | 'completed'   // accepted & written (or manually completed)
  | 'rejected'    // proposal rejected by the human
  | 'cancelled'   // mission cancelled
  | 'retrying'    // retried after a transient failure
  | 'failed'      // error — needs human attention
  | 'rollback';   // being rolled back

/** Checkpoint lifecycle — human gates across the whole execution. */
export type CheckpointKey = 'planning' | 'execution' | 'review' | 'completion';
export type CheckpointStatus = 'not-started' | 'pending' | 'passed' | 'failed' | 'skipped';

export interface CheckpointState {
  key: CheckpointKey;
  label: string;
  status: CheckpointStatus;
  at?: string;
  note?: string;
}

/* ── Execution status (whole mission) ─────────────────────────────── */
export type ExecutionStatus =
  | 'idle'        // plan built, not yet approved
  | 'approved'    // plan approved, awaiting execution start
  | 'running'     // tasks being executed
  | 'paused'
  | 'reviewing'   // all tasks done — mission-level review checkpoint open
  | 'completed'
  | 'cancelled'
  | 'failed';

/* ── DAG ──────────────────────────────────────────────────────────── */
export type DagEdgeKind = 'dependency' | 'block';

export interface DagNode {
  id: string;
  title: string;
  kind: TaskKind;
  targetFile: string | null;
  priority: TaskPriority;
  risk: TaskRisk;
  owner: 'ai' | 'human';
  estimatedDurationMinutes: number;
  /** Topological depth — longest chain of dependencies above this node. */
  depth: number;
  /** Batch (wave) index — nodes with the same batch can run in parallel. */
  batch: number;
  dependencies: string[];
  blockedBy: string[];
  status: ExecutionTaskStatus;
}

export interface DagEdge {
  from: string;
  to: string;
  kind: DagEdgeKind;
}

export interface ExecutionDag {
  nodes: DagNode[];
  edges: DagEdge[];
  /** Critical path = longest total-duration dependency chain. */
  criticalPath: string[];
  criticalDurationMinutes: number;
  /** Batches of parallelisable task ids, in auto-execution order. */
  batches: string[][];
  hasCycle: boolean;
  cycle: string[];
}

/* ── Timeline / Activity / Replay ─────────────────────────────────── */
export type TimelineType =
  | 'created'
  | 'approved'
  | 'rejected-plan'
  | 'execution-started'
  | 'execution-paused'
  | 'task-started'
  | 'task-proposed'
  | 'task-accepted'
  | 'task-rejected'
  | 'task-completed'
  | 'task-failed'
  | 'task-retried'
  | 'checkpoint'
  | 'review-passed'
  | 'completed'
  | 'cancelled'
  | 'note';

export type ActorKind = 'ai' | 'human' | 'system';

export interface TimelineEntry {
  id: string;
  at: string;
  type: TimelineType;
  actor: ActorKind;
  title: string;
  detail?: string;
  taskId?: string;
  checkpoint?: CheckpointKey;
}

/** The activity feed is a second projection of the same moments. */
export interface ActivityEntry {
  id: string;
  at: string;
  actor: ActorKind;
  kind: TimelineType;
  message: string;
  taskId?: string;
  checkpoint?: CheckpointKey;
}

/** A replay frame is a point-in-time snapshot of the whole execution. */
export interface ReplayFrame {
  id: string;
  at: string;
  type: 'created' | 'approved' | 'state' | 'task' | 'checkpoint' | 'done';
  snapshot: {
    executionStatus: ExecutionStatus;
    taskStates: Record<string, ExecutionTaskStatus>;
    checkpointStates: Record<CheckpointKey, CheckpointStatus>;
    batchIndex: number;
    completedCount: number;
    totalTasks: number;
  };
}

/* ── Metrics ──────────────────────────────────────────────────────── */
export interface MissionMetrics {
  tasksTotal: number;
  tasksQueued: number;
  tasksWaiting: number;
  tasksBlocked: number;
  tasksRunning: number;
  tasksReview: number;
  tasksCompleted: number;
  tasksRejected: number;
  tasksFailed: number;
  tasksCancelled: number;
  /** 0..100 — completed / total. */
  completion: number;
  criticalPathLength: number;
  criticalPathDone: number;
  criticalPathTotal: number;
  parallelBatches: number;
  currentBatch: number;
  estimatedRemainingMinutes: number;
  elapsedMinutes: number;
  /** Average tasks completed per minute of active execution. */
  throughput: number;
}

/* ── The full execution state attached to a MissionRecord ─────────── */
export interface MissionExecution {
  status: ExecutionStatus;
  checkpoints: CheckpointState[];
  timeline: TimelineEntry[];
  activity: ActivityEntry[];
  replay: ReplayFrame[];
  dag: ExecutionDag | null;
  metrics: MissionMetrics | null;
  batchIndex: number;
  startedAt?: string;
  completedAt?: string;
  lastUpdatedAt: string;
}

/* ── SSE events broadcast during execution ────────────────────────── */
export type ExecutionEvent =
  | { type: 'execution'; record: { id: string; projectId: string; execution: MissionExecution } }
  | { type: 'error'; message: string };

/** Map a planning TaskStatus to its runtime equivalent. */
export const PLANNING_TO_RUNTIME: Record<TaskStatus, ExecutionTaskStatus> = {
  pending: 'queued',
  proposed: 'review',
  accepted: 'completed',
  rejected: 'rejected',
  done: 'completed',
  error: 'failed',
};

/** Convenience re-exports so callers can import the whole domain in one line. */
export type { MissionCategory, TaskKind, TaskMode, TaskPriority, TaskRisk };
