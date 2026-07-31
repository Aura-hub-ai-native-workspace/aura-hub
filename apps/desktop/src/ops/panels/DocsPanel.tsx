/**
 * DocsPanel — a documentation browser over the active project's
 * architecture docs and knowledge-fabric doc nodes. Read-only; opening
 * a doc loads it in the Code Workspace.
 */
import { useMemo } from 'react';
import { Icon } from '@aura/ui';
import { useWorkspace } from '../../data/useWorkspace';
import { useEditorStore } from '../../editor/editorStore';
import { useAppStore } from '@aura/core';
import { EmptyState } from '../../components/EmptyState';
import { VirtualList } from '../../editor/VirtualList';
import { PanelBody, PanelHeader } from '../panelFrame';

interface DocRow {
  id: string;
  title: string;
  relPath: string;
  source: 'architecture' | 'fabric';
}

export default function DocsPanel() {
  const openId = useWorkspace((s) => s.openId);
  const profile = useWorkspace((s) => s.profile);
  const kg = useWorkspace((s) => s.kg);

  const rows = useMemo<DocRow[]>(() => {
    const out: DocRow[] = [];
    if (profile) {
      for (const d of profile.architectureDocs) {
        out.push({ id: `arch:${d.relPath}`, title: d.title, relPath: d.relPath, source: 'architecture' });
      }
    }
    if (kg) {
      for (const n of kg.nodes) {
        if (!/doc|readme|manual|guide/i.test(n.type) || !n.relPath) continue;
        out.push({ id: `fabric:${n.id}`, title: n.label, relPath: n.relPath, source: 'fabric' });
      }
    }
    return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }, [profile, kg]);

  const openDoc = (row: DocRow) => {
    const editor = useEditorStore.getState();
    if (editor.projectId) void editor.openFile({ path: row.relPath, name: row.title });
    const app = useAppStore.getState();
    app.openProject(openId ?? '');
    app.setProjectTab('code');
  };

  if (!openId) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState compact icon="doc" title="Open a project to browse documentation" />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState compact icon="doc" title="No documentation indexed yet" description="Docs appear here once the project is indexed and analyzed." />
      </div>
    );
  }

  return (
    <PanelBody padded={false} className="flex flex-col">
      <div className="px-3 pt-3">
        <PanelHeader title="Documentation" hint={`${rows.length} documents`} />
      </div>
      <VirtualList
        items={rows}
        itemHeight={42}
        className="min-h-0 flex-1"
        renderItem={(row) => (
          <button
            onClick={() => openDoc(row)}
            className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left transition-colors hover:bg-surface-hover"
          >
            <Icon name="doc" size={13} className="text-text-subtle" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-text">{row.title}</span>
              <span className="block truncate text-[10px] text-text-subtle">{row.relPath}</span>
            </span>
          </button>
        )}
      />
    </PanelBody>
  );
}
