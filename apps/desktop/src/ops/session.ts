/**
 * session — workspace session persistence (Part 4).
 * ------------------------------------------------------------------
 * On relaunch, AURA restores the state of the whole engineering
 * environment: the selected project, the mission/diagnosis focus, the
 * open editor tabs and the workspace layout (the layout itself persists
 * separately via ops/layoutStore, but session owns project + focus so
 * relaunch lands exactly where you left off).
 *
 * Restore is best-effort: if the backend is down or a project was
 * removed, the environment simply boots clean instead of erroring.
 */
import { useWorkspace } from '../data/useWorkspace';
import { useEditorStore } from '../editor/editorStore';
import { hydrateLayouts, hydratePresets, useLayoutStore, type DetailFocus } from './layoutStore';

const KEY = 'aura.ops.session';

export interface SessionSnapshot {
  projectId: string | null;
  focused: DetailFocus;
  editor: { openOrder: string[]; activePath: string | null };
}

export function saveSession(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const ws = useWorkspace.getState();
    const editor = useEditorStore.getState();
    const layout = useLayoutStore.getState();
    const snapshot: SessionSnapshot = {
      projectId: ws.openId,
      focused: layout.focused,
      editor: { openOrder: editor.openOrder, activePath: editor.activePath },
    };
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    /* session just won't persist */
  }
}

export function hydrateSession(): SessionSnapshot | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : null,
      focused: parsed.focused ?? { projectId: null, missionId: null, diagnosisId: null },
      editor: {
        openOrder: Array.isArray(parsed.editor?.openOrder) ? parsed.editor.openOrder : [],
        activePath: typeof parsed.editor?.activePath === 'string' ? parsed.editor.activePath : null,
      },
    };
  } catch {
    return null;
  }
}

/** Reopen a project and its editor tabs, then restore the focus. */
export async function restoreSession(): Promise<void> {
  const snap = hydrateSession();
  if (!snap) return;

  const layout = useLayoutStore.getState();
  // Restore the saved docked layout + presets (or default for new users).
  if (!layout.root) layout.setRoot(hydrateLayouts());
  const presets = hydratePresets();
  if (Object.keys(presets).length) useLayoutStore.setState({ presets });
  layout.setFocused(snap.focused);

  if (!snap.projectId) return;

  const ws = useWorkspace.getState();
  const project = ws.projects.find((p) => p.id === snap.projectId);
  if (!project) return;

  try {
    await ws.open(snap.projectId);
  } catch {
    return;
  }

  const editor = useEditorStore.getState();
  if (!editor.projectId) {
    await editor.init(snap.projectId, project.path);
  }
  for (const path of snap.editor.openOrder.slice(0, 20)) {
    const name = path.split('/').pop() ?? path;
    try {
      await editor.openFile({ path, name });
    } catch {
      /* file may be gone — skip */
    }
  }
  if (snap.editor.activePath) editor.setActivePath(snap.editor.activePath);
}
