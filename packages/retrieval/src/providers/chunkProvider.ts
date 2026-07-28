/**
 * ChunkProvider — splits documents into retrievable chunks.
 * ==================================================================
 * Responsibility: turn one `RetrievalDocument` into ordered `Chunk`s.
 * Chunking strategy (fixed-size, semantic, code-aware, sentence) is
 * swappable behind this interface. The default is a naive size-window
 * splitter — enough to make retrieval work, not a production strategy.
 */

import { estimateTokens, type Chunk, type RetrievalDocument } from '../types';

export interface ChunkProvider {
  readonly id: string;
  chunk(doc: RetrievalDocument): Chunk[];
}

export interface NaiveChunkOptions {
  /** Target characters per chunk. */
  size?: number;
  /** Character overlap between adjacent chunks. */
  overlap?: number;
}

/**
 * NaiveChunkProvider — splits on paragraph boundaries, packing up to
 * ~size characters per chunk. Placeholder strategy; real chunkers
 * (AST-aware for code, layout-aware for PDFs) implement the same shape.
 */
export class NaiveChunkProvider implements ChunkProvider {
  readonly id = 'naive-chunk-provider';
  private readonly size: number;
  private readonly overlap: number;

  constructor(opts: NaiveChunkOptions = {}) {
    this.size = opts.size ?? 600;
    this.overlap = opts.overlap ?? 80;
  }

  chunk(doc: RetrievalDocument): Chunk[] {
    const text = doc.text.trim();
    if (!text) return [];

    const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const chunks: string[] = [];
    let buf = '';
    for (const p of paras) {
      if (buf && (buf.length + p.length + 2) > this.size) {
        chunks.push(buf);
        buf = this.overlap > 0 ? buf.slice(-this.overlap) + '\n\n' + p : p;
      } else {
        buf = buf ? `${buf}\n\n${p}` : p;
      }
    }
    if (buf) chunks.push(buf);
    if (chunks.length === 0) chunks.push(text);

    return chunks.map((c, i) => ({
      id: `${doc.id}#${i}`,
      documentId: doc.id,
      ordinal: i,
      text: c,
      tokenEstimate: estimateTokens(c),
      domain: doc.domain,
      category: doc.category,
      title: doc.title,
      uri: doc.uri,
      projectId: doc.projectId,
      updatedAt: doc.updatedAt,
    }));
  }
}
