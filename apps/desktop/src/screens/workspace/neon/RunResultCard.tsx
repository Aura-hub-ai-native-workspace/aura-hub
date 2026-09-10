import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import type { AgentResult } from '../../../ai/centralAgentClient';
import { GlassCard } from './GlassCard';

/**
 * RunResultCard — AURA's final word on the run.
 *
 * Every line in the checklist is earned. A run that ended is not a run
 * that succeeded: the backend can report an objective it refused to
 * accept, a task that ran without verifying, and a worker that exited 0
 * having changed nothing. Those are different outcomes and they get
 * different marks here — ✓ only where a real record says so, and the
 * headline follows `result.outcome`, never the mere fact that the
 * process finished.
 *
 * The checklist is built from what the run actually reports, so a run
 * with no review produces no review line rather than an unticked one.
 */

interface Check {
  ok: boolean;
  text: string;
}

export function buildChecklist(
  result: AgentResult,
  objective: { accepted: boolean | null; unmet: string[] },
  tasks: Array<{ id: string; role: string; verified: boolean | null; state: string }>,
  denied: number,
): Check[] {
  const checks: Check[] = [];
  const verified = new Set(result.verified ?? []);

  const implemented = tasks.filter((t) => t.role === 'code');
  if (implemented.length > 0) {
    const ok = implemented.every((t) => verified.has(t.id) || t.state === 'skipped');
    checks.push({
      ok,
      text: ok
        ? 'Implementation verified'
        : `Implementation not verified (${implemented.filter((t) => !verified.has(t.id)).map((t) => t.id).join(', ')})`,
    });
  }

  const reviewed = tasks.filter((t) => t.role === 'review');
  if (reviewed.length > 0) {
    const ok = reviewed.every((t) => verified.has(t.id));
    checks.push({ ok, text: ok ? 'Independent review completed' : 'Review did not complete' });
  }

  if (denied > 0) {
    // A denial is not a failure of the run — it is governance working.
    // It is reported so the result never looks unsupervised.
    checks.push({ ok: true, text: `${denied} action${denied === 1 ? '' : 's'} denied before execution` });
  }

  if (objective.accepted !== null) {
    checks.push({
      ok: objective.accepted,
      text: objective.accepted
        ? 'Objective accepted'
        : `Objective not accepted${objective.unmet.length ? ` — ${objective.unmet.join('; ')}` : ''}`,
    });
  }

  return checks;
}

const HEADLINE: Record<string, string> = {
  completed: 'Work completed',
  'awaiting-approval': 'Waiting for your decision',
  cancelled: 'Run stopped',
  failed: 'Work not completed',
  denied: 'Refused',
};

export function RunResultCard({
  result,
  objective,
  tasks,
  denied,
  sessionId,
  projectPath,
  onOpenProject,
}: {
  result: AgentResult;
  objective: { accepted: boolean | null; unmet: string[] };
  tasks: Array<{ id: string; role: string; verified: boolean | null; state: string }>;
  denied: number;
  sessionId: string | null;
  projectPath: string | null;
  /** Only supplied when the host can really reveal a folder. */
  onOpenProject?: () => void;
}) {
  const checks = buildChecklist(result, objective, tasks, denied);
  const good = result.outcome === 'completed' && objective.accepted !== false;
  const tint = good ? 'green' : result.outcome === 'awaiting-approval' ? 'amber' : 'red';

  return (
    <GlassCard
      className="p-3"
      tint={tint}
      data-testid="agent-result"
      data-outcome={result.outcome}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={cn(
            'grid h-6 w-6 place-items-center rounded-md border',
            good
              ? 'border-[rgba(31,211,138,0.5)] bg-[rgba(31,211,138,0.12)] text-neon-success'
              : 'border-[rgba(255,181,71,0.5)] bg-[rgba(255,181,71,0.12)] text-neon-warning',
          )}
        >
          <Icon name="spark" size={13} />
        </span>
        <span className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-text-subtle">
            AURA Agent
          </p>
        </span>
      </div>

      <p
        className={cn(
          'text-[13.5px] font-semibold',
          good ? 'text-neon-success' : 'text-neon-warning',
        )}
        data-testid="agent-result-headline"
      >
        {HEADLINE[result.outcome] ?? result.outcome}
      </p>

      {checks.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="agent-result-checklist">
          {checks.map((c) => (
            <li key={c.text} className="flex items-baseline gap-2 text-[12px]" data-ok={c.ok}>
              <span className={cn('shrink-0 font-semibold', c.ok ? 'text-neon-success' : 'text-neon-warning')}>
                {c.ok ? '✓' : '✕'}
              </span>
              <span className="min-w-0 flex-1 text-text-muted">{c.text}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[12px] leading-relaxed text-text">{result.summary}</p>

      <p className="mt-2 text-[11px] text-text-subtle">
        outcome: <span className="font-semibold">{result.outcome}</span>
        {result.performed.length > 0 && <> · performed: {result.performed.join(', ')}</>}
        {result.verified.length > 0 && <> · verified: {result.verified.join(', ')}</>}
        {result.failureReason && <> · {result.failureReason}</>}
      </p>

      {/* Shown only when there is a real folder to reveal AND a host that
          can reveal it. A button that cannot act is worse than no button. */}
      {onOpenProject && projectPath && (
        <button
          type="button"
          onClick={onOpenProject}
          data-testid="agent-open-project"
          className="neon-focus mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-[rgba(125,146,255,0.45)] px-2.5 py-1.5 text-[11.5px] font-semibold text-neon-blue transition-colors hover:bg-[rgba(125,146,255,0.12)]"
        >
          <Icon name="folder" size={13} />
          Open project
        </button>
      )}

      {sessionId && (
        <p className="mt-1.5 truncate text-[10.5px] text-text-subtle">session {sessionId}</p>
      )}
    </GlassCard>
  );
}
