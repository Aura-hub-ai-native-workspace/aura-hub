# Workspace Execution Architecture

> The Workspace becomes AURA's execution environment: one **Hub** the user talks to,
> surrounded by **capability nodes** that represent real, verified execution connections.
>
> This document is the architecture review required before implementation. It is written
> against the code as it actually exists on `feature/workspace-execution-environment`
> (parent `880a8c7`), not against intent. Every claim carries a file reference. Where the
> system cannot do something, this document says so rather than describing a plan as if it
> were a capability.

---

## 1. Current architecture audit

### 1.1 What the Workspace is today

`apps/desktop/src/screens/WorkspaceScreen.tsx` is a 60-line two-pane shell: a
`WorkspaceCanvas` plus a conditional inspector rail. All behaviour lives in
`apps/desktop/src/ops/`:

| Concern | Owner |
|---|---|
| Window state (flat list, no split tree) | `ops/layoutStore.ts:37` `WindowState` |
| Window kinds — a **closed 15-member union** | `ops/layoutStore.ts:20` `PanelKind` |
| Window chrome: drag, 8-edge resize, snap, minimize, maximize | `ops/FloatingWindow.tsx` |
| Canvas, tray, suggestion nudge, template/preset menus | `ops/WorkspaceCanvas.tsx` |
| Panel registry (15 lazy components) | `ops/panels.tsx:29` |
| Inspector registry (4 of 15 kinds) | `ops/inspectors.tsx:19` |
| "Intelligence" — 3 hardcoded relation pairs, 6 layout templates | `ops/workspaceIntelligence.ts` |

`workspaceIntelligence.ts:5` is explicit that nothing there is AI: every "smart" behaviour is
a deterministic lookup. Live windows are **never persisted**; only *named presets* survive, in
`localStorage` under `aura.ops.layouts` (`layoutStore.ts:439-468`).

### 1.2 The node model already exists — in a second system

The **Connected Environment** (`packages/connected-environment/` + `apps/desktop/src/environment/`)
already implements most of what this brief asks for:

| Asset | Location |
|---|---|
| `EnvironmentNode` — identity, health, permissions, activity, log, connected | `connected-environment/src/types.ts:163` |
| `CatalogEntry` — category, capabilities, transport, auth, probe, endpoint | `connected-environment/src/types.ts:65` |
| **110 catalogued systems** | `connected-environment/src/catalog.ts` |
| 44 node-capability ids | `connected-environment/src/capabilities.ts:22` |
| Pure state transitions (`applyProbe`/`applyConnect`/`applyDisconnect`) | `connected-environment/src/registry.ts` |
| Capability gap analysis + candidate ranking | `connected-environment/src/resolver.ts` |
| Per-node inspector UI, node cards, gap panel | `apps/desktop/src/environment/` |

`TransportKind` (`types.ts:55`) — `internal | local-process | http | api-key | oauth` — is
described in-file as *"the honesty boundary of the whole architecture"*: it decides what AURA
can actually drive versus merely catalogue.

**Detection is real and already working.** `packages/ai-service/src/environment.ts` runs the
`probe: {command, args}` declared on each catalog entry through `execFile`, parses a version
out of noisy output (`extractVersion()`), caches for 30s, and batch-scans with concurrency 8.
Presence is decided by recognisable output rather than exit code, because tools like
`java -version` print to stderr and can exit non-zero while present. A hard security invariant
is stated at `environment.ts:9-16`: the command and args always come from the catalog entry
looked up by id, **never** from a request body.

### 1.3 Governed execution already exists

The Capability Fabric (`packages/capability-fabric/`) is the single governed path for side
effects: **resolve → policy → approval → execute → verify → recover → audit**
(`fabric.ts:351`). It carries 31 capability descriptors (`manifest.ts`), of which 14 have real
executors; the rest resolve honestly to `unsupported`.

Policy hard floors (`policy.ts:121-181`), checked before any configurable layer and not
overridable by configuration:

1. `no-provider` — nothing connected can perform it → **deny**
2. `permission-denied` — missing granted scopes → **deny**
3. `irreversible-floor` → **require-approval**
4. `destructive-floor` (`resource.destroy`) → **require-approval**
5. `authorization-floor` (`account.authorize`) → **require-approval**

`resource.destroy` and `account.authorize` are never grantable by a node permission flag
(`policy.ts:230-233`), so "write access" can never escalate into destroying a database.

### 1.4 Mission execution already exists

`MissionRecord` (`mission/types.ts:278`) is the sole mission model, persisted one JSON file per
mission at `~/.aura/missions/<projectId>/<missionId>.json`. Planning is a 9-stage pipeline
(`mission/orchestrator.ts:58`) with exactly **two** LLM calls — intent extraction and goal-graph
generation — plus one bounded review/revision. Everything else is deterministic.

`ExecutionDag` (`mission/execution/dag.ts`) supplies Kahn topological sort with priority
tie-breaking, parallel batches, and a critical path. `ExecutionTaskStatus` has 12 runtime
states; `TaskStatus` has 6 planning states; the mapping between them is explicit in both
directions.

The mission→Fabric seam is `WorkspaceManager.runTaskThroughFabric()`
(`ai-service/src/workspace.ts:578`), which calls `planTaskInvocation()` and translates
`InvocationResult.outcome` into a task outcome. Notably `unverified` maps to **failure**, on
the stated principle that an unverified effect the operator believes succeeded is worse than
one they know to re-check.

### 1.5 Process execution

There is one governed spawn path: `packages/ai-service/src/exec/process.ts`, extracted
verbatim from `workflow/nodes.ts` so the Fabric and Workflow engine share it rather than
drifting. `parseCommand()` rejects shell metacharacters and checks an allowlist:

```
SAFE_BINARIES = { git, ls, pwd, node, npm, npx, wc, du, grep, find, cargo, python3, go }
```

`safeShell()` uses `execFile` — never a shell. **No package manager is on this list**, which is
the reason the installation model in §6 introduces a separate, narrower allowlist rather than
widening this one.

---

## 2. Problems with the current Workspace

**P1 — It is a window manager, not an execution environment.** The Workspace shows 15 fixed
tool panels. Nothing in it represents a *capability*, a connection, or live execution state.

**P2 — No Hub.** There is no central object to talk to. `'hub'` exists only as a
`NodeCategory` string value (`types.ts:37`), never as a rendered entity.

**P3 — The node model is in the wrong place and not spatial.** The Connected Environment owns
nodes but renders a filtered card grid. Its header states it is *"deliberately not a wiring
canvas"* — a sound rejection of n8n/Zapier, but it left no spatial model at all. Nothing
anywhere positions nodes or draws an edge.

**P4 — Nodes are inert during execution.** `NodeActivity` exists on the type but no execution
path writes to it. A mission task running `git.diff` does not light up the Git node.

**P5 — Detection has no forward path.** `not-installed` is terminal. There is no install
action, no `installing` state, and zero install code anywhere in the repository.

**P6 — Two window managers.** `ops/layoutStore.ts` is hard-bound to the closed `PanelKind`
union; `environment/windows/windowManager.ts` is generic over an opaque `contentId`. The code
itself records the intended resolution: *"the Workspace's manager should eventually be rebuilt
on top of it so the app has one windowing model rather than two"* (`windowManager.ts:12-14`).

**P7 — Two execution engines with inconsistent governance.** See §21.1. This is the most
serious finding in the audit and it predates this work.

---

## 3. New Workspace philosophy

> One environment. One mission. Many capabilities.

Four principles, in priority order:

1. **Honesty over completeness.** A node shows what is actually true of the machine. An
   uninstalled tool says so; an unverified install is not a success. `TransportKind` and the
   `unsupported` outcome already encode this discipline — the Workspace inherits it.
2. **One of everything.** One mission model, one DAG, one policy engine, one approval system,
   one spawn path. The Workspace is a *surface over* these, never a second copy. §14 states
   the authoritative owners.
3. **The user states outcomes, not steps.** The user should never have to sequence
   "open terminal → install node → create repo → deploy". They state the outcome; the Hub
   plans, discovers requirements, asks permission, and executes.
4. **Always move the mission forward.** A missing capability is a question with an offer, not
   an error. "Docker is required and isn't installed — I can install it for you" rather than
   "Tool not found."

---

## 4. Hub model

**The Hub is a UI surface bound to Mission Control. It is not a node, not a window, and not an
engine.** It holds no mission state of its own.

```
User prompt
   │
   ▼
HubSurface ──► missionClient.create() ──► runMissionCreation()   [9 stages, existing]
   │                                            │
   │                                     MissionRecord            [sole model, existing]
   │                                            │
   ▼                                     ExecutionDag             [sole DAG, existing]
Hub renders: phase, plan summary, required capabilities, gaps, progress
```

The Hub's visual states map one-to-one onto phases that already exist, so it can never drift
from the engine:

| Hub state | Derived from |
|---|---|
| Idle | no active mission |
| Understanding | orchestrator stages 1–3 (classification, signals, intent) |
| Planning | stages 4–5 (strategy, goal graph) |
| Reviewing | stages 7–8 (risk, adversarial review) |
| Awaiting approval | `CheckpointKey: 'planning'` pending, or a Fabric `ApprovalRequest` |
| Executing | `ExecutionStatus: 'running'`, batch index from the DAG |
| Verifying | Fabric verification stage of the in-flight invocation |
| Complete / Failed | `ExecutionStatus: 'completed' \| 'failed'` |

Sizing is deliberate: a medium-sized central object, not a full-bleed chat surface. It shows
the *current* mission and its live requirements; mission history stays in Mission Control,
which is already a complete surface and is not duplicated here.

---

## 5. Node model

Nodes remain `EnvironmentNode` (`connected-environment/src/types.ts:163`). No fork, no parallel
type. Two additive changes:

**5.1 — `CatalogEntry.install?`** (new, optional):

```ts
interface InstallSpec {
  method: 'npm-global' | 'pipx' | 'cargo' | 'gh-extension' | 'system-package';
  package: string;
  /** Which privilege tier this needs. Drives §6. */
  privilege: 'user' | 'root';
  /** Per-distro package names where they differ. */
  distro?: Record<string, string>;
}
```

Optional, so all 110 existing entries stay valid. An entry without `install` is simply not
installable by AURA and says so.

**5.2 — Two orthogonal state axes.** The brief lists ~12 desired states. Collapsing them into
one enum would create a second state machine competing with `NodeStatus`. Instead:

**Axis A — presence/reachability.** `NodeStatus` remains the sole owner
(`types.ts:94-108`), gaining exactly one state:

```
unknown → available → connected → degraded
        ↘ not-installed → installing → available     (new transition)
        ↘ needs-auth
        ↘ no-connector
```

**Axis B — execution activity.** `NodeActivityPhase` (new, **derived, never persisted**):

```
idle | running | verifying | waiting-approval | recovering
```

Projected from live Fabric events by mapping the in-flight `capabilityId` to whichever node
provides its `requiresNodeCapability`. This is the same sidecar-projection discipline
`missionCapabilities.ts:20-23` already uses for capability bindings — derived on demand,
discarded when the mission ends, never written to disk.

A node renders as `status × phase` (e.g. *connected + running*). Each axis has exactly one
owner and one writer.

---

## 6. Installation model

**Nothing in AURA installs software today.** This is the largest genuinely new capability, and
it is the one most able to damage a user's machine, so it is the most constrained.

### 6.1 A new capability, not a new subsystem

`system.install` joins the existing manifest (`capability-fabric/src/manifest.ts`):

```
id: 'system.install'   surface: 'local-process'   risk: 'high'
permissions: ['process.execute']
verify: 'read-back'
requiresNodeCapability: (none — installing is how a node comes to exist)
```

`risk: high` means `DEFAULT_POLICY.byRisk` resolves it to **require-approval**. It therefore
inherits, with no new code, the entire existing approval machinery: a reviewable
`ApprovalRequest`, single-use grants with `consumedAt`, persistence across restart, the
`decideApproval` audit record, and the desktop `ApprovalGate`.

### 6.2 A separate allowlist — deliberately not `SAFE_BINARIES`

Package managers are **not** added to `SAFE_BINARIES`. Doing so would let `terminal.execute` —
a medium-risk, ask-user capability — install arbitrary software. Instead the `system.install`
executor carries its own table, and the *package name* is never free text: it comes from the
catalog entry's `InstallSpec`, looked up by node id, mirroring the invariant already enforced
for probes at `environment.ts:9-16`.

### 6.3 Privilege tiers

| Tier | Examples | Behaviour |
|---|---|---|
| **user** | `npm install -g`, `pipx install`, `cargo install`, `gh extension install` | Executed through `exec/process.ts` after approval |
| **root** | `pacman -S`, `apt install`, `dnf install` | **Never executed.** Returns outcome `guided` with the exact command |

The root tier is a deliberate, permanent boundary in this design. Auto-installing system
packages requires either a stored sudo password or a privileged helper daemon; both are large
security surfaces that this architecture does not open. On the target machine (Arch Linux),
Docker and PostgreSQL are root-tier, so the flow is: detect → explain → show the verified
command → wait → re-probe. Honest, and it still moves the mission forward.

### 6.4 Verification is mandatory

An install is **never** reported successful on the installer's exit code alone. Success
requires a re-probe through the existing `probeNode(id, refresh: true)` that detects the binary
and parses a version. If the installer exits 0 but the probe still finds nothing, the outcome
is `unverified` — which the mission layer already treats as failure (`workspace.ts:611-615`).

```
approve → execute installer → probeNode(refresh) → version parsed?
                                                   ├─ yes → installed, version recorded
                                                   └─ no  → unverified (NOT success)
```

---

## 7. Connection model

Installed and connected stay distinct, as they already are in `NodeStatus`.

| Transport | What "connect" means | Exists today |
|---|---|---|
| `internal` | AURA subsystem, always available | yes |
| `local-process` | Probe succeeds — binary present and runnable | yes |
| `http` | Endpoint liveness check (Ollama, LM Studio) | yes |
| `api-key` | User supplies a key; stored via the existing credential store | yes |
| `oauth` | **No connector exists.** Terminal `no-connector` | honest gap |

OAuth-only systems (most cloud providers in the catalog) remain `no-connector`. This
architecture does not pretend otherwise; adding OAuth is future work with its own security
review, and until then those nodes are catalogued but not driveable.

---

## 8. Capability model

Two catalogs exist and they are **not** duplicates — they answer different questions:

| Catalog | Question | Size |
|---|---|---|
| `capability-fabric/src/manifest.ts` | What can the Fabric be asked to **do**? | 31 actions |
| `connected-environment/src/catalog.ts` | What **systems** exist, and what do they provide? | 110 systems |

They are joined by one field: `CapabilityDescriptor.requiresNodeCapability` references a
`CapabilityId` from the 44-value vocabulary, which is also what `CatalogEntry.capabilities[]`
is drawn from. **No third registry is introduced by this work.**

Requirement discovery extends the existing deterministic path rather than adding a model call.
`annotateMissionCapabilities()` already derives per-task action capabilities from `TaskKind`.
This work adds a mission-level rollup: action capabilities → their `requiresNodeCapability` →
candidate systems via the existing `resolver.ts` `rankCandidates`/`findGaps`. So
"this mission needs Docker" is *derived from the plan*, not guessed by a model.

---

## 9. Mission integration

The Hub introduces **no** mission model, DAG, planner, scheduler or orchestrator. It calls the
existing endpoints already used by Mission Control:

```
POST /projects/:id/missions            create (SSE plan stream)
POST /projects/:id/missions/:mid/approve
POST /projects/:id/missions/:mid/start
POST /projects/:id/missions/:mid/execute   (SSE execution stream)
GET  /fabric/approvals · POST /fabric/approvals/:id/decide
```

Mission tasks continue to reach the Fabric through the single existing seam,
`runTaskThroughFabric()` (`workspace.ts:578`). The Workspace is a **second view** of the same
records Mission Control shows — never a second source of truth.

---

## 10. Agent integration

The audit found no server-side multi-agent orchestrator. `apps/desktop/src/ops/agentEngine.ts`
runs entirely in the renderer on a 30s interval and its only action is three HTTP calls —
`create` → `approve` → `start` — driving Mission Control through the same public API the human
UI uses. Its own comment records the safety rule: *"The agent NEVER edits code directly."*

`AgentRole` (14 roles, `connected-environment/src/agents.ts`) is accountability metadata on
Fabric invocations, not a scheduler — the DAG does all ordering.

**This architecture keeps it that way.** "Agent orchestration" in the Hub means the existing
DAG executing tasks with role labels for audit. No autonomous agent loop is introduced.

---

## 11. Workspace state model

Split by who owns the truth:

| State | Owner | Scope | Persistence |
|---|---|---|---|
| Installed / version / reachable | ai-service probes | **machine** | derived, 30s cache |
| Connected + credentials | ai-service credential store | machine | `~/.aura/` |
| Which nodes are placed, and where | desktop `hubStore` | **workspace** | `localStorage aura.workspace.layout` |
| Mission state | `MissionRecord` | project | `~/.aura/missions/…` |
| Approvals | Capability Fabric | machine | `~/.aura/fabric-approvals.json` |
| Policy | Capability Fabric | machine | `~/.aura/fabric-policy.json` |
| Node activity phase | derived projection | ephemeral | **never persisted** |

Whether Docker is installed is a fact about the machine, so it is global and shared. Which
nodes you have arranged, and where, is per-workspace. No workspace can hold a private opinion
about whether a binary exists.

---

## 12. Floating-window model

**Windows are not nodes.** A node is the Workspace's representation of a capability; a window
is a transient inspection surface over one. Closing a window never removes a node; the canvas
stays visible behind it.

This work consolidates on the generic `environment/windows/windowManager.ts` +
`FloatingSurface.tsx`, which are already content-agnostic (opaque `contentId`) and already
render `NodeInspector` this way. `ops/layoutStore.ts` and its 15 panels are **left untouched**
— they are a working system, and P6 is resolved by migration later (§17), not by deletion now.

Stacking follows the layering already established in this codebase and audited during the
notification fix: portaled surfaces at `z-[100..300]`, in-canvas windows ordered by a
monotonic per-session counter applied as inline `zIndex`. **No arbitrary large z-index values.**
Where a stacking problem appears, the fix is the stacking context (portal boundary), not the
number — the `backdrop-filter` trap documented in `CommandBar.tsx` is the worked example.

---

## 13. Data flow

```
User types a mission into the Hub
        │
        ▼
POST /projects/:id/missions  ──► 9-stage planner (2 LLM calls)
        │  SSE: stage events                    │
        ▼                                       ▼
   Hub phase updates                      MissionRecord + GoalGraph
        │
        ▼
annotateMissionCapabilities()  ──►  action capabilities per task
        │                                   │
        │                            requiresNodeCapability
        │                                   ▼
        │                       resolver.rankCandidates / findGaps
        ▼                                   │
Required-capability panel on the Hub ◄──────┘
        │
        ├── all present ──► approve → start → execute (DAG batches)
        │                        │
        │                        ▼
        │                 runTaskThroughFabric()
        │                        │
        │        resolve→policy→approval→execute→verify→recover→audit
        │                        │
        │                        ▼
        │                 node activity phase (derived) → canvas lights up
        │
        └── something missing ──► "X is required and isn't installed.
                                   I can install it for you."
                                        │
                                  approve → system.install → re-probe → verify
                                        │
                                  node appears → mission continues
```

---

## 14. UI architecture

New, under `apps/desktop/src/workspace/`:

| Component | Responsibility |
|---|---|
| `HubSurface` | The Hub object: prompt input, phase, plan summary, requirement list |
| `HubCanvas` | Spatial layout — Hub centre, nodes on category rings, SVG edges |
| `hubStore` | Placed nodes + positions; persisted per workspace |
| `AddNodeDialog` | Searchable picker grouped by `NodeCategory`, reading the existing 110-entry catalog |

Reused unchanged: `NodeInspector`, `FloatingSurface`, `windowManager`, `NodeCard` visual
vocabulary, `environmentStore.scan()`, `presentation.ts` status tones.

**Authoritative owners after this work** — extending `docs/CONSOLIDATION_MAP.md:18` rather than
forking it:

| Concern | Owner | Changed? |
|---|---|---|
| Mission state | `MissionRecord` | no |
| Execution DAG | `ExecutionDag` | no |
| Task runtime state | `ExecutionTaskStatus` | no |
| Policy / approval / audit | Capability Fabric | no |
| Process spawn | `exec/process.ts` | no |
| Action catalog | `capability-fabric/manifest.ts` | +1 entry |
| System catalog | `connected-environment/catalog.ts` | +optional field |
| Node presence state | `NodeStatus` | +1 state |
| Node execution phase | `NodeActivityPhase` | **new, derived** |
| Workspace layout | `hubStore` | **new** |

---

## 15. Backend architecture

Minimal additions:

- `system.install` descriptor in the manifest, and its executor under `ai-service/src/fabric/`,
  using `exec/process.ts` and `probeNode()` for verification.
- The existing `POST /environment/scan` and `POST /environment/probe` routes already serve
  detection; no new detection endpoint.
- Mission-level capability rollup added to the existing
  `GET /fabric/mission/:projectId/:missionId` annotation route.

The `capability-fabric` package must continue to have **no dependency on `ai-service`**. It is
enforced today only by `package.json` and convention — §21 records this.

---

## 16. State management

Zustand throughout, matching existing practice. `hubStore` follows the discipline in
`layoutStore.ts`: explicit persistence of layout only, hydration validated on read, stale keys
purged rather than silently misread. Machine facts are never mirrored into the layout store —
they are read from `environmentStore`, whose own comment records that a relaunch starts from an
unmeasured environment and re-scans rather than trusting stale state.

---

## 17. Migration strategy

Incremental. Nothing is deleted before its replacement is proven.

| Phase | Content | Risk |
|---|---|---|
| **1** | Hub + canvas + real detection + inspector windows + Add Node | low — additive |
| **2** | `NodeActivityPhase` projection; nodes react to live execution | low — derived only |
| **3** | Hub → mission execution wiring; requirement panel with gaps | medium |
| **4** | `system.install` (user tier), guided root tier, verification | **highest** |
| **5** | Migrate `ops/layoutStore` panels onto `windowManager` (resolves P6) | medium |
| **6** | Reconcile the two execution engines (resolves P7) | high — separate review |

Phase 1 is the current implementation slice. The old Workspace remains reachable and intact
throughout; the Connected Environment screen stays until the Hub canvas fully supersedes it.

---

## 18. Scalability

- 110 catalog entries render as cards today; a canvas draws only *placed* nodes — expected
  single digits to low tens. Edge count is O(n) from the Hub, not O(n²).
- `scanEnvironment()` already bounds concurrency to 8 with a 30s cache and 4s per-probe
  timeout.
- The mission DAG already handles batching and parallelism; the Hub adds no scheduling.
- Node activity is a derived projection over in-flight invocations — bounded by concurrent
  Fabric calls, not by history.

---

## 19. Security

| Boundary | Mechanism | Status |
|---|---|---|
| Arbitrary command execution | `parseCommand()` metachar rejection + `SAFE_BINARIES` | exists |
| Probe command injection | Commands come from the catalog by id, never from request bodies | exists |
| Install command injection | Package names come from `InstallSpec` by node id; separate allowlist | **new** |
| Privilege escalation | Root-tier installs are never executed | **new, by design** |
| Capability grants | Server-derived only; the desktop cannot name a capability | exists |
| Policy tampering | `sanitizePolicy()` treats persisted config as hostile; floors precede config | exists |
| Secrets | `summarizeInput()` redacts apiKey/token/secret/password from audit | exists |
| Audit trail | One `AuditRecord` per governed action, plus approval decisions | exists (in-memory) |

---

## 20. Failure and recovery

- **Fabric**: bounded retry — 3 attempts, exponential backoff from 400ms, only for
  transient-classified errors (`fabric.ts:47`).
- **Mission engine**: `runOne` wraps the hook in try/catch so a throw becomes a terminal
  failure rather than a task stuck "running"; `retryTask()` re-queues.
- **Verification failure** is not success: `unverified` maps to task failure.
- **Install failure**: re-probe is the arbiter. A failed install leaves the node
  `not-installed` — never a fabricated `available`.
- **Approval across restart**: pending requests are restored; **granted-but-unspent grants are
  deliberately dropped** (`fabric.ts:174-185`), so a restart can never silently re-authorise.

---

## 21. Honest limitations

**21.1 — Two execution engines remain, with inconsistent governance.** This is the most serious
finding and it predates this work. The mission DAG is Fabric-mediated, human-gated and audited.
The Workflow engine (`ai-service/src/workflow/engine.ts`) executes `action` nodes —
`shell-command`, `git-*`, `http-request` — **directly, with no policy check, no approval gate
and no audit record**. That is the same class of side effect missions route through the Fabric.
Merging them mid-reconstruction would be reckless, so the Hub is built exclusively on the
mission engine and this is scheduled as phase 6.

**21.2 — Two window managers remain** until phase 5.

**21.3 — Root-tier installation will never be automatic** under this design. On Arch, that
includes Docker and PostgreSQL — two of the brief's own examples. The guided path is honest but
is not the fully autonomous install the brief envisions.

**21.4 — OAuth systems cannot be connected.** Most cloud providers in the catalog are
`no-connector`. Cloudflare/Vercel/AWS nodes will be catalogued and honest, not functional.

**21.5 — `github.*` and `browser.*` capabilities have no executors** and resolve to
`unsupported`. Nodes for those systems show real gaps rather than working execution.

**21.6 — The audit log is in-memory only.** `AuditRecord`s do not survive a service restart,
unlike policy and approvals. For an execution layer with real permissions this is a genuine
gap.

**21.7 — The package boundary is convention, not enforcement.** `capability-fabric` must not
depend on `ai-service`; nothing in CI checks this.

**21.9 — Node selection lives in the executor, not the Fabric.** `agent.delegate` picks which
coding agent runs inside its own executor (`fabric/executors.ts` → `resolveAgent()`), by filtering
the catalogue for `coding-agent` and probing for presence. The Fabric itself still has no concept
of routing: `nodeAvailable()` (`ai-service/src/fabric/index.ts:53`) answers only the boolean
question *"does some node provide this capability?"*, never *"run it via that node."*

This works and is honest — the executor reports the node it used, and that `nodeId` now travels
through `ExecutorResult.output` → `InvocationResult.output` → `AuditRecord.nodeId` →
`RunTaskResult.nodeId` → `MissionTaskRun.nodeId` → the Workspace projection, so activity lands on
the exact node. But the selection *policy* is per-executor, so a second node-bound capability
would have to repeat it.

**Promoting node routing into the invocation contract would require, in order:**

1. `InvocationContext` gains an optional `nodeId` — the caller's *request* for a specific node,
   distinct from the executor's *report* of which one ran.
2. `FabricHost.nodeAvailable()` becomes `resolveNode(capability, context): NodeRef | null`,
   returning the chosen node rather than a boolean. The `no-provider` policy floor keeps its
   current meaning: `null` still denies.
3. `Invocation` carries the resolved `NodeRef`, so an executor receives its node instead of
   discovering it. `resolveAgent()` then collapses into a lookup of the argv builder.
4. Every existing executor is unaffected: capabilities with no `requiresNodeCapability` resolve
   to `null` and behave exactly as today. Only the four node-bound families (terminal, git, http,
   agent) would gain a resolved node.
5. Policy could then gate *per node* ("this agent may run, that one may not"), which is not
   expressible today and is the main reason to do this at all.

The reason not to do it now: step 2 changes a host interface that the whole Fabric depends on, and
step 3 changes the shape every executor receives. That is a wide, mechanical change best made when
a second node-bound agent capability actually needs it — not speculatively. Until then the debt is
one function in one executor, and it is contained.

**21.8 — Capability discovery is structural, not semantic.** Requirements are derived from
`TaskKind`/`targetFile`/`mode` produced by the planner, not from understanding the prompt. A
mission whose plan does not name a file will not discover that it needs Docker. Improving this
means enriching the planner's output, not adding a second inference path.

---

## 22. First-class node routing (resolves §21.9)

### 22.1 The problem

`FabricHost.nodeAvailable(capability)` answers a boolean: *"does some node provide this?"* It
cannot answer *"which node, and route there."* So `agent.delegate` discovered its own node inside
`resolveAgent()` — correct behaviour, wrong layer. Selection policy was per-executor, and a second
node-bound capability would have had to repeat it.

### 22.2 Where NodeRef enters

Exactly four places, each a distinct concept. The critical distinction is **requested ≠ executed**:

| Concept | Carrier | Meaning |
|---|---|---|
| **Requested** | `InvocationContext.nodeId?: string` | Routing *intent* from the caller. Optional. |
| **Resolved** | `Invocation.node?: NodeRef` | What the Fabric chose. Handed to the executor. |
| **Executed** | `ExecutorResult.output.nodeId` | What actually ran, reported by the executor. |
| **Recorded** | `AuditRecord.requestedNodeId` / `.executedNodeId` | Both, never collapsed. |

An executor no longer discovers anything: it receives `invocation.node`.

### 22.3 NodeRef

```ts
interface NodeRef { id: string; name: string; capabilities: string[]; binary?: string }
```

Minimal by design and **not a registry**. It is a projection of the catalogue plus the last
environment scan — built where `providedNodeCapabilities` is already built (`server.ts`), from the
same scan results, with the same freshness. The catalogue remains the only source of truth for what
a node is; `NodeRef` only carries what routing needs.

### 22.4 Resolution

`FabricHost.resolveNode(capability, context): NodeResolution` — synchronous, like `nodeAvailable`,
because it reads the last scan rather than probing. `nodeAvailable()` **remains** and is derived
from the same resolution, so the `no-provider` floor is unchanged.

```
NodeResolution = { ok: true; node: NodeRef }
               | { ok: false; code: NodeResolutionFailure; reason: string }
```

Failure codes, all denied **before execution**: `unknown-node`, `node-not-connected`,
`node-lacks-capability`, `node-unsupported`, `no-provider`.

**`Executor.supportsNode?(node)` — added during implementation, and the design would have been
wrong without it.** Routing by capability alone picked Cursor, the first present `coding-agent`
provider in catalogue order, which AURA has no verified way to drive; the run then failed at spawn
time. The Fabric cannot know which tools are drivable — that is executor knowledge — and the
executor must not do discovery. So the executor *declares* what it can drive, the Fabric passes
that predicate into resolution, and an unusable node is refused before policy instead of chosen and
then failed. Executors that shell out generically omit it and accept any provider.

**Selection policy, documented as required:**

1. Capability declares no `requiresNodeCapability` → `{ ok: true }` with no node. Unchanged path.
2. `aura-internal` surface → runs inside AURA, no node.
3. A node **was** requested → it must exist, be present, provide the capability, and be drivable
   by the executor. If any check fails the invocation is **denied**. A requested node is *never*
   silently substituted — refusing is the whole point.
4. No node requested → the first present provider **in catalogue order** that the executor can
   drive. Deterministic and documented; it is not arbitrary, and attribution stays exact because
   the executor still reports what ran.

### 22.5 Ordering, and why policy cannot be bypassed

```
validate → resolveNode → policy(nodeAvailable ← resolution) → approval → execute → verify → audit
```

Resolution runs *before* policy and feeds it. A requested node therefore cannot skip a gate: it
changes *which* node is evaluated, never *whether* evaluation happens. The irreversible floor,
approval, actor, project confinement and audit are all untouched.

### 22.6 Compatibility

Capabilities without `requiresNodeCapability` are unaffected — resolution returns no node and every
existing executor behaves exactly as before. `InvocationContext.nodeId` is optional; omitting it
preserves current behaviour end to end.

---

## 23. Per-node governance (extends §22)

### 23.1 The audit finding that shapes this

The existing engine is **monotonically escalate-only**. Every configurable layer is folded with
`stricter()` (`policy.ts:102`), and the file states the guarantee outright: *"A configuration
mistake can make the Fabric more cautious than intended. It cannot make it less cautious than the
hard floors."*

The precedence sketched in the brief — floors → node deny → **node allow** → capability policy →
risk — cannot be implemented as written. "Node allow overriding capability policy" is a *weakening*:
it would let a node rule lower `require-approval` to `auto-execute`. That breaks the engine's
central invariant and directly contradicts the brief's own Phase 4 (*"Node policy says 'OpenCode
allowed' must NOT mean 'OpenCode may execute without approval'"*).

Both cannot hold. The invariant wins, because it is the security argument of the whole Fabric.

### 23.2 What "allow" therefore means

Node policy is **admission control**, not a fast path:

- **deny** — this node may not perform this capability. Escalates to `deny`. Fully expressible.
- **allow** — this node is *not excluded*. Contributes **no** escalation, and therefore never
  lowers an existing requirement. `agent.delegate` on OpenCode still hits the irreversible floor
  and still requires approval.

So node identity can *restrict* who may act, never *relax* what acting costs. Node authorization
and execution authorization stay separate, exactly as Phase 4 demands.

### 23.3 Configuration

Two additions to the existing `PolicyConfig` — no second policy store, no new engine:

```ts
nodeOverrides?: Record<string, PolicyDecision>  // "@<nodeId>" | "<capabilityId>@<nodeId>"
nodeAllowlists?: Record<string, string[]>       // capabilityId → node ids permitted
```

`nodeAllowlists` is how *"unknown/untrusted node → denied"* is expressed: absent means no
allowlist and current behaviour is unchanged; present means a resolved node outside the list is
denied. Both are sanitized by the existing `sanitizePolicy`, which treats the file as hostile.

### 23.4 Evaluation order (actual, not assumed)

**One control-flow change was required, and it strengthens the model.** The three
`require-approval` floors used to `return` immediately, which made them a *ceiling* as well as a
floor: nothing could be stricter than "needs approval", so a rule denying a specific node could not
be expressed for precisely the capabilities where it matters most — the irreversible ones. They now
**seed** the decision instead. Because every layer below folds with `stricter()`, no configuration
can go beneath a floor, while a denial can still rise above one. The two `deny` floors
(`no-provider`, `permission-denied`) still return early, since nothing can exceed `deny`.

A candidate claims the reported `rule` only when it escalates, or when it restates the current
level from a more specific position. A weaker candidate changes nothing and must not relabel a
floor it never overcame.

Within the configurable layers, candidates are folded least-specific to most-specific through
`stricter()`:

```
risk default → capability override → node-wide (@node) → capability@node → allowlist → autonomy
```

More specific wins **in the only direction the model permits**: it can escalate, and when two
candidates are equally strict the more specific one supplies the reported rule name. So a node rule
"overrides" a capability rule by being stricter, never by being laxer.

### 23.5 Policy input

`PolicyInput` gains the resolved node — **identity only** (`{ id, name }`), not the whole
`NodeRef`, so catalogue metadata is not duplicated into policy. Actor, project, mission, task and
the *requested* node id are threaded through as context for transparency and future rules; §23.7
records honestly that no rule keys off them yet.

### 23.6 Transparency

Every decision already carries `rule` and `reason`. Node rules extend that vocabulary with
`node-denied:<id>`, `node-override:<capability>@<id>` and `node-not-allowlisted:<capability>`, each
with a sentence naming the node and the reason. Reasons name ids and capability names only — never
policy file contents or credentials.

### 23.7 Limits

Node policy is deny-only by construction (23.2). A future "trusted node runs with less friction"
feature is **not** reachable by extending this; it would require a deliberate, separately reviewed
change to the escalate-only invariant, and should not be smuggled in as a node rule.

---

## 24. Desktop packaging (Tauri)

### 24.1 Why Tauri and not a second shell

The packaging milestone was briefed as "package AURA Hub as an Electron application". The
repository already had a **working Tauri v2 shell** — `apps/desktop/src-tauri` with five
`#[tauri::command]`s, a path-confinement guard (`resolve_within_root`), a capability ACL,
icons and bundle configuration; the renderer calls it through `fsClient.ts`, and the service's
CORS allowlist already trusts `tauri://localhost`.

Introducing Electron would therefore have created a **second desktop application
architecture** — the thing this document exists to prevent — and would have required
reimplementing security-critical filesystem confinement in Node and widening the service's
origin allowlist. The decision, taken explicitly rather than by default, was to complete the
existing shell. Every functional requirement of the brief (self-starting service, health
gating, port safety, `~/.aura` state, Linux packaging) is framework-neutral and is met below.

### 24.2 What the shell owns

    launch
      ↓  identify port 4319
      ├─ AURA already there ────────────→ reuse (do not supervise)
      ├─ something else there ──────────→ refuse, with the reason
      └─ free
           ↓  resolve Node + packaged ai-service.mjs
           ↓  spawn with seeded PATH, AURA_HOME, AI_PORT
           ↓  poll /health until AURA answers  (never "spawned == ready")
           ↓  show window
           ↓  ...
           ↓  SIGTERM on exit → wait → SIGKILL fallback

`service.rs` owns this and nothing else. It is not an execution path: the only process the
desktop shell ever starts is AURA's own service, running a resolved Node interpreter. Tool
execution continues to travel the governed path (Fabric → policy → approval → audit), and the
shell adds no way around it.

### 24.3 Identifying the port, not assuming it

Port 4319 being open is not evidence that AURA is behind it. The shell fingerprints it on two
endpoints — `/health` answering in AURA's shape **and** `/fabric/capabilities` returning both a
capability catalogue and a policy — before reusing anything. Anything else is reported as
occupied and left strictly alone: AURA never kills the owner of a port it did not open.

### 24.4 PATH is a correctness concern, not a convenience

`environment.ts` probes every external tool with `execFile(probe.command, …)`, which resolves
through the **inherited PATH**. A desktop launcher gives a GUI process a minimal PATH, so a
naively packaged AURA would report OpenCode, cargo, go and everything else in a user bin
directory as "not installed" — a confident, wrong answer.

The shell therefore seeds the service's PATH: inherited PATH first (a developer's shell wins),
then the resolved interpreter's directory, then the conventional user tool directories
(`~/.local/bin`, `~/.opencode/bin`, `~/.cargo/bin`, …). `packaging-verify` launches the app
with `PATH=/usr/bin:/bin` specifically to prove this works.

### 24.5 Node is required, not bundled

The application does not ship a Node runtime. AURA already treats `node` as an external
execution node — it is in the catalogue and in `SAFE_BINARIES` — so requiring the real one is
consistent with how every other tool is handled, and bundling a second copy would mean the app
runs on a different Node than the one it reports detecting. The `.deb` declares a `nodejs`
dependency; a missing interpreter produces a clear message, not a silent failure.

### 24.6 User state

`persist.ts` already resolved `AURA_HOME || ~/.aura`, so state was never inside the
application. The shell reinforces this: the service is started with `AURA_HOME` set and its
working directory set to that home (never the installed tree, which may be read-only), and its
log is written to `~/.aura/logs/ai-service.log`.

### 24.7 Development is unchanged

`npm run dev` and `npm run ai` work exactly as before. `npm run desktop:dev` runs the shell
against the Vite dev server; because a compatible service is *reused*, a developer already
running `npm run ai` keeps ownership of it and quitting the app does not kill it.

### 24.8 Known limitations

1. **Linux only.** `bundle.targets` is `["appimage", "deb"]`. Windows and macOS were out of
   scope and are not configured; no cross-platform claim is made.
2. **Node must be installed.** See §24.5. This is a deliberate architectural choice, but it
   does mean the AppImage is not fully self-contained.
3. **The port is fixed at 4319.** The renderer bakes the base URL in at build time
   (`aiClient.ts`), so the shell cannot fall back to a different port without the UI
   following — it reports the conflict instead of silently relocating.
4. **A failed start still opens a window.** The window is shown even when the service could
   not start, carrying the reason via `service_status`, because a permanently invisible
   application would be the least honest outcome. There is no dedicated failure screen yet.

---

## Proof obligation

Before this reconstruction is called complete, the branch must show:

- exactly one type describing mission state (`MissionRecord`)
- exactly one DAG builder (`mission/execution/dag.ts`)
- exactly one policy engine, one approval system, one audit path
- exactly one process-spawn primitive (`exec/process.ts`), plus the narrower install allowlist
- no third capability registry
- no node reporting `available`/`connected` without a real probe behind it
