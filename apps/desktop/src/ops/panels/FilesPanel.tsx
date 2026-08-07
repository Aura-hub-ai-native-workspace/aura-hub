/**
 * FilesPanel — a file browser/search over the active project's real
 * filesystem (via the Code Workspace's desktop fs bridge). Opens files
 * in the editor. Read-only search.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon, Input } from '@aura/ui';
import { useWorkspace } from '../../data/useWorkspace';
import { useEditorStore } from '../../editor/editorStore';
import type { FileTreeNode } from '../../editor/editorTypes';
import { useAppStore } from '@aura/core';
import { EmptyState } from '../../components/EmptyState';
import { VirtualList } from '../../editor/VirtualList';
import { PanelBody, PanelHeader } from '../panelFrame';

export default function FilesPanel() {
  const openId = useWorkspace((s) => s.openId);
  const project = useWorkspace((s) => s.projects.find((p) => p.id === s.openId));
  const [q, setQ] = useState('');
  const [results, setResults] = useState<FileTreeNode[]>([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const debounce = useRef<number | null>(null);

  useEffect(() => {
    const editor = useEditorStore.getState();
    if (editor.projectId !== openId && openId && project) {
      void editor.init(openId, project.path);
    }
  }, [openId, project]);

  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current);
    const query = q.trim();
    if (!query) {
      setResults([]);
      setMessage(null);
      return;
    }
    setSearching(true);
    debounce.current = window.setTimeout(async () => {
      try {
        const editor = useEditorStore.getState();
        if (!editor.root || editor.desktopAvailable !== true) {
          setMessage('File search needs desktop file access (Tauri).');
          setResults([]);
          return;
        }
        const res = await editor.searchFiles(query);
        setResults(res);
        setMessage(res.length === 0 ? 'No matching files.' : null);
      } catch (e) {
        setMessage((e as Error).message);
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 180);
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current);
    };
  }, [q]);

  const openFile = (node: FileTreeNode) => {
    const editor = useEditorStore.getState();
    void editor.openFile(node);
    const app = useAppStore.getState();
    app.openProject(openId ?? '');
    app.setProjectTab('code');
  };

  if (!openId || !project) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState compact icon="folder" title="Open a project to browse files" />
      </div>
    );
  }

  return (
    <PanelBody padded={false} className="flex flex-col">
      <div className="px-3 pt-3">
        <PanelHeader title="Files" hint={project.name} />
        <Input
          icon="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files by name…"
          inputSize="sm"
          suffix={searching ? <span className="h-3 w-3 animate-spin rounded-full border border-accent border-t-transparent" /> : undefined}
        />
      </div>
      {message && <p className="px-4 py-6 text-center text-[11.5px] text-text-subtle">{message}</p>}
      {results.length > 0 && (
        <VirtualList
          items={results}
          itemHeight={36}
          className="min-h-0 flex-1"
          renderItem={(node) => (
            <button
              onClick={() => openFile(node)}
              className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left transition-colors hover:bg-surface-hover"
            >
              <Icon name={node.isDir ? 'folder' : 'file'} size={13} className="text-text-subtle" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-text">{node.path}</span>
            </button>
          )}
        />
      )}
    </PanelBody>
  );
}
