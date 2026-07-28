/**
 * CodingKnowledgeEngine — the production public API.
 * ==================================================================
 * Ties the pipeline together over a real workspace:
 *   index()   — full index of the filesystem
 *   update()  — incremental (added / modified / deleted only)
 *   search()  — keyword search (exact / prefix / fuzzy + filters)
 *   getContext() — assembled context (matches + neighbors + metadata)
 *   toContextPackage() — bridge to the frozen @aura/retrieval layer
 *
 * This is the reference implementation the other Knowledge Engines will
 * follow. No mock data — everything runs against real files.
 */

import path from 'node:path';
import type { ContextItem, ContextPackage, IndexCategory } from '@aura/retrieval/types';
import { CodingIndexer } from './indexer';
import { CodingSearch } from './search';
import { ContextBuilder } from './context';
import { IgnoreRules } from './ignore';
import { JsonKnowledgeStore } from './store/indexStore';
import type {
  CodeDocument,
  CodingContext,
  ContextOptions,
  IgnoreConfig,
  IndexDelta,
  IndexOptions,
  IndexStats,
  FileKind,
  SearchHit,
  SearchQuery,
} from './types';

export interface CodingEngineOptions {
  indexDir?: string;
  projectName?: string;
  ignore?: IgnoreConfig;
  now?: () => number;
}

const KIND_CATEGORY: Record<FileKind, IndexCategory> = {
  code: 'source-code',
  doc: 'documentation',
  manifest: 'dependencies',
  config: 'architecture',
  license: 'documentation',
  ignore: 'architecture',
  data: 'source-code',
  text: 'documentation',
  binary: 'source-code',
  unknown: 'source-code',
};

export class CodingKnowledgeEngine {
  readonly root: string;
  readonly store: JsonKnowledgeStore;
  private readonly indexer: CodingIndexer;
  private readonly searcher: CodingSearch;
  private readonly contextBuilder: ContextBuilder;
  private readonly rules: IgnoreRules;
  readonly projectName: string;

  constructor(root: string, opts: CodingEngineOptions = {}) {
    this.root = path.resolve(root);
    this.store = new JsonKnowledgeStore(this.root, opts.indexDir);
    this.rules = new IgnoreRules(opts.ignore);
    this.indexer = new CodingIndexer(this.store, opts.now);
    this.searcher = new CodingSearch(this.store, opts.now);
    this.projectName = opts.projectName ?? path.basename(this.root);
    this.contextBuilder = new ContextBuilder(this.store, this.projectName);
  }

  /** Load a previously persisted index, if present. */
  load(): Promise<boolean> {
    return this.store.load();
  }

  private rulesFor(opts?: IndexOptions): IgnoreRules {
    return opts?.ignore ? new IgnoreRules(opts.ignore) : this.rules;
  }

  index(opts?: IndexOptions): Promise<IndexStats> {
    return this.indexer.fullIndex(this.root, this.rulesFor(opts), opts);
  }

  update(opts?: IndexOptions): Promise<IndexDelta> {
    return this.indexer.incremental(this.root, this.rulesFor(opts), opts);
  }

  search(query: SearchQuery): SearchHit[] {
    return this.searcher.search(query);
  }

  getContext(query: SearchQuery, ctxOpts?: ContextOptions): CodingContext {
    const hits = this.searcher.search({ ...query, limit: query.limit ?? 30 });
    return this.contextBuilder.build(query.text, hits, ctxOpts);
  }

  /** Bridge the native CodingContext into the frozen retrieval ContextPackage. */
  toContextPackage(ctx: CodingContext, maxTokens = 6000): ContextPackage {
    const items: ContextItem[] = [];
    for (const entry of ctx.entries) {
      for (const ref of entry.chunks) {
        items.push({
          id: ref.chunk.id,
          title: `${entry.document.relPath}:${ref.chunk.startLine}-${ref.chunk.endLine}`,
          snippet: ref.chunk.text,
          kind: 'coding',
          category: KIND_CATEGORY[entry.document.kind],
          sourceEngine: 'coding-engine',
          ref: entry.document.relPath,
          score: entry.score,
          tokens: ref.chunk.tokenEstimate,
          updatedAt: entry.document.modifiedMs,
        });
      }
    }
    return {
      query: ctx.query,
      items,
      totalTokens: ctx.totalTokens,
      budget: { maxTokens, usedTokens: ctx.totalTokens, truncated: ctx.truncated },
      byEngine: { 'coding-engine': items.length },
      truncated: ctx.truncated,
      assembledAt: Date.now(),
    };
  }

  stats(): { documents: number; chunks: number } {
    return this.store.stats();
  }

  documents(): CodeDocument[] {
    return this.store.allDocuments();
  }
}
