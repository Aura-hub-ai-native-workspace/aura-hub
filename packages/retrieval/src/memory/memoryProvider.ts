/**
 * MemoryProvider — the memory storage seam.
 * ==================================================================
 * Responsibility: read/write `MemoryRecord`s for ONE layer. Every layer
 * of the hierarchy is just a MemoryProvider with a fixed `layer`, so any
 * layer can be backed by anything (in-memory, file, KV, DB) and swapped
 * independently. No database, no vector store here.
 */

export type MemoryLayer = 'session' | 'project' | 'workspace' | 'knowledge' | 'persistent';

export type MemoryKind =
  | 'message'
  | 'preference'
  | 'note'
  | 'task'
  | 'decision'
  | 'fact'
  | 'summary';

export interface MemoryRecord {
  id: string;
  layer: MemoryLayer;
  kind: MemoryKind;
  content: string;
  /** 0..1 salience — influences recall ranking and eviction. */
  importance: number;
  createdAt: number;
  updatedAt: number;
  projectId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** Fields a caller supplies when writing; the rest are filled in. */
export type MemoryWrite = Omit<MemoryRecord, 'id' | 'layer' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<MemoryRecord, 'id'>>;

export interface MemoryQuery {
  text?: string;
  projectId?: string;
  sessionId?: string;
  kinds?: MemoryKind[];
  tags?: string[];
  /** Only records updated at/after this epoch-ms. */
  since?: number;
  limit?: number;
}

export interface MemoryProvider {
  readonly id: string;
  readonly layer: MemoryLayer;
  write(record: MemoryWrite): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | undefined>;
  read(query: MemoryQuery): Promise<MemoryRecord[]>;
  forget(id: string): Promise<void>;
  all(): Promise<MemoryRecord[]>;
  clear(): Promise<void>;
}

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * InMemoryMemoryProvider — default implementation for any single layer.
 * Deterministic Map storage with a simple lexical `read` filter. Real
 * layers (persisted KV, encrypted store) implement `MemoryProvider`.
 */
export class InMemoryMemoryProvider implements MemoryProvider {
  private readonly records = new Map<string, MemoryRecord>();
  private seq = 0;

  constructor(
    readonly layer: MemoryLayer,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get id(): string {
    return `in-memory-${this.layer}-memory`;
  }

  async write(record: MemoryWrite): Promise<MemoryRecord> {
    const now = this.clock();
    const id = record.id ?? `${this.layer}:${(this.seq++).toString(36)}`;
    const existing = this.records.get(id);
    const full: MemoryRecord = {
      ...record,
      id,
      layer: this.layer,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(id, full);
    return full;
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    return this.records.get(id);
  }

  async read(query: MemoryQuery): Promise<MemoryRecord[]> {
    const terms = query.text ? new Set(tokenize(query.text)) : null;
    const results = [...this.records.values()].filter((r) => {
      if (query.projectId && r.projectId !== query.projectId) return false;
      if (query.sessionId && r.sessionId !== query.sessionId) return false;
      if (query.kinds && !query.kinds.includes(r.kind)) return false;
      if (query.since && r.updatedAt < query.since) return false;
      if (query.tags && !query.tags.every((t) => r.tags?.includes(t))) return false;
      if (terms) {
        const words = new Set(tokenize(r.content));
        if (![...terms].some((t) => words.has(t))) return false;
      }
      return true;
    });
    // Most salient + recent first.
    results.sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
    return query.limit ? results.slice(0, query.limit) : results;
  }

  async forget(id: string): Promise<void> {
    this.records.delete(id);
  }
  async all(): Promise<MemoryRecord[]> {
    return [...this.records.values()];
  }
  async clear(): Promise<void> {
    this.records.clear();
  }
}
