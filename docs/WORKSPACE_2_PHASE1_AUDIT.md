# Workspace 2.0 — Phase 1 Audit (READ-ONLY)

No code was modified to produce this document. It records what exists at
`a382625` + the current dirty tree, what can be reused for the Connected
Environment / Shared Context Fabric / Universal Agent work, what is genuinely
missing, and which findings should change the plan before Phase 2 starts.

Companion authorities: [`AURA_HUB_MASTER_HANDOFF.md`](./AURA_HUB_MASTER_HANDOFF.md),
[`AURA_HUB_ARCHITECTURE_MAP.md`](./AURA_HUB_ARCHITECTURE_MAP.md).

---

## 0. Headline

**Most of the Context Fabric already exists.** It is called *Repository
Intelligence*, it lives in `packages/ai-service/src/intelligence/`, and it
already does layered project understanding, per-intent context slicing,
staleness checks, incremental change detection and version snapshots.

What does **not** exist is:

1. an **exposure** of that understanding as a first-class, versioned,
   queryable *Context View* (there is no HTTP surface for it — it is only ever
   consumed internally, inline, on the `/ask` and `/stream` paths);
2. a **canonical agent system prompt**, and any path that gives a delegated CLI
   agent context at all (`agent.delegate` passes bare task text);
3. a **project-first Workspace UX** (Home is a project library; the Workspace
   screen is the node graph; the two disagree about which project is active);
4. **live git / tool / activity state in the shell** (git branch is read out of
   a frozen mission snapshot, the activity trail is in-memory only).

So Phase 2 is mostly *promotion and exposure*, not new invention. That matters:
building a second context engine beside `intelligence/` would violate the
"do not duplicate an authority" rule as hard as a second policy engine would.

---

## 1. Inventory — what exists today

### 1.1 Project truth

| Concern | Where | State |
| --- | --- | --- |
| Persistent project registry | `ai-service/src/projects.ts` (`ProjectRegistry`) | **Real.** Persists to `<home>/projects.json`. Rejects non-directories. Never seeds samples. |
| Open-project ownership | `ai-service/src/workspace.ts` (`open`, `currentProject`) | **Real**, server-side, single. |
| HTTP surface | `GET/POST /projects`, `POST /projects/:id/open`, `/profile`, `/intelligence`, `/graph`, `/changes`, `/memory`, `/architecture-layers` | **Real.** |
| UI project state | `apps/desktop/src/data/useWorkspace.ts` (`openId`) | Real, but a **second** copy of "which project is open". |
| Shell nav state | `packages/core/src/store/appStore.ts` (`activeProjectId`) | A **third** copy. Not persisted. `setNav` clears it (`appStore.ts:110`). |
| Workspace-screen project | `apps/desktop/src/screens/WorkspaceScreen.tsx:41,63` (`aura.workspace.projectId` in `localStorage`) | A **fourth** copy, independently persisted. |

> **Finding P-1 — four project pointers.** `ProjectRegistry.current` (server),
> `useWorkspace.openId`, `appStore.activeProjectId` and the Hub's
> `localStorage` key are four separate answers to "what am I working on".
> Section 4 of the brief ("AURA must always have an active project context")
> is not satisfiable until these collapse onto one. The server-side one is the
> only correct authority — the others should become projections of it.

### 1.2 Context infrastructure — the pre-existing Context Fabric

All of this is in `packages/ai-service/src/intelligence/`:

| Layer in the brief | Existing implementation | Notes |
| --- | --- | --- |
| **L0 Identity** | `identity.ts` (`ProjectIdentity`, `generateIdentity`, `loadIdentity`, `identityNeedsRegeneration`) | Persisted per project. Type, languages, frameworks, platforms, entry points, modules, build system, status. |
| **L1 Project map** | `moduleSummarizer.ts` (`RepositorySummary`, module tree), `architecture.ts` (`buildModuleHierarchy`, `detectEntryPoints`) | |
| **L2 Architecture** | `architecture.ts` (`buildDependencyGraph`, `mapApiSurface`, `findUsages`), `repositoryMemory.ts` (`RepositoryProfile` — patterns, conventions, key decisions), `validation.ts` (`validateArchitecture`, `DEFAULT_RULES`) | Invariant checking already exists. |
| **L3 Semantic** | `glossary.ts`, `documentPriority.ts` (`prioritizeDocuments`), `knowledgeGraph.ts`, plus `@aura/retrieval` (`contextAssembler`, `memory/hierarchy.ts`, `memory/layers.ts`, `budget/tokenBudget.ts`) | Two assemblers exist — see D-1 below. |
| **L4 Active context** | `changeIntelligence.ts` (change log, patterns, hotspots, velocity), `mission/signals.ts` (`gatherMissionSignals` → git status, recent commits, build status, debt markers, security findings) | Mission signals are captured **per mission at plan time**, not continuously. |
| **L5 Tool context** | `ai-service/src/environment.ts` + `@aura/connected-environment` CATALOG | Real probes. Not currently folded into any agent context. |
| **L6 Recent events** | `CapabilityFabric.auditLog` (`capability-fabric/src/fabric.ts:166`), `changeIntelligence` log, mission timelines | Audit log is **in-memory only**. |

**Context assembly** — `intelligence/contextAssembler.ts:289` `assembleContext()`
already implements exactly the model §6 of the brief asks for: a large body of
pre-computed knowledge, sliced *by intent*, never shipped whole.

Intent-specific slices that already exist (`contextAssembler.ts:195-272`):
`project_overview`, `architecture`, `module_explanation`,
`function_explanation`, `bug_fix`/`debugging`, `code_search`, `api_reference`,
`testing`, generic. Intent classification is `repositoryIntent.ts`.

**Context versioning** — `intelligence/versioning.ts` already gives
`IndexVersion { version, timestamp, artifactHashes, metadata }` with
`createVersion`, `getCurrentVersion`, `compareVersions`, `rollbackToVersion`,
`getVersionStats`. `intelligence/index.ts:236 snapshotVersionIfChanged()`
already bumps the version only when understanding actually changed. **This is
the `contextVersion: 142` in the mock-up, and it is already built.**

**Incremental indexing** — `intelligence/performance.ts`:
`loadIndexState`/`detectChanges`/`updateIndexState`/`hasChanges` over a stored
file→mtime map, plus `LazyFileLoader`.

**Staleness** — `intelligence/index.ts:111 isCacheStale()` (1h max age +
root mtime) guards summary, profile, glossary and health regeneration.

**Verification** — `intelligence/verification.ts` (`generateVerificationReport`)
and `confidence.ts` (`evaluateConfidence`, `ConfidenceMark`) already grade how
trustworthy a piece of context is. This is the raw material for §17's
"Agent Context Preview" trust feature.

> **Finding C-1 — the fabric exists but has no door.** `runIntelligencePipeline`
> (`intelligence/index.ts:128`) is called from exactly one place:
> `pipeline.ts:415`, inline, on `/ask` and `/stream`. Its output is turned
> straight into provider system messages and discarded. There is **no**
> `GET /context` route, no `ContextView` type, nothing any other tool or agent
> can consume. Phase 2's real work is exposing what is already computed.

> **Finding C-2 — the index state is global, not per-project.**
> `performance.ts:16` stores one `index-state/file-mtimes.json` for the whole
> installation. Switching projects makes every file look "changed". This must
> be keyed by project id before incremental context can be trusted.

### 1.3 Node / tool model

| Piece | Where | State |
| --- | --- | --- |
| Catalogue (one, authoritative) | `connected-environment/src/catalog.ts` (`CATALOG`) | ~110 entries. `id · name · category · capabilities · probe · install · auth · license · homepage`. Also the routing tie-break order. |
| Probing | `ai-service/src/environment.ts` (`scanEnvironment`, `probeNode`) | Real `execFile`, 30s cache, concurrency 8, Windows `.cmd` shim resolution. Commands come from the catalogue, never the request. |
| Publication to routing | `server.ts:130 refreshNodeAvailability` → `presentNodes`, `providedNodeCapabilities` | The single caller. |
| UI node state | `apps/desktop/src/environment/environmentStore.ts` | Deliberately non-persistent. Wraps pure reducers from the package. |
| Node presentation | `environment/presentation.ts`, `NodeCard.tsx`, `NodeInspector.tsx`, `ConnectedEnvironment.tsx` | Real status tones, install/auth affordances already modelled. |

The brief's §12 `ToolAdapter` contract (`id, name, category, version, status,
capabilities, healthCheck, contextProvider, execute`) is **already ~80% present**,
split across `CatalogEntry` (id/name/category/capabilities/install/auth),
`ProbeResult` (status/version/health) and the Fabric executors (execute). The
only genuinely missing member is `contextProvider`.

> **Finding N-1 — do not add a tool registry.** §11/§12 are satisfied by
> teaching the existing catalogue+probe pair to contribute a context slice.
> A parallel `ToolAdapter` registry would be a second node catalogue and
> breaks invariant 5.

Known open bug carried from the handoff (§4): `server.ts:149`
`presentNodes = nodes` **replaces** rather than merges, so a targeted scan
narrows the global projection. Anything in Workspace 2.0 that triggers a
targeted scan (e.g. "re-check Docker" from a tool row) will trip this.

### 1.4 Execution, policy, governance

Unchanged and reusable as-is — these are the invariants, not the work:

- one execution authority: `capability-fabric/src/fabric.ts` invoke pipeline;
- one policy engine: `capability-fabric/src/policy.ts` (`stricter()` + floors);
- one approval store: `ai-service/src/fabric/approvalStore.ts`;
- one process primitive: `ai-service/src/exec/process.ts`;
- three disjoint allow-lists: `SAFE_BINARIES` / `AGENT_BINARIES` / `INSTALLER_BINARIES`.

Capabilities relevant to Workspace 2.0 that **already exist** in
`capability-fabric/src/manifest.ts`: `git.status`, `git.diff`, `git.branch`,
`git.commit`, `git.push`, `filesystem.read/list/write`, `terminal.execute`,
`agent.delegate`, `project.list/open/inspect/create`, `mission.*`,
`knowledge.graph`, `memory.search`, `diagnosis.run`, `governance.audit`,
`system.install`, `provider.connect`, `workflow.run`, `browser.*`, `http.request`.

> **Finding G-1 — git context has a governed path already.** "Git → Context"
> (Phase 4) does not need a new git integration. `git.status` / `git.diff` /
> `git.branch` are catalogued capabilities behind the one execution authority.
> The Context Fabric should consume them through `fabric.invoke`, not by
> shelling out.

### 1.5 Mission

`mission/types.ts` (9-stage planning), `mission/store.ts`,
`mission/execution/{dag,engine,checkpoints,replay,metrics}.ts`. Missions execute
through the **same** Fabric instance (`workspace.ts:562 attachFabric`).

`MissionSignals` already carries `gitStatus`, `recentCommits`, `buildStatus`,
`securityFindings`, `technicalDebt`, `hotspots`, `healthScore`.

Carried limitation (handoff §9): `TaskStatus` has **no RUNNING state**, so
"Agent: OpenCode / Status: Working" in the §21 mock-up **cannot be rendered
truthfully today**. Either the status set gains a running state (a real
mission-model change, not a UI change) or the Workspace must not claim it.

### 1.6 Agent integration

`ai-service/src/fabric/executors.ts:160-250`:

```
AGENT_INVOCATIONS = { opencode: ['run', '--dir', cwd, ...model, task] }
```

- Only **OpenCode** has a verified non-interactive invocation. Claude Code,
  Codex, Gemini, Qwen and Cursor are catalogued and allow-listed but are
  refused by name rather than guessed at (`executors.ts:216`).
- The agent receives **the task string and nothing else** (`executors.ts:191`).
  No system prompt, no project context, no identity, no constraints.
- Attribution is already correct: `nodeId` travels back on the result
  (`executors.ts:237`) so the audit records who really ran.

> **Finding A-1 — `executors.ts:224` is the Phase 3 seam.** This single line
> (`invocation.args(task, cwd, model)`) is where AURA system prompt + Context
> View + task must be composed. Nothing else needs to move. The
> `AgentInvocation` contract will need a way to express "how does *this* CLI
> take a system prompt / context file", which is per-agent and must be
> *verified* per agent, exactly as the existing comment demands.

Existing prompt fragments that show house style and must not be duplicated:
`intelligence/contextAssembler.ts:30 AUTHORITATIVE_PREAMBLE`,
`contextAssembler.ts:169 buildGroundingRules()`,
`mission/goalGraph.ts:53` (mission planner persona),
`workflow/nodes.ts:292` (workflow node default system).

> **Finding A-2 — there is no canonical AURA agent prompt.** The four fragments
> above are surface-specific and inconsistent. §15 asks for one canonical
> prompt; the right move is to author it once and have
> `AUTHORITATIVE_PREAMBLE`/`buildGroundingRules` become *derivations* of it,
> not a fifth voice.

### 1.7 State and event infrastructure

| Mechanism | Where | Notes |
| --- | --- | --- |
| SSE streams | `POST /stream`, mission creation, diagnosis, workflow runs, execution batches | Real, already used for progress. |
| Shell store | `packages/core/src/store/appStore.ts` | Nav/chrome/theme only. Deliberately not a god store. |
| Domain stores | `useWorkspace`, `environmentStore`, `statusStore`, `memoryStore`, `notificationsStore`, `layoutStore`, `hubStore`, `agentStore`, `editorStore` | Zustand, one per module. |
| Vitals polling | `apps/desktop/src/ops/statusStore.ts` | Aggregates health, provider, index, missions, memory, diagnoses. |
| Command registry | `packages/core/src/types.ts (Command)`, `shell/useCommands.ts`, `shell/CommandBar.tsx` | ~30 real commands, ⌘K. |
| Notifications | `ops/notificationsStore.ts`, `ops/useNotificationsFeed.ts`, `NotificationCenter.tsx` | Exists. |
| Right context panel | `shell/RightPanel.tsx` | Already a project/nav-aware context panel — the natural host for §16. |

> **Finding S-1 — git branch is read from a frozen mission snapshot.**
> `statusStore.ts:62-78` gets the branch by listing missions, loading the newest
> one, and reading `record.signals.gitStatus.branch`. With no missions there is
> no branch; after a checkout the value is stale until a new mission is planned.
> The Workspace header cannot show a truthful branch this way.

> **Finding S-2 — the activity trail does not survive a restart.**
> `fabric.ts:166 private auditLog: AuditRecord[] = []` is in-memory. §20's
> shared activity stream and §14's cross-agent handoff both require durable
> events. `persist.ts` (`homePath`/`readJsonFile`/`writeJsonFile`) is the
> existing convention for this.

### 1.8 Workspace UX surfaces today

| Surface | File | What it is |
| --- | --- | --- |
| Home | `screens/Home.tsx` (428 ln) | Greeting (hardcoded "Groot", `Home.tsx:95`), project library, knowledge-index card, quick actions, AI-runtime card. No git, no tools, no context, no activity. |
| Workspace | `screens/WorkspaceScreen.tsx` (317 ln) | The Hub graph: capability nodes around a Hub, mission creation inside `HubSurface`, floating node inspectors. This is the "too technical" primary UX the brief wants moved to **Environment Map**. |
| Connected Environment | `environment/ConnectedEnvironment.tsx` (341 ln) | Real tool list with status/install/auth. Most of §13 already. |
| Project workspace | `screens/project/ProjectWorkspace.tsx` + 14 sections | Per-project tabs. |
| Ask AURA (Home) | `components/AskAuraChatbox.tsx` | **Mock.** See U-1. |
| Ask AURA (project) | `appStore.askAuraOpen` → `AiWorkspace` | Real, backed by `/stream`. |
| Router | `screens/ScreenRouter.tsx` | In-memory router; nav keys are `home / workflows / workspace / environment / settings`. Adding **Environment Map** is a `NavKey` + `NAV_ITEMS` + `renderScreen` change (`core/types.ts:10`, `core/navigation.ts:19`, `ScreenRouter.tsx:89`). |

> **Finding U-1 — the dashboard "Ask AURA" is entirely fake.**
> `AskAuraChatbox.tsx:14` says so plainly: *"Everything here is local mock
> behaviour… the backend and its APIs are never touched."* It answers from
> `MOCK_ANSWERS` regexes (`:31`) with a `FALLBACK` (`:96`). §18 makes Ask AURA
> a first-class Context-Fabric surface — this component must be **replaced by**
> the real streaming path (the one `AiWorkspace` already uses), not extended.
> Shipping it as-is contradicts the project's own "nothing is fabricated" rule.

> **Finding U-2 — two Ask AURA implementations.** One mock on Home, one real
> in the project workspace. Collapse to one.

---

## 2. Reuse map — requirement → existing authority

| Brief section | Reuse this, do not rebuild |
| --- | --- |
| §4 Project-first model | `ProjectRegistry` + `manager.open/currentProject`; collapse the 3 UI copies onto it |
| §5 Context Fabric | `intelligence/` engine (identity, summary, profile, glossary, health, architecture, changes) |
| §6 Index → view → agent | `contextAssembler.assembleContext()` intent slices; `@aura/retrieval` token budget |
| §7 Layers L0–L6 | See table 1.2 — L0–L4 exist; L5/L6 need wiring, not invention |
| §8 Context index | `intelligence/performance.ts` (fix per-project keying, C-2) |
| §9 Versioning | `intelligence/versioning.ts` + `snapshotVersionIfChanged` |
| §10 Context View API | **New**: a `ContextView` type + HTTP route over existing engine output |
| §11–§13 Tools | `CATALOG` + `environment.ts` probes + `presentation.ts` tones |
| §14 Multi-agent context | Fabric audit records + `changeIntelligence.recordChange` (needs persistence, S-2) |
| §15 Agent system prompt | **New**, but derive `AUTHORITATIVE_PREAMBLE`/`buildGroundingRules` from it |
| §16–§17 Context panel | `shell/RightPanel.tsx` + `verification.ts` + `confidence.ts` |
| §18 Ask AURA | The real `/stream` path used by `AiWorkspace`; delete the mock |
| §19 Command bar | `Command` type + `useCommands` + `CommandBar` |
| §20 Activity | Fabric `AuditRecord` + mission timeline + `notificationsStore` |
| §21 Mission | `mission/*` unchanged; no RUNNING state (do not fake it) |
| §22 Environment Map | Move `WorkspaceScreen` + `HubCanvas`/`HubSurface` behind a new nav key |
| §23 Real-time | Existing SSE + polling stores |
| §24 Security | `provider/credentialStore.ts` boundary; audit input redaction (`fabric.ts:109`) |
| §26 Diagnostics | `intelligence/verification.ts`, `getVersionStats`, `detectChanges` |

---

## 3. Genuine gaps (must be built)

1. **`ContextView` contract** — one normalized shape, versioned, with
   `contextVersion`, `status: synced|updating|stale|error`, `lastUpdated`,
   `source`, and per-section freshness. Nothing like it exists.
2. **A context service surface** — routes over the existing engine
   (`GET /projects/:id/context`, `.../context/view?intent=…`,
   `POST /projects/:id/context/refresh`, `GET .../context/diagnostics`).
3. **L5 tool context provider** — turn a probe result into a context slice.
4. **L6 durable event log** — persisted, project-scoped, agent-attributed.
5. **Live git context** — via `git.status`/`git.branch`/`git.diff` capabilities,
   replacing the mission-snapshot hack (S-1).
6. **Canonical AURA agent system prompt** + composition with a Context View.
7. **Context delivery into `agent.delegate`** — per-agent, verified.
8. **Project-first Workspace screen** + **Environment Map** nav key.
9. **Real Ask AURA on the dashboard** (replacing the mock).
10. **Secret-exclusion test** — §24 needs a test that proves no credential can
    enter a Context View. None exists.

---

## 4. Duplication risks to avoid in Phase 2

- **D-1 — two context assemblers.** `ai-service/src/intelligence/contextAssembler.ts`
  (live, intent-sliced, provider-bound) and `packages/retrieval/src/assembler/contextAssembler.ts`
  (`@aura/retrieval`, described as "frozen", consumed by `knowledge-coding` /
  `knowledge-fullstack` / `engineering-memory`). They are not the same thing:
  the retrieval one budgets and packages *documents*; the intelligence one
  composes *facts*. Phase 2 must pick the intelligence one as the Context
  Fabric authority and keep retrieval as its document supplier — writing a
  third would be the worst outcome.
- **D-2 — four project pointers** (P-1).
- **D-3 — two Ask AURA implementations** (U-2).
- **D-4 — node shapes.** `CatalogEntry` (catalogue), `EnvironmentNode` (UI),
  `NodeRef` (fabric routing). These are legitimately three views of one
  catalogue; a Context View must project from the catalogue, not introduce a
  fourth.

---

## 5. Findings that should change the plan

| # | Finding | Consequence |
| --- | --- | --- |
| C-1 | Intelligence engine has no external door | Phase 2 is *exposure*, not construction |
| C-2 | File-mtime index is global, not per-project | Fix before trusting incremental context |
| P-1 | Four project pointers | Phase 2 must include the collapse, or Phase 5 UX is unbuildable |
| U-1 | Dashboard Ask AURA is a mock | Must be replaced, and called out honestly |
| S-1 | Git branch comes from a stale mission snapshot | Live git via governed capabilities |
| S-2 | Audit log is in-memory | Persist before claiming multi-agent handoff (Phase 6) |
| A-1 | `agent.delegate` sends bare task text | The one seam for Phase 3 |
| A-2 | No canonical prompt; four inconsistent fragments | Author one, derive the rest |
| N-1 | `presentNodes` replaces on targeted scan (open bug) | Any per-tool re-probe in the new UX trips it |
| M-1 | No mission RUNNING state | Do not render "Status: Working" |

---

## 6. Proposed Phase 2 shape (for approval — not yet implemented)

1. `packages/ai-service/src/context/` — a thin **Context Fabric facade** over
   `intelligence/`, owning: `ContextView` types, layer assembly L0–L6,
   freshness/version resolution, and secret exclusion. It calls the existing
   engines; it does not re-implement them.
2. Per-project index state (fix C-2).
3. Tool context provider (L5) reading the existing scan.
4. Durable, project-scoped event log (L6) using `persist.ts`.
5. HTTP surface for context + diagnostics.
6. Tests: layer assembly, staleness transitions, version bump-on-change-only,
   per-project index isolation, and **secret exclusion**.

Everything above is additive and touches no policy, execution, routing,
catalogue, mission or approval code.

---

## 7. Safety note on the working tree

`git status --short` at audit time shows pre-existing user work in progress:
modified `Home.tsx`, `ScreenRouter.tsx`, `AiWorkspace.tsx`,
`ProjectWorkspace.tsx`, `RightPanel.tsx`, `appStore.ts`, `Cargo.toml`,
`ci.yml`, `tauri.conf.json`, `package.json`, plus staged release work
(`patch-appimage-linux.mjs`) and untracked handoff docs. **None of it was
touched.** The five modified UI files are exactly the files Phase 5 will need
to change — those edits must be read and preserved, never overwritten.

---

**Phase 1 complete. Stopping here for review before Phase 2.**
