/**
 * @aura/knowledge-coding — public surface
 * ==================================================================
 * The production Coding Knowledge Engine: real recursive filesystem
 * indexing, incremental updates, and keyword retrieval (exact / prefix /
 * fuzzy + filters + ranking) over actual project files. No embeddings,
 * no vector search — the vector index attaches later behind KnowledgeStore.
 *
 * Quick start:
 *   import { CodingKnowledgeEngine } from '@aura/knowledge-coding';
 *   const engine = new CodingKnowledgeEngine(process.cwd());
 *   await engine.index({ onProgress: (p) => console.log(p.phase, p.processed) });
 *   const hits = engine.search({ text: 'context assembler', mode: 'auto' });
 *   const ctx = engine.getContext({ text: 'task router' });
 */

export { CodingKnowledgeEngine, type CodingEngineOptions } from './engine';

// Pipeline components (each usable / replaceable on its own)
export { WorkspaceScanner, type ScanResult } from './scanner';
export { IgnoreRules, DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_EXTS, DEFAULT_MAX_FILE_BYTES } from './ignore';
export { readFileSafe, type ReadResult } from './reader';
export { chunkDocument, type ChunkOptions } from './chunker';
export { detectLanguage, detectKind, isIndexableLanguage } from './languages';
export { sha1 } from './checksum';
export { CodingIndexer } from './indexer';
export { CodingSearch } from './search';
export { ContextBuilder } from './context';

// Storage
export {
  type KnowledgeStore,
  type FileRecord,
  JsonKnowledgeStore,
} from './store/indexStore';
export { InvertedIndex, tokenize, type ExpansionKind, type RawHit } from './store/invertedIndex';

// Types
export type {
  LanguageId,
  FileKind,
  CodeDocument,
  CodeChunk,
  IgnoreConfig,
  ScanEntry,
  IndexPhase,
  Progress,
  ProgressCallback,
  IndexOptions,
  FileError,
  IndexStats,
  IndexDelta,
  MatchMode,
  SearchQuery,
  SearchHit,
  ContextChunkRef,
  CodingContextEntry,
  ProjectMeta,
  CodingContext,
  ContextOptions,
} from './types';
