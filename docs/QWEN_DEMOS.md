# Qwen Demo Scripts

Five short, runnable demos showing Qwen powering real AURA Hub surfaces —
not slides, not mockups. Each one uses a real, already-shipped feature
with Qwen connected and active as the AI provider (**AI Settings →
Providers → Qwen → Connect**, then select it as active). No fabricated
UI, no hypothetical output — every step below exercises code that exists
in this repository today.

Suggested demo project: `aura-hub` itself (the same recommendation as
[`docs/assets/screenshots/SCREENSHOT_GUIDE.md`](assets/screenshots/SCREENSHOT_GUIDE.md))
— a real, substantial TypeScript monorepo gives every demo genuine,
defensible output instead of a toy fixture.

---

## 1. AI Chat — grounded conversation

**Surface:** AI Workspace / Ask AURA (`server.ts` `/ask` and `/stream` →
`pipeline.ask`/`streamEvents`).

**Script:**
1. Open the AI Chat panel with Qwen active.
2. Ask something that requires real project grounding, not general
   knowledge — e.g. *"Explain the provider validation architecture in
   this codebase."*
3. Point out the response's context strip: which knowledge engines were
   consulted (Coding/FullStack), the active provider (Qwen) and model,
   and latency — this is the same footer every provider produces, so the
   answer is demonstrably grounded in the real repo, not a canned reply.

**What it proves:** Qwen answering with the exact same retrieval-grounded
pipeline (Coding Engine + FullStack Engine + Memory) every other provider
uses — no special-casing, no degraded experience.

## 2. Code Generation — Ctrl+I inline action

**Surface:** Ctrl+I code action (`codeAction.ts` → `pipeline.generate`).

**Script:**
1. Open a real source file in the editor (e.g. a provider adapter under
   `packages/ai-service/src/provider/adapters/`).
2. Select a function, press Ctrl+I, and ask for something concrete — e.g.
   *"Add a doc comment explaining what this function does and why."*
3. Show the inline diff Qwen proposes, then accept it.

**Follow-up (workflow form of the same capability):** instantiate the
`generate-unit-tests` template from the Workflow Library
(`examples/workflows/generate-unit-tests.json`) against a real module —
Qwen generates real unit tests from real source code, no stub output.

**What it proves:** Code generation isn't a chat-only feature — it's wired
into the editor's inline action surface and the workflow engine
identically for Qwen.

## 3. Workflow Automation — AI Workflow Builder

**Surface:** AI Builder panel (`screens/workflows/AiBuilderPanel.tsx` →
`workflow/generate.ts`).

**Script:**
1. Open **Automation Studio → Workflow Builder**, open the AI Builder
   panel, with Qwen active.
2. Describe an automation in plain language — e.g. *"Pull the current
   project's dependency manifest, analyze risk, and save critical
   findings to memory."* (This mirrors the real `dependency-analysis`
   template — a good target because the result is guaranteed to be a
   valid, well-formed graph.)
3. Watch Qwen generate a real node graph on the canvas — source node →
   intelligence/generate nodes → action node — with the builder's "Built
   X — N nodes, N connections" confirmation.
4. Run the generated workflow live and show real output.

**What it proves:** Natural-language-to-automation, a flagship AURA
differentiator, works end-to-end through Qwen with zero adapter-specific
code in `workflow/generate.ts`.

## 4. Engineering Analysis — diagnosis / governance

**Surface:** Engineering Intelligence (`diagnosis/*.ts` — root cause,
patch generation, review — and/or Engineering Governance).

**Script:**
1. Introduce (or pick a real, existing) issue in the sample project —
   a failing test, a lint violation, or a genuine architectural smell.
2. Run a bug investigation: instantiate the `bug-investigation` template
   (`examples/workflows/bug-investigation.json`), describe the symptom,
   and let Qwen propose ranked root causes grounded in real suspect code
   gathered by the Coding/FullStack engines.
3. Optionally follow with the `security-audit` or `architecture-review`
   template for a broader structural read.

**What it proves:** Qwen participating in AURA's deterministic-plus-model
engineering intelligence loop — the model explains and proposes, the
platform's real static analysis supplies the facts it reasons over.

## 5. Knowledge Graph — structural understanding

**Surface:** Knowledge Workspace (graph view) + the `explain-project`
template, which explicitly chains Project → Memory → Coding Engine →
FullStack Engine → AI → saved answer.

**Script:**
1. Open the Knowledge Workspace's graph view against the sample project
   — show the real AST-derived knowledge graph (god nodes, community
   clusters, cross-file edges — this repository's own
   `graphify-out/graph.json` is real output, not staged).
2. Instantiate `explain-project` (`examples/workflows/explain-project.json`)
   with Qwen active and run it — the workflow pulls real graph-derived
   context and Qwen produces a grounded onboarding-style explanation of
   the codebase, which gets saved to Engineering Memory.
3. Open Engineering Memory and show the saved explanation persisting
   across sessions.

**What it proves:** Qwen isn't just generating text — it's reasoning over
AURA's structural understanding of code (the knowledge graph) and
contributing to the platform's persistent engineering memory, the same
compounding-knowledge story the whole product is built around.

---

## Notes for whoever runs these live

- Every demo above reuses a **real, already-shipped template or panel** —
  nothing here required new product code beyond the Qwen adapter itself
  (see [`docs/QWEN_GUIDE.md`](QWEN_GUIDE.md) and
  [`docs/architecture/PROVIDER_INTEGRATION.md`](architecture/PROVIDER_INTEGRATION.md)).
- If you want to show provider-agnosticism explicitly, run the same
  `explain-project` workflow twice — once on Qwen, once on another
  connected provider — and diff the outputs. Same graph, same pipeline,
  different model.
- Have a Qwen API key connected *before* the demo starts (see
  [`docs/QWEN_GUIDE.md` §2](QWEN_GUIDE.md#2-api-key-guide)) — connecting
  live adds real time without adding anything to the story.
