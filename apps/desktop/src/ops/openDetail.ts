/**
 * openProjectDetail — the one way to open a detail panel for an entity.
 * ------------------------------------------------------------------
 * Notifications, memory records and search hits all reference an entity
 * (a mission, a diagnosis) that may belong to a project other than the
 * active one. Each of them used to handle that by writing the entity's
 * project into `layoutStore.focused.projectId`, which panels then read in
 * preference to the active project — so the shell showed project A while a
 * floating panel silently showed project B.
 *
 * The Workspace has ONE project scope. So reaching another project's
 * detail is a deliberate project switch, not a private scope on a panel:
 *
 *   switch the active project  →  focus the entity  →  open the panel
 *
 * Order matters, and is the reason this is a shared function rather than
 * three call sites agreeing to be careful:
 *
 *   • The switch must come FIRST. `WorkspaceWindowLayer` retires open
 *     windows when the active project changes, so opening the panel before
 *     switching would open it and immediately close it again.
 *   • If the switch is DECLINED — the user keeps unsaved Code Workspace
 *     changes — nothing else happens. No focus is set and no panel opens,
 *     so a refused switch cannot leave a panel pointing at a project the
 *     user chose not to move to.
 *
 * This adds no store and no project pointer. It reads and writes the
 * existing authorities only.
 */

import { useAppStore } from '@aura/core';
import { useLayoutStore, type DetailFocus, type PanelKind } from './layoutStore';
import { hasUnsavedWorkFor } from '../editor/editorStore';

export interface OpenDetailRequest {
  /**
   * The project the entity belongs to. Null/undefined means "the active
   * project" — the caller is already in scope and no switch is needed.
   */
  projectId?: string | null;
  /** Which entity to focus. Project scope is never part of this. */
  focus: Partial<DetailFocus>;
  panel: PanelKind;
  /** Called after a successful switch+focus, for callers that navigate. */
  onOpened?: () => void;
}

/**
 * Returns true when the detail was opened, false when the required project
 * switch was declined and nothing was changed.
 */
export function openProjectDetail({ projectId, focus, panel, onOpened }: OpenDetailRequest): boolean {
  const app = useAppStore.getState();
  const layout = useLayoutStore.getState();

  if (projectId && projectId !== app.activeProjectId) {
    // Same confirmation the search surface has always used before moving
    // the user off a project with unsaved editor work.
    if (hasUnsavedWorkFor(app.activeProjectId ?? '')
      && !window.confirm('You have unsaved changes in the current project\'s Code Workspace. Switch projects anyway?')) {
      return false;
    }
    // `setActiveProject` moves the ONE canonical pointer without forcing a
    // navigation — the caller decides where the user should end up.
    app.setActiveProject(projectId);
  }

  layout.setFocused({
    // A new focus replaces the previous one outright. Merging would leave
    // the last project's mission id sitting under the new project's panel.
    missionId: focus.missionId ?? null,
    diagnosisId: focus.diagnosisId ?? null,
  });
  layout.openPanel(panel);
  onOpened?.();
  return true;
}
