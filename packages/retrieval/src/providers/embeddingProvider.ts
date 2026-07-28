/**
 * EmbeddingProvider — the vectorization seam.
 * ==================================================================
 * Responsibility: turn text into an `Embedding`. This interface EXISTS
 * so a future embedding model / vector index can attach here — but no
 * embeddings are implemented (per the mission). The default is a Null
 * provider that returns a clearly non-semantic placeholder vector and
 * is NOT used by the default keyword retrieval path.
 *
 * A real provider (local model, hosted API, ONNX runtime) implements
 * this one interface. Nothing above it changes.
 */

import type { Embedding } from '../types';

export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  readonly model: string;
  embed(text: string): Promise<Embedding>;
  embedMany(texts: string[]): Promise<Embedding[]>;
}

/**
 * NullEmbeddingProvider — placeholder. Produces a deterministic hashed
 * pseudo-vector so the interface is exercisable in tests. This is NOT a
 * semantic embedding and must not be used for real similarity search;
 * it only proves the seam is wired. Swap for a real model later.
 */
export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'null-embedding-provider';
  readonly model = 'placeholder-null';
  constructor(readonly dim: number = 8) {}

  private hashVector(text: string): number[] {
    const v = new Array(this.dim).fill(0);
    for (let i = 0; i < text.length; i++) v[i % this.dim] += text.charCodeAt(i);
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }

  async embed(text: string): Promise<Embedding> {
    return { vector: this.hashVector(text), dim: this.dim, model: this.model };
  }
  async embedMany(texts: string[]): Promise<Embedding[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
