/**
 * @aura/retrieval — public surface
 * ==================================================================
 * The retrieval & memory foundation for AURA Hub. Four independent
 * domain engines, a layered memory hierarchy, a token-budget system,
 * and a context assembler that emits one ContextPackage.
 *
 * Provider-independent: no embeddings, no indexing, no vector DB, no
 * coupling to any AI provider, UI, or runtime. Real backends attach at
 * the documented seams (IndexProvider, RetrievalProvider,
 * EmbeddingProvider, DocumentStore, MemoryProvider) with no upstream
 * change.
 *
 * Quick start:
 *   import { createRetrievalKernel } from '@aura/retrieval';
 *   const kernel = createRetrievalKernel();
 *   await kernel.ingest(docs);
 *   const pkg = await kernel.retrieve({ text: 'how does routing work?' });
 */

// Vocabulary
export * from './types';

// Kernel + config (entry points)
export { RetrievalKernel, type RetrievalKernelDeps } from './kernel';
export {
  createRetrievalKernel,
  resolveRetrievalConfig,
  createDefaultMemory,
  type RetrievalConfig,
} from './config';

// Token budget system
export {
  type EngineBudgetConfig,
  type CompressionPolicyId,
  type RankingPolicyId,
  type Compressor,
  type GlobalBudget,
  type EngineAllotment,
  BudgetAllocator,
  NoopCompressor,
  TruncateCompressor,
  PlaceholderSummarizeCompressor,
  getCompressor,
} from './budget/tokenBudget';

// Provider seams (+ in-memory dummies)
export { type DocumentStore, type DocumentFilter, InMemoryDocumentStore } from './providers/documentStore';
export { type ChunkProvider, type NaiveChunkOptions, NaiveChunkProvider } from './providers/chunkProvider';
export { type EmbeddingProvider, NullEmbeddingProvider } from './providers/embeddingProvider';
export { type IndexProvider, type IndexCandidate, InMemoryIndexProvider } from './providers/indexProvider';
export { type RetrievalProvider, KeywordRetrievalProvider } from './providers/retrievalProvider';
export { type RankingProvider, type RankingContext, HeuristicRankingProvider } from './providers/rankingProvider';

// Retrieval engines (four independent domains)
export {
  type RetrievalEngine,
  type EngineDeps,
  BaseRetrievalEngine,
  RetrievalEngineRegistry,
} from './engines/retrievalEngine';
export { CodingRetrievalEngine, CODING_DEFAULT_CONFIG } from './engines/codingEngine';
export { ChatRetrievalEngine, CHAT_DEFAULT_CONFIG } from './engines/chatEngine';
export { ResearchRetrievalEngine, RESEARCH_DEFAULT_CONFIG } from './engines/researchEngine';
export { FullStackRetrievalEngine, FULLSTACK_DEFAULT_CONFIG } from './engines/fullstackEngine';

// Context assembler
export {
  type ContextAssembler,
  type AssembleInput,
  type DefaultAssemblerOptions,
  DefaultContextAssembler,
} from './assembler/contextAssembler';

// Layered memory
export {
  type MemoryLayer,
  type MemoryKind,
  type MemoryRecord,
  type MemoryWrite,
  type MemoryQuery,
  type MemoryProvider,
  InMemoryMemoryProvider,
} from './memory/memoryProvider';
export {
  type SessionMemory,
  type ProjectMemory,
  type WorkspaceMemory,
  type KnowledgeMemory,
  type PersistentMemory,
  MEMORY_LAYER_ORDER,
  LAYER_WEIGHT,
  InMemorySessionMemory,
  InMemoryProjectMemory,
  InMemoryWorkspaceMemory,
  InMemoryKnowledgeMemory,
  InMemoryPersistentMemory,
} from './memory/layers';
export {
  MemoryHierarchy,
  type MemoryLayers,
  type RecallHit,
  type RecallOptions,
  DEFAULT_KIND_LAYER,
} from './memory/hierarchy';

// Demo
export { runDemo } from './demo';
