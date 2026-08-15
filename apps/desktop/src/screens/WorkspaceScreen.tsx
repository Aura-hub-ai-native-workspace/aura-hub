/**
 * WorkspaceScreen — AURA's execution environment.
 * ------------------------------------------------------------------
 * One Hub at the centre, capability nodes around it, live measured state.
 * See docs/WORKSPACE_EXECUTION_ARCHITECTURE.md.
 *
 * What this screen is *not*: it is not a workflow builder. Edges run from
 * the Hub to capabilities it can reach; you cannot wire node to node,
 * because execution order is decided by the mission DAG (Mission Control
 * v3), never by dragging. It is also not a second source of truth —
 * every status shown comes from `environmentStore`, whose values are real
 * probes of this machine, and nothing here caches them across a restart.
 *
 * Clicking a node opens a floating **inspection** window. Windows are not
 * nodes: closing one never removes the capability, and the canvas stays
 * visible behind it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useAppStore } from '@aura/core';
import { Icon } from '@aura/ui';
import { useEnvironmentStore } from '../environment/environmentStore';
import { useWindowManager } from '../environment/windows/windowManager';
import { FloatingSurface } from '../environment/windows/FloatingSurface';
import { NodeInspector } from '../environment/NodeInspector';
import { CATEGORY_ICON, STATUS_TONE, TONE_DOT } from '../environment/presentation';
import { fabricClient, type MissionCapabilityAnnotation } from '../ai/fabricClient';
import { useWorkspace } from '../data/useWorkspace';
import { useMissions } from './missions/useMissions';
import { HubCanvas } from '../workspace/HubCanvas';
import { HubSurface, readinessOf } from '../workspace/HubSurface';
import { AddNodeDialog } from '../workspace/AddNodeDialog';
import {
  buildCapabilityNodeMap,
  deriveHubPhase,
  missingNodesFor,
  projectNodeActivity,
  type CapabilityNodeMap,
} from '../workspace/hubPhase';
import { useHubStore } from '../workspace/hubStore';
import { WorkspaceWindowLayer } from '../ops/WorkspaceCanvas';

export function WorkspaceScreen() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);

  const placed = useHubStore((s) => s.placed);
  const relayout = useHubStore((s) => s.relayout);
  const remove = useHubStore((s) => s.remove);

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
  const [capabilityToNode, setCapabilityToNode] = useState<CapabilityNodeMap>(() => new Map());

  useEffect(() => { void refreshProjects(); }, [refreshProjects]);

  // The capability→node mapping, read from the running service so it can
  // never disagree with the Fabric that will actually execute.
  useEffect(() => {
    let cancelled = false;
    void fabricClient.capabilities()
      .then((res) => { if (!cancelled) setCapabilityToNode(buildCapabilityNodeMap(res.capabilities)); })
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

  const selectProject = useCallback((id: string) => {
    setActiveProject(id || null);
    setAnnotation(null);
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

  // Once execution is running, keep pulling waves so the canvas reflects
  // real progress rather than a single frozen snapshot.
  useEffect(() => {
    if (active?.execution?.status === 'running' && !m.batchBusy) void runBatch();
  }, [active?.execution?.status, active?.execution?.batchIndex, m.batchBusy, runBatch]);

  const canvasNodes = useMemo(
    () => placed.map((p) => ({ placed: p, node: envNodes.find((n) => n.id === p.nodeId) ?? null })),
    [placed, envNodes],
  );

  const placedNodes = useMemo(
    () => canvasNodes.map((c) => c.node).filter((n): n is NonNullable<typeof n> => !!n),
    [canvasNodes],
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
    <div className="relative flex h-full min-h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-surface/40 px-5 py-2.5 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="spark" size={15} className="shrink-0 text-accent" />
          <span className="truncate text-[13px] font-semibold text-text">Workspace</span>
          <span className="truncate text-[11.5px] text-text-subtle">
            {placed.length} {placed.length === 1 ? 'capability' : 'capabilities'} around the Hub
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <HeaderButton icon="refresh" label="Re-arrange" onClick={relayout} />
          <HeaderButton icon="plus" label="Add node" onClick={() => setAdding(true)} testId="add-node-open" />
        </div>
      </header>

      <div ref={canvasRef} className="relative min-h-0 flex-1 overflow-hidden">
        <HubCanvas
          nodes={canvasNodes}
          canvasRef={canvasRef}
          onInspect={openWindow}
          activity={activity}
          hub={
            <HubSurface
              readiness={readiness}
              scanning={scanning}
              lastScanAt={lastScanAt}
              onScan={() => void scan(true)}
              projects={projects}
              projectId={projectId}
              onSelectProject={selectProject}
              progress={progress}
              mission={active}
              missing={missing}
              unattributed={projection.unattributed}
              error={errorText}
              onSubmit={(text) => void createMission(text)}
              onApprove={() => void approve()}
              onStart={() => void startExecution()}
            />
          }
        />

        <NodeWindows canvasRef={canvasRef} onRemove={remove} />

        {/* The Workspace's panel windows — Mission Control, Knowledge,
            Diagnostics and the rest. `layoutStore.openPanel()` has always
            been wired to roughly nineteen command-palette entries, but the
            component that renders those windows was mounted by nothing, so
            every one of them silently did nothing (Audit Defect #1). This
            mounts the EXISTING renderer; no panel was rebuilt. */}
        <WorkspaceWindowLayer canvasRef={canvasRef} />

        {placed.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-8 grid place-items-center">
            <p className="pointer-events-auto rounded-xl border border-dashed border-line bg-surface/80 px-4 py-2 text-[12px] text-text-muted">
              No capabilities placed yet — use <span className="font-medium text-text">Add node</span>.
            </p>
          </div>
        )}
      </div>

      <AddNodeDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function HeaderButton({
  icon,
  label,
  onClick,
  testId,
}: {
  icon: 'refresh' | 'plus';
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[11.5px] font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
    >
      <Icon name={icon} size={13} />
      {label}
    </button>
  );
}

/**
 * Inspection windows over placed nodes. This reuses the Connected
 * Environment's generic window manager (keyed by an opaque `contentId`)
 * rather than the Workspace's older `PanelKind`-bound one — that manager
 * is the intended survivor of the two, per its own note.
 */
function NodeWindows({
  canvasRef,
  onRemove,
}: {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  onRemove: (nodeId: string) => void;
}) {
  const windows = useWindowManager((s) => s.windows);
  const close = useWindowManager((s) => s.close);
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
        return (
          <FloatingSurface
            key={win.id}
            window={win}
            canvasRef={canvasRef}
            title={node.entry.name}
            icon={CATEGORY_ICON[node.entry.category]}
            subtitle={node.health.version}
            toneClass={TONE_DOT[STATUS_TONE[node.health.status]]}
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto">
                <NodeInspector
                  node={node}
                  busy={busy.includes(node.id)}
                  onConnect={() => void connect(node.id)}
                  onDisconnect={() => disconnect(node.id)}
                  onPermissions={(partial) => setNodePermissions(node.id, partial)}
                />
              </div>
              <div className="shrink-0 border-t border-line px-3 py-2">
                <button
                  onClick={() => {
                    onRemove(node.id);
                    close(win.id);
                  }}
                  className="text-[11px] font-medium text-text-subtle transition-colors hover:text-danger"
                >
                  Remove from workspace
                </button>
              </div>
            </div>
          </FloatingSurface>
        );
      })}
    </AnimatePresence>
  );
}
