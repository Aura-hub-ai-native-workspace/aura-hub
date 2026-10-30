import { useEffect, useMemo, useState } from 'react';
import { useAppStore, cn } from '@aura/core';
import { Badge, Button, Card, Icon, IconButton, Input, Menu, useToast } from '@aura/ui';
import { PageContainer, PageBlock } from './PageContainer';
import { EmptyState } from '../components/EmptyState';
import { AddProjectDialog } from '../components/AddProjectDialog';
import { GeneralChat } from '../components/GeneralChat';
import { useAgentLink } from '../ai/agentLinkStore';
import { useWorkspace } from '../data/useWorkspace';
import { hasUnsavedWorkFor } from '../editor/editorStore';
import { aiClient, type ProjectRecord } from '../ai/aiClient';
import { centralAgentClient } from '../ai/centralAgentClient';
import { AgentStrip, ProjectCards, PromptHero, type AgentRow } from './home/HomeSections';

type Segment = 'all' | 'favorites' | 'recent';

const SUGGESTIONS = ['Plan a new app from an idea', 'What can AURA do?', 'Compare tech stacks for my idea'];

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
  const addProjectDialogOpen = useAppStore((s) => s.addProjectDialogOpen);
  const openAddProjectDialog = useAppStore((s) => s.openAddProjectDialog);
  const openSettings = useAppStore((s) => s.openSettings);
  const closeAddProjectDialog = useAppStore((s) => s.closeAddProjectDialog);
  const { projects, localProjects, refresh, open } = useWorkspace();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [isAskAuraOpen, setIsAskAuraOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [chatSeed, setChatSeed] = useState<string | undefined>(undefined);
  const { push } = useToast();

  useEffect(() => {
    void refresh();
    // Probe until reachable, then re-check now and then. A single probe at mount
    // read "Backend offline" for the whole session whenever the services were
    // still starting (the packaged app), while the status bar had already connected.
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = () => {
      aiClient.health()
        .then(() => { if (!alive) return; setReachable(true); timer = setTimeout(probe, 15000); })
        .catch(() => { if (!alive) return; setReachable(false); timer = setTimeout(probe, 2000); });
    };
    probe();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [refresh]);

  // The first refresh can run before the backend is up and fail quietly; load the list again the moment it answers.
  useEffect(() => {
    if (reachable === true) void refresh();
  }, [reachable, refresh]);

  // The agents orbiting the core are the ones really detected on this machine.
  // Discovery can race the backend finishing its start-up, so a failure is retried a few times.
  useEffect(() => {
    if (reachable !== true) return;
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      centralAgentClient.agentRuntimeDiscover()
        .then((r) => { if (alive) { setAgents(r.agents.map((a) => ({ id: a.id, name: a.name, detected: a.detected, status: a.status, drift: a.drift }))); setAgentsLoading(false); } })
        .catch(() => { if (!alive) return; if (++tries < 4) timer = setTimeout(load, 4000); else setAgentsLoading(false); });
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [reachable]);

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
  // The command bar's "Start Building" raises this counter.
  const focusTick = useAgentLink((s) => s.focusTick);
  useEffect(() => { if (focusTick > 0) setIsAskAuraOpen(true); }, [focusTick]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const startWith = (text: string) => { setChatSeed(text); setPrompt(''); setIsAskAuraOpen(true); };

  return (
    <PageContainer wide>
      <AddProjectDialog open={addProjectDialogOpen} onClose={closeAddProjectDialog} />
      <GeneralChat isOpen={isAskAuraOpen} onClose={() => { setIsAskAuraOpen(false); setChatSeed(undefined); }} initialMessage={chatSeed} />

      <div className="mx-auto max-w-[760px] pt-[7vh] pb-16">
        <PageBlock>
          <PromptHero
            greeting={`${greeting}, Groot.`}
            value={prompt}
            onChange={setPrompt}
            onSubmit={startWith}
            suggestions={SUGGESTIONS}
          />
        </PageBlock>
        <PageBlock className="mt-16">
          <ProjectCards projects={recents} onOpen={enter} onAdd={openAddProjectDialog} onAll={() => setShowAllProjects((v) => !v)} showingAll={showAllProjects} relTime={relTime} />
        </PageBlock>
        <PageBlock className="mt-12">
          <AgentStrip agents={agents} loading={agentsLoading} onManage={() => openSettings('runtime')} />
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
                segment === s.key ? 'bg-surface text-text' : 'text-text-muted hover:text-text',
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
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-surface-active text-text">
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
                  <span className="truncate">{p.path}</span>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Readout icon="cpu" label="Language" value={p.language} />
                  <Readout icon="spark" label="Type" value={p.type.replace(' application', '').replace(' service', '')} />
                </div>

                <div className="mt-4 flex items-center justify-between pt-3">
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
