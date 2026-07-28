import type { NavKey } from '@aura/core';
import type { IconName } from '@aura/ui';

/**
 * Section identity — each environment has its own *personality* while
 * staying within the AURA language. The blue accent still owns actions;
 * a section's hue only ever colours ambient atmosphere (auras, motif),
 * so the product feels varied but never inconsistent.
 *
 * Identity/atmosphere only — no structural change to the shell.
 */
export interface SectionIdentity {
  /** Ambient hue for auras + the motif tile (NOT for buttons). */
  hue: string;
  motif: IconName;
  /** A short, human line that sets the mood of the space. */
  tagline: string;
  /** Guidance chips shown in the empty state. */
  chips: { icon: IconName; label: string }[];
}

export const SECTION_IDENTITY: Record<NavKey, SectionIdentity> = {
  home: {
    hue: '#3b6bff',
    motif: 'home',
    tagline: 'Your environment at a glance.',
    chips: [],
  },
  projects: {
    hue: '#3b6bff',
    motif: 'projects',
    tagline: 'Every project is its own environment.',
    chips: [],
  },
  knowledge: {
    hue: '#1fb567',
    motif: 'knowledge',
    tagline: 'A living fabric of everything your environment knows.',
    chips: [
      { icon: 'doc', label: 'Import documents' },
      { icon: 'link', label: 'Connect a source' },
      { icon: 'note', label: 'Write a note' },
    ],
  },
  ai: {
    hue: '#7c5cff',
    motif: 'spark',
    tagline: 'The reserved stage where intelligence will live.',
    chips: [
      { icon: 'cpu', label: 'Configure models' },
      { icon: 'spark', label: 'Define an agent' },
      { icon: 'memory', label: 'Attach memory' },
    ],
  },
  workflows: {
    hue: '#f5a524',
    motif: 'workflows',
    tagline: 'Orchestrate the environment with automation graphs.',
    chips: [
      { icon: 'plus', label: 'New workflow' },
      { icon: 'workflows', label: 'From template' },
      { icon: 'activity', label: 'View runs' },
    ],
  },
  marketplace: {
    hue: '#3b6bff',
    motif: 'marketplace',
    tagline: 'Extend AURA with modules, models and templates.',
    chips: [
      { icon: 'marketplace', label: 'Browse modules' },
      { icon: 'spark', label: 'Featured models' },
      { icon: 'grid', label: 'Templates' },
    ],
  },
  settings: {
    hue: '#6b7385',
    motif: 'settings',
    tagline: 'Tune the environment to how you think.',
    chips: [
      { icon: 'layout', label: 'Appearance' },
      { icon: 'command', label: 'Shortcuts' },
      { icon: 'cpu', label: 'Runtime' },
    ],
  },
};
