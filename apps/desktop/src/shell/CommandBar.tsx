import { NAV_TITLES, useAppStore, cn } from '@aura/core';
import { Icon, IconButton, Tooltip } from '@aura/ui';
import { useWorkspace } from '../data/useWorkspace';
import { useUnreadCount } from '../ops/useNotificationsFeed';
import { useLayoutStore } from '../ops/layoutStore';

/**
 * Top command / search bar. The search field is a *portal* into the
 * command palette — clicking it (or ⌘K) opens the universal action
 * surface. Also hosts the breadcrumb and quick view controls.
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
  const setNav = useAppStore((s) => s.setNav);
  const unread = useUnreadCount();
  const openPanel = useLayoutStore((s) => s.openPanel);

  const project = useWorkspace((s) => s.projects.find((p) => p.id === activeProjectId));

  const openNotifications = () => {
    setNav('workspace');
    openPanel('notifications');
  };

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
        <Tooltip content="Notifications">
          <button
            onClick={openNotifications}
            className="relative grid h-7 w-7 place-items-center rounded-lg text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
            aria-label="Open notification center"
          >
            <Icon name="bell" size={16} />
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[9px] font-bold leading-none text-white">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        </Tooltip>
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
