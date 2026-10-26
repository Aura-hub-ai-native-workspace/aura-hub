/**
 * workspaceProject — which folder a workspace conversation works in.
 *
 * Delegated worker runs need a project directory. A workspace chat is keyed
 * by its workspace id, which is not always a project id (the "home"
 * workspace is not one). When that id matches no project, the project the
 * person has open is the one the work belongs to. Without this fallback the
 * run started with no folder, and every worker dispatch failed with "No
 * project directory is set" — which the UI reported honestly, but which
 * should never have happened with a project open.
 */
export interface ProjectRef {
  id: string;
  path: string;
}

export function resolveWorkspaceProjectPath(
  projects: readonly ProjectRef[],
  workspaceProjectId: string | null,
  activeProjectId: string | null,
): string | null {
  const byId = (id: string | null) =>
    id ? projects.find((p) => p.id === id) ?? null : null;
  return (byId(workspaceProjectId) ?? byId(activeProjectId))?.path ?? null;
}
