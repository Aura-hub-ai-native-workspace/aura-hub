import { Suspense, lazy, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { PROJECT_TABS, pageVariants, useAppStore, cn } from '@aura/core';
import { Badge, Button, Icon } from '@aura/ui';
import { ProjectSection } from './sections';
import { ProjectModeSwitch } from '../../shell/ProjectModeSwitch';
import { EmptyState } from '../../components/EmptyState';
import { ProjectIntro } from '../../components/ProjectIntro';
import { useWorkspace } from '../../data/useWorkspace';

/** The project's Workspace (execution chat + capability graph), loaded on first visit. */
const WorkspaceScreen = lazy(() => import('../WorkspaceScreen').then((m) => ({ default: m.WorkspaceScreen })));

/**
 * ProjectWorkspace — a real project rendered as its own operating
 * environment. Opening a project mounts it in the backend (indexing
 * starts automatically); the header and every tab read real, derived
 * data. Tabs with no real local source show honest empty states.
 */
export function ProjectWorkspace() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const tab = useAppStore((s) => s.projectTab);
  const setTab = useAppStore((s) => s.setProjectTab);
  const closeProject = useAppStore((s) => s.closeProject);
  const setNav = useAppStore((s) => s.setNav);
  const mode = useAppStore((s) => s.projectMode);
  const setMode = useAppStore((s) => s.setProjectMode);
  const { projects, status } = useWorkspace();
  const pendingIntro = useWorkspace((s) => s.pendingIntro);
  const clearIntro = useWorkspace((s) => s.clearIntro);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  // Once visited, the Workspace stays mounted (hidden) while Overview shows,
  // so its conversation and run state survive switching back and forth.
  const [workspaceVisited, setWorkspaceVisited] = useState(mode === 'workspace');
  useEffect(() => {
    if (mode === 'workspace') setWorkspaceVisited(true);
  }, [mode]);
  useEffect(() => {
    setWorkspaceVisited(useAppStore.getState().projectMode === 'workspace');
  }, [activeProjectId]);

  /* Mounting the project in the backend used to happen here. It now happens
     in `useActiveProjectSync` (AppShell), because the project must be
     mounted whenever it is ACTIVE — not only while this screen is on
     display. Doing it here meant the Hub could be working against a project
     the service had not mounted. */

  // The first time a project is opened (decided and remembered by the
  // service, not by this screen), its opening moment plays once. A project
  // that was just created from an idea then continues straight into its
  // Workspace; an existing folder stays on its overview.
  const intro = project && pendingIntro?.projectId === project.id ? pendingIntro : null;
  const introEnded = () => {
    const wasNew = pendingIntro?.kind === 'new';
    clearIntro();
    if (wasNew) setMode('workspace');
  };

  if (!project) {
    return (
      <div className="grid min-h-full place-items-center p-10">
        <EmptyState
          icon="folder"
          title="Project not found"
          description="It may have been removed. Return to Home to pick another."
          action={<Button icon="home" onClick={() => setNav('home')}>Back to Home</Button>}
        />
      </div>
    );
  }

  const introOverlay = intro && project
    ? <ProjectIntro kind={intro.kind} projectName={project.name} onDone={introEnded} />
    : null;

  const indexing = status?.phase === 'indexing';
  // The Code page and the Workspace own fixed-viewport layouts with their
  // own internal scroll regions; they never sit in the page's scroll flow.
  const isWorkspace = mode === 'workspace';
  const isCode = !isWorkspace && tab === 'code';
  const fixed = isWorkspace || isCode;

  return (
    <div className={cn('flex flex-col', fixed ? 'h-full min-h-full' : 'min-h-full')}>
      {introOverlay}
      {/* The only chrome at the top of the app: the switch for this project. It stays put while the page scrolls under it. */}
      <div className="pointer-events-none sticky top-0 z-30 flex h-14 shrink-0 items-center justify-center">
        <div className="pointer-events-auto"><ProjectModeSwitch /></div>
      </div>
      {!isWorkspace && (
      <div className="shrink-0 border-b border-line bg-surface/40 px-8 pb-5 pt-2 backdrop-blur-sm sm:px-10 lg:px-12">
        <button onClick={closeProject} className="mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-text-muted transition-colors hover:text-text">
          <Icon name="chevron-right" size={14} className="rotate-180" />
          Back to Home
        </button>

        <div className="flex min-w-0 items-center gap-4">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-3xl bg-surface-active text-text">
            <Icon name={(project.icon as 'folder') || 'folder'} size={26} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[24px] font-semibold tracking-[-0.01em] text-text">{project.name}</h1>
              <Badge tone="neutral">{project.type}</Badge>
              {status && (
                <Badge tone={status.phase === 'ready' ? 'positive' : status.phase === 'error' ? 'critical' : 'info'} dot>
                  {status.phase === 'ready' ? `${status.coding.chunks} chunks · ${status.fullstack.entities} entities` : status.message}
                </Badge>
              )}
            </div>
            <p className="mt-1 truncate font-mono text-[12px] text-text-muted">{project.path}</p>
          </div>
        </div>
      </div>
      )}

      <div className={cn('flex-1', fixed ? 'flex min-h-0 overflow-hidden' : 'flex')}>
        {workspaceVisited && (
          <div className={cn('min-h-0 min-w-0 flex-1', isWorkspace ? 'flex flex-col' : 'hidden')} data-testid="project-workspace-pane">
            <Suspense fallback={<WorkspaceLoading />}>
              <WorkspaceScreen />
            </Suspense>
          </div>
        )}
        {!isWorkspace && (
          <>
            <nav aria-label="Overview" className="w-48 shrink-0 border-r border-line bg-surface/30 p-3">
              {PROJECT_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  aria-current={tab === t.key ? 'page' : undefined}
                  className={cn(
                    'mb-0.5 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors',
                    tab === t.key ? 'bg-accent/10 text-text' : 'text-text-muted hover:bg-surface hover:text-text',
                  )}
                >
                  <Icon name={t.icon as never} size={15} />
                  {t.label}
                </button>
              ))}
            </nav>
            <div className={cn('min-w-0 flex-1', isCode ? 'flex min-h-0 overflow-hidden' : '')}>
              {indexing && !isCode ? (
                <EmptyState icon="knowledge" title="Indexing your project…" description={`${status?.message ?? 'Working'} — ${status?.coding.processed ?? 0}/${status?.coding.total || '…'} files.`} />
              ) : isCode ? (
                <ProjectSection tab={tab} projectId={project.id} />
              ) : (
                <motion.div key={tab} variants={pageVariants} initial="initial" animate="animate">
                  <ProjectSection tab={tab} projectId={project.id} />
                </motion.div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Shown while the Workspace chunk streams in; mirrors its two-pane chrome. */
function WorkspaceLoading() {
  return (
    <div className="flex h-full w-full">
      <div className="hidden w-[30%] shrink-0 animate-pulse bg-surface/40 lg:block" />
      <div className="flex-1 animate-pulse bg-canvas" />
    </div>
  );
}
