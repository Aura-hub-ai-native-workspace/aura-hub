# @aura/knowledge-coding

The **production Coding Knowledge Engine** for AURA Hub — the first real
Knowledge Engine and the reference the others will follow. It indexes and
retrieves **actual project files** from the real filesystem.

- ✅ recursive workspace scanner (ignore rules, hidden/dep/build/cache dirs, symlink-loop safe)
- ✅ real document pipeline: language detect → safe read → metadata → chunk → store
- ✅ checksum + mtime + path + language tracking per file
- ✅ incremental indexing (added / modified / deleted, mtime+checksum diff)
- ✅ real persistent local index (`.aura-index/`, atomic writes) with BM25
- ✅ keyword search: exact · prefix · fuzzy · filename · path · language · extension · ranking
- ✅ context: matched chunks + neighbors + file/doc/project metadata + token count + source refs
- ✅ robust: large repos, very large files (capped), binary detection, invalid UTF-8, permission/IO errors, cancellation, progress
- ❌ no embeddings, no vector search, no Groq, no mock data

Node-only (real `fs`). Depends on `@aura/retrieval` for shared types + the
`ContextPackage` bridge — nothing else.

## Usage

```ts
import { CodingKnowledgeEngine } from '@aura/knowledge-coding';

const engine = new CodingKnowledgeEngine(process.cwd(), { projectName: 'my-repo' });

// Full index (first run) with progress + cancellation.
const ac = new AbortController();
const stats = await engine.index({ signal: ac.signal, onProgress: (p) => console.log(p.phase, p.processed, p.total) });
// → { files, chunks, bytes, skipped, binaries, errors, durationMs, byLanguage }

// Later runs: only touch what changed.
const delta = await engine.update();       // { added, modified, deleted, unchanged, stats }

// Search.
engine.search({ text: 'BudgetAllocator', mode: 'exact' });
engine.search({ text: 'retriev', mode: 'prefix' });
engine.search({ text: 'retreival', mode: 'fuzzy' });         // tolerates typos
engine.search({ text: 'architecture', languages: ['markdown'] });
engine.search({ text: 'provider', filename: 'engine' });

// Context (matches + surrounding neighbor chunks + metadata + token budget).
const ctx = engine.getContext({ text: 'task router' }, { neighbors: 1, maxTokens: 4000 });
// → CodingContext { entries[{ document, chunks[match|neighbor], source, tokens }], totalTokens, project }

// Bridge to the frozen retrieval layer.
const pkg = engine.toContextPackage(ctx);   // @aura/retrieval ContextPackage

// Persistence: reload a prior index instead of re-scanning.
const e2 = new CodingKnowledgeEngine(process.cwd());
if (await e2.load()) e2.search({ text: '...' });
```

## Pipeline (each component is standalone & replaceable)

```
WorkspaceScanner → readFileSafe → detectLanguage/Kind → buildDocument
   → chunkDocument → JsonKnowledgeStore(InvertedIndex + documents + chunks + manifest)
CodingSearch (BM25 + expansion + filters + boosts) → ContextBuilder → CodingContext
```

| Component | Responsibility |
| --- | --- |
| `WorkspaceScanner` | recursive traversal + ignore rules + cancellation + progress |
| `IgnoreRules` | configurable ignores (dirs, patterns, exts, size cap, hidden) |
| `readFileSafe` | size cap, binary detection, UTF-8 tolerance, typed IO errors |
| `chunkDocument` | contiguous semantic chunks with line + byte ranges + symbols |
| `InvertedIndex` | code-aware tokenization, postings, **BM25**, prefix + bounded-fuzzy |
| `JsonKnowledgeStore` | real persistent index (atomic writes) + neighbor lookup |
| `CodingIndexer` | full + **incremental** (manifest diff: added/modified/deleted) |
| `CodingSearch` | exact/prefix/fuzzy + language/ext/kind/path/filename + ranking |
| `ContextBuilder` | matches + neighbors + metadata + token budget → `CodingContext` |

## The vector-index seam

The keyword index lives behind the `KnowledgeStore` interface (and its
`InvertedIndex`). A future vector index is an **additional** store/backend
the engine composes — it does not replace `JsonKnowledgeStore` or any calling
code. Search can then blend BM25 + vector scores with no change to the scanner,
chunker, indexer, or context builder.

## Verification (reproducible, real files)

Indexing this very repository (`/home/Groot/aura-hub`):

```
files indexed : 153        chunks created: 451        errors: 0
duration      : ~340 ms    (~450 files/s)             heapUsed ~17 MB
by language   : typescript:72  tsx:49  json:17  markdown:5  rust:3 …
exact  "BudgetAllocator"   → tokenBudget.ts:77-112  (bm25,exact,filename,path)
prefix "retriev"           → retrievalEngine.ts
fuzzy  "retreival" (typo)  → retrieval sources
context "intent classifier pipeline" → 3 entries, matches+neighbors, 2228 tokens

incremental   : added=1 modified=1 deleted=1 unchanged=4  ✅
deleted gone  : exact "beta" → 0 hits ✅   modified seen: "A2" → 1 hit ✅
binary/bad-utf8 → detected, no content chunks, no crash
missing file  → typed ENOENT (never throws)   aborted signal → AbortError ✅
```
