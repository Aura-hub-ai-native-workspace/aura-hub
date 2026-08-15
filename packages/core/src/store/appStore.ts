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
/**
 * The ONE key that records which project AURA is working on.
 *
 * It replaces `aura.workspace.projectId`, which WorkspaceScreen used to own
 * privately. Two keys meant the Hub and the rest of the shell could disagree
 * about the active project, and nothing reconciled them.
 */
const ACTIVE_PROJECT_KEY = 'aura.activeProjectId';

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

/** Restore the active project across relaunches. An id that no longer exists
 *  in the registry is pruned by `useActiveProject`, which is the only place
 *  that can know — this store deliberately does not talk to the service. */
function initialActiveProject(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(ACTIVE_PROJECT_KEY) || null;
}

function persistActiveProject(id: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (id) localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  else localStorage.removeItem(ACTIVE_PROJECT_KEY);
}

interface AppState {
  /** Active top-level destination. */
  nav: NavKey;
  /**
   * The project AURA is working on. THE single active-project authority for
   * the UI, and persisted across relaunches.
   *
   * Deliberately independent of navigation. It used to be nulled by every
   * `setNav`, which conflated "which project" with "am I looking at the
   * project screen" — and that conflation is why the Workspace Hub had to
   * keep a second, private project pointer to survive a nav away. Use
   * `inProjectView` for the "am I looking at it" question.
   */
  activeProjectId: string | null;
  /** Whether the project workspace screen is the thing on screen right now. */
  inProjectView: boolean;
  /**
   * Whether "Ask AURA" is taking over the project view, full-screen.
   *
   * A SUB-MODE of `inProjectView`, not a peer of `activeProjectId`. It lives
   * here rather than in ProjectWorkspace's local state because the router
   * needs it to switch the screen into a fixed-viewport layout — the chat
   * owns its own internal scrolling, exactly like the Code Workspace.
   *
   * Never persisted. Ask AURA is a way of looking at a project, never part
   * of the project's identity, so a relaunch restores the project and lands
   * on the normal project view.
   */
  askAuraOpen: boolean;
  /** Active tab within the project workspace. */
  projectTab: ProjectTab;
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
  setBooted: (booted: boolean) => void;
  /** Marks onboarding complete (persisted) and skips the redundant generic
   *  boot animation this one time — the onboarding's own Ready screen
   *  already served as this launch's cinematic boot moment. */
  completeOnboarding: () => void;
  pushRecentCommand: (id: string) => void;
  /** Toggle the Ask AURA sub-mode. Never touches `activeProjectId`. */
  setAskAuraOpen: (open: boolean) => void;
  /** Make `id` active AND show its workspace. */
  openProject: (id: string) => void;
  /** Leave the project screen. The project stays active. */
  closeProject: () => void;
  /**
   * Switch which project is active without navigating anywhere — what the
   * Workspace Hub's project picker needs. Passing null clears it.
   */
  setActiveProject: (id: string | null) => void;
  /**
   * Forget the active project entirely. For when it stops existing (removed
   * from the registry), never for merely navigating away.
   */
  clearActiveProject: () => void;
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
  activeProjectId: initialActiveProject(),
  inProjectView: false,
  askAuraOpen: false,
  projectTab: 'overview',
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

  /* ── The three-field state model ──────────────────────────────────
     activeProjectId  WHICH project is active   (persisted, nav-independent)
       └─ inProjectView   is that project's screen showing
            └─ askAuraOpen   is Ask AURA taking over that screen

     The view states nest; only the innermost ones follow navigation.
     `activeProjectId` is the single authority and is preserved by every
     transition except `clearActiveProject`.

     Every transition that leaves or re-targets the project view also closes
     Ask AURA. It is a view *of* one project, so it must never survive onto a
     screen — or a project — that no longer backs it. */

  // Navigating away leaves the project SCREEN but does not deactivate the
  // project — the Hub and the Context Fabric keep working against it from
  // any destination.
  setNav: (nav) => set({ nav, inProjectView: false, askAuraOpen: false }),
  // Project entry now lives on Home (the former standalone Projects
  // screen was folded into it) — opening a project always returns you to
  // Home once it's closed, rather than a dedicated "Projects" nav key.
  openProject: (id) => {
    persistActiveProject(id);
    set({ nav: 'home', activeProjectId: id, inProjectView: true, askAuraOpen: false, projectTab: 'overview' });
  },
  closeProject: () => set({ inProjectView: false, askAuraOpen: false }),
  // Re-targeting the active project closes Ask AURA: the open conversation
  // belongs to the project being switched away from.
  setActiveProject: (id) => {
    persistActiveProject(id);
    set({ activeProjectId: id, askAuraOpen: false });
  },
  clearActiveProject: () => {
    persistActiveProject(null);
    set({ activeProjectId: null, inProjectView: false, askAuraOpen: false });
  },
  // The sub-mode toggle, and ONLY the sub-mode — it must never write
  // `activeProjectId`, or Ask AURA would become part of project identity.
  setAskAuraOpen: (askAuraOpen) => set({ askAuraOpen }),
  setProjectTab: (projectTab) => set({ projectTab }),
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
