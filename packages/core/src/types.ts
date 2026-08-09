/**
 * AURA Hub — Shared Domain Types
 * ------------------------------------------------------------------
 * These types describe the *environment*, not any intelligence.
 * They are deliberately AI-agnostic: an AI module will later produce
 * and consume these structures, but the shell owns their shape.
 */

/** Top-level navigation destinations (permanent left rail). */
export type NavKey =
  | 'home'
  | 'workflows'
  | 'workspace'
  | 'environment'
  | 'settings';

/** Tabs inside a project workspace (the project's own environment). */
export type ProjectTab =
  | 'overview'
  | 'architecture'
  | 'code'
  | 'frontend'
  | 'backend'
  | 'database'
  | 'research'
  | 'documentation'
  | 'knowledge'
  | 'intelligence'
  | 'memory'
  | 'tasks'
  | 'deployment'
  | 'settings';

export type StatusTone = 'positive' | 'attention' | 'critical' | 'info' | 'neutral';

export interface Project {
  id: string;
  name: string;
  description: string;
  /** 0–100 completion signal for the overview ring. */
  progress: number;
  color: string;
  updatedAt: string;
  tags: string[];
  status: StatusTone;
}

export interface ActivityEntry {
  id: string;
  actor: string;
  action: string;
  target: string;
  at: string;
  tone: StatusTone;
}

export interface QuickAction {
  id: string;
  label: string;
  hint: string;
  /** Icon name resolved by @aura/ui icon registry. */
  icon: string;
}

/** A command-palette entry — the environment's universal action surface. */
export interface Command {
  id: string;
  title: string;
  section: string;
  icon: string;
  shortcut?: string[];
  keywords?: string[];
  run: () => void;
}
