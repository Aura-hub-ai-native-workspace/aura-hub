# AURA — Mission Control v3 (Execution Engine)

> Internal architecture reference for the execution half of Mission
> Control. Describes systems that **exist and run today**. Every claim
> cites a real path in `packages/ai-service/src/mission/execution/`.
> If a future engineer cannot find the referenced file, the claim is
> wrong — fix the document, not your assumptions.

---

## 1. What v3 adds over v2

v2 (`ENGINEERING_INTELLIGENCE_PLATFORM.md` §6) could plan, approve, and
execute one task at a time, but it did **not** model the *shape* of the
work: task ordering was whatever the planner happened to emit, there
was no notion of dependencies, batching, critical path, or progress,
and the UI could only ever say "no fake progress."

v3 keeps every guarantee of v2 and adds a real execution model on top:

| Concern | v2 | v3 |
|---|---|---|
| Task ordering | planner emit order | **DAG**: deterministic auto-ordering (dependencies → waves) |
| Dependencies | declared, ignored | enforced: blocked/waiting/queued states |
| Failure isolation | n/a | `blocked` = a hard-failed dependency |
| Progress | "refresh signals, measure twice" | engine-derived metrics from real states |
| Critical path | n/a | longest-duration chain, surfaced + highlighted |
| Checkpoints | plan + per-task gates | 4 gates: **planning → execution → review → completion** |
| Replay | n/a | frame-per-mutation timeline (capped 4000) |
| Dashboard | n/a | global aggregate across every project |

The two **human gates are byte-for-byte unchanged**: the whole plan
must be explicitly approved before any task can run, and a proposal
is only ever written to disk after an explicit per-task **Accept**.
v3 automates *ordering* and *proposal generation* — never *acting*.

---

## 2. Where it lives

```
packages/ai-service/src/mission/
├── execution/
│   ├── types.ts        execution domain types (state machine, DAG, metrics,
│   │                   timeline, activity, replay, SSE events)
│   ├── dag.ts          buildDag / runnableTaskIds / orderTasks
│   ├── metrics.ts      computeMetrics — all counts derived from real states
│   ├── checkpoints.ts  emptyCheckpoints / setCheckpoint / statusFromCheckpoints
│   ├── replay.ts       captureFrame (MAX_FRAMES = 4000), progressOf
│   ├── engine.ts       MissionExecutionEngine — the state machine
│   └── index.ts        barrel
├── types.ts            MissionRecord.execution?: MissionExecution  (additive)
├── store.ts            hydrationEngine — hydrates v2 records on read
└── workspace.ts        WorkspaceManager.missionEngine(id, signal?, emit?)
                        + the public API surface (approveMission, runMissionTask,
                        acceptMissionTask, startMissionExecution, runMissionBatch, …)
```

The engine **imports planning types, never planning modules**. It
consumes only the already-computed `MissionRecord.goalGraph.tasks`.
`mission/types.ts` re-imports the execution types **type-only**, so
there is no import cycle.

---

## 3. The state machine

### 3.1 Task runtime states (`ExecutionTaskStatus`)

```
queued    waiting    blocked    running    paused    review
completed rejected    cancelled  retrying   failed   rollback
```

Derived from the plan's own `TaskStatus` via `PLANNING_TO_RUNTIME`:

| Planning (v2) | Runtime (v3) |
|---|---|
| `pending` | `queued` / `waiting` / `blocked` (propagated) |
| `proposed` | `review` |
| `accepted` | `completed` |
| `rejected` | `rejected` |
| `error` | `failed` (a `proposal.error` present) |

`engine.ts#apply()` is the single propagation pass: any task whose
dependency hit a hard terminal state (`failed`/`rejected`/`cancelled`)
becomes `blocked`; whose dependencies are all `completed` becomes
`queued`; otherwise `waiting`.

### 3.2 Execution status (`ExecutionStatus`)

`idle → approved → running ⇄ paused → reviewing → completed`, plus
`cancelled` / `failed`. `statusFromCheckpoints` derives status from
the checkpoint gates on read (`refreshStatus`), and deliberately
**skips terminal statuses** (`completed`/`cancelled`/`failed`) so a
read can never "un-complete" a mission.

### 3.3 Checkpoints (`CheckpointKey`)

`planning → execution → review → completion`, each with
`not-started / pending / passed / failed / skipped`.

- `planning` passes on **Approve Plan** (human).
- `execution` becomes pending on **Start Execution**, passed on
  completion.
- `review` opens when every task resolves
  (`engine.ts#maybeComplete` → `status: 'reviewing'`) and needs an
  explicit **Pass Review** (human). A failed review leaves the review
  checkpoint `failed` and keeps the mission in a state the human must
  revisit — nothing auto-resumes.
- `completion` passes only after review passes.

### 3.4 What the engine will NOT do

- Run any task unless `execution.status === 'running'`.
- Run a task whose dependencies aren't all `completed` (guarded by
  `runnableTaskIds`).
- Generate a proposal before the plan is approved.
- Write a single byte to disk — `acceptTask` only *records* the accept
  and flips the state; the write itself happens in the injected
  `runTask`/accept side effects wired by `workspace.ts`
  (`resolveInsideProject` + `fs.writeFileSync`), which also reindexes
  and writes the `accepted` memory entry.
- Accept a task that has no `proposed` run with real `newCode`.

---

## 4. The DAG (`dag.ts`)

`buildDag({ tasks, getRuntimeStatus })` is deterministic and pure:

- **Layers**: Kahn topological sort over real `task.dependencies`.
  Cycles are detected honestly (`hasCycle`/`cycle`), and tasks in a
  cycle are still placed in the first layer that satisfies their
  (acyclic) constraints — never silently dropped.
- **Batches**: `batch = depth` — the parallel wave index. A wave is
  exactly the set of tasks whose dependencies are all in earlier waves.
- **Priority tie-breaks** give a stable order inside a wave.
- **Critical path**: the longest-duration chain through the graph
  (`criticalPath`, `criticalDurationMinutes`) — the answer to "what
  must finish on time for the mission to finish."
- **Block edges**: pairs on the critical path whose chain contains a
  high-risk task become explicit `kind: 'block'` edges so the UI can
  draw the risk literally, not just as a color.
- `runnableTaskIds` returns the current ready set; `orderTasks`
  returns the full auto-order used for the initial `batches`.

Because layout is deterministic, the Workflow Canvas draws the same
plan identically every time — the client runs its own Sugiyama-lite
layering only to *position* nodes; the graph structure is the server's
DAG verbatim.

---

## 5. Metrics (`metrics.ts`)

`computeMetrics` counts only real states: `tasksQueued/Waiting/Blocked/
Running/Review/Completed/Rejected/Failed/Cancelled`, `completion`
(0–1), critical-path progress (`criticalPathDone/Total`), wave index
(`currentBatch`, `parallelBatches`), and time estimates
(`elapsedMinutes`, `estimatedRemainingMinutes`, `throughput`). No
number is invented; every count is a `Object.values(statuses)` tally.

---

## 6. Replay (`replay.ts`)

Every `apply()` pass appends one `ReplayFrame` — a snapshot of
`{executionStatus, taskStates, checkpointStates, batchIndex}` plus
`completedCount/totalTasks`. Frames are capped at `MAX_FRAMES = 4000`
(oldest dropped), so a pathological mission cannot grow unbounded.
The client scrubs these frames to re-trace exactly what the engine
did — the same frames feed the Engineering Dashboard's "live" feel
and the per-mission Replay tab.

---

## 7. Engine wiring (`workspace.ts`)

`WorkspaceManager.missionEngine(id, signal?, emit?)` constructs a
`MissionExecutionEngine` with real side effects injected:

| Hook | Real implementation |
|---|---|
| `runTask` | `generateTaskProposal(...)` (the same proposal generator as v2 — one LLM call, returns proposal, writes nothing) |
| `persist` | `this.missions.save(record)` — atomic JSON write under `~/.aura/missions/<projectId>/<id>.json` |
| `emit` | SSE `ExecutionEvent` broadcast (the `/execute` stream) |

Public methods: `runMissionCreation`, `approveMission`,
`rejectMission`, `runMissionTask`, `runMissionBatch`, `acceptMissionTask`
(write + reindex + memory), `rejectMissionTask`, `completeManualTask`,
`startMissionExecution`, `pauseMissionExecution`,
`resumeMissionExecution`, `cancelMissionExecution`, `retryMissionTask`,
`reviewMissionCheckpoint`, `getMissionReplay`, `missionDashboard`.

Server routes (`server.ts`): `POST .../missions/:mid/{start|execute|
pause|resume|cancel|review|replay}` and
`POST .../tasks/:taskId/{run|accept|reject|complete|retry}`, plus the
global `GET /missions/dashboard` (checked before the project-scoped
`missions` segment). The `/execute` route streams `ExecutionEvent`s
over SSE (`data:`/`[DONE]` framing) so the UI stays live while
proposals generate.

`store.ts` carries a `hydrationEngine` whose `runTask` returns
`{ok:false}` — v2 records (or any read after a crash) are hydrated
into a valid v3 execution block on read without ever attempting side
effects.

---

## 8. Client + UI

- `apps/desktop/src/ai/missionClient.ts` mirrors every execution type
  and adds `approve/reject/start/pause/resume/cancel/review/replay/
  dashboard/runTask/acceptTask/rejectTask/completeManualTask/retryTask`
  plus the SSE streaming `execute(projectId, mid, onEvent, opts)`.
- `apps/desktop/src/screens/missions/useMissions.ts` rewires the hook
  to the engine: `runBatch` streams `/execute` and patches
  `active.execution` per event; `loadReplay` pulls `ReplayFrame`s.
- Screens: `MissionControl` (rail + filters), `MissionDetail`
  (execution header, wave stepper, checkpoint gates, tabs: Overview /
  Tasks / Canvas / Timeline / Activity / Replay), and the components
  `WorkflowCanvas`, `TaskList`, `MissionTimeline`, `ActivityFeed`,
  `CheckpointPanel`, `MissionReplay`.
- `apps/desktop/src/screens/EngineeringDashboard.tsx` renders the
  global `GET /missions/dashboard` aggregate; a new top-level
  `NavKey: 'dashboard'` wires it into the shell.

Every number shown derives from `MissionExecution` state — the same
"no fake progress" law from v2 now extends to execution itself: the
percentages, wave counts, and critical-path numbers are tallied from
real states, not fabricated.
