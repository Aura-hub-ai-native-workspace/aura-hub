/**
 * @aura/knowledge-coding — Types
 * ==================================================================
 * Real domain types for the Coding Knowledge Engine. Reuses the frozen
 * @aura/retrieval vocabulary where it fits (token estimation, the
 * ContextPackage bridge) and adds the concrete, filesystem-backed shapes
 * this engine needs. No mock shapes — every field describes a real file.
 */

export type LanguageId =
  | 'typescript' | 'javascript' | 'tsx' | 'jsx'
  | 'json' | 'jsonc' | 'yaml' | 'toml' | 'ini' | 'xml' | 'sql'
  | 'markdown' | 'text'
  | 'rust' | 'python' | 'go' | 'java' | 'c' | 'cpp' | 'csharp' | 'ruby' | 'php' | 'swift' | 'kotlin'
  | 'css' | 'scss' | 'html'
  | 'shell' | 'dockerfile' | 'makefile'
  | 'license' | 'gitignore' | 'env'
  | 'binary' | 'unknown';

/** Coarse file role — used for filtering, boosting and reporting. */
export type FileKind = 'code' | 'doc' | 'config' | 'manifest' | 'license' | 'ignore' | 'data' | 'text' | 'binary' | 'unknown';

/** One indexed file. Every field is derived from the real file on disk. */
export interface CodeDocument {
  id: string;
  absPath: string;
  relPath: string;
  projectRoot: string;
  name: string;
  ext: string;
  language: LanguageId;
  kind: FileKind;
  /** File size in bytes. */
  size: number;
  /** Content hash (sha1) — powers change detection. */
  checksum: string;
  /** mtime in epoch ms. */
  modifiedMs: number;
  /** When this document was last indexed. */
  indexedMs: number;
  lines: number;
  /** Content was capped at the size limit. */
  truncated: boolean;
  binary: boolean;
  metadata: Record<string, unknown>;
}

/** A retrievable slice of a document, with precise source coordinates. */
export interface CodeChunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  startLine: number; // 1-based inclusive
  endLine: number;   // 1-based inclusive
  startByte: number;
  endByte: number;
  tokenEstimate: number;
  language: LanguageId;
  relPath: string;
  /** Light extracted identifiers/headings for boosting. */
  symbols: string[];
}

/* ── Scanning & ignore ─────────────────────────────────────────────── */

export interface IgnoreConfig {
  /** Directory names to skip entirely (in addition to defaults). */
  directories?: string[];
  /** Substring/suffix patterns to skip (matched against relative path). */
  patterns?: string[];
  /** File extensions to skip (with dot, e.g. '.png'). */
  extensions?: string[];
  /** Skip files larger than this many bytes for content (default 2 MiB). */
  maxFileBytes?: number;
  /** Include dotfiles/dot-folders (default false). */
  includeHidden?: boolean;
  /** Replace the built-in defaults instead of extending them. */
  replaceDefaults?: boolean;
}

export interface ScanEntry {
  absPath: string;
  relPath: string;
  size: number;
  modifiedMs: number;
}

/* ── Progress & cancellation ───────────────────────────────────────── */

export type IndexPhase = 'scan' | 'read' | 'chunk' | 'index' | 'persist' | 'done';

export interface Progress {
  phase: IndexPhase;
  processed: number;
  total?: number;
  path?: string;
}
export type ProgressCallback = (p: Progress) => void;

export interface IndexOptions {
  ignore?: IgnoreConfig;
  onProgress?: ProgressCallback;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

/* ── Results & stats ───────────────────────────────────────────────── */

export interface FileError {
  relPath: string;
  code: string;
  message: string;
}

export interface IndexStats {
  files: number;
  chunks: number;
  bytes: number;
  skipped: number;
  binaries: number;
  errors: FileError[];
  durationMs: number;
  byLanguage: Record<string, number>;
}

export interface IndexDelta {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
  stats: IndexStats;
}

/* ── Search ────────────────────────────────────────────────────────── */

export type MatchMode = 'auto' | 'exact' | 'prefix' | 'fuzzy';

export interface SearchQuery {
  text: string;
  /** Term-matching strategy. 'auto' blends exact + prefix + fuzzy. */
  mode?: MatchMode;
  languages?: LanguageId[];
  /** Extensions with dot, e.g. ['.ts', '.md']. */
  extensions?: string[];
  kinds?: FileKind[];
  /** Case-insensitive substring the relative path must contain. */
  pathIncludes?: string;
  /** Case-insensitive substring the filename must contain (also boosts). */
  filename?: string;
  limit?: number;
  /** Max Levenshtein distance for fuzzy term expansion (default derived from term length). */
  fuzzyMaxDistance?: number;
}

export interface SearchHit {
  chunk: CodeChunk;
  document: CodeDocument;
  score: number;
  matchedTerms: string[];
  /** Why it ranked: e.g. ['bm25', 'filename', 'prefix', 'recency']. */
  reasons: string[];
}

/* ── Context ───────────────────────────────────────────────────────── */

export interface ContextChunkRef {
  chunk: CodeChunk;
  role: 'match' | 'neighbor';
}

export interface CodingContextEntry {
  document: CodeDocument;
  chunks: ContextChunkRef[];
  score: number;
  /** Human/citation reference: `relPath:startLine-endLine`. */
  source: string;
  tokens: number;
}

export interface ProjectMeta {
  root: string;
  name: string;
  fileCount: number;
  chunkCount: number;
}

export interface CodingContext {
  query: string;
  entries: CodingContextEntry[];
  totalTokens: number;
  project: ProjectMeta;
  truncated: boolean;
}

export interface ContextOptions {
  limit?: number;
  /** Include N neighbor chunks on each side of a match (default 1). */
  neighbors?: number;
  /** Token budget for the whole context (default 6000). */
  maxTokens?: number;
}
