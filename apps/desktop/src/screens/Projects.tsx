import { useEffect, useMemo, useState } from 'react';
import { useAppStore, cn } from '@aura/core';
import { Badge, Button, Card, Icon, IconButton, Input, Menu, useToast } from '@aura/ui';
import { PageContainer, PageBlock } from './PageContainer';
import { EmptyState } from '../components/EmptyState';
import { AddProjectDialog } from '../components/AddProjectDialog';
import { useWorkspace } from '../data/useWorkspace';
import type { ProjectRecord } from '../ai/aiClient';

/**
 * Projects — the real project library. Every card is a folder the user
 * added; its type, language and "last opened" are derived from the real
 * folder. Opening one enters its operating environment. When the library
 * is empty (or the backend is offline) an honest empty state is shown.
 */

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

export function Projects() {
  const openProjectNav = useAppStore((s) => s.openProject);
  const { projects, reachable, refresh, open, favorite, remove, rename } = useWorkspace();
  const { push } = useToast();
  const [query, setQuery] = useState('');
  const [segment, setSegment] = useState<Segment>('all');
  const [adding, setAdding] = useState(false);

  useEffect(() => { void refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (segment === 'favorites' && !p.favorite) return false;
      if (!q) return true;
      return `${p.name} ${p.type} ${p.language} ${p.path}`.toLowerCase().includes(q);
    });
  }, [projects, query, segment]);

  const visible = segment === 'recent' ? filtered.slice(0, 6) : filtered;

  const enter = (p: ProjectRecord) => { void open(p.id); openProjectNav(p.id); };

  const segments: { key: Segment; label: string; icon: 'grid' | 'pin' | 'activity' }[] = [
    { key: 'all', label: 'All', icon: 'grid' },
    { key: 'favorites', label: 'Favorites', icon: 'pin' },
    { key: 'recent', label: 'Recent', icon: 'activity' },
  ];

  return (
    <PageContainer
      wide
      title="Projects"
      subtitle="Every project is a real folder — indexed, profiled and remembered."
      actions={
        <>
          <Input icon="search" placeholder="Search projects…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-60" />
          <Button icon="plus" onClick={() => setAdding(true)}>Add Project</Button>
        </>
      }
    >
      <AddProjectDialog open={adding} onClose={() => setAdding(false)} />

      {reachable === false && (
        <PageBlock className="mb-6">
          <div className="flex items-center gap-3 rounded-2xl border border-attention/30 bg-attention/10 px-4 py-3 text-[12.5px] text-attention">
            <Icon name="cpu" size={16} />
            <span>Backend service offline. Start it with <code className="rounded bg-surface-active px-1.5 py-0.5 font-mono text-[11px]">npm&nbsp;run&nbsp;ai</code> — your projects live there.</span>
          </div>
        </PageBlock>
      )}

      {projects.length > 0 && (
        <PageBlock className="mb-6">
          <div className="flex flex-wrap items-center gap-2">
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
        </PageBlock>
      )}

      {projects.length === 0 ? (
        <EmptyState
          icon="folder"
          title="No projects yet"
          description="Add a real project folder to start. AURA profiles it, indexes its code and system graph, and remembers everything you do."
          action={<Button icon="plus" onClick={() => setAdding(true)}>Add your first project</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((p) => (
            <PageBlock key={p.id}>
              <Card interactive padding="lg" onClick={() => enter(p)} className="group h-full">
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
                    <IconButton
                      icon="pin"
                      label={p.favorite ? 'Unfavorite' : 'Favorite'}
                     
                      className={p.favorite ? 'text-accent' : 'text-text-subtle'}
                      onClick={() => void favorite(p.id, !p.favorite)}
                    />
                    <Menu
                      align="end"
                      trigger={<IconButton icon="more" label="Project actions" />}
                      items={[
                        { id: 'open', label: 'Open', icon: 'arrow-right', onSelect: () => enter(p) },
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
                      ]}
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
            <button onClick={() => setAdding(true)} className="flex h-full min-h-[220px] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line text-text-subtle transition-colors hover:border-accent hover:text-accent">
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
    </PageContainer>
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
