/**
 * CodingSearch — production keyword search.
 * ==================================================================
 * Runs BM25 over the inverted index, then applies real filters
 * (language, extension, kind, path, filename) and ranking boosts
 * (filename/path/symbol match, recency). Supports exact, prefix and
 * fuzzy term matching. No vector search.
 */

import type { KnowledgeStore } from './store/indexStore';
import { tokenize, type ExpansionKind } from './store/invertedIndex';
import type { SearchHit, SearchQuery } from './types';

const MODE_EXPANSIONS: Record<NonNullable<SearchQuery['mode']>, ExpansionKind[]> = {
  exact: ['exact'],
  prefix: ['exact', 'prefix'],
  fuzzy: ['exact', 'fuzzy'],
  auto: ['exact', 'prefix', 'fuzzy'],
};

export class CodingSearch {
  constructor(private readonly store: KnowledgeStore, private readonly now: () => number = () => Date.now()) {}

  search(query: SearchQuery): SearchHit[] {
    const qTokens = tokenize(query.text);
    if (qTokens.length === 0) return [];

    const modes = new Set<ExpansionKind>(MODE_EXPANSIONS[query.mode ?? 'auto']);
    const maxDist = query.fuzzyMaxDistance ?? 2;
    const raw = this.store.index.search(qTokens, modes, maxDist);

    const limit = query.limit ?? 20;
    const hits: SearchHit[] = [];
    const now = this.now();

    for (const r of raw) {
      const chunk = this.store.getChunk(r.chunkId);
      if (!chunk) continue;
      const doc = this.store.getDocument(chunk.documentId);
      if (!doc) continue;

      // ── Filters ──
      if (query.languages && !query.languages.includes(doc.language)) continue;
      if (query.extensions && !query.extensions.includes(doc.ext)) continue;
      if (query.kinds && !query.kinds.includes(doc.kind)) continue;
      if (query.pathIncludes && !doc.relPath.toLowerCase().includes(query.pathIncludes.toLowerCase())) continue;
      if (query.filename && !doc.name.toLowerCase().includes(query.filename.toLowerCase())) continue;

      // ── Boosts ──
      let score = r.score;
      const reasons = new Set(r.reasons);
      const nameLower = doc.name.toLowerCase();
      const pathLower = doc.relPath.toLowerCase();
      const symSet = new Set(chunk.symbols.map((s) => s.toLowerCase()));

      if (r.matched.some((t) => nameLower.includes(t))) { score *= 1.6; reasons.add('filename'); }
      if (r.matched.some((t) => pathLower.includes(t))) { score *= 1.2; reasons.add('path'); }
      if (r.matched.some((t) => symSet.has(t) || [...symSet].some((s) => s.includes(t)))) { score *= 1.3; reasons.add('symbol'); }
      if (query.filename) { score *= 1.3; reasons.add('filename-filter'); }

      const ageDays = Math.max(0, (now - doc.modifiedMs) / 86_400_000);
      const recency = Math.pow(0.5, ageDays / 60);
      score *= 1 + 0.15 * recency;
      if (recency > 0.5) reasons.add('recency');

      hits.push({ chunk, document: doc, score, matchedTerms: r.matched, reasons: [...reasons] });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
