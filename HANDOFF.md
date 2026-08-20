# Phase 2 — Nervous system

> *An agent that cannot interrupt the human cannot be governed by the human.*

Branch `phase2/nervous-system`, based on `origin/main` @ `1212724`.
Written against `308f5ba`. Every claim below was produced by running
something; where it was not, it says **NOT VERIFIED** and why.

**BUILT** means the code exists and typechecks. **RUNTIME VERIFIED**
means it was executed and observed. A build is not a run.

---

## Exit criterion

> A backend-raised approval reaches the UI with no polling; the agent
> survives closing the window; AURA answers with no internet and no API
> key.

| Clause | Status | Evidence |
| --- | --- | --- |
| A backend-raised approval reaches the UI with no polling | **RUNTIME VERIFIED** | `event-spine-verify` B1: the Fabric raised `approval.required`, it arrived on the stream in **23 ms**, and the subscriber made **exactly one HTTP request in its lifetime** — the stream itself |
| The agent survives closing the window | **RUNTIME VERIFIED** | `event-spine-verify` C4: seeded real diagnosis events, the agent proposed a campaign, the whole service was `SIGTERM`'d, a new process started, and the campaign was still awaiting the same human answer with its timeline intact |
| AURA answers with no internet and no API key | **RUNTIME VERIFIED** | `model-router-verify` D4: a throwaway `AURA_HOME` with no credentials, Ollama connected unprompted, `qwen2.5-coder:1.5b` answered `"ONLINE"` in **720 ms**, and the routing report attributes it to a local model |

---

## Verification suites

```
node scripts/event-spine-verify.mjs      29/29 checks passed
node scripts/model-router-verify.mjs     42/42 checks passed
```

Both were run at `308f5ba` on Linux. Every check has a negative control;
the controls are listed alongside the checks in the scripts and named
`-neg` in the output.

`event-spine-verify` **found a real defect on its first run**: the
service published two event types (`workspace.engineering-event`,
`workspace.engineering-purged`) that the renderer's client did not listen
for, so they would have been silently dropped. Check D5 exists to catch
exactly that drift, and it did.

---

## Per deliverable

### 1. Durable typed event log · one push channel · the poll retired

**BUILT · RUNTIME VERIFIED**

| Piece | Where |
| --- | --- |
| Typed topics and the `AuraEvent` record | `packages/ai-service/src/events/types.ts` |
| Segmented append-only JSONL, `fsync`'d, exact replay, bounded retention | `packages/ai-service/src/events/log.ts` |
| Publish / subscribe-by-topic / replay-from-offset | `packages/ai-service/src/events/spine.ts` |
| The Fabric's first real subscriber | `packages/ai-service/src/events/fabricBridge.ts` |
| `GET /events/{head,replay,stream}` | `packages/ai-service/src/server.ts` |
| The renderer's one `EventSource` | `apps/desktop/src/events/spineClient.ts` |
| Approvals becoming notifications | `apps/desktop/src/ops/notificationsStore.ts` |

The Fabric already emitted `FabricEvent` into an empty listener set. **No
new emitter was added** — `bridgeFabricEvent` is the consumer that
emitter was waiting for.

Verified: replay from an offset is exact across segment boundaries
(A1); the log survives a restart and continues its sequence (A2); a torn
final record is dropped without losing the rest (A3); a reader whose
offset fell off the back is **told so** rather than silently
short-changed (A4); topic filters hold (A5); `Last-Event-ID` resumes with
no gap and no duplicate (B2); index status is pushed unprompted (B3).

**The poll.** `apps/desktop/src/data/useWorkspace.ts` no longer polls as
its primary path. The 600 ms interval is retained deliberately and armed
**only while the channel is not open** (D2/D3) — deleting it would leave
no path during a reconnect. Two other pollers remain and are **out of
this phase's scope**: `ops/memoryRecorder.ts` (30 s reconcile, whose
dedupe keys make it idempotent) and `ops/useNotificationsFeed.ts`.

### 2. The agent engine moved out of the browser

**BUILT · RUNTIME VERIFIED**

Deleted: `apps/desktop/src/ops/agentEngine.ts`,
`apps/desktop/src/ops/memoryStore.ts`, and the old
`apps/desktop/src/ops/agentStore.ts`.

Added, in the service:

| Piece | Where |
| --- | --- |
| ONE engineering-event model, stored as a `BaseMemoryRecord` | `packages/ai-service/src/engineering/events.ts` |
| Dedupe, workspace scope, read cache, purge | `packages/ai-service/src/engineering/log.ts` |
| The Learning Engine, rules verbatim | `packages/ai-service/src/engineering/learning.ts` |
| Campaigns + timeline, atomic, on disk | `packages/ai-service/src/engineering/agentStore.ts` |
| The loop | `packages/ai-service/src/engineering/agent.ts` |

**On not duplicating an authority.** The browser store was a *second*
engineering-memory model. It was not replaced with a third: the richer
model won, and it is persisted through the `@aura/engineering-memory`
store that already existed, with the extra fields carried in `tags`
(which `EngineeringSearch` already indexes). One store, one directory,
one dedupe namespace. `fromRecord()` round-trips exactly and returns
`null` for records written by the mission/diagnosis engines, which are
surfaced through an explicit `derivedEvent()` projection rather than
being mangled into a shape they were never written in.

The renderer files that replace them (`ops/agentStore.ts`,
`ops/engineeringMemory.ts`, `ops/learningEngine.ts`) hold a cache fed by
the spine and **no authority**. Their exported names are unchanged, so
`AgentCenter`, `MemoryCenter`, `MemoryGraph` and `EngineeringLearning`
are untouched.

**Invariant 10 holds and is strengthened.** The renderer still cannot
execute processes, and it can no longer even schedule the agent that
asks for them. The agent's only action remains creating a real mission,
whose plan-approval and per-task-acceptance gates are intact, and whose
tasks still execute through the Capability Fabric under policy.

Verified: events record and dedupe on disk (C1, C1-neg); the agent
observes real signals and proposes, awaiting a human (C2); its state is
on disk (C3); it survives the process being killed (C4); a human
decision made after the restart is honoured (C5).

### 3. Ollama and LM Studio adapters

**BUILT · RUNTIME VERIFIED against a real Ollama.**
**LM Studio: BUILT, NOT VERIFIED against real LM Studio (see below).**

| Piece | Where |
| --- | --- |
| Loopback-only endpoint resolution, honest probe classification, Ollama's native runtime | `packages/ai-service/src/provider/adapters/local.ts` |
| Ollama | `packages/ai-service/src/provider/adapters/ollama.ts` |
| LM Studio | `packages/ai-service/src/provider/adapters/lmstudio.ts` |

The credential slot carries an **endpoint**, not a secret, so one store
and one activation path serve both kinds of provider. Boot probes
loopback and connects a local server if one answers — and never displaces
a provider the user already activated.

Ollama was verified against the real thing, running locally with
`qwen2.5-coder:1.5b` and `qwen3:4b`: connection with no API key (D1),
**real** context windows read off the server (32768 and 262144 — D2),
embedding-only models correctly refused as chat targets (D2-neg), a real
generation round trip (D4), and the model counting its own prompt tokens
(D5).

**NOT VERIFIED — LM Studio against a real LM Studio.** LM Studio is not
installed in this environment (`which lms` finds nothing) and its
installer is a multi-hundred-megabyte desktop application; `/` had 3.9 GB
free and the instructions forbid installs. The adapter *was* exercised
end-to-end against a server speaking LM Studio's exact OpenAI-compatible
protocol (`/v1/models`, `/v1/chat/completions`) in `model-router-verify`
D6, which proves the protocol path and the connect/activate path, and
does **not** prove behaviour against LM Studio's own quirks.

*To verify:* install LM Studio, load any model, start its server on the
Developer tab (default `http://127.0.0.1:1234`), then
`node scripts/model-router-verify.mjs`. D1 should list `lmstudio` among
the connected providers with the model's real `max_context_length`.

### 4. A real tokenizer

**BUILT · RUNTIME VERIFIED**

`packages/ai-service/src/tokenizer/` replaces all three copies of
`length / 4` with a ladder, and every result reports which rung produced
it:

1. **`provider`** — the provider's own counter. Anthropic
   `/v1/messages/count_tokens`, Gemini `:countTokens`, Ollama's
   `prompt_eval_count`. Exact by construction.
2. **`bpe`** — the real GPT-family algorithm over a vocabulary present on
   the machine (`<AURA_HOME>/tokenizer/<name>.tiktoken`).
3. **`estimate`** — pre-tokenized and priced per piece. Not a divisor.
4. **`chars-over-4`** — reachable only when pre-tokenization itself
   throws, and labelled `LAST RESORT: characters ÷ 4. Not a tokenizer.`

The three original sites now go through it: `intelligence/contextAssembler.ts`,
`context/systemPrompt.ts` (which now also reports `tokenMethod` and
`tokensExact`), and `packages/retrieval/src/types.ts`. Retrieval sits
*inside* the service in the dependency direction and cannot import the
tokenizer, so it exposes a seam (`setTokenCounter`) that `startService()`
fills; its standalone floor is the one clearly-labelled `charsOverFour`.

Verified: the BPE merge loop against a hand-built rank table with a known
answer (B1, B1-neg); the `.tiktoken` format parsed with malformed lines
skipped (B2); the ladder claiming `exact` only when it is (B3, B3-neg);
the estimate visibly differing from `length / 4` on TypeScript (47 vs 35)
and on CJK (28 vs 7) (B4); no naive divisor left at any of the three
sites (B6); and a **real** provider counter — `qwen2.5-coder:1.5b`
reporting 39 prompt tokens, surfaced by the ladder as `method: 'provider'`
(D5).

**A vocabulary is not shipped.** See QUESTIONS.md §1 — it is a
several-megabyte data decision, not a code one.

### 5. `contextWindow` and the cost fields, actually read

**BUILT · RUNTIME VERIFIED**

`packages/ai-service/src/provider/modelCatalog.ts` carries published
context windows and USD list prices per 1k tokens for 26 models across
OpenAI, Anthropic, Gemini, Groq and Mistral. Every entry cites the vendor
page it came from and the file is dated (`PRICES_RECORDED_AT`).

`registry.getAdapter()` decorates `discoverModels()` **once**, so all
thirteen adapters are enriched in one place rather than in twelve. An
unpriced model gets **no** cost fields — absent, never zero — and the
router ranks it last rather than treating it as free.

`contextWindow` finally has a reader: the router's context gate
(`contextGate`), against a *measured* token count.

Verified: dated snapshots resolve to their family (C1); longest-prefix
wins so `gpt-4o-mini` is not priced as `gpt-4o` (C1); an unknown model
gets no price (C2); the arithmetic (C3); local models cost zero and their
window is **not** guessed (C4); the recorded-on date is carried (C5); the
context gate refuses a 62k request on a 32k model and accepts a small one
(A4, A4-neg).

**NOT VERIFIED — the prices against live vendor pages.** See
QUESTIONS.md §2.

### 6. Provider fallback chain and routing v1

**BUILT · RUNTIME VERIFIED**

`packages/ai-service/src/provider/router.ts` is a **pure decision
function** — no I/O, no state — for the same reason `policy.ts` is one:
its decisions have to be reproducible and testable.

Gate order, and the order is the point:

1. **privacy** — `secret` never leaves the machine. First, so nothing
   downstream can trade privacy for capability, cost or availability.
2. **capability** — an explicit `toolCalling: false` disqualifies;
   unknown does not (most local models advertise nothing).
3. **context** — must fit `contextWindow`, measured.
4. **cost** — published prices, cheapest healthy first; a per-call budget
   removes what exceeds it.
5. **fallback** — preferred → sibling cloud → local → **refuse**.

Refusing is a returned outcome carrying the rule that caused it and a
next step, not an exception.

The pipeline gains an **outer** loop over the chain; `withRetry` remains
the inner same-provider loop, unchanged. Failover never reassigns the
user's active provider, never happens once a token has reached the user,
and is restricted to failures meaning *this provider cannot serve you* —
a malformed request is not quietly re-sent to a second company.

Verified: privacy gate with the control that would pass on a router which
always chose local (A1, A1-neg); refusal rather than downgrade when
`secret` has nowhere to go (A2, A2-neg); capability (A3, A3-neg); context
(A4, A4-neg); cost ordering and unpriced-ranked-last (A5, A5-neg);
budget (A6); offline (A7, A7-neg); chain shape (A8); the privacy gate on
the **real** connected set (D3); and a genuine failover — an
OpenAI-compatible endpoint that connects like a real LM Studio and then
503s every completion, with the chain falling over to Ollama, the failing
server proven to have been contacted, the active provider **not** stolen,
and the control showing a healthy provider is not failed over (D6).

---

## Coordination with Phase 1

I did not touch any file Phase 1 owns:

```
packages/ai-service/src/context/redact.ts          untouched (does not exist on this branch)
packages/ai-service/src/context/promptContract.ts  untouched
packages/ai-service/src/intelligence/contextAssembler.ts   ONE LINE — see below
packages/capability-fabric/src/auditStore.ts       untouched (does not exist on this branch)
packages/ai-service/src/exec/process.ts            untouched
packages/ai-service/src/fabric/executors.ts        untouched
```

**One surgical edit inside a Phase 1 file.**
`intelligence/contextAssembler.ts:19` was one of the three `length / 4`
sites the phase brief names explicitly, so replacing it was unavoidable.
The change is exactly two lines — a new import and the body of the
one-line `estTokens` helper. Nothing else in that file was read or
altered. If Phase 1 rewrites it, take their version and re-apply the
`countTokensSync` call.

`context/systemPrompt.ts` was also edited (the second named `/4` site).
It is not on the Phase 1 list, but it lives in the same directory, so it
is called out here.

**On the journal.** I did not build a second audit sink. The spine is a
*consumer* of the Fabric's existing event emitter, and it deliberately
carries no invocation arguments. Whether the two should share
`DurableEventLog` is QUESTIONS.md §4 — the shape is a `retention` option,
and I did not add it because it would mean editing a Phase 1 file.

---

## Regressions checked

| Suite | Result |
| --- | --- |
| `npm run typecheck` | passes (asserted before every commit) |
| `npm run build` (vite, the real renderer bundle) | passes in 1m 4s |
| `tsc -p packages/retrieval/tsconfig.json` | passes |
| `scripts/verify-providers.ts` | 10 failures — **byte-identical** to the same run at base `1212724`, compared in a scratch worktree. Pre-existing, unchanged. |
| `perf-redaction-verify`, `context-index-verify`, `process-timeout-test`, `active-project-verify`, `detail-focus-verify` | all pass |
| `retry-governance-verify`, `retry-governance-e2e` | fail with `ERR_MODULE_NOT_FOUND` — **identically at base**. A pre-existing invocation-mode problem (they need the TS loader), not a regression. |

**NOT RUN, deliberately:** `node-policy-verify`, `node-routing-verify`,
`agent-failure-recovery-test`, `hub-execution-verify`. Each hardcodes
`/home/Groot/aura-hub` — the user's live tree with uncommitted work — and
`hub-execution-verify` runs `git status` against it. Running them from
this worktree would have pointed them at the tree I was instructed never
to touch. `hub-verify` and `ui-approval-test` drive a headless browser
against `npm run dev`, which was out of reach on a disk with 3.9 GB free.

---

## What a reviewer should look at first

1. `packages/ai-service/src/events/log.ts` — retention is the load-bearing
   design decision, and `replay().truncated` is the honesty that makes it
   acceptable.
2. `packages/ai-service/src/provider/router.ts` — gate order.
3. `packages/ai-service/src/engineering/events.ts` — the mapping that
   made two memory models into one, and `fromRecord()` returning `null`
   rather than guessing.
4. `QUESTIONS.md` — four decisions that are yours.
