/**
 * WorkspaceCanvas — the Workspace's window canvas.
 * ------------------------------------------------------------------
 * Everything here is a floating window (see FloatingWindow.tsx); there is
 * no dock tree, no tab stack, no split ratios. The header keeps exactly
 * three controls per the Workspace V2 design: New Window (a launcher
 * popover built from the same Tools catalog as the shelf, plus optional
 * templates), a Layout selector (named, explicitly-saved arrangements),
 * and global search — which is the app's existing ⌘K command bar, not
 * duplicated here.
 *
 * Workspace V3 additions: a live canvas size (feeds smart placement in
 * layoutStore.ts), a dock-style window tray showing every open window
 * (not just minimized ones), and a deterministic, dismissible suggestion
 * nudge — never applied automatically.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon, Menu } from '@aura/ui';
import type { IconName } from '@aura/ui';
import { PANEL_META, persistPresets, useLayoutStore, type PanelKind, type WindowState } from './layoutStore';
import { FloatingWindow } from './FloatingWindow';
import { TOOL_CATEGORIES } from './toolCategories';
import { ToolCategoryGroup } from './ToolCategoryGroup';
import { WORKSPACE_TEMPLATES } from './workspaceIntelligence';

export function WorkspaceCanvas() {
  const windows = useLayoutStore((s) => s.windows);
  const presets = useLayoutStore((s) => s.presets);
  const setCanvasSize = useLayoutStore((s) => s.setCanvasSize);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => persistPresets(presets), [presets]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setCanvasSize(width, height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [setCanvasSize]);

  const empty = windows.length === 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-app">
      <WorkspaceHeader />
      <div ref={canvasRef} className="relative min-h-0 flex-1 overflow-hidden">
        {empty ? (
          <div className="grid h-full place-items-center">
            <div className="text-center">
              <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl border border-line bg-surface text-text-subtle">
                <Icon name="layout" size={24} />
              </div>
              <p className="text-[14px] font-semibold text-text">This workspace is empty</p>
              <p className="mx-auto mt-1 max-w-xs text-[12px] text-text-muted">
                Launch a tool from the shelf on the left, or open New Window above, to place your first window.
              </p>
            </div>
          </div>
        ) : (
          <AnimatePresence>
            {windows.map((w) => <FloatingWindow key={w.id} window={w} canvasRef={canvasRef} />)}
          </AnimatePresence>
        )}
        <SuggestionNudge />
        <WindowTray />
      </div>
    </div>
  );
}

/* ── window tray — dock-style, shows every window ────────────────── */

function WindowTray() {
  const windows = useLayoutStore((s) => s.windows);
  const focusedWindowId = useLayoutStore((s) => s.focusedWindowId);
  const focusWindow = useLayoutStore((s) => s.focusWindow);
  const minimizeWindow = useLayoutStore((s) => s.minimizeWindow);
  const closeWindow = useLayoutStore((s) => s.closeWindow);
  const reorderWindows = useLayoutStore((s) => s.reorderWindows);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  if (windows.length === 0) return null;

  const handleClick = (w: WindowState) => {
    if (w.minimized) focusWindow(w.id);
    else if (focusedWindowId === w.id) minimizeWindow(w.id);
    else focusWindow(w.id);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center pb-2">
      <div className="pointer-events-auto flex items-end gap-1 rounded-2xl border border-line bg-surface/90 p-1.5 shadow-lg backdrop-blur-xl">
        {windows.map((w) => {
          const meta = PANEL_META[w.kind];
          const active = focusedWindowId === w.id && !w.minimized;
          return (
            <div
              key={w.id}
              className="relative flex flex-col items-center"
              draggable
              onDragStart={(e) => { setDragId(w.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && dragId !== w.id) reorderWindows(dragId, w.id);
                setDragId(null);
              }}
              onDragEnd={() => setDragId(null)}
              onMouseEnter={() => setHoverId(w.id)}
              onMouseLeave={() => setHoverId((h) => (h === w.id ? null : h))}
            >
              <AnimatePresence>
                {hoverId === w.id && (
                  <motion.div
                    initial={{ opacity: 0, y: 6, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.95 }}
                    transition={spring.snappy}
                    className="pointer-events-auto absolute bottom-full mb-2 flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface py-1.5 pl-2.5 pr-1.5 text-[11px] font-medium text-text shadow-lg"
                  >
                    {meta.label}
                    {w.minimized && <span className="text-text-subtle">· minimized</span>}
                    <button
                      onClick={(e) => { e.stopPropagation(); closeWindow(w.id); }}
                      title={`Close ${meta.label}`}
                      className="grid h-4 w-4 shrink-0 place-items-center rounded text-text-subtle transition-colors hover:bg-surface-hover hover:text-text"
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
              <button
                onClick={() => handleClick(w)}
                title={meta.label}
                className={cn(
                  'relative grid h-9 w-9 place-items-center rounded-xl outline-none transition-all hover:scale-105 focus-visible:ring-2 focus-visible:ring-accent/50',
                  active ? 'bg-accent/15 text-accent-700 dark:text-accent-200' : 'text-text-muted hover:bg-surface-hover hover:text-text',
                  dragId === w.id && 'opacity-50',
                )}
              >
                <Icon name={meta.icon as IconName} size={16} />
                {w.hasUnread && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-danger" />}
              </button>
              <span className={cn('mt-1 h-1 w-1 rounded-full bg-accent transition-opacity', active ? 'opacity-100' : 'opacity-0')} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── suggestion nudge — deterministic, dismissible, never automatic ── */

function SuggestionNudge() {
  const suggestion = useLayoutStore((s) => s.suggestion);
  const dismissSuggestion = useLayoutStore((s) => s.dismissSuggestion);
  const openPanel = useLayoutStore((s) => s.openPanel);

  useEffect(() => {
    if (!suggestion) return;
    const t = window.setTimeout(dismissSuggestion, 7000);
    return () => window.clearTimeout(t);
  }, [suggestion, dismissSuggestion]);

  return (
    <AnimatePresence>
      {suggestion && (
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.97 }}
          transition={spring.smooth}
          className="pointer-events-auto absolute bottom-16 right-3 z-30 w-64 rounded-2xl border border-line bg-surface p-3 shadow-lg backdrop-blur-xl"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <p className="text-[12px] font-medium text-text">
              {suggestion.suggestKinds.length > 1
                ? `Open ${PANEL_META[suggestion.suggestKinds[0]].label} and ${suggestion.suggestKinds.length - 1} more?`
                : `Open ${PANEL_META[suggestion.suggestKinds[0]].label}?`}
            </p>
            <button
              onClick={dismissSuggestion}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-subtle transition-colors hover:bg-surface-hover hover:text-text"
            >
              <Icon name="close" size={11} />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestion.suggestKinds.map((kind) => (
              <button
                key={kind}
                onClick={() => openPanel(kind)}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-active px-2 py-1 text-[11px] font-medium text-text transition-colors hover:border-accent hover:text-accent"
              >
                <Icon name={PANEL_META[kind].icon as IconName} size={11} />
                {PANEL_META[kind].label}
              </button>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── header: New Window (+ templates) / Layout selector ──────────── */

function WorkspaceHeader() {
  const openPanel = useLayoutStore((s) => s.openPanel);
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-2">
      <span className="px-1.5 text-[12px] font-semibold text-text">Workspace</span>
      <NewWindowMenu onLaunch={openPanel} />
      <span className="hidden text-[10.5px] text-text-subtle sm:inline">drag to move · edges to resize · drag to an edge to snap</span>
      <div className="ml-auto">
        <LayoutSelector />
      </div>
    </div>
  );
}

/**
 * NewWindowMenu — the prominent "New Window" picker in the Workspace header.
 * Reuses the exact same category data and rendering (`TOOL_CATEGORIES` +
 * `ToolCategoryGroup`) as the persistent Tools shelf, rather than defining
 * a second tool list. Templates (optional, curated multi-window layouts)
 * live in the same popover rather than adding a fourth header control.
 */
function NewWindowMenu({ onLaunch }: { onLaunch: (kind: PanelKind) => void }) {
  const applyTemplate = useLayoutStore((s) => s.applyTemplate);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-accent-600"
      >
        <Icon name="plus" size={13} />
        New Window
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-2 max-h-[70vh] w-64 overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-lg"
        >
          {WORKSPACE_TEMPLATES.length > 0 && (
            <>
              <div className="px-2 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-subtle">Templates</div>
              <div className="mb-1 space-y-0.5">
                {WORKSPACE_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => { applyTemplate(t.id); setOpen(false); }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
                  >
                    <Icon name={t.icon as IconName} size={15} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{t.label}</span>
                      <span className="block truncate text-[10.5px] text-text-subtle">{t.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="my-1 h-px bg-line" />
            </>
          )}
          {TOOL_CATEGORIES.map((category) => (
            <ToolCategoryGroup
              key={category.id}
              category={category}
              railExpanded
              onLaunch={(kind) => {
                onLaunch(kind);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LayoutSelector() {
  const savePreset = useLayoutStore((s) => s.savePreset);
  const loadPreset = useLayoutStore((s) => s.loadPreset);
  const removePreset = useLayoutStore((s) => s.removePreset);
  const presets = useLayoutStore((s) => s.presets);
  const closeAll = useLayoutStore((s) => s.closeAll);
  const [name, setName] = useState('');
  const presetNames = Object.keys(presets);

  const save = () => {
    const n = name.trim();
    if (!n) return;
    savePreset(n);
    setName('');
  };

  return (
    <div className="flex items-center gap-1.5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        placeholder="Save layout as…"
        className="h-7 w-32 rounded-lg border border-line bg-surface px-2 text-[11px] text-text outline-none transition-colors placeholder:text-text-subtle focus:border-accent"
      />
      <Menu
        align="end"
        trigger={<ToolbarButton icon="layout" label={presetNames.length ? `Layouts · ${presetNames.length}` : 'Layouts'} />}
        items={[
          { id: 'save', label: name.trim() ? `Save "${name.trim()}"` : 'Save current layout', icon: 'plus' as IconName, onSelect: save },
          'separator',
          ...(presetNames.length === 0
            ? [{ id: 'none', label: 'No saved layouts yet', onSelect: () => {} }]
            : presetNames.flatMap((n) => [
                { id: `load:${n}`, label: `Load "${n}"`, icon: 'layout' as IconName, onSelect: () => loadPreset(n) },
              ])),
          ...(presetNames.length === 0
            ? []
            : ['separator' as const, ...presetNames.map((n) => ({
                id: `del:${n}`,
                label: `Delete "${n}"`,
                icon: 'close' as IconName,
                tone: 'danger' as const,
                onSelect: () => removePreset(n),
              }))]),
          'separator',
          { id: 'close-all', label: 'Close all windows', icon: 'close' as IconName, tone: 'danger' as const, onSelect: closeAll },
        ]}
      />
    </div>
  );
}

function ToolbarButton({ icon, label }: { icon: IconName; label: string }) {
  return (
    <span className="flex h-7 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[11px] font-medium text-text-muted transition-colors hover:border-line-strong hover:bg-surface-hover hover:text-text">
      <Icon name={icon} size={13} />
      <span className="hidden md:inline">{label}</span>
    </span>
  );
}
