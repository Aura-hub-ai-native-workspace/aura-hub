/**
 * RetrievalKernel — the composition root & orchestrator.
 * ==================================================================
 * Fans a query out to the relevant domain engines, optionally folds in
 * layered-memory recall, and hands everything to the ContextAssembler to
 * produce one ContextPackage. It depends ONLY on interfaces (engines,
 * assembler, memory hierarchy) — every part is replaceable via config.
 *
 * This kernel performs no AI calls and holds no provider logic. It is
 * the boundary the intelligence layer will later call to obtain context.
 */

import type { GlobalBudget } from './budget/tokenBudget';
import type { ContextAssembler } from './assembler/contextAssembler';
import type { RetrievalEngine, RetrievalEngineRegistry } from './engines/retrievalEngine';
import type { MemoryHierarchy, RecallHit } from './memory/hierarchy';
import type { ContextPackage, RetrievalDocument, RetrievalQuery, SearchResult } from './types';

export interface RetrievalKernelDeps {
  engines: RetrievalEngineRegistry;
  assembler: ContextAssembler;
  globalBudget: GlobalBudget;
  memory?: MemoryHierarchy;
  memoryRecallLimit?: number;
  clock?: () => number;
}

/** Turn a memory recall hit into a SearchResult attributed to an engine. */
function memoryHitToResult(hit: RecallHit, engineId: string): SearchResult {
  return {
    id: `mem:${hit.record.id}`,
    chunkId: hit.record.id,
    documentId: `memory:${hit.layer}:${hit.record.id}`,
    engineId,
    domain: 'chat',
    category: 'workspace-memory',
    title: `${hit.layer} memory · ${hit.record.kind}`,
    snippet: hit.record.content,
    projectId: hit.record.projectId,
    updatedAt: hit.record.updatedAt,
    score: Math.min(1, hit.score),
    matched: [],
  };
}

export class RetrievalKernel {
  constructor(private readonly deps: RetrievalKernelDeps) {}

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  /** Populate every engine's index from a document set (dev/demo helper). */
  async ingest(docs: RetrievalDocument[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const engine of this.deps.engines.list()) counts[engine.id] = await engine.ingest(docs);
    return counts;
  }

  /** The main entry: query → assembled ContextPackage. */
  async retrieve(query: RetrievalQuery): Promise<ContextPackage> {
    const now = query.now ?? this.now();
    const scoped: RetrievalQuery = { ...query, now };
    const engines: RetrievalEngine[] = this.deps.engines.select(query.domains);

    const perEngine = await Promise.all(engines.map((e) => e.retrieve(scoped)));
    let results = perEngine.flat();

    // Fold layered-memory recall in via the chat engine's budget.
    const wantsChat = !query.domains || query.domains.includes('chat');
    const chatEngine = engines.find((e) => e.domain === 'chat');
    if (this.deps.memory && wantsChat && chatEngine) {
      const hits = await this.deps.memory.recall(
        { text: query.text, projectId: query.projectId, sessionId: query.sessionId, limit: this.deps.memoryRecallLimit ?? 8 },
        { now },
      );
      results = results.concat(hits.map((h) => memoryHitToResult(h, chatEngine.id)));
    }

    return this.deps.assembler.assemble({ query: scoped, engines, results, globalBudget: this.deps.globalBudget, now });
  }

  /** Introspect the wired components — proves what is plugged in. */
  describe() {
    return {
      assembler: this.deps.assembler.id,
      globalBudget: this.deps.globalBudget,
      hasMemory: Boolean(this.deps.memory),
      engines: this.deps.engines.list().map((e) => e.describe()),
    };
  }
}
