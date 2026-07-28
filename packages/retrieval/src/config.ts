/**
 * @aura/retrieval — Configuration & Wiring
 * ==================================================================
 * The composition root: the ONLY place concrete implementations are
 * named. Every field is optional and defaults to an in-memory
 * placeholder. Swap any provider, engine, memory layer, or the whole
 * assembler here — nothing upstream changes.
 *
 * Each engine gets its OWN index (domain isolation) while sharing the
 * stateless chunker/retrieval/ranking strategies. Override `makeIndex`
 * to back engines with a real store, one line, no other edits.
 */

import type { GlobalBudget } from './budget/tokenBudget';
import { NaiveChunkProvider, type ChunkProvider } from './providers/chunkProvider';
import { InMemoryIndexProvider, type IndexProvider } from './providers/indexProvider';
import { KeywordRetrievalProvider, type RetrievalProvider } from './providers/retrievalProvider';
import { HeuristicRankingProvider, type RankingProvider } from './providers/rankingProvider';
import { DefaultContextAssembler, type ContextAssembler } from './assembler/contextAssembler';
import { RetrievalEngineRegistry, type EngineDeps, type RetrievalEngine } from './engines/retrievalEngine';
import { CodingRetrievalEngine } from './engines/codingEngine';
import { ChatRetrievalEngine } from './engines/chatEngine';
import { ResearchRetrievalEngine } from './engines/researchEngine';
import { FullStackRetrievalEngine } from './engines/fullstackEngine';
import {
  InMemoryKnowledgeMemory,
  InMemoryPersistentMemory,
  InMemoryProjectMemory,
  InMemorySessionMemory,
  InMemoryWorkspaceMemory,
} from './memory/layers';
import { MemoryHierarchy } from './memory/hierarchy';
import { RetrievalKernel, type RetrievalKernelDeps } from './kernel';

export interface RetrievalConfig {
  /** Replace the entire engine set. Default: the four domain engines. */
  engines?: RetrievalEngine[];
  chunker?: ChunkProvider;
  retrieval?: RetrievalProvider;
  ranking?: RankingProvider;
  /** Per-engine index factory (domain isolation). Default: in-memory lexical. */
  makeIndex?: () => IndexProvider;
  assembler?: ContextAssembler;
  /** Provide a hierarchy, or `false` to disable memory entirely. */
  memory?: MemoryHierarchy | false;
  globalBudget?: GlobalBudget;
  memoryRecallLimit?: number;
  clock?: () => number;
}

/** Build the default five-layer in-memory memory hierarchy. */
export function createDefaultMemory(clock: () => number = () => Date.now()): MemoryHierarchy {
  return new MemoryHierarchy(
    {
      session: new InMemorySessionMemory(clock),
      project: new InMemoryProjectMemory(clock),
      workspace: new InMemoryWorkspaceMemory(clock),
      knowledge: new InMemoryKnowledgeMemory(clock),
      persistent: new InMemoryPersistentMemory(clock),
    },
    clock,
  );
}

/** Resolve a partial config into fully-wired kernel dependencies. */
export function resolveRetrievalConfig(config: RetrievalConfig = {}): RetrievalKernelDeps {
  const clock = config.clock ?? (() => Date.now());
  const chunker = config.chunker ?? new NaiveChunkProvider();
  const retrieval = config.retrieval ?? new KeywordRetrievalProvider();
  const ranking = config.ranking ?? new HeuristicRankingProvider();
  const makeIndex = config.makeIndex ?? (() => new InMemoryIndexProvider());

  const registry = new RetrievalEngineRegistry();
  const engines =
    config.engines ??
    (() => {
      const mk = (): EngineDeps => ({ index: makeIndex(), retrieval, ranking, chunker, clock });
      return [
        new CodingRetrievalEngine(mk()),
        new ChatRetrievalEngine(mk()),
        new ResearchRetrievalEngine(mk()),
        new FullStackRetrievalEngine(mk()),
      ];
    })();
  engines.forEach((e) => registry.register(e));

  const memory = config.memory === false ? undefined : config.memory ?? createDefaultMemory(clock);

  return {
    engines: registry,
    assembler: config.assembler ?? new DefaultContextAssembler(),
    globalBudget: config.globalBudget ?? { maxTokens: 6000, reserveTokens: 500 },
    memory,
    memoryRecallLimit: config.memoryRecallLimit,
    clock,
  };
}

/** Factory — the ergonomic entry point. `createRetrievalKernel()` just works. */
export function createRetrievalKernel(config?: RetrievalConfig): RetrievalKernel {
  return new RetrievalKernel(resolveRetrievalConfig(config));
}
