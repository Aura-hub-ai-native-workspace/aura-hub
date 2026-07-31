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
import { useCallback, useRef, useState } from 'react';
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
    const mission = await missionClient.approve(projectId, active.id);
    setActive(mission);
    void refreshList();
  }, [projectId, active, refreshList]);

  const rejectPlan = useCallback(async () => {
    if (!projectId || !active) return;
    const mission = await missionClient.reject(projectId, active.id);
    setActive(mission);
    void refreshList();
  }, [projectId, active, refreshList]);

  const startExecution = useCallback(async () => {
    if (!projectId || !active) return;
    setBatchBusy(true);
    try {
      const result = await missionClient.start(projectId, active.id);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
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

  const runTask = useCallback(async (taskId: string) => {
    if (!projectId || !active) return;
    setBusyTaskId(taskId);
    setError(null);
    try {
      const result = await missionClient.runTask(projectId, active.id, taskId);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
    } finally {
      setBusyTaskId(null);
    }
  }, [projectId, active]);

  const acceptTask = useCallback(async (taskId: string) => {
    if (!projectId || !active) return;
    setBusyTaskId(taskId);
    try {
      const result = await missionClient.acceptTask(projectId, active.id, taskId);
      if (result.mission) setActive(result.mission);
      if (!result.ok && result.error) setError(result.error);
    } finally {
      setBusyTaskId(null);
    }
  }, [projectId, active]);

  const rejectTask = useCallback(async (taskId: string) => {
    if (!projectId || !active) return;
    const result = await missionClient.rejectTask(projectId, active.id, taskId);
    if (result.mission) setActive(result.mission);
  }, [projectId, active]);

  const retryTask = useCallback(async (taskId: string) => {
    if (!projectId || !active) return;
    const result = await missionClient.retryTask(projectId, active.id, taskId);
    if (result.mission) setActive(result.mission);
  }, [projectId, active]);

  const completeTask = useCallback(async (taskId: string) => {
    if (!projectId || !active) return;
    const result = await missionClient.completeManualTask(projectId, active.id, taskId);
    if (result.mission) setActive(result.mission);
  }, [projectId, active]);

  const pause = useCallback(async () => {
    if (!projectId || !active) return;
    const result = await missionClient.pause(projectId, active.id);
    if (result.mission) setActive(result.mission);
  }, [projectId, active]);

  const resume = useCallback(async () => {
    if (!projectId || !active) return;
    const result = await missionClient.resume(projectId, active.id);
    if (result.mission) setActive(result.mission);
  }, [projectId, active]);

  const cancel = useCallback(async () => {
    if (!projectId || !active) return;
    const result = await missionClient.cancel(projectId, active.id);
    if (result.mission) setActive(result.mission);
  }, [projectId, active]);

  const reviewCheckpoint = useCallback(async (pass: boolean, note?: string) => {
    if (!projectId || !active) return;
    const result = await missionClient.review(projectId, active.id, pass, note);
    if (result.mission) setActive(result.mission);
  }, [projectId, active]);

  const loadReplay = useCallback(async (id?: string) => {
    if (!projectId) return;
    const mid = id ?? active?.id;
    if (!mid) return;
    const payload = await missionClient.replay(projectId, mid);
    if ('error' in payload) setError(payload.error);
    else setReplay(payload);
  }, [projectId, active]);

  return {
    missions, active, loadingList, creation, busyTaskId, batchBusy, replay, error,
    refreshList, selectMission, createMission, approve, rejectPlan,
    startExecution, runBatch, runTask, acceptTask, rejectTask, retryTask, completeTask,
    pause, resume, cancel, reviewCheckpoint, loadReplay,
    clearActive: () => { setActive(null); setCreation(IDLE_CREATION); setReplay(null); },
  };
}
