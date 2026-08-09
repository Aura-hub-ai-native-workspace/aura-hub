/**
 * useMissions — Mission Control v3's data hook.
 * ------------------------------------------------------------------
 * Mission CREATION still streams real SSE stage events (same reader loop
 * as before): creation is a genuine multi-LLM-call pipeline but only
 * ever computes and stores a plan — nothing touches the real filesystem.
 *
 * EXECUTION is now engine-driven (`mission/execution/`): an approved plan
 * becomes a DAG (dependencies/blocks/critical path/parallel batches/auto-
 * ordering) and the engine advances tasks wave by wave. `runBatch` streams
 * ExecutionEvents over SSE so the UI stays live while proposals generate.
 * Human gating is unchanged: the whole plan needs an explicit Approve
 * before any task runs, and each proposal needs an explicit Accept before
 * it is ever written to disk.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fabricClient, type ApprovalRequest } from '../../ai/fabricClient';
import {
  missionClient,
  type ExtractedIntent,
  type GoalGraph,
  type IntentClassification,
  type MissionEvent,
  type MissionRecord,
  type MissionReplayPayload,
  type MissionReviewVerdict,
  type MissionSignals,
  type MissionStrategy,
  type MissionSummary,
  type QualityScore,
  type RiskAnalysis,
} from '../../ai/missionClient';

export type CreationStage = 'idle' | 'classify' | 'signals' | 'intent' | 'strategy' | 'goal-graph' | 'risk' | 'review' | 'quality' | 'done' | 'error';

export interface CreationState {
  stage: CreationStage;
  classification: IntentClassification | null;
  intent: ExtractedIntent | null;
  signals: MissionSignals | null;
  strategy: MissionStrategy | null;
  goalGraph: GoalGraph | null;
  risk: RiskAnalysis | null;
  review: MissionReviewVerdict | null;
  quality: QualityScore | null;
  errorMessage: string | null;
}

const IDLE_CREATION: CreationState = {
  stage: 'idle', classification: null, intent: null, signals: null, strategy: null,
  goalGraph: null, risk: null, review: null, quality: null, errorMessage: null,
};

export function useMissions(projectId: string | null) {
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [active, setActive] = useState<MissionRecord | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [creation, setCreation] = useState<CreationState>(IDLE_CREATION);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [replay, setReplay] = useState<MissionReplayPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const batchAbortRef = useRef<AbortController | null>(null);

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
    setReplay(null);
    try {
      const mission = await missionClient.get(projectId, id);
      if ('error' in mission && mission.error) setError(mission.error);
      else if (!('error' in mission)) setActive(mission);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  const createMission = useCallback(async (text: string) => {
    const busy = creation.stage !== 'idle' && creation.stage !== 'done' && creation.stage !== 'error';
    if (!projectId || busy) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setCreation({ ...IDLE_CREATION, stage: 'classify' });
    setError(null);

    const STAGE_NAMES = new Set(['classify', 'signals', 'intent', 'strategy', 'goal-graph', 'risk', 'review', 'quality']);

    await missionClient.create(projectId, text, (e: MissionEvent) => {
      setCreation((s) => {
        switch (e.type) {
          case 'stage':
            return e.status === 'start' && STAGE_NAMES.has(e.stage) ? { ...s, stage: e.stage as CreationStage } : s;
          case 'classification':
            return { ...s, classification: e.classification };
          case 'signals':
            return { ...s, signals: e.signals };
          case 'intent':
            return { ...s, intent: e.intent };
          case 'strategy':
            return { ...s, strategy: e.strategy };
          case 'goal-graph':
            return { ...s, goalGraph: e.goalGraph };
          case 'risk':
            return { ...s, risk: e.risk };
          case 'review':
            return { ...s, review: e.review };
          case 'quality':
            return { ...s, quality: e.quality };
          case 'done':
            setActive(e.mission);
            void refreshList();
            return { ...s, stage: 'done' };
          case 'error':
            return { ...s, errorMessage: e.message, stage: 'error' };
          default:
            return s;
        }
      });
    }, ac.signal);
  }, [projectId, creation.stage, refreshList]);

  const approve = useCallback(async () => {
    if (!projectId || !active) return;
    setError(null);
    try {
      const mission = await missionClient.approve(projectId, active.id);
      setActive(mission);
      void refreshList();
    } catch (e) {
      setError((e as Error).message || 'Could not approve the mission plan.');
    }
  }, [projectId, active, refreshList]);

  const rejectPlan = useCallback(async () => {
    if (!projectId || !active) return;
    setError(null);
    try {
      const mission = await missionClient.reject(projectId, active.id);
      setActive(mission);
      void refreshList();
    } catch (e) {
      setError((e as Error).message || 'Could not reject the mission plan.');
    }
  }, [projectId, active, refreshList]);

  const startExecution = useCallback(async () => {
    if (!projectId || !active) return;
    setBatchBusy(true);
    setError(null);
    try {
      const result = await missionClient.start(projectId, active.id);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
    } catch (e) {
      setError((e as Error).message || 'Could not start execution.');
    } finally {
      setBatchBusy(false);
    }
  }, [projectId, active]);

  /** Stream the current ready wave — proposals generate live over SSE. */
  const runBatch = useCallback(async () => {
    if (!projectId || !active) return;
    batchAbortRef.current?.abort();
    const ac = new AbortController();
    batchAbortRef.current = ac;
    setBatchBusy(true);
    setError(null);
    await missionClient.execute(projectId, active.id, (e) => {
      if (e.type === 'execution') {
        setActive((prev) => (prev ? { ...prev, execution: e.record.execution } : prev));
      } else if (e.type === 'error') {
        setError(e.message);
      }
    }, { signal: ac.signal });
    setBatchBusy(false);
    void refreshList();
  }, [projectId, active, refreshList]);

  /**
   * Pending authorization requests, refreshed from the service.
   *
   * Deliberately not cached beyond a render: the service owns approval
   * state, so a reload, a reconnect or a second window all converge on
   * the same list rather than on anything this hook remembers.
   */
  const refreshApprovals = useCallback(async () => {
    try {
      const res = await fabricClient.approvals();
      setApprovals(res.approvals ?? []);
    } catch {
      /* the gate is service-side; a failed poll just means no update */
    }
  }, []);

  const runTask = useCallback(async (taskId: string) => {
    if (!projectId || !active) return;
    setBusyTaskId(taskId);
    setError(null);
    try {
      const result = await missionClient.runTask(projectId, active.id, taskId);
      if (result.mission) setActive(result.mission);
      // A parked task is not an error — it is a question. Surfacing it as
      // one would push the user toward Retry when they need Approve.
      if (!result.ok && result.error && !result.awaitingApproval) setError(result.error);
      if (result.awaitingApproval) await refreshApprovals();
    } catch (e) {
      setError((e as Error).message || 'Could not run the task.');
    } finally {
      setBusyTaskId(null);
    }
  }, [projectId, active, refreshApprovals]);

  /**
   * Answer an authorization request. The service resumes the same mission
   * task on approval and declines it on refusal, so this only reports the
   * outcome — it never runs anything itself and never names a capability.
   */
  const decideApproval = useCallback(async (id: string, granted: boolean, reason?: string) => {
    setApprovalBusyId(id);
    setError(null);
    try {
      const result = await fabricClient.decide(id, granted, reason);
      if (result.error && !result.approval) setError(result.error);
      if (projectId && active) {
        const rec = await missionClient.get(projectId, active.id);
        if (!('error' in rec)) setActive(rec);
      }
    } catch (e) {
      setError((e as Error).message || 'Could not record that decision.');
    } finally {
      setApprovalBusyId(null);
      await refreshApprovals();
    }
  }, [projectId, active, refreshApprovals]);

  const acceptTask = useCallback(async (taskId: string) => {
    if (!projectId || !active) return;
    setBusyTaskId(taskId);
    setError(null);
    try {
      const result = await missionClient.acceptTask(projectId, active.id, taskId);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
    } catch (e) {
      setError((e as Error).message || 'Could not write this change to disk.');
    } finally {
      setBusyTaskId(null);
    }
  }, [projectId, active]);

  const rejectTask = useCallback(async (taskId: string) => {
    if (!projectId || !active) return;
    setError(null);
    try {
      const result = await missionClient.rejectTask(projectId, active.id, taskId);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
    } catch (e) {
      setError((e as Error).message || 'Could not reject the task.');
    }
  }, [projectId, active]);

  const retryTask = useCallback(async (taskId: string) => {
    if (!projectId || !active) return;
    setError(null);
    try {
      const result = await missionClient.retryTask(projectId, active.id, taskId);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
    } catch (e) {
      setError((e as Error).message || 'Could not retry the task.');
    }
  }, [projectId, active]);

  const completeTask = useCallback(async (taskId: string) => {
    if (!projectId || !active) return;
    setError(null);
    try {
      const result = await missionClient.completeManualTask(projectId, active.id, taskId);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
    } catch (e) {
      setError((e as Error).message || 'Could not complete the task.');
    }
  }, [projectId, active]);

  const pause = useCallback(async () => {
    if (!projectId || !active) return;
    setError(null);
    try {
      const result = await missionClient.pause(projectId, active.id);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
    } catch (e) {
      setError((e as Error).message || 'Could not pause execution.');
    }
  }, [projectId, active]);

  const resume = useCallback(async () => {
    if (!projectId || !active) return;
    setError(null);
    try {
      const result = await missionClient.resume(projectId, active.id);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
    } catch (e) {
      setError((e as Error).message || 'Could not resume execution.');
    }
  }, [projectId, active]);

  const cancel = useCallback(async () => {
    if (!projectId || !active) return;
    setError(null);
    try {
      const result = await missionClient.cancel(projectId, active.id);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
    } catch (e) {
      setError((e as Error).message || 'Could not cancel the mission.');
    }
  }, [projectId, active]);

  const reviewCheckpoint = useCallback(async (pass: boolean, note?: string) => {
    if (!projectId || !active) return;
    setError(null);
    try {
      const result = await missionClient.review(projectId, active.id, pass, note);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
    } catch (e) {
      setError((e as Error).message || 'Could not record the review decision.');
    }
  }, [projectId, active]);

  const loadReplay = useCallback(async (id?: string) => {
    if (!projectId) return;
    const mid = id ?? active?.id;
    if (!mid) return;
    try {
      const payload = await missionClient.replay(projectId, mid);
      if ('error' in payload) setError(payload.error);
      else setReplay(payload);
    } catch (e) {
      setError((e as Error).message || 'Could not load mission replay.');
    }
  }, [projectId, active]);

  // Rehydrate the gate whenever a mission is opened — including after a
  // reload, which is the whole point: the pending request is on the
  // service, so it comes back on its own with no duplicate created.
  useEffect(() => { void refreshApprovals(); }, [active?.id, refreshApprovals]);

  return {
    missions, active, loadingList, creation, busyTaskId, batchBusy, replay, error,
    approvals, approvalBusyId, decideApproval, refreshApprovals,
    refreshList, selectMission, createMission, approve, rejectPlan,
    startExecution, runBatch, runTask, acceptTask, rejectTask, retryTask, completeTask,
    pause, resume, cancel, reviewCheckpoint, loadReplay,
    clearActive: () => { setActive(null); setCreation(IDLE_CREATION); setReplay(null); },
  };
}
