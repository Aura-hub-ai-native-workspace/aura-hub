/**
 * useMissions — the Planner's data hook.
 * ------------------------------------------------------------------
 * The Planner turns a goal into a structured, editable plan. It never
 * executes: execution belongs to Workspace and is reached only through
 * `sendToWorkspace`, the explicit handoff.
 *
 *   · planning streams the planner's real stages (context → plan → check)
 *     from the service; a failed run keeps the goal and is retried in place
 *   · edits are saved against the revision the editor started from, so a
 *     plan changed elsewhere is never silently overwritten
 *   · sendToWorkspace saves, reserves the handoff of THIS revision (the
 *     service makes that idempotent), opens the plan's project in
 *     Workspace and starts the run there — and reports "started" only once
 *     Workspace has confirmed it
 *
 * (The file keeps its name: plans are stored as mission records for
 * compatibility with existing data and the `mission.*` capabilities.)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@aura/core';
import {
  missionClient,
  type GoalGraph,
  type MissionEvent,
  type MissionRecord,
  type MissionSummary,
  type PlanIssue,
  type PlanTaskEdit,
} from '../../ai/missionClient';
import { centralAgentClient } from '../../ai/centralAgentClient';
import { useAgentConversations } from '../../ai/useAgentConversations';
import { useLayoutStore } from '../../ops/layoutStore';

/** The planner's real stages, in the order the service emits them. */
export type CreationStage = 'idle' | 'context' | 'plan' | 'check' | 'done' | 'error';

export interface CreationState {
  stage: CreationStage;
  goalGraph: GoalGraph | null;
  errorMessage: string | null;
  /** While one long model call runs: real elapsed time against its real deadline. */
  waiting: { elapsedMs: number; deadlineMs: number; receivedChars: number } | null;
}

const IDLE_CREATION: CreationState = { stage: 'idle', goalGraph: null, errorMessage: null, waiting: null };
const STAGES = new Set<CreationStage>(['context', 'plan', 'check']);

export type HandoffPhase = 'idle' | 'saving' | 'sending' | 'started' | 'failed';

/** What Workspace reports about the run a plan revision started. */
export interface RunState { sessionId: string; state: string; outcome: string | null; summary: string | null }

export function useMissions(projectId: string | null) {
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [active, setActive] = useState<MissionRecord | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [creation, setCreation] = useState<CreationState>(IDLE_CREATION);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<PlanIssue[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [handoff, setHandoff] = useState<{ phase: HandoffPhase; message: string | null }>({ phase: 'idle', message: null });
  const [run, setRun] = useState<RunState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Guards Send to Workspace against a second click while one is in flight. */
  const sendingRef = useRef(false);

  const refreshList = useCallback(async () => {
    if (!projectId) return;
    setLoadingList(true);
    try {
      const res = await missionClient.list(projectId);
      setMissions(res.missions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, [projectId]);

  const selectMission = useCallback(async (id: string) => {
    if (!projectId) return;
    setError(null);
    setIssues(null);
    setHandoff({ phase: 'idle', message: null });
    try {
      const mission = await missionClient.get(projectId, id);
      if ('error' in mission) setError(mission.error || 'The service reported an error with no message.');
      else setActive(mission);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  const busy = creation.stage !== 'idle' && creation.stage !== 'done' && creation.stage !== 'error';

  /** Shared stream handling for a new plan and a retried one. */
  const stream = useCallback(async (start: (onEvent: (e: MissionEvent) => void, signal: AbortSignal) => Promise<void>) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setCreation({ ...IDLE_CREATION, stage: 'context' });
    setError(null);
    let done: MissionRecord | null = null;
    await start((e) => {
      if (e.type === 'done') { done = e.mission; return; }
      setCreation((s) => {
        if (e.type === 'stage') return e.status === 'start' && STAGES.has(e.stage as CreationStage) ? { ...s, stage: e.stage as CreationStage } : s;
        if (e.type === 'progress') return { ...s, waiting: { elapsedMs: e.elapsedMs, deadlineMs: e.deadlineMs, receivedChars: e.receivedChars ?? 0 } };
        if (e.type === 'goal-graph') return { ...s, goalGraph: e.goalGraph, waiting: null };
        if (e.type === 'error') return { ...s, errorMessage: e.message, stage: 'error' };
        return s;
      });
    }, ac.signal);
    if (ac.signal.aborted) return;
    const finished = done as MissionRecord | null;
    if (finished) {
      setActive(finished);
      setCreation((s) => (s.stage === 'error' ? s : { ...s, stage: 'done' }));
      void refreshList();
    }
  }, [refreshList]);

  const createMission = useCallback(async (text: string) => {
    if (!projectId || busy) return;
    setHandoff({ phase: 'idle', message: null });
    await stream((onEvent, signal) => missionClient.create(projectId, text, onEvent, signal));
  }, [projectId, busy, stream]);

  /** Retry planning for the open plan, in place. */
  const replan = useCallback(async () => {
    if (!projectId || !active || busy) return;
    const mid = active.id;
    setHandoff({ phase: 'idle', message: null });
    await stream((onEvent, signal) => missionClient.replan(projectId, mid, onEvent, signal));
  }, [projectId, active, busy, stream]);

  /** Save edited tasks. Returns the saved plan, or null with `error` set. */
  const savePlan = useCallback(async (tasks: PlanTaskEdit[], acceptance?: string[]): Promise<MissionRecord | null> => {
    if (!projectId || !active) return null;
    setSaving(true);
    setError(null);
    try {
      const r = await missionClient.savePlan(projectId, active.id, active.revision ?? 1, tasks, acceptance);
      if (!r.ok || !r.mission) {
        setError(r.error ?? 'The plan could not be saved.');
        return null;
      }
      setActive(r.mission);
      void refreshList();
      return r.mission;
    } catch (e) {
      setError((e as Error).message || 'The plan could not be saved.');
      return null;
    } finally {
      setSaving(false);
    }
  }, [projectId, active, refreshList]);

  /**
   * The explicit handoff. `edits` (unsaved changes, if any) are saved
   * first, so what runs is exactly what the person sees.
   */
  const sendToWorkspace = useCallback(async (edits: PlanTaskEdit[] | null, acceptance?: string[]) => {
    if (!projectId || !active || sendingRef.current) return;
    sendingRef.current = true;
    setIssues(null);
    try {
      let plan = active;
      if (edits) {
        setHandoff({ phase: 'saving', message: 'Saving your changes…' });
        const saved = await savePlan(edits, acceptance);
        if (!saved) { setHandoff({ phase: 'failed', message: 'The plan was not sent: saving your changes failed.' }); return; }
        plan = saved;
      }
      setHandoff({ phase: 'sending', message: 'Sending to Workspace…' });
      const reservation = await missionClient.reserveHandoff(projectId, plan.id, plan.revision ?? 1);
      if (!reservation.ok || !reservation.handoff || !reservation.plan || !reservation.projectPath) {
        setIssues(reservation.issues ?? null);
        setHandoff({ phase: 'failed', message: reservation.error ?? 'The plan could not be sent.' });
        return;
      }
      const reserved = reservation.handoff;
      if (reservation.duplicate && reserved.status === 'started') {
        setHandoff({ phase: 'started', message: 'This version of the plan is already running in Workspace.' });
        openWorkspace(projectId);
        return;
      }
      openWorkspace(projectId);
      const started = await useAgentConversations.getState().executePlan({
        plan: reservation.plan, sessionId: reserved.sessionId, projectId, projectPath: reservation.projectPath,
      });
      if (started.status === 'failed') {
        await missionClient.settleHandoff(projectId, plan.id, reserved.id, 'failed', started.error).catch(() => null);
        setHandoff({ phase: 'failed', message: `Workspace did not start the plan: ${started.error}` });
      } else {
        await missionClient.settleHandoff(projectId, plan.id, reserved.id, 'started').catch(() => null);
        setHandoff({
          phase: 'started',
          message: started.status === 'duplicate'
            ? 'This version of the plan is already running in Workspace.'
            : 'Running in Workspace.',
        });
      }
      const fresh = await missionClient.get(projectId, plan.id).catch(() => null);
      if (fresh && !('error' in fresh)) setActive(fresh);
    } catch (e) {
      setHandoff({ phase: 'failed', message: (e as Error).message || 'The plan could not be sent.' });
    } finally {
      sendingRef.current = false;
    }
  }, [projectId, active, savePlan]);

  // The run a started handoff produced, as Workspace reports it.
  // Only a run of THIS revision counts: a later edit is a new revision that has not run.
  const latestStarted = [...(active?.handoffs ?? [])].reverse().find((h) => h.status === 'started' && h.revision === active?.revision) ?? null;
  const runSessionId = latestStarted?.sessionId ?? null;
  useEffect(() => {
    if (!runSessionId) { setRun(null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const s = await centralAgentClient.getSession(runSessionId).catch(() => null);
      if (!alive) return;
      const outcome = s?.lastResult?.outcome ?? null;
      setRun(s ? { sessionId: runSessionId, state: s.state, outcome, summary: s.lastResult?.summary ?? null } : null);
      const settled = s && ['completed', 'failed', 'cancelled'].includes(s.state);
      if (!settled) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [runSessionId]);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  return {
    missions, active, loadingList, creation, creating: busy, error, issues, saving, handoff, run,
    refreshList, selectMission, createMission, replan, savePlan, sendToWorkspace,
  };
}

/**
 * Show Workspace for the plan's project: make it the active project and
 * step the Planner window aside so the run is what the person sees.
 */
function openWorkspace(projectId: string): void {
  const app = useAppStore.getState();
  if (app.activeProjectId !== projectId) app.setActiveProject(projectId);
  app.openWorkspace(projectId);
  const layout = useLayoutStore.getState();
  for (const w of layout.windows) if (w.kind === 'missions' || w.kind === 'mission-detail') layout.minimizeWindow(w.id);
}
