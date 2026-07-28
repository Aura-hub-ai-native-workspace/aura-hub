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
 * Maps a project tab to its section. Each section is a self-contained
 * environment fed by getProjectEnv(projectId) mock data. Adding a section
 * is one entry here plus one PROJECT_TABS entry — a clean extension point.
 */
export function ProjectSection({ tab, projectId }: { tab: ProjectTab; projectId: string }) {
  switch (tab) {
    case 'overview': return <Overview projectId={projectId} />;
    case 'architecture': return <Architecture projectId={projectId} />;
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
