import { Suspense, lazy } from 'react';
import type { ProjectTab } from '@aura/core';
import { Overview } from './Overview';
import { Architecture } from './Architecture';
import { Frontend } from './Frontend';
import { Backend } from './Backend';
import { Database } from './Database';
import { Research } from './Research';
import { Documentation } from './Documentation';
import { Knowledge } from './Knowledge';
import { Intelligence } from './Intelligence';
import { Memory } from './Memory';
import { Tasks } from './Tasks';
import { Deployment } from './Deployment';
import { Settings } from './Settings';

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
 * environment fed by getProjectEnv(projectId) mock data. Adding a section
 * is one entry here plus one PROJECT_TABS entry — a clean extension point.
 */
export function ProjectSection({ tab, projectId }: { tab: ProjectTab; projectId: string }) {
  switch (tab) {
    case 'overview': return <Overview projectId={projectId} />;
    case 'architecture': return <Architecture projectId={projectId} />;
    case 'code':
      return (
        <Suspense fallback={<CodeWorkspaceLoading />}>
          <EditorWorkspace projectId={projectId} />
        </Suspense>
      );
    case 'frontend': return <Frontend projectId={projectId} />;
    case 'backend': return <Backend projectId={projectId} />;
    case 'database': return <Database projectId={projectId} />;
    case 'research': return <Research projectId={projectId} />;
    case 'documentation': return <Documentation projectId={projectId} />;
    case 'knowledge': return <Knowledge projectId={projectId} />;
    case 'intelligence': return <Intelligence projectId={projectId} />;
    case 'memory': return <Memory projectId={projectId} />;
    case 'tasks': return <Tasks projectId={projectId} />;
    case 'deployment': return <Deployment projectId={projectId} />;
    case 'settings': return <Settings projectId={projectId} />;
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
