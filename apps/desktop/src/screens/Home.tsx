import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useAppStore, cn, spring } from '@aura/core';
import { Badge, Button, Card, CardHeader, Icon, IconButton, Input, Menu, useToast } from '@aura/ui';
import { PageContainer, PageBlock } from './PageContainer';
import { EmptyState } from '../components/EmptyState';
import { AddProjectDialog } from '../components/AddProjectDialog';
import { CreateProjectDialog } from '../components/CreateProjectDialog';
import { AskAuraChatbox } from '../components/AskAuraChatbox';
import { useWorkspace } from '../data/useWorkspace';
import { hasUnsavedWorkFor } from '../editor/editorStore';
import { aiClient, type HealthResult, type ProjectRecord } from '../ai/aiClient';

type Segment = 'all' | 'favorites' | 'recent';

function relTime(iso: string | null): string {
  if (!iso) return 'never opened';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Home — the environment overview. Everything shown here is real: the
 * projects the user actually added, the live indexing status of the open
 * project, and the real AI provider connection. When there is no data
 * yet, the space says so and points at the first action.
 *
 * The full project library (search, favorites, rename, remove — what used
 * to be its own "Projects" nav destination) lives here too, as an
 * expandable section, now that the sidebar only has four primary
 * destinations. "Continue working" and "All projects" are two views onto
 * the same real project list, not two separate features.
 */
export function Home() {
  const openProjectNav = useAppStore((s) => s.openProject);
  const setNav = useAppStore((s) => s.setNav);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const addProjectDialogOpen = useAppStore((s) => s.addProjectDialogOpen);
  const openAddProjectDialog = useAppStore((s) => s.openAddProjectDialog);
  const closeAddProjectDialog = useAppStore((s) => s.closeAddProjectDialog);
  const createProjectDialogOpen = useAppStore((s) => s.createProjectDialogOpen);
  const openCreateProjectDialog = useAppStore((s) => s.openCreateProjectDialog);
  const closeCreateProjectDialog = useAppStore((s) => s.closeCreateProjectDialog);
  const { projects, localProjects, status, refresh, open } = useWorkspace();
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [isAskAuraOpen, setIsAskAuraOpen] = useState(false);
  const { push } = useToast();

  useEffect(() => {
    void refresh();
    aiClient.health().then((h) => { setHealth(h); setReachable(true); }).catch(() => setReachable(false));
  }, [refresh]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const allProjects = useMemo(() => [...localProjects, ...projects], [localProjects, projects]);
  const recents = allProjects.slice(0, 4);
  const enter = (id: string) => {
    if (id.startsWith('local-')) {
      push({ title: 'Local draft', description: 'Register the folder with Add Project to profile and open it.', tone: 'info' });
      return;
    }
    if (hasUnsavedWorkFor(id) && !window.confirm('You have unsaved changes in the current project\'s Code Workspace. Switch projects anyway?')) return;
    void open(id);
    openProjectNav(id);
  };
  const askAura = () => setIsAskAuraOpen(true);

  const subtitle = allProjects.length === 0
    ? 'No projects yet — add a real folder to begin.'
    : `${allProjects.length} project${allProjects.length > 1 ? 's' : ''} in your workspace.`;

  return (
    <PageContainer wide>
      <AddProjectDialog open={addProjectDialogOpen} onClose={closeAddProjectDialog} />
      <CreateProjectDialog open={createProjectDialogOpen} onClose={closeCreateProjectDialog} />
      <AskAuraChatbox isOpen={isAskAuraOpen} onClose={() => setIsAskAuraOpen(false)} />

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
            <div className="flex flex-wrap gap-2.5">
              <motion.button
                type="button"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.95 }}
                transition={spring.snappy}
                onClick={openCreateProjectDialog}
                className="relative inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-[#00b3ff] px-4 text-[13px] font-medium text-white shadow-[0_0_16px_rgba(0,179,255,0.45)] outline-none select-none transition-all duration-200 hover:bg-[#2fc2ff] hover:shadow-[0_0_26px_rgba(0,179,255,0.65)] active:bg-[#0093d4] active:shadow-[0_0_12px_rgba(0,179,255,0.35)] focus-visible:ring-2 focus-visible:ring-cyan-300/60"
              >
                <Icon name="folder" size={16} />
                <span className="truncate">Create Project</span>
              </motion.button>
              <Button variant="primary" icon="plus" onClick={openAddProjectDialog}>Add Project</Button>
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
              {allProjects.length > 0 && (
                <Button size="sm" variant="ghost" iconRight={showAllProjects ? 'chevron-down' : 'chevron-right'} onClick={() => setShowAllProjects((v) => !v)}>
                  {showAllProjects ? 'Hide' : 'All projects'}
                </Button>
              )}
            </div>
            {recents.length === 0 ? (
              <EmptyState
                icon="folder"
                title="No projects to continue"
                description="Add a folder and it will show up here so you can pick up where you left off."
                action={<Button icon="plus" onClick={openAddProjectDialog}>Add Project</Button>}
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
              <QuickAction icon="plus" label="Add Project" hint="Import a real folder" onClick={openAddProjectDialog} />
              <QuickAction icon="spark" label="Ask AURA" hint="Chat over your project" onClick={askAura} />
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
                value={reachable === false ? 'Backend offline' : health?.health.ok ? `Connected · ${health.health.latencyMs}ms` : 'Connected'}
                tone={reachable === false ? 'critical' : 'positive'}
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

      {showAllProjects && (
        <PageBlock className="mt-5">
          <ProjectLibrary projects={allProjects} onEnter={enter} onAdd={openAddProjectDialog} />
        </PageBlock>
      )}
    </PageContainer>
  );
}

/**
 * The full project library — search, favorites/recent filters, per-card
 * manage menu. Absorbed from the former standalone "Projects" screen;
 * expanded here from Home's "All projects" toggle rather than its own
 * top-level nav destination.
 */
function ProjectLibrary({ onEnter, onAdd, projects }: { onEnter: (id: string) => void; onAdd: () => void; projects: ProjectRecord[] }) {
  const { reachable, favorite, remove, rename } = useWorkspace();
  const { push } = useToast();
  const [query, setQuery] = useState('');
  const [segment, setSegment] = useState<Segment>('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (segment === 'favorites' && !p.favorite) return false;
      if (!q) return true;
      return `${p.name} ${p.type} ${p.language} ${p.path}`.toLowerCase().includes(q);
    });
  }, [projects, query, segment]);

  const visible = segment === 'recent' ? filtered.slice(0, 6) : filtered;

  const segments: { key: Segment; label: string; icon: 'grid' | 'pin' | 'activity' }[] = [
    { key: 'all', label: 'All', icon: 'grid' },
    { key: 'favorites', label: 'Favorites', icon: 'pin' },
    { key: 'recent', label: 'Recent', icon: 'activity' },
  ];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold text-text">All projects</h2>
        <Input icon="search" placeholder="Search projects…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-60" />
        <div className="inline-flex items-center gap-1 rounded-xl bg-surface-active/70 p-1">
          {segments.map((s) => (
            <button
              key={s.key}
              onClick={() => setSegment(s.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                segment === s.key ? 'bg-surface text-text shadow-sm' : 'text-text-muted hover:text-text',
              )}
            >
              <Icon name={s.icon} size={14} /> {s.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[12px] text-text-subtle">{visible.length} of {projects.length}</span>
      </div>

      {reachable === false && (
        <div className="mb-5 flex items-center gap-3 rounded-2xl border border-attention/30 bg-attention/10 px-4 py-3 text-[12.5px] text-attention">
          <Icon name="cpu" size={16} />
          <span>Backend service offline. Start it with <code className="rounded bg-surface-active px-1.5 py-0.5 font-mono text-[11px]">npm&nbsp;run&nbsp;ai</code> — your projects live there.</span>
        </div>
      )}

      {projects.length === 0 ? (
        <EmptyState
          icon="folder"
          title="No projects yet"
          description="Add a real project folder to start. AURA profiles it, indexes its code and system graph, and remembers everything you do."
          action={<Button icon="plus" onClick={onAdd}>Add your first project</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((p) => (
            <PageBlock key={p.id}>
              <Card interactive padding="lg" onClick={() => onEnter(p.id)} className="group h-full">
                <div className="flex items-start justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-white shadow-sm" style={{ background: p.color }}>
                      <Icon name={(p.icon as 'folder') || 'folder'} size={20} />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate text-[15px] font-semibold text-text">{p.name}</h3>
                      <div className="mt-0.5 flex items-center gap-2">
                        <Badge tone="neutral">{p.type}</Badge>
                        <span className="text-[11px] text-text-subtle">{relTime(p.lastOpenedAt)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                    {!p.id.startsWith('local-') && (
                      <IconButton
                        icon="pin"
                        label={p.favorite ? 'Unfavorite' : 'Favorite'}
                        className={p.favorite ? 'text-accent' : 'text-text-subtle'}
                        onClick={() => void favorite(p.id, !p.favorite)}
                      />
                    )}
                    <Menu
                      align="end"
                      trigger={<IconButton icon="more" label="Project actions" />}
                      items={
                        p.id.startsWith('local-')
                          ? [
                              { id: 'open', label: 'Open', icon: 'arrow-right', onSelect: () => onEnter(p.id) },
                              'separator',
                              { id: 'note', label: 'Frontend draft — add it via Add Project to register it', onSelect: () => {} },
                            ]
                          : [
                              { id: 'open', label: 'Open', icon: 'arrow-right', onSelect: () => onEnter(p.id) },
                              {
                                id: 'rename', label: 'Rename', icon: 'note',
                                onSelect: () => { const n = window.prompt('Rename project', p.name); if (n && n.trim()) void rename(p.id, n.trim()); },
                              },
                              {
                                id: 'fav', label: p.favorite ? 'Remove favorite' : 'Add favorite', icon: 'pin',
                                onSelect: () => void favorite(p.id, !p.favorite),
                              },
                              'separator',
                              {
                                id: 'remove', label: 'Remove from AURA', icon: 'close', tone: 'danger',
                                onSelect: () => {
                                  if (window.confirm(`Remove "${p.name}" from AURA? The folder on disk is not deleted.`)) {
                                    void remove(p.id);
                                    push({ title: 'Project removed', description: 'The folder was left untouched.', tone: 'info' });
                                  }
                                },
                              },
                            ]
                      }
                    />
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2 text-[11.5px] text-text-subtle">
                  <Icon name="doc" size={13} />
                  <span className="font-mono truncate">{p.path}</span>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Readout icon="cpu" label="Language" value={p.language} />
                  <Readout icon="spark" label="Type" value={p.type.replace(' application', '').replace(' service', '')} />
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
                  <span className="text-[11px] text-text-subtle">Added {relTime(p.createdAt)}</span>
                  <Icon name="arrow-right" size={16} className="text-text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-text" />
                </div>
              </Card>
            </PageBlock>
          ))}

          <PageBlock>
            <button onClick={onAdd} className="flex h-full min-h-[220px] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line text-text-subtle transition-colors hover:border-accent hover:text-accent">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-active"><Icon name="plus" size={22} /></span>
              <span className="text-[13px] font-medium">Add a project</span>
            </button>
          </PageBlock>

          {visible.length === 0 && (
            <div className="col-span-full">
              <EmptyState icon="search" title="No projects match" description="Try a different filter or search term." compact />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Readout({ icon, label, value }: { icon: 'cpu' | 'spark'; label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-active/50 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[10px] text-text-subtle"><Icon name={icon} size={11} /> {label}</div>
      <div className="mt-0.5 truncate text-[13px] font-semibold text-text">{value}</div>
    </div>
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
