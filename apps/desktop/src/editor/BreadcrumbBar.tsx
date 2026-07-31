import { Icon } from '@aura/ui';
import { useEditorStore } from './editorStore';

/** Path trail for the active file. Folder crumbs reveal that folder in the Explorer. */
export function BreadcrumbBar({ path, projectName }: { path: string; projectName: string }) {
  const setSidebarView = useEditorStore((s) => s.setSidebarView);
  const toggleExpanded = useEditorStore((s) => s.toggleExpanded);
  const expanded = useEditorStore((s) => s.expanded);

  const segments = path.split('/');
  const dirs = segments.slice(0, -1);

  function revealFolder(depth: number) {
    setSidebarView('explorer');
    const ancestorPath = dirs.slice(0, depth + 1).join('/');
    if (!expanded[ancestorPath]) toggleExpanded(ancestorPath);
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-3 text-[12px] text-text-subtle">
      <span className="font-medium text-text-muted">{projectName}</span>
      {dirs.map((seg, i) => (
        <span key={i} className="flex items-center gap-1">
          <Icon name="chevron-right" size={11} className="shrink-0 text-text-subtle" />
          <button onClick={() => revealFolder(i)} className="rounded px-1 py-0.5 transition-colors hover:bg-surface-hover hover:text-text">
            {seg}
          </button>
        </span>
      ))}
      <Icon name="chevron-right" size={11} className="shrink-0 text-text-subtle" />
      <span className="font-medium text-text">{segments[segments.length - 1]}</span>
    </div>
  );
}
