# Phase 4 — Context, retrieval, RAG and intelligence

**Status: PARTIAL — the retrieval engine is COMPLETE; the rest of Phase 4
is named and outstanding.**

Phase 4's full surface is roughly **10,200 lines**: `context/` (1,144),
`knowledge-coding` (1,613), `knowledge-fullstack` (1,766) and
`intelligence/` (5,668). That is not one honestly-verified pass, and
claiming it as one would be the kind of "BUILT ≠ VERIFIED" blur this
migration exists to avoid.

This pass takes the **retrieval engine** — `knowledge-coding` — because
it is the actual RAG, it is fully self-contained (zero dependencies on
`intelligence/`), and it is deterministic enough to be verified
exhaustively rather than argued about.

---

## 1. What is NOT in this pass, and why

| Remaining | Size | Blocked on |
| --- | --- | --- |
| `context/` — the Context Fabric | 1,144 | `compose.ts` reads identity, summaries, health, change intelligence and versioning — all from `intelligence/`. It cannot be ported before them. |
| `intelligence/` — 21 modules | 5,668 | Nothing; it is simply large. Identity alone is a 561-line bounded filesystem scan. |
| `knowledge-fullstack` — entity/relation graph | 1,766 | Nothing; large, and the structural half of retrieval rather than the lexical half. |
| `diagnosis/` — 20 files | — | **A real blocker.** Five modules depend on the TypeScript compiler API. Needs a Node sidecar, tree-sitter, or an accepted fidelity loss. |

---

## 2. What was migrated

| TypeScript | Python |
| --- | --- |
| `store/invertedIndex.ts` | `retrieval/inverted_index.py` — BM25, tokenization, expansion |
| `search.ts` | `retrieval/search.py` — filters and boosts |
| `chunker.ts` | `retrieval/chunker.py` |
| `languages.ts` | `retrieval/languages.py` |
| `ignore.ts` | `retrieval/ignore.py` |
| `scanner.ts` | `retrieval/scanner.py` |
| `reader.ts` | `retrieval/reader.py` |
| `store/indexStore.ts` | `retrieval/store.py` |
| `indexer.ts` | `retrieval/indexer.py` |
| `context.ts` | `retrieval/context.py` |
| `engine.ts` | `retrieval/engine.py` |

### It is lexical, and it stays lexical

The brief is explicit: *"Do NOT replace existing behavior with vector
RAG."* So the constants were **copied, not chosen** — K1 = 1.5, B = 0.75,
idf = `ln(1 + (N − df + 0.5)/(df + 0.5))`; expansion weights 1.0 exact,
0.5 prefix, `0.35 × (1 − d/(max+1))` fuzzy; boosts ×1.6 filename, ×1.2
path, ×1.3 symbol, ×1.3 filename-filter, and a recency bonus of
`1 + 0.15 × 0.5^(ageDays/60)`.

A negative control makes this structural rather than a matter of intent:
it greps the package's own source for `numpy`, `sentence_transformers`,
`faiss` and for any exported name containing `embed`, `vector` or
`cosine`. If an embedding store is ever swapped in, that test fails
first.

Two more assert the behavioural consequence: a query with no lexical
overlap returns **nothing** — where a vector store would always return
its nearest neighbour — and an empty query returns nothing rather than
everything.

---

## 3. Verification

### 3.1 Differential — everything compared, zero differences

`backend/parity/retrieval_parity.py` builds a real corpus (nested source,
docs, a manifest, unicode, a **binary blob**, and a file inside
`node_modules` that must never appear), indexes it with **both**
implementations, and diffs everything observable:

| Compared | Count |
| --- | --- |
| tokenization cases | 22 |
| language/kind detections | 22 |
| chunked documents / chunks | 7 / 13 |
| indexed documents (metadata + checksums) | 9 |
| queries / ranked hits | 15 / 33 |
| assembled contexts | 4 |
| index statistics, incremental delta | ✓ |

Every one matches. Hits are compared on `relPath`, `chunkId`, **score**,
`matchedTerms` and `reasons` — so a ranking change, a lost boost, or a
different explanation for why something matched would all be caught.

`now` is injected on both sides, because the recency boost reads the
clock and an un-pinned comparison would be measuring the passage of time.

**The document list is compared UNSORTED**, on purpose. The engine's order
comes from the filesystem walk, so comparing it unsorted tests traversal
order too. The first run diverged only there — and that was my harness's
fault, sorting Python code-point against TypeScript `localeCompare`.
Comparing the engine's own order is the stronger test, so the sort was
removed rather than aligned.

### 3.2 Two Python-versus-JavaScript traps caught

**Negative index wraparound.** `neighborChunks` does `ids[pos - d]`. In
JavaScript that is `undefined` for a negative index; in Python it **wraps
to the end of the list**, which would have reported the last chunk of a
file as a neighbour of the first — a plausible-looking citation pointing
at the wrong code. Guarded, and covered by
`test_a_neighbour_lookup_never_wraps_around_the_file`.

**Modification-time precision.** Node's `mtimeMs` is derived from
nanoseconds (`tv_sec × 1000 + tv_nsec / 1e6`). Python's `st_mtime` is
already a lossy float in seconds, so `st_mtime * 1000` gives different low
bits — and that value feeds *both* the recency score and the incremental
fast-path equality check, where a mismatch means re-indexing every file on
every update. Now derived from `st_mtime_ns`, matching Node's formula
rather than approximating it.

### 3.3 Negative controls — 45/45

Beyond the no-vector-RAG guards: dependency directories are never walked
and their contents are unsearchable; binary content is detected and never
indexed as text; an oversized file is truncated **and flagged**; an
unreadable file is an error result, never an exception; hidden files are
skipped unless explicitly meaningful (`.gitignore`, `.env.example`);
chunks never overlap and their ordinals are contiguous; **byte offsets are
exact for multi-byte text**, because a chunk's byte range is a citation;
symbols are bounded at 12; a corrupt or future-schema index refuses to
load rather than half-loading; an unchanged tree re-indexes nothing; a
changed file, a new file and a deleted file are each handled; and a
context that cannot fit its first whole entry returns **empty and
flagged** rather than a partial file that reads like a complete match.

Three of these initially failed, and the engine was right each time: sub-token
indexing means searching `subtractNumbers` legitimately also matches a
README that says "numbers". The tests now assert that behaviour explicitly
(`test_a_compound_identifier_also_matches_on_its_parts`) instead of
asserting my assumption about it.

### 3.4 Runtime — 21/21 against a real repository

`backend/verify/retrieval_runtime.py` copies `packages/capability-fabric`
to a temporary tree and works on real files: indexes 9 files into 77
chunks in 0.13 s with no errors; finds `evaluatePolicy` with `policy.ts`
ranked first and the reasons that got it there; returns **nothing** for
"photosynthesis chlorophyll mitochondria"; assembles context that cites
`src/fabric.ts:1-852`; persists five files and reloads them with
**identical ids and scores**; re-indexes an unchanged tree as zero work;
then makes a real edit, adds a file and deletes one, and confirms all
three land. A final check asserts the reference tree was never written to.

---

## 4. Behavioural differences

None. Every difference found during this pass was a Python porting error,
and each was fixed to match rather than documented as a divergence.

---

## 5. Known limitations

- **Not wired to HTTP.** The routes that expose retrieval (`GET /index`,
  `POST /reindex`, `POST /retrieve`) belong to `pipeline.ts`, which is
  Phase 5. The engine is a library here, and runtime verification says so
  rather than inventing a contract.
- **`@aura/retrieval` was not ported**, as the Phase 0 audit recommended:
  it is a declared dependency with zero imports from the service. Only
  `estimateTokens` was carried across, into `retrieval/types.py`.
- **Scanning is synchronous.** The reference is async but bounded by the
  same single traversal; nothing concurrent was introduced.
- **`toContextPackage` was not ported** — it bridges into the dormant
  `@aura/retrieval` shapes and has no consumer.

---

## 6. Files created

```
backend/src/aura_backend/retrieval/{__init__,types,inverted_index,languages,
    ignore,reader,chunker,scanner,store,indexer,search,context,engine}.py
backend/parity/{retrieval_oracle.ts,retrieval_parity.py}
backend/verify/retrieval_runtime.py
backend/tests/{test_retrieval_negative_controls,test_retrieval_parity}.py
docs/PHASE_04_RETRIEVAL.md
```
