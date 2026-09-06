/**
 * WorkspaceScreen — AURA's AI-native engineering workspace.
 * ------------------------------------------------------------------
 * One AURA Agent at the centre, capability nodes around it, workflow
 * timeline, and bottom information panel.
 *
 * What this screen is: an AI-native engineering control center that
 * visualizes the core capabilities of AURA Hub, shows live agent
 * collaboration, and provides a prompt-driven interface for mission
 * planning and execution.
 *
 * What this screen is not: it is not a workflow builder. Edges run from
 * the Hub to capabilities it can reach; you cannot wire node to node,
 * because execution order is decided by the mission DAG (Mission Control
 * v3), never by dragging. It is also not a second source of truth —
 * every status shown comes from `environmentStore`, whose values are real
 * probes of this machine, and nothing here caches them across a restart.
 *
 * Presentation lives in `screens/workspace/neon/` (WorkspaceShell,
 * LeftControlPanel, TimelineContainer). Every prop below is the same
 * authority the legacy Hub/canvas read — only the layout changed.
 */
import { useEffect, useMemo, useRef, useState, useCallback, type RefObject } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring, useAppStore } from '@aura/core';
import { Icon } from '@aura/ui';
import { useEnvironmentStore } from '../environment/environmentStore';
import { useWorkspace } from '../data/useWorkspace';
import { useMissions } from './missions/useMissions';
import { useHubStore } from '../workspace/hubStore';
import { fabricClient, type MissionCapabilityAnnotation } from '../ai/fabricClient';
import { AddNodeDialog } from '../workspace/AddNodeDialog';
import { NodeInspector } from '../environment/NodeInspector';
import { FloatingSurface } from '../environment/windows/FloatingSurface';
import { useWindowManager } from '../environment/windows/windowManager';
import { CATEGORY_ICON, STATUS_TONE, TONE_DOT } from '../environment/presentation';
import { deriveHubPhase, missingNodesFor, projectNodeActivity, readinessOf } from '../workspace/hubPhase';
import { WorkspaceShell } from './workspace/neon/WorkspaceShell';
import { LeftControlPanel } from './workspace/neon/LeftControlPanel';
import { TimelineContainer } from './workspace/neon/TimelineContainer';

export function WorkspaceScreen() {
  const [adding, setAdding] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const placed = useHubStore((s) => s.placed);
  const relayout = useHubStore((s) => s.relayout);

  const envNodes = useEnvironmentStore((s) => s.nodes);
  const scanning = useEnvironmentStore((s) => s.scanning);
  const lastScanAt = useEnvironmentStore((s) => s.lastScanAt);
  const scan = useEnvironmentStore((s) => s.scan);
  const openWindow = useWindowManager((s) => s.open);

  /* ── Mission wiring ──────────────────────────────────────────────
     Missions plan against real files, so they are project-scoped. The Hub
     is global, and it now reads the SHELL's active project rather than
     remembering its own — the Hub used to keep a private
     `aura.workspace.projectId` because navigating here cleared
     `activeProjectId`. Now that the active project survives navigation,
     that second pointer is gone and the Hub and the rest of the shell can
     no longer disagree about which project is being worked on. */
  const projects = useWorkspace((s) => s.projects);
  const refreshProjects = useWorkspace((s) => s.refresh);
  const projectId = useAppStore((s) => s.activeProjectId);
  const setActiveProject = useAppStore((s) => s.setActiveProject);

  // The entire mission lifecycle, reused as-is. No second engine.
  const m = useMissions(projectId);
  const { active, creation, approvals, createMission, approve, startExecution, runBatch } = m;

  const [annotation, setAnnotation] = useState<MissionCapabilityAnnotation | null>(null);
  const [capabilityToNode, setCapabilityToNode] = useState<Map<string, string>>(() => new Map());

  useEffect(() => { void refreshProjects(); }, [refreshProjects]);

  // The capability→node mapping, read from the running service so it can
  // never disagree with the Fabric that will actually execute.
  useEffect(() => {
    let cancelled = false;
    void fabricClient.capabilities()
      .then((res) => {
        if (!cancelled) {
          const map = new Map<string, string>();
          res.capabilities.forEach((c) => map.set(c.id, c.id));
          setCapabilityToNode(map);
        }
      })
      .catch(() => { /* service unreachable — nodes simply show no activity */ });
    return () => { cancelled = true; };
  }, []);

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

  /* What the plan actually needs, read from the Fabric's existing
     annotation route. Re-read whenever the plan changes. */
  useEffect(() => {
    if (!projectId || !active?.goalGraph) { setAnnotation(null); return; }
    let cancelled = false;
    void fabricClient.missionCapabilities(projectId, active.id).then((res) => {
      if (cancelled) return;
      setAnnotation('error' in res ? null : res);
    }).catch(() => { if (!cancelled) setAnnotation(null); });
    return () => { cancelled = true; };
  }, [projectId, active?.id, active?.goalGraph]);

  // Once execution is running, keep pulling waves so the timeline reflects
  // real progress rather than a single frozen snapshot.
  useEffect(() => {
    if (active?.execution?.status === 'running' && !m.batchBusy) void runBatch();
  }, [active?.execution?.status, active?.execution?.batchIndex, m.batchBusy, runBatch]);

  const placedNodes = useMemo(
    () => placed.map((p) => envNodes.find((n) => n.id === p.nodeId) ?? null).filter((n): n is NonNullable<typeof n> => !!n),
    [placed, envNodes],
  );

  /* The Fabric's approval queue is global. Only the requests raised by
     THIS mission may speak for it — otherwise an unrelated mission's gate
     would make the Hub claim this one is waiting on the user. */
  const missionApprovals = useMemo(
    () => (active ? approvals.filter((a) => a.missionId === active.id) : []),
    [approvals, active],
  );

  const progress = useMemo(
    () => deriveHubPhase(creation, active, annotation, missionApprovals),
    [creation, active, annotation, missionApprovals],
  );

  const projection = useMemo(
    () => projectNodeActivity(active, annotation, placedNodes, missionApprovals, capabilityToNode),
    [active, annotation, placedNodes, missionApprovals, capabilityToNode],
  );
  const activity = projection.byNode;

  const missing = useMemo(
    () => missingNodesFor(annotation, placedNodes, capabilityToNode),
    [annotation, placedNodes, capabilityToNode],
  );

  /* Both failure channels reach the user. `useMissions` reports action
     failures through `error`, but a planning failure arrives as a stream
     event and only lands in `creation.errorMessage` — without this, a
     mission that could not be planned would show a phase and no reason. */
  const errorText =
    m.error ?? (creation.stage === 'error' ? creation.errorMessage : null) ?? active?.error ?? null;

  // Readiness reflects the nodes actually in this workspace, not all 110
  // catalogue entries — otherwise the count would describe a machine the
  // user never asked about.
  const readiness = useMemo(() => readinessOf(placedNodes), [placedNodes]);

  return (
    <div ref={canvasRef} className="relative h-full min-h-0">
      <WorkspaceShell
        left={
          <LeftControlPanel
            nodes={placedNodes}
            scanning={scanning}
            readiness={readiness}
            lastScanAt={lastScanAt}
            gaps={missing}
            projects={projects}
            projectId={projectId}
            onSelectProject={selectProject}
            progress={progress}
            mission={active}
            error={errorText}
            onSubmit={(text) => void createMission(text)}
            onApprove={() => void approve()}
            onStart={() => void startExecution()}
            onScan={() => void scan(true)}
            onAddNode={() => setAdding(true)}
            onRelayout={relayout}
            activity={activity}
            onInspect={openWindow}
          />
        }
        right={
          <TimelineContainer
            active={active}
            creation={creation}
            progress={progress}
            projects={projects}
            projectId={projectId}
            onSelectProject={selectProject}
            busy={progress.busy && !active}
            error={errorText}
          />
        }
      />
      {/* Catalogue dialog mounts alongside so placing a node never unmounts the shell. */}
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
