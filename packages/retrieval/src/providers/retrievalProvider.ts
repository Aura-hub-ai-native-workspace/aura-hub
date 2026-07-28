/**
 * RetrievalProvider — the query-strategy seam.
 * ==================================================================
 * Responsibility: given a query and an `IndexProvider`, produce hydrated
 * `SearchResult`s. Separates *how you query* (lexical, dense, hybrid,
 * multi-hop) from *how the index stores* (IndexProvider) and *how docs
 * live* (DocumentStore). The default is a keyword strategy over the
 * index — no embeddings, no vector search.
 */

import type { IndexProvider } from './indexProvider';
import type { RetrievalQuery, SearchResult } from '../types';

export interface RetrievalProvider {
  readonly id: string;
  retrieve(query: RetrievalQuery, index: IndexProvider, engineId: string, k: number): Promise<SearchResult[]>;
}

/**
 * KeywordRetrievalProvider — asks the index for candidates and hydrates
 * them into results. A future dense/hybrid retriever implements the same
 * interface; engines never know the difference.
 */
export class KeywordRetrievalProvider implements RetrievalProvider {
  readonly id = 'keyword-retrieval-provider';

  async retrieve(query: RetrievalQuery, index: IndexProvider, engineId: string, k: number): Promise<SearchResult[]> {
    const candidates = await index.search(query, k);
    const results: SearchResult[] = [];
    for (const cand of candidates) {
      const chunk = index.getChunk(cand.chunkId);
      if (!chunk) continue;
      results.push({
        id: `${engineId}:${chunk.id}`,
        chunkId: chunk.id,
        documentId: chunk.documentId,
        engineId,
        domain: chunk.domain,
        category: chunk.category,
        title: chunk.title,
        snippet: chunk.text,
        uri: chunk.uri,
        projectId: chunk.projectId,
        updatedAt: chunk.updatedAt,
        score: cand.score,
        matched: cand.matched,
      });
    }
    return results;
  }
}
