/**
 * MemoryCenter — the Engineering Memory Platform UI.
 * ==================================================================
 * Seven surfaces in one workspace-friendly component:
 *   • Timeline view  — memories grouped by day
 *   • History view   — the full sortable list (virtualized)
 *   • Search Memory  — instant query over title/summary/files/symbols
 *   • Memory Filters — category + importance + project chips
 *   • Memory Importance — per-importance counts + per-row badges
 *   • Related Memories — computed from shared mission/diagnosis/file/
 *                        symbol/layer refs, shown beside a selection
 *   • Memory Graph   — a laid-out SVG graph of the most significant
 *                      memories and the links between them
 *
 * `variant="screen"` renders the full landing; `variant="panel"`
 * renders the compact workspace-panel form. Both read the same store —
 * there is no fake data anywhere in this view.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Icon, Input } from '@aura/ui';
import type { IconName } from '@aura/ui';
import { cn } from '@aura/core';
import { useWorkspace } from '../data/useWorkspace';
import { useAppStore } from '@aura/core';
import { useEditorStore } from '../editor/editorStore';
import { VirtualList } from '../editor/VirtualList';
import { relTime } from '../screens/missions/missionMeta';
import { useLayoutStore } from './layoutStore';
import { MemoryGraphView } from './MemoryGraph';
import {
  applyFilter,
  layoutMemoryGraph,
  MEMORY_CATEGORY_META,
  MEMORY_IMPORTANCE_META,
  projectLabel,
  relatedMemories,
  useMemoryStore,
  type EngineeringMemory,
  type MemoryCategory,
  type MemoryImportance,
  type MemoryView,
} from './memoryStore';

const ICON_TONE: Record<string, string> = {
  architecture: 'text-accent',
  code: 'text-accent',
  mission: 'text-attention',
  diagnosis: 'text-attention',
  documentation: 'text-accent',
  review: 'text-attention',
  decision: 'text-positive',
  learning: 'text-text-muted',
};

const ALL_CATEGORIES: MemoryCategory[] = [
  'architecture', 'code', 'mission', 'diagnosis', 'documentation', 'review', 'decision', 'learning',
];
const ALL_IMPORTANCES: MemoryImportance[] = ['critical', 'high', 'medium', 'low'];

const VIEWS: { key: MemoryView; label: string; icon: IconName }[] = [
  { key: 'timeline', label: 'Timeline', icon: 'activity' },
  { key: 'history', label: 'History', icon: 'clipboard' },
  { key: 'graph', label: 'Graph', icon: 'architecture' },
];

export function MemoryCenter({ variant = 'screen' }: { variant?: 'screen' | 'panel' }) {
  const memories = useMemoryStore((s) => s.memories);
  const selectedId = useMemoryStore((s) => s.selectedId);
  const view = useMemoryStore((s) => s.view);
  const filter = useMemoryStore((s) => s.filter);
  const setView = useMemoryStore((s) => s.setView);
  const setFilter = useMemoryStore((s) => s.setFilter);
  const select = useMemoryStore((s) => s.select);
  const clear = useMemoryStore((s) => s.clear);
  const projects = useWorkspace((s) => s.projects);

  const [timelineLimit, setTimelineLimit] = useState(200);

  const filtered = useMemo(() => applyFilter(memories, filter), [memories, filter]);
  const selected = useMemo(() => memories.find((m) => m.id === selectedId) ?? null, [memories, selectedId]);
  const related = useMemo(() => (selected ? relatedMemories(memories, selected.id) : []), [memories, selected]);
  const graph = useMemo(() => layoutMemoryGraph(filtered), [filtered]);

  const projectIds = useMemo(() => {
    const set = new Set<string | null>();
    for (const m of memories) set.add(m.projectId);
    return [...set];
  }, [memories]);

  const toggleCategory = (c: MemoryCategory) => {
    const cur = filter.categories ?? [];
    const next = cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c];
    setFilter({ categories: next.length ? next : null });
  };
  const toggleImportance = (i: MemoryImportance) => {
    const cur = filter.importances ?? [];
    const next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i];
    setFilter({ importances: next.length ? next : null });
  };

  const importanceCounts = useMemo(() => {
    const counts: Record<MemoryImportance, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const m of filtered) counts[m.importance] += 1;
    return counts;
  }, [filtered]);

  return (
    <div className={cn('flex min-h-0 flex-col', variant === 'screen' ? 'mx-auto w-full max-w-[1360px] px-6 py-7 sm:px-10' : '')}>
      {/* header */}
      <div className={cn('flex flex-wrap items-end justify-between gap-3', variant === 'screen' ? 'mb-5' : 'px-3 pt-3')}>
        <div>
          <div className="flex items-center gap-2">
            <h2 className={cn('font-semibold tracking-[-0.01em] text-text', variant === 'screen' ? 'text-[19px]' : 'text-[13px]')}>
              Engineering Memory
            </h2>
            <Badge tone="info">{memories.length} memories</Badge>
          </div>
          <p className="mt-1 text-[12.5px] text-text-muted">
            Persistent engineering history — code changes, missions, diagnoses, reviews, decisions and learnings.
          </p>
        </div>
        <Button variant="ghost" size="sm" icon="close" onClick={clear}>
          Clear all
        </Button>
      </div>

      {/* view tabs + search */}
      <div className={cn('flex flex-wrap items-center gap-2', variant === 'panel' && 'px-3')}>
        <div className="flex items-center gap-1 rounded-xl border border-line bg-surface p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium transition-colors',
                view === v.key ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text',
              )}
            >
              <Icon name={v.icon} size={13} />
              {v.label}
            </button>
          ))}
        </div>
        <Input
          inputSize="sm"
          icon="search"
          placeholder="Search memories…"
          value={filter.query}
          onChange={(e) => setFilter({ query: e.target.value })}
          className="min-w-[180px] flex-1"
        />
      </div>

      {/* Memory Filters: categories */}
      <div className={cn('mt-2 flex flex-wrap items-center gap-1.5', variant === 'panel' && 'px-3')}>
        {ALL_CATEGORIES.map((c) => {
          const active = filter.categories?.includes(c) ?? false;
          return (
            <button
              key={c}
              onClick={() => toggleCategory(c)}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium transition-colors',
                active ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-text-muted hover:text-text',
              )}
            >
              <Icon name={MEMORY_CATEGORY_META[c].icon as IconName} size={11} />
              {MEMORY_CATEGORY_META[c].label}
            </button>
          );
        })}
        {projectIds.length > 1 && <span className="mx-1 h-4 w-px bg-line" />}
        {projectIds.length > 1 &&
          projectIds.slice(0, 6).map((pid) => {
            const active = filter.projectId === pid;
            return (
              <button
                key={pid ?? 'global'}
                onClick={() => setFilter({ projectId: active ? null : pid })}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[10.5px] font-medium transition-colors',
                  active ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-text-muted hover:text-text',
                )}
              >
                {projectLabel(pid, projects)}
              </button>
            );
          })}
      </div>

      {/* Memory Importance: counts + chips */}
      <div className={cn('mt-2 flex flex-wrap items-center gap-1.5', variant === 'panel' && 'px-3')}>
        {ALL_IMPORTANCES.map((i) => {
          const active = filter.importances?.includes(i) ?? false;
          const count = importanceCounts[i];
          return (
            <button
              key={i}
              onClick={() => toggleImportance(i)}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium transition-colors',
                active ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-text-muted hover:text-text',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', {
                critical: 'bg-danger',
                high: 'bg-attention',
                medium: 'bg-accent',
                low: 'bg-text-subtle',
              }[i])}
              />
              {MEMORY_IMPORTANCE_META[i].label} · {count}
            </button>
          );
        })}
        <span className="text-[10.5px] text-text-subtle">{filtered.length} shown of {memories.length}</span>
      </div>

      {/* content */}
      <div className={cn('grid gap-3', variant === 'screen' ? 'mt-4 grid-cols-1 xl:grid-cols-[1fr_300px]' : 'mt-2 min-h-0 flex-1 grid-cols-1 xl:grid-cols-[1fr_300px]')}>
        <div className="min-h-0">
          {view === 'timeline' && (
            <TimelineView
              filtered={filtered}
              selectedId={selectedId}
              onSelect={select}
              limit={timelineLimit}
              onMore={() => setTimelineLimit((n) => n + 200)}
              projects={projects}
            />
          )}
          {view === 'history' && (
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              <VirtualList
                items={filtered}
                itemHeight={44}
                className="max-h-[60vh] min-h-[200px]"
                renderItem={(m) => (
                  <MemoryRow m={m} selected={m.id === selectedId} onSelect={select} projects={projects} />
                )}
              />
            </div>
          )}
          {view === 'graph' && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10.5px] text-text-muted">Nodes are memories; edges connect shared mission, diagnosis, file, symbol or layer.</span>
              </div>
              <MemoryGraphView graph={graph} selectedId={selectedId} onSelect={select} />
            </div>
          )}
        </div>

        {selected ? (
          <MemoryDetail
            memory={selected}
            related={related}
            onSelect={select}
            projects={projects}
          />
        ) : (
          <div className="hidden rounded-xl border border-dashed border-line bg-canvas p-4 xl:block">
            <p className="text-[11.5px] leading-relaxed text-text-subtle">
              Select a memory to inspect its full record — files, symbols, layer, related memories and its originating mission or diagnosis.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Timeline (grouped by day) ──────────────────────────────────────── */

function TimelineView({
  filtered,
  selectedId,
  onSelect,
  limit,
  onMore,
  projects,
}: {
  filtered: EngineeringMemory[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  limit: number;
  onMore: () => void;
  projects: { id: string; name: string }[];
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, EngineeringMemory[]>();
    for (const m of filtered) {
      const key = m.at.slice(0, 10);
      const arr = map.get(key);
      if (arr) arr.push(m);
      else map.set(key, [m]);
    }
    return [...map.entries()];
  }, [filtered]);

  const total = grouped.reduce((acc, [, list]) => acc + list.length, 0);
  const showMore = total > limit;
  let rendered = 0;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      {grouped.length === 0 && (
        <p className="px-4 py-12 text-center text-[12px] text-text-muted">
          No memories yet — they will appear here as real engineering events happen.
        </p>
      )}
      {grouped.map(([day, list]) => {
        if (rendered >= limit) return null;
        const items = list.slice(0, Math.max(0, limit - rendered));
        rendered += items.length;
        const label =
          day === new Date().toISOString().slice(0, 10)
            ? 'Today'
            : new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
        return (
          <div key={day}>
            <div className="flex items-center gap-2 border-b border-line bg-surface-active/60 px-3 py-1.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">{label}</span>
              <span className="text-[10px] text-text-subtle">{items.length}</span>
            </div>
            {items.map((m) => (
              <MemoryRow key={m.id} m={m} selected={m.id === selectedId} onSelect={onSelect} projects={projects} />
            ))}
          </div>
        );
      })}
      {showMore && (
        <div className="border-t border-line p-2 text-center">
          <Button variant="ghost" size="sm" onClick={onMore}>
            Show more
          </Button>
        </div>
      )}
    </div>
  );
}

/* ── one compact memory row ─────────────────────────────────────────── */

function MemoryRow({
  m,
  selected,
  onSelect,
  projects,
}: {
  m: EngineeringMemory;
  selected: boolean;
  onSelect: (id: string) => void;
  projects: { id: string; name: string }[];
}) {
  const meta = MEMORY_CATEGORY_META[m.category];
  const imp = MEMORY_IMPORTANCE_META[m.importance];
  return (
    <button
      onClick={() => onSelect(m.id)}
      className={cn(
        'flex h-11 w-full items-center gap-2.5 border-b border-line/60 px-3 text-left transition-colors last:border-b-0',
        selected ? 'bg-accent/10' : 'hover:bg-surface-hover',
      )}
    >
      <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-active', ICON_TONE[m.category])}>
        <Icon name={meta.icon as IconName} size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text">{m.title}</span>
          <Badge tone={imp.tone} className="shrink-0">{imp.label}</Badge>
        </span>
        <span className="block truncate text-[10.5px] text-text-subtle">
          {m.summary || m.reason} · {projectLabel(m.projectId, projects)}
        </span>
      </span>
      <span className="shrink-0 text-[10px] text-text-subtle">{relTime(m.at)}</span>
    </button>
  );
}

/* ── detail + Related Memories ──────────────────────────────────────── */

function MemoryDetail({
  memory,
  related,
  onSelect,
  projects,
}: {
  memory: EngineeringMemory;
  related: EngineeringMemory[];
  onSelect: (id: string | null) => void;
  projects: { id: string; name: string }[];
}) {
  const meta = MEMORY_CATEGORY_META[memory.category];
  const imp = MEMORY_IMPORTANCE_META[memory.importance];
  const openPanel = useLayoutStore((s) => s.openPanel);
  const setFocused = useLayoutStore((s) => s.setFocused);

  const openMission = () => {
    setFocused({ projectId: memory.projectId, missionId: memory.missionId });
    openPanel('mission-detail');
  };
  const openDiagnosis = () => {
    setFocused({ projectId: memory.projectId, diagnosisId: memory.diagnosisId });
    openPanel('diagnostics');
  };
  const openFile = (path: string) => {
    const editor = useEditorStore.getState();
    if (editor.projectId) {
      void editor.openFile({ path, name: path.split('/').pop() ?? path });
      const app = useAppStore.getState();
      app.openProject(editor.projectId);
      app.setProjectTab('code');
    }
  };

  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className={cn('grid h-7 w-7 place-items-center rounded-lg bg-surface-active', ICON_TONE[memory.category])}>
          <Icon name={meta.icon as IconName} size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold text-text">{memory.title}</p>
          <p className="text-[10px] text-text-subtle">{meta.label} · {imp.label} · {relTime(memory.at)}</p>
        </div>
        <button onClick={() => onSelect(null)} className="rounded-md p-1 text-text-subtle hover:bg-surface-hover" aria-label="Clear selection">
          <Icon name="close" size={13} />
        </button>
      </div>

      <p className="text-[12px] leading-relaxed text-text-muted">{memory.summary || memory.reason}</p>
      {memory.reason && <p className="mt-1 text-[11px] leading-relaxed text-text-subtle">Why: {memory.reason}</p>}

      {(memory.missionId || memory.diagnosisId) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {memory.missionId && (
            <Button variant="secondary" size="sm" icon="deploy" onClick={openMission}>Mission</Button>
          )}
          {memory.diagnosisId && (
            <Button variant="secondary" size="sm" icon="bug" onClick={openDiagnosis}>Diagnosis</Button>
          )}
        </div>
      )}

      {memory.files.length > 0 && (
        <ChipSection label="Files">
          {memory.files.slice(0, 5).map((f) => (
            <button
              key={f}
              onClick={() => openFile(f)}
              className="max-w-full truncate rounded-md border border-line bg-canvas px-2 py-0.5 text-[10px] text-text-muted transition-colors hover:border-accent hover:text-accent"
              title={f}
            >
              {f.split('/').pop()}
            </button>
          ))}
        </ChipSection>
      )}

      {memory.symbols.length > 0 && (
        <ChipSection label="Symbols">
          {memory.symbols.map((s) => (
            <span key={s} className="rounded-md bg-surface-active px-2 py-0.5 text-[10px] text-text-muted">{s}</span>
          ))}
        </ChipSection>
      )}

      {(memory.layer || memory.dependencies.length > 0) && (
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-text-subtle">
          {memory.layer && <span>Layer: <strong className="text-text-muted">{memory.layer}</strong></span>}
          {memory.dependencies.length > 0 && <span>Deps: <strong className="text-text-muted">{memory.dependencies.join(', ')}</strong></span>}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-subtle">
        <span>User: <strong className="text-text-muted">{memory.user}</strong></span>
        <span>Source: <strong className="text-text-muted">{memory.source}</strong></span>
        <span>Project: <strong className="text-text-muted">{projectLabel(memory.projectId, projects)}</strong></span>
      </div>

      {related.length > 0 && (
        <div className="mt-3 border-t border-line pt-2.5">
          <p className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">
            <Icon name="link" size={11} /> Related memories · {related.length}
          </p>
          <div className="space-y-1">
            {related.slice(0, 6).map((r) => (
              <button
                key={r.id}
                onClick={() => onSelect(r.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
              >
                <Icon name={MEMORY_CATEGORY_META[r.category].icon as IconName} size={11} className="shrink-0 text-text-subtle" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-text">{r.title}</span>
                <span className="shrink-0 text-[9.5px] text-text-subtle">{relTime(r.at)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChipSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-2.5">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-subtle">{label}</p>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}
