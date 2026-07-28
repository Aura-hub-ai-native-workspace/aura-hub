# @aura/retrieval

The **retrieval & memory foundation** for AURA Hub. Architecture only:

- ❌ no embeddings, no indexing, no vector search (yet)
- ❌ no vector DB (Chroma / LanceDB / FAISS / …), no SQLite
- ❌ no coupling to Groq, any AI provider, UI, React, or Electron/Tauri
- ✅ provider-independent interfaces for every responsibility
- ✅ four **independent** retrieval engines (not one giant RAG)
- ✅ a five-layer memory hierarchy
- ✅ a token-budget system + a context assembler → one `ContextPackage`
- ✅ working in-memory dummies so it all runs today, offline

It compiles **standalone** (zero runtime deps, every import relative).

## Architecture

```
                    ┌──────── four independent engines ────────┐
   RetrievalQuery → │ Coding  Chat  Research  FullStack         │
                    │   each: IndexProvider · RetrievalProvider │
                    │         RankingProvider · budget config   │
                    └───────────────┬──────────────────────────┘
                                    │  SearchResult[]
   MemoryHierarchy ─── recall ──────┤  (session→project→workspace
   (5 layers)                       │   →knowledge→persistent)
                                    ▼
                        ContextAssembler
              (collect · dedupe · rank · budget · recency/project priority)
                                    ▼
                            ContextPackage   ← the one artifact
```

## Interfaces (each explains its responsibility)

| Interface | Responsibility | Default dummy |
| --- | --- | --- |
| `DocumentStore` | persist/query source documents | `InMemoryDocumentStore` |
| `ChunkProvider` | split a document into chunks | `NaiveChunkProvider` |
| `EmbeddingProvider` | text → vector (seam only) | `NullEmbeddingProvider` |
| `IndexProvider` | hold chunks, return candidates (**vector-DB seam**) | `InMemoryIndexProvider` (lexical) |
| `RetrievalProvider` | query strategy → `SearchResult[]` | `KeywordRetrievalProvider` |
| `RankingProvider` | re-rank by relevance/recency/project | `HeuristicRankingProvider` |
| `RetrievalEngine` | one domain's retriever + budget config | Coding / Chat / Research / FullStack |
| `MemoryProvider` | read/write one memory layer | `InMemory*Memory` |
| `MemoryHierarchy` | compose the five layers | — |
| `ContextAssembler` | produce the one `ContextPackage` | `DefaultContextAssembler` |
| `Compressor` | fit text to a token budget | Noop / Truncate / Summarize (placeholder) |

## The four engines

Each **declares exactly what it indexes** (in the type system) and its
**budget config** (`maxContext`, `priority`, `compression`, `ranking`):

| Engine | Indexes | maxContext · priority · compression · ranking |
| --- | --- | --- |
| **Coding** | source-code, apis, documentation, git-history, errors, architecture, dependencies | 3000 · 0.9 · truncate · hybrid |
| **Chat** | conversations, preferences, notes, tasks, workspace-memory | 1500 · 0.7 · truncate · recency-weighted |
| **Research** | pdfs, books, websites, papers, documentation, local-knowledge | 2500 · 0.6 · summarize · relevance |
| **FullStack** | frontend, backend, database, api-contracts, deployment, architecture, project-structure | 3000 · 0.8 · truncate · project-weighted |

Engines are independent (own index each) and registered by id — add or
replace one without touching the others.

## Memory hierarchy

```
Session → Project → Workspace → Knowledge → Persistent
```

Each layer is its own `MemoryProvider` (replaceable independently).
`MemoryHierarchy.recall()` merges all layers, weighting by **layer
proximity × importance × recency**; `remember()` routes writes by kind;
`promote()` moves records between layers.

## Token budget system

- **Per engine:** `EngineBudgetConfig { maxContext, priority, compression, ranking }`.
- **Global:** `BudgetAllocator` splits a `GlobalBudget` across engines by
  priority, capped per engine, with one redistribution pass.
- **Compression:** `Compressor` strategies (`none` / `truncate` /
  `summarize`-placeholder) fit snippets to their allotment.

## Quick start

```ts
import { createRetrievalKernel } from '@aura/retrieval';

const kernel = createRetrievalKernel();          // 4 engines + 5-layer memory
await kernel.ingest(docs);                        // chunk + index (dev helper)
const pkg = await kernel.retrieve({ text: 'how does the router deploy?', projectId: 'aurora' });

pkg.items;        // ranked, de-duped, budget-fitted ContextItem[]
pkg.byEngine;     // contribution per engine
pkg.totalTokens;  // ≤ budget
```

## Replacing anything

```ts
createRetrievalKernel({
  makeIndex: () => new MyVectorIndex(),   // ← real vector DB, one line
  retrieval: new MyDenseRetriever(),
  ranking:   new MyCrossEncoderRanker(),
  assembler: new MyAssembler(),
  memory:    myHierarchy,                 // or `false` to disable
  globalBudget: { maxTokens: 8000, reserveTokens: 1000 },
});
```

The `IndexProvider` seam is where a real vector database attaches. Nothing
above it changes — engines, assembler, kernel, and the intelligence layer
that will consume `ContextPackage` all stay untouched.

## Verification (reproducible)

```
npx tsc -p packages/retrieval/tsconfig.json      # compiles standalone → exit 0
# bundle src/demo.ts with esbuild and run on node → "RETRIEVAL DEMO OK"
```

`runDemo()` exercises: domain-isolated ingest, cross-domain assembly with
ranking + budgeting, domain-restricted retrieval, the five-layer memory
(write / weighted recall / promote), memory folded into retrieval, budget
**truncation** under a tiny budget, a **swapped ranking provider**, and
memory **disabled** — all offline, no provider.

## Integration

`ContextPackage` is the hand-off point. A thin adapter will later map its
`ContextItem[]` onto `@aura/intelligence`'s `ContextProvider` seam — but
this package depends on nothing, so it stays independently testable and
replaceable.
