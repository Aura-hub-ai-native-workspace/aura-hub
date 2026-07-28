/**
 * AURA Hub — Global Environment Store
 * ------------------------------------------------------------------
 * A single, small Zustand store for *shell* state only (navigation,
 * chrome visibility, theme). Feature/domain state should live in its
 * own store beside its module — this is intentionally not a god store.
 */

import { create } from 'zustand';
import type { NavKey, ProjectTab } from '../types';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'aura-theme';

/** Read the persisted theme so a relaunch (and its boot) respects it. */
function initialTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'light';
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
}

interface AppState {
  /** Active top-level destination. */
  nav: NavKey;
  /** Currently open project (when in the Projects workspace). */
  activeProjectId: string | null;
  /** Active tab within the project workspace. */
  projectTab: ProjectTab;
  /** Left rail expanded vs. rail-only. */
  sidebarExpanded: boolean;
  /** Right context panel visibility. */
  rightPanelOpen: boolean;
  /** Command palette open state. */
  paletteOpen: boolean;
  /** Whether the boot/intro sequence has finished. */
  booted: boolean;
  /** Recently-run command ids (most-recent first) — powers the palette. */
  recentCommandIds: string[];
  /** Active theme (also reflected on <html data-theme>). */
  theme: Theme;

  setNav: (nav: NavKey) => void;
  setBooted: (booted: boolean) => void;
  pushRecentCommand: (id: string) => void;
  openProject: (id: string) => void;
  closeProject: () => void;
  setProjectTab: (tab: ProjectTab) => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setPaletteOpen: (open: boolean) => void;
  toggleTheme: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  nav: 'home',
  activeProjectId: null,
  projectTab: 'overview',
  sidebarExpanded: true,
  rightPanelOpen: true,
  paletteOpen: false,
  booted: false,
  recentCommandIds: [],
  theme: initialTheme(),

  setBooted: (booted) => set({ booted }),
  pushRecentCommand: (id) =>
    set((s) => ({ recentCommandIds: [id, ...s.recentCommandIds.filter((x) => x !== id)].slice(0, 5) })),

  setNav: (nav) =>
    set((s) => ({
      nav,
      // Leaving the Projects section closes any open project workspace.
      activeProjectId: nav === 'projects' ? s.activeProjectId : null,
    })),
  openProject: (id) => set({ nav: 'projects', activeProjectId: id, projectTab: 'overview' }),
  closeProject: () => set({ activeProjectId: null }),
  setProjectTab: (projectTab) => set({ projectTab }),
  toggleSidebar: () => set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  toggleTheme: () =>
    set((s) => {
      const theme = s.theme === 'light' ? 'dark' : 'light';
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', theme);
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(THEME_KEY, theme);
      }
      return { theme };
    }),
}));
