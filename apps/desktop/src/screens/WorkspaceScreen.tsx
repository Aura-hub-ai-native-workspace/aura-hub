/**
 * WorkspaceScreen — the Engineering Operating Environment's home.
 * ------------------------------------------------------------------
 * Two areas, side by side: the Tools shelf (ops/ToolsRail) launches
 * panels as windows; the dockable multi-panel canvas (ops/PanelWorkspace)
 * arranges them. Reached from the Workspace nav item; the workspace
 * restores your last layout and session on relaunch.
 */
import { PanelWorkspace } from '../ops/PanelWorkspace';
import { ToolsRail } from '../ops/ToolsRail';
import { useLayoutStore } from '../ops/layoutStore';

export function WorkspaceScreen() {
  const openPanel = useLayoutStore((s) => s.openPanel);

  return (
    <div className="flex h-full min-h-full">
      <ToolsRail onLaunch={(kind) => openPanel(kind)} />
      <div className="min-w-0 flex-1">
        <PanelWorkspace />
      </div>
    </div>
  );
}
