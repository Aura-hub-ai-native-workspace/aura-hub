import { useMemo, useState } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import { StatusPill, type StepStatus } from './StatusPill';

/**
 * RunTimeline — the run as an orchestration, not a list.
 *
 * The plan card used to render one flat row per task, which said what
 * happened but not who was coordinating it. AURA's actual shape is
 * AURA → worker → AURA → worker, and the thing that makes it safe is
 * precisely that workers never hand off to each other: a verified result
 * goes back to AURA, and AURA gives it to the next worker. A timeline
 * that drew `OpenCode → Kilo` would be drawing a system AURA does not
 * run, so every worker step here is bracketed by the AURA step that
 * authorised or verified it.
 *
 * Every row is derived from state the backend already reported —
 * plan.created rows, worker.lifecycle, invocation.observed,
 * verification.completed and the recorded handoff lineage. There are no
 * timers, no interpolated stages and no invented events: a stage that
 * cannot be supported by a real record is simply not drawn.
 */

export interface TimelineTask {
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

export interface TimelineHandoff {
  from: string;
  to: string;
  toWorker: string;
  invocations: string[];
}

type Actor = 'aura' | 'worker' | 'tool';

interface Row {
  key: string;
  actor: Actor;
  /** Who acted: "AURA Agent", or the worker AURA selected. */
  name: string;
  /** What happened, in the run's own terms. */
  action: string;
  status: StepStatus;
  detail?: string;
  /** Expandable evidence — invocation ids, dependencies, scope. */
  facts?: string[];
  /** Correction rounds are marked so the lane reads as a correction. */
  correction?: boolean;
  /** Backend `at` for this step. Absent when no frame carried one. */
  at?: string;
  /** Nested evidence panel: what the step produced. */
  output?: { title: string; body: string };
}

/** `implement-correction-2` → base `implement`, round 2. */
const CORRECTION_RE = /^(.*)-correction-(\d+)$/;

export function correctionOf(taskId: string): { base: string; round: number } | null {
  const m = CORRECTION_RE.exec(taskId);
  if (!m) return null;
  const round = Number(m[2]);
  return Number.isFinite(round) ? { base: m[1], round } : null;
}

/**
 * Task state → the pill this workspace shows.
 *
 * A `done` task is NOT completed until its verification says so: the
 * backend can report a task that ran, exited cleanly and still failed to
 * produce what the task required. That distinction is the whole point of
 * the verification layer, so it survives into the UI as two different
 * words rather than one green tick.
 */
function statusOf(task: TimelineTask): StepStatus {
  switch (task.state) {
    case 'done':
      return task.verified === true ? 'verified' : task.verified === false ? 'unverified' : 'completed';
    case 'skipped':
      return 'skipped';
    case 'awaiting-approval':
      return 'awaiting-approval';
    case 'blocked':
      return 'waiting';
    case 'denied':
      return 'denied';
    case 'failed':
      return 'failed';
    case 'timed-out':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'executing';
    default:
      return 'idle';
  }
}

/** What the worker was asked to do, from the role the plan required. */
function actionOf(task: TimelineTask): string {
  if (task.state === 'awaiting-approval') return 'Waiting for your go-ahead — nothing has run';
  if (task.state === 'blocked') return 'Blocked until its dependency verifies';
  if (task.state === 'skipped') return 'Already verified in an earlier leg — not re-run';
  if (task.state === 'denied') return 'Refused before anything ran';
  if (task.role === 'review') return task.state === 'running' ? 'Reviewing the change' : 'Independent review';
  if (task.role === 'code') return task.state === 'running' ? 'Writing the change' : 'Implementation';
  return task.description || task.id;
}

export interface TimelineAction {
  key: string;
  tool: string;
  actionType: string;
  target: string;
  decision: string;
  reason: string;
  worker: string;
}

export function buildRows(
  tasks: TimelineTask[],
  handoffs: TimelineHandoff[],
  objective: { accepted: boolean | null; unmet: string[] },
  planned: boolean,
  actions: TimelineAction[] = [],
): Row[] {
  const rows: Row[] = [];

  if (planned) {
    rows.push({
      key: 'aura-plan',
      actor: 'aura',
      name: 'AURA Agent',
      action:
        tasks.length === 1
          ? 'Planned 1 task and selected the worker for it'
          : `Planned ${tasks.length} tasks and selected a worker for each`,
      status: 'planning',
      facts: tasks.map((t) =>
        `${t.id}${t.role ? ` · ${t.role}` : ''}${t.worker ? ` → ${t.worker}` : ' → unassigned'}`,
      ),
      output: {
        title: 'Task Plan',
        body: tasks
          .map((t, i) => `${i + 1}. ${t.description || t.id}`)
          .join('\n'),
      },
    });
  }

  const handoffTo = new Map<string, TimelineHandoff>();
  for (const h of handoffs) handoffTo.set(h.to, h);

  for (const task of tasks) {
    const corr = correctionOf(task.id);

    // A corrective task exists ONLY because AURA parked the original and
    // built a new one. That is a fact about the plan, not a guess, so the
    // AURA step that produced it is drawn from the id itself.
    if (corr) {
      rows.push({
        key: `aura-correct-${task.id}`,
        actor: 'aura',
        name: 'AURA Agent',
        action: `Prepared correction round ${corr.round} for ${corr.base}`,
        status: 'correcting',
        detail: 'The corrected task carries a fresh approval; the original stays parked.',
        correction: true,
      });
    }

    // The verified result AURA carried from the upstream worker to this
    // one. Drawn between the two worker rows so the path reads
    // worker → AURA → worker, which is what actually happens.
    const inbound = handoffTo.get(task.id);
    if (inbound) {
      rows.push({
        key: `aura-handoff-${inbound.from}-${task.id}`,
        actor: 'aura',
        name: 'AURA Agent',
        action: `Handed the verified result of ${inbound.from} to ${inbound.toWorker || task.worker || 'the next worker'}`,
        status: 'verified',
        detail: 'Workers never exchange work directly — AURA owns the handoff.',
        facts: inbound.invocations.map((i) => `consumed invocation ${i}`),
      });
    }

    rows.push({
      key: `task-${task.id}`,
      actor: 'worker',
      name: task.worker || 'Worker not yet assigned',
      action: actionOf(task),
      status: statusOf(task),
      detail: task.detail || task.description,
      correction: Boolean(corr),
      facts: [
        `task ${task.id}`,
        ...(task.role ? [`role ${task.role}`] : []),
        ...(task.dependsOn.length ? [`after ${task.dependsOn.join(', ')}`] : []),
        ...(task.conditional ? ['runs only if the review reports findings'] : []),
        ...(task.lifecycle ? [`lifecycle ${task.lifecycle}`] : []),
      ],
    });

    // TOOLS — the mediated actions this task actually performed. A tool
    // lane appears only when AURA observed real actions for it; nothing
    // is drawn for a task whose runtime AURA could not supervise.
    const mine = actions.filter((a) => a.worker && task.worker
      && a.worker.toLowerCase() === task.worker.toLowerCase());
    if (mine.length > 0) {
      const denied = mine.filter((a) => a.decision === 'DENY');
      rows.push({
        key: `tools-${task.id}`,
        actor: 'tool',
        name: 'Tools',
        action: `${mine.length} governed action${mine.length === 1 ? '' : 's'}`
          + (denied.length ? ` · ${denied.length} denied before execution` : ''),
        status: denied.length ? 'correcting' : 'executing',
        output: {
          title: denied.length ? 'Allowed and refused' : 'Mediated actions',
          body: mine.slice(-6).map((a) =>
            `${a.decision.padEnd(5)} [${a.tool || a.actionType}] ${a.target}`).join('\n'),
        },
      });
    }

    // AURA's own verification of that worker's output.
    if (task.verified !== null && task.state !== 'awaiting-approval') {
      rows.push({
        key: `aura-verify-${task.id}`,
        actor: 'aura',
        name: 'AURA Agent',
        action:
          task.verified === true
            ? `Verified ${task.id}`
            : `Could not verify ${task.id}`,
        status: task.verified === true ? 'verified' : 'unverified',
        detail: task.verified === false ? task.detail : undefined,
      });
    }
  }

  if (objective.accepted !== null) {
    rows.push({
      key: 'aura-objective',
      actor: 'aura',
      name: 'AURA Agent',
      action: objective.accepted ? 'Objective accepted' : 'Objective NOT accepted',
      status: objective.accepted ? 'completed' : 'unverified',
      detail: objective.accepted ? undefined : objective.unmet.join('; '),
    });
  }

  return rows;
}

const ACTOR_STYLE: Record<Actor, { tile: string; icon: 'spark' | 'cpu' | 'command'; dot: string }> = {
  aura:   { tile: 'border-[rgba(122,92,255,0.6)] bg-[rgba(122,92,255,0.16)] text-[#c9bcff] shadow-glow-violet', icon: 'spark',   dot: 'bg-neon-violet' },
  worker: { tile: 'border-[rgba(77,124,255,0.45)] bg-[rgba(13,19,38,0.95)] text-[#8fb0ff]',                     icon: 'cpu',     dot: 'bg-neon-blue' },
  tool:   { tile: 'border-[rgba(32,211,255,0.45)] bg-[rgba(10,20,30,0.95)] text-neon-cyan',                     icon: 'command', dot: 'bg-neon-cyan' },
};

/** Backend `at` → local clock. Never invented: absent stays absent. */
function clock(at?: string): string | null {
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function RunTimeline({
  tasks,
  handoffs,
  objective,
  planned,
  actions = [],
}: {
  tasks: TimelineTask[];
  handoffs: TimelineHandoff[];
  objective: { accepted: boolean | null; unmet: string[] };
  planned: boolean;
  actions?: TimelineAction[];
}) {
  const rows = useMemo(
    () => buildRows(tasks, handoffs, objective, planned, actions),
    [tasks, handoffs, objective, planned, actions],
  );
  if (rows.length === 0) return null;

  return (
    <ol className="relative space-y-3" data-testid="run-timeline">
      {rows.map((row, i) => {
        const style = ACTOR_STYLE[row.actor];
        return (
          <li key={row.key} className="relative pl-[62px]">
            {/* The spine every step hangs from: one line, through AURA. */}
            {i < rows.length - 1 && (
              <span
                aria-hidden
                className="absolute left-[21px] top-[52px] h-[calc(100%-38px)] w-px bg-gradient-to-b from-[rgba(122,92,255,0.5)] to-[rgba(77,124,255,0.15)]"
              />
            )}
            <span
              aria-hidden
              className={cn('absolute left-[15px] top-[18px] h-[13px] w-[13px] rounded-full border-2 border-[rgba(9,13,26,1)]', style.dot)}
            />
            <span
              aria-hidden
              className={cn('absolute left-[38px] top-3 grid h-11 w-11 place-items-center rounded-xl border', style.tile)}
            >
              <Icon name={style.icon} size={20} />
            </span>
            <TimelineRow row={row} />
          </li>
        );
      })}
    </ol>
  );
}

function TimelineRow({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const hasFacts = (row.facts?.length ?? 0) > 0;
  const time = clock(row.at);
  return (
    <div
      data-testid="run-timeline-row"
      data-actor={row.actor}
      data-status={row.status}
      className={cn(
        'ml-4 rounded-xl border px-4 py-3',
        row.correction
          ? 'border-[rgba(255,181,71,0.38)] bg-[rgba(255,181,71,0.06)]'
          : row.actor === 'aura'
            ? 'border-[rgba(122,92,255,0.3)] bg-[rgba(24,20,48,0.55)]'
            : 'border-[rgba(125,146,255,0.22)] bg-[rgba(13,19,38,0.6)]',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="text-[13.5px] font-semibold text-text">{row.name}</span>
          <span className="ml-2 text-[12.5px] text-text-muted">{row.action}</span>
        </span>
        {time && <span className="shrink-0 pt-0.5 text-[11px] text-text-subtle">{time}</span>}
        <StatusPill status={row.status} />
      </div>

      {row.detail && (
        <p className="mt-1.5 line-clamp-2 text-[11.5px] text-text-subtle">{row.detail}</p>
      )}

      {/* What the step produced — the run's own record, never a mock. */}
      {row.output && (
        <div className="mt-2.5 flex gap-3 rounded-lg border border-[rgba(125,146,255,0.18)] bg-[rgba(9,13,26,0.6)] px-3 py-2.5">
          <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-[rgba(125,146,255,0.25)] text-text-subtle">
            <Icon name="file" size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-semibold text-text">{row.output.title}</span>
            <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-muted">
              {row.output.body}
            </pre>
          </span>
        </div>
      )}

      {hasFacts && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="neon-focus mt-2 inline-flex items-center gap-1 rounded text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle transition-colors hover:text-text"
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
            {open ? 'Hide details' : 'View details'}
          </button>
          {open && (
            <ul className="mt-1.5 space-y-0.5 border-l border-[rgba(125,146,255,0.25)] pl-3">
              {row.facts!.map((f) => (
                <li key={f} className="truncate text-[10.5px] text-text-subtle">{f}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
