/**
 * AURA Hub — Navigation Model
 * ------------------------------------------------------------------
 * The permanent left rail is data-driven. Adding a destination is a
 * one-line change here; the shell renders whatever this array says.
 * This is a core extension point for future modules.
 */

import type { NavKey, ProjectMode, ProjectTab, SettingsTab } from './types';

interface NavItem {
  key: NavKey;
  label: string;
  icon: string;
  /** Grouping — lets us insert a visual divider without hard-coding it. */
  group: 'primary' | 'system';
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: 'Home', icon: 'home', group: 'primary' },
  { key: 'workflows', label: 'Automations', icon: 'workflows', group: 'primary' },
  { key: 'settings', label: 'Settings', icon: 'settings', group: 'system' },
];

interface ProjectTabDef {
  key: ProjectTab;
  label: string;
  icon: string;
}

export const PROJECT_TABS: ProjectTabDef[] = [
  { key: 'overview', label: 'Overview', icon: 'grid' },
  // Second on purpose: "what does AURA know about this project?" is the
  // question a user asks before trusting anything else in the workspace.
  { key: 'context', label: 'Context', icon: 'spark' },
  { key: 'architecture', label: 'Architecture', icon: 'architecture' },
  { key: 'code', label: 'Code', icon: 'code' },
];

/** The top switch of an open project. */
export const PROJECT_MODES: { key: ProjectMode; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'workspace', label: 'Workspace' },
];

/** Settings tabs, in display order. */
export const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: 'connections', label: 'Connections' },
  { key: 'tools', label: 'Connected tools' },
  { key: 'runtime', label: 'AI Runtime' },
  { key: 'updates', label: 'Updates' },
];

/** Human-readable titles for the top command bar breadcrumb. */
export const NAV_TITLES: Record<NavKey, string> = {
  home: 'Home',
  workflows: 'Automations',
  settings: 'Settings',
};
