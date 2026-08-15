import { Suspense, lazy } from 'react';
import { motion } from 'framer-motion';
import { PROJECT_TABS, pageVariants, spring, useAppStore, cn } from '@aura/core';
import { Badge, Button, Icon } from '@aura/ui';
import { ProjectSection } from './sections';
import { EmptyState } from '../../components/EmptyState';
import { useWorkspace } from '../../data/useWorkspace';

/**
 * Ask AURA is the project's own conversation surface, shown full-screen
 * inside the project rather than as a floating workspace panel. Lazily
 * loaded so a project that is never asked anything doesn't pay for it.
 *
 * It replaces the old header action that called `openPanel('ai-chat')`.
 * That route was dead: `openPanel` writes to `layoutStore`, and the
 * component that renders those windows (`ops/WorkspaceCanvas.tsx`) is not
 * mounted by any screen, so the button changed a store nothing read.
 */
const AiWorkspace = lazy(() => import('../ai/AiWorkspace').then((m) => ({ default: m.AiWorkspace })));

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
  const askAuraOpen = useAppStore((s) => s.askAuraOpen);
  const setAskAuraOpen = useAppStore((s) => s.setAskAuraOpen);
  const { projects, openId, status } = useWorkspace();

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  /* Mounting the project in the backend used to happen here. It now happens
     in `useActiveProjectSync` (AppShell), because the project must be
     mounted whenever it is ACTIVE — not only while this screen is on
     display. Doing it here meant the Hub could be working against a project
     the service had not mounted. */

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

  // Ask AURA takes over the whole project view — full-screen *within* the
  // project, not a floating panel in the Workspace. The project header and
  // tabs step aside; one control brings them back.
  //
  // `openId` gates the chat because AiWorkspace reads the MOUNTED project.
  // Mounting is driven by `useActiveProjectSync` in AppShell now, so by the
  // time this screen is reachable the mount is normally already in flight —
  // this gate just avoids rendering the chat against the previous project.
  if (askAuraOpen) {
    return (
      <div className="flex h-full min-h-full flex-col">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-surface/40 px-8 py-2.5 backdrop-blur-sm sm:px-10 lg:px-12">
          <button
            onClick={() => setAskAuraOpen(false)}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-text-muted transition-colors hover:text-text"
          >
            <Icon name="chevron-right" size={14} className="rotate-180" />
            Back to {project.name}
          </button>
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-text-muted">
            <Icon name="spark" size={14} className="text-accent" />
            Ask AURA
          </span>
        </div>
        <div className="min-h-0 flex-1">
          {openId === project.id ? (
            <Suspense fallback={<AskAuraLoading />}>
              <AiWorkspace />
            </Suspense>
          ) : (
            <AskAuraLoading />
          )}
        </div>
      </div>
    );
  }

  const indexing = status?.phase === 'indexing';
  // The Code Workspace doesn't depend on Knowledge Fabric indexing (it
  // reads/writes real files directly) and owns a fixed-viewport layout
  // with its own internal scroll regions — it never waits on the
  // indexing gate and never sits inside the page's normal scroll flow.
  const isCode = tab === 'code';

  return (
    <div className={cn('flex flex-col', isCode ? 'h-full min-h-full' : 'min-h-full')}>
      <div className="shrink-0 border-b border-line bg-surface/40 px-8 pt-6 backdrop-blur-sm sm:px-10 lg:px-12">
        <button onClick={closeProject} className="mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-text-muted transition-colors hover:text-text">
          <Icon name="chevron-right" size={14} className="rotate-180" />
          Back to Home
        </button>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-3xl text-white shadow-sm" style={{ background: project.color }}>
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
          <div className="flex gap-2.5">
            <Button variant="secondary" icon="spark" onClick={() => setAskAuraOpen(true)}>Ask AURA</Button>
          </div>
        </div>

        <div className="-mb-px mt-6 flex gap-1 overflow-x-auto">
          {PROJECT_TABS.map((t) => (
            <WorkspaceTab key={t.key} icon={t.icon} label={t.label} active={tab === t.key} onClick={() => setTab(t.key)} />
          ))}
        </div>
      </div>

      <div className={cn('flex-1', isCode ? 'flex min-h-0 overflow-hidden' : '')}>
        {indexing && !isCode && tab !== 'settings' && tab !== 'memory' ? (
          <EmptyState icon="knowledge" title="Indexing your project…" description={`${status?.message ?? 'Working'} — ${status?.coding.processed ?? 0}/${status?.coding.total || '…'} files.`} />
        ) : isCode ? (
          <ProjectSection tab={tab} projectId={project.id} />
        ) : (
          <motion.div key={tab} variants={pageVariants} initial="initial" animate="animate">
            <ProjectSection tab={tab} projectId={project.id} />
          </motion.div>
        )}
      </div>
    </div>
  );
}

/**
 * Shown while the chat bundle streams in, or while the project is still
 * being mounted in the backend. Mirrors the chat's real chrome so the
 * swap-in never causes a layout jump.
 */
function AskAuraLoading() {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="h-[68px] shrink-0 animate-pulse border-b border-line bg-surface/60" />
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[248px] shrink-0 animate-pulse bg-surface/40 lg:block" />
        <div className="flex-1 animate-pulse bg-canvas" />
        <div className="hidden w-[340px] shrink-0 animate-pulse bg-surface/40 xl:block" />
      </div>
    </div>
  );
}

function WorkspaceTab({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cn('relative flex shrink-0 items-center gap-1.5 px-3.5 py-2.5 text-[13px] font-medium transition-colors', active ? 'text-text' : 'text-text-muted hover:text-text')}>
      <Icon name={icon as never} size={15} />
      {label}
      {active && <motion.span layoutId="ws-tab-indicator" transition={spring.smooth} className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
    </button>
  );
}
