import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cn, type Command } from '@aura/core';
import { CommandPalette, IconButton, useHotkey } from '@aura/ui';
import { useWorkspace } from '../data/useWorkspace';
import type { ActionKind } from '../ai/aiClient';
import { useEditorStore } from './editorStore';
import { ExplorerPanel } from './ExplorerPanel';
import { EditorTabs } from './EditorTabs';
import { EditorView } from './EditorView';
import { BottomPanel } from './BottomPanel';
import { AIContextPanel } from './AIContextPanel';
import { EmptyState } from '../components/EmptyState';
import { ACTION_SPECS, actionSpec, type WorkspaceActionId } from './actionSpecs';
import { useAiAction } from './useAiAction';
import { useDiagnosis } from './useDiagnosis';
import { contextForSelection } from './aiContext';
import { useProjectData } from '../screens/project/sections/shared';
import { AIActionDialog } from './AIActionDialog';
import { DiagnosisPanel } from './DiagnosisPanel';
import { TextPromptDialog } from './TextPromptDialog';

/**
 * EditorWorkspace — AURA's Code Workspace root.
 *
 *   ┌──────────┬──────────────────────────────┬──────────────┐
 *   │ Explorer │ Tabs                         │ AI Context   │
 *   │ (Search/ │ ├──────────────────────────┤ │ (project /   │
 *   │ Bookmarks│ │ Breadcrumb                │ │  file / lang │
 *   │ /Git/    │ │ Monaco                    │ │  / cursor /  │
 *   │ Knowledge│ │                           │ │  selection)  │
 *   │  rail)   │ ├──────────────────────────┤ │              │
 *   │          │ │ Bottom Panel (Terminal…) │ │              │
 *   └──────────┴──────────────────────────────┴──────────────┘
 *
 * Independent of Knowledge Fabric indexing — it reads/writes real files
 * directly, so it's usable the instant a project is open. See
 * ProjectWorkspace.tsx for the indexing-gate bypass and full-bleed
 * layout this depends on.
 */
export function EditorWorkspace({ projectId }: { projectId: string }) {
  const project = useWorkspace((s) => s.projects.find((p) => p.id === projectId));
  const init = useEditorStore((s) => s.init);
  const desktopAvailable = useEditorStore((s) => s.desktopAvailable);
  const explorerOpen = useEditorStore((s) => s.explorerOpen);
  const explorerWidth = useEditorStore((s) => s.explorerWidth);
  const setExplorerWidth = useEditorStore((s) => s.setExplorerWidth);
  const aiPanelOpen = useEditorStore((s) => s.aiPanelOpen);
  const aiPanelWidth = useEditorStore((s) => s.aiPanelWidth);
  const setAiPanelWidth = useEditorStore((s) => s.setAiPanelWidth);
  const toggleExplorer = useEditorStore((s) => s.toggleExplorer);
  const toggleAiPanel = useEditorStore((s) => s.toggleAiPanel);
  const activePath = useEditorStore((s) => s.activePath);
  const openFiles = useEditorStore((s) => s.openFiles);

  const aiAction = useAiAction(projectId);
  const diagnosis = useDiagnosis(projectId);
  const { graph } = useProjectData(projectId);
  const [auraPaletteOpen, setAuraPaletteOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<ActionKind | null>(null);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);

  useHotkey(
    'i',
    () => {
      if (useEditorStore.getState().activePath) setAuraPaletteOpen(true);
    },
    { meta: true, allowInInput: true },
  );

  const handleAction = (id: WorkspaceActionId) => {
    setAuraPaletteOpen(false);
    if (id === 'diagnose') {
      setDiagnosisOpen(true);
      void diagnosis.run();
      return;
    }
    if (actionSpec(id).needsInput) {
      setPendingPrompt(id);
    } else {
      void aiAction.run(id);
    }
  };

  const auraCommands: Command[] = ACTION_SPECS.map((spec) => ({
    id: `aura-action-${spec.id}`,
    title: spec.paletteLabel,
    section: 'AURA',
    icon: spec.icon,
    run: () => handleAction(spec.id),
  }));

  const renameDefault = useMemo(() => {
    if (pendingPrompt !== 'rename' || !activePath) return '';
    const file = openFiles[activePath];
    if (!file) return '';
    return contextForSelection(graph, activePath, file.cursor.line).symbol?.name ?? '';
  }, [pendingPrompt, activePath, openFiles, graph]);

  useEffect(() => {
    if (project) void init(project.id, project.path);
    // Depend on primitives, not the derived `project` object — `.find()`
    // returns a fresh-enough reference on unrelated store updates that
    // depending on the object itself would re-init more than intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.path, init]);

  if (!project) return null;

  if (desktopAvailable === false) {
    return (
      <div className="grid h-full place-items-center p-10">
        <EmptyState
          icon="code"
          title="Desktop file access required"
          description="The Code Workspace reads and writes real files on disk, which only the native app can do. Run `npm run tauri dev` to edit real files here."
          compact
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      {explorerOpen && (
        <ResizablePane width={explorerWidth} onResize={setExplorerWidth} edge="right">
          <ExplorerPanel />
        </ResizablePane>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center border-b border-line bg-surface/40">
          <IconButton
            icon="sidebar"
            label={explorerOpen ? 'Hide Explorer' : 'Show Explorer'}
            size="sm"
            active={explorerOpen}
            onClick={toggleExplorer}
            className="ml-1 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <EditorTabs />
          </div>
          <IconButton
            icon="panel"
            label={aiPanelOpen ? 'Hide AI Context' : 'Show AI Context'}
            size="sm"
            active={aiPanelOpen}
            onClick={toggleAiPanel}
            className="mr-1 shrink-0"
          />
        </div>

        <div className="min-h-0 flex-1">
          <EditorView projectName={project.name} onAction={handleAction} onOpenPalette={() => setAuraPaletteOpen(true)} />
        </div>

        <BottomPanel />
      </div>

      {aiPanelOpen && (
        <ResizablePane width={aiPanelWidth} onResize={setAiPanelWidth} edge="left">
          <AIContextPanel projectName={project.name} projectId={project.id} />
        </ResizablePane>
      )}

      <CommandPalette
        open={auraPaletteOpen}
        onClose={() => setAuraPaletteOpen(false)}
        commands={auraCommands}
        placeholder="Ask AURA to explain, refactor, optimize…"
      />
      <AIActionDialog aiAction={aiAction} />
      <DiagnosisPanel open={diagnosisOpen} onClose={() => setDiagnosisOpen(false)} diagnosis={diagnosis} />
      <TextPromptDialog
        open={pendingPrompt !== null}
        spec={pendingPrompt ? actionSpec(pendingPrompt) : null}
        defaultValue={renameDefault}
        onClose={() => setPendingPrompt(null)}
        onSubmit={(value) => {
          const action = pendingPrompt;
          setPendingPrompt(null);
          if (action) void aiAction.run(action, value);
        }}
      />
    </div>
  );
}

/** A fixed-width pane with a drag handle on one edge. Used for both side panels. */
function ResizablePane({
  width,
  onResize,
  edge,
  children,
}: {
  width: number;
  onResize: (w: number) => void;
  edge: 'left' | 'right';
  children: ReactNode;
}) {
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  function onDragStart(e: ReactPointerEvent<HTMLDivElement>) {
    dragState.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onDragMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragState.current) return;
    const delta = e.clientX - dragState.current.startX;
    onResize(dragState.current.startWidth + (edge === 'right' ? delta : -delta));
  }
  function onDragEnd() {
    dragState.current = null;
  }

  return (
    <div className="relative flex shrink-0 border-line" style={{ width }}>
      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        className={cn(
          'absolute top-0 h-full w-1 shrink-0 cursor-col-resize hover:bg-accent/30',
          edge === 'right' ? 'right-0 border-r border-line' : 'left-0 border-l border-line',
        )}
      />
    </div>
  );
}
