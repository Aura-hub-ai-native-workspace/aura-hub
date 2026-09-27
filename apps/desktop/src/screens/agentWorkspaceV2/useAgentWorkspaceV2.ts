/**
 * Agent Workspace v2 — orchestrator hook.
 * =====================================================================
 * The one hook the v2 screen uses to read AURA's live state. It
 * deliberately REUSES `useAgentRun` (the existing hook the neon
 * workspace already trusts) for the run pipeline — same Central Agent
 * session, same SSE subscription, same derived views (`plan`, `handoffs`,
 * `actions`, `objective`). No parallel runtime, no duplicate client.
 *
 * On top of that, this hook adds four v2-specific things:
 *
 *   1. Web-search state — UI-local. The backend submit API does not
 *      accept a `webSearch` field yet; the toggle is honest about
 *      that ("ON but gateway pending") instead of pretending the
 *      backend honors it.
 *
 *   2. Gateway probe — one `privateSearchGateway.probe()` on mount +
 *      when the user flips the toggle. Reports `GATEWAY_NOT_IMPLEMENTED`
 *      or `ready — <endpoint>`.
 *
 *   3. Provider readout — from `centralAgentClient.modelStatus()`.
 *      Called once on mount and again whenever a run settles, so the
 *      left panel always shows the model the host is actually pointed
 *      at.
 *
 *   4. Timeline — `buildV2Timeline(...)` over the run's own views.
 *      Pure synchronous fold; the hook re-runs it whenever any of
 *      its inputs change.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { centralAgentClient } from '../../ai/centralAgentClient';
import { useAgentRun } from '../workspace/neon/useAgentRun';
import { buildV2Timeline, type V2TimelineInput } from './timelineModel';
import { privateSearchGateway } from './searchGateway';
import { useAttachments } from './useAttachments';
import type { GatewayProbe } from './types';

export interface V2ScreenState {
  /** Composer text — the screen binds to this for the textarea. */
  text: string;
  setText: (v: string) => void;
  /** True while a run is driving. Drives disabled states on buttons. */
  busy: boolean;
  /** The v2 timeline for the current run. */
  timeline: ReturnType<typeof buildV2Timeline>;
  /** Whether the current stream is paused (SSE reconnecting). */
  streamPaused: boolean;
  /** Liveness of the Central Agent service (null = not yet asked). */
  agentUp: boolean | null;
  /** Providers this host reports as configured + reachable. */
  connectedProviders: string[];
  /** The model the host is currently pointed at (null if unknown). */
  modelName: string | null;
  /** Tools AURA reported as available — from `capability.discovery`. */
  availableTools: string[];
  /** Live phase line, when the run is moving. */
  agentPhase: string | null;

  /** Attachments state. */
  attachments: ReturnType<typeof useAttachments>;
  /** Web research state (UI-local — see header doc for honesty note). */
  webSearchEnabled: boolean;
  setWebSearchEnabled: (v: boolean) => void;
  gatewayProbe: GatewayProbe;
  reprobeGateway: () => void;

  /** Actions the screen binds to. */
  onSend: () => void;
  onStop: () => void;
  onResumeCancelled: () => void;
  onDecided: (next: unknown) => void;

  /** True while the backend is asking the user to decide. */
  pendingApproval: string | null;
  /** The live Central Agent session, for the approval decision path. */
  sessionId: string | null;
  parkedTaskId: string | null;
  parkedScope: string[];
  workerRail: string;
}

/** The screen calls this from inside a component.
 *
 *  `projectId` + `projectPath` are used by `useAgentRun` to submit the
 *  run under the correct scope; pass null for a global workspace turn.
 */
export function useAgentWorkspaceV2(opts: {
  projectId: string | null;
  projectPath: string | null;
}): V2ScreenState {
  /* Reuse the existing run hook — same client, same SSE, same views. */
  const run = useAgentRun({
    projectId: opts.projectId,
    projectPath: opts.projectPath,
  });

  /* Attachments — independent of the run; users can add files at any
     point and they ingest in the background. */
  const attachments = useAttachments();

  /* Web research — UI-local. */
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);

  /* Gateway probe — run once on mount and on any toggle. */
  const [gatewayProbe, setGatewayProbe] = useState<GatewayProbe>({
    state: 'unavailable',
    reason: 'GATEWAY_NOT_IMPLEMENTED',
  });
  const reprobeGateway = useCallback(async () => {
    const res = await privateSearchGateway.probe();
    setGatewayProbe(res);
  }, []);
  useEffect(() => { void reprobeGateway(); }, [reprobeGateway]);

  /* Providers — from the backend's own modelStatus. */
  const [providers, setProviders] = useState<Array<{ id: string; model: string }>>([]);
  const [agentUp, setAgentUp] = useState<boolean | null>(null);
  const [modelName, setModelName] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    try {
      const res = await centralAgentClient.modelStatus();
      setAgentUp(true);
      setProviders(
        (res.providers ?? [])
          .filter((p) => p.id)
          .map((p) => ({ id: p.id, model: p.model ?? '' })),
      );
      // The model the host is pointed at: `lastCall.provider` when it
      // exists, else the first configured provider's id.
      if (res.lastCall?.provider) setModelName(`${res.lastCall.provider} · ${res.lastCall.model}` as string);
      else if (res.configured && (res.providers ?? []).length > 0) setModelName(res.providers[0].model ?? res.providers[0].id);
    } catch {
      setAgentUp(false);
    }
  }, []);
  useEffect(() => { void loadProviders(); }, [loadProviders]);
  // Refresh when a run settles — the provider list may change as the
  // agent rotates through available routes.
  useEffect(() => {
    if (run.result) void loadProviders();
  }, [run.result, loadProviders]);

  /* Available tools — from the run's own `capability.discovery` frame,
     which is the single source of truth for "what the backend said
     was available this run". */
  const availableTools = useMemo(() => {
    const out: string[] = [];
    for (const f of run.events) {
      if (f.type !== 'capability.discovery') continue;
      const tools = (f.payload?.tools ?? []) as Array<Record<string, unknown>>;
      for (const t of tools) {
        if (t.available !== true) continue;
        const id = typeof t.id === 'string' ? t.id : null;
        if (id && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }, [run.events]);

  /* Live phase line — the same vocabulary the neon workspace uses. */
  const agentPhase = useMemo(() => {
    for (let i = run.events.length - 1; i >= 0; i--) {
      const f = run.events[i];
      if (f.type === 'answer.token' || f.type === 'result.ready') continue;
      if (f.type === 'plan.created') return 'Planning';
      if (f.type === 'execution.started') return 'Executing';
      if (f.type === 'worker.lifecycle') {
        const lc = String(f.payload?.lifecycle ?? '');
        if (lc === 'ACTIVE') return 'Working';
        if (lc === 'WAITING') return 'Waiting for approval';
        if (lc === 'FAILED') return 'One step failed';
        if (lc === 'TERMINATED') return 'Stopping';
      }
      if (f.type === 'approval.required') return 'Waiting for approval';
      if (f.type === 'verification.completed') return 'Verifying';
      if (f.type === 'invocation.observed') return 'Working';
      if (f.type === 'intent.compiled') return 'Understanding your request';
      if (f.type === 'session.started') return 'Starting';
    }
    return run.busy ? 'Working' : null;
  }, [run.events, run.busy]);

  /* Stream-paused — the client's own `stream.reconnecting` frame is the
     honest signal; nothing here fabricates a pause. */
  const streamPaused = useMemo(() => {
    for (let i = run.events.length - 1; i >= 0; i--) {
      const f = run.events[i];
      if (f.type === 'stream.reconnecting') return true;
      if (f.type === 'result.ready' || f.type === 'run.cancelled') return false;
    }
    return false;
  }, [run.events]);

  /* Timeline — the v2 view over the run's real records. */
  const input: V2TimelineInput = useMemo(
    () => ({
      objective: run.objective,
      handoffs: run.handoffs,
      actions: run.actions,
      plan: run.plan,
      events: run.events,
      result: run.result,
      sessionId: run.sessionId,
      busy: run.busy,
    }),
    [run.objective, run.handoffs, run.actions, run.plan, run.events, run.result, run.sessionId, run.busy],
  );
  const timeline = useMemo(() => buildV2Timeline(input), [input]);

  /* Screen-level callbacks */
  const onSend = useCallback(() => { void run.submit(); }, [run]);
  const onStop = useCallback(() => { void run.stop(); }, [run]);
  const onResumeCancelled = useCallback(() => { void run.resumeCancelled(); }, [run]);
  const onDecided = useCallback((next: unknown) => run.onDecided(next), [run]);

  const connectedProviders = useMemo(
    () => providers.map((p) => p.model || p.id).filter(Boolean),
    [providers],
  );

  const workerRail =
    run.plan.find((t) => t.worker)?.worker ?? '';

  return {
    text: run.text,
    setText: run.setText,
    busy: run.busy,
    timeline,
    streamPaused,
    agentUp,
    connectedProviders,
    modelName: modelName ?? null,
    availableTools,
    agentPhase,
    attachments,
    webSearchEnabled,
    setWebSearchEnabled: (v: boolean) => {
      setWebSearchEnabled(v);
      void reprobeGateway();
    },
    gatewayProbe,
    reprobeGateway: () => void reprobeGateway(),
    onSend,
    onStop,
    onResumeCancelled,
    onDecided,
    pendingApproval: run.pendingApproval,
    sessionId: run.sessionId,
    parkedTaskId: run.parkedTask?.id ?? null,
    parkedScope: run.parkedScope ?? [],
    workerRail,
  };
}
