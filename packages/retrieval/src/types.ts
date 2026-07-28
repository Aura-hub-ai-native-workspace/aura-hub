/**
 * @aura/retrieval — Core Vocabulary
 * ==================================================================
 * The shared types every retrieval and memory component speaks. They
 * are provider-independent: nothing here references a vector database,
 * SQLite, Chroma, LanceDB, FAISS, embeddings, an AI provider, a UI, or
 * a runtime. A concrete backend maps ITS shapes onto these at an adapter
 * — and only there.
 */

/* ── Domains & index categories ────────────────────────────────────── */

/** The four independent retrieval domains. Each has its own engine. */
export type RetrievalDomain = 'coding' | 'chat' | 'research' | 'fullstack';

/**
 * Everything an engine may index. Declaring categories is documentation:
 * it states, in the type system, exactly what each engine is responsible
 * for — without implementing any indexing.
 */
export type IndexCategory =
  // coding
  | 'source-code' | 'apis' | 'documentation' | 'git-history' | 'errors' | 'architecture' | 'dependencies'
  // chat
  | 'conversations' | 'preferences' | 'notes' | 'tasks' | 'workspace-memory'
  // research
  | 'pdfs' | 'books' | 'websites' | 'papers' | 'local-knowledge'
  // fullstack
  | 'frontend' | 'backend' | 'database' | 'api-contracts' | 'deployment' | 'project-structure';

/* ── Documents & chunks ────────────────────────────────────────────── */

export type Metadata = Record<string, unknown>;

/** A unit of source material handed to the layer. Storage-agnostic. */
export interface RetrievalDocument {
  id: string;
  domain: RetrievalDomain;
  category: IndexCategory;
  title: string;
  text: string;
  uri?: string;
  projectId?: string;
  /** Epoch ms — powers recency ranking. */
  updatedAt: number;
  metadata?: Metadata;
}

/** A retrievable slice of a document. Denormalized for cheap ranking/citation. */
export interface Chunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  tokenEstimate: number;
  domain: RetrievalDomain;
  category: IndexCategory;
  title: string;
  uri?: string;
  projectId?: string;
  updatedAt: number;
}

/** An embedding vector. Defined for the interface only — never computed here. */
export interface Embedding {
  vector: number[];
  dim: number;
  model: string;
}

/* ── Queries & results ─────────────────────────────────────────────── */

export interface RetrievalQuery {
  text: string;
  projectId?: string;
  sessionId?: string;
  /** Restrict to specific domains/engines. Empty = all. */
  domains?: RetrievalDomain[];
  /** Restrict to specific index categories. */
  categories?: IndexCategory[];
  /** Per-engine candidate cap before budgeting. */
  limit?: number;
  /** Injectable clock for deterministic recency scoring. */
  now?: number;
  filters?: Metadata;
}

/** One retrieved, scored hit from an engine. */
export interface SearchResult {
  id: string;
  chunkId: string;
  documentId: string;
  engineId: string;
  domain: RetrievalDomain;
  category: IndexCategory;
  title: string;
  snippet: string;
  uri?: string;
  projectId?: string;
  updatedAt: number;
  /** Relevance in 0..1 as produced by retrieval/ranking. */
  score: number;
  /** Debug: which query terms matched. */
  matched?: string[];
}

/* ── Assembled context ─────────────────────────────────────────────── */

/** A single, budget-fitted piece of the final context. */
export interface ContextItem {
  id: string;
  title: string;
  snippet: string;
  kind: RetrievalDomain | 'memory';
  category?: IndexCategory;
  sourceEngine: string;
  /** Citation reference (uri or documentId). */
  ref?: string;
  score: number;
  tokens: number;
  updatedAt?: number;
  projectId?: string;
  /** True when the snippet was compressed/truncated to fit the budget. */
  compressed?: boolean;
}

export interface BudgetInfo {
  maxTokens: number;
  usedTokens: number;
  truncated: boolean;
}

/**
 * The single artifact the whole layer exists to produce: a ranked,
 * de-duplicated, budget-respecting bundle of context ready to hand to
 * the intelligence pipeline. No AI, no provider data — just context.
 */
export interface ContextPackage {
  query: string;
  items: ContextItem[];
  totalTokens: number;
  budget: BudgetInfo;
  /** How many items each engine contributed. */
  byEngine: Record<string, number>;
  truncated: boolean;
  assembledAt: number;
}

/** Shared, neutral token estimator (~4 chars/token). No tokenizer dependency. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
