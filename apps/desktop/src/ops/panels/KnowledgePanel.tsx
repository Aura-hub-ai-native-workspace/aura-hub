/**
 * KnowledgePanel — a browser over the active project's knowledge fabric
 * (graph nodes grouped by type), read-only from `useWorkspace.kg`.
 */
import { useMemo } from 'react';
import { Badge } from '@aura/ui';
import { useWorkspace } from '../../data/useWorkspace';
import { EmptyState } from '../../components/EmptyState';
import { VirtualList } from '../../editor/VirtualList';
import { PanelBody, PanelHeader } from '../panelFrame';

interface Row {
  id: string;
  label: string;
  type: string;
  relPath: string | null;
}

export default function KnowledgePanel() {
  const openId = useWorkspace((s) => s.openId);
  const kg = useWorkspace((s) => s.kg);

  const rows = useMemo<Row[]>(() => {
    if (!kg) return [];
    return kg.nodes
      .map((n) => ({ id: n.id, label: n.label, type: n.type, relPath: n.relPath ?? null }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }, [kg]);

  if (!openId) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState compact icon="knowledge" title="Open a project to browse its fabric" />
      </div>
    );
  }
  if (!kg) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState compact icon="knowledge" title="Knowledge graph not ready" description="The project is still indexing, or has no graph yet." />
      </div>
    );
  }

  const counts = kg.counts ?? {};

  return (
    <PanelBody padded={false} className="flex flex-col">
      <div className="px-3 pt-3">
        <PanelHeader title="Knowledge fabric" hint={`${kg.nodes.length} nodes · ${kg.edges.length} relations`} />
        <div className="mb-2 flex flex-wrap gap-1.5">
          {Object.entries(counts).slice(0, 8).map(([k, n]) => (
            <Badge key={k} tone="info">{k}: {n}</Badge>
          ))}
        </div>
      </div>
      {rows.length === 0 && (
        <p className="px-4 py-10 text-center text-[12px] text-text-subtle">No knowledge nodes yet.</p>
      )}
      {rows.length > 0 && (
        <VirtualList
          items={rows}
          itemHeight={38}
          className="min-h-0 flex-1"
          renderItem={(row) => (
            <div className="flex items-center gap-2 px-3">
              <span className="w-20 shrink-0 truncate rounded bg-surface-active px-1.5 py-0.5 text-center text-[9.5px] uppercase tracking-wide text-text-subtle">
                {row.type}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-text">{row.label}</span>
              {row.relPath && <span className="max-w-[45%] shrink-0 truncate text-[10px] text-text-subtle">{row.relPath}</span>}
            </div>
          )}
        />
      )}
    </PanelBody>
  );
}
