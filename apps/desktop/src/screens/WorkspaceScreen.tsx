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
 * Clicking a node opens a floating inspection window. Windows are not
 * nodes: closing one never removes the capability, and the canvas stays
 * visible behind it.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAppStore } from '@aura/core';
import { Icon, IconButton, Tooltip } from '@aura/ui';
import { useEnvironmentStore } from '../environment/environmentStore';
import { useWindowManager } from '../environment/windows/windowManager';
import { useWorkspace } from '../data/useWorkspace';
import { useMissions } from './missions/useMissions';
import { HubCanvas } from '../workspace/HubCanvas';
import { HubSurface, readinessOf } from '../workspace/HubSurface';
import { useHubStore } from '../workspace/hubStore';
import { fabricClient, type MissionCapabilityAnnotation } from '../ai/fabricClient';
import { WorkspaceToolbar } from '../shell/WorkspaceToolbar';
import { BottomInfoPanel } from '../shell/BottomInfoPanel';
import { useEnvironmentSummary } from '../environment/environmentStore';
import { WorkflowTimeline } from './workflows/WorkflowTimeline';
import { deriveHubPhase, missingNodesFor, projectNodeActivity } from '../workspace/hubPhase';

export function WorkspaceScreen() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

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

  const envSummary = useEnvironmentSummary();

  return (
    <div className="relative flex h-full min-h-full flex-col">
      {/* ── 1. Workspace Toolbar / Top Header ───────────────────────── */}
      <WorkspaceToolbar
        onRelayout={relayout}
        onAddNode={() => void relayout()}
        onSelectProject={selectProject}
        projects={projects}
        projectId={projectId}
        viewMode={viewMode}
        setViewMode={setViewMode}
      />

      {/* ── 2. Main content area ───────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col">
          {/* ── A. Central AURA Agent Workspace ───────────────────── */}
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
              viewMode={viewMode as 'grid' | 'list'}
            />

          {/* ── B. Workflow Timeline ───────────────────────────────── */}
          <WorkflowTimeline
            active={active}
            progress={progress}
          />

          {/* ── C. Capability Nodes Graph ──────────────────────────── */}
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
        </div>
      </div>

      {/* ── 3. Bottom Information Panel ───────────────────────────── */}
      <BottomInfoPanel
        envSummary={envSummary}
        onScanEnvironment={() => void scan(true)}
        activeProjectId={projectId}
        projects={projects}
      />
    </div>
  );
}