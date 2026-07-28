/**
 * Token Budget System
 * ==================================================================
 * A configurable budgeting layer. Each engine declares how much context
 * it may contribute (maxContext), how important it is (priority), and
 * how it compresses / ranks. A global allocator divides a shared token
 * budget across engines by priority, capped per engine. Everything here
 * is pure arithmetic + strategy interfaces — no I/O, no AI.
 */

import { estimateTokens } from '../types';

/** Named compression strategy. Implementations live behind `Compressor`. */
export type CompressionPolicyId = 'none' | 'truncate' | 'summarize';

/** Named ranking strategy. Implementations live behind `RankingProvider`. */
export type RankingPolicyId = 'relevance' | 'recency-weighted' | 'project-weighted' | 'hybrid';

/** What every engine declares about its budgeting behavior. Fully configurable. */
export interface EngineBudgetConfig {
  /** Max tokens this engine may contribute to the final context. */
  maxContext: number;
  /** Weight (0..1) in the global allocation between engines. */
  priority: number;
  /** How this engine shrinks a snippet that doesn't fit. */
  compression: CompressionPolicyId;
  /** How this engine orders its own results. */
  ranking: RankingPolicyId;
}

/* ── Compressors (strategy interface + placeholder implementations) ─── */

/**
 * A Compressor fits text into a token budget. Real strategies (semantic
 * summarization, extractive compression) implement the same interface.
 * None here call an AI — `summarize` is a labelled placeholder.
 */
export interface Compressor {
  readonly id: CompressionPolicyId;
  compress(text: string, targetTokens: number): { text: string; compressed: boolean };
}

export const NoopCompressor: Compressor = {
  id: 'none',
  compress: (text) => ({ text, compressed: false }),
};

export const TruncateCompressor: Compressor = {
  id: 'truncate',
  compress(text, targetTokens) {
    if (estimateTokens(text) <= targetTokens) return { text, compressed: false };
    const maxChars = Math.max(0, targetTokens * 4 - 1);
    return { text: text.slice(0, maxChars).trimEnd() + '…', compressed: true };
  },
};

/**
 * PlaceholderSummarizeCompressor — the SEAM for future semantic
 * summarization. It performs NO AI call; it falls back to truncation and
 * marks the result. Replace it with a real compressor behind this id.
 */
export const PlaceholderSummarizeCompressor: Compressor = {
  id: 'summarize',
  compress: (text, targetTokens) => TruncateCompressor.compress(text, targetTokens),
};

const COMPRESSORS: Record<CompressionPolicyId, Compressor> = {
  none: NoopCompressor,
  truncate: TruncateCompressor,
  summarize: PlaceholderSummarizeCompressor,
};

export const getCompressor = (id: CompressionPolicyId): Compressor => COMPRESSORS[id];

/* ── Global allocation ─────────────────────────────────────────────── */

export interface GlobalBudget {
  /** Total tokens available for the whole context package. */
  maxTokens: number;
  /** Tokens held back (e.g. for the prompt itself). */
  reserveTokens?: number;
}

export interface EngineAllotment {
  engineId: string;
  tokens: number;
}

/**
 * BudgetAllocator — splits the global budget across engines by priority,
 * capped by each engine's `maxContext`. Deterministic. Leftover from
 * capped engines is redistributed once to uncapped engines.
 */
export class BudgetAllocator {
  constructor(private readonly global: GlobalBudget) {}

  allocate(engines: { id: string; config: EngineBudgetConfig }[]): Map<string, number> {
    const available = Math.max(0, this.global.maxTokens - (this.global.reserveTokens ?? 0));
    const totalPriority = engines.reduce((s, e) => s + Math.max(0, e.config.priority), 0) || 1;

    const result = new Map<string, number>();
    let leftover = 0;
    const uncapped: { id: string; config: EngineBudgetConfig }[] = [];

    for (const e of engines) {
      const fair = Math.floor((Math.max(0, e.config.priority) / totalPriority) * available);
      const grant = Math.min(fair, e.config.maxContext);
      result.set(e.id, grant);
      if (grant < fair) leftover += fair - grant;
      else uncapped.push(e);
    }

    // One redistribution pass of leftover to uncapped engines (still capped).
    if (leftover > 0 && uncapped.length) {
      const share = Math.floor(leftover / uncapped.length);
      for (const e of uncapped) {
        const cur = result.get(e.id) ?? 0;
        result.set(e.id, Math.min(e.config.maxContext, cur + share));
      }
    }
    return result;
  }
}
