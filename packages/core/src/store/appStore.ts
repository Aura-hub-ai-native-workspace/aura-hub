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
const ONBOARDED_KEY = 'aura-onboarded';

/** Read the persisted theme so a relaunch (and its boot) respects it. */
function initialTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'light';
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
}

/** First-run onboarding only ever plays once per install. */
function initialOnboarded(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(ONBOARDED_KEY) === 'true';
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
  /** Whether the first-run onboarding experience has been completed. */
  onboarded: boolean;
  /** Recently-run command ids (most-recent first) — powers the palette. */
  recentCommandIds: string[];
  /** Active theme (also reflected on <html data-theme>). */
  theme: Theme;

  setNav: (nav: NavKey) => void;
  setBooted: (booted: boolean) => void;
  /** Marks onboarding complete (persisted) and skips the redundant generic
   *  boot animation this one time — the onboarding's own Ready screen
   *  already served as this launch's cinematic boot moment. */
  completeOnboarding: () => void;
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
  sidebarExpanded: false,
  rightPanelOpen: false,
  paletteOpen: false,
  booted: false,
  onboarded: initialOnboarded(),
  recentCommandIds: [],
  theme: initialTheme(),

  setBooted: (booted) => set({ booted }),
  completeOnboarding: () => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(ONBOARDED_KEY, 'true');
    set({ onboarded: true, booted: true });
  },
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
