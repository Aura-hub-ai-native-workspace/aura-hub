/**
 * DocumentStore — storage abstraction for source material.
 * ==================================================================
 * Responsibility: persist and query `RetrievalDocument`s. This is the
 * seam a real store (SQLite, Postgres, object storage, a filesystem
 * walker) plugs into — WITHOUT any upper layer knowing which. The
 * default is a pure in-memory Map. No database dependency exists here.
 */

import type { IndexCategory, RetrievalDocument, RetrievalDomain } from '../types';

export interface DocumentFilter {
  domain?: RetrievalDomain;
  category?: IndexCategory;
  projectId?: string;
  categories?: IndexCategory[];
}

export interface DocumentStore {
  readonly id: string;
  put(doc: RetrievalDocument): Promise<void>;
  putMany(docs: RetrievalDocument[]): Promise<void>;
  get(id: string): Promise<RetrievalDocument | undefined>;
  all(): Promise<RetrievalDocument[]>;
  query(filter: DocumentFilter): Promise<RetrievalDocument[]>;
  delete(id: string): Promise<void>;
  size(): number;
}

/** Default in-memory store. Deterministic, dependency-free. */
export class InMemoryDocumentStore implements DocumentStore {
  readonly id = 'in-memory-document-store';
  private readonly docs = new Map<string, RetrievalDocument>();

  async put(doc: RetrievalDocument): Promise<void> {
    this.docs.set(doc.id, doc);
  }
  async putMany(docs: RetrievalDocument[]): Promise<void> {
    for (const d of docs) this.docs.set(d.id, d);
  }
  async get(id: string): Promise<RetrievalDocument | undefined> {
    return this.docs.get(id);
  }
  async all(): Promise<RetrievalDocument[]> {
    return [...this.docs.values()];
  }
  async query(filter: DocumentFilter): Promise<RetrievalDocument[]> {
    return [...this.docs.values()].filter((d) => {
      if (filter.domain && d.domain !== filter.domain) return false;
      if (filter.category && d.category !== filter.category) return false;
      if (filter.categories && !filter.categories.includes(d.category)) return false;
      if (filter.projectId && d.projectId !== filter.projectId) return false;
      return true;
    });
  }
  async delete(id: string): Promise<void> {
    this.docs.delete(id);
  }
  size(): number {
    return this.docs.size;
  }
}
