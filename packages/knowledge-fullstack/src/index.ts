/**
 * @aura/knowledge-fullstack — public surface
 * ==================================================================
 * The production FullStack Knowledge Engine: analyzes a real workspace
 * into a persistent, cross-layer project graph (pages · components ·
 * routes · endpoints · controllers · services · repositories · tables ·
 * migrations · env vars · docker · compose · CI · deps · architecture)
 * and answers system-level questions with a structured ContextPackage.
 *
 * Reuses the frozen Coding Knowledge Engine. No embeddings, no vector
 * search, no mock data.
 *
 *   import { FullStackKnowledgeEngine } from '@aura/knowledge-fullstack';
 *   const engine = new FullStackKnowledgeEngine(process.cwd());
 *   await engine.analyze();
 *   engine.search({ text: 'Where is authentication implemented?' });
 */

export { FullStackKnowledgeEngine, type FullStackEngineOptions } from './engine';
export { FullStackIndexer, type AnalyzeOptions } from './indexer';
export { FullStackSearch } from './search';

// Graph
export { ProjectGraphStore, type FileRecord } from './graph/graphStore';
export { RelationLinker } from './link/linker';

// Extraction (pluggable)
export { ExtractorRegistry } from './extract/registry';
export {
  type Extractor,
  type SourceFile,
  LineMap,
  makeEntity,
  entityId,
  importSpecifiers,
  envRefs,
} from './extract/extractor';
export { FrontendExtractor } from './extract/frontend';
export { BackendExtractor } from './extract/backend';
export { DatabaseExtractor } from './extract/database';
export { ConfigExtractor } from './extract/config';
export { ArchitectureExtractor } from './extract/architecture';

// Types
export type {
  Layer,
  EntityKind,
  RelationKind,
  Entity,
  Relation,
  GraphStats,
  GraphDelta,
  AnalyzeStats,
  QueryIntent,
  SystemQuery,
  EntityHit,
  RelationPath,
  SystemAnswer,
} from './types';
