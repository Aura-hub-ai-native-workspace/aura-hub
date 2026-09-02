/**
 * useActiveProject — the one way to ask "what project are we working on?"
 * ==================================================================
 * Before this hook there were four answers to that question, and nothing
 * reconciled them:
 *
 *   1. `appStore.activeProjectId`            — in memory, nulled by every nav
 *   2. `localStorage['aura.workspace.projectId']` — WorkspaceScreen's private copy
 *   3. `useWorkspace.openId`                 — which project the client last opened
 *   4. `pipeline.currentProjectId` (service) — which project is actually mounted
 *
 * The model now is a single chain with one authority and three derivations:
 *
 *   appStore.activeProjectId  (AUTHORITY — persisted, survives navigation)
 *          │
 *          ├─► useWorkspace.open(id) ──► POST /projects/:id/open
 *          │                                     │
 *          │                             pipeline.currentProjectId
 *          └─► useWorkspace.openId  (mirror of the above)
 *
 * `openId` and the service mount are consequences of the active project, never
 * competing statements of it. This hook is the only thing that drives that
 * chain, so there is exactly one place where the sync can be wrong.
 *
 * Mount it ONCE, high in the tree (AppShell). Reading the active project
 * anywhere else is just `useAppStore((s) => s.activeProjectId)`.
 */

import { useEffect } from 'react';
import { useAppStore } from '@aura/core';
import { useWorkspace } from './useWorkspace';
import type { ProjectRecord } from '../ai/aiClient';

export interface ActiveProject {
  /** The active project id, or null when none is set. */
  id: string | null;
  /** The registry record, once the project list has loaded. */
  record: ProjectRecord | null;
  /**
   * True while the id is set but the record has not been found yet — either
   * the project list is still loading, or the id is dangling. Callers should
   * show a loading state rather than "no project".
   */
  resolving: boolean;
}

/**
 * Keeps the service mount in step with the active project, and prunes an
 * active id that no longer exists.
 *
 * Call this exactly once, from the shell.
 */
export function useActiveProjectSync(): void {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const clearActiveProject = useAppStore((s) => s.clearActiveProject);
  const projects = useWorkspace((s) => s.projects);
  const loading = useWorkspace((s) => s.loading);
  const reachable = useWorkspace((s) => s.reachable);
  const registryReadable = useWorkspace((s) => s.registryReadable);
  const openId = useWorkspace((s) => s.openId);
  const open = useWorkspace((s) => s.open);
  const refresh = useWorkspace((s) => s.refresh);

  // The project list is what makes a persisted id verifiable, so load it once.
  useEffect(() => { void refresh(); }, [refresh]);

  /* Prune a dangling id — a project removed from the registry, or one
     persisted by a previous install. Only ever runs against a list we
     actually received: while `loading`, or when the service is unreachable,
     an empty list means "we don't know yet", NOT "the project is gone".
     Clearing on an unknown would silently drop the user's project whenever
     the service was slow to start. */
  useEffect(() => {
    if (!activeProjectId) return;
    if (loading || reachable !== true) return;
    /* An unreadable registry produces an EMPTY list, not a truthful one.
       Pruning on it would delete the user's active project — and its
       persisted pointer — because a file failed to parse. Absence of
       evidence is not evidence of removal. */
    if (!registryReadable) return;
    if (projects.some((p) => p.id === activeProjectId)) return;
    clearActiveProject();
  }, [activeProjectId, projects, loading, reachable, registryReadable, clearActiveProject]);

  /* Mount the active project service-side. This is the ONLY place that
     drives `open()` from the active-project state, so the mount can never
     drift from the authority. */
  useEffect(() => {
    if (!activeProjectId) return;
    if (openId === activeProjectId) return;
    if (!projects.some((p) => p.id === activeProjectId)) return;
    void open(activeProjectId);
  }, [activeProjectId, openId, projects, open]);
}

/**
 * Read the active project. Safe to call from anywhere; performs no syncing.
 */
export function useActiveProject(): ActiveProject {
  const id = useAppStore((s) => s.activeProjectId);
  const projects = useWorkspace((s) => s.projects);
  const localProjects = useWorkspace((s) => s.localProjects);

  if (!id) return { id: null, record: null, resolving: false };
  const record = projects.find((p) => p.id === id) ?? localProjects.find((p) => p.id === id) ?? null;
  return { id, record, resolving: record === null };
}
