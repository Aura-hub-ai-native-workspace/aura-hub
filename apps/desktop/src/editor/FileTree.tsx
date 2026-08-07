import { useMemo } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import { VirtualList } from './VirtualList';
import { colorForPath } from './fileIcons';
import { useEditorStore, type DirState } from './editorStore';
import type { FileTreeNode } from './editorTypes';
import { EmptyState } from '../components/EmptyState';

const ROW_HEIGHT = 28;

interface Row {
  node: FileTreeNode;
  depth: number;
}

/** Depth-first flatten of the lazily-loaded tree, respecting `expanded`. */
function flatten(
  children: FileTreeNode[],
  dirs: Record<string, DirState>,
  expanded: Record<string, boolean>,
  depth: number,
  out: Row[],
) {
  for (const node of children) {
    out.push({ node, depth });
    if (node.isDir && expanded[node.path]) {
      const dir = dirs[node.path];
      if (dir?.status === 'loaded') flatten(dir.children, dirs, expanded, depth + 1, out);
    }
  }
}

export function FileTree() {
  const dirs = useEditorStore((s) => s.dirs);
  const expanded = useEditorStore((s) => s.expanded);
  const activePath = useEditorStore((s) => s.activePath);
  const bookmarks = useEditorStore((s) => s.bookmarks);
  const toggleExpanded = useEditorStore((s) => s.toggleExpanded);
  const openFile = useEditorStore((s) => s.openFile);
  const toggleBookmark = useEditorStore((s) => s.toggleBookmark);

  const root = dirs[''];
  const rows = useMemo(() => {
    const out: Row[] = [];
    if (root?.status === 'loaded') flatten(root.children, dirs, expanded, 0, out);
    return out;
  }, [root, dirs, expanded]);

  if (!root || root.status === 'loading') {
    return (
      <div className="space-y-1 px-2 py-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-[22px] animate-pulse rounded-md bg-surface-active/60" style={{ marginLeft: (i % 3) * 14 }} />
        ))}
      </div>
    );
  }

  if (root.status === 'error') {
    return <EmptyState icon="folder" title="Couldn't read this project" description={root.error} compact />;
  }

  if (rows.length === 0) {
    return <EmptyState icon="folder" title="Empty project" description="No files found in this folder." compact />;
  }

  return (
    <VirtualList
      items={rows}
      itemHeight={ROW_HEIGHT}
      className="h-full flex-1 overflow-y-auto px-1.5 py-1.5"
      renderItem={({ node, depth }) => {
        const isOpenDir = node.isDir && expanded[node.path];
        const isActive = !node.isDir && activePath === node.path;
        const isBookmarked = bookmarks.includes(node.path);
        return (
          <button
            onClick={() => (node.isDir ? toggleExpanded(node.path) : void openFile(node))}
            className={cn(
              'group flex w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[12.5px] transition-colors',
              isActive ? 'bg-accent-50 text-accent-700 dark:bg-accent/15 dark:text-accent-200' : 'text-text-muted hover:bg-surface-hover hover:text-text',
            )}
            style={{ paddingLeft: 6 + depth * 14, height: ROW_HEIGHT }}
            title={node.path}
          >
            {node.isDir ? (
              <Icon name="chevron-right" size={12} className={cn('shrink-0 text-text-subtle transition-transform', isOpenDir && 'rotate-90')} />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {node.isDir ? (
              <Icon name="folder" size={14} className="shrink-0 text-text-subtle" />
            ) : (
              <span className="relative grid h-3.5 w-3.5 shrink-0 place-items-center text-text-subtle">
                <Icon name="file" size={14} />
                <span
                  className="absolute bottom-[1px] right-[-2px] h-1.5 w-1.5 rounded-full ring-2 ring-surface"
                  style={{ background: colorForPath(node.name) }}
                />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {!node.isDir && (
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleBookmark(node.path);
                }}
                className={cn(
                  'shrink-0 opacity-0 transition-opacity group-hover:opacity-100',
                  isBookmarked && 'opacity-100 text-accent',
                )}
              >
                <Icon name="bookmark" size={12} />
              </span>
            )}
          </button>
        );
      }}
    />
  );
}
