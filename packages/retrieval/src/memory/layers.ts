/**
 * Memory Layers
 * ==================================================================
 * The five-tier hierarchy, most-immediate first:
 *
 *   Session   — the current interaction (volatile, highest precedence)
 *     ↓
 *   Project   — everything scoped to one AURA project
 *     ↓
 *   Workspace — shared across the user's projects
 *     ↓
 *   Knowledge — curated, durable knowledge
 *     ↓
 *   Persistent — long-horizon, cross-everything memory
 *
 * Each layer is its OWN interface (a `MemoryProvider` with a fixed
 * `layer`) so it can be backed and replaced independently. The default
 * implementations are all in-memory.
 */

import {
  InMemoryMemoryProvider,
  type MemoryLayer,
  type MemoryProvider,
} from './memoryProvider';

/** Marker interfaces — each pins a provider to one layer. */
export interface SessionMemory extends MemoryProvider {
  readonly layer: 'session';
}
export interface ProjectMemory extends MemoryProvider {
  readonly layer: 'project';
}
export interface WorkspaceMemory extends MemoryProvider {
  readonly layer: 'workspace';
}
export interface KnowledgeMemory extends MemoryProvider {
  readonly layer: 'knowledge';
}
export interface PersistentMemory extends MemoryProvider {
  readonly layer: 'persistent';
}

/** Ordered from most-immediate to most-durable. */
export const MEMORY_LAYER_ORDER: MemoryLayer[] = [
  'session',
  'project',
  'workspace',
  'knowledge',
  'persistent',
];

/** Default recall weight per layer (proximity → higher weight). */
export const LAYER_WEIGHT: Record<MemoryLayer, number> = {
  session: 1.0,
  project: 0.8,
  workspace: 0.6,
  knowledge: 0.45,
  persistent: 0.3,
};

/* ── Default in-memory layer implementations ───────────────────────── */

const clockOf = (clock?: () => number) => clock ?? (() => Date.now());

export class InMemorySessionMemory extends InMemoryMemoryProvider implements SessionMemory {
  readonly layer = 'session' as const;
  constructor(clock?: () => number) {
    super('session', clockOf(clock));
  }
}
export class InMemoryProjectMemory extends InMemoryMemoryProvider implements ProjectMemory {
  readonly layer = 'project' as const;
  constructor(clock?: () => number) {
    super('project', clockOf(clock));
  }
}
export class InMemoryWorkspaceMemory extends InMemoryMemoryProvider implements WorkspaceMemory {
  readonly layer = 'workspace' as const;
  constructor(clock?: () => number) {
    super('workspace', clockOf(clock));
  }
}
export class InMemoryKnowledgeMemory extends InMemoryMemoryProvider implements KnowledgeMemory {
  readonly layer = 'knowledge' as const;
  constructor(clock?: () => number) {
    super('knowledge', clockOf(clock));
  }
}
export class InMemoryPersistentMemory extends InMemoryMemoryProvider implements PersistentMemory {
  readonly layer = 'persistent' as const;
  constructor(clock?: () => number) {
    super('persistent', clockOf(clock));
  }
}
