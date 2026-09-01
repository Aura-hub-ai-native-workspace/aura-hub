# AURA Hub — Architecture Audit

> **Agent 4 (Architecture Auditor) — read-only inspection report**
>
> **Audited:** 2026-08-25 · **Branch:** `feature/aura-central-agent` · **HEAD:** `161142c`
>
> **Method:** repository reconnaissance, static import/route analysis, documentation
> cross-check, safe verification commands only. No source files modified.
>
> **Companion docs reviewed:** `AURA_HUB_MASTER_HANDOFF.md`, `AURA_HUB_ARCHITECTURE_MAP.md`,
> `docs/migration/*`, `AURA_CENTRAL_AGENT_*`, `AURA_CENTRAL_AGENT_IMPLEMENTATION.md`

---

## 1. Repository state

| Item | Observation |
| --- | --- |
| **Current branch** | `feature/aura-central-agent` (active) |
| **Recent commits** | Central Agent milestone 3 (intent/plan/unified runner), desktop agent UX, Python uv/ruff gates |
| **Modified (tracked)** | 26 files — predominantly `apps/desktop/src/**` (Agent 3 WIP), verification scripts, `packages/core`, `graphify-out/*` |
| **Untracked (notable)** | `apps/desktop/src/screens/workflows/agent/RunAgentPanel.tsx`, `apps/desktop/src/components/states/`, `apps/desktop/src/context/`, `backend/*.txt`, multiple `aura-*.html` design docs |
| **Parallel branches (local)** | `feature/backend-python-migration`, `feature/workflow-automation-unification`, `migration/python-backend`, `central-agent-integrated` — indicates concurrent agent worktrees |
| **graphify-out/** | User-owned; modified in tree — do not revert |

**Verification runs (this session):**

| Command | Result |
| --- | --- |
| `python3 -m pytest tests -q` (backend) | **177 passed, 2 failed** |
| `python3 scripts/verify_central_agent.py` | **12/12 PASS** — RUNTIME VERIFIED |
| `python3 -m pytest tests/differential -q` | **9/9 PASS** |
| `node scripts/ui-workflow-test.mjs` | **BLOCKED** — AI service not running on :4319 |
| `node scripts/hub-verify.mjs` | **BLOCKED** — AI service not running on :4319 |

---

## 2. Branch / worktree observations

1. **Dual-track migration in flight:** Python backend (`backend/aura/`) is advancing on Central Agent + subset fabric/workflow, while the Tauri shell still spawns the TypeScript bundle on **:4319** (`apps/desktop/src-tauri/src/service.rs`, `packages/ai-service/src/start.ts`).

2. **Central Agent is a second service on :4320**, started manually (`python3 backend/scripts/serve_central_agent_api.py`) — not wired into Tauri lifecycle.

3. **Documentation lag:** `AURA_HUB_MASTER_HANDOFF.md` (written at `a382625`) still describes a single Node service owning all intelligence. The current branch contradicts that for Central Agent surfaces.

4. **Migration ledger drift:** `docs/migration/python-migration-status.md` lists Fabric invoke as `NOT-STARTED` / `IN-PROGRESS`, but `backend/aura/fabric/invoke.py` + executors exist and the runtime gate passes 12/12. Ledger row needs refresh (INFO — doc maintenance).

---

## 3. Architecture map

### 3.1 Intended single authority chain (invariant)

```
User → Central Agent → Intent → Plan → Policy → Capability Fabric
     → Workflow Engine → Executor → Verification → Evidence → Audit
```

### 3.2 Actual runtime topology (this branch)

```
┌─────────────────────────────────────────────────────────────────────┐
│  AURA Hub Desktop (Tauri + React)                                   │
│                                                                     │
│  aiClient.ts ──────────────► :4319  TS ai-service (SPAWNED)        │
│  automationClient.ts ──────► :4319                                  │
│  fabricClient.ts ──────────► :4319                                  │
│  centralAgentClient.ts ────► :4320  Python Central Agent (MANUAL)  │
│       (dev: Vite proxy /agent-api → :4320)                          │
└─────────────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────────────┐    ┌─────────────────────────────────────┐
│ packages/ai-service     │    │ backend/aura/                        │
│  server.ts (~70 routes) │    │  api.py (agent + thin fabric surface)│
│  workflow/runner.ts     │    │  central_agent/service.py            │
│  workflow/engine.ts     │    │  workflow/engine.py                  │
│  workflow/agent/*       │    │  fabric/invoke.py (subset)           │
│  @aura/capability-fabric│    │  policy/, approvals/, audit/         │
│  @aura/automation       │    │  persistence/* (stores)              │
└─────────────────────────┘    └─────────────────────────────────────┘
         │                                    │
         └──────── BOTH write ~/.aura ────────┘
              (workflows, runs, automation, audit, approvals)
```

### 3.3 Python Central Agent path (verified)

Within `:4320`, the chain is **architecturally correct**:

| Stage | Module | Authority role |
| --- | --- | --- |
| Intent | `central_agent/intent.py` | Reasons; fail-closed on malformed model JSON |
| Plan | `central_agent/planner.py` | Bounded (MAX_TASKS=8); registry-gated capabilities |
| Authority preflight | `central_agent/authority.py` | Reads `describe_authority()` — does not decide |
| Discovery | `central_agent/discovery.py` | Manifest-only; absent caps never runnable |
| Compile | `central_agent/workflow_compiler.py` | Graph → stored workflow |
| Execute | `central_agent/execution.py` | Routes through `invoke_fabric` or `WorkflowEngine` |
| Policy | `policy/engine.py` | Single decision engine (250-case differential passed) |
| Fabric | `fabric/invoke.py` | validate→policy→approval→execute→verify→audit |
| Verify | `central_agent/verification.py` | Reads Fabric outcomes; cannot upgrade authority |
| Evidence | `central_agent/evidence.py` | Joins audit trail; creates no records |
| API/SSE | `api.py` | Observability stream; persisted state authoritative |

Evidence: `backend/scripts/verify_central_agent.py` — 12/12 checks including scenarios A/B/G, approval replay refusal, deny pre-execution.

### 3.4 TypeScript production path (still canonical for desktop)

| Stage | Module |
| --- | --- |
| HTTP | `packages/ai-service/src/server.ts` |
| Workflow runner (single entry) | `packages/ai-service/src/workflow/runner.ts` |
| Graph engine | `packages/ai-service/src/workflow/engine.ts` |
| In-graph agent | `packages/ai-service/src/workflow/agent/{loop,runner,bounds}.ts` |
| Fabric | `packages/capability-fabric/src/fabric.ts` |
| Automation | `packages/automation/src/{engine,scheduler}.ts` via `ai-service/automation.ts` |
| Process primitive | `packages/ai-service/src/exec/process.ts` |

Tauri health-gates **only :4319** (`service.rs:44`, fingerprint check).

---

## 4. Backend TypeScript inventory

Classification per migration contract (`docs/migration/ts-backend-inventory.md`):

| Path | Class | Runtime? | Canonical replacement | Safe to retain? | Must migrate? |
| --- | --- | --- | --- | --- | --- |
| `packages/ai-service/src/server.ts` | **B — LEGACY TS** | **YES** (Tauri spawn) | `backend/aura/api.py` strangler | Until cutover | YES |
| `packages/capability-fabric/src/fabric.ts` | **B + C** | YES (via ai-service) | `backend/aura/fabric/invoke.py` | As differential oracle | YES (subset done) |
| `packages/capability-fabric/src/policy.ts` | **C — ORACLE** | YES | `backend/aura/policy/engine.py` | YES (differential) | Retire after cutover |
| `packages/ai-service/src/workflow/engine.ts` | **B** | YES | `backend/aura/workflow/engine.py` | Until convergence | YES |
| `packages/ai-service/src/workflow/runner.ts` | **B** | YES | Python runner + strangler | Until convergence | YES |
| `packages/ai-service/src/workflow/agent/*` | **B** | YES | `backend/aura/central_agent/*` | Parallel agent runtime | YES (consolidate) |
| `packages/ai-service/src/fabric/*` | **B** | YES | `backend/aura/fabric/*` | Partial | YES |
| `packages/ai-service/src/exec/process.ts` | **B** | YES | NOT STARTED (settle/TIMEOUT=124) | Oracle | YES — CRITICAL |
| `packages/automation/src/*` | **B** | YES | Python engine NOT STARTED | Oracle for stores | YES |
| `packages/ai-service/src/diagnosis/*` | **C — SIDECAR PERMANENT** | YES | Proxy only (D1) | YES permanently | NO |
| `apps/desktop/src/ai/*.ts` | **D — FRONTEND** | Client HTTP only | N/A | YES | N/A |
| `apps/desktop/src/ops/agentEngine.ts` | **D** | Client-side mission loop | N/A | YES (separate product surface) | N/A |

**Backend-relevant TS LOC:** ~48k (per inventory); **Python backend LOC:** ~53 modules under `backend/aura/`.

---

## 5. Python canonical inventory

| Subsystem | Status | Gate evidence |
| --- | --- | --- |
| Contracts (`aura.contracts`) | **CANONICAL** | Golden + schema tests |
| jsonutil / canonical / config | **CANONICAL** | Byte-parity vectors |
| Policy engine | **CANONICAL** | 250-case differential, 0 divergences |
| Approvals ledger | **CANONICAL** | 7 unit tests + invoke differential |
| Audit store | **CANONICAL** | Append-only invariants |
| Persistence stores (workflows, runs, versions, automation) | **CANONICAL** (with bug — see §6) | Cross-lang byte-identical script |
| Fabric invoke (subset) | **IN-PROGRESS CANONICAL** | 16 unit tests; git/fs/workflow executors |
| Workflow engine | **CANONICAL (Python path)** | Scenarios F/G; engine smoke |
| Central Agent | **CANONICAL (Python path)** | 12/12 runtime gate |
| Automation engine/scheduler | **NOT IMPLEMENTED** | Store persistence only |
| Connected environment | **NOT STARTED** | — |
| Full HTTP surface (:4319 routes) | **NOT STARTED** | Only agent API on :4320 |
| Providers (production) | **NOT STARTED** | Fixture harness only |
| exec/process settle() | **NOT STARTED** | — |
| Mission / intelligence / context fabric | **NOT STARTED** | — |

---

## 6. Duplicate systems

| System | Implementations | Severity | Notes |
| --- | --- | --- | --- |
| **HTTP backend** | TS `:4319` + Python `:4320` | **CRITICAL** | Two live services; only TS spawned by Tauri |
| **Workflow engine** | `workflow/engine.ts` + `workflow/engine.py` | **HIGH** | Both execute graphs through respective fabric hosts |
| **Agent runtime** | `workflow/agent/*` (in-graph) + `central_agent/*` (top-level) | **HIGH** | Different entry points, overlapping semantics |
| **Fabric invoke** | `capability-fabric/fabric.ts` + `fabric/invoke.py` | **HIGH** | Python is subset (2 workflow + git/fs); TS is full |
| **Policy engine** | TS + Python | **MEDIUM** | Differential parity verified; TS still production authority |
| **Approval ledger** | TS store + Python ledger | **HIGH** | Documented dual-ledger during migration (`centralAgentClient.ts:196–199`) |
| **Automation runtime** | TS engine/scheduler only | **HIGH** | Python has persistence mirror, no runtime |
| **Persistence writers** | Both backends can write `~/.aura` | **CRITICAL** | Concurrent services risk store corruption / divergent indexes |

---

## 7. Central Agent audit

### 7.1 Invariant compliance (Python path)

| Invariant | Status | Evidence |
| --- | --- | --- |
| Agent reasons; policy decides | **PASS** | `authority.py` calls `describe_authority`; no overrides |
| Fabric enforces | **PASS** | All effects via `invoke_fabric` |
| Workflow engine orchestrates | **PASS** | `ExecutionController` routes workflow-run tasks |
| Executors perform | **PASS** | Fixed-argv git, confined fs writes |
| Verifiers verify | **PASS** | Mechanical + audit-only kinds distinguished |
| Evidence proves | **PASS** | Joins audit IDs; runtime gate checks linkage |
| Audit records | **PASS** | Append-only JSONL |

### 7.2 Security controls (verified by tests)

| Control | Status |
| --- | --- |
| Model output ≠ authority | **PASS** — `test_injected_capabilities_stripped`, schema validation |
| MCP descriptors ≠ permissions | **PASS** — `mcp_gateway.py` empty permissions; poison tests |
| Approval replay refused | **PASS** — 409 on second decide |
| Fingerprint binding | **PASS** — approval spend tests |
| Path traversal guarded | **PASS** — `_confine()` in executors |
| Bounded plans/loops | **PASS** — MAX_TASKS=8, MAX_NODE_EXECUTIONS=200, MAX_LOOP_ITERATIONS=50 |
| Clarification fail-closed | **PASS** — CLARIFICATION_CONFIDENCE=0.6 deterministic |

### 7.3 Central Agent findings

#### Finding CA-1: Dual approval surfaces in Home UI
- **Severity:** HIGH
- **Evidence:** `HomeSections.tsx:7–8` polls `useFabric` (:4319) for pending approvals; `AskAuraHero.tsx` resolves approvals via `centralAgentClient.approve` (:4320). Agent-parked approvals on :4320 will not appear in Home ACTIVE section.
- **Why it matters:** User may miss agent approvals or attempt to decide through the wrong ledger.
- **Owner:** Agent 3 (UI)
- **Recommended action:** Home ACTIVE approvals must union or route by source; agent approvals only via `centralAgentClient.pendingApprovals()`.
- **Blocks migration?** YES (UX correctness)

#### Finding CA-2: Python API lacks wire-contract gates
- **Severity:** MEDIUM
- **Evidence:** `api.py:74,115` sets `access-control-allow-origin: *`; no `/shutdown` header gate; no OPTIONS handler found.
- **Why it matters:** Weaker CORS than TS (`wire-contracts.md §2`); packaged Tauri builds cannot preflight to :4320 (`centralAgentClient.ts:28–29`).
- **Owner:** Agent 2 (Central Agent backend)
- **Recommended action:** Mirror TS CORS regex; add OPTIONS; add shutdown gate before production.
- **Blocks migration?** YES (packaged desktop)

#### Finding CA-3: SSE reconnect / sequence semantics undocumented
- **Severity:** MEDIUM
- **Evidence:** `api.py` SSE via `EventBus.subscribe_stream`; no sequence numbers or Last-Event-ID handling found in client (`centralAgentClient.ts:230–258`).
- **Why it matters:** Stream loss between frames may leave UI stale; persisted reload is authoritative but UX gap exists.
- **Owner:** Agent 2 + Agent 3
- **Recommended action:** Document reconnect contract; client should reload session on `stream.lost`.
- **Blocks migration?** NO (degraded UX)

#### Finding CA-4: Model-proposed `system.modify` survives intent compilation
- **Severity:** LOW
- **Evidence:** `test_security_boundaries.py:57–66` — well-formed injected capability IDs pass compilation; blocked later by manifest/discovery.
- **Why it matters:** Defense-in-depth relies on downstream gates; acceptable but worth monitoring.
- **Owner:** Agent 2
- **Recommended action:** Consider stripping non-manifest capabilities at intent compile time.
- **Blocks migration?** NO

---

## 8. Workflow audit

#### Finding WF-1: Two workflow runners, one desktop product
- **Severity:** CRITICAL
- **Evidence:** TS `WorkflowRunner` (`runner.ts:1–24`) is entry for Run button, webhooks, automation; Python `WorkflowEngine` serves Central Agent only.
- **Why it matters:** Violates "ONE CANONICAL WORKFLOW RUNNER" invariant during migration.
- **Owner:** Agent 1 (Python backend) + Agent 2 (convergence design)
- **Recommended action:** Strangler route map — all triggers must converge before TS retirement.
- **Blocks migration?** YES

#### Finding WF-2: Python workflow engine supports limited node set
- **Severity:** MEDIUM
- **Evidence:** `engine.py:3–8` — pure/control/governed subset; agent nodes not in Python engine.
- **Why it matters:** Central Agent-compiled workflows cannot execute in-graph agent steps on Python path yet.
- **Owner:** Agent 2
- **Recommended action:** Explicit capability matrix documenting which node types route where.
- **Blocks migration?** YES (feature parity)

#### Finding WF-3: Resume chain semantics aligned
- **Severity:** INFO (positive)
- **Evidence:** Scenario G passes; `supersededBy` chain documented in API docs.
- **Owner:** —
- **Blocks migration?** NO

---

## 9. Automation audit

#### Finding AU-1: No Python automation engine or scheduler
- **Severity:** HIGH
- **Evidence:** `grep AutomationEngine backend/` → no matches; `automation.py` is store-only; TS `AutomationScheduler` (`scheduler.ts:1–28`) owns cron/missed-run policy.
- **Why it matters:** Scheduled/background intents cannot execute on Python-only stack; automation rules still TS-only.
- **Owner:** Agent 1
- **Recommended action:** Port engine + scheduler per migration Phase 7; preserve missed-run-never-executes invariant.
- **Blocks migration?** YES

#### Finding AU-2: TS automation correctly delegates to single workflow runner
- **Severity:** INFO (positive)
- **Evidence:** `automation.ts:43–57` injects `runWorkflow`; engine never executes graphs directly.
- **Owner:** —
- **Blocks migration?** NO

#### Finding AU-3: Automation cannot auto-approve (verified design)
- **Severity:** INFO (positive)
- **Evidence:** `RuleBuilder.tsx:642`, `automationClient.ts:19` — auto-execute parks at `awaiting-approval`.
- **Owner:** —
- **Blocks migration?** NO

---

## 10. Security findings

| ID | Finding | Severity | Evidence | Owner | Blocks? |
| --- | --- | --- | --- | --- | --- |
| SEC-1 | Dual backend concurrent write to `~/.aura` | **CRITICAL** | Both services use `AURA_HOME`; no file locking | Agent 1 | YES |
| SEC-2 | Python CORS wildcard on agent API | **MEDIUM** | `api.py:74` | Agent 2 | YES (Tauri) |
| SEC-3 | No `/shutdown` gate on Python API | **LOW** | `api.py` routes | Agent 2 | NO |
| SEC-4 | TS production still has full process primitive | **INFO** | `exec/process.ts` — allow-lists intact | Agent 1 | N/A |
| SEC-5 | Python git executor uses subprocess with fixed argv | **INFO** (positive) | `executors.py:155` — no shell | Agent 1 | NO |
| SEC-6 | Secrets redaction gate passes | **INFO** (positive) | Runtime check 8/12 | Agent 2 | NO |

No evidence of client-side policy decisions or renderer-side process execution was found. Tauri IPC remains six non-shell commands per master handoff.

---

## 11. Contract mismatches

| Mismatch | Frontend | Backend | Severity |
| --- | --- | --- | --- |
| **Service port** | `aiClient` → 4319, `centralAgentClient` → 4320 | Two services | HIGH |
| **Approval ledger** | `fabricClient` vs `centralAgentClient.pendingApprovals` | Separate ledgers | HIGH |
| **Health payload** | Shell expects TS `/health` shape | Python returns `{ok, service}` | MEDIUM |
| **Wire contracts doc** | Says port 4319 only | Agent API on 4320 additive | INFO |
| **Migration ledger** | Fabric invoke NOT-STARTED | invoke.py exists + verified | INFO |
| **Outcome vocabulary** | `centralAgentClient.ts` includes `needs-clarification`, `unsupported` | Matches `contracts/agent.py:244–246` | PASS |
| **CORS / preflight** | Dev proxy works; Tauri direct fetch | Python lacks OPTIONS | HIGH |

---

## 12. Missing verification

| Gap | Status | Notes |
| --- | --- | --- |
| Full pytest suite green | **2 FAILURES** | `test_persistence_invariants.py` (see PF-1) |
| UI workflow/automation/agent suites | **NOT RUN** | AI service not running this session |
| `verify-providers` | **Known pre-existing failures** (10) | Per master handoff |
| `ui-approval-test` | **Known pre-existing failures** (17) | Mission Control unreachable |
| End-to-end dual-service integration test | **MISSING** | No suite proves 4319+4320 coexist safely |
| Tauri-spawned Python agent | **NOT IMPLEMENTED** | Manual start only |
| `ui-central-agent-home.mjs` | **NOT RUN** | Requires :4319 + :4320 + :1420 |
| TypeScript backend retirement gate | **NOT STARTED** | Phase 13 |

---

## 13. Severity-classified findings (complete register)

### CRITICAL

#### PF-1: WorkflowRunStore default ID generator collides within a process
- **Finding:** Default `_id_gen = lambda p: f"{p}-{os.getpid()}"` (`runs.py:67`) produces identical IDs for all runs in the same process (e.g. `run-77215`).
- **Evidence:** `pytest tests/unit/test_persistence_invariants.py` — 2 failures; creating 203 runs yields `len(summaries)==1` not 200; index rebuild sees 1 entry not 2.
- **Why it matters:** Run records overwrite each other; retention pruning, resume chains, and audit correlation are corrupted. Cross-lang byte-parity tests use injected deterministic id_gen and may mask this in differential suites.
- **Owner:** Agent 1 (Python backend)
- **Recommended action:** Replace default with UUID-based generator matching TS `genId('run')` semantics; re-run persistence invariants.
- **Blocks migration?** **YES**

#### WF-1: Two canonical workflow runners (see §8)

#### SEC-1: Concurrent `~/.aura` writers (see §10)

### HIGH

#### CA-1: Dual approval surfaces in Home UI (see §7.3)

#### AU-1: No Python automation engine (see §9)

#### DS-1: Dual HTTP backends without unified lifecycle
- **Finding:** Tauri spawns TS only; Python Central Agent requires manual start.
- **Evidence:** `service.rs` — port 4319 only; `scripts/ui-central-agent-home.mjs:11–12`.
- **Owner:** Agent 1 + Agent 3
- **Recommended action:** Tauri service supervisor must health-gate both services or strangler-proxy agent routes through :4319.
- **Blocks migration?** **YES**

#### DS-2: Duplicate agent runtimes
- **Finding:** TS in-graph agent (`workflow/agent/*`) and Python Central Agent coexist.
- **Evidence:** Both wired; TS still used by workflow Run button agent nodes.
- **Owner:** Agent 2
- **Recommended action:** Publish convergence plan — which runtime owns which trigger surface.
- **Blocks migration?** **YES**

### MEDIUM

#### CA-2: Python API wire-contract gaps (see §7.3)

#### CA-3: SSE reconnect semantics (see §7.3)

#### WF-2: Limited Python node catalogue (see §8)

#### DOC-1: Master handoff describes pre-Central-Agent architecture
- **Owner:** Agent 4 / doc maintainers
- **Blocks migration?** NO

### LOW

#### CA-4: Intent compilation passes some injected capability names (see §7.3)

#### SEC-3: No Python shutdown gate (see §10)

### INFO

#### Positive: Central Agent vertical slice RUNTIME VERIFIED (12/12)
#### Positive: Differential suites 0 divergences (~630 cases per migration doc)
#### Positive: Automation engine does not bypass policy (TS design intact)
#### Positive: Python authority checker does not decide — mirrors policy only
#### Positive: MCP gateway enforces empty permissions for external tools

---

## 14. Dependency map (simplified)

```
apps/desktop
 ├── aiClient ──────────────► packages/ai-service (TS) ──► @aura/capability-fabric
 │                              ├── workflow/runner ──► workflow/engine
 │                              ├── workflow/agent ──► fabric.invoke
 │                              └── automation.ts ──► @aura/automation
 ├── centralAgentClient ────► backend/aura/api.py
 │                              └── central_agent/service
 │                                   ├── intent, planner, authority
 │                                   ├── execution ──► workflow/engine OR fabric/invoke
 │                                   └── evidence ← audit
 └── fabricClient ──────────► packages/ai-service (TS fabric hosts)

backend/aura (Python)
 ├── policy ◄── fabric/invoke
 ├── approvals ◄── fabric/invoke
 ├── audit ◄── fabric/invoke
 ├── persistence/* ◄── workflow/engine, executors
 └── contracts ◄── all Python subsystems

packages/capability-fabric ◄── differential oracle ──► backend/aura/policy, fabric
```

---

## 15. Agent ownership summary

| Surface | Owner | Auditor action |
| --- | --- | --- |
| Python backend / persistence / fabric port | Agent 1 | Report only — **NOT MY WORK** |
| Central Agent intelligence / API / MCP | Agent 2 | Report only — **NOT MY WORK** |
| React desktop / clients / UX | Agent 3 | Report only — **NOT MY WORK** |
| Verification scripts / docs / audit | Agent 4 | This document |

---

## 16. Recommended next actions (audit-only — not implemented)

1. **Agent 1 — CRITICAL:** Fix `WorkflowRunStore` ID generation; restore persistence invariant tests.
2. **Agent 1 + 2:** Publish strangler map for single workflow runner convergence.
3. **Agent 2:** Align Python API with `wire-contracts.md` CORS/OPTIONS/shutdown gates.
4. **Agent 3:** Fix Home approval source split (CA-1); ensure packaged build path for :4320.
5. **Agent 1:** Implement Python automation engine before claiming automation migration.
6. **All:** Add integration test proving safe dual-service OR enforce mutual exclusion on `AURA_HOME` writes.
7. **Agent 4:** Re-run UI verification suites once `:4319` service is available.

---

*End of audit. No repository source files were modified during this inspection.*
