import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn, useAppStore } from '@aura/core';
import { Icon } from '@aura/ui';
import {
  centralAgentClient,
  type AgentEventFrame,
  type AgentResult,
} from '../../../ai/centralAgentClient';
import { GlassCard } from './GlassCard';
import { GlowButton } from './GlowButton';
import { ApprovalRequestCard } from './ApprovalRequestCard';
import { RunTimeline } from './RunTimeline';
import { RunResultCard } from './RunResultCard';

/**
 * AgentRunPanel — the live AURA Agent workspace.
 *
 * "Plan • Delegate • Supervise • Verify", showing the backend's own run
 * state and nothing else. Every line below is rendered from an event the
 * Central Agent actually emitted on its existing bus, or from the
 * terminal AgentResult. There is no second event stream, no polling
 * loop, and deliberately no progress bar: AURA does not know what
 * fraction of a worker's task is done, so it does not draw one. Between
 * events the panel shows the correct waiting state instead.
 *
 * The frontend is not the authority here. It sends the user's intent and
 * displays what came back; worker selection, authorisation, governance,
 * verification and the final verdict all happen in the backend.
 */

interface PlanTask {
  id: string;
  description: string;
  role: string;
  dependsOn: string[];
  /** Planned up front, dispatched only if the upstream reports findings. */
  conditional: boolean;
  state: string;
  verified: boolean | null;
  detail: string;
  worker: string;
  lifecycle: string;
}

interface Handoff {
  from: string;
  to: string;
  toWorker: string;
  invocations: string[];
}

interface ObjectiveState {
  text: string;
  expected: string;
  acceptance: string[];
  accepted: boolean | null;
  unmet: string[];
}

interface GovernedAction {
  key: string;
  tool: string;
  actionType: string;
  target: string;
  decision: string;
  reason: string;
  worker: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function AgentRunPanel({
  projectId,
  projectPath,
  onWorkerActivity,
}: {
  projectId: string | null;
  projectPath: string | null;
  /** Lifts live worker lifecycle to the rail. Never invents a state. */
  onWorkerActivity?: (activity: Map<string, string>) => void;
}) {
  // Real navigation, from the shell's own store: "Open project" shows
  // the project this run worked in. No OS-level opener exists in this
  // build, so nothing here pretends to reveal a folder on disk.
  const openProject = useAppStore((st) => st.openProject);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEventFrame[]>([]);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Run control. `stopRequested` means AURA accepted the request, NOT
   * that anything has stopped — the run reaches CANCELLED only when the
   * backend says so. Rendering it any earlier would be the UI claiming
   * a stop it has not seen.
   */
  const [stopRequested, setStopRequested] = useState(false);
  const [stopping, setStopping] = useState(false);
  const closeStream = useRef<(() => void) | null>(null);

  useEffect(() => () => closeStream.current?.(), []);

  const submit = useCallback(async () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setEvents([]);
    setStopRequested(false);
    setStopping(false);
    closeStream.current?.();
    try {
      const res = await centralAgentClient.submit(message, {
        projectId: projectId ?? undefined,
        projectPath: projectPath ?? undefined,
      });
      setSessionId(res.sessionId);
      setResult(res.result);
      setText('');
      if (res.sessionId) {
        // The backend replays this session's event tail and then closes
        // (the client reconnects with backoff and dedupes). Submit runs
        // to a terminal-or-parked outcome server-side, so for THIS turn
        // the frames arrive after the fact — that is the honest shape of
        // the existing transport, and nothing here pretends otherwise by
        // animating progress AURA never observed.
        closeStream.current = centralAgentClient.events(res.sessionId, (frame) =>
          setEvents((prev) => (prev.length > 400 ? prev : [...prev, frame])),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'the AURA service could not be reached');
    } finally {
      setBusy(false);
    }
  }, [text, busy, projectId, projectPath]);

  const stop = useCallback(async () => {
    if (!sessionId || stopRequested) return;
    setStopRequested(true);
    try {
      await centralAgentClient.cancel(sessionId, 'stopped from the workspace');
    } catch (e) {
      // The request did not land, so nothing was asked to stop. Say so
      // rather than leaving the button looking like it worked.
      setStopRequested(false);
      setError(e instanceof Error ? e.message : 'the stop request did not reach AURA');
    }
  }, [sessionId, stopRequested]);

  const resumeCancelled = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await centralAgentClient.resumeCancelled(sessionId);
      setResult(res.result);
      setStopRequested(false);
      setStopping(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'the run could not be resumed');
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  /* ── derived, AURA-owned run state ─────────────────────────────── */

  const blank = (id: string): PlanTask => ({
    id, description: '', role: '', dependsOn: [], conditional: false,
    state: 'pending', verified: null, detail: '', worker: '', lifecycle: 'IDLE',
  });

  const plan = useMemo<PlanTask[]>(() => {
    const order: string[] = [];
    const byId = new Map<string, PlanTask>();
    const take = (id: string) => {
      if (!byId.has(id)) { order.push(id); byId.set(id, blank(id)); }
      return byId.get(id)!;
    };
    for (const f of events) {
      const p = f.payload ?? {};
      if (f.type === 'plan.created') {
        // AURA sends the plan it derived: ids, what each step is for, the
        // role it requires and what it waits on. Nothing here is inferred
        // from the task id.
        const rows = Array.isArray(p.plan) ? (p.plan as Record<string, unknown>[]) : [];
        for (const row of rows) {
          const id = str(row.id);
          if (!id) continue;
          byId.set(id, {
            ...take(id),
            description: str(row.description),
            role: str(row.role),
            dependsOn: Array.isArray(row.dependsOn) ? row.dependsOn.map(str) : [],
            conditional: row.conditional === true,
          });
        }
        if (rows.length === 0 && Array.isArray(p.tasks)) {
          for (const raw of p.tasks as unknown[]) take(str(raw));
        }
      }
      if (f.type === 'invocation.observed' && p.taskId) {
        const id = str(p.taskId);
        byId.set(id, {
          ...take(id),
          state: str(p.state) || take(id).state,
          verified: typeof p.verified === 'boolean' ? p.verified : take(id).verified,
          detail: str(p.detail) || take(id).detail,
        });
      }
      if (f.type === 'worker.lifecycle' && p.taskId) {
        const id = str(p.taskId);
        const prev = take(id);
        byId.set(id, {
          ...prev,
          worker: str(p.worker) || str(p.nodeId) || prev.worker,
          lifecycle: str(p.lifecycle) || prev.lifecycle,
          state: str(p.state) || prev.state,
          verified: typeof p.verified === 'boolean' ? p.verified : prev.verified,
        });
      }
    }
    return order.map((id) => byId.get(id)!).filter(Boolean);
  }, [events]);

  /* The user's objective, and whether AURA accepted it. Both come from
     the backend: the workspace never decides that a run succeeded. */
  const objective = useMemo<ObjectiveState>(() => {
    const out: ObjectiveState = {
      text: '', expected: '', acceptance: [], accepted: null, unmet: [],
    };
    for (const f of events) {
      const p = f.payload ?? {};
      if (f.type === 'plan.created') {
        out.text = str(p.objective) || out.text;
        out.expected = str(p.expectedOutcome) || out.expected;
        if (Array.isArray(p.acceptance)) out.acceptance = p.acceptance.map(str);
      }
      if (f.type === 'verification.completed') {
        if (typeof p.objectiveAccepted === 'boolean') out.accepted = p.objectiveAccepted;
        if (Array.isArray(p.unmet)) out.unmet = p.unmet.map(str);
      }
    }
    return out;
  }, [events]);

  /* Verified results AURA passed from one worker to the next. Drawn from
     the lineage the backend recorded, never from adjacency in the plan. */
  const handoffs = useMemo<Handoff[]>(() => {
    const byTask = new Map<string, string>();
    const out: Handoff[] = [];
    for (const f of events) {
      if (f.type !== 'worker.lifecycle') continue;
      const p = f.payload ?? {};
      const id = str(p.taskId);
      const worker = str(p.worker) || str(p.nodeId);
      if (id && worker) byTask.set(id, worker);
      const consumed = Array.isArray(p.consumedFrom) ? p.consumedFrom.map(str) : [];
      const deps = Array.isArray(p.dependsOn) ? p.dependsOn.map(str) : [];
      if (consumed.length === 0 || deps.length === 0) continue;
      for (const from of deps) {
        const key = `${from}->${id}`;
        if (out.some((h) => `${h.from}->${h.to}` === key)) continue;
        out.push({ from, to: id, toWorker: worker, invocations: consumed });
      }
    }
    return out.map((h) => ({ ...h, from: byTask.get(h.from) ? `${h.from} (${byTask.get(h.from)})` : h.from }));
  }, [events]);

  const actions = useMemo<GovernedAction[]>(() => {
    const out: GovernedAction[] = [];
    events.forEach((f, i) => {
      if (f.type !== 'worker.action') return;
      const p = f.payload ?? {};
      if (p.summary) return;
      out.push({
        key: `${i}-${str(p.sequence)}`,
        tool: str(p.tool),
        actionType: str(p.actionType),
        target: str(p.target) || str(p.command),
        decision: str(p.decision),
        reason: str(p.reason),
        worker: str(p.workerNodeId),
      });
    });
    return out;
  }, [events]);

  const supervisor = useMemo(() => {
    const allowed = actions.filter((a) => a.decision === 'ALLOW').length;
    const denied = actions.filter((a) => a.decision === 'DENY').length;
    const parked = plan.filter((t) => t.state === 'awaiting-approval' || t.state === 'blocked').length;
    return { observed: actions.length, allowed, denied, parked };
  }, [actions, plan]);

  // Lift live worker lifecycle so the worker rail can pulse the right
  // card. Keyed by node id — the same identity the backend routes on.
  useEffect(() => {
    if (!onWorkerActivity) return;
    const map = new Map<string, string>();
    for (const f of events) {
      if (f.type !== 'worker.lifecycle') continue;
      const nodeId = str(f.payload?.nodeId);
      if (nodeId) map.set(nodeId, str(f.payload?.lifecycle) || 'ACTIVE');
    }
    onWorkerActivity(map);
  }, [events, onWorkerActivity]);

  /* Cancellation state comes from the backend's own events. STOPPING
     appears when AURA says it is stopping; CANCELLED only when AURA
     says it is cancelled. No timers, no optimistic transitions. */
  useEffect(() => {
    for (const f of events) {
      if (f.type === 'run.cancellation-requested') setStopRequested(true);
      if (f.type === 'run.stopping') setStopping(true);
      if (f.type === 'run.cancelled') setStopping(false);
    }
  }, [events]);

  /* The approval this run is parked on, if any.
     Two sources, both the backend's own: the terminal result names the
     ids it parked on, and `approval.required` carries the id live. The
     plan row supplies who it is about. Nothing is inferred from prose. */
  const pendingApproval = useMemo(() => {
    if (result && result.outcome !== 'awaiting-approval') return null;
    const fromResult = result?.evidence?.approvalIds ?? [];
    if (fromResult.length > 0) return fromResult[fromResult.length - 1];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const f = events[i];
      if (f.type !== 'approval.required') continue;
      const id = str(f.payload?.approvalId);
      if (id) return id;
    }
    return null;
  }, [result, events]);

  const parkedTask = useMemo(
    () => plan.find((t) => t.state === 'awaiting-approval') ?? null,
    [plan],
  );

  /* Scope declared for the parked task, straight from plan.created. AURA
     enforces it; this only restates it so the person deciding can see
     the boundary they are authorising. */
  const parkedScope = useMemo<string[]>(() => {
    if (!parkedTask) return [];
    for (const f of events) {
      if (f.type !== 'plan.created') continue;
      const rows = Array.isArray(f.payload?.plan) ? (f.payload!.plan as Record<string, unknown>[]) : [];
      for (const row of rows) {
        if (str(row.id) !== parkedTask.id) continue;
        const scope = row.scopePaths;
        if (Array.isArray(scope)) return scope.map(str).filter(Boolean);
      }
    }
    return [];
  }, [parkedTask, events]);

  /* A decision resumes the run server-side and returns the next result.
     The event stream stays open, so the timeline keeps filling in. */
  const onDecided = useCallback((next: unknown) => {
    setResult(next as AgentResult);
  }, []);

  const cancelled = result?.outcome === 'cancelled';
  const runState = cancelled ? 'CANCELLED'
    : stopping ? 'STOPPING'
    : stopRequested ? 'STOP REQUESTED'
    : busy ? 'RUNNING'
    : result ? 'DONE' : 'READY';

  const waiting = busy && plan.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" data-testid="agent-run-panel">
      {/* Composer */}
      <GlassCard className="p-3">
        <label htmlFor="agent-composer" className="sr-only">Describe what you want AURA to do</label>
        <textarea
          id="agent-composer"
          rows={3}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
          }}
          data-testid="agent-composer"
          placeholder="e.g. Implement token refresh in src/auth and have another AI review it"
          className="neon-focus w-full resize-none bg-transparent text-[13px] leading-relaxed text-text outline-none placeholder:text-text-subtle disabled:cursor-not-allowed"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="truncate text-[10.5px] text-text-subtle">
            {busy ? 'AURA is planning, delegating and verifying…'
              : 'AURA plans the work, chooses the worker, and verifies the result.'}
          </span>
          <span className="flex items-center gap-2">
            <span
              data-testid="agent-run-state"
              data-state={runState}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                runState === 'CANCELLED' ? 'text-neon-warning'
                  : runState === 'STOPPING' || runState === 'STOP REQUESTED' ? 'text-neon-warning'
                  : runState === 'RUNNING' ? 'text-neon-cyan' : 'text-text-subtle',
              )}
            >
              {runState}
            </span>
            {busy && sessionId && (
              <button
                type="button"
                onClick={() => void stop()}
                disabled={stopRequested}
                data-testid="agent-stop"
                aria-label="Stop this run"
                className="neon-focus rounded-md border border-[rgba(255,181,71,0.5)] px-2 py-1 text-[11px] font-semibold text-neon-warning transition-colors hover:bg-[rgba(255,181,71,0.12)] disabled:opacity-60"
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
                className="neon-focus rounded-md border border-[rgba(125,146,255,0.45)] px-2 py-1 text-[11px] font-semibold text-neon-blue transition-colors hover:bg-[rgba(125,146,255,0.12)] disabled:opacity-60"
              >
                Resume
              </button>
            )}
            <GlowButton
              size="sm"
              onClick={() => void submit()}
              disabled={busy || text.trim().length === 0}
              data-testid="agent-submit"
              aria-label="Send to AURA"
            >
              <Icon name="arrow-right" size={15} />
            </GlowButton>
          </span>
        </div>
      </GlassCard>

      {error && (
        <p role="alert" data-testid="agent-error" className="rounded-lg border border-[rgba(255,93,122,0.45)] bg-[rgba(255,93,122,0.1)] px-3 py-2 text-[12px] text-neon-danger">
          {error}
        </p>
      )}

      {/* USER OBJECTIVE */}
      {objective.text && (
        <GlassCard className="p-3" data-testid="agent-objective">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-text-subtle">
            User objective
          </p>
          <p className="text-[12.5px] leading-relaxed text-text">{objective.text}</p>
          {objective.expected && (
            <p className="mt-1 text-[11px] text-text-muted">{objective.expected}</p>
          )}
        </GlassCard>
      )}

      {/* APPROVAL — the decision this run is parked on. Rendered high in
          the panel because a parked run cannot advance without it. */}
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

      {/* ORCHESTRATION — AURA → worker → AURA → worker. The handoff rows
          are part of this flow rather than a separate card, because the
          handoff IS the flow: a verified result returning to AURA and
          going out again. */}
      {(plan.length > 0 || waiting) && (
        <GlassCard className="p-3" data-testid="agent-plan">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-widest text-text-subtle">
            Orchestration
          </p>
          {waiting && <p className="text-[12px] text-text-muted">Waiting for AURA's plan…</p>}
          <RunTimeline
            tasks={plan}
            handoffs={handoffs}
            objective={objective}
            planned={plan.length > 0}
          />
        </GlassCard>
      )}

      {/* WORKER ACTIVITY + SUPERVISOR */}
      {actions.length > 0 && (
        <GlassCard className="p-3" data-testid="agent-supervisor">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-subtle">
            Supervisor
          </p>
          <p className="mb-2 text-[11.5px] text-text-muted">
            {supervisor.observed} action{supervisor.observed === 1 ? '' : 's'} observed ·{' '}
            <span className="text-neon-success">{supervisor.allowed} allowed</span> ·{' '}
            <span className={supervisor.denied ? 'text-neon-danger' : ''}>{supervisor.denied} denied</span> ·{' '}
            {supervisor.parked} parked
          </p>
          <ul className="space-y-1">
            {actions.slice(-8).map((a) => (
              <li key={a.key} data-testid="agent-action" data-decision={a.decision} className="flex items-baseline gap-2 text-[11.5px]">
                <span className={cn('shrink-0 font-semibold', a.decision === 'DENY' ? 'text-neon-danger' : 'text-neon-success')}>
                  {a.decision}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-muted">
                  [{a.tool || a.actionType}] {a.target}
                  {a.reason && <span className="text-text-subtle"> — {a.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
        </GlassCard>
      )}

      {/* AURA RESPONSE */}
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
