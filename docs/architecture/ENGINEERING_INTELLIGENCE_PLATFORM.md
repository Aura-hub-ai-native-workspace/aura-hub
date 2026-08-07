# AURA — Engineering Intelligence Platform

> Internal architecture reference. This document describes systems that
> **exist and run today** in this codebase. Anything not present in the
> real source is marked **Future Extension — Architecture Planned** and
> must not be treated as built. If a future engineer cannot find the file
> path referenced next to a claim in this document, the claim is wrong —
> fix the document, not your assumptions.

---

## 1. Vision

AURA is not an AI-assisted code editor. An AI IDE bolts a chat window or
an autocomplete model onto a text buffer: every question is answered
from whatever happens to be visible in the prompt window at that
instant, every suggestion is a guess grounded in nothing durable. The
model has no persistent understanding of the repository — it re-derives
context from zero on every keystroke, and there is no distinction
between "the model thinks this is true" and "this is actually true."

The Engineering Intelligence Platform inverts that relationship three
times, and all three inversions are load-bearing:

1. **Knowledge before generation.** The codebase is modeled as a
   persistent structure — a **Knowledge Fabric** — computed once,
   incrementally updated, and queried before any model call happens.
   The model is handed real, already-computed facts (entities,
   relations, exports, layers, health scores, change hotspots); it is
   never asked to reconstruct them from a raw file dump.

2. **Deterministic judgment before probabilistic judgment.** Every
   question with one correct, checkable answer — *is this actually
   dead code, did this patch remove a public export, is this access
   actually unguarded* — is answered by real parsing and arithmetic,
   never by asking a language model to decide. The model's role is
   deliberately narrowed to the two things only a language model can
   do: explain a cause in prose, and draft a plausible patch. Every
   other judgment in this platform is code.

3. **Nothing is autonomous.** The platform can analyze, diagnose, plan,
   and propose without limit — but no subsystem ever mutates the real
   filesystem without an explicit human click. Planning and proposing
   are unbounded; acting is always gated.

This is why the platform is organized around **four subsystems that
share one source of truth** — the Knowledge Fabric, AI Code
Intelligence, the Engineering Diagnosis Engine, and Mission Control —
rather than four separate AI features that each re-derive their own
understanding of the code. An AI IDE's chat window and its
autocomplete typically don't even agree with each other about what a
symbol is; in this platform they cannot disagree, because there is
only one place that computes it.

---

## 2. High-Level Architecture

```
User
  ↓
Knowledge Fabric            (Coding Engine + FullStack Engine — already indexed, already loaded)
  ↓
AI Context                  (client-resolved for Code Intelligence; server-composed Stage 1 for
                              Diagnosis / Mission Control — same graph, different consumers)
  ↓
  ├── AI Code Intelligence   (single-shot: explain / refactor / diff / new-file / findings)
  ├── Diagnosis Engine       (classify → root cause → patch → limit → simulate → confidence → review → evolve)
  └── Mission Planner        (signals → goal graph → per-task proposal)
  ↓
Diff Engine                 (spliceSelection / splicePatch — one line-range-replace primitive,
                              reimplemented consistently on both client and server)
  ↓
Approval Engine             (Accept / Reject — always an explicit, separately-rendered human action)
  ↓
Execution                   (the ONLY point any of these subsystems writes to the real filesystem)
  ↓
Reindex                     (fire-and-forget — the Knowledge Fabric picks up the new file content)
  ↓
Memory                      (write-only recall log today — see §11 for what this is NOT yet)
```

**Every stage explained:**

- **Knowledge Fabric** — computed once per project, persisted, incrementally updated. Nothing downstream is allowed to re-derive what this layer already knows.
- **AI Context** — the same graph, resolved differently depending on the caller: the Code Workspace client already holds the graph in memory (zero extra fetches); the Diagnosis Engine and Mission Control gather their own Stage-1 context server-side because they need real filesystem access (git, exports, test-file existence) the client-side graph doesn't carry.
- **The three AI-facing subsystems** are not three implementations of "call an LLM." Each is a distinct pipeline with a distinct contract (single-shot diff, 10-stage diagnosis, human-gated multi-step plan) — but all three are consumers of the same Knowledge Fabric and the same JSON-mode call convention (`jsonMode.ts`).
- **Diff Engine** — every proposal in this platform, regardless of which subsystem produced it, is expressed the same way: a range of lines to replace and the replacement text. One splice primitive, not one per feature.
- **Approval Engine** — never implicit, never inferred from "the user didn't object." Always a rendered button click.
- **Execution** — the write. Everywhere in this codebase, this is a single, small, named function (`saveFile`, `acceptDiagnosis`, `acceptMissionTask`) — never inline in a generation path.
- **Reindex** — a real, asynchronous refresh of the Coding/FullStack indexes so the next Knowledge Fabric query reflects the new file.
- **Memory** — today, a flat, per-project recall log that is *written to* by these subsystems and *read from* at the start of a new diagnosis/mission, but does not yet *change* any subsystem's behavior. See §11 — this is explicitly not a learning loop yet.

---

## 3. Knowledge Fabric

**Why it exists:** every other subsystem in this platform needs to ask
"what does this codebase actually look like" without re-scanning the
filesystem, and needs the answer to be the *same* answer no matter who
asks. The Knowledge Fabric is that single computation.

It is two independent engines, not one:

### 3.1 Coding Knowledge Engine (`packages/knowledge-coding`)

File-level. Walks the real filesystem (`IgnoreRules` — skips
`node_modules`/`.git`/build output/binary assets), producing a
`CodeDocument` + chunk index per file (`JsonKnowledgeStore`, one JSON
index on disk per project under `~/.aura/index/<projectId>/coding`).

- **Search is keyword search** — exact / prefix / fuzzy matching with
  filters (`CodingSearch`) — **not** vector embeddings, **not**
  semantic similarity. This is a deliberate, real architectural fact:
  retrieval here is exact and explainable, not a black-box nearest
  neighbor.
- `getContext()` assembles matches plus neighboring chunks into a
  token-budgeted `CodingContext`; `toContextPackage()` bridges that
  into the frozen `@aura/retrieval` `ContextPackage` shape shared
  across the platform's conversational answering path.
- `index()` (full) / `update()` (incremental — added/modified/deleted
  only) are the only two ways this engine's state changes.

### 3.2 FullStack Knowledge Engine (`packages/knowledge-fullstack`)

System-level, not file-level. This is the engine that produces the
**graph** every other subsystem actually queries.

- **`ExtractorRegistry`** runs five extractors (`FrontendExtractor`,
  `BackendExtractor`, `DatabaseExtractor`, `ConfigExtractor`,
  `ArchitectureExtractor`) over real source text, producing typed
  **`Entity[]`** — `{id, kind, layer, name, relPath, line?, metadata}`.
  `EntityKind` spans both frontend (`page`, `component`, `layout`,
  `hook`, `route`, `api-client`, `state-store`, `asset`) and backend
  (`endpoint`, `controller`, `service`, `repository`, `middleware`,
  `auth-guard`) and database/config/docs kinds (`orm-model`, `table`,
  `migration`, `env-var`, `dependency`, `dockerfile`,
  `compose-service`, `ci-pipeline`, `build-config`, `arch-module`,
  `doc`). Extraction is real regex/heuristic parsing over real files —
  **not** an AST semantic pass, **not** invented data.
- **`RelationLinker`** derives **`Relation[]`** (`renders`, `imports`,
  `uses-hook`, `defines-route`, `calls-endpoint`, `handles`,
  `uses-service`, `uses-repository`, `maps-to-table`, `foreign-key`,
  `migrates`, `configures`, `depends-on`, `documents`, `secured-by`,
  `runs-in`) purely from the entities' own extracted metadata — there
  is no separate call-graph analysis pass.
- `graph()` returns `{entities, relations, stats}` — this is the exact
  object every consumer in this platform reads.

**Two known, real, load-bearing limitations** (documented here because
two other subsystems in this platform had to be designed around them —
any future engineer who assumes otherwise will silently reintroduce
bugs this platform already paid to discover):

1. **`'imports'` is not a real import graph.** `link/linker.ts` only
   emits an `'imports'` relation when a JSX-rendered component tag
   matches another component entity by name. There is no relation
   derived from resolving an actual `import { X } from './y'`
   statement. Do not use `graph.relations` to answer "what does this
   file import" — it will silently be wrong for anything that isn't a
   JSX-rendered component reference.
2. **Extractors only produce entities for framework-shaped exports.**
   A plain exported utility function, a helper module, most backend
   business logic that isn't a `Controller`/`Service`/`Repository`-
   suffixed class — none of these ever become an `Entity`. This is why
   the Diagnosis Engine's Dead Code and Broken API detectors do **not**
   query the graph for cross-file usage (they would silently
   false-negative on ~80% of real code) — they run a real, bounded,
   textual filesystem scan instead (`exportScan.ts` / `repoScan.ts`),
   using the graph only as a secondary corroborating signal. It is
   also why Diagnosis's `signals.ts` has a textual
   `nearestDeclaredName` fallback: the graph-based `nearestSymbol`
   heuristic returns `null` for any location with no Entity at all,
   which — before this fallback existed — silently broke symbol
   resolution for most ordinary files.
3. **No `'test'` `EntityKind` and no `TestExtractor` exist.**
   Test-relatedness anywhere in this platform is established by real
   filesystem existence checks (`<file>.test.ts`, `.spec.ts`,
   `__tests__/`), never by querying the graph.

### 3.3 Derived intelligence reports

Sitting on top of the two engines, not inside them:

- **Repository Health Engine** (`intelligence/healthEngine.ts`) — real,
  deterministic assessment of documentation/testing/dependency/
  architecture coverage via direct filesystem checks (README presence,
  test file counts, orphan module detection). Produces `HealthScore`
  (`overall`/`documentation`/`architecture`/`testing`/`dependencies`/
  `maintainability`) + `HealthIssue[]`, cached per project with a
  staleness check against the project root's real mtime.
- **Change Intelligence** (`intelligence/changeIntelligence.ts`) —
  hotspot detection, change velocity, change patterns. **Real, but
  known-imprecise**: the change log (`~/.aura/changes/log.json`) is a
  single global file, not scoped per project. This is a pre-existing
  limitation every screen that surfaces this signal (Architecture view,
  Mission Control) already lives with and discloses honestly rather
  than hiding.
- **Architecture layer extraction** (`architectureExtractor.ts`) —
  derives visual layer tiers from graphify's richer graph when
  available, falling back to the FullStack graph's own entities/
  relations for the currently mounted project. Exposed as
  `WorkspaceManager.resolveArchitectureLayers(id)` — extracted onto the
  manager specifically so it has exactly one implementation shared by
  the `/architecture-layers` route and Mission Control's signal
  gathering (see §7).

**How every other subsystem consumes this fabric:** read-only, through
exactly two surfaces — `PipelineManager.graphView()` /
`.retrieve()` for entities/relations/coding search, and
`WorkspaceManager.projectIntelligence(id)` /
`.resolveArchitectureLayers(id)` for health/verification/change/
architecture reports. No subsystem downstream re-implements extraction,
re-derives layers, or re-scores health. That is the whole point of
having a Knowledge Fabric at all.

---

## 4. AI Code Intelligence

**Why it exists:** the Code Workspace needs fast, scoped, single-shot
edits (Explain, Refactor, Optimize, Simplify, Convert, Rename, Add
Documentation, Review Security, Generate Tests, Custom Prompt) that are
grounded in real dependency data without paying for a full
conversational context assembly on every keystroke-adjacent action.

**Selection pipeline** (`apps/desktop/src/editor/aiContext.ts`): the
client already holds the project's `GraphView` in memory (loaded once
via `useProjectData()` — zero extra network calls per action).
`nearestSymbol()` resolves the entity nearest to the cursor by a
**documented line-proximity heuristic** — entities only carry a start
line, never an AST end-range, so this is explicitly not scope-precise.
`contextForSelection()` then derives real `dependencies`/`dependents`/
`dependentFileCount` purely from `graph.relations`.

**Prompt assembly** (`packages/ai-service/src/codeAction.ts`):
`buildSystemPrompt()`/`buildUserPrompt()` render a strict JSON-only
contract — the task verb for the chosen `ActionKind`, the selected
code, a bounded 12-line window of surrounding context (reference-only,
explicitly marked "do not modify"), the resolved symbol, and the real
dependency/dependent lists resolved above — with an explicit
instruction that the model must use only the given numbers and invent
nothing else.

**The call itself** is `PipelineManager.generate({system, user,
json:true})` — deliberately **not** the conversational `ask()`/
`streamEvents()` path, which assembles a heavier repository-identity +
conversation-history context this focused, single-shot edit does not
want or need.

**Diff generation:** the model returns `{explanation, newCode|null,
findings|null, risk}`. `'diff'`/`'new-file'` actions produce `newCode`,
spliced into the real buffer for preview via `spliceSelection()` —
never applied directly. `'findings'` actions (`Explain`,
`Review Security`) are read-only by contract and never touch the
buffer at all.

**Risk floor, computed before the model is ever called**
(`aiContext.ts#riskFloor`): a deterministic `'safe'|'medium'|'high'`
floor from real, named signals — dependent file count, reference
count, a sensitive-pattern regex (secrets/env vars/exec-eval/
destructive SQL), selection size, rename blast radius.
`jsonMode.ts#mergeRisk` lets the model only ever **escalate** this
floor, never lower it — the same "deterministic before probabilistic"
law used everywhere else in this platform.

**Approval and write:** `AIActionDialog.tsx` never writes anything
until the user clicks **Accept** — Accept calls `updateContent()` +
`saveFile()`, which round-trips through the real Tauri filesystem
bridge (`code_write_file`). A fire-and-forget `reindex()` call follows
so the Knowledge Fabric picks up the change on its next query.

**Why direct editing is forbidden:** a single-shot LLM generation has
no verification step of its own. Treating its output as ground truth
and writing it unattended would let a hallucinated rename, a wrong
argument count, or a subtly broken edit land in the user's real
repository with nobody having looked at it. The Accept click is the
one and only place risk becomes real — everything before it is
reversible by simply closing the dialog.

**Monaco integration / command palette / right-click actions:**
`ACTION_SPECS` (`actionSpecs.ts`) is the single source of truth for
every action's label, palette phrasing, mode (`'diff'|'findings'|
'new-file'|'diagnosis'`), read-only flag, icon, and prompt verb.
`MonacoEditor.tsx`'s `handleMount` iterates this **one array once** to
register real native context-menu entries (`editor.addAction`);
`EditorWorkspace.tsx`'s Ctrl+I command palette maps the **same array**
to palette commands. The menu and the palette cannot drift out of sync
because there is only one array to edit.

**Note on deprecation:** `'fix-bug'` and `'find-bugs'` were removed
entirely from `ActionKind` — replaced by the Engineering Diagnosis
Engine's `'diagnose'` action (§5). The risk-floor and never-write-
directly mechanics were preserved; what was retired was the shallow,
unverified "AI, please fix this" contract, in favor of a pipeline that
classifies deterministically before ever asking a model to explain or
patch anything.

---

## 5. Engineering Diagnosis Engine

**Why it exists:** "AI, find and fix the bug" is not a safe contract —
it asks a model to do three things at once (detect, explain, patch)
with no verification anywhere in the loop. The Diagnosis Engine splits
this into ten explicit stages so that every fact-based question is
answered deterministically, every model call has a narrow, single job,
and every patch is safety-checked twice (once by rule, once by a
second adversarial model) before a human ever sees it.

**Never ask the LLM to classify. The engine classifies first.**

### Stage 1 — Failure Analysis (`diagnosis/signals.ts`) — deterministic, zero model calls

Reads the real file from disk. Resolves a symbol via the graph's
`nearestSymbol`, falling back to a **real textual parse**
(`tsHelpers.ts#nearestDeclaredName`) when no graph Entity exists at
that location (see §3's Gap 2 — this fallback is required for the
engine to work on ordinary, non-framework-shaped code at all).
Computes real exports (`exportScan.ts`, textual regex scan, not a
type-checker), real local/external imports, real dependency/dependent
references from the graph, the file's real architecture layer plus
cross-layer import resolution (`architectureSmell.ts#resolveCrossLayerImports`
— reused unmodified by three later stages), real git history/blame
(`gitSignals.ts`, its own small `execFile` wrapper), real test-file
existence, doc/API/database relations filtered from the dependency
list, `ts.transpileModule` syntax diagnostics, and a real
`memory.recall()` query. **No AI call happens in this stage.**

### Stage 2 — Classification (`diagnosis/classify.ts`) — deterministic, zero model calls

Runs four real detectors in a fixed, most-specific-first order —
null-bug → dead-code → broken-api → architecture-smell — first fire
wins. If none fire, the category is honestly **`'unknown'`**, and the
**pipeline stops right here** — no root cause, no patch, ever
generated for a category the engine cannot verify. Every detector
attaches `checksRun` (what was checked, whether it fired) — this is
also literally the data the Confidence Engine's `diagnosis` score is
computed from.

The four detectors, each returning `{fires, evidence, checksRun}`:

- **null-bug** (`detectors/nullBug.ts`) — pure `ts.createSourceFile`
  parse of the enclosing function. Finds nullable sources (optional or
  `| null`/`| undefined` params, or locals from `.find()`/`Map.get()`/
  `.exec()`/`.match()`/`getElementById()`), walks the function in
  source order tracking a guarded-name set, fires only on a real
  unguarded, non-optional-chained access. **Documented as a coarse
  heuristic** — not full control-flow analysis.
- **dead-code** (`detectors/deadCode.ts`) — confirms a real export
  (`scanExports`) → excludes graph-recognized framework-entry-point
  kinds (routes, pages, endpoints, middleware, CI/build config, etc. —
  never eligible) → a bounded (40-file-capped), ignore-rule-respecting
  repo scan for any cross-file import resolving to this file → a
  sibling-barrel re-export check. **Deliberately not a graph lookup**
  — the graph only has entities for framework-shaped code (§3, Gap 2).
- **broken-api** (`detectors/brokenApi.ts`) — parses the real current
  signature (param count/optionality) and export list → the same
  bounded scan for real callers → per caller, two purely syntactic
  checks: a named import no longer in the export list, and an
  argument count below the required parameter count. **Gate:** zero
  real callers anywhere means this category cannot honestly fire.
- **architecture-smell** (`detectors/architectureSmell.ts`) — resolves
  the current file's own real import specifiers (scanned from its own
  text, immune to the file itself having no graph Entity) against an
  explicit allowed-edges matrix (`frontend→backend`/`database`
  disallowed; `backend→database`, same-layer, and anything into
  `config`/`docs`/`architecture` allowed), using a file→layer map built
  from every graph Entity.

### Stage 3 — Root Cause (`diagnosis/rootCause.ts`, LLM call #1)

Explains **why**, grounded exclusively in Stage 1/2's real evidence.
Explicitly, contractually forbidden from proposing any code — that is
a separate, later stage.

### Stage 4 — Patch Generation (`diagnosis/patchGen.ts`, LLM calls #2–4)

Called three times with three distinct system prompts —
`minimal-fix` / `defensive-fix` / `refactor-adjacent-fix`. The output
schema forces a **surgical `{targetRange, newText}` range-replace**
over the current file, never a full-file rewrite — structurally
checkable downstream by the Patch Limiter, not merely an instruction
the model might ignore. Every prompt embeds explicit PATCH RULES:
never remove unrelated functions/exports/imports/tests/docs, never
change a public API or the architecture, never rename an unrelated
symbol.

### Stage 5 — Patch Limiter (`diagnosis/patchLimiter.ts`) — the deterministic safety engine

Splices the candidate into the real file text (`splicePatch` — the
same line-range-replace primitive the client uses for its own diff
preview), then computes real, named stats: `linesAdded`/
`linesRemoved`/`percentRemoved`, `entireFileChanged`, `exportsRemoved`/
`exportsAdded` (via the same `scanExports` used in classification),
`importsRemovedCount`, `architectureLayerChanged` (re-runs
`resolveCrossLayerImports` before vs. after — sensitive to a violation
being either introduced *or* fixed).

**Exact decision ladder, evaluated in this literal order:**

```
percentRemoved > 30%            → auto-rejected
entire file effectively replaced → auto-rejected
any real export removed          → auto-rejected
a cross-layer-import violation changed → requires-manual-approval
otherwise                        → auto-approved
```

**Critical distinction, never to be blurred:** `'auto-approved'` means
*passed the deterministic safety gates* — it does **not** mean written
to disk. The file is only ever written from the separate `/accept`
endpoint, after an explicit human click, **regardless** of this
decision. `'auto-rejected'` candidates are still shown to the human,
grayed out, with their real rejection reason — never hidden.

**Documented, known tension (not a bug):** the rule "any export
removed → auto-reject" will sometimes reject the objectively smallest
fix for dead code — e.g. simply dropping the unused `export` keyword —
because that is, by definition, removing an export. This is the rule
working exactly as specified. The UI surfaces this honestly rather
than special-casing it away.

### Stage 6 — Patch Simulation (`diagnosis/simulate.ts`)

Never trusts the patch. Three real, bounded checks: (a) a
`ts.transpileModule` syntax/local-diagnostics compile check — **no
cross-file type-checking, no `ts.createProgram`**, an explicit, stated
scope cut disclosed in every `notes` array; (b) re-runs the *same
winning detector* against the patched text to see if the category
still fires; (c) re-runs the Broken API caller-search against every
export the Limiter flagged as removed. Test discovery is
existence-only and **never executed** — `notes` states this plainly
every time, regardless of outcome, so it can never be misread as
"tests passed."

### Stage 7 — Confidence Engine (`diagnosis/confidence.ts`)

Every one of five numbers (`diagnosis`/`patch`/`architecture`/
`simulation`/`overall`) is a ratio of real checks fired over real
checks run — **never a bare model opinion** — and passes through
`capConfidence` (hard-capped at `0.99`) both server- and client-side,
so a badge can never honestly display "100%". `overall` is a
documented, auditable weighted average: `0.30·diagnosis + 0.30·patch +
0.15·architecture + 0.25·simulation`.

### Stage 8 — Reviewer (`diagnosis/reviewer.ts`, one LLM call per surviving candidate)

A second, distinct adversarial model role. Its only job is to try to
**prove the patch wrong**: it doesn't fix the stated root cause, it
breaks a real caller, it introduces a *new* null-deref, it violates
the file's real style, or the confidence numbers overclaim what was
actually verified. Rejects only for a genuine, specific, named flaw —
never a vague objection. If the reviewer call itself fails (e.g. a
rate limit), the candidate is **not** penalized — it's treated as
`pass` with an honest note that the failure was the platform's, not
the patch's.

### Stage 9 — Patch Evolution (`diagnosis/evolution.ts`)

Compares **only** candidates that survived both the Limiter (not
auto-rejected) and the Reviewer (not rejected). Zero survivors →
`recommended` is honestly `null`, never fabricated. Exactly one
survivor → recommended by elimination, no LLM call spent comparing
against nothing. Two or three survivors → one final LLM call producing
a labeled "AI-written comparison" writeup plus a recommended id.

### Stage 10 — Approval, Persistence, and Memory

`DiagnosisPanel.tsx` shows the full stage timeline, Stage 1 evidence,
the classification with its `checksRun` breakdown, the AI root cause,
and the A/B/C compare view (`DiagnosisPatchCompare.tsx` — a real Monaco
`DiffEditor` per candidate). The human picks **one** candidate.
`POST /projects/:id/diagnose/:did/accept` is the **only** place
`fs.writeFileSync` is ever called for a diagnosis — gated a **second
time, server-side**, by re-checking the Limiter's decision (a
directly-crafted API call cannot accept an auto-rejected candidate even
if the UI is bypassed). Every `DiagnosisRecord` is persisted
(`DiagnosisStore`, one JSON file per diagnosis under
`~/.aura/diagnosis/<projectId>/<id>.json`) as the pipeline runs, so a
crash mid-run leaves an honest partial record, never a lost one. A
`MemoryItem{kind:'diagnosis'}` is written immediately after
classification/root-cause — the one piece of persistent memory this
stage produces today (see §11 for what this is *not* yet).

**Why deterministic systems always execute before AI reasoning:** a
language model has no ground truth about *this specific repository*
beyond whatever text is stuffed into its prompt at call time. It
cannot be trusted to correctly determine "is this actually dead code"
or "did this patch remove a public export" — those are factual,
checkable questions with one right answer, not judgment calls. Running
the real parse/scan/diff **first** means the model is only ever asked
to do the two things it is actually good at — explaining a cause in
prose, and drafting a plausible patch — never to adjudicate a fact a
parser could get right every time.

---

## 6. Mission Control

**Why it exists:** a free-text goal like "prepare this project for
production" is not itself actionable — it needs to become a concrete,
evidence-grounded plan, and that plan needs to be executed one
reviewed step at a time, never as an unattended batch. Mission Control
is the pipeline that does exactly that, and nothing more.

> **v3 execution layer:** everything below (planning through the two
> human gates) is unchanged and still authoritative. What v3 *added* is
> an execution engine on top of the approved plan — a real DAG with
> auto-ordering, dependency blocking, waves, critical path, checkpoint
> gates (planning → execution → review → completion), metrics derived
> from real task states, frame-per-mutation replay, and a global
> dashboard. See [`MISSION_CONTROL_V3.md`](./MISSION_CONTROL_V3.md) for
> the execution model; this section covers the planning pipeline that
> feeds it.

### Mission model

A `MissionRecord` — `{id, projectId, text, createdAt, signals, intent,
classification, strategy, goalGraph, risk, review, quality, approval,
taskRuns, execution?}` — persisted one JSON file per mission under
`~/.aura/missions/<projectId>/<id>.json` (`MissionStore`, identical
atomic-write convention to `WorkflowStore`/`DiagnosisStore`). The
`execution?` block is populated lazily by the store's `hydrationEngine`
on read, so every record — including pre-v3 ones — presents a valid
execution view.

### Stage 1 — Signals (`mission/signals.ts`) — deterministic, zero model calls

Composes three **already-existing** real engines rather than computing
anything new: the repository Health Engine's score and issues (real
`HealthScore` + `HealthIssue[]`), real architecture layers (the exact
same `resolveArchitectureLayers` shared with the `/architecture-layers`
route — see §7, no duplicated logic), and real change hotspots,
velocity, verification score, and recommendations (via
`projectIntelligence()`). Carries forward the honest, documented
limitation from §3: the change log is not project-scoped — Mission
Control does not pretend otherwise.

### Stage 2 — Planner (`mission/planner.ts`, one LLM call)

Turns the free-text mission into a Goal Graph: goals (`title`,
`rationale`, `relatedEvidence`, `priority`) each broken into steps
(`title`, `description`, `targetFile` or `null`). The system prompt
explicitly forbids inventing issues, files, or numbers not given, and
requires every goal's `relatedEvidence` to cite real Stage-1 evidence.
`targetFile` must be a real evidence-given path, a plausible new
root-level documentation file, or `null` for a step with no single
concrete file (an architectural/process goal). A step's `mode` at plan
time is only ever a **provisional guess** — Stage 4 corrects it against
the real filesystem before ever generating a proposal.

### Stage 3 — Approval Gate #1: the plan

`approval.status` starts `'pending'`. The execution engine's
`runReadyTasks`/`runTask` refuse outright — **server-side, not merely
in the UI** — until the planning checkpoint is `passed`
(`approval.status === 'approved'`). This is the first of Mission
Control's two human gates: the entire plan must be read and approved
before a single task can run.

### Stage 4 — Task Execution, per task, human-gated (`mission/taskGen.ts`)

The engine only ever runs a task whose dependencies are all complete.
For tasks with a real `targetFile`, proposal generation checks
`fs.existsSync` of the real target file to decide `diff` vs.
`new-file` mode, reads the real current content, and makes **one** LLM
call asking for the complete rewritten file, grounded in the task's
own description and the goal's rationale, explicitly told to make the
minimum change needed. This produces a `TaskProposal` — it writes
nothing.

### Stage 5 — Approval Gate #2: Accept / Reject / Mark Done

`acceptMissionTask` is the **only** place a mission task's proposal is
ever written to disk — gated by requiring the task be in `review`
with a real `newCode` already present (the engine refuses any other
state, so a directly-crafted API call cannot accept an unreviewed
task). The write itself happens in the `workspace.ts`-injected hook:
`resolveInsideProject` + `fs.writeFileSync`, followed by a
fire-and-forget reindex and an `accepted` memory entry. This is the
second human gate. `rejectMissionTask` records the decision (and
propagates `blocked` to dependents) and writes nothing. Manual kinds
are never sent to a model at all — `completeManualTask` just
records that the human resolved them.
### Stage 6 — Verification (`refresh-signals`)

Re-runs Stage 1's exact same deterministic gather, on demand. This
works because the underlying Health Engine already has its own
staleness check (it only regenerates when the project root's real
mtime shows change since the cached report), so re-fetching signals
after accepting a few tasks shows a **real** before/after — never a
fabricated progress percentage.

**Why there is no fake progress:** an early version of this platform's
design called for a live numeric "simulation" of mission outcomes
before execution. That is not honestly buildable — there is no model
of an arbitrary codebase precise enough to predict a percentage. What
*is* honestly buildable, and is what exists: real signals before the
mission starts, a plan grounded in those real signals, and the exact
same real signals recomputed after real steps are taken. Every number
Mission Control ever shows is a number that was actually measured —
twice.

---

## 7. Shared Architecture

The platform has exactly **one implementation per concern**. This
section is the proof.

- **Single source of truth for "what does this project look like":**
  `PipelineManager.graphView()` and `WorkspaceManager
  .projectIntelligence()` / `.resolveArchitectureLayers()`. AI Code
  Intelligence, the Diagnosis Engine, and Mission Control all read
  these same two surfaces. None re-extracts entities, re-derives
  layers, or re-implements health scoring.
- **`resolveArchitectureLayers`** is the concrete proof this rule is
  enforced, not aspirational: it was originally inlined once, in
  `server.ts`'s `/architecture-layers` route. It was extracted onto
  `WorkspaceManager` specifically so Mission Control's `signals.ts`
  could call the **exact same function** rather than re-implementing
  the graphify-preference/fallback logic a second time.
- **`resolveCrossLayerImports`** (Diagnosis's `architectureSmell.ts`)
  is reused, unmodified, by three different stages within Diagnosis
  alone: the architecture-smell detector itself, the Patch Limiter's
  before/after check, and Patch Simulation's category re-check. One
  real algorithm, three consumers — not three approximations of the
  same idea.
- **`jsonMode.ts`** (`parseModelJson`, `mergeRisk`, `RiskLevel`) is the
  one shared JSON-mode LLM-call convention used by `codeAction.ts`,
  Diagnosis's `rootCause`/`patchGen`/`reviewer`, and any future
  single-shot grounded call. One fence-stripping/parse/no-retry
  contract, not N reimplementations with N slightly different failure
  modes.
- **`exportScan.ts` / `repoScan.ts`** (a bounded, ignore-rule-
  respecting filesystem scan plus real export/import parsing) is
  shared across the Dead Code detector, the Broken API detector, the
  Patch Limiter's exports-removed check, and Patch Simulation's
  reference re-check.
- **Memory (`ProjectMemory`)** is a single per-project store, consulted
  by Stage-1 signal gathering in both Diagnosis and the wider
  assistant, and written to by both Diagnosis's and Mission Control's
  Accept/Reject actions. One memory, many writers — not a separate
  memory per feature.

**Net effect:** knowledge is computed once, in one place, by one
deterministic engine per concern (extraction, health, change,
architecture-layer resolution), and every AI-facing feature is a
**consumer** of that computed knowledge — never a second
implementation of it.

---

## 8. Safety Philosophy

These are enforced rules, verifiable in the source referenced next to
each — not aspirations.

- **AI never writes directly to the real filesystem.** Every
  code-facing feature (Code Intelligence's diff/new-file actions,
  Diagnosis's patch candidates, Mission Control's task proposals)
  produces a proposal object in memory. The write only happens inside
  a small, explicit, named function (`saveFile`, `acceptDiagnosis`,
  `acceptMissionTask`) triggered by a real user click.
- **Every write requires approval, enforced in two places, not one.**
  The UI disables the action, *and* the server independently
  re-checks the precondition — Diagnosis's `/accept` re-checks the
  Limiter's decision even if the client is bypassed entirely; Mission
  Control's execution engine re-checks `approval.status` server-side
  (`engine.ts#runReadyTasks`) before any task runs.
- **Deterministic analysis always runs first.** Diagnosis classifies
  before any model is called at all, honestly stopping at `'unknown'`
  rather than asking the model to guess a category.
- **The Patch Limiter cannot be bypassed by the model.** The model can
  only ever propose `{targetRange, newText}` — a structurally tiny
  surface. Every property the Limiter checks (lines changed, exports
  removed, layer violations) is measured by real code, never asked of
  the model.
- **Risk cannot be hidden.** `riskFloor()`/`mergeRisk()` guarantee a
  deterministic floor can only be *escalated* by the model, never
  lowered. The Confidence Engine's `0.99` cap guarantees no confidence
  number is ever allowed to imply certainty.
- **Simulation before execution.** Diagnosis re-parses, re-classifies,
  and re-checks references against the *patched* text before a human
  even sees the candidate — the human's Accept decision is informed by
  a real, if bounded, dry run, not blind trust in the model's own
  claim.
- **The human remains in control at every step.** Nothing in this
  platform runs unattended past its first grounding computation.
  Diagnosis stops at one human decision per diagnosis; Mission Control
  requires two independent human approvals (the plan, then each step)
  before a single byte changes on disk.

---

## 9. Data Flow

```
User
  ↓
Knowledge      graphView() / projectIntelligence() — already loaded client-side for Code
               Intelligence; gathered fresh server-side for Diagnosis/Mission Stage 1
  ↓
AI             codeAction.ts single-shot call, OR Diagnosis's up-to-8-call pipeline,
               OR Mission's planner + per-step calls — always through jsonMode.ts's
               one parse/no-retry contract
  ↓
Diff           spliceSelection() / splicePatch() — one line-range-replace primitive,
               reimplemented consistently client- and server-side
  ↓
Approval       Accept click — always a distinct, explicit, separately-rendered UI action,
               never inferred from "the user didn't object"
  ↓
Write          saveFile() / fs.writeFileSync() — the ONLY place any of these subsystems
               touches the real filesystem for a mutation
  ↓
Reindex        reindex() — fire-and-forget, so the Coding/FullStack indexes pick up the
               new file content
  ↓
Knowledge Update   the NEXT graphView()/projectIntelligence() call reflects the real,
                   current state — no manual cache invalidation the user has to remember
```

**Where this loop is honestly not closed automatically:** health and
change signals are only rechecked on the **next explicit request**
(e.g. Mission Control's "Refresh" button), not pushed to any open UI
the instant a file changes. This is a disclosed limitation, not a
hidden gap — closing it would require a filesystem watcher this
platform does not currently run.

---

## 10. Extension Guide

**New AI Action (Code Intelligence):** add one entry to `ACTION_SPECS`
(`id`/`label`/`paletteLabel`/`mode`/`readOnly`/`icon`/`promptVerb`) and
one `VERB`/`MODE`/`READ_ONLY` entry in `codeAction.ts`'s `ActionKind`
maps. Never bypass `buildUserPrompt`'s real-dependency-data rule — a
new action must still ground itself in `ctx.dependencies`/
`ctx.dependents`, never invent scope.

**New Diagnosis Rule (bug category):** add a new detector file under
`diagnosis/detectors/` returning `{fires, evidence, checksRun}`;
register it in `classify.ts`'s `ORDER` array (placement matters —
first-fire-wins, so order most-specific-first); add the new
`BugCategory` literal to `types.ts`. A new detector must **never** call
a model — if a check requires model judgment, it isn't a
classification rule; it belongs in Root Cause or the Reviewer.

**New Mission Type:** Mission Control's pipeline is not hardcoded to
"prepare for production" — `planner.ts` already accepts arbitrary free
text and grounds it in whatever real Stage-1 signals exist. A
genuinely new mission *type* (one that needs a new kind of evidence)
should add a field to `MissionSignals` and populate it in `signals.ts`
from a real, already-existing engine — never fabricate a new metric
inside the planner's prompt.

**New Safety Rule:** add it to `patchLimiter.ts`'s decision ladder as
its own explicit branch, in explicit priority order, with its own
named `reasons` string. Never fold two independent rules into one
boolean check — the UI and the Confidence Engine both need to know
exactly *which* rule fired.

**New Knowledge Provider:** implement the existing `Extractor`
interface (`extract/extractor.ts`) and register it in
`ExtractorRegistry`. It must produce real `Entity[]`/relations from
real files only, and must not reach into another provider's output. If
it introduces a new `EntityKind` or `Layer`, every consumer that
switches on those unions (`architectureSmell`'s `DISALLOWED` matrix,
the Health Engine's module walk) needs an explicit, reviewed decision
about how the new kind is treated — never let it silently fall through
to a default.

**General rule for all of the above:** if you cannot point to the
real, deterministic signal a new feature is grounded in, it is not
ready to build yet. Compute that signal first — in one place, in the
Knowledge Fabric or an existing intelligence engine — and only then
wire an AI feature on top of it.

---

## 11. Future Extensions

Everything in this section is **Architecture Planned** — none of it is
implemented. Do not build on top of an assumption that any of the
following exists.

- **Engineering Memory — Architecture Planned.** Today, `ProjectMemory`
  is a flat, keyword-overlap recall log written to by Accept/Reject
  actions across features and read by Stage-1 signal gathering. No
  detector, no confidence score, and no planner choice is currently
  *conditioned on* past memory content. A true Engineering Memory
  would let, for example, a Diagnosis classifier or the Confidence
  Engine weight a candidate based on what similar past patches'
  real-world outcomes were.
- **Learning Engine — Architecture Planned.** No component in this
  platform updates its own behavior based on outcomes. Reviewer
  verdicts, accept/reject decisions, and confidence scores are all
  computed fresh, every time, from the same fixed rules.
- **Predictive Intelligence — Architecture Planned, explicitly out of
  scope, not merely deferred.** A live, per-keystroke bug-probability
  percentage was explicitly ruled out during this platform's own
  design process as not honestly buildable without real statistical or
  ML backing. No such model exists anywhere in this codebase.
- **Digital Twin — Architecture Planned.** No running, simulated model
  of the target application exists. Patch Simulation (§5, Stage 6) is
  a real but narrow *static* check — syntax, local diagnostics, and a
  re-run of the same deterministic detector — not an execution twin.
- **Multi-Agent Execution — Architecture Planned.** Every AI call in
  this platform today is a single, stateless request to one model in
  one role at a time (root-cause writer, patch generator ×3
  strategies, adversarial reviewer, comparison writer, mission
  planner, step generator) — sequential, not a coordinating
  multi-agent system with shared state or negotiation between agents.

---

## 12. Engineering Principles

These are permanent laws for this platform, not situational
preferences. A change that violates one of these is an architecture
regression, regardless of how it tests.

1. **Knowledge before Generation.** No model call happens without real,
   already-computed facts from the Knowledge Fabric handed to it
   first.
2. **Deterministic before Probabilistic.** Any question with one
   correct, checkable answer is answered by code, never by asking a
   model to judge.
3. **Simulation before Execution.** A proposed change is re-checked
   against reality before a human is asked to decide on it.
4. **Approval before Mutation.** Nothing is written to the real
   filesystem without an explicit, rendered human action — enforced
   server-side, not only in the UI.
5. **Architecture before Features.** A new capability is only built
   once its real, deterministic signal exists in the Knowledge Fabric
   or an intelligence engine — never invented inline inside a prompt.
6. **Trust before Automation.** The platform earns the right to
   automate a step only by first making every judgment behind it
   inspectable — a rule that cannot be shown its reason has no place
   here.
7. **Memory before Intelligence.** Understanding this repository's past
   decisions is a prerequisite for claiming to understand its future
   ones — which is precisely why this platform does not yet claim to
   *learn*, only to *remember* (§11).
