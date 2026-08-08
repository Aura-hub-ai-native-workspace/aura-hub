import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { spring, useAppStore, cn } from '@aura/core';
import { Badge, Button, Icon, PanelSection, PropertyRow } from '@aura/ui';
import { useWorkspace } from '../data/useWorkspace';
import { useLayoutStore } from '../ops/layoutStore';
import { aiClient, type HealthResult, type ProviderStatus } from '../ai/aiClient';

export function RightPanel() {
  const nav = useAppStore((s) => s.nav);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const project = useWorkspace((s) => s.projects.find((p) => p.id === activeProjectId));
  const contextKey = project ? `project:${project.id}` : `nav:${nav}`;

  return (
    <div className="flex h-full flex-col divide-y divide-line">
      <motion.div key={contextKey} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring.smooth} className="flex flex-1 flex-col divide-y divide-line">
        {project ? <ProjectContext projectId={project.id} /> : <NavContext />}
      </motion.div>
    </div>
  );
}

function ProjectContext({ projectId }: { projectId: string }) {
  const { projects, profile, status, memory, openId } = useWorkspace();
  const project = projects.find((p) => p.id === projectId);
  const live = openId === projectId;
  if (!project) return null;

  return (
    <>
      <PanelSection title="Project" icon="folder">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl text-white" style={{ background: project.color }}>
            <Icon name={(project.icon as 'folder') || 'folder'} size={18} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-text">{project.name}</div>
            <div className="text-[11.5px] text-text-muted">{project.type}</div>
          </div>
        </div>
        <p className="mt-3 truncate font-mono text-[11px] text-text-subtle">{project.path}</p>
      </PanelSection>

      <PanelSection title="Knowledge" icon="knowledge">
        {live && status && status.phase !== 'empty' ? (
          <div className="space-y-2">
            <PropertyRow label="Status" value={<Badge tone={status.phase === 'ready' ? 'positive' : status.phase === 'error' ? 'critical' : 'info'} dot>{status.phase}</Badge>} />
            <PropertyRow label="Code chunks" value={status.coding.chunks.toLocaleString()} />
            <PropertyRow label="Entities" value={status.fullstack.entities.toLocaleString()} />
            <PropertyRow label="Relations" value={status.fullstack.relations.toLocaleString()} />
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-text-subtle">Indexing…</div>
        )}
      </PanelSection>

      <PanelSection title="Profile" icon="settings">
        <PropertyRow label="Language" value={project.language} />
        <PropertyRow label="Package mgr" value={profile?.packageManager ?? '—'} />
        <PropertyRow label="Files" value={String(profile?.fileCount ?? 0)} />
        <PropertyRow label="Memory items" value={String(live ? memory.length : 0)} />
      </PanelSection>
    </>
  );
}

function NavContext() {
  const setNav = useAppStore((s) => s.setNav);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const openAddProjectDialog = useAppStore((s) => s.openAddProjectDialog);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const projectCount = useWorkspace((s) => s.projects.length);
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [provStatus, setProvStatus] = useState<ProviderStatus | null>(null);

  useEffect(() => {
    aiClient.health().then((h) => { setHealth(h); setReachable(true); }).catch(() => setReachable(false));
    aiClient.getProviders().then((r) => setProvStatus(r.status)).catch(() => {});
  }, []);

  const actions = [
    { icon: 'plus' as const, label: 'Add Project', hint: 'Import a real folder', run: () => { setNav('home'); openAddProjectDialog(); } },
    { icon: 'spark' as const, label: 'Help Chat Assistant', hint: 'Chat over your project', run: () => { setNav('workspace'); openPanel('ai-chat'); } },
    { icon: 'command' as const, label: 'Command Bar', hint: 'Run any command', run: () => setPaletteOpen(true) },
  ];

  return (
    <>
      <PanelSection title="Quick actions" icon="command">
        <div className="space-y-1.5">
          {actions.map((a) => (
            <button key={a.label} onClick={a.run} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-surface-hover">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-surface-active text-text-muted"><Icon name={a.icon} size={16} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium text-text">{a.label}</span>
                <span className="block truncate text-[11px] text-text-subtle">{a.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </PanelSection>

      <PanelSection title="AI Provider" icon="cpu">
        <div className="space-y-2">
          <PropertyRow label="Connection" value={
            <span className={cn('inline-flex items-center gap-1.5 text-[11.5px] font-medium',
              reachable === false ? 'text-critical' : health?.health.ok ? 'text-positive' : 'text-text-subtle')}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {reachable === false ? 'Offline' : health?.health.ok ? `${health.health.latencyMs}ms` : 'Not connected'}
            </span>
          } />
          <PropertyRow label="Provider" value={!provStatus || provStatus.type === 'none' ? 'Not connected' : provStatus.label} />
          <PropertyRow label="Model" value={provStatus?.model || '—'} />
          <PropertyRow label="Projects" value={String(projectCount)} />
        </div>
        <Button variant="subtle" block icon="settings" className="mt-3" onClick={() => setNav('settings')}>{!provStatus || provStatus.type === 'none' ? 'Connect a provider' : 'Configure AI'}</Button>
      </PanelSection>
    </>
  );
}
