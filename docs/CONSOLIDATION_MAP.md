# Consolidation Map — Connected Environment → existing AURA architecture

> Written **before** any deletion, as required. Every abstraction created on
> `feature/connected-environment-v2` is mapped to its existing AURA equivalent
> and given one of four verdicts:
>
> | Verdict | Meaning |
> |---|---|
> | **DUPLICATE** | An existing AURA module already does this, as well or better. Delete. |
> | **DUPLICATE + GAP** | Existing module covers most of it; a specific behaviour is genuinely missing and is preserved by integrating into the existing architecture. |
> | **KEEP** | No existing equivalent. Survives into the Capability Fabric. |
>
> Nothing is deleted for looking duplicated. Each **DUPLICATE** verdict below
> cites the file, the mechanism, and why the incumbent is at least as strong.

---

## 1. Authoritative models after consolidation

| Concern | Authoritative owner | Status |
|---|---|---|
| Mission state | `MissionRecord` — `packages/ai-service/src/mission/types.ts:278` | **Sole owner** |
| Execution DAG / batches / critical path | `ExecutionDag` — `mission/execution/types.ts:102`, built by `mission/execution/dag.ts:73` | **Sole owner** |
| Task runtime state machine | `ExecutionTaskStatus` (11 states) — `mission/execution/types.ts:38` | **Sole owner** |
| Human gates | `CheckpointState` + `MissionApproval` — `mission/execution/types.ts:56`, `mission/types.ts:273` | **Sole owner** |
| Observability | `TimelineEntry` / `ActivityEntry` / `ReplayFrame` / `MissionMetrics` | **Sole owner** |
| Risk vocabulary | `TaskRisk = 'low' \| 'medium' \| 'high'` — `mission/types.ts:184` | **Reused verbatim** |
| Automation intent | `AutomationLevel = 'automatic' \| 'assisted' \| 'manual'` — `mission/types.ts:178` | **Reused verbatim** |
| Workflow execution | `WfNodeType` + `workflow/engine.ts` | **Sole owner of workflow runs** |
| Safe process execution | `safeShell()` / `git()` — `workflow/nodes.ts:71,83` | **Sole owner of process spawn** |
| Internal capability surface | `WorkspaceManager` — `ai-service/src/workspace.ts` | **Sole facade** |

---

## 2. Module-by-module mapping

### 2.1 `promptIntelligence.ts` → **DUPLICATE + GAP**

**Existing equivalent:** `mission/intentClassifier.ts` (Stage 1) + `mission/intentExtraction.ts` (Stage 2).

| My implementation | Incumbent | Assessment |
|---|---|---|
| `detectIntent()` — 9 intents, substring counting, no tie-break | `classifyIntent()` — 14 categories, one regex set per category, counts **distinct** patterns so repetition cannot inflate a match, honest `'unknown'` outcome | Incumbent is strictly stronger |
| `BriefEnricher` — interface, never implemented | `intentExtraction.ts` — real LLM call, constrained **in code** to the deterministic candidate list (`resolveCategory`) so the model can re-rank but never invent | Incumbent is real; mine was a stub |
| `EnrichedBrief.stack/features/surfaces` | `ExtractedIntent.targetComponents` + `MissionSignals` (derived from real repo scan) | Incumbent derives from the actual project, not from keywords in the prompt |

**Verdict: DELETE.** The incumbent classifies more categories, more rigorously, and is already wired to a real model behind a code-enforced constraint.

**Genuine gap preserved:** `ExtractedIntent` has no `assumptions`, `openQuestions`, or `requiredCapabilities`. The first two are real product behaviour worth keeping ("show what was filled in for you"); the third is the bridge the Fabric needs.

**How it is integrated:** as a *deterministic, additive annotation* computed from the existing `ExtractedIntent` + `MissionSignals` + `GoalGraph` — `capability-fabric/src/missionCapabilities.ts`. It reads the incumbent's output and adds fields; it does **not** edit the mission engine's LLM prompt contract, does not re-classify, and introduces no second intent model.

---

### 2.2 `missionPlanner.ts` → **DUPLICATE**

**Existing equivalent:** `mission/strategies.ts` (Stage 4) + `mission/goalGraph.ts` (Stage 5) + `mission/taskGen.ts` (Stage 6).

| My implementation | Incumbent | Assessment |
|---|---|---|
| `PlanBuilder` with hard-coded `after` keys | Category-specific strategy scaffolds (192 lines) feeding a goal graph builder (244 lines) | Incumbent varies plan *structure* by category; mine varied only which tasks were included |
| `MissionTask` — label/detail/phase/agent/requires/dependsOn | `MissionTask` — goalId, focusAreaId, kind, targetFile, mode, priority, dependencies, estimatedDurationMinutes, **confidence**, risk, owner, automationLevel, status | Incumbent carries confidence, duration estimates, ownership and automation level; mine carried none of these |
| 10 fixed phases | Goals → focus areas → tasks, derived per mission | Incumbent is not a fixed template |

**Verdict: DELETE.** A second planner producing a second task type is exactly the duplicated state §8.9 forbids.

**Genuine gap preserved:** tasks carry no capability requirement. Preserved as a sidecar projection keyed by existing task id (see §3), not as a new task type.

---

### 2.3 `orchestrator.ts` → **DUPLICATE**

**Existing equivalent:** `mission/execution/dag.ts` + `mission/execution/engine.ts` (520 lines).

| My implementation | Incumbent | Assessment |
|---|---|---|
| `levelTasks()` — naive level assignment, no ordering within a level | `topoSort()` — Kahn's algorithm with priority tie-breaking for deterministic order | Incumbent is deterministic and priority-aware |
| `waves[]` | `ExecutionDag.batches[]` — same concept, plus `depth` per node | Identical concept, incumbent richer |
| — | `criticalPath` + `criticalDurationMinutes` (longest-duration chain) | Missing from mine entirely |
| — | `block` edges for high-risk dependency chains | Missing from mine entirely |
| `hasCycle` → emit remainder as final wave | `hasCycle` + `cycle[]` identifying the members | Incumbent identifies the cycle |
| `reconcileTaskStates()` — 5 states | `ExecutionTaskStatus` — 11 states incl. `retrying`, `rollback`, `paused`, `review` | Incumbent models failure and recovery; mine did not |
| `missionProgress()` | `MissionMetrics` — throughput, critical-path progress, estimated remaining | Incumbent is a superset |

**Verdict: DELETE.** Mine was a strictly weaker re-implementation of the same algorithm.

**Genuine gap preserved:** late-bound routing of a task to a *node that provides a capability*. This is not scheduling — it is a separate question the incumbent never asks — and it moves into the Fabric's `resolveExecutor()`.

---

### 2.4 `agents.ts` → **KEEP (reduced)**

No existing agent-role registry. `MissionTask.owner` is only `'ai' | 'human'`. The 14 specialist roles remain useful as *accountability labels* on fabric invocations.

**Reduced:** the roles no longer drive scheduling (the incumbent DAG does that). They are metadata only.

---

### 2.5 `capabilities.ts`, `catalog.ts`, `registry.ts`, `resolver.ts`, `language.ts` → **KEEP**

No existing equivalent anywhere in the repository:

- No capability vocabulary exists. `WfNodeType` is a closed union of *workflow node types*, not a capability taxonomy, and it cannot express "this needs somewhere to deploy".
- No catalog of external systems exists.
- No node identity / health / permission model exists.
- No tool-discovery or ranking exists.
- No centralized user-facing state phrasing exists.

These become the Capability Fabric's registry side.

---

### 2.6 Desktop UI → **PARTIAL DELETE**

| File | Verdict |
|---|---|
| `MissionComposer.tsx`, `MissionBoard.tsx` | **DELETE** — they render the deleted mission model. Mission Control (`screens/missions/`) is the mission surface. |
| `GapPanel.tsx`, `NodeCard.tsx`, `NodeInspector.tsx`, `ConnectedEnvironment.tsx`, `presentation.ts`, `windows/` | **KEEP** — environment/node surfaces, no mission-model dependency after rewiring |
| `environmentStore.ts` | **KEEP (reduced)** — mission/plan/preview state removed; node state retained |

---

## 3. The sidecar decision, and why it is not a new abstraction layer

The one thing the incumbent genuinely cannot express is *which capability a task
needs and where it may run*. Two ways to add it:

1. **Edit `MissionTask`** — add `requires`, `policy`, `executionResult`.
2. **Sidecar projection** keyed by existing task id.

Option 1 is the truest single model but edits a shipping, human-gated engine and
its persisted records. Option 2 was chosen **only because the mission engine
already persists `MissionRecord` to disk** and adding required fields would break
records written by earlier versions.

The sidecar is not a parallel mission model. It holds no task list, no ordering,
no status, and no lifecycle. It is `Map<taskId, CapabilityBinding>` — derived,
never persisted, discarded when the mission ends. If the persistence concern is
resolved later, it collapses into `MissionTask` with no other change.

---

## 4. Proof obligation

After consolidation the branch must show:

- exactly one type named `Mission*` describing mission state (`MissionRecord`)
- exactly one DAG/batch builder (`mission/execution/dag.ts`)
- exactly one process-spawn path (`workflow/nodes.ts` primitives, wrapped)
- zero remaining imports of the deleted modules

Verified in `docs/CAPABILITY_FABRIC.md` §Validation.
