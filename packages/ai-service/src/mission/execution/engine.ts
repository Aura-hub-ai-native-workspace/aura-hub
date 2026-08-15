/**
 * Mission Execution Engine — the v3 state machine.
 * ==================================================================
 * Consumes ONLY the already-computed plan (`goalGraph.tasks`) — it never
 * re-runs planning and never touches the filesystem. Side effects are
 * injected:
 *
 *   • `runTask`  — generates a task proposal (workspace delegates to
 *                  `generateTaskProposal`); the engine only records the
 *                  result and flips the state machine.
 *   • `persist`  — the engine hands the fully-updated record back for
 *                  atomic save + SSE broadcast.
 *
 * Human gating is unchanged from v2: no task runs before the plan is
 * approved, and no diff is ever written to disk before an explicit
 * per-task Accept. The engine automates only ordering and proposal
 * generation — the two gates stay human.
 *
 * The machine is intentionally honest: every transition is computed
 * from current state, and invalid transitions (e.g. accepting a task
 * that has no proposal) return without mutating.
 */
import { buildDag, runnableTaskIds, type DagInput } from './dag';
import { computeMetrics } from './metrics';
import { captureFrame } from './replay';
import {
  emptyCheckpoints,
  setCheckpoint,
  checkpointStatus,
  nextCheckpoint,
  statusFromCheckpoints,
} from './checkpoints';
import {
  PLANNING_TO_RUNTIME,
  type ActivityEntry,
  type ActorKind,
  type CheckpointKey,
  type CheckpointStatus,
  type ExecutionEvent,
  type ExecutionTaskStatus,
  type MissionExecution,
  type ReplayFrame,
  type TimelineEntry,
  type TimelineType,
} from './types';
import { genId } from '../../workflow/types';
import type { MissionRecord, MissionTask, TaskMode, TaskProposal, TaskStatus } from '../types';
import type { TaskNode } from './nodes';

export interface RunTaskResult {
  ok: boolean;
  error?: string;
  proposal?: TaskProposal;
  mode?: TaskMode;
  /** The execution node that actually produced this result. */
  executedNode?: TaskNode;
}

export interface EngineHooks {
  runTask: (ctx: { record: MissionRecord; task: MissionTask }) => Promise<RunTaskResult>;
  persist: (record: MissionRecord) => void;
  emit?: (e: ExecutionEvent) => void;
}

export interface RunReadyOptions {
  maxParallel?: number;
}

const RUNTIME_TO_PLANNING: Record<ExecutionTaskStatus, TaskStatus> = {
  queued: 'pending',
  waiting: 'pending',
  blocked: 'pending',
  running: 'pending',
  paused: 'pending',
  review: 'proposed',
  completed: 'accepted',
  rejected: 'rejected',
  cancelled: 'rejected',
  retrying: 'pending',
  failed: 'error',
  rollback: 'pending',
};

const timeline = (type: TimelineType, actor: ActorKind, title: string, extra?: Partial<TimelineEntry>): TimelineEntry => ({
  id: genId('evt'),
  at: new Date().toISOString(),
  type,
  actor,
  title,
  ...extra,
});

const activity = (actor: ActorKind, kind: TimelineType, message: string, extra?: Partial<ActivityEntry>): ActivityEntry => ({
  id: genId('act'),
  at: new Date().toISOString(),
  actor,
  kind,
  message,
  ...extra,
});

export class MissionExecutionEngine {
  constructor(private hooks: EngineHooks) {}

  private commit(record: MissionRecord): MissionRecord {
    this.hooks.persist(record);
    if (record.execution) {
      this.hooks.emit?.({ type: 'execution', record: { id: record.id, projectId: record.projectId, execution: record.execution } });
    }
    return record;
  }

  /** Runtime status of a single task, derived from the plan's own status + runs. */
  private statusForTask(record: MissionRecord, taskId: string): ExecutionTaskStatus {
    const t = record.goalGraph?.tasks.find((x) => x.id === taskId);
    if (!t) return 'queued';
    const run = record.taskRuns.find((r) => r.taskId === taskId);
    if (run?.proposal?.error) return 'failed';
    return PLANNING_TO_RUNTIME[t.status] ?? 'queued';
  }

  /** Runtime status per task, derived from the plan's own status + runs. */
  private taskStatuses(record: MissionRecord): Record<string, ExecutionTaskStatus> {
    const out: Record<string, ExecutionTaskStatus> = {};
    for (const t of record.goalGraph?.tasks ?? []) out[t.id] = this.statusForTask(record, t.id);
    return out;
  }

  private build(record: MissionRecord): { dag: ReturnType<typeof buildDag>; statuses: Record<string, ExecutionTaskStatus> } {
    const tasks = record.goalGraph?.tasks ?? [];
    const statuses = this.taskStatuses(record);
    const input: DagInput = { tasks, getRuntimeStatus: (id) => statuses[id] ?? null };
    return { dag: buildDag(input), statuses };
  }

  /** Core mutation pass: sync planning task states, recompute DAG + metrics, append a replay frame. */
  private apply(
    record: MissionRecord,
    mutate: (ex: MissionExecution) => void,
    frameType: ReplayFrame['type'],
    toPlan: Map<string, { status: TaskStatus; mode?: TaskMode }>,
  ): MissionRecord {
    if (!record.execution) return record;
    const { dag, statuses } = this.build(record);

    // Write toPlan's task-status changes first, and sync the in-memory
    // `statuses` map to match immediately — otherwise the DAG/metrics/replay
    // snapshot built below (and broadcast over SSE this same pass) would show
    // the task's PREVIOUS status until some later call recomputed it fresh.
    for (const [taskId, { status, mode }] of toPlan) {
      const tasks = record.goalGraph!.tasks.map((t) => (t.id === taskId ? { ...t, status, ...(mode ? { mode } : {}) } : t));
      record.goalGraph = { ...record.goalGraph!, tasks };
      const run = record.taskRuns.find((r) => r.taskId === taskId);
      record.taskRuns = [
        ...record.taskRuns.filter((r) => r.taskId !== taskId),
        { taskId, status, proposal: run?.proposal ?? null, executedNode: run?.executedNode, updatedAt: new Date().toISOString() },
      ];
      statuses[taskId] = this.statusForTask(record, taskId);
    }

    // Propagate dependency-driven states (blocked/queued/waiting) using the
    // now-current statuses, so a dependent of a task that just resolved in
    // this same pass is correctly re-evaluated against its real state
    // instead of the pre-mutation snapshot.
    for (const n of dag.nodes) {
      const s = statuses[n.id];
      if (s !== 'waiting' && s !== 'queued') continue;
      const depStates = n.dependencies.map((d) => statuses[d]);
      const anyHard = depStates.some((d) => d === 'failed' || d === 'rejected' || d === 'cancelled');
      const allDone = depStates.every((d) => d === 'completed');
      if (anyHard) statuses[n.id] = 'blocked';
      else if (allDone) statuses[n.id] = 'queued';
      else statuses[n.id] = 'waiting';
    }

    const ex = record.execution;
    ex.dag = buildDag({ tasks: record.goalGraph!.tasks, getRuntimeStatus: (id) => statuses[id] ?? null });
    ex.metrics = computeMetrics(ex, statuses);
    mutate(ex);
    ex.lastUpdatedAt = new Date().toISOString();
    const checkpointStates: Record<CheckpointKey, CheckpointStatus> = {
      planning: checkpointStatus(ex.checkpoints, 'planning'),
      execution: checkpointStatus(ex.checkpoints, 'execution'),
      review: checkpointStatus(ex.checkpoints, 'review'),
      completion: checkpointStatus(ex.checkpoints, 'completion'),
    };
    ex.replay = captureFrame(
      frameType,
      {
        executionStatus: ex.status,
        taskStates: statuses,
        checkpointStates,
        batchIndex: ex.batchIndex,
      },
      ex.replay,
    );
    return record;
  }

  /* ── Setup ──────────────────────────────────────────────────────── */

  /** Ensure a v3 execution block exists (idempotent — call on every read). */
  hydrate(record: MissionRecord): MissionRecord {
    if (record.execution) return record;
    if (!record.goalGraph?.tasks?.length) return record;
    const approved = record.approval.status === 'approved';
    const checkpoints = emptyCheckpoints();
    if (approved) {
      checkpoints[0] = { ...checkpoints[0], status: 'passed', at: record.approval.at ?? new Date().toISOString() };
    }
    const statuses = this.taskStatuses(record);
    const ex: MissionExecution = {
      status: approved ? 'approved' : 'idle',
      checkpoints,
      timeline: [timeline('created', 'system', 'Mission plan created', { checkpoint: 'planning' })],
      activity: [activity('system', 'created', `Mission created from: "${record.text.slice(0, 120)}"`)],
      replay: [],
      dag: null,
      metrics: null,
      batchIndex: 0,
      lastUpdatedAt: new Date().toISOString(),
    };
    record.execution = ex;
    ex.dag = buildDag({ tasks: record.goalGraph!.tasks, getRuntimeStatus: (id) => statuses[id] ?? null });
    ex.metrics = computeMetrics(ex, statuses);
    ex.replay = captureFrame(
      'created',
      {
        executionStatus: ex.status,
        taskStates: statuses,
        checkpointStates: {
          planning: checkpointStatus(checkpoints, 'planning'),
          execution: checkpointStatus(checkpoints, 'execution'),
          review: checkpointStatus(checkpoints, 'review'),
          completion: checkpointStatus(checkpoints, 'completion'),
        },
        batchIndex: 0,
      },
      [],
    );
    return record;
  }

  /* ── Approval gate ──────────────────────────────────────────────── */

  approve(record: MissionRecord): MissionRecord {
    if (!record.execution) this.hydrate(record);
    if (!record.execution) return record;
    record.execution.checkpoints = setCheckpoint(record.execution.checkpoints, 'planning', 'passed', 'Plan approved by operator');
    record.execution.status = 'approved';
    record.execution.timeline.push(timeline('approved', 'human', 'Mission plan approved', { checkpoint: 'planning' }));
    record.execution.activity.push(activity('human', 'approved', 'Plan approved — execution unlocked'));
    // Keep the legacy v2 `approval` field in sync — workspace.ts's
    // startMissionExecution()/runMissionTask() (and several UI surfaces:
    // TaskList's per-task Run button, MissionDetail's approval badges,
    // signals.ts's open-missions filter) all still read this field, and
    // v3's own checkpoint state was never mirrored into it.
    record.approval = { status: 'approved', at: new Date().toISOString() };
    this.commit(record);
    return record;
  }

  rejectPlan(record: MissionRecord, reason?: string): MissionRecord {
    if (!record.execution) this.hydrate(record);
    if (!record.execution) return record;
    record.execution.checkpoints = setCheckpoint(record.execution.checkpoints, 'planning', 'failed', reason);
    record.execution.status = 'idle';
    record.execution.timeline.push(timeline('rejected-plan', 'human', 'Mission plan rejected', { checkpoint: 'planning', detail: reason }));
    record.execution.activity.push(activity('human', 'rejected-plan', `Plan rejected${reason ? ` — ${reason}` : ''}`));
    record.approval = { status: 'rejected', at: new Date().toISOString() };
    this.commit(record);
    return record;
  }

  /* ── Execution lifecycle ────────────────────────────────────────── */

  startExecution(record: MissionRecord): MissionRecord {
    if (!record.execution) this.hydrate(record);
    if (!record.execution) return record;
    if (checkpointStatus(record.execution.checkpoints, 'planning') !== 'passed') return record;
    if (record.execution.status !== 'approved') return record;
    record.execution.status = 'running';
    record.execution.batchIndex = 0;
    record.execution.startedAt = new Date().toISOString();
    record.execution.checkpoints = setCheckpoint(record.execution.checkpoints, 'execution', 'pending', 'Execution started');
    record.execution.timeline.push(timeline('execution-started', 'human', 'Execution started'));
    record.execution.activity.push(activity('human', 'execution-started', 'Execution started — first batch unlocked'));
    this.apply(record, () => undefined, 'state', new Map());
    this.commit(record);
    return record;
  }

  pauseExecution(record: MissionRecord): MissionRecord {
    if (!record.execution || record.execution.status !== 'running') return record;
    record.execution.status = 'paused';
    record.execution.timeline.push(timeline('execution-paused', 'human', 'Execution paused'));
    record.execution.activity.push(activity('human', 'execution-paused', 'Execution paused by operator'));
    this.apply(record, () => undefined, 'state', new Map());
    this.commit(record);
    return record;
  }

  resumeExecution(record: MissionRecord): MissionRecord {
    if (!record.execution || record.execution.status !== 'paused') return record;
    record.execution.status = 'running';
    record.execution.timeline.push(timeline('execution-started', 'human', 'Execution resumed'));
    record.execution.activity.push(activity('human', 'execution-started', 'Execution resumed'));
    this.apply(record, () => undefined, 'state', new Map());
    this.commit(record);
    return record;
  }

  cancelExecution(record: MissionRecord, reason?: string): MissionRecord {
    if (!record.execution) return record;
    record.execution.status = 'cancelled';
    record.execution.checkpoints = setCheckpoint(record.execution.checkpoints, 'execution', 'failed', reason ?? 'Cancelled by operator');
    record.execution.timeline.push(timeline('cancelled', 'human', 'Mission cancelled', { detail: reason }));
    record.execution.activity.push(activity('human', 'cancelled', `Mission cancelled${reason ? ` — ${reason}` : ''}`));
    this.apply(record, () => undefined, 'done', new Map());
    this.commit(record);
    return record;
  }

  /* ── Task execution ─────────────────────────────────────────────── */

  /**
   * Run the current ready wave — every task whose dependencies are all
   * completed, bounded by `maxParallel`. The wave's hooks (LLM
   * proposal generation, git preflight) run CONCURRENTLY, bounded by
   * `maxParallel`; per-task bookkeeping commits and the result
   * application stay serial, and the wave commits once. Proposals only:
   * nothing is written until each task is Accepted, which then unlocks
   * the next wave. This is what makes ordering automated while the two
   * human gates (plan approval, per-task Accept) stay intact.
   */
  /**
   * Task kinds that resolve to the MANUAL node — no governed executor, no
   * proposal generation. They can only be resolved by a human via
   * `completeManualTask`, and must never be auto-run by a wave (auto-running
   * them would fabricate a failure). Matches the fabric's capability map:
   * every one of these kinds resolves to `manual`.
   */
  static MANUAL_KINDS: ReadonlySet<MissionTask['kind']> = new Set(['manual-operation', 'approval', 'review', 'documentation', 'research']);

  async runReadyTasks(record: MissionRecord, opts: RunReadyOptions = {}): Promise<MissionRecord> {
    if (!record.execution) return record;
    if (record.execution.status !== 'running') return record;
    const { dag, statuses } = this.build(record);
    let ready = runnableTaskIds(dag, (id) => statuses[id]);
    // Manual-node tasks stay queued until a human resolves them — they are
    // left out of the auto-run wave entirely.
    ready = ready.filter((id) => {
      const task = record.goalGraph?.tasks.find((t) => t.id === id);
      return task ? !MissionExecutionEngine.MANUAL_KINDS.has(task.kind) : false;
    });
    if (ready.length === 0) return record;
    const maxParallel = opts.maxParallel ?? 2;
    const wave = ready.slice(0, maxParallel).flatMap((id) => {
      const task = record.goalGraph?.tasks.find((t) => t.id === id);
      return task ? [task] : [];
    });
    // Serial bookkeeping first: each task gets its own 'task-started'
    // commit so the audit trail stays per-task and commits never interleave.
    for (const task of wave) this.beginTask(record, task);
    // The expensive part — hook invocations (LLM calls, git preflights) —
    // runs concurrently. Hooks only read shared state and write their own
    // task's resolvedNode index, so parallel invocation is safe.
    const settled = await Promise.allSettled(wave.map((task) => this.invokeTask(record, task)));
    for (let i = 0; i < wave.length; i++) {
      const s = settled[i];
      const result =
        s.status === 'fulfilled'
          ? s.value
          : { ok: false, error: (s.reason as Error).message || 'Task execution failed unexpectedly' };
      this.finishTask(record, wave[i], result);
    }
    this.commit(record);
    return record;
  }

  /** Run a single task through proposal generation. */
  async runTask(record: MissionRecord, taskId: string): Promise<{ ok: boolean; error?: string; record: MissionRecord }> {
    if (!record.execution) return { ok: false, error: 'no execution state', record };
    const task = record.goalGraph?.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: 'no such task', record };
    if (record.execution.status !== 'running') return { ok: false, error: 'execution is not running', record };
    if (MissionExecutionEngine.MANUAL_KINDS.has(task.kind)) {
      return { ok: false, error: 'This task resolves to the manual node — complete it manually (Mark Done) instead of running it.', record };
    }
    await this.beginTask(record, task);
    const result = await this.invokeTask(record, task);
    this.finishTask(record, task, result);
    const run = record.taskRuns.find((r) => r.taskId === taskId);
    const ok = !!run?.proposal && !run.proposal.error;
    this.commit(record);
    return { ok, error: ok ? undefined : run?.proposal?.error?.message, record };
  }

  private beginTask(record: MissionRecord, task: MissionTask): void {
    const ex = record.execution!;
    ex.timeline.push(timeline('task-started', 'ai', `Running: ${task.title}`, { taskId: task.id }));
    ex.activity.push(activity('ai', 'task-started', `Started task: ${task.title}`, { taskId: task.id }));
    this.apply(record, () => undefined, 'state', new Map([[task.id, { status: 'pending' as TaskStatus }]]));
    this.commit(record);
  }

  private async invokeTask(record: MissionRecord, task: MissionTask): Promise<RunTaskResult> {
    // The hook is documented to resolve with a RunTaskResult, never reject —
    // but its real implementation (workspace.ts) calls through to fs reads
    // and resolveInsideProject(), which throw on an escaping/unreadable
    // path. Without this guard, that throw would abort right after the
    // 'task-started' commit, leaving the task stuck mid-flight on disk
    // forever instead of resolving to a terminal 'failed' state.
    try {
      return await this.hooks.runTask({ record, task });
    } catch (e) {
      return { ok: false, error: (e as Error).message || 'Task execution failed unexpectedly' };
    }
  }

  private finishTask(record: MissionRecord, task: MissionTask, result: RunTaskResult): void {
    const ex = record.execution!;
    const toPlan = new Map<string, { status: TaskStatus; mode?: TaskMode }>();
    toPlan.set(task.id, { status: result.ok ? 'proposed' : 'error', mode: result.mode });
    if (result.proposal) {
      record.taskRuns = [
        ...record.taskRuns.filter((r) => r.taskId !== task.id),
        { taskId: task.id, status: result.ok ? 'proposed' : 'error', proposal: result.proposal, executedNode: result.executedNode, updatedAt: new Date().toISOString() },
      ];
    }
    ex.timeline.push(
      result.ok
        ? timeline('task-proposed', 'ai', `Proposal ready: ${task.title}`, { taskId: task.id, detail: result.proposal?.explanation })
        : timeline('task-failed', 'ai', `Failed: ${task.title}`, { taskId: task.id, detail: result.error }),
    );
    ex.activity.push(
      result.ok
        ? activity('ai', 'task-proposed', `Proposal generated for: ${task.title} — awaiting accept`, { taskId: task.id })
        : activity('ai', 'task-failed', `Task failed: ${task.title} — ${result.error ?? 'unknown error'}`, { taskId: task.id }),
    );
    this.apply(record, () => undefined, result.ok ? 'task' : 'state', toPlan);
  }

  /** Human Accept — the ONLY path that allows a side effect (file write or governed git mutation). */
  acceptTask(record: MissionRecord, taskId: string): MissionRecord {
    if (!record.execution) return record;
    const run = record.taskRuns.find((r) => r.taskId === taskId);
    if (!run || run.status !== 'proposed' || !run.proposal) return record;
    // A proposal is acceptable when it carries a diff to write (aura-ai node)
    // OR a governed git operation to execute (git node). Everything else must
    // be resolved another way — never accepted silently.
    if (!run.proposal.newCode && !run.proposal.operation) return record;
    const task = record.goalGraph?.tasks.find((t) => t.id === taskId);
    record.execution.timeline.push(timeline('task-accepted', 'human', `Accepted: ${task?.title ?? taskId}`, { taskId }));
    record.execution.activity.push(activity('human', 'task-accepted', run.proposal.operation ? 'Proposal accepted and executed by the governed node' : 'Proposal accepted and written to disk', { taskId }));
    this.apply(record, () => undefined, 'task', new Map([[taskId, { status: 'accepted' as TaskStatus }]]));
    this.maybeComplete(record);
    this.commit(record);
    return record;
  }

  /** Human Reject — dependent tasks become blocked until resolved. */
  rejectTask(record: MissionRecord, taskId: string, note?: string): MissionRecord {
    if (!record.execution) return record;
    const task = record.goalGraph?.tasks.find((t) => t.id === taskId);
    record.execution.timeline.push(timeline('task-rejected', 'human', `Rejected: ${task?.title ?? taskId}`, { taskId, detail: note }));
    record.execution.activity.push(activity('human', 'task-rejected', `Proposal rejected${note ? ` — ${note}` : ''}`, { taskId }));
    this.apply(record, () => undefined, 'task', new Map([[taskId, { status: 'rejected' as TaskStatus }]]));
    this.maybeComplete(record);
    this.commit(record);
    return record;
  }

  /** Retry a failed/blocked task (re-queues it). */
  retryTask(record: MissionRecord, taskId: string): MissionRecord {
    if (!record.execution) return record;
    const task = record.goalGraph?.tasks.find((t) => t.id === taskId);
    // Drop the errored proposal: `statusForTask` reads `proposal.error` as
    // 'failed', so a retried task would otherwise stay un-runnable forever.
    const run = record.taskRuns.find((r) => r.taskId === taskId);
    if (run?.proposal?.error) {
      record.taskRuns = record.taskRuns.map((r) => (r.taskId === taskId ? { ...r, proposal: null } : r));
    }
    record.execution.timeline.push(timeline('task-retried', 'human', `Retrying: ${task?.title ?? taskId}`, { taskId }));
    record.execution.activity.push(activity('human', 'task-retried', `Retrying task: ${task?.title ?? taskId}`, { taskId }));
    this.apply(record, () => undefined, 'state', new Map([[taskId, { status: 'pending' as TaskStatus }]]));
    this.commit(record);
    return record;
  }

  /** Human-completes a manual/review/approval/documentation/research task. */
  completeManualTask(record: MissionRecord, taskId: string): MissionRecord {
    if (!record.execution) return record;
    const task = record.goalGraph?.tasks.find((t) => t.id === taskId);
    if (!task || task.kind === 'file-operation' || task.kind === 'git-operation') return record;
    record.execution.timeline.push(timeline('task-completed', 'human', `Completed manually: ${task.title}`, { taskId }));
    record.execution.activity.push(activity('human', 'task-completed', `Completed manual task: ${task.title}`, { taskId }));
    this.apply(record, () => undefined, 'task', new Map([[taskId, { status: 'done' as TaskStatus }]]));
    this.maybeComplete(record);
    this.commit(record);
    return record;
  }

  /* ── Mission-level completion ───────────────────────────────────── */

  private maybeComplete(record: MissionRecord): void {
    if (!record.execution) return;
    const statuses = this.taskStatuses(record);
    const ids = Object.keys(statuses);
    if (ids.length === 0) return;
    const allCompleted = ids.every((id) => statuses[id] === 'completed');
    const exec = record.execution;
    if (allCompleted) {
      exec.status = 'reviewing';
      if (checkpointStatus(exec.checkpoints, 'review') === 'not-started') {
        exec.checkpoints = setCheckpoint(exec.checkpoints, 'review', 'pending', 'All tasks resolved — mission review required');
        exec.timeline.push(timeline('checkpoint', 'system', 'Review checkpoint opened', { checkpoint: 'review' }));
        exec.activity.push(activity('system', 'checkpoint', 'All tasks complete — mission review required'));
      }
    }
  }

  /** Human decision on the mission-review checkpoint. */
  reviewCheckpoint(record: MissionRecord, pass: boolean, note?: string): MissionRecord {
    if (!record.execution) return record;
    if (nextCheckpoint(record.execution.checkpoints)?.key !== 'review') return record;
    record.execution.checkpoints = setCheckpoint(record.execution.checkpoints, 'review', pass ? 'passed' : 'failed', note);
    record.execution.timeline.push(
      pass
        ? timeline('review-passed', 'human', 'Mission review passed', { checkpoint: 'review', detail: note })
        : timeline('checkpoint', 'human', 'Mission review returned for changes', { checkpoint: 'review', detail: note }),
    );
    record.execution.activity.push(
      pass
        ? activity('human', 'review-passed', 'Mission review passed by operator')
        : activity('human', 'checkpoint', 'Mission review returned for changes', { checkpoint: 'review' }),
    );
    if (pass) this.completeMission(record);
    else this.apply(record, () => undefined, 'checkpoint', new Map());
    this.commit(record);
    return record;
  }

  private completeMission(record: MissionRecord): void {
    const exec = record.execution!;
    exec.status = 'completed';
    exec.completedAt = new Date().toISOString();
    exec.checkpoints = setCheckpoint(exec.checkpoints, 'completion', 'passed', 'Mission completed');
    exec.checkpoints = setCheckpoint(exec.checkpoints, 'execution', 'passed', 'Execution finished');
    exec.timeline.push(timeline('completed', 'system', 'Mission completed', { checkpoint: 'completion' }));
    exec.activity.push(activity('system', 'completed', 'Mission completed successfully'));
    this.apply(record, () => undefined, 'done', new Map());
  }

  /** Derive execution status from checkpoints (used on reads). */
  refreshStatus(record: MissionRecord): MissionRecord {
    if (!record.execution) return record;
    const statuses = this.taskStatuses(record);
    const ids = Object.keys(statuses);
    const allCompleted = ids.length > 0 && ids.every((id) => statuses[id] === 'completed');
    const live = record.execution.status === 'idle' || record.execution.status === 'approved'
      || record.execution.status === 'running' || record.execution.status === 'reviewing';
    if (live) {
      record.execution.status = statusFromCheckpoints(record.execution.checkpoints, allCompleted, !!record.execution.startedAt);
    }
    record.execution.metrics = computeMetrics(record.execution, statuses);
    return record;
  }

  /** Expose the planning-state mapping for v2 compat surfaces. */
  static planningStatus(status: ExecutionTaskStatus): TaskStatus {
    return RUNTIME_TO_PLANNING[status];
  }
}
