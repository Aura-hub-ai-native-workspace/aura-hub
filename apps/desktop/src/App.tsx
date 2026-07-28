import { useEffect } from 'react';
import { CommandPalette, useHotkey, useMediaQuery } from '@aura/ui';
import { useAppStore } from '@aura/core';
import { AppShell } from './shell/AppShell';
import { BootSequence } from './shell/BootSequence';
import { useCommands } from './shell/useCommands';

/**
 * App root. Owns global keyboard shortcuts, the command palette, and
 * responsive collapse of the chrome. All *screen* rendering is delegated
 * to <AppShell>. Intelligence is intentionally absent — this is the
 * environment only.
 */
export function App() {
  const commands = useCommands();
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);
  const theme = useAppStore((s) => s.theme);
  const booted = useAppStore((s) => s.booted);
  const setBooted = useAppStore((s) => s.setBooted);
  const recentCommandIds = useAppStore((s) => s.recentCommandIds);
  const pushRecentCommand = useAppStore((s) => s.pushRecentCommand);

  // Keep <html data-theme> in sync (also set on first paint).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Global shortcuts — the environment's muscle memory.
  useHotkey('k', () => setPaletteOpen(!paletteOpen), { meta: true, allowInInput: true });
  useHotkey('b', () => toggleSidebar(), { meta: true });
  useHotkey('.', () => toggleRightPanel(), { meta: true });

  // Auto-collapse the chrome on narrow viewports (responsive behavior).
  const isNarrow = useMediaQuery('(max-width: 1024px)');
  const setChrome = useAppStore.setState;
  useEffect(() => {
    if (isNarrow) setChrome({ sidebarExpanded: false, rightPanelOpen: false });
  }, [isNarrow, setChrome]);

  return (
    <>
      {/* The environment is always mounted underneath, so the boot
          sequence dissolves *into* Home rather than cutting to it. */}
      <AppShell />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        recentIds={recentCommandIds}
        onRun={(cmd) => pushRecentCommand(cmd.id)}
      />
      {!booted && <BootSequence onComplete={() => setBooted(true)} />}
    </>
  );
}
