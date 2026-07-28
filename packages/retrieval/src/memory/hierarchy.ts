/**
 * MemoryHierarchy — composes the five layers.
 * ==================================================================
 * Responsibility: present the layered memory as one recall/remember
 * surface while keeping each layer independently replaceable. Recall
 * queries every layer and merges results, weighting by layer proximity,
 * salience and recency. Writes are routed to a layer (by kind, or
 * explicitly). Records can be promoted/demoted between layers.
 *
 * No AI, no provider logic — pure composition + ranking arithmetic.
 */

import {
  LAYER_WEIGHT,
  MEMORY_LAYER_ORDER,
  type KnowledgeMemory,
  type PersistentMemory,
  type ProjectMemory,
  type SessionMemory,
  type WorkspaceMemory,
} from './layers';
import type { MemoryKind, MemoryLayer, MemoryProvider, MemoryQuery, MemoryRecord, MemoryWrite } from './memoryProvider';

export interface MemoryLayers {
  session: SessionMemory;
  project: ProjectMemory;
  workspace: WorkspaceMemory;
  knowledge: KnowledgeMemory;
  persistent: PersistentMemory;
}

/** A recalled record with the layer it came from and its blended score. */
export interface RecallHit {
  record: MemoryRecord;
  layer: MemoryLayer;
  score: number;
}

/** Default layer a write lands in, by kind. Overridable per call. */
export const DEFAULT_KIND_LAYER: Record<MemoryKind, MemoryLayer> = {
  message: 'session',
  preference: 'workspace',
  note: 'project',
  task: 'project',
  decision: 'project',
  fact: 'knowledge',
  summary: 'project',
};

export interface RecallOptions {
  now?: number;
  limit?: number;
  recencyHalfLifeMs?: number;
}

export class MemoryHierarchy {
  constructor(
    private readonly layers: MemoryLayers,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Direct access to one layer (for targeted reads/writes). */
  layer(name: MemoryLayer): MemoryProvider {
    return this.layers[name];
  }

  /**
   * Recall across all layers. Each hit's score blends the layer weight,
   * the record's importance, and recency — so a fresh, salient session
   * memory outranks a stale persistent fact, as intended.
   */
  async recall(query: MemoryQuery, opts: RecallOptions = {}): Promise<RecallHit[]> {
    const now = opts.now ?? this.clock();
    const halfLife = opts.recencyHalfLifeMs ?? 14 * 24 * 60 * 60 * 1000;

    const perLayer = await Promise.all(
      MEMORY_LAYER_ORDER.map(async (layer) => {
        const records = await this.layers[layer].read(query);
        return records.map((record) => {
          const recency = Math.pow(0.5, Math.max(0, now - record.updatedAt) / halfLife);
          const score = LAYER_WEIGHT[layer] * (0.4 + 0.6 * record.importance) * (0.5 + 0.5 * recency);
          return { record, layer, score } satisfies RecallHit;
        });
      }),
    );

    const merged = perLayer.flat().sort((a, b) => b.score - a.score);
    return opts.limit ? merged.slice(0, opts.limit) : merged;
  }

  /** Write a memory. Routes to the layer for its kind unless one is given. */
  async remember(write: MemoryWrite, layer?: MemoryLayer): Promise<MemoryRecord> {
    const target = layer ?? DEFAULT_KIND_LAYER[write.kind];
    return this.layers[target].write(write);
  }

  /** Move a record from one layer to another (promotion or demotion). */
  async promote(id: string, from: MemoryLayer, to: MemoryLayer): Promise<MemoryRecord | undefined> {
    const rec = await this.layers[from].get(id);
    if (!rec) return undefined;
    const moved = await this.layers[to].write({
      kind: rec.kind,
      content: rec.content,
      importance: rec.importance,
      projectId: rec.projectId,
      sessionId: rec.sessionId,
      tags: rec.tags,
      metadata: rec.metadata,
    });
    await this.layers[from].forget(id);
    return moved;
  }

  /** Count of records per layer — for introspection / tests. */
  async snapshot(): Promise<Record<MemoryLayer, number>> {
    const entries = await Promise.all(
      MEMORY_LAYER_ORDER.map(async (l) => [l, (await this.layers[l].all()).length] as const),
    );
    return Object.fromEntries(entries) as Record<MemoryLayer, number>;
  }
}
