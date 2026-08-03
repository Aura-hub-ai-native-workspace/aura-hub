# Automation Engine

## Purpose and Mission
The Automation Engine (AE) is AURA's event-driven workflow layer. It runs **real engineering workflows from real platform events** — no cron, no timers, no fake execution. When a mission completes, the AE runs the Diagnosis Engine. When files change, the AE updates the Knowledge Fabric. When a README changes, the AE reviews documentation. When a PR merges, the AE audits architecture. When a dependency changes, the AE runs a security review. When a mission task is accepted, the AE writes engineering memory.

Every execution is a first-class, persistent record: a **rule** declares *when* (trigger), *if* (conditions), and *what* (action chain with retries). Every run writes an immutable **timeline** with per-action states (`pending/running/retrying/completed/failed/skipped`), a queue of events per rule (events that arrive while a rule is executing are queued, not dropped), and lifecycle statuses (`queued/running/paused/retrying/completed/failed/cancelled`). Nothing is invented — actions call the exact same public engines the rest of AURA uses, and every human safety gate (accept-before-write) is preserved.

### Key Responsibilities
- **Trigger matching**: deterministic dispatch of platform events (`mission-completed`, `mission-accepted`, `diagnosis-completed`, `diagnosis-accepted`, `file-changed`, `readme-changed`, `dependency-changed`, `pr-merged`) to enabled rules.
- **Conditions**: data-driven predicates over the event payload (`equals/not-equals/exists/not-exists/contains/not-contains/in/matches-regex/gt/gte/lt/lte`) with dot-path access.
- **Chains**: ordered, composable action lists with `continueOnError` semantics and per-action retry policies (maxAttempts, exponential backoff).
- **Persistence**: atomic, crash-safe JSON storage for rules, runs, and manifest snapshots under `~/.aura/automation/`.
- **Runtime control**: pause/resume per rule, cancel per run, FIFO queueing per rule, AbortSignal cancellation of in-flight actions.
- **Observability**: run timeline, execution history, and a live SSE stream of run events for the UI / AI chat.
- **Visual builder**: templates expose the full rule shape (trigger, conditions, chain, retries) so the UI can instantiate and edit them as a workflow.

---

## Modules and Responsibilities

### `packages/automation/src/persist.ts`
Self-contained persistence helpers: `configHome()` (`AURA_HOME` or `~/.aura`), `homePath(...parts)`, `readJsonFile`, and atomic `writeJsonFile` (temp file + rename). No package dependencies — each package owns its own storage layout.

### `packages/automation/src/types.ts`
The complete public type surface:
- `AutomationTriggerType` — the eight real platform moments.
- `AutomationEvent` — `{ type, projectId, projectPath, at, payload }`.
- `ConditionOp` / `Condition` / `ConditionEvaluation` — the predicate DSL.
- `AutomationActionType` — `run-diagnosis`, `run-governance-audit`, `run-security-review`, `run-docs-review`, `update-knowledge`, `save-memory`.
- `RuleAction` (+`continueOnError`), `RetryPolicy`, `AutomationRule`, `AutomationRun`, `AutomationRunSummary`.
- `RunStatus` (`queued/running/paused/retrying/completed/failed/cancelled`), `RunActionStatus` (`pending/running/retrying/completed/failed/skipped`), `ActionRunState`, `RunTimelineEntry`, `TimelineType`.
- `ActionCtx` / `ActionResult` / `ActionHandler` — the injected-action seam.
- `genId(prefix)`.

### `packages/automation/src/store.ts`
`AutomationStore` — filesystem-backed CRUD.
- Rules: `~/.aura/automation/rules/<id>.json` (`listRules` sorted by `updatedAt` desc, `getRule`, `createRule`, `saveRule`, `removeRule`).
- Runs: `~/.aura/automation/runs/<ruleId>/<id>.json` (`listRuns(ruleId?)` scans run dirs, `getRun`, `createRun`, `saveRun`).

### `packages/automation/src/engine.ts`
`AutomationEngine` — the state machine.
- `handleEvent(event)` — match all enabled rules, queue an event per rule (FIFO via a `running` map so simultaneous events never clobber), return the first created run.
- `runRuleNow(ruleId, event)` — synchronous trigger/condition evaluation + chain execution (used by the manual "Run now" endpoint).
- `ruleMatches` — returns the full `ConditionEvaluation[]` for transparency.
- Chain execution with per-action retry (`maxAttempts`/`delayMs`/`backoffFactor`), config interpolation of `{{payload.x}}`, timeline appends + atomic saves + `emit`, AbortSignal propagation.
- Control API: `pauseRule` / `resumeRule` / `cancelRun` / `activeRules`.

### `packages/automation/src/templates.ts`
Six built-in, runnable templates, each mapping a real trigger to a real action chain:
1. `mission-completed-run-diagnosis` — Mission completed → run diagnosis.
2. `file-changes-update-documentation` — File changes → update knowledge graph.
3. `readme-changes-review-docs` — README changes → review documentation.
4. `pr-merged-architecture-audit` — PR merged → architecture audit.
5. `new-dependency-security-review` — New dependency → security review.
6. `mission-accepted-generate-engineering-memory` — Mission accepted → engineering memory (interpolates `{{payload.task.title}}` / `{{payload.mission.text}}`).

`instantiateAutomationTemplate(id)` returns a fully-configured rule definition.

### `packages/automation/src/triggers.ts`
Real event sources (no polling — the host calls these when it has a reason):
- `detectChangedFiles` — `git status --porcelain`; `readmeChanged` regex on README/CHANGELOG/docs paths.
- `detectMergedPrs` — `git log --merges`.
- Manifest snapshot/diff for `package.json`, `cargo.toml`, `pyproject.toml`, `go.mod`; `persistDependencySnapshot` stores snapshots under `~/.aura/automation/manifest-snapshots/` and returns `{added, removed, changed}` + `first`.
- Event builders: `buildEvent`, `fileChangeEvent`, `dependencyChangeEvent`, `prMergedEvent`.
- `createTriggerScanner(roots)` — no background polling; the host drives `scan(projectPath)` / `scanAll()`.

### `packages/ai-service/src/automation.ts`
The **only** place that binds real action handlers:
- `createAutomationRuntime(host, emit?)` — injects handlers that call the real engines:
  - `run-diagnosis` → `runDiagnosis(pipeline, memory, diagnoses, root, …)`; requires a `filePath` in config or event payload; leaks `DiagnosisEvent`s.
  - `run-governance-audit` → `getEngineeringAudit({ projectPath, scope })` (scope narrowed to weekly/release/architecture, else daily).
  - `run-security-review` → `getSecurityReport` (summarizes `findings.length`).
  - `run-docs-review` → `getDocumentationHealth` (summarizes `issues.length`).
  - `update-knowledge` → `pipeline.fullstack.update()` when mounted, else a fresh `FullStackKnowledgeEngine(root, { indexDir: homePath('index', projectId, 'fullstack') })` (uses `GraphDelta.filesAdded/filesModified/filesDeleted`).
  - `save-memory` → `host.memoryFor(projectId).add({...})`.
- `automationEvent(type, projectId, projectPath, payload)` — event factory for hosts.
- `subscribe(fn)` on the runtime — fan-out for the SSE stream.

---

## Integration Points

| Real moment | Where emitted | Who handles it |
| --- | --- | --- |
| `mission-completed` | `WorkspaceManager.runMissionBatch` after execution reaches `completed` (payload includes the last accepted task's `filePath`) | Diagnosis template |
| `mission-accepted` | `WorkspaceManager.acceptMissionTask` after the write | Memory template |
| `diagnosis-completed` | `WorkspaceManager.runDiagnosis` after orchestration | user rules |
| `diagnosis-accepted` | `WorkspaceManager.acceptDiagnosis` after the write | user rules |
| `file-changed` / `readme-changed` / `dependency-changed` / `pr-merged` | host calls `detectChangedFiles` / `detectMergedPrs` / `persistDependencySnapshot` and pushes the built event | doc/knowledge/governance templates |

The host (`WorkspaceManager`) wires the runtime via `initAutomation()`: `projectPath` from the project registry, `pipelineFor` → the mounted pipeline, `memoryFor` → per-project memory, `diagnoses` → the shared diagnosis store.

---

## HTTP Surface (`packages/ai-service/src/server.ts`, `/automation`)

| Route | Method | Purpose |
| --- | --- | --- |
| `/automation/templates` | GET | List templates (id, name, description, category). |
| `/automation/events` | POST | Push a real event (`{type, projectId, payload}`). |
| `/automation/events/stream` | GET | SSE stream of `AutomationRunEvent`. |
| `/automation/rules` | GET/POST | List / create (by `template` id or raw rule). |
| `/automation/rules/:id` | GET/PUT/PATCH/DELETE | Read / save / patch / remove a rule. |
| `/automation/rules/:id/run` | POST | Manual run (`{projectId, payload}`). |
| `/automation/rules/:id/pause` / `resume` | POST | Pause / resume a running rule. |
| `/automation/rules/:id/runs` | GET | Run history for the rule. |
| `/automation/rules/:id/runs/:runId` | GET | Full run record (timeline, action states). |
| `/automation/rules/:id/runs/:runId/cancel` | POST | Cancel a run. |

---

## Design Constraints
- **No cron/timers**: events come only from real platform moments; the host decides when to scan git/workspace state.
- **No fake execution**: every action calls the real engine behind its public seam; failures are recorded as run failures with retries, never silently faked.
- **Safety gates preserved**: `run-diagnosis` requires a real `filePath` (config or event payload); `save-memory` writes through `ProjectMemory`; knowledge updates use the mounted engine when available.
- **Persistence is canonical**: the timeline/status in `~/.aura/automation/runs/` is the source of truth — the UI and AI chat read from it.
- **Determinism**: trigger match is a strict type + coarse-match comparison; conditions are pure functions of the payload.
