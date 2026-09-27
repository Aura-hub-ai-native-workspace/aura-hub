/**
 * WorkspaceScreen — the ONE unified, full-screen Workspace.
 * =====================================================================
 * AURA Hub has a single workspace. It is two modes in one surface,
 * chosen by the Central Agent from the request and its context — never
 * by a mode switch:
 *
 *   CHAT — the left panel is the conversation: complete history,
 *   streamed assistant responses, one composer, attachments, web
 *   research, and the approval gate when AURA parks on a decision.
 *
 *   AGENT WORK — the right panel is the live execution: the Central
 *   Agent's plan, delegated tasks, worker messages, governed actions
 *   and verification, rendered from the SAME event frames the
 *   transcript streams. A Capabilities tab preserves the machine
 *   inventory: tool slots, worker slots, project picker, autonomy.
 *
 * One pipeline, not two. The conversation store
 * (`useWorkspaceConversations`) owns the single submission, the
 * transcript and the one SSE subscription; the timeline folds its
 * views from the store's own frames via the shared pure derivations
 * (`agentWorkspaceV2/runViews`). Nothing here submits a second run.
 *
 * The right panel takes NO input — the only composer is the left
 * panel's. Reduced motion is handled globally (global.css).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring, useAppStore } from '@aura/core';
import { Icon } from '@aura/ui';
import { useMediaQuery } from '@aura/ui';
import { useEnvironmentStore } from '../environment/environmentStore';
import { useWorkspace } from '../data/useWorkspace';

import { ACTIVE_TOOL_SLOTS, useHubStore } from '../workspace/hubStore';
import { deriveToolSlots } from '../workspace/toolSlots';
import { deriveWorkerSlots } from '../workspace/workerSlots';
import { fabricClient, type ApprovalRequest } from '../ai/fabricClient';
import { centralAgentClient, type AgentResult } from '../ai/centralAgentClient';
import { agentApprovalToRequest, type AgentApprovalRow } from '../ai/agentApprovals';
import { AddNodeDialog } from '../workspace/AddNodeDialog';
import { NodeInspector } from '../environment/NodeInspector';
import { FloatingSurface } from '../environment/windows/FloatingSurface';
import { useWindowManager } from '../environment/windows/windowManager';
import { CATEGORY_ICON, STATUS_TONE, TONE_DOT } from '../environment/presentation';

import { useWorkerStore } from '../workspace/useWorkers';
import { useLayoutStore } from '../ops/layoutStore';
import { LeftControlPanel } from './workspace/neon/LeftControlPanel';
import { ConversationPane } from './workspace/neon/ConversationPane';
import { useWorkspaceConversations } from '../ai/useAgentConversations';
import { AuraEverything } from '../environment/AuraEverything';
import { AddWorkerPanel } from '../workspace/AddWorkerPanel';

import { IdentityStrip, AttachPanel } from './agentWorkspaceV2/LeftPanel';
import { V2TimelinePanel } from './agentWorkspaceV2/TimelinePanel';
import { buildV2Timeline } from './agentWorkspaceV2/timelineModel';
import { useAgentWorkspaceV2 } from './agentWorkspaceV2/useAgentWorkspaceV2';

type RightTab = 'execution' | 'capabilities';

export function WorkspaceScreen() {
  const isWide = !useMediaQuery('(max-width: 1024px)');
  const [rightTab, setRightTab] = useState<RightTab>('execution');
  const [adding, setAdding] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  /* The working project — the same source the v2 surface reads, so
     the two can never disagree about which directory AURA works in.
     A project is needed for file work; it is NOT needed to talk. */
  const projects = useWorkspace((s) => s.projects);
  const refreshProjects = useWorkspace((s) => s.refresh);
  const projectId = useAppStore((s) => s.activeProjectId);
  const setActiveProject = useAppStore((s) => s.setActiveProject);
  useEffect(() => { void refreshProjects(); }, [refreshProjects]);
  const projectPath = useMemo(
    () => projects.find((p) => p.id === projectId)?.path ?? null,
    [projects, projectId],
  );

  /* ── the ONE conversation pipeline ─────────────────────────────
     The store owns the transcript, the single submission and the
     single SSE subscription. The timeline below folds from the same
     frames — no second run is ever started here. */
  const conv = useWorkspaceConversations();
  /* Stable action reference: the effect must NOT depend on `conv`
     (the whole store object, new identity on every set). Depending
     on it re-ran loadForWorkspace after each store write, and with
     an empty conversation list the early-return guard never passed —
     an infinite setState loop that froze the screen on mount. */
  const loadForWorkspace = useWorkspaceConversations((s) => s.loadForWorkspace);
  useEffect(() => {
    void loadForWorkspace(projectId, projectPath);
  }, [projectId, projectPath, loadForWorkspace]);

  /* v2 support state — provider readout, web-research toggle, gateway
     probe, attachments. The run-dependent fields of this hook are NOT
     used for sending: the store is the only submission path. */
  const s = useAgentWorkspaceV2({ projectId, projectPath });

  /* ── capability / machine inventory (preserved from the neon
     workspace) — the Capabilities tab and the floating inspectors. */
  const placed = useHubStore((s) => s.placed);
  const relayout = useHubStore((s) => s.relayout);
  const placeTool = useHubStore((s) => s.add);
  const removeTool = useHubStore((s) => s.remove);
  const replaceToolAt = useHubStore((s) => s.replaceAt);
  const workerIds = useHubStore((s) => s.workerIds);
  const placeWorkerAt = useHubStore((s) => s.placeWorkerAt);
  const clearWorkerAt = useHubStore((s) => s.clearWorkerAt);
  const firstFreeWorkerSlot = useHubStore((s) => s.firstFreeWorkerSlot);
  const hasFreeSlot = useHubStore((s) => s.placed.length < ACTIVE_TOOL_SLOTS);

  const envNodes = useEnvironmentStore((s) => s.nodes);
  const scanning = useEnvironmentStore((s) => s.scanning);
  const lastScanAt = useEnvironmentStore((s) => s.lastScanAt);
  const scan = useEnvironmentStore((s) => s.scan);
  const openWindow = useWindowManager((s) => s.open);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const installNode = useEnvironmentStore((s) => s.install);
  const busyNodes = useEnvironmentStore((s) => s.busy);

  useEffect(() => {
    if (!lastScanAt) void scan();
  }, [lastScanAt, scan]);

  const selectProject = useCallback((id: string | null) => {
    setActiveProject(id || null);
  }, [setActiveProject]);

  const toolSlots = useMemo(() => deriveToolSlots(placed, envNodes), [placed, envNodes]);
  const placedIds = useMemo(() => placed.map((p) => p.nodeId), [placed]);

  /* Real AI workers — the backend's own connection verdict, read from
     the worker routes rather than an environment probe. */
  const workers = useWorkerStore((s) => s.workers);
  const workersConnecting = useWorkerStore((s) => s.connecting);
  const workersError = useWorkerStore((s) => s.error);
  const refreshWorkers = useWorkerStore((s) => s.refresh);
  const connectWorker = useWorkerStore((s) => s.connect);
  const disconnectWorker = useWorkerStore((s) => s.disconnect);
  useEffect(() => { void refreshWorkers(); }, [refreshWorkers]);

  const workerSlots = useMemo(
    () => deriveWorkerSlots(workerIds, workers),
    [workerIds, workers],
  );

  /* Which management surface is open, if any. Opening one costs
     nothing: the roster and the inventory are already loaded. */
  const [surface, setSurface] = useState<'none' | 'worker' | 'tool'>('none');
  const [replacingSlot, setReplacingSlot] = useState<number | null>(null);
  const [workerSlotIndex, setWorkerSlotIndex] = useState<number | null>(null);

  const closeSurface = useCallback(() => {
    setSurface('none');
    setReplacingSlot(null);
    setWorkerSlotIndex(null);
  }, []);

  const openToolSurface = useCallback((slotIndex: number | null) => {
    setReplacingSlot(slotIndex);
    setSurface('tool');
  }, []);

  const openWorkerSurface = useCallback((slotIndex: number | null) => {
    setWorkerSlotIndex(slotIndex);
    setSurface('worker');
  }, []);

  const workerSlotContext = useMemo(() => {
    if (workerSlotIndex === null) return null;
    const slot = workerSlots[workerSlotIndex];
    return { index: workerSlotIndex, name: slot?.workerId ? slot.worker?.name ?? slot.workerId : null };
  }, [workerSlotIndex, workerSlots]);

  const replacing = useMemo(() => {
    if (replacingSlot === null) return null;
    const slot = toolSlots[replacingSlot];
    if (!slot?.nodeId) return null;
    return { index: replacingSlot, name: slot.node?.entry.name ?? slot.nodeId };
  }, [replacingSlot, toolSlots]);

  /* ── approvals — resolved from the ledgers by id, exactly as the
     neon workspace did. The Central Agent parks on its OWN ledger
     (:4320), so that ledger is authoritative for a parked id; the
     workflow ledger (:4319) remains the fallback. Never guessed: an
     id with no match stays null and the gate is not shown. */
  const [approvals, setApprovals] = useState<Record<string, ApprovalRequest | null>>({});
  const resolving = useRef<Set<string>>(new Set());
  const [deciding, setDeciding] = useState(false);
  const [autonomyBusy, setAutonomyBusy] = useState(false);
  const setAutonomy = useWorkspace((s) => s.setAutonomy);
  const toggleAutonomy = useCallback(async (enabled: boolean) => {
    if (!projectId) return;
    setAutonomyBusy(true);
    try {
      await setAutonomy(projectId, enabled);
    } finally {
      setAutonomyBusy(false);
    }
  }, [projectId, setAutonomy]);
  const parkedIds = useMemo(
    () => conv.messages.map((m) => m.agent?.approvalId).filter((x): x is string => !!x),
    [conv.messages],
  );
  useEffect(() => {
    const missing = parkedIds.filter((id) => approvals[id] === undefined && !resolving.current.has(id));
    if (!missing.length) return;
    for (const id of missing) resolving.current.add(id);
    void (async () => {
      let agentRows: AgentApprovalRow[] = [];
      let decidedRows: AgentApprovalRow[] = [];
      let failed = false;
      try {
        const res = await centralAgentClient.pendingApprovals();
        agentRows = res.approvals ?? [];
        decidedRows = res.decided ?? [];
      } catch {
        failed = true;
      }
      const agentById = new Map(agentRows.map((r) => [r.id, r]));
      const decidedById = new Map(decidedRows.map((r) => [r.id, r]));
      const needFallback = missing.filter((id) => !agentById.has(id));
      let fabricList: ApprovalRequest[] = [];
      if (needFallback.length) {
        try {
          ({ approvals: fabricList } = await fabricClient.approvals());
        } catch { /* the gate stays unrendered rather than guessing */ }
      }
      const fabricById = new Map(fabricList.map((a) => [a.id, a]));
      if (!failed) {
        setApprovals((prev) => {
          const next = { ...prev };
          for (const id of missing) {
            const agentRow = agentById.get(id) ?? decidedById.get(id);
            next[id] = (agentRow ? agentApprovalToRequest(agentRow) : null)
              ?? fabricById.get(id)
              ?? null;
          }
          return next;
        });
      }
      for (const id of missing) resolving.current.delete(id);
    })();
  }, [parkedIds, approvals]);

  const decide = useCallback(async (messageId: string, granted: boolean, reason?: string) => {
    setDeciding(true);
    try {
      const decided = await conv.decide(messageId, granted, reason);
      if (decided && typeof decided.id === 'string') {
        const settled = agentApprovalToRequest(decided);
        if (settled) setApprovals((prev) => ({ ...prev, [settled.id]: settled }));
      }
    } finally { setDeciding(false); }
  }, [conv]);

  /* Explicit Ask AURA → Workspace handoff. An offer, not an order. */
  const handoff = useWorkspaceConversations((s) => s.pendingHandoff);
  const dismissHandoff = useCallback(() => { conv.dismissHandoff(); }, [conv]);
  const startHandoff = useCallback(() => {
    const h = conv.consumeHandoff();
    if (h?.text.trim()) void conv.send(h.text);
  }, [conv]);

  /* ── the execution timeline — folded from the store's OWN frames.
     The transcript streams tokens from the same list; the right panel
     shows the plan, handoffs, governed actions and verification those
     frames establish. One pipeline, one source of truth. */
  const frames = useWorkspaceConversations((st) => st.frames);
  const timeline = useMemo(() => {
    const views = conv.runViews();
    const lastAssistant = [...conv.messages].reverse().find((m) => m.role === 'assistant');
    const meta = lastAssistant?.agent;
    let result: AgentResult | null = null;
    if (meta) {
      result = {
        status: 'completed',
        outcome: meta.outcome ?? 'completed',
        summary: lastAssistant?.content ?? '',
        performed: meta.performed ?? [],
        verified: meta.verified ?? [],
        evidence: {
          sessionId: meta.sessionId ?? '',
          planId: '',
          auditRecordIds: [],
          approvalIds: meta.approvalId ? [meta.approvalId] : [],
          summary: meta.evidenceSummary ?? '',
          createdAt: '',
        },
        runId: meta.runId ?? null,
      };
    }
    return buildV2Timeline({
      objective: views.objective,
      handoffs: views.handoffs,
      actions: views.actions,
      plan: views.plan,
      events: frames,
      result,
      sessionId: meta?.sessionId ?? null,
      busy: conv.phase === 'working',
    });
  }, [conv, frames]);

  /* Live worker highlight for the capability tab, from the frames the
     conversation already receives. No second subscription. */
  const workerActivity = useMemo(
    () => new Map(Object.entries(conv.activity.workers)),
    [conv.activity.workers],
  );

  const agentPhase = conv.activity.phase
    ?? (conv.phase === 'working' ? 'Working' : 'Ready when you are');
  const projectName = projects.find((p) => p.id === projectId)?.name ?? null;

  return (
    <div ref={canvasRef} className="neon-shell relative h-full min-h-0" data-testid="workspace-screen">
      <div aria-hidden className="neon-grid pointer-events-none absolute inset-0" />

      <div
        className={cn(
          'relative mx-auto grid min-h-0 w-full max-w-[1760px] flex-1 gap-4 p-4',
          isWide
            ? 'grid-cols-[minmax(340px,30%)_minmax(0,1fr)] overflow-hidden'
            : 'grid-cols-1 gap-3 overflow-y-auto',
        )}
        data-testid="workspace-split"
      >
        {/* LEFT — the conversation: history, streamed responses, the
            ONE composer, attachments, web research, approvals. */}
        <div
          className="flex min-h-0 flex-col gap-3"
          data-testid="ws-left-panel"
          aria-label="User interaction — talk to AURA Central Agent"
        >
          <div className="rounded-2xl border border-[rgba(125,146,255,0.28)] bg-ws-panel p-4 shadow-card">
            <IdentityStrip
              connectedProviders={s.connectedProviders}
              availableTools={s.availableTools}
              agentPhase={agentPhase}
              agentBusy={conv.phase === 'working'}
              modelName={s.modelName}
            />
          </div>

          <ConversationPane
            messages={conv.messages}
            activity={conv.activity}
            busy={conv.phase === 'working'}
            agentUp={conv.agentUp}
            approvals={approvals}
            deciding={deciding}
            onSend={(text) => void conv.send(text)}
            onStop={() => conv.stop()}
            onRegenerate={() => void conv.regenerate()}
            onDecide={(id, granted, reason) => void decide(id, granted, reason)}
            projectName={projectName}
            scope="workspace"
            onPickFiles={(files) => { if (files && files.length > 0) void s.attachments.add(files); }}
            webSearch={{
              enabled: s.webSearchEnabled,
              onToggle: () => s.setWebSearchEnabled(!s.webSearchEnabled),
            }}
          />

          <AttachPanel
            attachments={s.attachments.attachments}
            onRemove={(id) => s.attachments.remove(id)}
            onPick={(files) => void s.attachments.add(files)}
          />
        </div>

        {/* RIGHT — agent execution. No user composer here. */}
        <div
          className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[rgba(125,146,255,0.28)] bg-ws-panel shadow-card"
          data-testid="ws-right-panel"
          aria-label="AURA agent execution"
        >
          {/* Web-research state — the sole toggle lives in the left
              composer; this bar only reports the state. */}
          <div
            className="flex shrink-0 items-center gap-2 border-b border-[rgba(125,146,255,0.16)] px-5 py-2"
            data-testid="ws-web-search-status"
            role="status"
            aria-live="polite"
          >
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold leading-tight',
                s.webSearchEnabled
                  ? 'border-[rgba(32,211,255,0.55)] bg-[rgba(32,211,255,0.12)] text-ws-ink-cyan'
                  : 'border-line bg-ws-soft text-text-muted',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  s.webSearchEnabled ? 'bg-neon-cyan' : 'bg-text-subtle',
                )}
              />
              Web research {s.webSearchEnabled ? 'ON' : 'OFF'} for this request
            </span>
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-text-subtle">
              {s.webSearchEnabled
                ? s.gatewayProbe.state === 'ready'
                  ? `Gateway live at ${s.gatewayProbe.endpoint || 'the agent host'} — only a redacted query leaves the machine.`
                  : 'No public query will leave this host until the gateway route exists on the backend; AURA will say so, honestly.'
                : 'Private by default — no public-web egress for this request.'}
            </span>
          </div>

          {/* Right-panel views: the live execution is the headline; the
              machine inventory is one tab away. */}
          <div
            className="flex shrink-0 items-center gap-1 border-b border-[rgba(125,146,255,0.16)] px-3 py-1.5"
            role="tablist"
            aria-label="Workspace views"
          >
            {(
              [
                { key: 'execution', label: 'Live execution' },
                { key: 'capabilities', label: 'Capabilities' },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={rightTab === key}
                data-testid={`ws-tab-${key}`}
                onClick={() => setRightTab(key)}
                className={cn(
                  'neon-focus rounded-lg px-3 py-1.5 text-[11.5px] font-medium transition-colors',
                  rightTab === key
                    ? 'bg-[rgba(125,146,255,0.16)] text-text'
                    : 'text-text-muted hover:text-text',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {rightTab === 'execution' ? (
            <V2TimelinePanel
              timeline={timeline}
              agentUp={conv.agentUp}
              streamPaused={s.streamPaused}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <LeftControlPanel
                toolSlots={toolSlots}
                workerSlots={workerSlots}
                scanning={scanning}
                projects={projects}
                projectId={projectId}
                onSelectProject={selectProject}
                onAddWorker={(index) => openWorkerSurface(index)}
                onRemoveWorker={(index) => clearWorkerAt(index)}
                onReplaceWorker={(index) => openWorkerSurface(index)}
                onAddTool={() => openToolSurface(null)}
                onRemoveTool={removeTool}
                onReplaceTool={(index) => openToolSurface(index)}
                onRelayout={relayout}
                onInspect={openWindow}
                workers={workers}
                workersConnecting={workersConnecting}
                workersError={workersError}
                workerActivity={workerActivity}
                onRefreshWorkers={() => void refreshWorkers()}
                onConnectWorker={(id) => void connectWorker(id)}
                onDisconnectWorker={(id) => void disconnectWorker(id)}
                phase={agentPhase}
                agentBusy={conv.phase === 'working'}
                autonomyBusy={autonomyBusy}
                onToggleAutonomy={(enabled) => void toggleAutonomy(enabled)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Offered task from Ask AURA. An offer, not an order. */}
      {handoff && (
        <div
          role="dialog"
          aria-label="Suggested Workspace Task from Ask AURA"
          data-testid="handoff-banner"
          className="absolute inset-x-0 top-3 z-20 mx-auto w-[min(640px,calc(100%-2rem))]"
        >
          <div className="rounded-2xl border border-[rgba(125,146,255,0.4)] bg-ws-dialog p-4 shadow-card">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
              Suggested Workspace Task{handoff.sourceProjectName ? ` · from ${handoff.sourceProjectName}` : ''}
            </p>
            <p className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-text">
              {handoff.text}
            </p>
            <p className="mt-1.5 text-[11px] text-text-subtle">
              Will run as an execution objective
              {projectName
                ? ` in ${projectName}`
                : ' with no working project — pick one in the Capabilities tab first if the work needs files'}.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={dismissHandoff}
                className="neon-focus rounded-xl border border-[rgba(125,146,255,0.3)] px-3.5 py-1.5 text-[12px] text-text-muted transition-colors hover:text-text"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={startHandoff}
                data-testid="handoff-start"
                className="neon-focus rounded-xl bg-gradient-to-br from-neon-blue to-neon-violet px-3.5 py-1.5 text-[12px] font-medium text-white shadow-glow-blue"
              >
                Start in Workspace
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Catalogue dialog mounts alongside so placing a node never unmounts the shell. */}
      {surface !== 'none' && (
        <div
          className="absolute inset-0 z-30 flex items-stretch justify-end bg-[rgba(4,7,14,0.72)] p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={surface === 'worker' ? 'Add AI Worker' : 'AURA Everything'}
          onClick={(e) => { if (e.target === e.currentTarget) closeSurface(); }}
        >
          <div className="flex w-full max-w-[560px] min-h-0 flex-col rounded-2xl border border-[rgba(125,146,255,0.3)] bg-ws-dialog p-4 shadow-card">
            <div className="mb-3 flex items-start justify-end">
              <button
                type="button"
                onClick={closeSurface}
                aria-label="Close"
                data-testid="surface-close"
                className="neon-focus grid h-8 w-8 place-items-center rounded-lg border border-[rgba(125,146,255,0.3)] text-text-muted transition-colors hover:text-text"
              >
                <Icon name="close" size={15} />
              </button>
            </div>
            {surface === 'worker' ? (
              <AddWorkerPanel
                workers={workers}
                connecting={workersConnecting}
                error={workersError}
                slot={workerSlotContext}
                inWorkspace={workerIds.filter((id): id is string => !!id)}
                hasFreeSlot={firstFreeWorkerSlot() !== null}
                onConnect={(id) => void connectWorker(id)}
                onDisconnect={(id) => void disconnectWorker(id)}
                onPlace={(workerId) => {
                  const index = workerSlotIndex ?? firstFreeWorkerSlot();
                  if (index === null) return;
                  if (placeWorkerAt(index, workerId)) closeSurface();
                }}
              />
            ) : (
              <AuraEverything
                installing={busyNodes}
                onInstall={(catalogId) => void installNode(catalogId)}
                inWorkspace={placedIds}
                hasFreeSlot={hasFreeSlot}
                replacing={replacing}
                onAddToWorkspace={(catalogId) => {
                  const done =
                    replacingSlot === null
                      ? placeTool(catalogId)
                      : replaceToolAt(replacingSlot, catalogId);
                  if (done) closeSurface();
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* Sovereign panel quick-launch — Documents, Artifacts, Sovereign Monitor. */}
      <div
        data-testid="sovereign-panel-toolbar"
        className="absolute bottom-4 right-4 z-10 flex items-center gap-1 rounded-xl border border-[rgba(125,146,255,0.25)] bg-ws-pop-soft p-1 shadow-card backdrop-blur-sm"
      >
        {(
          [
            { kind: 'documents', icon: 'doc', label: 'Documents' },
            { kind: 'artifacts', icon: 'folder', label: 'Artifacts' },
            { kind: 'sovereign-monitor', icon: 'shield', label: 'Sovereign Monitor' },
          ] as const
        ).map(({ kind, icon, label }) => (
          <button
            key={kind}
            type="button"
            data-testid={`open-panel-${kind}`}
            aria-label={label}
            title={label}
            onClick={() => openPanel(kind)}
            className="neon-focus grid h-7 w-7 place-items-center rounded-lg text-text-muted transition-colors hover:bg-[rgba(125,146,255,0.12)] hover:text-text"
          >
            <Icon name={icon} size={14} />
          </button>
        ))}
      </div>

      <AddNodeDialog open={adding} onClose={() => setAdding(false)} />
      <NodeWindows canvasRef={canvasRef} />
      <WindowTray />
    </div>
  );
}

/* ── Floating node inspectors ───────────────────────────────────────
   Same proven surface as ConnectedEnvironment: clicking a capability
   opens its live inspector above the shell. Windows are working
   surfaces — closing one never removes the capability. */

function NodeWindows({ canvasRef }: { canvasRef: RefObject<HTMLDivElement | null> }) {
  const windows = useWindowManager((s) => s.windows);
  const nodes = useEnvironmentStore((s) => s.nodes);
  const busy = useEnvironmentStore((s) => s.busy);
  const connect = useEnvironmentStore((s) => s.connect);
  const disconnect = useEnvironmentStore((s) => s.disconnect);
  const setNodePermissions = useEnvironmentStore((s) => s.setNodePermissions);

  return (
    <AnimatePresence>
      {windows.map((win) => {
        const node = nodes.find((n) => n.id === win.contentId);
        if (!node) return null;
        const tone = STATUS_TONE[node.health.status];
        return (
          <FloatingSurface
            key={win.id}
            window={win}
            canvasRef={canvasRef}
            title={node.entry.name}
            icon={CATEGORY_ICON[node.entry.category]}
            subtitle={node.health.version}
            toneClass={TONE_DOT[tone]}
          >
            <NodeInspector
              node={node}
              busy={busy.includes(node.id)}
              onConnect={() => void connect(node.id)}
              onDisconnect={() => disconnect(node.id)}
              onPermissions={(partial) => setNodePermissions(node.id, partial)}
            />
          </FloatingSurface>
        );
      })}
    </AnimatePresence>
  );
}

function WindowTray() {
  const windows = useWindowManager((s) => s.windows);
  const focusedId = useWindowManager((s) => s.focusedId);
  const focus = useWindowManager((s) => s.focus);
  const minimize = useWindowManager((s) => s.minimize);
  const closeAll = useWindowManager((s) => s.closeAll);
  const nodes = useEnvironmentStore((s) => s.nodes);

  if (!windows.length) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.smooth}
      className="pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center"
    >
      <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-line bg-surface/90 p-1.5 shadow-lg backdrop-blur-xl">
        {windows.map((win) => {
          const node = nodes.find((n) => n.id === win.contentId);
          if (!node) return null;
          const active = focusedId === win.id && !win.minimized;
          return (
            <button
              key={win.id}
              onClick={() => (active ? minimize(win.id) : focus(win.id))}
              title={node.entry.name}
              className={cn(
                'grid h-8 w-8 place-items-center rounded-xl transition-all hover:scale-105',
                active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-surface-hover hover:text-text',
              )}
            >
              <Icon name={CATEGORY_ICON[node.entry.category]} size={16} />
            </button>
          );
        })}
        <button
          onClick={() => closeAll()}
          title="Close all windows"
          className="grid h-8 w-8 place-items-center rounded-xl text-text-subtle transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </motion.div>
  );
}
