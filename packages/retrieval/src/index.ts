/**
 * @aura/retrieval — the retrieval vocabulary.
 * ==================================================================
 * This package used to describe itself as "the retrieval & memory
 * foundation": four domain engines, a five-layer memory hierarchy, a
 * token-budget system and a context assembler. All of it was real,
 * careful code. None of it had a single importer outside this package.
 *
 * It was never dead code. It was UNWIRED code — designs that were
 * correct and simply never connected to anything that runs. Phase 4
 * harvested the two that mattered and then removed what remained, so
 * that the tree stops carrying a second, plausible-looking answer to
 * questions that now have a real one.
 *
 * WHERE THE HARVESTED DESIGNS WENT
 * ------------------------------------------------------------------
 *   budget/tokenBudget.ts   → `ai-service/src/context/budget.ts`
 *       `BudgetAllocator.allocate()` arithmetic preserved exactly; the
 *       unit changed from "engine" to "group", because the thing being
 *       budgeted is now a class of context item rather than a retrieval
 *       engine. The `Compressor` interface and `TruncateCompressor`
 *       came with it. `PlaceholderSummarizeCompressor` did NOT: it
 *       claimed the `summarize` id while silently truncating, and the
 *       new budgeter records which compression was applied, so a
 *       compressor that lies about what it did makes that record
 *       worthless.
 *
 *   memory/layers.ts        → `ai-service/src/unifiedMemory.ts`
 *       The layered idea survives as four tiers — working, episodic,
 *       semantic, procedural — each backed by a store that already
 *       exists on disk rather than by an in-memory default. The five
 *       in-memory layer classes are gone: they held nothing, and every
 *       tier now has a real owner.
 *
 * WHAT REMAINS, AND WHY
 * ------------------------------------------------------------------
 * `types.ts` only. `@aura/knowledge-coding` and
 * `@aura/knowledge-fullstack` import `estimateTokens`, `ContextItem`,
 * `ContextPackage` and `IndexCategory` from it, so it is a live shared
 * vocabulary rather than an unwired design.
 *
 * ⚠ NAME COLLISION, DELIBERATELY LEFT ALONE
 * `ContextItem` here is the RETRIEVAL-result shape — title, snippet,
 * score, tokens. It is not the addressable context unit introduced in
 * `ai-service/src/context/item.ts`, which carries provenance,
 * sensitivity and trust. Renaming this one would touch two knowledge
 * packages for cosmetic reasons; the two are never imported into the
 * same file, and the composer only ever sees the addressable one.
 */

export * from './types';
