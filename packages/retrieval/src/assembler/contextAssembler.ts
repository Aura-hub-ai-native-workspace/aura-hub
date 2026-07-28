/**
 * ContextAssembler — produces the single ContextPackage.
 * ==================================================================
 * Responsibilities (exactly as specified):
 *   • collect results from every engine
 *   • remove duplicates
 *   • rank relevance
 *   • respect token budgets (global + per-engine)
 *   • prioritize recent context
 *   • prioritize project context
 *   • produce ONE ContextPackage
 *
 * No AI calls. No provider logic. Pure ranking + budgeting arithmetic.
 * Compression and per-engine caps come from each engine's declared
 * `EngineBudgetConfig`, so budgeting policy lives with the engine while
 * enforcement lives here (one place).
 */

import { BudgetAllocator, getCompressor, type GlobalBudget } from '../budget/tokenBudget';
import type { RetrievalEngine } from '../engines/retrievalEngine';
import {
  estimateTokens,
  type ContextItem,
  type ContextPackage,
  type RetrievalQuery,
  type SearchResult,
} from '../types';

export interface AssembleInput {
  query: RetrievalQuery;
  engines: RetrievalEngine[];
  /** All engine results, flattened (each already tagged with engineId). */
  results: SearchResult[];
  globalBudget: GlobalBudget;
  now?: number;
}

export interface ContextAssembler {
  readonly id: string;
  assemble(input: AssembleInput): Promise<ContextPackage>;
}

/** Smallest useful item; below this we drop rather than over-compress. */
const MIN_ITEM_TOKENS = 24;

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface DefaultAssemblerOptions {
  /** Weights for global ranking: [relevance, recency, project, enginePriority]. */
  weights?: [number, number, number, number];
  recencyHalfLifeMs?: number;
  minItemTokens?: number;
}

export class DefaultContextAssembler implements ContextAssembler {
  readonly id = 'default-context-assembler';
  private readonly w: [number, number, number, number];
  private readonly halfLife: number;
  private readonly minItem: number;

  constructor(opts: DefaultAssemblerOptions = {}) {
    this.w = opts.weights ?? [0.5, 0.2, 0.2, 0.1];
    this.halfLife = opts.recencyHalfLifeMs ?? 30 * 24 * 60 * 60 * 1000;
    this.minItem = opts.minItemTokens ?? MIN_ITEM_TOKENS;
  }

  async assemble(input: AssembleInput): Promise<ContextPackage> {
    const now = input.now ?? input.query.now ?? Date.now();
    const configById = new Map(input.engines.map((e) => [e.id, e.config]));

    // 1) De-duplicate — same document + near-identical snippet → keep best.
    const deduped = new Map<string, SearchResult>();
    for (const r of input.results) {
      const key = `${r.documentId}::${normalize(r.snippet).slice(0, 120)}`;
      const prev = deduped.get(key);
      if (!prev || r.score > prev.score) deduped.set(key, r);
    }

    // 2) Global ranking — relevance + recency + project + engine priority.
    const [wRel, wRec, wProj, wEng] = this.w;
    const ranked = [...deduped.values()]
      .map((r) => {
        const recency = Math.pow(0.5, Math.max(0, now - r.updatedAt) / this.halfLife);
        const projectMatch = input.query.projectId && r.projectId === input.query.projectId ? 1 : 0;
        const enginePriority = configById.get(r.engineId)?.priority ?? 0.5;
        const rank = wRel * r.score + wRec * recency + wProj * projectMatch + wEng * enginePriority;
        return { r, rank };
      })
      .sort((a, b) => b.rank - a.rank);

    // 3) Budget allocation — split the global budget across engines.
    const allocator = new BudgetAllocator(input.globalBudget);
    const allotment = allocator.allocate(input.engines.map((e) => ({ id: e.id, config: e.config })));
    const engineUsed = new Map<string, number>();
    const globalMax = Math.max(0, input.globalBudget.maxTokens - (input.globalBudget.reserveTokens ?? 0));

    // 4) Greedy fill respecting per-engine allotment + global cap; compress to fit.
    const items: ContextItem[] = [];
    const byEngine: Record<string, number> = {};
    let totalUsed = 0;
    let truncated = false;

    for (const { r, rank } of ranked) {
      const cfg = configById.get(r.engineId);
      if (!cfg) continue;
      const engineBudget = allotment.get(r.engineId) ?? 0;
      const engineRemaining = engineBudget - (engineUsed.get(r.engineId) ?? 0);
      const globalRemaining = globalMax - totalUsed;
      const target = Math.min(engineRemaining, globalRemaining, cfg.maxContext);

      if (target < this.minItem) {
        truncated = true;
        continue;
      }

      const compressor = getCompressor(cfg.compression);
      const { text, compressed } = compressor.compress(r.snippet, target);
      const tokens = estimateTokens(text);
      if (tokens === 0) {
        truncated = true;
        continue;
      }

      items.push({
        id: r.id,
        title: r.title,
        snippet: text,
        kind: r.domain,
        category: r.category,
        sourceEngine: r.engineId,
        ref: r.uri ?? r.documentId,
        score: Math.min(1, rank),
        tokens,
        updatedAt: r.updatedAt,
        projectId: r.projectId,
        compressed,
      });
      engineUsed.set(r.engineId, (engineUsed.get(r.engineId) ?? 0) + tokens);
      byEngine[r.engineId] = (byEngine[r.engineId] ?? 0) + 1;
      totalUsed += tokens;
    }

    return {
      query: input.query.text,
      items,
      totalTokens: totalUsed,
      budget: { maxTokens: globalMax, usedTokens: totalUsed, truncated },
      byEngine,
      truncated,
      assembledAt: now,
    };
  }
}
