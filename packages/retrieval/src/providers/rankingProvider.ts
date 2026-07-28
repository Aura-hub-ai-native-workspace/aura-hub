/**
 * RankingProvider — the re-ranking seam.
 * ==================================================================
 * Responsibility: reorder `SearchResult`s according to a policy that
 * blends relevance with recency and project affinity. Separated from
 * retrieval so a cross-encoder / learned ranker can replace the
 * heuristic without touching engines. Pure functions, no I/O, no AI.
 */

import type { RankingPolicyId } from '../budget/tokenBudget';
import type { SearchResult } from '../types';

export interface RankingContext {
  queryText: string;
  now: number;
  policy: RankingPolicyId;
  projectId?: string;
  /** Half-life (ms) for recency decay. Default ~30 days. */
  recencyHalfLifeMs?: number;
}

export interface RankingProvider {
  readonly id: string;
  rank(results: SearchResult[], ctx: RankingContext): SearchResult[];
}

/** Weight profiles per policy: [relevance, recency, project]. */
const WEIGHTS: Record<RankingPolicyId, [number, number, number]> = {
  relevance: [1.0, 0.0, 0.0],
  'recency-weighted': [0.5, 0.4, 0.1],
  'project-weighted': [0.5, 0.1, 0.4],
  hybrid: [0.55, 0.25, 0.2],
};

/**
 * HeuristicRankingProvider — a transparent, deterministic ranker.
 * final = wRel*relevance + wRec*recency + wProj*projectMatch.
 */
export class HeuristicRankingProvider implements RankingProvider {
  readonly id = 'heuristic-ranking-provider';

  rank(results: SearchResult[], ctx: RankingContext): SearchResult[] {
    const [wRel, wRec, wProj] = WEIGHTS[ctx.policy];
    const halfLife = ctx.recencyHalfLifeMs ?? 30 * 24 * 60 * 60 * 1000;

    const scored = results.map((r) => {
      const ageMs = Math.max(0, ctx.now - r.updatedAt);
      const recency = Math.pow(0.5, ageMs / halfLife); // 1 (fresh) → 0 (old)
      const projectMatch = ctx.projectId && r.projectId === ctx.projectId ? 1 : 0;
      const final = wRel * r.score + wRec * recency + wProj * projectMatch;
      return { r, final };
    });

    return scored
      .sort((a, b) => b.final - a.final)
      .map(({ r, final }) => ({ ...r, score: Math.min(1, final) }));
  }
}
