import { Icon } from '@aura/ui';
import { ApprovalRequestCard } from './ApprovalRequestCard';
import { RunTimeline } from './RunTimeline';
import { RunResultCard } from './RunResultCard';
import type { AgentRun } from './useAgentRun';

/**
 * AgentRunPanel — the live AURA Agent workspace.
 *
 * The run as it actually happened, and nothing else. Every line below is
 * rendered from an event the Central Agent emitted on its existing bus,
 * or from the terminal AgentResult. There is no second event stream, no
 * polling loop, and deliberately no progress bar: AURA does not know
 * what fraction of a worker's task is done, so it does not draw one.
 *
 * The composer that starts a run lives in the Hub rail, because the user
 * is talking to AURA rather than to this panel. State arrives through
 * `useAgentRun`, which both halves of the screen read.
 */
export function AgentRunPanel({ run }: { run: AgentRun }) {
  const {
    sessionId, result, error, plan, objective, handoffs, actions,
    supervisor, pendingApproval, parkedTask, parkedScope, busy, waiting,
    onDecided, openProject, projectPath, projectId, stop, stopRequested,
    cancelled, resumeCancelled, runState,
  } = run as AgentRun & { projectPath: string | null; projectId: string | null };

  const idle = !result && plan.length === 0 && !busy && !error;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5"
      data-testid="agent-run-panel"
    >
      {error && (
        <p
          role="alert"
          data-testid="agent-error"
          className="rounded-xl border border-[rgba(255,93,122,0.45)] bg-[rgba(255,93,122,0.1)] px-4 py-3 text-[12.5px] text-neon-danger"
        >
          {error}
        </p>
      )}

      {/* EMPTY STATE — the workspace still has to say what it is for.
          It never fabricates a timeline to look busy. */}
      {idle && (
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center"
          data-testid="agent-empty"
        >
          <span className="grid h-16 w-16 place-items-center rounded-2xl border border-[rgba(122,92,255,0.45)] bg-[rgba(122,92,255,0.12)] text-[#b7a6ff] shadow-glow-violet">
            <Icon name="spark" size={30} />
          </span>
          <h3 className="mt-4 text-[19px] font-semibold tracking-[-0.01em] text-text">
            Ready to build.
          </h3>
          <p className="mt-2 max-w-[440px] text-[13px] leading-relaxed text-text-muted">
            Tell AURA what you want to create, change, debug or review. Your
            request is planned, delegated to the workers it needs, supervised
            while it runs, and verified before anything is called done.
          </p>
          {/* A delegate invocation needs a working directory: the backend
              refuses one without it. Say which step is missing rather than
              leaving the composer inert with no reason given. */}
          <p className="mt-4 text-[11.5px] text-text-subtle">
            {projectId
              ? 'The composer is on the left — you talk to AURA, not to a worker.'
              : 'Select a project to start building — AURA needs a directory to work in.'}
          </p>
        </div>
      )}

      {/* RUN HEADER — objective plus the run's own control. */}
      {objective.text && (
        <div className="flex items-start gap-3" data-testid="agent-objective">
          <span className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-text-subtle">
              Objective
            </p>
            <p className="mt-1 text-[14px] leading-relaxed text-text">{objective.text}</p>
            {objective.expected && (
              <p className="mt-0.5 text-[12px] text-text-muted">{objective.expected}</p>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-2 pt-4">
            <span
              data-testid="agent-run-state"
              data-state={runState}
              className={
                runState === 'RUNNING'
                  ? 'rounded-full border border-[rgba(32,211,255,0.45)] bg-[rgba(32,211,255,0.12)] px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-neon-cyan'
                  : runState === 'CANCELLED' || runState === 'STOPPING' || runState === 'STOP REQUESTED'
                    ? 'rounded-full border border-[rgba(255,181,71,0.45)] bg-[rgba(255,181,71,0.1)] px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-neon-warning'
                    : 'rounded-full border border-white/10 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle'
              }
            >
              {runState}
            </span>
            {busy && sessionId && (
              <button
                type="button"
                onClick={() => void stop()}
                disabled={stopRequested}
                data-testid="agent-stop"
                className="neon-focus rounded-lg border border-[rgba(255,181,71,0.5)] px-2.5 py-1 text-[11px] font-semibold text-neon-warning transition-colors hover:bg-[rgba(255,181,71,0.12)] disabled:opacity-60"
              >
                {stopRequested ? 'Stopping…' : 'Stop'}
              </button>
            )}
            {cancelled && (
              <button
                type="button"
                onClick={() => void resumeCancelled()}
                disabled={busy}
                data-testid="agent-resume-cancelled"
                className="neon-focus rounded-lg border border-[rgba(125,146,255,0.45)] px-2.5 py-1 text-[11px] font-semibold text-neon-blue transition-colors hover:bg-[rgba(125,146,255,0.12)] disabled:opacity-60"
              >
                Resume
              </button>
            )}
          </span>
        </div>
      )}

      {waiting && (
        <p className="text-[13px] text-text-muted">Waiting for AURA's plan…</p>
      )}

      {/* APPROVAL — inside the timeline's own column, because the
          decision is a step of the run, not a notice beside it. */}
      {sessionId && pendingApproval && (
        <ApprovalRequestCard
          sessionId={sessionId}
          approvalId={pendingApproval}
          worker={parkedTask?.worker ?? ''}
          taskId={parkedTask?.id ?? ''}
          taskDescription={parkedTask?.description ?? ''}
          scopePaths={parkedScope}
          busy={busy}
          onDecided={onDecided}
        />
      )}

      {/* ORCHESTRATION — AURA → worker → AURA → worker. */}
      {plan.length > 0 && (
        <RunTimeline
          tasks={plan}
          handoffs={handoffs}
          objective={objective}
          planned={plan.length > 0}
          actions={actions}
        />
      )}

      {/* SUPERVISOR — what AURA allowed and refused inside the runtime. */}
      {actions.length > 0 && (
        <div
          className="rounded-xl border border-[rgba(125,146,255,0.22)] bg-[rgba(13,19,38,0.55)] px-4 py-3"
          data-testid="agent-supervisor"
        >
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-text-subtle">
            Supervisor
          </p>
          <p className="text-[12px] text-text-muted">
            {supervisor.observed} action{supervisor.observed === 1 ? '' : 's'} observed ·{' '}
            <span className="text-neon-success">{supervisor.allowed} allowed</span> ·{' '}
            <span className={supervisor.denied ? 'text-neon-danger' : ''}>
              {supervisor.denied} denied
            </span>{' '}
            · {supervisor.parked} parked
          </p>
        </div>
      )}

      {result && (
        <RunResultCard
          result={result}
          objective={objective}
          tasks={plan}
          denied={supervisor.denied}
          sessionId={sessionId}
          projectPath={projectPath}
          onOpenProject={projectId ? () => openProject(projectId) : undefined}
        />
      )}
    </div>
  );
}
