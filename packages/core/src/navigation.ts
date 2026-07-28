/**
 * AURA Hub — Navigation Model
 * ------------------------------------------------------------------
 * The permanent left rail is data-driven. Adding a destination is a
 * one-line change here; the shell renders whatever this array says.
 * This is a core extension point for future modules.
 */

import type { NavKey, ProjectTab } from './types';

export interface NavItem {
  key: NavKey;
  label: string;
  icon: string;
  /** Optional live count badge (e.g. running tasks). */
  badge?: number;
  /** Grouping — lets us insert a visual divider without hard-coding it. */
  group: 'primary' | 'system';
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: 'Home', icon: 'home', group: 'primary' },
  { key: 'projects', label: 'Projects', icon: 'projects', group: 'primary' },
  { key: 'knowledge', label: 'Knowledge', icon: 'knowledge', group: 'primary' },
  { key: 'ai', label: 'AI', icon: 'spark', group: 'primary' },
  { key: 'workflows', label: 'Workflows', icon: 'workflows', group: 'primary' },
  { key: 'marketplace', label: 'Marketplace', icon: 'marketplace', group: 'primary' },
  { key: 'settings', label: 'Settings', icon: 'settings', group: 'system' },
];

export interface ProjectTabDef {
  key: ProjectTab;
  label: string;
  icon: string;
}

export const PROJECT_TABS: ProjectTabDef[] = [
  { key: 'overview', label: 'Overview', icon: 'grid' },
  { key: 'architecture', label: 'Architecture', icon: 'architecture' },
  { key: 'frontend', label: 'Frontend', icon: 'layout' },
  { key: 'backend', label: 'Backend', icon: 'server' },
  { key: 'database', label: 'Database', icon: 'database' },
  { key: 'research', label: 'Research', icon: 'research' },
  { key: 'documentation', label: 'Documentation', icon: 'doc' },
  { key: 'knowledge', label: 'Knowledge', icon: 'knowledge' },
  { key: 'intelligence', label: 'Intelligence', icon: 'spark' },
  { key: 'memory', label: 'Memory', icon: 'memory' },
  { key: 'tasks', label: 'Tasks', icon: 'check' },
  { key: 'deployment', label: 'Deployment', icon: 'deploy' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

/** Human-readable titles for the top command bar breadcrumb. */
export const NAV_TITLES: Record<NavKey, string> = {
  home: 'Home',
  projects: 'Projects',
  knowledge: 'Knowledge',
  ai: 'AI',
  workflows: 'Workflows',
  marketplace: 'Marketplace',
  settings: 'Settings',
};
