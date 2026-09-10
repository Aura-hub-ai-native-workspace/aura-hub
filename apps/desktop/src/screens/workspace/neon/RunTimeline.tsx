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

type Actor = 'aura' | 'worker';

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

export function buildRows(
  tasks: TimelineTask[],
  handoffs: TimelineHandoff[],
  objective: { accepted: boolean | null; unmet: string[] },
  planned: boolean,
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

export function RunTimeline({
  tasks,
  handoffs,
  objective,
  planned,
}: {
  tasks: TimelineTask[];
  handoffs: TimelineHandoff[];
  objective: { accepted: boolean | null; unmet: string[] };
  planned: boolean;
}) {
  const rows = useMemo(
    () => buildRows(tasks, handoffs, objective, planned),
    [tasks, handoffs, objective, planned],
  );
  if (rows.length === 0) return null;

  return (
    <ol className="relative space-y-2" data-testid="run-timeline">
      {rows.map((row, i) => (
        <li key={row.key} className="relative pl-8">
          {/* The spine: one continuous line the AURA nodes sit on. */}
          {i < rows.length - 1 && (
            <span
              aria-hidden
              className="absolute left-[13px] top-8 h-[calc(100%-14px)] w-px bg-gradient-to-b from-[rgba(122,92,255,0.45)] to-[rgba(77,124,255,0.14)]"
            />
          )}
          <span
            aria-hidden
            className={cn(
              'absolute left-0 top-2 grid h-[27px] w-[27px] place-items-center rounded-lg border',
              row.actor === 'aura'
                ? 'border-[rgba(122,92,255,0.55)] bg-[rgba(122,92,255,0.14)] text-[#b7a6ff]'
                : 'border-[rgba(77,124,255,0.45)] bg-[rgba(13,19,38,0.95)] text-[#8fb0ff]',
            )}
          >
            <Icon name={row.actor === 'aura' ? 'spark' : 'cpu'} size={14} />
          </span>
          <TimelineRow row={row} />
        </li>
      ))}
    </ol>
  );
}

function TimelineRow({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const hasFacts = (row.facts?.length ?? 0) > 0;
  return (
    <div
      data-testid="run-timeline-row"
      data-actor={row.actor}
      data-status={row.status}
      className={cn(
        'rounded-lg border px-3 py-2',
        row.correction
          ? 'border-[rgba(255,181,71,0.35)] bg-[rgba(255,181,71,0.05)]'
          : 'border-[rgba(125,146,255,0.22)] bg-[rgba(13,19,38,0.6)]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-text">{row.name}</span>
          <span className="block text-[11.5px] text-text-muted">{row.action}</span>
        </span>
        <StatusPill status={row.status} />
      </div>
      {row.detail && (
        <p className="mt-1 line-clamp-2 text-[11px] text-text-subtle">{row.detail}</p>
      )}
      {hasFacts && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="neon-focus mt-1.5 inline-flex items-center gap-1 rounded text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle transition-colors hover:text-text"
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
            {open ? 'Hide details' : 'View details'}
          </button>
          {open && (
            <ul className="mt-1 space-y-0.5 border-l border-[rgba(125,146,255,0.25)] pl-2.5">
              {row.facts!.map((f) => (
                <li key={f} className="truncate text-[10.5px] text-text-subtle">
                  {f}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
