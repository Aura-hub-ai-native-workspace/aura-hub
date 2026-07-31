import { useEffect } from 'react';
import { CommandPalette, useHotkey, useMediaQuery } from '@aura/ui';
import { useAppStore } from '@aura/core';
import { AppShell } from './shell/AppShell';
import { BootSequence } from './shell/BootSequence';
import { useCommands } from './shell/useCommands';
import { OnboardingFlow } from './onboarding/OnboardingFlow';
import { useWorkspace } from './data/useWorkspace';
import { useEditorStore } from './editor/editorStore';
import { useLayoutStore } from './ops/layoutStore';
import { useNotificationsFeed } from './ops/useNotificationsFeed';
import { restoreSession, saveSession } from './ops/session';

/**
 * App root. Owns global keyboard shortcuts, the command palette,
 * responsive collapse of the chrome, the notification feed poll, and
 * workspace session persistence (restore on launch, save on change).
 * All *screen* rendering is delegated to <AppShell>. Intelligence is
 * intentionally absent — this is the environment only.
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
  const onboarded = useAppStore((s) => s.onboarded);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const recentCommandIds = useAppStore((s) => s.recentCommandIds);
  const pushRecentCommand = useAppStore((s) => s.pushRecentCommand);

  // The notification feed: polls real engine state, derives persisted,
  // deduplicated notifications (Part 2).
  useNotificationsFeed();

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

  // Boot: refresh the project library, then restore the last session
  // (selected project, open editor tabs, mission focus).
  useEffect(() => {
    let alive = true;
    const boot = async () => {
      await useWorkspace.getState().refresh();
      if (!alive) return;
      await restoreSession();
    };
    void boot();
    return () => {
      alive = false;
    };
  }, []);

  // Persist the session whenever the shape of "where you left off"
  // changes: selected project, focus, or the editor's open tabs.
  useEffect(() => {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const unsubs = [
      useWorkspace.subscribe((s, p) => { if (s.openId !== p.openId) saveSession(); }),
      useLayoutStore.subscribe((s, p) => { if (!same(s.focused, p.focused)) saveSession(); }),
      useEditorStore.subscribe((s, p) => {
        if (!same(s.openOrder, p.openOrder) || s.activePath !== p.activePath) saveSession();
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

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
      {!onboarded ? (
        <OnboardingFlow onComplete={completeOnboarding} />
      ) : (
        !booted && <BootSequence onComplete={() => setBooted(true)} />
      )}
    </>
  );
}
