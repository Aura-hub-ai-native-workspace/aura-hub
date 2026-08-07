/**
 * DiagnosticsPanel — the focused project's diagnosis history with
 * decision state, read-only from the public diagnosis API. Clicking a
 * row opens the diagnosed file in the Code Workspace.
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge, Icon } from '@aura/ui';
import { diagnosisClient, type DiagnosisSummary } from '../../ai/diagnosisClient';
import { useWorkspace } from '../../data/useWorkspace';
import { useEditorStore } from '../../editor/editorStore';
import { useAppStore } from '@aura/core';
import { EmptyState } from '../../components/EmptyState';
import { VirtualList } from '../../editor/VirtualList';
import { PanelBody, PanelHeader } from '../panelFrame';
import { useLayoutStore } from '../layoutStore';

const DECISION_TONE: Record<string, 'positive' | 'attention' | 'critical' | 'info' | 'neutral'> = {
  pending: 'attention',
  accepted: 'positive',
  rejected: 'neutral',
};

export default function DiagnosticsPanel() {
  const focused = useLayoutStore((s) => s.focused);
  const openId = useWorkspace((s) => s.openId);
  const projectId = focused.projectId ?? openId;
  const projects = useWorkspace((s) => s.projects);
  const project = projects.find((p) => p.id === projectId);
  const [items, setItems] = useState<DiagnosisSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    if (!projectId) {
      setItems([]);
      setLoading(false);
      return;
    }
    diagnosisClient
      .list(projectId)
      .then((res) => {
        if (alive) setItems(res.diagnoses);
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

  const rows = useMemo(
    () => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [items],
  );

  const openFile = (path: string) => {
    const editor = useEditorStore.getState();
    if (editor.projectId) {
      void editor.openFile({ path, name: path.split('/').pop() ?? path });
      const app = useAppStore.getState();
      app.openProject(editor.projectId);
      app.setProjectTab('code');
    }
  };

  if (!projectId || !project) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState compact icon="bug" title="Open a project to see diagnoses" />
      </div>
    );
  }

  return (
    <PanelBody padded={false} className="flex flex-col">
      <div className="px-3 pt-3">
        <PanelHeader title="Diagnostics" hint={project.name} />
      </div>
      {loading && (
        <div className="space-y-2 px-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-surface-active" />
          ))}
        </div>
      )}
      {!loading && rows.length === 0 && (
        <p className="px-4 py-10 text-center text-[12px] text-text-subtle">No diagnoses yet — run one from the Code Workspace.</p>
      )}
      {rows.length > 0 && (
        <VirtualList
          items={rows}
          itemHeight={52}
          className="min-h-0 flex-1"
          renderItem={(d) => (
            <button
              onClick={() => openFile(d.filePath)}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-surface-hover"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted">
                <Icon name="bug" size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-text">{d.filePath.split('/').pop()}</span>
                <span className="block truncate text-[10.5px] text-text-subtle">{d.filePath} · {d.category}</span>
              </span>
              <Badge tone={DECISION_TONE[d.decision.status] ?? 'neutral'}>{d.decision.status}</Badge>
            </button>
          )}
        />
      )}
    </PanelBody>
  );
}
