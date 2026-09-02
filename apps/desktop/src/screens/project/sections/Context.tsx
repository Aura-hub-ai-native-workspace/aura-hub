/**
 * Context — "what does AURA actually know about this project?"
 * ==================================================================
 * The first Workspace surface onto the Context Fabric. It renders ONE
 * `ContextView` fetched for the canonical `activeProjectId`; it derives
 * nothing, computes nothing and asks no other endpoint. If a fact looks
 * wrong here, it is wrong at its authority — this panel cannot disagree
 * with Ask AURA, because both read the same view.
 *
 * ── The design decision that matters ─────────────────────────────────
 * Freshness leads, and it is stated even when the answer is unflattering.
 * A context panel that quietly presents month-old facts as current is
 * worse than no panel: the user's trust in every other row depends on
 * knowing whether the row is still true. So the freshness banner is the
 * first thing rendered, it is never hidden, and when understanding is
 * stale or absent the affected sections say so in place rather than
 * showing an empty state that reads as "there is nothing here".
 */
import { useCallback, useEffect, useState } from 'react';
import { cn } from '@aura/core';
import { Badge, Button, Icon } from '@aura/ui';
import { SectionView, Block } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';
import { aiClient, type ContextView, type ContextFreshness } from '../../../ai/aiClient';

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function Context({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ContextView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await aiClient.projectContext(projectId);
      setView(res.view);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  /* Refresh goes through the EXISTING re-index authority, but names its
     project. The generic re-index acts on whatever is mounted, so this
     panel — which is scoped to `projectId` — could refresh project A and
     re-index project B. The service refuses that mismatch; the button is
     disabled below so the user meets an explanation rather than an error.

     This panel deliberately has no indexing mechanism of its own —
     inventing a second one is how two notions of "up to date" start. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await aiClient.reindexProject(projectId);
      if (res && typeof res === 'object' && 'error' in res) {
        setError(res.error ?? 'The project could not be re-indexed.');
        return;
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [projectId, load]);

  if (loading && !view) {
    return <SectionView title="Context"><Block><div className="h-40 animate-pulse rounded-2xl bg-surface-active/50" /></Block></SectionView>;
  }
  if (error || !view) {
    return (
      <SectionView title="Context">
        <EmptyState
          icon="cpu"
          title="Context unavailable"
          description={error ?? 'The AURA service did not return a context view for this project.'}
          action={<Button icon="refresh" onClick={() => void load()}>Try again</Button>}
        />
      </SectionView>
    );
  }

  const f = view.freshness;
  const r = view.repository;

  return (
    <SectionView
      eyebrow="Project understanding"
      title="What AURA knows"
      hint={`Everything below is what AURA can tell an agent about ${view.project.name}.`}
      actions={
        <div className="flex items-center gap-2.5">
          {/* Re-indexing only works on the open project, and AURA will not
              switch projects behind the user's back to make a refresh
              possible. Say so rather than offering a button that fails. */}
          {!view.project.mounted && (
            <span className="text-[11.5px] text-text-subtle">Open this project to refresh</span>
          )}
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={() => void refresh()}
            disabled={refreshing || !view.project.mounted}
          >
            {refreshing ? 'Re-indexing…' : 'Refresh context'}
          </Button>
        </div>
      }
    >
      <Block>
        <FreshnessBanner freshness={f} />
      </Block>

      {view.constraints.length > 0 && (
        <Block className="mt-4">
          <Panel title="Worth knowing before you act" icon="shield">
            <ul className="space-y-2">
              {view.constraints.map((c) => (
                <li key={c.id} className="flex gap-2.5 text-[12.5px] text-text-muted">
                  <Icon name="chevron-right" size={13} className="mt-0.5 shrink-0 text-text-subtle" />
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </Block>
      )}

      <div className="mt-4 grid grid-cols-12 gap-4">
        <Block className="col-span-12 lg:col-span-6">
          <Panel title="Project" icon="folder">
            <Rows rows={[
              ['Name', view.project.name],
              ['Root', <span className="font-mono text-[11.5px]">{view.project.root}</span>],
              ['Type', view.project.type],
              ['Language', view.project.language],
              ['Open in AURA', view.project.mounted ? 'Yes' : 'No — open it to see live index status'],
            ]} />
          </Panel>
        </Block>

        <Block className="col-span-12 lg:col-span-6">
          <Panel title="Git" icon="git">
            {view.git.value?.branch ? (
              <>
                <Rows rows={[
                  ['Branch', <span className="font-mono text-[11.5px]">{view.git.value.branch}</span>],
                  ['Working tree', view.git.value.dirty ? `${view.git.value.changedFiles} uncommitted change(s)` : 'Clean'],
                ]} />
                {view.git.value.recentCommits.length > 0 && (
                  <div className="mt-3 space-y-1.5 border-t border-line pt-3">
                    {view.git.value.recentCommits.map((c) => (
                      <div key={c.hash} className="flex gap-2.5 text-[12px]">
                        <span className="shrink-0 font-mono text-[11px] text-text-subtle">{c.hash.slice(0, 7)}</span>
                        <span className="truncate text-text-muted">{c.subject}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <Unavailable reason={view.git.reason ?? 'Not a git repository.'} />
            )}
          </Panel>
        </Block>

        <Block className="col-span-12">
          <Panel
            title="Repository"
            icon="architecture"
            action={
              <Badge tone={r.value?.identity ? 'positive' : 'neutral'}>
                {r.value?.identity ? 'Analysed' : 'Not analysed yet'}
              </Badge>
            }
          >
            {!r.value?.identity ? (
              <Unavailable reason="AURA has not analysed this project yet. These facts are unavailable, not empty." />
            ) : (
              <>
                {r.value.identity.purpose && <p className="mb-3 text-[13px] leading-relaxed text-text-muted">{r.value.identity.purpose}</p>}
                <Rows rows={[
                  ['Kind', r.value.identity.repositoryType],
                  ['Architecture', r.value.identity.architectureStyle],
                  ['Primary language', r.value.identity.primaryLanguage],
                  ['Frameworks', r.value.identity.frameworks.length ? r.value.identity.frameworks.join(', ') : null],
                  ['Files', r.value.modules.length > 0 ? String(r.value.modules.length) + ' modules' : null],
                ]} />
                {r.value.modules.length > 0 && (
                  <div className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-xl bg-line sm:grid-cols-2">
                    {r.value.modules.map((m) => (
                      <div key={m.path} className="bg-surface p-3">
                        <div className="text-[12.5px] font-medium text-text">{m.name}</div>
                        <div className="mt-0.5 font-mono text-[10.5px] text-text-subtle">{m.path}</div>
                        <div className="mt-1 line-clamp-2 text-[11.5px] text-text-muted">{m.description}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </Panel>
        </Block>

        <Block className="col-span-12 lg:col-span-6">
          <Panel
            title="Environment"
            icon="cpu"
            action={<span className="text-[11.5px] text-text-subtle">scanned {relTime(view.environment.generatedAt)}</span>}
          >
            {view.environment.value ? (
              <>
                <Rows rows={[
                  ['OS', `${view.environment.value.os} (${view.environment.value.arch})`],
                ]} />
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
                  {view.environment.value.tools.map((n) => (
                    <span key={n.id} className="rounded-lg bg-surface-active/60 px-2 py-1 text-[11px] text-text-muted">
                      {n.name}{n.version ? ` ${n.version}` : ''}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <Unavailable reason={view.environment.reason ?? 'Environment not scanned.'} />
            )}
          </Panel>
        </Block>

        <Block className="col-span-12 lg:col-span-6">
          <Panel title="Capabilities" icon="spark">
            {view.capabilities.value && view.capabilities.value.length > 0 ? (
              <div className="space-y-1.5">
                {view.capabilities.value.map((cap) => (
                  <div key={cap.id} className="flex items-center justify-between gap-3 text-[12px]">
                    <span className="text-text">{cap.name}</span>
                    <span className={cn('text-[11px]',
                      cap.availability === 'available' ? 'text-positive' : 'text-text-subtle')}>
                      {cap.availability}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Unavailable reason={view.capabilities.reason ?? 'No capabilities measured.'} />
            )}
          </Panel>
        </Block>

        <Block className="col-span-12 lg:col-span-6">
          <Panel title="Missions" icon="deploy">
            {view.missions.value && view.missions.value.length > 0 ? (
              <div className="space-y-2">
                {view.missions.value.map((m) => (
                  <div key={m.id} className="flex items-start gap-2 text-[12px]">
                    <span className="text-text-muted">{m.text}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Unavailable reason={view.missions.reason ?? 'No missions for this project yet.'} />
            )}
          </Panel>
        </Block>

        <Block className="col-span-12 lg:col-span-6">
          <Panel title="Recent activity" icon="activity">
            {view.activity.value && view.activity.value.length > 0 ? (
              <div className="space-y-1.5">
                {view.activity.value.map((e, i) => (
                  <div key={`${e.at}-${i}`} className="flex gap-2.5 text-[12px]">
                    <span className="shrink-0 text-[11px] text-text-subtle">{relTime(e.at)}</span>
                    <span className="truncate text-text-muted">{e.decision}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Unavailable reason={view.activity.reason ?? 'Nothing has run for this project yet.'} />
            )}
          </Panel>
        </Block>
      </div>
    </SectionView>
  );
}

/* ── pieces ──────────────────────────────────────────────────────── */

function FreshnessBanner({ freshness }: { freshness: ContextFreshness }) {
  const tone =
    freshness === 'fresh' ? 'positive'
      : freshness === 'stale' ? 'attention'
        : 'neutral';
  const label =
    freshness === 'fresh' ? 'Context is current'
      : freshness === 'stale' ? 'Context is out of date'
        : 'Project not analysed yet';

  return (
    <div className={cn(
      'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border px-4 py-3',
      tone === 'positive' && 'border-positive/25 bg-positive/5',
      tone === 'attention' && 'border-attention/30 bg-attention/10',
      tone === 'neutral' && 'border-line bg-surface',
    )}>
      {/* Never colour alone: the state is spelled out in words too. */}
      <span className="inline-flex items-center gap-2">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full',
          tone === 'positive' && 'bg-positive',
          tone === 'attention' && 'bg-attention',
          tone === 'neutral' && 'bg-text-subtle')} />
        <span className="text-[13px] font-medium text-text">{label}</span>
      </span>
    </div>
  );
}

function Panel({ title, icon, action, children }: {
  title: string; icon: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="h-full rounded-2xl border border-line bg-surface p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon name={icon as 'folder'} size={14} className="text-text-subtle" />
          <h3 className="text-[13px] font-semibold text-text">{title}</h3>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  return (
    <div className="divide-y divide-line">
      {shown.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 py-1.5">
          <span className="shrink-0 text-[12px] text-text-subtle">{k}</span>
          <span className="min-w-0 truncate text-right text-[12.5px] text-text">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** An honest "we don't know" — distinct from an empty list. */
function Unavailable({ reason }: { reason: string }) {
  return <p className="text-[12.5px] leading-relaxed text-text-subtle">{reason}</p>;
}
