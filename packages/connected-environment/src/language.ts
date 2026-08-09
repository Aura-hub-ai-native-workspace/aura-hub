/**
 * language — the environment's voice, in one place.
 * ==================================================================
 * Every state the user can land in gets a headline and a next step. The
 * rule the whole layer enforces: **be accurate about what happened, and
 * always name what happens next.** "Docker isn't running" is honest but
 * terminal; "Docker is installed but its daemon is asleep — start Docker
 * Desktop, or the Hub will build without containers" is honest *and*
 * moves forward.
 *
 * Centralizing this matters more than it looks. Scattered status strings
 * drift toward whatever the developer felt at the time; one table can be
 * reviewed, translated, and kept consistent as the surface grows.
 */

import type { EnvironmentNode, NodeStatus } from './types';

export type Tone = 'positive' | 'progress' | 'attention' | 'neutral';

export interface Phrase {
  headline: string;
  nextStep: string;
  tone: Tone;
}

const NODE_PHRASES: Record<NodeStatus, (node: EnvironmentNode) => Phrase> = {
  connected: (n) => ({
    headline: `${n.entry.name} is connected`,
    nextStep: n.health.version ? `Running ${n.health.version}.` : 'Ready for work.',
    tone: 'positive',
  }),
  available: (n) => ({
    headline: `${n.entry.name} is installed here`,
    nextStep: 'Connect it to let missions route work through it.',
    tone: 'progress',
  }),
  unknown: (n) => ({
    headline: `${n.entry.name} has not been checked`,
    nextStep: 'Run a scan and the Hub will look for it on this machine.',
    tone: 'neutral',
  }),
  'not-installed': (n) => ({
    headline: `${n.entry.name} is not on this machine`,
    nextStep: `Install it from ${n.entry.homepage}, or let the Hub suggest an alternative that already provides the same capability.`,
    tone: 'attention',
  }),
  degraded: (n) => ({
    headline: `${n.entry.name} answered, but not healthily`,
    nextStep: n.health.detail,
    tone: 'attention',
  }),
  'needs-auth': (n) => ({
    headline: `${n.entry.name} needs to know it is you`,
    nextStep: n.entry.auth === 'api-key'
      ? 'Add the API key and the Hub will route through it.'
      : 'Sign in through the tool once; the Hub reuses that session.',
    tone: 'progress',
  }),
  'no-connector': (n) => ({
    headline: `${n.entry.name} is catalogued, not connected`,
    nextStep: 'Missions can plan around it and hand you the step. A connector for it has not been built yet.',
    tone: 'neutral',
  }),
};

export function describeNode(node: EnvironmentNode): Phrase {
  return NODE_PHRASES[node.health.status](node);
}

/*
 * Task and mission phrasing deliberately does NOT live here. Those states
 * belong to Mission Control v3 (`ExecutionTaskStatus`, `ExecutionStatus`)
 * and are already surfaced by the mission screens. A second phrase table
 * over states this package cannot see would drift out of sync with the
 * engine that actually owns them.
 */

/**
 * The environment's one-line status. Deliberately leads with what *is*
 * working rather than with what is missing.
 */
export function describeEnvironment(summary: { connected: number; available: number; catalogued: number; running: number }): string {
  if (summary.running > 0) {
    return `${summary.running} ${summary.running === 1 ? 'task' : 'tasks'} running across ${summary.connected} connected ${summary.connected === 1 ? 'node' : 'nodes'}.`;
  }
  if (summary.connected > 0) {
    return `${summary.connected} ${summary.connected === 1 ? 'node' : 'nodes'} connected${summary.available ? `, ${summary.available} more found on this machine` : ''}.`;
  }
  if (summary.available > 0) {
    return `${summary.available} tools found on this machine and ready to connect.`;
  }
  return `${summary.catalogued} systems catalogued. Scan this machine to see what is already here.`;
}
