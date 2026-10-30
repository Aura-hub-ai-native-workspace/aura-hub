import { Suspense, lazy } from 'react';
import type { ProjectTab } from '@aura/core';
import { Overview } from './Overview';
import { Context } from './Context';
import { Architecture } from './Architecture';

/**
 * The Code Workspace pulls in Monaco (~2MB) — code-split so every other
 * tab's bundle stays untouched. `CodeWorkspaceLoading` mirrors the real
 * layout's chrome so the swap-in on load never causes a layout jump.
 */
const EditorWorkspace = lazy(() =>
  import('../../../editor/EditorWorkspace').then((m) => ({ default: m.EditorWorkspace })),
);

/**
 * Maps a project tab to its section. Each section is a self-contained
 * environment derived from the project's real folder (see shared.tsx: there is no sample data). Adding a section
 * is one entry here plus one PROJECT_TABS entry — a clean extension point.
 */
export function ProjectSection({ tab, projectId }: { tab: ProjectTab; projectId: string }) {
  switch (tab) {
    case 'overview': return <Overview projectId={projectId} />;
    case 'context': return <Context projectId={projectId} />;
    case 'architecture': return <Architecture projectId={projectId} />;
    case 'code':
      return (
        <Suspense fallback={<CodeWorkspaceLoading />}>
          <EditorWorkspace projectId={projectId} />
        </Suspense>
      );
    default: return <Overview projectId={projectId} />;
  }
}

/** Skeleton chrome shown while the Monaco bundle streams in. */
function CodeWorkspaceLoading() {
  return (
    <div className="flex h-full w-full divide-x divide-line">
      <div className="hidden w-60 shrink-0 animate-pulse bg-surface/60 sm:block" />
      <div className="flex-1 animate-pulse bg-canvas" />
      <div className="hidden w-72 shrink-0 animate-pulse bg-surface/60 lg:block" />
    </div>
  );
}
