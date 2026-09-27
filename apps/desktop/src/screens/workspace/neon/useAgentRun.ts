import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@aura/core';
import {
  centralAgentClient,
  type AgentEventFrame,
  type AgentResult,
} from '../../../ai/centralAgentClient';
import {
  deriveActions,
  deriveHandoffs,
  deriveObjective,
  derivePlan,
  type GovernedAction,
  type Handoff,
  type ObjectiveState,
  type PlanTask,
} from '../../agentWorkspaceV2/runViews';

/**
 * useAgentRun — one AURA conversation, owned above the panels.
 *
 * The composer belongs at the bottom of the Hub rail and the run it
 * starts belongs in the workspace beside it, so the state that joins
 * them cannot live inside either one. It lives here instead: the same
 * centralAgentClient calls, the same derived records, lifted so both
 * halves of the screen read one run rather than two.
 *
 * This is not a store and not a second source of truth. Every field is
 * derived from frames the Central Agent actually emitted, or from the
 * AgentResult it returned. The derivations themselves live in
 * `agentWorkspaceV2/runViews` so the conversation store — the single
 * submission pipeline — folds the same views from the same frames.
 */

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}


export function useAgentRun({ projectId, projectPath, onWorkerActivity }: {
  projectId: string | null;
  projectPath: string | null;
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

  /* ── derived, AURA-owned run state ───────────────────────────────
     Pure folds over the frames this run received; the conversation
     store runs the same functions over the frames its own SSE
     subscription receives (see useAgentConversations). */

  const plan = useMemo<PlanTask[]>(() => derivePlan(events), [events]);

  /* The user's objective, and whether AURA accepted it. Both come from
     the backend: the workspace never decides that a run succeeded. */
  const objective = useMemo<ObjectiveState>(() => deriveObjective(events), [events]);

  /* Verified results AURA passed from one worker to the next. Drawn from
     the lineage the backend recorded, never from adjacency in the plan. */
  const handoffs = useMemo<Handoff[]>(() => deriveHandoffs(events), [events]);

  const actions = useMemo<GovernedAction[]>(() => deriveActions(events), [events]);

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


  return {
    text, setText, busy, sessionId, events, result, error,
    stopRequested, stopping, cancelled, runState, waiting,
    plan, objective, handoffs, actions, supervisor,
    pendingApproval, parkedTask, parkedScope,
    submit, stop, resumeCancelled, onDecided, openProject,
    projectId, projectPath,
  };
}

export type AgentRun = ReturnType<typeof useAgentRun>;
export type { PlanTask, Handoff, ObjectiveState, GovernedAction };
