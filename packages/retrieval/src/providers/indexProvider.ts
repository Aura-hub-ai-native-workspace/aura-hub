/**
 * IndexProvider — the searchable-index seam.
 * ==================================================================
 * Responsibility: hold chunks and return candidate matches for a query.
 * THIS is where a real vector DB / inverted index / hybrid engine plugs
 * in (Chroma, LanceDB, FAISS, Postgres FTS, …) — all behind this one
 * interface. The default `InMemoryIndexProvider` does trivial lexical
 * term-overlap scoring: a placeholder to make engines work, NOT real
 * indexing or vector search.
 */

import type { Chunk, RetrievalQuery } from '../types';

export interface IndexCandidate {
  chunkId: string;
  /** 0..1 similarity as judged by the index. */
  score: number;
  matched?: string[];
}

export interface IndexProvider {
  readonly id: string;
  add(chunks: Chunk[]): Promise<void>;
  remove(chunkId: string): Promise<void>;
  getChunk(chunkId: string): Chunk | undefined;
  size(): number;
  /** Return up to `k` candidate chunks for the query. */
  search(query: RetrievalQuery, k: number): Promise<IndexCandidate[]>;
}

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * InMemoryIndexProvider — placeholder lexical index. Scores chunks by
 * query-term overlap, honoring category/project filters carried on the
 * query. Deterministic and dependency-free. Replace with a real index
 * behind the `IndexProvider` interface; no caller changes.
 */
export class InMemoryIndexProvider implements IndexProvider {
  readonly id = 'in-memory-lexical-index';
  private readonly chunks = new Map<string, Chunk>();

  async add(chunks: Chunk[]): Promise<void> {
    for (const c of chunks) this.chunks.set(c.id, c);
  }
  async remove(chunkId: string): Promise<void> {
    this.chunks.delete(chunkId);
  }
  getChunk(chunkId: string): Chunk | undefined {
    return this.chunks.get(chunkId);
  }
  size(): number {
    return this.chunks.size;
  }

  async search(query: RetrievalQuery, k: number): Promise<IndexCandidate[]> {
    const terms = new Set(tokenize(query.text));
    if (terms.size === 0) return [];

    const out: IndexCandidate[] = [];
    for (const c of this.chunks.values()) {
      if (query.categories && !query.categories.includes(c.category)) continue;
      if (query.projectId && c.projectId && c.projectId !== query.projectId) continue;

      const words = tokenize(`${c.title} ${c.text}`);
      const matched: string[] = [];
      let hits = 0;
      const seen = new Set<string>();
      for (const w of words) {
        if (terms.has(w)) {
          hits++;
          if (!seen.has(w)) {
            seen.add(w);
            matched.push(w);
          }
        }
      }
      if (hits === 0) continue;
      // coverage of query terms + a small density factor, squashed to 0..1
      const coverage = seen.size / terms.size;
      const density = hits / Math.max(20, words.length);
      const score = Math.min(1, 0.7 * coverage + 0.3 * Math.min(1, density * 8));
      out.push({ chunkId: c.id, score, matched });
    }

    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
