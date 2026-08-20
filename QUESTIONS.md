# Questions for the human — Phase 2

Four things I could not decide without you. Everything else in the phase
is complete; nothing below is a half-finished feature, and nothing was
invented to paper over a gap.

---

## 1. A BPE vocabulary is data, not code. Should AURA ship one?

**Status: shipped without one, and honest about it.**

The backend has **zero third-party runtime dependencies**, which is a
property worth keeping. `packages/ai-service/src/tokenizer/bpe.ts`
implements the real GPT-family algorithm — the pre-tokenizer regex, the
byte-level merge loop, and the exact `.tiktoken` rank format OpenAI
publishes — and it is exercised by `model-router-verify` against a
hand-built rank table with a known answer.

What it does not have is a **vocabulary**. `cl100k_base` is ~1.7 MB of
merge ranks and `o200k_base` is larger. That is not a dependency in the
`package.json` sense, but it is vendoring several megabytes of somebody
else's data into the repository, and it is a decision about repository
size, licensing and update cadence that is yours, not mine.

Today, when no vocabulary is present, the ladder falls to a **structural
estimate** (pre-tokenized, priced per piece by UTF-8 length) that is
substantially closer than `length / 4` — 47 vs 35 tokens on a line of
TypeScript, 28 vs 7 on CJK — and every result says which method produced
it, so a budget can never pass as measured when it was guessed.

The three options, as I see them:

| | Cost | Effect |
| --- | --- | --- |
| **a. Ship the ranks** | ~2-4 MB in the repo and in every build | Exact counts for every OpenAI-compatible provider, offline, no dependency |
| **b. Add `gpt-tokenizer` or `js-tiktoken`** | The first backend runtime dependency | Exact counts, smaller diff, a supply-chain surface where there was none |
| **c. Leave it (current)** | Nothing | Exact for Anthropic, Gemini and Ollama (their own counters); a labelled estimate elsewhere |

A user can already opt into (a) themselves: drop
`cl100k_base.tiktoken` or `o200k_base.tiktoken` into
`<AURA_HOME>/tokenizer/` and the BPE path activates with no code change.

**What I need from you:** a, b, or c.

---

## 2. The published prices are transcribed, and they go stale.

**Status: shipped, dated, cited — and unverified against live pages.**

`packages/ai-service/src/provider/modelCatalog.ts` carries real published
list prices and context windows for 26 models across five providers, each
entry citing the vendor page it came from, and the file carries
`PRICES_RECORDED_AT = '2026-08-20'`.

I transcribed those figures from the vendors' published pricing pages as
I know them. **I did not fetch those pages during this work** — this
environment had no outbound network — so I cannot claim they match what
the pages say today. Vendors cut prices without notice, and a stale price
makes the router's cost gate quietly wrong (it will still route to a
*working* model; it may not route to the *cheapest* one).

**What I need from you:** somebody with a browser should walk the six
cited URLs and correct any drift, then bump `PRICES_RECORDED_AT`. The
router already tolerates an absent price correctly — an unpriced model is
ranked last, never treated as free — so deleting an entry you cannot
confirm is a safe action.

The URLs, all in the file:

- https://openai.com/api/pricing/
- https://www.anthropic.com/pricing#api
- https://ai.google.dev/gemini-api/docs/pricing
- https://groq.com/pricing/
- https://mistral.ai/pricing#api-pricing

---

## 3. What should `sensitivity` default to, and who sets it?

**Status: defaulted to `internal`, and that is a product decision, not an
engineering one.**

`AiSettings.sensitivity` is the input to the router's privacy gate.
`secret` means "this may only ever run on a model on this machine, and if
there is none, the correct answer is no answer."

I defaulted it to `internal` (cloud allowed) because defaulting everyone
to `secret` would silently disable AI for every user without a local
model — a change that would look like a bug. But that is a *policy*
choice about your users, and there is a real argument for the opposite.

There is also a question I did not answer at all: **should sensitivity be
per-project rather than global?** A user with one client repository under
NDA and five personal ones has a real need the current single global
setting does not serve. `PolicyConfig` is already per-machine and
persisted; a per-project sensitivity would most naturally live beside the
project profile.

**What I need from you:**
- the default (`internal` or `secret`), and
- whether sensitivity is global (today) or per-project (not built).

---

## 4. Does the Event Spine become the substrate for Phase 1's journal?

**Status: deliberately NOT merged, and designed so it could be.**

Phase 1 is landing a durable append-only journal behind the Fabric's
existing audit API (`packages/capability-fabric/src/auditStore.ts`). This
phase landed a durable append-only event log
(`packages/ai-service/src/events/log.ts`). They look similar and they are
not the same thing:

- the **journal** persists *decisions* — what was permitted, on whose
  authority, and whether it worked. It is evidence, it must be complete,
  and losing a record is a governance failure.
- the **spine** persists *events* — that a thing happened, in order, so a
  reconnecting reader can catch up. It has bounded retention **by
  design**: old events are unlinked whole segments at a time, and a
  reader whose offset fell off the back is told so.

Retention is the whole difference. An audit journal that drops its oldest
records to stay small is not an audit journal.

I built exactly one of them and made the spine a *consumer* of the
Fabric's events rather than a second sink: `fabricBridge.ts` subscribes
to the emitter that already existed and had zero subscribers, and it
deliberately carries **no invocation arguments** — ids, capability,
outcome and decision only. The Fabric's `AuditRecord` remains the only
place a redacted argument summary lives.

If they should share a substrate, the shape is clear: `DurableEventLog`
gains a `retention: 'bounded' | 'forever'` option and the journal opens
it with `'forever'` and its own directory. I did not do this because it
would mean editing a file Phase 1 owns.

**What I need from you:** should Phase 3 unify them on
`DurableEventLog`, or should they stay separate?
