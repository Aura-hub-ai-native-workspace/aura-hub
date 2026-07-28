/**
 * FullStackKnowledgeEngine — the production public API.
 * ==================================================================
 * Understands an entire software system over a real workspace:
 *   analyze()  — full analysis → persistent project graph
 *   update()   — incremental (added / modified / deleted + re-link)
 *   search()   — cross-layer, graph-aware questions → SystemAnswer
 *   graph()    — the entities + relationships
 *   toContextPackage() — bridge to the frozen @aura/retrieval layer
 *
 * Reuses the frozen Coding Knowledge Engine (scanner/reader/ignore) and
 * its InvertedIndex. No embeddings, no vector search, no mock data.
 */

import path from 'node:path';
import { IgnoreRules } from '@aura/knowledge-coding';
import { estimateTokens } from '@aura/retrieval/types';
import type { ContextItem, ContextPackage, IndexCategory } from '@aura/retrieval/types';
import { ProjectGraphStore } from './graph/graphStore';
import { ExtractorRegistry } from './extract/registry';
import { RelationLinker } from './link/linker';
import { FullStackIndexer, type AnalyzeOptions } from './indexer';
import { FullStackSearch } from './search';
import type { AnalyzeStats, Entity, GraphDelta, GraphStats, Layer, Relation, SystemAnswer, SystemQuery } from './types';

export interface FullStackEngineOptions {
  indexDir?: string;
  projectName?: string;
  ignore?: ConstructorParameters<typeof IgnoreRules>[0];
  now?: () => number;
}

const LAYER_CATEGORY: Record<Layer, IndexCategory> = {
  frontend: 'frontend',
  backend: 'backend',
  database: 'database',
  config: 'architecture',
  infra: 'deployment',
  deployment: 'deployment',
  docs: 'documentation',
  architecture: 'architecture',
};

export class FullStackKnowledgeEngine {
  readonly root: string;
  readonly store: ProjectGraphStore;
  readonly projectName: string;
  private readonly indexer: FullStackIndexer;
  private readonly searcher: FullStackSearch;
  private readonly rules: IgnoreRules;

  constructor(root: string, opts: FullStackEngineOptions = {}) {
    this.root = path.resolve(root);
    this.store = new ProjectGraphStore(this.root, opts.indexDir);
    this.rules = new IgnoreRules(opts.ignore);
    this.indexer = new FullStackIndexer(this.store, new ExtractorRegistry(), new RelationLinker(), opts.now);
    this.searcher = new FullStackSearch(this.store);
    this.projectName = opts.projectName ?? path.basename(this.root);
  }

  load(): Promise<boolean> {
    return this.store.load();
  }

  private rulesFor(opts?: AnalyzeOptions): IgnoreRules {
    return opts?.ignore ? new IgnoreRules(opts.ignore) : this.rules;
  }

  analyze(opts?: AnalyzeOptions): Promise<AnalyzeStats> {
    return this.indexer.analyze(this.root, this.rulesFor(opts), opts);
  }
  update(opts?: AnalyzeOptions): Promise<GraphDelta> {
    return this.indexer.update(this.root, this.rulesFor(opts), opts);
  }

  search(query: SystemQuery): SystemAnswer {
    return this.searcher.answer(query);
  }

  graph(): { entities: Entity[]; relations: Relation[]; stats: GraphStats } {
    return { entities: this.store.allEntities(), relations: this.store.allRelations(), stats: this.store.stats() };
  }
  entity(id: string): Entity | undefined {
    return this.store.getEntity(id);
  }
  stats(): GraphStats {
    return this.store.stats();
  }

  /** Bridge a SystemAnswer into the frozen retrieval ContextPackage. */
  toContextPackage(answer: SystemAnswer, maxTokens = 6000): ContextPackage {
    const items: ContextItem[] = [];
    const seen = new Set<string>();
    const push = (e: Entity, score: number) => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      const snippet = e.snippet ?? e.summary ?? `${e.kind} ${e.name}`;
      items.push({
        id: e.id,
        title: `${e.kind}: ${e.name} — ${e.relPath}${e.line ? `:${e.line}` : ''}`,
        snippet,
        kind: 'fullstack',
        category: LAYER_CATEGORY[e.layer],
        sourceEngine: 'fullstack-engine',
        ref: e.relPath,
        score,
        tokens: estimateTokens(snippet),
        updatedAt: Date.now(),
      });
    };
    for (const h of answer.hits) push(h.entity, h.score);
    for (const p of answer.paths) for (const e of p.entities) push(e, 0.5);

    const totalTokens = items.reduce((s, i) => s + i.tokens, 0);
    return {
      query: answer.query,
      items,
      totalTokens,
      budget: { maxTokens, usedTokens: totalTokens, truncated: totalTokens > maxTokens },
      byEngine: { 'fullstack-engine': items.length },
      truncated: totalTokens > maxTokens,
      assembledAt: Date.now(),
    };
  }
}
