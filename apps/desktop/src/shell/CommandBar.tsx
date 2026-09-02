import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { NAV_TITLES, useAppStore, cn, popVariants } from '@aura/core';
import { Icon, IconButton, Tooltip } from '@aura/ui';
import { useWorkspace } from '../data/useWorkspace';
import { useUnreadCount } from '../ops/useNotificationsFeed';
import { NotificationCenter } from '../ops/NotificationCenter';

/**
 * Top command / search bar. The search field is a *portal* into the
 * command palette — clicking it (or ⌘K) opens the universal action
 * surface. Also hosts the breadcrumb and quick view controls.
 *
 * Notifications are deliberately ambient chrome, not a dockable Workspace
 * tool: the bell shows an unread badge and opens a small popover (the
 * same NotificationCenter the old dockable panel used), never a full
 * inbox panel a user has to arrange windows around.
 *
 * That popover is **portaled to `document.body`**, like every other
 * floating surface in AURA (Dialog, CommandPalette, Toast,
 * WindowSwitcher). It has to be: this header carries `backdrop-blur-xl`,
 * and `backdrop-filter` creates a stacking context, so a popover rendered
 * inside the header is trapped in it. `<main>` is a *later sibling* of the
 * header, so it paints on top of the header's entire subtree no matter how
 * large the popover's own z-index is — raising it would change nothing.
 * Portaling is the fix; the z-layer below only orders it against the other
 * portaled surfaces.
 */
export function CommandBar() {
  const nav = useAppStore((s) => s.nav);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const closeProject = useAppStore((s) => s.closeProject);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);
  const theme = useAppStore((s) => s.theme);
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const unread = useUnreadCount();
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** Viewport coordinates for the portaled popover, anchored to the bell. */
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const project = useWorkspace((s) => s.projects.find((p) => p.id === activeProjectId));

  // The popover lives outside this subtree, so it cannot inherit the bell's
  // position — it is measured from the bell and re-measured whenever the
  // viewport moves under it.
  const place = useCallback(() => {
    const el = notifRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, []);

  useLayoutEffect(() => {
    if (!notifOpen) return;
    place();
    window.addEventListener('resize', place);
    // Capture phase: any scrolling container in the app can shift the bell,
    // and scroll events from nested scrollers don't bubble to window.
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [notifOpen, place]);

  useEffect(() => {
    if (!notifOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The bell toggles itself; the panel is no longer a DOM descendant of
      // the bell, so it must be checked separately or every click *inside*
      // the panel would close it on mousedown — before the click landed.
      if (notifRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setNotifOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNotifOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [notifOpen]);

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-surface/50 px-5 backdrop-blur-xl">
      {/* Breadcrumb */}
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <button
          onClick={() => project && closeProject()}
          className={cn('font-semibold text-text', project && 'text-text-muted hover:text-text transition-colors')}
        >
          {NAV_TITLES[nav]}
        </button>
        {project && (
          <>
            <Icon name="chevron-right" size={14} className="text-text-subtle" />
            <span className="truncate font-semibold text-text">{project.name}</span>
          </>
        )}
      </div>

      {/* Palette trigger */}
      <button
        onClick={() => setPaletteOpen(true)}
        className="group mx-auto flex h-9 w-full max-w-md items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 text-[13px] text-text-subtle transition-colors hover:border-line-strong hover:bg-surface-hover"
      >
        <Icon name="search" size={16} className="group-hover:text-text-muted" />
        <span className="flex-1 text-left">Search or run a command…</span>
        <span className="flex items-center gap-1">
          <kbd className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10px]">⌘</kbd>
          <kbd className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10px]">K</kbd>
        </span>
      </button>

      {/* View controls */}
      <div className="flex items-center gap-1">
        <Tooltip content="Toggle theme">
          <IconButton icon={theme === 'light' ? 'moon' : 'sun'} label="Toggle theme" size="sm" onClick={toggleTheme} />
        </Tooltip>
        <div ref={notifRef} className="relative">
          <Tooltip content="Notifications">
            <button
              onClick={() => setNotifOpen((v) => !v)}
              className="relative grid h-7 w-7 place-items-center rounded-lg text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
              aria-label="Notifications"
              aria-expanded={notifOpen}
            >
              <Icon name="bell" size={16} />
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[9px] font-bold leading-none text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </button>
          </Tooltip>
          {createPortal(
            <AnimatePresence>
              {notifOpen && anchor && (
                <motion.div
                  ref={popRef}
                  variants={popVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  style={{ top: anchor.top, right: anchor.right }}
                  // `flex flex-col` is load-bearing: it gives the inner
                  // PanelBody a shrinkable flex item inside the 70vh cap, so
                  // its `overflow-y-auto` actually engages. As a plain block
                  // the body sized to its content and the overflow was simply
                  // clipped, leaving later notifications unreachable.
                  className="fixed z-[90] flex max-h-[70vh] w-[360px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-lg"
                >
                  <NotificationCenter embedded onNavigate={() => setNotifOpen(false)} />
                </motion.div>
              )}
            </AnimatePresence>,
            document.body,
          )}
        </div>
        <Tooltip content="Context panel">
          <IconButton
            icon="panel"
            label="Toggle context panel"
            size="sm"
            active={rightPanelOpen}
            onClick={toggleRightPanel}
          />
        </Tooltip>
        <div className="ml-2 grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-accent to-accent-700 text-[12px] font-semibold text-white">
          A
        </div>
      </div>
    </header>
  );
}
