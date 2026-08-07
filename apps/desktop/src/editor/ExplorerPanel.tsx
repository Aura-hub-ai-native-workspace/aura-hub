import { useEffect, useState } from 'react';
import { Icon, IconButton, Input, type IconName } from '@aura/ui';
import { cn } from '@aura/core';
import { FileTree } from './FileTree';
import { useEditorStore } from './editorStore';
import type { ExplorerView, FileTreeNode } from './editorTypes';
import { EmptyState } from '../components/EmptyState';

const RAIL: { key: ExplorerView; icon: IconName; label: string }[] = [
  { key: 'explorer', icon: 'folder', label: 'Explorer' },
  { key: 'search', icon: 'search', label: 'Search' },
  { key: 'bookmarks', icon: 'bookmark', label: 'Bookmarks' },
  { key: 'git', icon: 'git-branch', label: 'Source Control' },
  { key: 'knowledge', icon: 'knowledge', label: 'Knowledge Fabric' },
];

const TITLES: Record<ExplorerView, string> = {
  explorer: 'Explorer',
  search: 'Search',
  bookmarks: 'Bookmarks',
  git: 'Source Control',
  knowledge: 'Knowledge Fabric',
};

/** Left Sidebar — Explorer, Search, Bookmarks, and two reserved spaces. */
export function ExplorerPanel() {
  const sidebarView = useEditorStore((s) => s.sidebarView);
  const setSidebarView = useEditorStore((s) => s.setSidebarView);
  const refreshDir = useEditorStore((s) => s.refreshDir);

  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface/40 py-2">
        {RAIL.map((r) => (
          <IconButton
            key={r.key}
            icon={r.icon}
            label={r.label}
            size="sm"
            active={sidebarView === r.key}
            onClick={() => setSidebarView(r.key)}
          />
        ))}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center justify-between px-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">{TITLES[sidebarView]}</span>
          {sidebarView === 'explorer' && (
            <IconButton icon="refresh" label="Refresh" size="sm" onClick={() => void refreshDir('')} />
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {sidebarView === 'explorer' && <FileTree />}
          {sidebarView === 'search' && <SearchView />}
          {sidebarView === 'bookmarks' && <BookmarksView />}
          {sidebarView === 'git' && (
            <PlaceholderView icon="git-branch" title="Source control" description="Git integration — status, diffs and commits — is coming soon." />
          )}
          {sidebarView === 'knowledge' && (
            <PlaceholderView icon="knowledge" title="Knowledge Fabric" description="Live links to related entities, god nodes and communities land here next." />
          )}
        </div>
      </div>
    </div>
  );
}

function SearchView() {
  const searchFiles = useEditorStore((s) => s.searchFiles);
  const openFile = useEditorStore((s) => s.openFile);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    setLoading(true);
    const handle = setTimeout(() => {
      void searchFiles(q).then((r) => {
        setResults(r);
        setLoading(false);
      });
    }, 220);
    return () => clearTimeout(handle);
  }, [query, searchFiles]);

  return (
    <div className="flex h-full flex-col px-2.5 py-2">
      <Input
        icon="search"
        inputSize="sm"
        placeholder="Search files by name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-2 shrink-0"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!query.trim() ? (
          <p className="px-1 py-6 text-center text-[12px] text-text-subtle">Type to search filenames across the project.</p>
        ) : loading ? (
          <div className="space-y-1.5 px-1 py-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[22px] animate-pulse rounded-md bg-surface-active/60" />
            ))}
          </div>
        ) : results.length === 0 ? (
          <p className="px-1 py-6 text-center text-[12px] text-text-subtle">No files match “{query}”.</p>
        ) : (
          <div className="space-y-0.5">
            {results.map((node) => (
              <button
                key={node.path}
                onClick={() => void openFile(node)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
                title={node.path}
              >
                <Icon name="file" size={14} className="shrink-0 text-text-subtle" />
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                <span className="shrink-0 truncate font-mono text-[10.5px] text-text-subtle">{node.path}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BookmarksView() {
  const bookmarks = useEditorStore((s) => s.bookmarks);
  const toggleBookmark = useEditorStore((s) => s.toggleBookmark);
  const openFile = useEditorStore((s) => s.openFile);

  if (bookmarks.length === 0) {
    return <EmptyState icon="bookmark" title="No bookmarks yet" description="Hover a file in the Explorer and click its bookmark icon to pin it here." compact />;
  }

  return (
    <div className="space-y-0.5 px-2 py-2">
      {bookmarks.map((path) => {
        const name = path.split('/').pop() ?? path;
        return (
          <div key={path} className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-text-muted hover:bg-surface-hover hover:text-text">
            <button onClick={() => void openFile({ path, name })} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={path}>
              <Icon name="file" size={14} className="shrink-0 text-text-subtle" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
            </button>
            <button
              onClick={() => toggleBookmark(path)}
              className="shrink-0 text-accent opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Remove bookmark"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function PlaceholderView({ icon, title, description }: { icon: IconName; title: string; description: string }) {
  return (
    <div className={cn('grid h-full place-items-center px-4')}>
      <EmptyState icon={icon} title={title} description={description} compact />
    </div>
  );
}
