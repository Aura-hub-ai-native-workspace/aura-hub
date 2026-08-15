# AURA Capability Fabric

> The single governed path by which anything in AURA Hub causes a side effect.
>
> Branch: `feature/autonomous-connected-environment`
> Consolidation record: [CONSOLIDATION_MAP.md](./CONSOLIDATION_MAP.md)

---

## 1. Architecture discovered

The audit changed the design more than any other input. AURA Hub already had far
more of the target architecture than the brief assumed.

| Already existed | Where | Consequence |
|---|---|---|
| 9-stage mission planner (deterministic classify → LLM extraction constrained to deterministic candidates → strategy → goal graph → tasks → risk → quality → review) | `ai-service/src/mission/` | **Do not build a planner** |
| Mission Control v3 execution engine: Kahn topological sort, parallel batches, critical path, cycle detection, 11-state task machine, checkpoints, timeline, activity feed, replay frames, metrics | `mission/execution/` (520-line engine) | **Do not build an orchestrator or a DAG** |
| Workflow engine with real action nodes incl. allow-listed shell, git status/diff/commit/branch, bounded HTTP | `ai-service/src/workflow/` | **Do not build a process executor — wrap the existing one** |
| Autonomous Engineering Agent: observe → reason → plan → propose → human-approve → execute → verify → learn | `desktop/src/ops/agentEngine.ts` | A working agent loop already exists |
| `WorkspaceManager` — one facade over projects, conversations, memory, missions, diagnosis, knowledge, providers, workflows, governance | `ai-service/src/workspace.ts` | **This is the internal control plane** |
| Automation engine, Engineering Memory, Learning Engine, Governance, Predictive, Knowledge Fabric | `packages/*` | Capabilities to expose, not rebuild |

**What genuinely did not exist:** a capability vocabulary, a node/health model, tool
discovery, a risk-classified policy engine, an approval gate, closed-loop
verification, bounded recovery, a typed event surface, and an audit trail.

That gap is exactly the Fabric.

---

## 2. Old architecture limitations

1. **Effects were ungoverned.** The workflow engine's allow-list was the only
   control, and it was binary: on the list or not. There was no notion of risk, no
   configurable decision, no authorization record, and no audit.
2. **No capability indirection.** `WfNodeType` is a closed union of workflow node
   types. Nothing could express "this step needs somewhere to deploy" and let the
   environment answer.
3. **Verification was per-engine, not per-action.** Mission Control verifies tasks;
   nothing verified that a *command* did what it claimed.
4. **AURA's own capabilities were unaddressable.** `WorkspaceManager` methods were
   reachable only from hand-written HTTP routes — an agent could not discover
   "what can I do here".
5. **Recovery was ad-hoc.** No retry classification, no backoff, no bound.

---

## 3. New architecture

```
  User / Chat
       │
  Mission Control v3        ← owns missions, planning, approval checkpoints
       │                       (MissionRecord — the ONLY mission model)
  ExecutionDag              ← owns ordering, batches, critical path
       │                       (the ONLY DAG)
  ┌────▼──────────────────────────────────────────────────┐
  │  CAPABILITY FABRIC                                     │
  │                                                        │
  │   resolve → policy → approval → execute →              │
  │   verify → recover → audit                             │
  │                                                        │
  │   no missions · no task graph · no scheduling          │
  └────┬──────────────────────────────────────────────────┘
       │
  ┌────▼───────────────┬──────────────────────┐
  │ Internal capability │ External node        │
  │ (WorkspaceManager)  │ (@aura/connected-env)│
  └────┬───────────────┴──────────┬───────────┘
       │                          │
  exec/process (one spawn path) · fetch
       │
  Verification → result → audit record
```

`missionId` / `taskId` on an invocation are **correlation keys** into the
authoritative `MissionRecord`. The Fabric never holds mission state.

---

## 4. Execution model — the seven steps

Every invocation runs all seven, in order, with no way to skip one.

| Step | What happens | Failure mode |
|---|---|---|
| **resolve** | Look up the descriptor; validate arguments against the declared contract | `failed` / `invalid-input` |
| **policy** | Hard floors → permission scopes → capability override → autonomy switch → risk default | `denied` |
| **approval** | Batched authorization request; grant is per-invocation and never outlives it | `awaiting-approval` |
| **execute** | The one registered executor, or honest `unsupported` | `failed` / `unsupported` |
| **verify** | Read-back / exit-code / HTTP-status, where one exists | `unverified` |
| **recover** | Bounded retry with exponential backoff, transient failures only | `failed` after 3 |
| **audit** | Immutable record: actor, decision, rule, outcome, verification, duration | — |

---

## 5. Permission and policy system

**Decisions:** `auto-execute` · `ask-user` · `require-approval` · `deny`
**Risk vocabulary:** `low | medium | high` — deliberately identical to Mission
Control's `TaskRisk` so planned risk and actual risk speak one language.

Evaluation order is the security argument. **No configuration can reach the hard
floors** — they are checked first and return early. Within the configurable
layers, an override can only escalate the risk default, never relax it.

One honest qualification: `byRisk` itself *is* the user's dial and can be set
lower than shipped (`high: 'auto-execute'` is a legal, if unwise, choice). What
that cannot do is make an irreversible, destructive or account-authorizing action
run unattended — those are floors, and they hold regardless. Verified against a
deliberately hostile policy file in §11.

1. **Hard floors** (not configurable): no provider → deny · missing scope → deny ·
   irreversible → require-approval · destructive → require-approval ·
   account authorization → require-approval
2. **Configurable layers**, each able only to escalate: capability override →
   global autonomy switch → risk default

**A bug this ordering caught during implementation:** `account.authorize` and
`resource.destroy` are deliberately ungrantable by any node flag. The first draft
checked them in the permission step, which denied `provider.connect` outright and
made authorization impossible rather than gated. They are now excluded from the
grant check and handled only by the floors.

---

## 6. Verification engine

Verification is real where a read-back exists, and honestly absent otherwise.

| Capability | Check | Proven |
|---|---|---|
| `filesystem.write` | read the file back, compare bytes | ✅ read-back matched |
| `git.commit` | `git log -1 --pretty=%s` equals the message | ✅ |
| `git.branch` | `rev-parse --abbrev-ref HEAD` equals the target | ✅ |
| `terminal.execute` | exit code is 0 | ✅ |
| `http.request` | status in 200–399 | ✅ answered 200 |
| `git.status`, `git.diff`, `knowledge.graph`, … | none exists | reported `no-check`, never a pass |

A capability that declares a check but whose executor implements none reports
`passed: null` with an explanation — never a silent pass.

---

## 7. Recovery system

Bounded and classified. `MAX_ATTEMPTS = 3`, backoff `400ms · 800ms`.

Only genuinely transient failures retry (`timeout`, `ECONNRESET`, `ENOTFOUND`,
`EAI_AGAIN`, `429`, `503`, …). A permission error or a bad argument escalates
immediately — retrying it three times is noise, not resilience.

**A second bug found by validation:** the HTTP executor collapsed Node's nested
`cause.code` into a bare `"fetch failed"`, so genuinely transient DNS failures
never matched the classifier and never retried. Fixed; now measured at 3 attempts
over 1225 ms, versus 1 attempt for a non-transient exit code.

---

## 8. Security architecture

- **One spawn path.** `exec/process.ts` was extracted from `workflow/nodes.ts`
  (the only hardened implementation) and the workflow engine now imports it.
  Allow-listed binaries, no shell interpretation, bounded timeout and buffer,
  abortable.
- **Refusal before approval.** `parseCommand` is exported so the Fabric can refuse
  an unsafe command *before* asking a human to authorize it.
- **cwd is never caller-supplied.** The route resolves the working directory from
  the project registry, so no request can point execution at an arbitrary path.
- **Path traversal rejected.** Filesystem capabilities resolve inside the project
  root and refuse escapes.
- **Secrets redacted in audit.** Fields matching `apiKey|token|secret|password`
  are replaced before the record is written — verified 0 leaks across 19 records.
- **Approval cannot leak.** A grant lives on the invocation context, so authorizing
  one action never silently covers the next.
- **The service never self-approves.** It has no UI, so it returns
  `awaiting-approval` rather than granting.

---

## 9. Files

### Created
```
packages/capability-fabric/            @aura/capability-fabric
  src/types.ts        domain: descriptors, invocation, policy, approval, events, audit
  src/manifest.ts     31 capabilities — AURA internal + local + extension points
  src/policy.ts       risk classification, hard floors, configurable layers
  src/fabric.ts       the seven-step path, recovery loop, audit assembly
  src/missionCapabilities.ts  the two gaps preserved from the deleted planners
  src/index.ts

packages/ai-service/src/exec/process.ts    the single spawn primitive (extracted)
packages/ai-service/src/fabric/executors.ts 19 real executors
packages/ai-service/src/fabric/index.ts     host wiring: grants, availability, approval

apps/desktop/src/environment/fabricRequirements.ts   the core execution surface

docs/CONSOLIDATION_MAP.md    duplicate → incumbent mapping, written before deletion
docs/CAPABILITY_FABRIC.md    this document
```

### Modified
```
packages/ai-service/src/workflow/nodes.ts   now imports the shared spawn primitive
packages/ai-service/src/server.ts           /fabric/{capabilities,invoke,audit,mission/:p/:m}; scan feeds availability
packages/connected-environment/src/*        trimmed to registry scope
apps/desktop/src/environment/*              mission state removed from the store/screen
tsconfig.base.json, ai-service/package.json paths and deps
```

### Deleted (mapped first — see CONSOLIDATION_MAP.md)
```
connected-environment/src/missionPlanner.ts       → mission/strategies + goalGraph + taskGen
connected-environment/src/orchestrator.ts         → mission/execution/dag + engine
connected-environment/src/promptIntelligence.ts   → mission/intentClassifier + intentExtraction
desktop/src/environment/MissionComposer.tsx       → screens/missions/
desktop/src/environment/MissionBoard.tsx          → screens/missions/
```

### Intentionally untouched
`mission/`, `workflow/engine.ts`, `automation/`, `governance/`, `predictive/`,
`ops/agentEngine.ts`, `knowledge-*`, `engineering-memory/` — all working systems.
The only edit to a shipping engine was replacing two private spawn helpers in
`workflow/nodes.ts` with imports of the identical extracted code.

---

## 10. Single-authority proof

| Claim | Method | Result |
|---|---|---|
| One mission model | grep all `Mission*` type declarations | `MissionRecord` in `mission/types.ts` is the only mission-state model. `missionClient.ts` mirrors it as a **client DTO** — see limitation 1. `predictive`/`engineering-memory` `Mission*` types are different concepts (prediction context, memory record), not state. |
| One DAG | grep `buildDag` / `topoSort` / `batches` | Built only in `mission/execution/dag.ts`; other hits are consumers. |
| No orphan imports | grep deleted module names | **0 references** |
| One *governed* spawn path | grep `execFile`/`spawn` | The Fabric and the Workflow Engine share `exec/process.ts`. **10 pre-existing direct spawn sites remain** — see limitation 2. |

---

## 11. Validation performed

```
npm run typecheck     clean   (ai-service + desktop project references)
npm run build         clean   (31s; ConnectedEnvironment 60.86 KB / 16.17 KB gz)
```

Live service, real machine, 19 audit records:

| Scenario | Result |
|---|---|
| Read-only work runs unattended | `git.status`, `project.list`, `filesystem.list` → `auto-execute` / `succeeded` |
| A write is gated, then verified | no approval → `awaiting-approval`, nothing ran · approved → `succeeded` + read-back matched |
| Commands verified by exit code | `node --version` → verified · failing command → `failed`, no false pass |
| Unsafe commands refused pre-execution | `rm -rf /` → allow-list refusal · `ls; whoami` → operator refusal |
| Irreversible always authorized | `git.push` → `require-approval` via `irreversible-floor` even with autonomy on |
| Unimplemented capabilities say so | `github.create_repository` → `unsupported` · `browser.navigate` → `denied` (no provider) |
| Input contract enforced | missing argument and unknown capability both rejected before policy |
| AURA internals use the identical path | `knowledge.graph`, `memory.search` → same seven steps |
| Recovery bounded | transient → 3 attempts / 1225 ms · non-transient → 1 attempt |
| Audit integrity | every record carries actor + decision + rule; 0 secrets leaked |

Mission annotation (§15), against **real stored `MissionRecord`s**, not fixtures:

| Scenario | Result |
|---|---|
| Every task kind maps | a 9-task plan spanning `research`/`review`/`file-operation`/`documentation`/`manual-operation` and all three `mode` values → every task bound, no fallthrough |
| Risk escalates from the capability | `documentation` task planned `low` → bound `medium`, because `filesystem.write` is medium |
| A task needing nothing says so | `approval` → `requires: []`, keeps its own planned risk, rationale names Mission Control as the owner |
| Gaps name the blocked task | host with no `terminal.execute` executor → `{capabilityId, taskIds:['t2'], reason:'no-executor'}` |
| Unknown host ≠ everything missing | annotation without a `supported` set → `gaps: []`, not 6 false gaps |
| Unplanned mission degrades quietly | `goalGraph: null` → empty bindings, assumptions still derived from intent |

---

## 12. Capability status

**19 of 31 capabilities have a real executor.**

**IMPLEMENTED** — `filesystem.list/read/write`, `terminal.execute`,
`git.status/diff/branch/commit/push`, `http.request`, `project.list/create/open/inspect`,
`mission.inspect/approve`, `knowledge.graph`, `memory.search`, `governance.audit`

**ARCHITECTED, NOT EXECUTABLE** — `github.create_repository`, `github.create_pr`
(path: `gh` via the existing spawn primitive) · `browser.navigate/read/click/type/screenshot`
(path: Playwright) · `mission.create`, `mission.start`, `diagnosis.run`,
`workflow.run`, `provider.connect` (path: `WorkspaceManager` methods that exist but
are streaming/SSE and need an adapter)

Each reports `unsupported` at call time with its implementation path. None pretends.

---

## 13. Known limitations

1. **`MissionRecord` has a hand-maintained client mirror.** `missionClient.ts`
   redeclares the wire shape. One *authoritative* model, but two declarations that
   can drift. Pre-existing; fix is to share types from a common package.
2. **10 pre-existing direct spawn sites remain outside the Fabric** —
   `governance/core/git.ts`, `diagnosis/gitSignals.ts`, `mission/gitSignals.ts`,
   `graphify.ts`, `automation/triggers.ts`, `editor/aiContext.ts`, and three
   governance modules. All are read-only git/tooling helpers. "One governed path"
   is true of the Fabric and the Workflow Engine, **not yet of the repository**.
3. **The approval UI has no automated regression gate.** `npm run test:ui`
   exercises the rendered gate end to end (§18), but it is a script, not a
   suite: it needs the service and dev server already running, and it targets
   one known mission by id.
4. **Only two task kinds execute through the Fabric.** `review` and `research`
   run as capability calls (§16); `manual-operation` and `documentation` come
   back `unbound` because the plan contains no command and no content to write,
   and `file-operation` keeps its propose-then-accept flow. The *accept-write*
   of a file-operation does go through the Fabric.
5. **A gated task shows as `queued`, not "awaiting approval".** `TaskStatus` has
   no such member and adding one would change the persisted `MissionRecord`
   contract, so the task stays `pending`/`queued` — truthfully "hasn't run" —
   with the gate held in the Fabric's `ApprovalRequest`, a `checkpoint` timeline
   entry, and `awaitingApproval: true` on the run response. A UI that wants a
   distinct badge must read that flag rather than the task status.
6. **The task→capability mapping is coarse, and deliberately so.** It keys off
   `kind`, `mode` and `targetFile` only. A task whose description implies a
   network call is still bound to `filesystem.write` if that is its kind.
   Reading task *content* would mean a model call, which would make the
   annotation non-deterministic and put a second interpretation of the plan
   beside Mission Control's own.
7. **`gaps` is structurally empty today.** All six capabilities the mapping can
   emit have executors, so a real mission cannot currently produce a gap. The
   detection is verified against a restricted host (§11) rather than in
   production; it earns its place when the mapping grows to reach
   `github.*`/`browser.*`.
8. **Browser execution is an interface only.** No Playwright dependency was added —
   adding one is a real commitment that should be its own decision.
9. **`node.activity` is still never populated**, so live node progress renders
   nothing. `upsertActivity` is the documented entry point for when it is.
10. **Agent roles are labels, not actors.** There is no per-agent memory, no agent
   lifecycle and no inter-agent messaging. The `AgentRole` on an invocation is
   accountability metadata for the audit trail only.
11. **Node availability is discovered once, at boot.** A tool installed *while*
    the service is running stays invisible until the next `POST /environment/scan`
    or restart. There is no watcher.
12. **The annotation has no UI.** `/fabric/mission/:projectId/:missionId` returns
    it; no desktop surface renders it yet.

---

## 14. Next implementation phase

1. **Approval UI in the desktop** — the single change that makes medium/high-risk
   capabilities usable. The gate, the record and the batching already exist.
2. **Route Mission Control task execution through the Fabric** — so every mission
   task inherits policy, verification, recovery and audit.
3. **`gh` executors** for `github.create_repository` / `create_pr` — real, and
   reachable today through the existing spawn primitive.
4. **Bring the 10 remaining spawn sites under `exec/process`**, making the
   repository-wide claim true.
5. **Persist policy** and expose it in Settings.
6. **Browser executor** behind a deliberate Playwright decision.
7. **Render the mission annotation** — assumptions and open questions are the
   user-facing half of §15 and currently reach no screen.

---

## 15. Mission annotation — the gaps preserved from the deleted planners

`CONSOLIDATION_MAP.md` deleted three modules as duplicates and recorded two
behaviours inside them that were **not** duplicates and had to survive:

| Gap | Why the incumbent lacks it |
|---|---|
| `assumptions` / `openQuestions` | `ExtractedIntent` records what the user asked for, never what was filled in on their behalf. The user is never shown the difference. |
| per-task capability requirement | `MissionTask` says what a task is *for*, never what it *needs*. Nothing can route a task to something that provides a capability. |

`capability-fabric/src/missionCapabilities.ts` holds both, under four constraints
that keep it from becoming a second planner:

- **Additive.** It reads Mission Control's finished output and appends. It never
  re-classifies, re-plans or re-orders, and does not touch the mission engine's
  LLM prompt contract.
- **Deterministic.** No model call, so it is recomputed on request rather than
  persisted — which is what keeps `MissionRecord`'s on-disk shape unchanged
  (CONSOLIDATION_MAP §3).
- **Not a mission model.** No task list, no ordering, no status, no lifecycle.
  `CapabilityBinding` is keyed by an existing task id and discarded with the
  mission.
- **Structurally typed.** `IntentView` / `SignalsView` / `TaskView` declare only
  the fields read, so the package still does not depend on `ai-service`. The real
  mission types satisfy them with no casts — the typecheck is the proof.

The mapping, total over `TaskKind`:

| Task kind | Requires |
|---|---|
| `file-operation` · `new-file` | `filesystem.write` |
| `file-operation` · `diff` | `filesystem.read` → `filesystem.write` |
| `file-operation` · unresolved target | `filesystem.list` → `filesystem.read` |
| `documentation` | `filesystem.write` |
| `research` | `knowledge.graph` → `memory.search` |
| `review` | `git.diff` |
| `manual-operation` | `terminal.execute` |
| `approval` | *nothing* — a human gate Mission Control owns |

A binding's risk is the highest among its required capabilities, falling back to
the task's own planned risk when it needs none. This is the payoff for making
`RiskLevel` structurally identical to `TaskRisk` (§5): planned risk and
required-capability risk compare without translation, so a task planned `low`
that turns out to need a `medium` capability is visibly upgraded rather than
quietly under-stated.

---

## 16. Mission task execution through the Fabric

The read-only half of §15 states what a task *needs*. This is the half that
*acts*, and it closes limitation 4 of the previous phase.

### 16.1 The integration point

`MissionExecutionEngine` already declared its side-effect seam: `EngineHooks.runTask`,
injected by `workspace.ts`. Before this phase that hook did one thing — generate an
LLM proposal for a `file-operation` — and dead-ended everything else with
*"complete it manually"*. The Fabric was added **inside that hook**, which is why:

- `engine.ts` still owns ordering, the state machine, timeline, metrics and replay
- `dag.ts` is untouched — one DAG, still built in one place
- the propose→accept flow and the Workflow Engine are untouched
- no second executor registry exists; the Fabric's is the only one

```
runnableTaskIds(dag)              ExecutionDag        [unchanged]
  └─ engine.runOne(task)          state machine       [unchanged]
      └─ hooks.runTask                                ← the seam
          ├─ planTaskInvocation(task, projectId)
          │     └─ unbound → existing manual path, with a specific reason
          └─ fabric.invoke(cap, input, {missionId, taskId, approvedCapabilities})
                resolve → policy → approval → execute → verify → recover → audit
          ↓ InvocationResult
      └─ outcome mapped to an EXISTING TaskStatus
          └─ apply() → dag + metrics + replay frame   [unchanged]
```

### 16.2 Outcome → task state

| `InvocationOutcome` | `TaskStatus` | runtime | meaning |
|---|---|---|---|
| `succeeded` | `done` | `completed` | ran and, where checkable, verified |
| `unverified` | `error` | `failed` | ran; the read-back disagreed |
| `awaiting-approval` | `pending` | `queued` | **nothing ran**; still ready, so a grant resumes *this* task |
| `denied` | `rejected` | `rejected` | policy refused, rule recorded |
| `unsupported` / `failed` | `error` | `failed` | honest, with the reason |

`RunTaskResult` gained `status`, `detail` and `pending`. Every value it can carry
is an existing member of `TaskStatus` — the engine gained no states and remains
the only writer of them.

### 16.3 The accept-write, which was bypassing the Fabric

`acceptMissionTask` wrote proposals to disk with a bare `fs.writeFileSync` —
the most consequential action in the mission system, and the one place still
outside governance. It now goes through `filesystem.write`, so it is policy-checked,
**read-back verified**, recovered and audited. The operator's Accept is passed as
the per-invocation grant, because Accept *is* the authorization; without it the
write parks at `awaiting-approval` and nothing reaches disk.

### 16.4 What is deliberately not routed

`planTaskInvocation` refuses to invent arguments. A `manual-operation` task says
"fix the build" but carries no command line, and synthesising one would mean an
LLM deciding what to execute on the user's machine. Those tasks return `unbound`
with a specific next step and stay with the human — which is what they already did,
now with a reason instead of a shrug.

### 16.5 Validation — real mission, real service, real executors

Mission `hub-login-page/mission-ms99d6uv-1mr15w`, a real stored `MissionRecord`
(9 tasks, 5 task kinds), driven over HTTP against the live service.

| # | Case | Evidence |
|---|---|---|
| **A** | Automatic low-risk task | `research` → `memory.search` → `auto-execute` → **`done`**, rule `risk-default:low` |
| **B** | Approval required, nothing runs | `allowAutonomous:false` → `git.diff` → `awaiting-approval`, task stayed **`pending`**, HTTP 202 |
| **C** | Approval accepted resumes the SAME task | re-ran the same `taskId` with `approvedCapabilities:['git.diff']` → **`done`**; two audit records, one task |
| **D** | Approval declined | declined via `/reject` with a reason → task **`rejected`**, reason on the timeline and in decision memory |
| **E** | Verification determines success | Accept without a grant → parked, **file absent on disk**. Accept with grant → 129 bytes written, `verified=true`, task **`accepted`** |
| **F** | Verification failure | write truncated to 20 bytes, **real** read-back verifier → `unverified`, task stayed **`proposed`**, never accepted |
| **G** | Bounded recovery | transient `ECONNRESET` ×2 → **3 executor invocations / 1214 ms** → `done`. Control: non-transient → **1 invocation**, `error` |
| **H** | Unsupported capability | executor removed → task **`error`**: *"…is planned for but has no executor yet, so nothing was run"*. Separately, `manual-operation` → `unbound` with a specific next step |

A–E ran over HTTP against real infrastructure. F, G and H substitute exactly one
executor to produce a failure mode that cannot be summoned on demand — everything
else (service, `WorkspaceManager`, engine, Fabric, `MissionRecord`) is production code.

**Mission Control remained authoritative**, checked after all eight cases:

```
plan status vs taskRuns vs DAG node status — 9 tasks, 0 mismatches
metrics    tasksTotal 9 · completed 1 · review 2 · rejected 1 · queued 3
dag        9 nodes, 3 batches, critical path 3 — still built only in dag.ts
replay     72 frames; snapshots capture every Fabric-driven transition
timeline   75 entries / 75 activity entries
```

**A bug this validation caught:** `runTask` computed success as *"a proposal
exists and has no error"*. A Fabric-executed task completes without ever producing
a proposal, so the first working end-to-end run reported `ok:false` and HTTP 400
for a task that had genuinely succeeded. Success is now read from the task's
resolved status.

---

## 17. Control surfaces — approval UI, persisted policy, decision audit

### 17.1 What was reused rather than built

| Need | Reused |
|---|---|
| Approval state model | the existing `ApprovalRequest` — it already carried `state`, `decidedBy`, `decidedAt`, `consumedAt`; it was simply never *retained* |
| Notifications | `notificationsStore` + `useNotificationsFeed`, including its existing `approval-required` kind and stable-key dedupe |
| Task surface | `TaskList` / `MissionDetail` / `useMissions` |
| Persistence | `persist.ts` — same config home and same atomic write-then-rename as the project registry |
| Audit | the existing `AuditRecord`, plus two optional fields for the human decision |

No second approval model, no second policy model, no second store.

### 17.2 The security property that shaped the API

The desktop **cannot name a capability**. `POST /fabric/approvals/:id/decide`
takes an id and a yes/no; the service reads the capability, mission and task off
the request it stored. `approvedCapabilities` was consequently removed from the
mission run and accept routes — those previously trusted a client-supplied list.

A forged grant was tested: `POST …/tasks/:id/run {"approvedCapabilities":["git.diff"]}`
left the task parked, unchanged.

### 17.3 Duplicate prevention

An approval is keyed by **the question** — `missionId:taskId:capabilityId` — not
by the invocation. Pressing Run four times on a gated task produced **one**
request. Deciding an already-decided request returns 409 with the existing state,
so a double-click, a second window or a replayed request cannot authorize twice.

### 17.4 Validation

Live service, real mission `hub-login-page/mission-ms99d6uv-1mr15w`, driving the
same endpoints the desktop calls.

| # | Case | Evidence |
|---|---|---|
| **A** | Request appears | `GET /fabric/approvals` → capability `git.diff`, risk `low`, rule `autonomy-disabled`, summary, onAccept/onDecline, mission+task ids |
| **B/C** | Approve → same task resumes | `decide {granted:true}` → `resumed: true`, **same** `task-ms99e1xr-86upwl` → `done` |
| **D** | Decline | `decide {granted:false, reason}` → `declined: true`, `resumed: false`, task `rejected`, **nothing executed** |
| **E** | Refresh while pending | re-read as a fresh client → same request id, still `pending` |
| **F** | Duplicate prevention | 4 runs → **1** pending request; second decide → 409 *"already granted"* |
| **G** | Policy persists | saved `allowAutonomous:false` → `~/.aura/fabric-policy.json` → **restart** → loaded back |
| **H** | Decisions audited | 2 records with `approvalDecision` granted/denied, each carrying actor, missionId, taskId, capabilityId, decision, rule, approvalId, timestamp, and the decline reason |
| **I** | Mission Control consistent | 9 tasks / **0** plan-vs-run mismatches; 3 batches; 93 timeline + 93 activity; 89 replay frames; last frame carries all 9 task states |

**Hostile-config test.** A hand-written policy file setting every risk level to
`auto-execute`, `git.push` and `provider.connect` to `auto-execute`, an invalid
decision string, an empty capability key and `allowAutonomous: "yes-please"` was
loaded on boot:

```
git.push          → require-approval   rule=irreversible-floor
provider.connect  → require-approval   rule=authorization-floor
invalid decision + empty key           → dropped by sanitizePolicy
allowAutonomous: "yes-please"          → false (corrupt reads cautious)
```

**A bug this caught:** `sanitizePolicy` originally fell back to the *shipped*
`allowAutonomous` (`true`) for a non-boolean value, so a corrupted file could
silently re-enable unattended execution — the opposite of what its own comment
claimed. A present-but-invalid value now reads `false`.

---

## 18. Production hardening — real UI validation, durable approvals, boot discovery

### 18.1 Pending approvals survive a restart

`fabric-approvals.json` in the existing config home, written through the same
atomic `persist.ts` helpers as the project registry and `MissionStore`. No new
database, no second persistence system.

The safety rule is in the *loader*, not the writer: **only `pending` requests are
restored.** A grant that was given but never spent is deliberately dropped, because
reinstating it would let a restart silently authorize an action with nobody
watching. The task asks again instead. Decided requests are already in the audit
trail, so nothing is lost.

Proven with a hand-written approvals file containing a `granted` unconsumed
request for `git.push`, a `denied` request, and two malformed entries:

```
restored pending requests        : 0
forged GRANT restored?           : False
decide(apr-forged-grant)         : "no such approval request"
git.push                         : require-approval / irreversible-floor
```

### 18.2 Environment discovery at boot

`refreshNodeAvailability()` is now shared by startup and `POST /environment/scan`,
so one function decides what "available" means and a node counts only when it
answered a probe. At boot: `21 node(s) present · 19 capabilities available`.

This fixed a real regression found in the previous phase: after a restart
`git.diff` was *denied* as `no-provider` even though git was installed and working,
until someone happened to trigger a scan.

### 18.3 Real UI validation

`npm run test:ui` (`scripts/ui-approval-test.mjs`, `playwright-core` driving the
system Chromium — no bundled browser download) launches the actual app, dismisses
onboarding, opens the project, opens Mission Control from the command bar, selects
the mission, switches to Tasks, and reads and clicks the rendered gate.

| Check | Result |
|---|---|
| Gate rendered in Mission Detail | PASS |
| Capability / risk / reason shown | PASS — `git.diff`, `low risk`, policy reason |
| Both consequences shown | PASS — Approve and Decline outcomes |
| Policy rule shown | PASS — `autonomy-disabled` |
| Run Task suppressed while gated | PASS |
| Refresh while pending | PASS — same `approvalId` |
| No duplicate requests | PASS — 1 request across repeated runs |
| Approve button → same taskId resumes | PASS — task → `done` |
| Task actually executed | PASS — succeeded record in audit |
| Grant recorded in audit | PASS |
| Decline button + reason prompt | PASS |
| Declined task never executed | PASS — succeeded-record count unchanged |
| Decline recorded with reason | PASS |

**A pre-existing bug this found:** `MissionControl` never called `refreshList()`
on mount, so the Missions panel showed *"No missions yet"* until some unrelated
action refreshed it. `MissionDetailPanel` had the effect; the main panel did not.
Fixed with a mount effect.

**Honest note on verification in the UI path:** the task exercised is `git.diff`,
which declares no verification mechanism, so the audit records `verified=null`
(`no-check`). A genuine verification *pass* is proven separately on
`filesystem.write` (§16.5 case E, `verified=true`) and a verification *failure* in
case F.
