/**
 * WorkspaceScreen — the place you talk to AURA.
 *
 * This screen used to be a control centre: a capability graph on the
 * left with the only composer under it, and a run timeline on the
 * right showing task ids, worker lifecycles and an outcome enum. It
 * described orchestration accurately and answered nothing. "Hi" got a
 * plan review, and two composers on one screen made it a guess which
 * one was listening.
 *
 * It is now a conversation with a capability graph beside it. The
 * conversation is the content; the graph supports it by showing who
 * AURA can call on and lighting up while they work. There is exactly
 * one composer, at the foot of the conversation.
 *
 * Nothing about authority moved. The same Central Agent session drives
 * the same intent → plan → approval → Fabric → verification path, the
 * same approval ledger decides, and this screen reads the same stores
 * it always did. What changed is which of it is the headline.
 *
 * One conversation store (`useAgentConversations`, the existing project
 * Ask AURA engine) owns the transcript, the session and the live
 * events. There is no second chat implementation and no second stream.
 */
import { useEffect, useMemo, useRef, useState, useCallback, type RefObject } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring, useAppStore } from '@aura/core';
import { Icon } from '@aura/ui';
import { useEnvironmentStore } from '../environment/environmentStore';
import { useWorkspace } from '../data/useWorkspace';

import { ACTIVE_TOOL_SLOTS, useHubStore } from '../workspace/hubStore';
import { deriveToolSlots } from '../workspace/toolSlots';
import { deriveWorkerSlots } from '../workspace/workerSlots';
import { fabricClient, type ApprovalRequest } from '../ai/fabricClient';
import { AddNodeDialog } from '../workspace/AddNodeDialog';
import { NodeInspector } from '../environment/NodeInspector';
import { FloatingSurface } from '../environment/windows/FloatingSurface';
import { useWindowManager } from '../environment/windows/windowManager';
import { CATEGORY_ICON, STATUS_TONE, TONE_DOT } from '../environment/presentation';

import { useWorkerStore } from '../workspace/useWorkers';
import { WorkspaceShell } from './workspace/neon/WorkspaceShell';
import { LeftControlPanel } from './workspace/neon/LeftControlPanel';
import { ConversationPane } from './workspace/neon/ConversationPane';
import { useAgentConversations } from '../ai/useAgentConversations';
import { AuraEverything } from '../environment/AuraEverything';
import { AddWorkerPanel } from '../workspace/AddWorkerPanel';

export function WorkspaceScreen() {
  const [adding, setAdding] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const placed = useHubStore((s) => s.placed);
  const relayout = useHubStore((s) => s.relayout);
  // Placing and freeing a slot are layout edits and nothing else. Neither
  // installs, uninstalls, connects, or touches the machine inventory.
  const placeTool = useHubStore((s) => s.add);
  const removeTool = useHubStore((s) => s.remove);
  const replaceToolAt = useHubStore((s) => s.replaceAt);
  // The six worker slots live in the same layout store as the three tool
  // slots, under their own key. Placing and freeing one is a layout edit
  // and nothing else: no connect, no disconnect, no install, no scan.
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
  // Installation runs through the existing environment store action, which
  // posts a catalogue id to /environment/install. The UI never builds a
  // command and never learns one.
  const installNode = useEnvironmentStore((s) => s.install);
  const busyNodes = useEnvironmentStore((s) => s.busy);

  /* The project the conversation works in. The Hub reads the SHELL's
     active project rather than remembering its own, so the two can
     never disagree about what AURA is pointed at. A project is needed
     for work on files; it is NOT needed to talk. */
  const projects = useWorkspace((s) => s.projects);
  const refreshProjects = useWorkspace((s) => s.refresh);
  const projectId = useAppStore((s) => s.activeProjectId);
  const setActiveProject = useAppStore((s) => s.setActiveProject);

  useEffect(() => { void refreshProjects(); }, [refreshProjects]);

  // Measure the machine once on arrival. Without this the canvas would
  // show every node as "Not scanned", which is honest but useless.
  useEffect(() => {
    if (!lastScanAt) void scan();
  }, [lastScanAt, scan]);

  /* Pruning a project that no longer exists is `useActiveProjectSync`'s job
     now — it is the single place that reconciles the active project with the
     registry, and doing it here as well would be a second authority for the
     same decision. */

  /**
   * Selects the active project for mission planning.
   * @param id Project ID or null to deselect
   */
  const selectProject = useCallback((id: string | null) => {
    setActiveProject(id || null);
  }, [setActiveProject]);

  /* The three active workspace tool slots. Resolved against the live
     environment for status, but WHICH tools occupy them comes only from
     the saved layout — an unresolvable id keeps its slot and reads as
     unavailable rather than silently disappearing. */
  const toolSlots = useMemo(() => deriveToolSlots(placed, envNodes), [placed, envNodes]);

  const placedIds = useMemo(() => placed.map((p) => p.nodeId), [placed]);


  /* ── Real AI workers ─────────────────────────────────────────────
     Separate from the capability nodes above, and read from the
     backend's worker routes rather than an environment probe: a probe
     proves a binary exists, which is not evidence that AURA can hand
     that runtime a task and get a real answer back. `connected` here is
     always the backend's verdict. */
  const workers = useWorkerStore((s) => s.workers);
  const workersConnecting = useWorkerStore((s) => s.connecting);
  const workersError = useWorkerStore((s) => s.error);
  const refreshWorkers = useWorkerStore((s) => s.refresh);
  const connectWorker = useWorkerStore((s) => s.connect);
  const disconnectWorker = useWorkerStore((s) => s.disconnect);
  useEffect(() => { void refreshWorkers(); }, [refreshWorkers]);

  /* The six worker slots: the saved arrangement resolved against the
     live roster. WHICH workers occupy them comes only from the layout;
     their state comes only from the backend's verdict, and an unread
     roster reads as unknown rather than as absence. */
  const workerSlots = useMemo(
    () => deriveWorkerSlots(workerIds, workers),
    [workerIds, workers],
  );

  const projectPath = useMemo(
    () => projects.find((p) => p.id === projectId)?.path ?? null,
    [projects, projectId],
  );

  // ONE conversation, owned above both panels: the composer lives in the
  // rail, the run it starts renders in the workspace. Same client, same
  // session — lifted only so the two halves cannot disagree.
  // Which management surface is open, if any. Opening one costs nothing:
  // the worker roster and the machine inventory are already loaded, so
  // neither entry point triggers a scan.
  const [surface, setSurface] = useState<'none' | 'worker' | 'tool'>('none');

  /* Which slot the open tool surface is replacing, if any. This is the
     whole of the replace flow's state: a slot index, held only while the
     surface is open. Null means the surface was opened from an empty
     slot and the next choice fills it instead of swapping. */
  const [replacingSlot, setReplacingSlot] = useState<number | null>(null);

  /* Which worker slot the open worker surface will fill. Null means it
     was opened from the rail's own button rather than from a slot, and
     the choice lands in the first free slot. */
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

  /* Opening the worker surface costs nothing: the roster is already
     loaded, so no scan, no probe and no connection attempt happens
     because a slot was clicked. */
  const openWorkerSurface = useCallback((slotIndex: number | null) => {
    setWorkerSlotIndex(slotIndex);
    setSurface('worker');
  }, []);

  /* The worker slot the surface will fill, named so it can say what it
     is about to displace. */
  const workerSlotContext = useMemo(() => {
    if (workerSlotIndex === null) return null;
    const slot = workerSlots[workerSlotIndex];
    return { index: workerSlotIndex, name: slot?.workerId ? slot.worker?.name ?? slot.workerId : null };
  }, [workerSlotIndex, workerSlots]);

  /* What the open surface is replacing, named so it can say so. The name
     comes from the catalogue entry when the id still resolves; otherwise
     the raw id, which is the honest thing to show for a tool AURA no
     longer knows. */
  const replacing = useMemo(() => {
    if (replacingSlot === null) return null;
    const slot = toolSlots[replacingSlot];
    if (!slot?.nodeId) return null;
    return { index: replacingSlot, name: slot.node?.entry.name ?? slot.nodeId };
  }, [replacingSlot, toolSlots]);

  /* ── the one conversation ─────────────────────────────────────────
     The existing project Ask AURA engine, unchanged: it owns the
     transcript, the Central Agent session and the single SSE
     subscription. Pointing it at the active project (or at none) is
     the only wiring this screen does. */
  const conv = useAgentConversations();
  useEffect(() => {
    void conv.loadForProject(projectId, projectPath);
  }, [projectId, projectPath]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Live worker highlight for the graph, from the frames the
     conversation already receives. No second subscription. */
  const workerActivity = useMemo(
    () => new Map(Object.entries(conv.activity.workers)),
    [conv.activity.workers],
  );

  /* Pending approvals, read from the existing ledger by id. A parked
     message names its approval; this resolves that id to the real
     request so the existing gate can render it. Never guessed: an id
     with no match stays null and the gate is not shown. */
  const [approvals, setApprovals] = useState<Record<string, ApprovalRequest | null>>({});
  const [deciding, setDeciding] = useState(false);
  const parkedIds = useMemo(
    () => conv.messages.map((m) => m.agent?.approvalId).filter((x): x is string => !!x),
    [conv.messages],
  );
  useEffect(() => {
    const missing = parkedIds.filter((id) => approvals[id] === undefined);
    if (!missing.length) return;
    let cancelled = false;
    setApprovals((prev) => {
      const next = { ...prev };
      for (const id of missing) next[id] = null;
      return next;
    });
    void fabricClient.approvals().then(({ approvals: list }) => {
      if (cancelled) return;
      setApprovals((prev) => {
        const next = { ...prev };
        for (const id of missing) next[id] = list.find((a) => a.id === id) ?? null;
        return next;
      });
    }).catch(() => { /* the gate stays unrendered rather than guessing */ });
    return () => { cancelled = true; };
  }, [parkedIds, approvals]);

  const decide = useCallback(async (messageId: string, granted: boolean, reason?: string) => {
    setDeciding(true);
    try { await conv.decide(messageId, granted, reason); }
    finally { setDeciding(false); }
  }, [conv]);

  /* The graph's status line: what AURA is doing, in the same words the
     conversation uses. One vocabulary, two places. */
  const agentPhase = conv.activity.phase
    ?? (conv.phase === 'working' ? 'Working' : 'Ready when you are');

  return (
    <div ref={canvasRef} className="relative h-full min-h-0">
      <WorkspaceShell
        left={
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
          />
        }
        right={
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
            projectName={projects.find((p) => p.id === projectId)?.name ?? null}
          />
        }
      />
      {/* Catalogue dialog mounts alongside so placing a node never unmounts the shell. */}
      {surface !== 'none' && (
        <div
          className="absolute inset-0 z-30 flex items-stretch justify-end bg-[rgba(4,7,14,0.72)] p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={surface === 'worker' ? 'Add AI Worker' : 'AURA Everything'}
          onClick={(e) => { if (e.target === e.currentTarget) closeSurface(); }}
        >
          <div className="flex w-full max-w-[560px] min-h-0 flex-col rounded-2xl border border-[rgba(125,146,255,0.3)] bg-[rgba(9,13,26,0.97)] p-4 shadow-card">
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
                  // Layout only. The chosen id is the backend's own worker
                  // id, so the slot's status still comes from the next
                  // answer `GET /workers` gives about it — placing proves
                  // nothing and claims nothing.
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
                  // Layout only, on both paths. The result already carries a
                  // catalogue id, which is the same identity the environment
                  // scanner probes — nothing new is discovered, installed or
                  // run, and the slot's status still comes from the next
                  // answer the environment gives about that id.
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

      <AddNodeDialog open={adding} onClose={() => setAdding(false)} />
      <NodeWindows canvasRef={canvasRef} />
      <WindowTray />
    </div>
  );
}

/* ── Floating node inspectors ───────────────────────────────────────
   Same proven surface as ConnectedEnvironment: clicking a capability
   opens its live inspector (probe state, connect, permissions) above the
   shell. Windows are working surfaces — closing one never removes the
   capability. Copied contract, not a second implementation. */

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
