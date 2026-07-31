/**
 * MemoryPanel — the focused project's engineering memory items,
 * read from the public memory API. No mutations.
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge, Icon } from '@aura/ui';
import { aiClient, type MemoryItem } from '../../ai/aiClient';
import { useWorkspace } from '../../data/useWorkspace';
import { EmptyState } from '../../components/EmptyState';
import { VirtualList } from '../../editor/VirtualList';
import { PanelBody, PanelHeader } from '../panelFrame';
import { useLayoutStore } from '../layoutStore';

const KIND_TONE = (kind: string): 'positive' | 'attention' | 'critical' | 'info' | 'neutral' => {
  if (kind === 'accepted') return 'positive';
  if (kind === 'rejected' || kind === 'correction') return 'critical';
  if (kind === 'decision' || kind === 'learning') return 'attention';
  if (kind === 'diagnosis') return 'info';
  return 'neutral';
};

export default function MemoryPanel() {
  const focused = useLayoutStore((s) => s.focused);
  const openId = useWorkspace((s) => s.openId);
  const projectId = focused.projectId ?? openId;
  const projects = useWorkspace((s) => s.projects);
  const project = projects.find((p) => p.id === projectId);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    if (!projectId) {
      setItems([]);
      setLoading(false);
      return;
    }
    aiClient
      .listMemory(projectId)
      .then((res) => {
        if (alive) setItems(res.items);
      })
      .catch(() => {
        if (alive) setItems([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const rows = useMemo(() => items, [items]);

  if (!projectId || !project) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState compact icon="memory" title="Open a project to view its memory" />
      </div>
    );
  }

  return (
    <PanelBody padded={false} className="flex flex-col">
      <div className="px-3 pt-3">
        <PanelHeader title="Engineering memory" hint={project.name} />
      </div>
      {loading && (
        <div className="space-y-2 px-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-surface-active" />
          ))}
        </div>
      )}
      {!loading && rows.length === 0 && (
        <p className="px-4 py-10 text-center text-[12px] text-text-subtle">No memory items yet.</p>
      )}
      {rows.length > 0 && (
        <VirtualList
          items={rows}
          itemHeight={58}
          className="min-h-0 flex-1"
          renderItem={(item) => (
            <div className="flex items-start gap-2.5 px-3">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted">
                <Icon name="memory" size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12px] font-medium text-text">{item.title}</span>
                  <Badge tone={KIND_TONE(item.kind)}>{item.kind}</Badge>
                </div>
                <div className="line-clamp-1 text-[10.5px] text-text-subtle">{item.body}</div>
              </div>
            </div>
          )}
        />
      )}
    </PanelBody>
  );
}
