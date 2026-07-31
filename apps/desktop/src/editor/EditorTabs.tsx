import { motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon } from '@aura/ui';
import { useEditorStore } from './editorStore';
import { colorForPath } from './fileIcons';

/** Center — the open-file tab strip. Dirty dot replaces the close × on hover-out, matches on hover-in. */
export function EditorTabs() {
  const openOrder = useEditorStore((s) => s.openOrder);
  const openFiles = useEditorStore((s) => s.openFiles);
  const activePath = useEditorStore((s) => s.activePath);
  const setActivePath = useEditorStore((s) => s.setActivePath);
  const closeFile = useEditorStore((s) => s.closeFile);

  if (openOrder.length === 0) return <div className="h-full" />;

  return (
    <div className="flex h-full items-center gap-0.5 overflow-x-auto px-1.5">
      {openOrder.map((path) => {
        const file = openFiles[path];
        if (!file) return null;
        const active = path === activePath;
        return (
          <div
            key={path}
            onClick={() => setActivePath(path)}
            className={cn(
              'group relative flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[12.5px] transition-colors',
              active ? 'bg-surface text-text shadow-xs' : 'text-text-muted hover:bg-surface-hover hover:text-text',
            )}
            title={file.path}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: colorForPath(file.path) }} />
            <span className="max-w-[140px] truncate">{file.name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeFile(path);
              }}
              className="relative grid h-4 w-4 shrink-0 place-items-center rounded text-text-subtle hover:bg-surface-active hover:text-text"
              aria-label={`Close ${file.name}`}
            >
              <Icon name="close" size={11} className="opacity-0 transition-opacity group-hover:opacity-100" />
              {file.dirty && (
                <span className="absolute h-1.5 w-1.5 rounded-full bg-current opacity-70 transition-opacity group-hover:opacity-0" />
              )}
            </button>
            {active && (
              <motion.span layoutId="code-tab-indicator" transition={spring.smooth} className="absolute inset-x-2 -bottom-[5px] h-0.5 rounded-full bg-accent" />
            )}
          </div>
        );
      })}
    </div>
  );
}
