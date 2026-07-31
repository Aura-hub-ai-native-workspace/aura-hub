/**
 * WorkspaceScreen — the Engineering Operating Environment's home.
 * ------------------------------------------------------------------
 * The dockable multi-panel workspace (ops/PanelWorkspace) as a full
 * fixed-viewport screen. Reached from the Workspace nav item; the
 * workspace restores your last layout and session on relaunch.
 */
import { PanelWorkspace } from '../ops/PanelWorkspace';

export function WorkspaceScreen() {
  return (
    <div className="h-full min-h-full">
      <PanelWorkspace />
    </div>
  );
}
