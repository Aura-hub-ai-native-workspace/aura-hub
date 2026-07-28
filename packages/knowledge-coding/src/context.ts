/**
 * ContextBuilder — assembles retrieval context from search hits.
 * ==================================================================
 * For the top hits, returns: the matched chunks, their neighbor chunks
 * (for surrounding code), file + document metadata, project metadata,
 * a token count, and precise source references. Respects a token budget.
 */

import type { KnowledgeStore } from './store/indexStore';
import type {
  CodeDocument,
  CodingContext,
  CodingContextEntry,
  ContextChunkRef,
  ContextOptions,
  SearchHit,
} from './types';

export class ContextBuilder {
  constructor(private readonly store: KnowledgeStore, private readonly projectName: string) {}

  build(query: string, hits: SearchHit[], opts: ContextOptions = {}): CodingContext {
    const neighbors = opts.neighbors ?? 1;
    const maxTokens = opts.maxTokens ?? 6000;
    const limit = opts.limit ?? 8;

    // Group hits by document, keeping the best score + all matched chunks.
    const groups = new Map<string, { score: number; matchIds: Set<string> }>();
    for (const h of hits) {
      const g = groups.get(h.document.id) ?? { score: 0, matchIds: new Set<string>() };
      g.score = Math.max(g.score, h.score);
      g.matchIds.add(h.chunk.id);
      groups.set(h.document.id, g);
    }

    const ordered = [...groups.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);

    const entries: CodingContextEntry[] = [];
    let totalTokens = 0;
    let truncated = false;

    for (const [docId, g] of ordered) {
      const doc = this.store.getDocument(docId);
      if (!doc) continue;

      // Collect matched chunks + neighbors, de-duplicated, in source order.
      const byId = new Map<string, ContextChunkRef>();
      for (const cid of g.matchIds) {
        const chunk = this.store.getChunk(cid);
        if (chunk) byId.set(cid, { chunk, role: 'match' });
        for (const nb of this.store.neighborChunks(cid, neighbors)) {
          if (!byId.has(nb.id)) byId.set(nb.id, { chunk: nb, role: 'neighbor' });
        }
      }
      const refs = [...byId.values()].sort((a, b) => a.chunk.startLine - b.chunk.startLine);

      // Budget: add whole entries until the token budget is exhausted.
      const entryTokens = refs.reduce((s, r) => s + r.chunk.tokenEstimate, 0);
      if (totalTokens + entryTokens > maxTokens) {
        // Try to fit at least the match chunks if nothing added yet.
        if (entries.length === 0) {
          const matchOnly = refs.filter((r) => r.role === 'match');
          const t = matchOnly.reduce((s, r) => s + r.chunk.tokenEstimate, 0);
          if (t <= maxTokens) {
            entries.push(this.entry(doc, matchOnly, g.score));
            totalTokens += t;
          }
        }
        truncated = true;
        break;
      }

      entries.push(this.entry(doc, refs, g.score));
      totalTokens += entryTokens;
    }

    return {
      query,
      entries,
      totalTokens,
      project: {
        root: this.store.root,
        name: this.projectName,
        fileCount: this.store.stats().documents,
        chunkCount: this.store.stats().chunks,
      },
      truncated,
    };
  }

  private entry(doc: CodeDocument, refs: ContextChunkRef[], score: number): CodingContextEntry {
    const startLine = Math.min(...refs.map((r) => r.chunk.startLine));
    const endLine = Math.max(...refs.map((r) => r.chunk.endLine));
    const tokens = refs.reduce((s, r) => s + r.chunk.tokenEstimate, 0);
    return { document: doc, chunks: refs, score, source: `${doc.relPath}:${startLine}-${endLine}`, tokens };
  }
}
