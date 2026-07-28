
import { Card, Icon } from '@aura/ui';
import { EmptyState } from '../../../components/EmptyState';
import { useWorkspace } from '../../../data/useWorkspace';
import type { GraphEntity } from '../../../ai/aiClient';

/**
 * Section data — the real, live view of the currently open project. Only
 * valid when the requested project is the mounted one (it always is: a
 * section renders inside its open workspace). Everything returned here is
 * derived from the real folder; there is no fallback sample data.
 */
export function useProjectData(projectId: string) {
  const { openId, profile, graph, kg, status, memory } = useWorkspace();
  const ready = openId === projectId;
  return {
    ready,
    profile: ready ? profile : null,
    graph: ready ? graph : null,
    kg: ready ? kg : null,
    status: ready ? status : null,
    memory: ready ? memory : [],
  };
}

/** Group entities by kind, most-populous first. */
export function byKind(entities: GraphEntity[]): { kind: string; items: GraphEntity[] }[] {
  const map = new Map<string, GraphEntity[]>();
  for (const e of entities) {
    const list = map.get(e.kind) ?? [];
    list.push(e);
    map.set(e.kind, list);
  }
  return [...map.entries()].map(([kind, items]) => ({ kind, items })).sort((a, b) => b.items.length - a.items.length);
}

/** A real, grouped list of graph entities for a layer. */
export function EntityGroups({ groups }: { groups: { kind: string; items: GraphEntity[] }[] }) {
  return (
    <div className="space-y-5">
      {groups.map(({ kind, items }) => (
        <Card key={kind} padding="none" className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <span className="text-[13px] font-semibold capitalize text-text">{kind.replace(/-/g, ' ')}</span>
            <span className="text-[11.5px] text-text-subtle">{items.length}</span>
          </div>
          <div className="divide-y divide-line">
            {items.slice(0, 40).map((e) => (
              <div key={e.id} className="flex items-start gap-3 px-5 py-2.5">
                <Icon name="dot" size={14} className="mt-1 shrink-0 text-text-subtle" />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-text">{e.name}</div>
                  <div className="truncate font-mono text-[11px] text-text-subtle">{e.relPath}{e.line ? `:${e.line}` : ''}</div>
                  {e.summary && <div className="mt-0.5 line-clamp-1 text-[11.5px] text-text-muted">{e.summary}</div>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Shared "not indexed / no data" surface for graph-backed sections. */
export function LayerEmpty({ ready, label }: { ready: boolean; label: string }) {
  if (!ready) return <EmptyState icon="knowledge" title="Analyzing project…" description="The system graph is still being built." compact />;
  return <EmptyState icon="architecture" title={`No ${label} detected`} description={`AURA found no ${label} entities in this project's real files. Nothing is fabricated.`} compact />;
}
