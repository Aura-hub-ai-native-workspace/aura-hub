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
  /** Whether "Ask AURA" is open full-screen inside the project. Lives here
   *  rather than in ProjectWorkspace's local state because the router needs
   *  it to switch the screen into a fixed-viewport layout — the chat owns
   *  its own internal scrolling, exactly like the Code Workspace. */
  askAuraOpen: boolean;
  /** Left rail expanded vs. rail-only. */
  sidebarExpanded: boolean;
  /** Right context panel visibility. */
  rightPanelOpen: boolean;
  /** Command palette open state. */
  paletteOpen: boolean;
  /** "Add a project" dialog open state — shared by Home's own button/tile
   *  and the command palette's "Add Project" command, so both trigger the
   *  same dialog instance instead of each owning a local copy. */
  addProjectDialogOpen: boolean;
  /** "Create project" dialog open state — a frontend-only scaffold flow,
   *  kept separate from "Add project" (which registers a real folder). */
  createProjectDialogOpen: boolean;
  /** Whether the boot/intro sequence has finished. */
  booted: boolean;
  /** Whether the first-run onboarding experience has been completed. */
  onboarded: boolean;
  /** Recently-run command ids (most-recent first) — powers the palette. */
  recentCommandIds: string[];
  /** Active theme (also reflected on <html data-theme>). */
  theme: Theme;

  setNav: (nav: NavKey) => void;
  setAskAuraOpen: (open: boolean) => void;
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
  openAddProjectDialog: () => void;
  closeAddProjectDialog: () => void;
  openCreateProjectDialog: () => void;
  closeCreateProjectDialog: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  nav: 'home',
  activeProjectId: null,
  projectTab: 'overview',
  askAuraOpen: false,
  sidebarExpanded: false,
  rightPanelOpen: false,
  paletteOpen: false,
  addProjectDialogOpen: false,
  createProjectDialogOpen: false,
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

  // Leaving a project — by navigating away, entering another one, or
  // closing it — always closes Ask AURA. It is a view *of* the project, so
  // it must never survive into a screen that project no longer backs.
  setNav: (nav) => set({ nav, activeProjectId: null, askAuraOpen: false }),
  // Project entry now lives on Home (the former standalone Projects
  // screen was folded into it) — opening a project always returns you to
  // Home once it's closed, rather than a dedicated "Projects" nav key.
  openProject: (id) => set({ nav: 'home', activeProjectId: id, projectTab: 'overview', askAuraOpen: false }),
  closeProject: () => set({ activeProjectId: null, askAuraOpen: false }),
  setProjectTab: (projectTab) => set({ projectTab }),
  setAskAuraOpen: (askAuraOpen) => set({ askAuraOpen }),
  toggleSidebar: () => set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  openAddProjectDialog: () => set({ addProjectDialogOpen: true }),
  closeAddProjectDialog: () => set({ addProjectDialogOpen: false }),
  openCreateProjectDialog: () => set({ createProjectDialogOpen: true }),
  closeCreateProjectDialog: () => set({ createProjectDialogOpen: false }),
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
