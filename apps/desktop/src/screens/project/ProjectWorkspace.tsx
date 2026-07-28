import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { PROJECT_TABS, pageVariants, spring, useAppStore, cn } from '@aura/core';
import { Badge, Button, Icon } from '@aura/ui';
import { ProjectSection } from './sections';
import { EmptyState } from '../../components/EmptyState';
import { useWorkspace } from '../../data/useWorkspace';

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
  const { projects, openId, status, open } = useWorkspace();

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  // Ensure the active project is actually mounted + indexing in the backend.
  useEffect(() => {
    if (activeProjectId && openId !== activeProjectId) void open(activeProjectId);
  }, [activeProjectId, openId, open]);

  if (!project) {
    return (
      <div className="grid min-h-full place-items-center p-10">
        <EmptyState
          icon="folder"
          title="Project not found"
          description="It may have been removed. Return to the library to pick another."
          action={<Button icon="projects" onClick={() => setNav('projects')}>Back to Projects</Button>}
        />
      </div>
    );
  }

  const indexing = status?.phase === 'indexing';

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-line bg-surface/40 px-8 pt-6 backdrop-blur-sm sm:px-10 lg:px-12">
        <button onClick={closeProject} className="mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-text-muted transition-colors hover:text-text">
          <Icon name="chevron-right" size={14} className="rotate-180" />
          Back to Projects
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
            <Button variant="secondary" icon="spark" onClick={() => setNav('ai')}>Ask AURA</Button>
          </div>
        </div>

        <div className="-mb-px mt-6 flex gap-1 overflow-x-auto">
          {PROJECT_TABS.map((t) => (
            <WorkspaceTab key={t.key} icon={t.icon} label={t.label} active={tab === t.key} onClick={() => setTab(t.key)} />
          ))}
        </div>
      </div>

      <div className="flex-1">
        {indexing && tab !== 'settings' && tab !== 'memory' ? (
          <EmptyState icon="knowledge" title="Indexing your project…" description={`${status?.message ?? 'Working'} — ${status?.coding.processed ?? 0}/${status?.coding.total || '…'} files.`} />
        ) : (
          <motion.div key={tab} variants={pageVariants} initial="initial" animate="animate">
            <ProjectSection tab={tab} projectId={project.id} />
          </motion.div>
        )}
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
