import { useEffect, useState } from 'react';
import { useAppStore, cn } from '@aura/core';
import { Button, Card, CardHeader, Icon } from '@aura/ui';
import { PageContainer, PageBlock } from './PageContainer';
import { EmptyState } from '../components/EmptyState';
import { AddProjectDialog } from '../components/AddProjectDialog';
import { useWorkspace } from '../data/useWorkspace';
import { aiClient, type HealthResult } from '../ai/aiClient';

/**
 * Home — the environment overview. Everything shown here is real: the
 * projects the user actually added, the live indexing status of the open
 * project, and the real AI provider connection. When there is no data
 * yet, the space says so and points at the first action.
 */
export function Home() {
  const openProjectNav = useAppStore((s) => s.openProject);
  const setNav = useAppStore((s) => s.setNav);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const { projects, status, refresh, open } = useWorkspace();
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void refresh();
    aiClient.health().then((h) => { setHealth(h); setReachable(true); }).catch(() => setReachable(false));
  }, [refresh]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const recents = projects.slice(0, 4);
  const enter = (id: string) => { void open(id); openProjectNav(id); };

  const subtitle = projects.length === 0
    ? 'No projects yet — add a real folder to begin.'
    : `${projects.length} project${projects.length > 1 ? 's' : ''} in your workspace.`;

  return (
    <PageContainer wide>
      <AddProjectDialog open={adding} onClose={() => setAdding(false)} />

      <PageBlock className="mb-8">
        <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-8">
          <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
          <div className="relative flex flex-wrap items-end justify-between gap-6">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-accent">
                <Icon name="spark" size={15} />
                {reachable === false ? 'Backend offline' : 'Environment ready'}
              </div>
              <h1 className="text-[32px] font-semibold tracking-[-0.02em] text-text">{greeting}, Groot</h1>
              <p className="mt-2 max-w-lg text-[14px] text-text-muted">{subtitle}</p>
            </div>
            <div className="flex gap-2.5">
              <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add Project</Button>
              <Button variant="secondary" icon="command" onClick={() => setPaletteOpen(true)}>Command Bar</Button>
            </div>
          </div>
        </div>
      </PageBlock>

      <div className="grid grid-cols-12 gap-5">
        {/* Continue working */}
        <PageBlock className="col-span-12 xl:col-span-8">
          <Card padding="none" className="overflow-hidden">
            <div className="flex items-center justify-between px-6 pt-5">
              <CardHeader title="Continue working" subtitle="Your recent projects" />
              {projects.length > 0 && (
                <Button size="sm" variant="ghost" iconRight="arrow-right" onClick={() => setNav('projects')}>All projects</Button>
              )}
            </div>
            {recents.length === 0 ? (
              <EmptyState
                icon="folder"
                title="No projects to continue"
                description="Add a folder and it will show up here so you can pick up where you left off."
                action={<Button icon="plus" onClick={() => setAdding(true)}>Add Project</Button>}
                compact
              />
            ) : (
              <div className="mt-5 grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
                {recents.map((p) => (
                  <button key={p.id} onClick={() => enter(p.id)} className="group flex items-center gap-4 bg-surface p-5 text-left transition-colors hover:bg-surface-hover">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-white shadow-sm" style={{ background: p.color }}>
                      <Icon name={(p.icon as 'folder') || 'folder'} size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="truncate text-[14px] font-semibold text-text">{p.name}</span>
                      <p className="mt-0.5 truncate text-[12px] text-text-muted">{p.type} · {p.language}</p>
                      <div className="mt-1 truncate font-mono text-[10.5px] text-text-subtle">{p.path}</div>
                    </div>
                    <Icon name="arrow-right" size={18} className="text-text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-text" />
                  </button>
                ))}
              </div>
            )}
          </Card>
        </PageBlock>

        {/* Knowledge / index status */}
        <PageBlock className="col-span-12 xl:col-span-4">
          <Card className="h-full">
            <CardHeader title="Knowledge index" subtitle="Live for the open project" />
            {status && status.phase !== 'empty' ? (
              <div className="mt-5 space-y-4">
                <StatusRow label="Status" value={status.message} tone={status.phase === 'ready' ? 'positive' : status.phase === 'error' ? 'critical' : 'info'} />
                <Stat label="Code chunks indexed" value={status.coding.chunks} />
                <Stat label="System entities" value={status.fullstack.entities} />
                <Stat label="Relationships" value={status.fullstack.relations} />
                {status.phase === 'indexing' && (
                  <div className="text-[11px] text-text-subtle">Indexing {status.coding.processed}/{status.coding.total || '…'} files</div>
                )}
              </div>
            ) : (
              <EmptyState icon="knowledge" title="No open project" description="Open a project to index its code and system graph." compact />
            )}
          </Card>
        </PageBlock>

        {/* Quick actions */}
        <PageBlock className="col-span-12 lg:col-span-6">
          <Card className="h-full">
            <CardHeader title="Quick actions" />
            <div className="mt-4 grid grid-cols-2 gap-2.5">
              <QuickAction icon="plus" label="Add Project" hint="Import a real folder" onClick={() => setAdding(true)} />
              <QuickAction icon="spark" label="Ask AURA" hint="Chat over your project" onClick={() => setNav('ai')} />
              <QuickAction icon="command" label="Command Bar" hint="Do anything, instantly" onClick={() => setPaletteOpen(true)} />
              <QuickAction icon="settings" label="AI Provider" hint="Connect an AI provider" onClick={() => setNav('settings')} />
            </div>
          </Card>
        </PageBlock>

        {/* AI provider status (real) */}
        <PageBlock className="col-span-12 lg:col-span-6">
          <Card className="h-full">
            <CardHeader title="AI Runtime" subtitle="Connection status" action={<Icon name="cpu" size={16} className="text-text-subtle" />} />
            <div className="mt-4 space-y-3">
              <StatusRow
                label="Connection"
                value={reachable === false ? 'Backend offline' : health?.health.ok ? `Connected · ${health.health.latencyMs}ms` : 'Not connected'}
                tone={reachable === false ? 'critical' : health?.health.ok ? 'positive' : 'neutral'}
              />
              <StatusRow
                label="API key"
                value={health?.key.configured ? `Configured · ${health.key.fingerprint}` : 'Not set'}
                tone={health?.key.configured ? 'positive' : 'attention'}
              />
              {!health?.key.configured && reachable !== false && (
                <Button size="sm" variant="secondary" icon="settings" onClick={() => setNav('settings')}>Configure AI</Button>
              )}
            </div>
          </Card>
        </PageBlock>
      </div>
    </PageContainer>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12.5px] text-text-muted">{label}</span>
      <span className="text-[13px] font-semibold text-text">{value.toLocaleString()}</span>
    </div>
  );
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral' }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-text-muted">{label}</span>
      <span className="inline-flex items-center gap-1.5 truncate text-[12px] font-medium text-text">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full',
          tone === 'positive' && 'bg-positive', tone === 'attention' && 'bg-attention',
          tone === 'critical' && 'bg-critical', tone === 'info' && 'bg-accent animate-pulse', tone === 'neutral' && 'bg-text-subtle')} />
        {value}
      </span>
    </div>
  );
}

function QuickAction({ icon, label, hint, onClick }: { icon: 'plus' | 'spark' | 'command' | 'settings'; label: string; hint: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col gap-3 rounded-2xl border border-line p-4 text-left transition-all hover:border-line-strong hover:bg-surface-hover">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-50 text-accent dark:bg-accent/15"><Icon name={icon} size={18} /></span>
      <span>
        <span className="block text-[13px] font-medium text-text">{label}</span>
        <span className="mt-0.5 block text-[11px] text-text-subtle">{hint}</span>
      </span>
    </button>
  );
}
