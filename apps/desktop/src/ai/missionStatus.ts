/**
 * missionStatus — the plain-language view of a finished run.
 *
 * Turns what the backend recorded (per-task states, the worker that ran
 * each task, the mission acceptance verdict, the failure reason) into
 * sentences a person can act on. Two rules are held here, and tested:
 *
 *   • A worker finishing is not the mission succeeding. A task can be
 *     "Done" while the mission reads "Not verified" — the verdict line
 *     is the only thing that says the work met its acceptance criteria.
 *   • No raw identifiers or enum names reach the user. Task ids, backend
 *     states and reason codes are translated, and the technical record
 *     stays in the diagnostics, not in these labels.
 */
import type { AgentMsgMeta } from './useAgentConversations';
import type { AgentTaskStatus } from './centralAgentClient';

export type Tone = 'ok' | 'working' | 'waiting' | 'bad' | 'neutral';

export interface MissionTaskView {
  taskId: string;
  title: string;
  stateLabel: string;
  tone: Tone;
  /** "by Claude Code", or null when no worker ran this task. */
  byline: string | null;
  /** What it is waiting on, when it has not started. */
  waitingOn: string | null;
}

export interface MissionView {
  understanding: string | null;
  tasks: MissionTaskView[];
  verdict: { tone: Tone; text: string } | null;
}

const WORKER_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'kilo-code': 'Kilo Code',
  'opencode': 'OpenCode',
};

/** Human name for a worker id; unknown ids are shown as a plain label. */
export function workerName(worker: string | null | undefined): string | null {
  if (!worker) return null;
  return WORKER_NAMES[worker] ?? worker.replace(/[-_]+/g, ' ');
}

const FAILURE_REASON: Record<string, string> = {
  'task-failed': 'A task failed, so the rest of the plan did not run.',
  'action-denied': 'An action was refused by policy, so the run stopped.',
  'timed-out': 'A task took too long, so the run stopped.',
  'cancelled': 'The run was stopped before it finished.',
  'unverified-actions': 'Some actions could not be verified.',
  'objective-unaccepted': 'The acceptance criteria were not met.',
  'ambiguous-intent': 'The request needs more detail before work can start.',
};

/** The sentence for a backend failure reason; unknown reasons say so. */
export function failureReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return FAILURE_REASON[reason] ?? 'The run did not finish as planned.';
}

function stateView(task: AgentTaskStatus, titles: Map<string, string>): Omit<MissionTaskView, 'taskId' | 'title' | 'byline'> {
  const waiting = task.dependsOn
    .map((id) => titles.get(id) ?? 'an earlier step')
    .join(', ');
  switch (task.state) {
    case 'done':
      return task.verified === false
        ? { stateLabel: 'Finished, not verified', tone: 'bad', waitingOn: null }
        : { stateLabel: 'Done', tone: 'ok', waitingOn: null };
    case 'skipped':
      return { stateLabel: 'Already done earlier', tone: 'ok', waitingOn: null };
    case 'running':
      return { stateLabel: 'Working', tone: 'working', waitingOn: null };
    case 'awaiting-approval':
      return { stateLabel: 'Waiting for your approval', tone: 'waiting', waitingOn: null };
    case 'failed':
      return { stateLabel: 'Failed', tone: 'bad', waitingOn: null };
    case 'denied':
      return { stateLabel: 'Refused by policy', tone: 'bad', waitingOn: null };
    case 'timed-out':
      return { stateLabel: 'Timed out', tone: 'bad', waitingOn: null };
    case 'cancelled':
      return { stateLabel: 'Stopped', tone: 'neutral', waitingOn: null };
    case 'blocked':
      return { stateLabel: 'Blocked', tone: 'bad', waitingOn: null };
    default:
      // "pending" / "ready": not started yet.
      return waiting
        ? { stateLabel: 'Waiting', tone: 'waiting', waitingOn: waiting }
        : { stateLabel: 'Not started', tone: 'neutral', waitingOn: null };
  }
}

/**
 * The mission view for one assistant message, or null when the run
 * recorded no mission detail (for example a plain conversational answer).
 */
export function missionView(agent: Pick<AgentMsgMeta,
  'understanding' | 'objective' | 'tasks' | 'failureReason'> | null | undefined): MissionView | null {
  if (!agent) return null;
  const tasks = agent.tasks ?? [];
  const objective = agent.objective ?? null;
  if (tasks.length === 0 && !objective && !agent.understanding) return null;

  // Titles are the task descriptions, so "waiting on" reads as a step name.
  const titles = new Map(tasks.map((t) => [t.taskId, t.description || 'an earlier step']));
  const views: MissionTaskView[] = tasks.map((t) => {
    const s = stateView(t, titles);
    const worker = workerName(t.worker);
    return {
      taskId: t.taskId,
      title: t.description || 'Step',
      byline: worker ? `by ${worker}` : null,
      ...s,
    };
  });

  let verdict: MissionView['verdict'] = null;
  if (objective && objective.accepted === true) {
    verdict = { tone: 'ok', text: 'Mission verified: every acceptance criterion is met.' };
  } else if (objective && objective.accepted === false) {
    const unmet = objective.unmet.length ? ` Not met: ${objective.unmet.join('; ')}.` : '';
    verdict = { tone: 'bad', text: `Mission not verified.${unmet}` };
  } else if (agent.failureReason) {
    verdict = { tone: 'bad', text: failureReasonText(agent.failureReason) ?? 'The run did not finish.' };
  }

  return { understanding: agent.understanding ?? null, tasks: views, verdict };
}
