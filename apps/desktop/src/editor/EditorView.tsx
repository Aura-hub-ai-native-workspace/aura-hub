import { motion } from 'framer-motion';
import { spring } from '@aura/core';
import { Icon } from '@aura/ui';
import { BreadcrumbBar } from './BreadcrumbBar';
import { MonacoEditor } from './MonacoEditor';
import { useEditorStore } from './editorStore';
import { EmptyState } from '../components/EmptyState';
import type { WorkspaceActionId } from './actionSpecs';

/** Center-right — breadcrumb + Monaco, or a premium empty state when nothing is open. */
export function EditorView({
  projectName,
  onAction,
  onOpenPalette,
}: {
  projectName: string;
  onAction?: (id: WorkspaceActionId) => void;
  onOpenPalette?: () => void;
}) {
  const activePath = useEditorStore((s) => s.activePath);
  const file = useEditorStore((s) => (activePath ? s.openFiles[activePath] : undefined));
  const recentFiles = useEditorStore((s) => s.recentFiles);
  const openFile = useEditorStore((s) => s.openFile);

  if (!activePath || !file) {
    return (
      <div className="grid h-full place-items-center">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle} className="max-w-sm text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line bg-surface text-text-subtle">
            <Icon name="code" size={24} />
          </div>
          <div className="text-[15px] font-semibold text-text">No file open</div>
          <p className="mx-auto mt-1.5 max-w-xs text-[12.5px] leading-relaxed text-text-muted">
            Pick a file from the Explorer to start editing.
          </p>
          {recentFiles.length > 0 && (
            <div className="mx-auto mt-6 max-w-[280px] space-y-1 text-left">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Recent</div>
              {recentFiles.slice(0, 6).map((path) => (
                <button
                  key={path}
                  onClick={() => void openFile({ path, name: path.split('/').pop() ?? path })}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
                >
                  <Icon name="file" size={13} className="shrink-0 text-text-subtle" />
                  <span className="truncate">{path}</span>
                </button>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BreadcrumbBar path={file.path} projectName={projectName} />
      <div className="relative min-h-0 flex-1">
        {file.loading ? (
          <div className="grid h-full place-items-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
          </div>
        ) : file.error ? (
          <div className="grid h-full place-items-center">
            <EmptyState icon="close" title="Couldn't open this file" description={file.error} compact />
          </div>
        ) : (
          // Mounted only once real content is in hand. @monaco-editor/react's
          // controlled `value` sync has a race across the loading -> loaded
          // transition (its first sync effect after mount is intentionally a
          // no-op, matching a `useUpdateEffect` pattern) — mounting while
          // content is still '' can leave the model permanently empty even
          // after the real text arrives. Never mounting until content is
          // final sidesteps the race entirely.
          <MonacoEditor path={file.path} onAction={onAction} onOpenPalette={onOpenPalette} />
        )}
      </div>
    </div>
  );
}
