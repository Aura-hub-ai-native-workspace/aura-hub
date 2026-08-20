# Phase 4 — Reach

*Improve what it knows, and widen what it can touch.*

Branch `phase4/reach`, based on `origin/main` @ `1212724`.
`npm run typecheck` passes at every commit on this branch.

---

## ⚠ Read first — files another phase owns

| File | Owner | What Phase 4 did | Merge |
|---|---|---|---|
| `packages/ai-service/src/context/redact.ts` | **Phase 1** | **Created**, with the seven regexes and `redact()` extracted verbatim from the private copy in `promptContract.ts`. Phase 4's one-composer work needs it to exist. | **Trivial — it merges to itself.** If Phase 1's copy differs, keep Phase 1's. |
| `packages/ai-service/src/context/promptContract.ts` | shared | Removed the private `SECRET_PATTERNS`/`redact` and imports them from `redact.ts` — the change Phase 1 was going to make. Then appended `renderContextItems()` **below** the existing renderer; nothing above it moved. | Take both. The import swap is the same edit twice. |
| `packages/ai-service/src/intelligence/contextAssembler.ts` | shared | Phase 1 was to apply `redact()` at the `fullContext` choke point. That line is present (`const fullContext = redact(composed.text)`). The rest of the file below the fact builders was rewritten — the nine `assemble*` functions and the intent switch are gone. | Keep Phase 4's body; the redaction line satisfies Phase 1's requirement. |
| `packages/ai-service/src/fabric/executors.ts` | **Phase 1** (`mission.create`, `governance.audit`, git-wrapper consolidation) | Touched **only** `httpRequest`: it calls `guardedFetch` instead of `fetch`, and returns a `BlockedAddressError` as a refusal rather than a transient error. `mission.create`, `governance.audit` and the git wrappers are untouched. | Disjoint hunks. |
| `packages/ai-service/src/exec/process.ts` | **Phase 1** | **Not touched.** The long-lived process primitive is a *new sibling*, `exec/session.ts` — see the invariant note below. | No conflict. |
| `packages/capability-fabric/src/auditStore.ts` | **Phase 1** | **Not touched / not created.** Phase 4 reads the journal through `fabric.audit()`, which is the existing in-memory accessor. When Phase 1 makes it durable, the procedural memory tier gets a longer history for free and needs no change. | No conflict. |
| `apps/desktop/src/ops/memoryStore.ts` | **Phase 2** may delete | **Not touched.** See `QUESTIONS.md` §1 — deleting it is a seven-surface UI port plus a user-data decision. | No conflict. |
| tokenizer / router | **Phase 2** | Not built. `context/item.ts` names the exact interface it needs — `countTokens(text, model?)` — and labels the interim `length / 4` estimate as an estimate at its definition. | See "What Phase 2 needs to do" below. |
| tool calling / agent loop | **Phase 3** | Not built. | — |

---

## Per-deliverable status

### 1. One composer, context items carrying provenance, sensitivity and trust

**BUILT · RUNTIME VERIFIED** — `scripts/context-budget-verify.mjs`, 44/44.

There were two prompt builders. Path A (chat) selected context with a
`switch` on an intent label, redacted nothing and had no budget. Path B
(agent) had the redaction choke point, real provenance and derived
constraints, but six fixed blocks and no way for a caller to contribute.

Path B's contract renderer survived. **Path A is now a caller.**

- `context/item.ts` — `ContextItem`, answering all seven questions.
  `sensitivity` and `trust` did not exist anywhere in AURA before. They
  are assigned **once, at the boundary**, by the `from*()` constructors,
  which are deliberately not parameterised on trust: a caller that could
  choose its own trust level is a caller that can get it wrong.
- `context/composer.ts` — CANDIDATES → SCORE → BUDGET → COMPRESS →
  ASSEMBLE. `systemPrompt.ts:buildAgentPrompt` and
  `intelligence/contextAssembler.ts:assembleContext` are both thin
  callers of it.
- `promptContract.ts:renderContextItems` renders items through the same
  `block()` that applies `redact()`, so **every item is redacted exactly
  once by construction** — not by convention.

Verified: an AWS key and a GitHub token placed in a source file reach
neither the chat payload nor the agent prompt (3a–3g), with a negative
control proving the fixtures are genuinely redactable shapes and another
proving an unredacted assembly is caught by the same detector.

**Trust assignments, for review:**

| Source | trust | why |
|---|---|---|
| repository file / chunk | untrusted | a repo can contain a file that says "ignore your instructions" |
| web page, DOM node, page title | untrusted | the most adversarial source AURA has |
| MCP / tool result | untrusted | somebody else's output, over a protocol, from a server AURA did not write |
| recalled memory (episodic, semantic) | untrusted | AURA stored it; what it stored is quoted from things it did not author |
| **user turn** | **trusted** | the user is the principal |
| assistant turn | untrusted | a model that can instruct its own next turn can be talked into instructing itself |
| AURA-derived facts (env, git, mission, procedural) | trusted | arithmetic over AURA's own registries; no attacker-controlled string |

### 2. Score → budget → compress, with enforcement

**BUILT · RUNTIME VERIFIED** — `scripts/context-budget-verify.mjs`.

- `context/score.ts` — four independent signals, each contributing a
  clause to a non-null `relevance.reason`: BM25 (same Okapi constants as
  `knowledge-coding/store/invertedIndex.ts`), graph distance with a
  directory-proximity fallback, the existing `1 + 0.15·0.5^(age/60)`
  recency curve, and kind-fit. Intent did not disappear — it survives as
  the fourth signal, influencing ranking instead of dictating inclusion.
- `context/budget.ts` — harvests `BudgetAllocator.allocate()` from
  `retrieval/src/budget/tokenBudget.ts` (arithmetic preserved exactly),
  the `Compressor` interface and `TruncateCompressor`. It does **not**
  keep `PlaceholderSummarizeCompressor`, which claimed the `summarize`
  id while silently truncating; a real extractive summariser replaces
  it, and every line it emits was in the source (verified, 1l).
- **Enforcement, which did not exist at all.** Over budget → compress;
  still over → `ContextBudgetExceededError` naming what was dropped and
  the numbers. Never a silent truncation.

Verified across windows from 2k to 1M (1e), including that a 1M window
does **not** inflate a small context (1f) — a ceiling, not a target.

**A real bug the suite found and this branch fixed:** the budgeter
allocated against item text only, so per-item rendering overhead
(provenance line, reason line, fences) pushed the assembly over and the
composer then *dropped* the item rather than compressing it. The composer
now measures the overhead and feeds it back as an addition to the
incompressible floor, converging in at most three rounds.

### 3. Memory unified behind one API, conversation compaction

**BUILT · RUNTIME VERIFIED for the wiring** (the service boots, indexes
and serves with `UnifiedMemory` in the chat path; `context-view-verify`
33/33 and `context-isolation-verify` 17/17 pass against the running
service). **NOT VERIFIED as a dedicated suite** — there is no
`memory-verify.mjs`; the phase brief specified three suites and those are
the three that were built.

| Store | Verdict | What happened |
|---|---|---|
| `ProjectMemory` | KEEP as **episodic** | unchanged, now tier 2 of the unified API |
| `ProjectConversations` | EXTEND | compaction added; see below |
| `@aura/engineering-memory` | **PROMOTE to semantic** | **done** — it was write-only since it was built; it now reaches every prompt, ranked by its own `importance` and `confidence` fields |
| desktop `ops/memoryStore.ts` | DELETE | **not done** — `QUESTIONS.md` §1 |
| `retrieval` `MemoryHierarchy` | HARVEST | design harvested into the four tiers, files deleted |

**Procedural memory** is derived from the Fabric's audit journal, never
authored: `deriveProcedural()` folds records into per-capability facts
(succeeded/attempted, which node, whether policy always needs a human,
the usual rule, median duration) and refuses to report anything with
fewer than three observations, because a single success is an anecdote
and presenting it as "how things are done here" teaches a superstition.
There is deliberately no `remember('procedural', …)`.

**Conversation compaction.** Turn 9 used to remove turn 1 from the
model's world with nothing recording that it had. Now everything older
than the verbatim tail folds into a rolling digest, written back as an
episodic memory item so it reaches a prompt. The digest carries the
**producer that wrote it** — `'model'` when an abstractive summariser is
injected, `'system'` for the deterministic extractive fallback where
every emitted line appeared in the transcript. A paraphrase is never
allowed to read as a quotation.

> ⚠ **`~/.aura` is JSON-file-per-record with a whole-file rewrite on
> append** (`conversations.ts` `save()`, called from `append()`), so
> appending a message is O(n) in the conversation's size, and compaction
> adds one more whole-file write per compaction. **This is not fixed.**
> It is bounded in practice — the digest keeps the file from growing
> without limit — but a conversation with thousands of turns will feel
> it. The fix is an append-only log per conversation with periodic
> compaction of the file itself, which is a storage change, not a
> context change, and did not belong in this phase.

### 4. MCP as a driver class, actuation tiers, driver registry

**BUILT · RUNTIME VERIFIED** — `scripts/mcp-driver-verify.mjs`, 49/49,
against a **real MCP server** launched as a child process and spoken to
over real newline-delimited JSON-RPC 2.0.

- `capability-fabric/tier.ts` — six tiers. The tier is **recorded on
  every journal entry** (verified at runtime: `browser-tier-verify` 5n
  shows `browser.navigate:tier4 browser.read:tier4` in `fabric.audit()`)
  and **raises effective risk** by entering the existing policy engine as
  a `riskFloor` folded in with `stricterRisk` before any rule is read.
  There is still exactly one policy engine; this only corrects the risk
  it reasons about. Verified `low → medium` at tier 4, with a negative
  control proving a floor can only escalate, never relax.
- `capability-fabric/driverRegistry.ts` — `(capabilityId, nodeId) →
  driver`. **`resolve()` never returns a higher tier than asked for**
  (verified 7b), and says how to request it deliberately (7c). The node
  catalogue is untouched as the single answer to what the machine is.
- `mcp/` — real client, two transports, a connection pool. **Three
  capabilities, not thirty**: the server declares its own schemas, so
  `mcp.call_tool` validates arguments against what the server actually
  sent, at call time, before a governed invocation is spent.
- Servers come **only** from `~/.aura/mcp/servers.json`. No discovery, no
  auto-install, no default list. See `QUESTIONS.md` §2.

**Invariant note — a second file in `exec/`.** MCP stdio and CDP both
need a process that stays up and is spoken to, which `exec/process.ts`
cannot express (it spawns, waits, settles). `exec/session.ts` is that
shape, and is the *only* long-lived primitive — not one inside the MCP
client and another inside the browser driver. `settle()` remains the
single place an exit code, signal or timeout is interpreted;
`exec/process.ts` was not modified. It carries **no allow-list**: adding
a fourth general-purpose binary list would be the merge invariant 8
forbids under a new name. Instead every caller must name the *authority*
that permitted the process to exist, and that string is recorded.

### 5. Browser tier on CDP, with a profile AURA owns

**BUILT · RUNTIME VERIFIED** — `scripts/browser-tier-verify.mjs`, 66/66,
driving a **real Chromium** over the real CDP client, through a **real
`CapabilityFabric`** with policy, approval and audit in the path, against
a real HTTP server.

The five `browser.*` capabilities were prose-only extension points with
zero implementations. They are real now.

- **AURA's own profile** at `~/.aura/browser/profile`, never the user's.
  Asserted behaviourally *and* in source (1c/1d), because a future edit
  dropping `--user-data-dir` would still pass a behavioural test on a
  machine whose default profile happens to be empty.
- **Grants are per-origin, time-bounded and revocable.** An origin, not a
  domain suffix: `https://evil.example.test` is not covered by a grant
  for `https://example.test`, and neither is `http://` (2e). Over-long
  requests are clamped to 24h rather than honoured (2f). Revoked grants
  are kept in the record, not erased (2h).
- **An unavailable tier reports `not-executed` and never guesses** — no
  browser, no page open, no WebSocket in the runtime, a selector that
  matches nothing. Each says what did not happen and why, and the click
  path says explicitly that AURA *did not try a different way of reaching
  it* (5p).

**SSRF guard: BUILT · RUNTIME VERIFIED except the redirect loop.**
`net/ssrfGuard.ts` denies eleven address families across IPv4, IPv6 and
IPv4-in-IPv6, with a negative control proving it does not block the
public internet. Both outbound fetch sites use it (6f). The **manual
redirect re-check is BUILT and structurally verified but not exercised
end to end** — that needs a public redirector; see `QUESTIONS.md` §4.

The comment it replaces argued no deny list was needed because AURA is
single-user with no multi-tenant boundary. That is right about tenancy
and wrong about the threat: the attacker is the **content AURA reads**,
and one persuasive paragraph in a README is enough.

**Catalogue change.** `browser.navigate` requires the `browser-automation`
node capability, which only Playwright and Puppeteer declared — so the
whole tier would have been denied `no-provider` in production. AURA now
speaks CDP directly, so the Chromium-based entries (`chrome`, `chromium`,
`edge`) genuinely provide it and now say so. **Firefox and Brave
deliberately do not** — AURA has no verified way to drive them, and the
executors' `supportsNode` refuses Playwright and Puppeteer rather than
attempting them.

---

## Exit criterion

> *Assembled context never exceeds the chosen model's window and every
> inclusion carries a reason; injected page content cannot cause a
> capability invocation.*

**Met, and verified at runtime.**

- Window: `context-budget-verify` 1b/1c/1e across 2k–1M, measured on the
  real rendered string, not an idealised sum.
- Reasons: 2a–2e — every inclusion carries one, **and the reason reaches
  the prompt**, not just the return value. An audit trail nobody can see
  in the artefact is not an audit trail.
- Injection: `browser-tier-verify` 5m. A real Chromium loaded a real page
  whose entire content was an attempt to get `terminal.execute` invoked.
  A canary executor for that capability recorded **zero** calls, and the
  journal contains only `browser.navigate, browser.read` (5o). **The
  negative control fires the canary with a deliberate invocation** — so
  5m is not passing because the canary is inert.

---

## What Phase 2 needs to do when the tokenizer lands

One function body, in `packages/ai-service/src/context/item.ts`:

```ts
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
```

Replace it with `countTokens(text, model)`. Delete nothing else. Every
caller already treats the result as authoritative, and the budget
enforcement is correct for any monotonic counter — the interim estimate
is why `DEFAULT_CONTEXT_FRACTION` is 0.6 rather than something tighter.

The composer takes a `BudgetSpec { model, windowTokens, reserveTokens }`.
The window comes from the **provider registry**
(`ModelCapabilities.contextWindow`), read via
`provider/modelValidation.ts:modelWindow()` and
`RuntimeManager.contextBudget()`. No second table of model sizes was
introduced. When router v1 chooses a model, it should pass that model's
`BudgetSpec` down the same parameter.

---

## Test results, honestly

Run from the branch root.

| Suite | Result |
|---|---|
| `node scripts/context-budget-verify.mjs` | **44/44** |
| `node scripts/mcp-driver-verify.mjs` | **49/49** |
| `node scripts/browser-tier-verify.mjs` | **66/66** (real Chromium present) |
| `node scripts/run-ts.mjs scripts/retry-governance-verify.mjs` | **passes** |
| `node scripts/perf-redaction-verify.mjs` | **passes** |
| `node scripts/process-timeout-test.mjs` | **passes** |
| `node scripts/run-ts.mjs scripts/context-view-verify.mjs` | **33 passes** (service running) |
| `node scripts/run-ts.mjs scripts/context-isolation-verify.mjs` | **17 passes** (service running) |

**Failures that are pre-existing, each confirmed identical at the base
commit `1212724`:**

| Suite | Failure | Confirmed at base |
|---|---|---|
| `node-policy-verify` | `A2/A3/C3/J2` — *"No project directory is set for this invocation"*; needs a real coding agent (OpenCode) installed | ✅ ran the **base service** and the **base script**: byte-identical failures |
| `node-routing-verify` | same cause | ✅ same |
| `agent-context-verify` | 41 pass, 1 fail: *"6. current activity is present when there is any, absent when not — hasActivity=false block=true"* | ✅ identical failure at base |
| `hub-execution-verify` | `ERR_CONNECTION_REFUSED at http://localhost:1420/` — needs the desktop dev server | environment |

Per `CLAUDE.md`, `verify-providers` (10) and `ui-approval-test` (17) fail
for documented pre-existing reasons and were not run.

**Note on running the older suites:** several need
`node scripts/run-ts.mjs scripts/<name>.mjs`, not bare `node`. Run bare,
they die on an extensionless import inside `capability-fabric/src/index.ts`
and look like a regression. The three suites this phase ships register the
loader themselves and run with plain `node`.

**Runtime check of the whole service.** The AI service was bundled with
esbuild and started with every change in place: it booted, scanned the
environment (`24 node(s) present · 25 capabilities available`), indexed a
real project and served `/health`. A build is not a run; this was a run.

---

## Not done, and why

1. **`apps/desktop/src/ops/memoryStore.ts` is not deleted.**
   `QUESTIONS.md` §1 — seven UI importers plus an unanswerable question
   about existing user data. The reason it was marked for deletion is
   fixed independently.
2. **No dedicated memory suite.** The brief named three suites; those
   three exist and pass. Unified memory is exercised through the live
   service and the chat path, not by its own script.
3. **The redirect re-check is not runtime verified.** `QUESTIONS.md` §4.
4. **`~/.aura`'s O(n) append is not fixed.** Flagged above, as required.
5. **No tokenizer, no router, no tool calling, no agent loop, no event
   spine.** Phases 2 and 3 own those.
