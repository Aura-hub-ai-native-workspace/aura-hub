/**
 * RetrievalEngine — an independent, domain-scoped retriever.
 * ==================================================================
 * The mission is explicit: NOT one giant RAG. Each domain (coding, chat,
 * research, fullstack) is its own engine with its own index, its own
 * declared categories, and its own budget config (maxContext, priority,
 * compression, ranking). Engines are interchangeable and registered by
 * id; the kernel fans a query out to the relevant ones.
 *
 * An engine OWNS retrieval + ranking of its results. It DECLARES its
 * budget/compression policy but does not enforce the global budget —
 * that is the ContextAssembler's job (single source of truth).
 */

import type { EngineBudgetConfig } from '../budget/tokenBudget';
import type { ChunkProvider } from '../providers/chunkProvider';
import type { IndexProvider } from '../providers/indexProvider';
import type { RetrievalProvider } from '../providers/retrievalProvider';
import type { RankingProvider } from '../providers/rankingProvider';
import type { IndexCategory, RetrievalDocument, RetrievalDomain, RetrievalQuery, SearchResult } from '../types';

export interface RetrievalEngine {
  readonly id: string;
  readonly domain: RetrievalDomain;
  /** Exactly what this engine is responsible for indexing. */
  readonly indexes: IndexCategory[];
  readonly config: EngineBudgetConfig;
  /** Populate this engine's own index (dev/demo helper; not real indexing). */
  ingest(docs: RetrievalDocument[]): Promise<number>;
  /** Retrieve + rank this engine's results for a query. */
  retrieve(query: RetrievalQuery): Promise<SearchResult[]>;
  describe(): {
    id: string;
    domain: RetrievalDomain;
    indexes: IndexCategory[];
    config: EngineBudgetConfig;
    size: number;
  };
}

export interface EngineDeps {
  index: IndexProvider;
  retrieval: RetrievalProvider;
  ranking: RankingProvider;
  chunker: ChunkProvider;
  clock?: () => number;
}

/**
 * BaseRetrievalEngine — wires the providers together. Concrete engines
 * only declare their domain, categories and default config; behavior is
 * inherited, so all four engines stay consistent and every provider is
 * replaceable per-engine.
 */
export abstract class BaseRetrievalEngine implements RetrievalEngine {
  abstract readonly domain: RetrievalDomain;
  abstract readonly indexes: IndexCategory[];
  readonly config: EngineBudgetConfig;
  protected readonly deps: EngineDeps;

  constructor(deps: EngineDeps, config: EngineBudgetConfig) {
    this.deps = deps;
    this.config = config;
  }

  get id(): string {
    return `${this.domain}-engine`;
  }

  /** Chunk + index only the documents this engine is responsible for. */
  async ingest(docs: RetrievalDocument[]): Promise<number> {
    const mine = docs.filter((d) => d.domain === this.domain && this.indexes.includes(d.category));
    let count = 0;
    for (const doc of mine) {
      const chunks = this.deps.chunker.chunk(doc);
      await this.deps.index.add(chunks);
      count += chunks.length;
    }
    return count;
  }

  async retrieve(query: RetrievalQuery): Promise<SearchResult[]> {
    // Constrain the query to this engine's categories (intersection).
    const scoped: RetrievalQuery = {
      ...query,
      categories: query.categories
        ? query.categories.filter((c) => this.indexes.includes(c))
        : this.indexes,
    };
    const k = query.limit ?? 20;
    const raw = await this.deps.retrieval.retrieve(scoped, this.deps.index, this.id, k);
    return this.deps.ranking.rank(raw, {
      queryText: query.text,
      now: query.now ?? this.deps.clock?.() ?? Date.now(),
      policy: this.config.ranking,
      projectId: query.projectId,
    });
  }

  describe() {
    return { id: this.id, domain: this.domain, indexes: this.indexes, config: this.config, size: this.deps.index.size() };
  }
}

/** Registry of engines — resolvable by id or domain, fully replaceable. */
export class RetrievalEngineRegistry {
  private readonly engines = new Map<string, RetrievalEngine>();

  register(engine: RetrievalEngine): this {
    this.engines.set(engine.id, engine);
    return this;
  }
  resolve(id: string): RetrievalEngine | undefined {
    return this.engines.get(id);
  }
  byDomain(domain: RetrievalDomain): RetrievalEngine | undefined {
    return [...this.engines.values()].find((e) => e.domain === domain);
  }
  list(): RetrievalEngine[] {
    return [...this.engines.values()];
  }
  /** Engines matching the query's requested domains (all if unspecified). */
  select(domains?: RetrievalDomain[]): RetrievalEngine[] {
    if (!domains || domains.length === 0) return this.list();
    return this.list().filter((e) => domains.includes(e.domain));
  }
}
