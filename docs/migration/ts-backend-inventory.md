# TypeScript backend inventory

**Revision audited:** `141d101` · **Branch at audit:** `feature/workspace-execution-environment` → migration branch `migration/python-backend` cut from the same commit.
**Method:** read-only reconnaissance across sessions 2026-08-23/24: full LOC census (`wc -l` over every package), import-graph scan (`grep -rhoE "from '…'"`), route/SSE enumeration from `server.ts`, on-disk verification against live `~/.aura`, and execution of every non-mutating verification suite.

## 0. Decisive environmental facts

1. **Zero external runtime dependencies.** The entire backend runs on Node builtins
   (`node:http`, `node:fs`, `node:path`, `node:child_process`, `node:crypto`,
   `node:os`) plus workspace-internal `@aura/*` imports. The only npm package
   imported at runtime is `typescript` — by the diagnosis subsystem only
   (5 files). There is no Express, no framework, no DB driver. Migration replaces
   **Node stdlib idioms**, not a framework.
2. **Single-file bundle deployment.** esbuild bundles everything into
   `ai-service.mjs`; the Tauri Rust shell spawns it and health-gates loopback port
   4319 (`/health`). Packaging implications are deferred to cutover phases.
3. **All persistence is flat JSON/JSONL under `~/.aura`** (`AURA_HOME`-overridable).
   No SQLite anywhere; `better-sqlite3` appears only as a *catalogued* node
   capability name, never as code.
4. **Verification suites are language-independent already**: every
   `scripts/*.mjs` suite drives the product black-box over HTTP/browser. They are
   the regression constitution for all phases.

## 1. Package census (LOC = non-blank lines in src/**.ts)

| Package | LOC | Role | Consumed by |
| --- | --- | --- | --- |
| `packages/ai-service` | 27,865 | THE backend: HTTP server, workflow engine, agent runtime, fabric hosts, providers, intelligence, mission, diagnosis, context fabric | desktop shell (spawned bundle) |
| `packages/capability-fabric` | 2,575 | Governed side-effect authority: policy engine, manifest, invoke pipeline, fingerprints | ai-service |
| `packages/automation` | 2,144 | Rules engine + cron scheduler + run stores | ai-service |
| `packages/connected-environment` | 1,319 | Node catalogue + probe runner + resolution | capability-fabric, ai-service |
| `packages/governance` | 3,950 | Governance scans (core/scan, imports, git, codeShape) | ai-service (4 deep imports) |
| `packages/engineering-memory` | 2,132 | Engineering memory store | ai-service |
| `packages/knowledge-fullstack` | 1,766 | FullStack Knowledge Engine graph | ai-service |
| `packages/retrieval` | 1,780 | Retrieval pipeline | ai-service |
| `packages/knowledge-coding` | 1,613 | Coding Knowledge Engine index | ai-service |
| `packages/predictive` | 1,445 | Predictive collectors | ai-service |
| `packages/ui` | 1,480 | Shared UI components (frontend) | apps/desktop |
| `packages/core` | 492 | Frontend store/tokens/nav + appStore WIP | apps/desktop |
| `packages/intelligence` | 416 | Intelligence contracts/helpers | ai-service |
| `packages/runtime` | 87 | Provider-neutral Runtime contract types (pure types) | ai-service, adapters |

Backend-relevant total ≈ **48k LOC**; core execution path ≈ **34k**.

## 2. Subsystem inventory

Legend: DIFFICULTY ∈ EASY/MODERATE/HARD/VERY-HARD · ORDER = phase in
README.md §"Migration phases" mapping.

### 2.1 HTTP server & lifecycle — `packages/ai-service/src/server.ts` (1,379), `start.ts` (62)

| Field | Value |
| --- | --- |
| Entry point | `start.ts` → `serve()`; bundled to `ai-service.mjs`; shell health-gates :4319 |
| Dependencies | workspace.ts facade, node:http, all subsystems below |
| Public contracts | 25 route families (~70 routes), CORS regex (server.ts:46), `x-aura-shutdown` gate (:248–255), `{error}` bodies, camelCase wire |
| Persistence | none directly (delegates) |
| Tests | every `.mjs` suite (HTTP-level); `/shutdown` negative control |
| Side effects | process lifecycle (spawn/kill), port ownership/reuse semantics |
| Difficulty | HARD (router parity + SSE framing + gates) |
| Order | Phase 10 (strangler proxy last flip before it) |

### 2.2 Workspace facade & project registry — `workspace.ts` (1,403), `projects.ts` (135), `profile.ts` (385)

| Field | Value |
| --- | --- |
| Entry | `WorkspaceManager` singleton wired in server.ts:22 |
| Contracts | contextView/contextContract (34–36, 417); projects CRUD; profile derivation |
| Persistence | `~/.aura/projects.json`, profiles, per-project dirs |
| Side effects | mounts indexes, spawns probes via connected-environment |
| Difficulty | MODERATE · Order Phase 5 |

### 2.3 Workflow domain — `workflow/*`

| Files | LOC | Notes |
| --- | --- | --- |
| `engine.ts` | 633 | sequential executor, governor injection, checkpoint-per-node, ports, loops |
| `nodes.ts` | 480 | node specs; `agent` ENABLED at :443; only research-engine disabled :232 |
| `governed.ts`/`governor.ts` | 297+220 | Fabric routing classification (agent→'intelligence') |
| `envelope.ts` | 356 | AuthorityEnvelope computation incl. hosts/offlineCapable/notRequested |
| `dryrun.ts` | 312 | reachability dry-run |
| `versions.ts` | 196 | immutable versions, graphHash (:95–113) |
| `store.ts` | 129 | `~/.aura/workflows/<id>.json` |
| `validate.ts`/`generate.ts`/`templates.ts`/`provenance.ts`/`types.ts` | 137/167/177/147/218 | validation, AI generation, templates, lattice, RunEvent union |

Run records: `workflow/run/store.ts` (427) + `run/types.ts` (308) →
`~/.aura/workflow-runs/<wf>/<run>.json` + `index.json`; caps 200/5000.
Difficulty: engine VERY-HARD-adjacent (HARD); rest MODERATE. Order Phase 6.
Depends on: fabric hosts, envelope, agent runtime, automation triggers (for trigger kind).

### 2.4 Agent runtime — `workflow/agent/{bounds,loop,runner,types}.ts` (228/462/218/240)

Clamped bounds (ceilings 25/600k/200k/5), four-rule tool narrowing with permanent-first
ordering, nine-beat ledger (MAX_BEATS 500/text 4000/transcript 40), stop→port map,
resume transcript + pendingCall bound to approval fingerprint, live SSE beats,
tokenSource honesty. Difficulty HARD. Order Phase 8. Depends on fabric invoke +
providers streaming + envelope.

### 2.5 Capability Fabric core — `packages/capability-fabric/src/*`

`fabric.ts` (878): validate→resolve→policy→approval→execute→verify→audit;
`fingerprintInvocation` :122–138; summarizeInput redaction :147–159; invocationId scheme :140–144.
`policy.ts`: stricter ladder :122–135, four floors :169–240, DEFAULT_POLICY :32–44, sanitizePolicy :76–112.
`manifest.ts`: CapabilityDescriptor catalogue incl. browser/github declared-but-unimplemented;
optional `context` field on agent.delegate (added in 141d101).
Difficulty HARD (security heart). Order Phase 4 (after differential harness exists).

### 2.6 Fabric hosts — `ai-service/src/fabric/*` + exec primitives

| Files | LOC | Content |
| --- | --- | --- |
| `executors.ts` | 762 | filesystem.list/read/write, terminal.execute, agent.delegate, system.install, git.status/diff/branch/commit/push, http.request + internal executors; `withContext` seam :186/:223 |
| `exec/process.ts` | 457 | ONE settle(); SAFE_BINARIES :62, AGENT_BINARIES :82, INSTALLER_BINARIES :102; TIMEOUT_EXIT_CODE=124 :256; path-like rejection |
| `exec/install.ts`/`which.ts` | 314/224 | installer allow-list enforcement; PATH resolution |
| `approvalStore.ts`/`auditStore.ts`/`policyStore.ts`/`scopes.ts` | 48/98/45/115 | pending-only approvals JSON; append-only JSONL audit (5000/6000 caps); sanitized policy file; scope checks |

Difficulty HARD (semantics under cancellation/timeouts). Order Phases 2+5.

### 2.7 Automation — `packages/automation/*` + `automationDryRun.ts` (337) + `automation.ts` (242)

engine 492, types 353, store 322, schedule 283 (hand cron parser), scheduler 233,
triggers 177, templates 170, persist 38 (own config-home copy by design).
Stores: rules/*.json, runs/*.json, runs-index.json, schedule-state.json.
Difficulty MODERATE (cron/timezone parity is the trap). Order Phase 7.

### 2.8 Context Fabric — `ai-service/src/context/{compose,contract,index,types}.ts` (539/269/42/294)

Read-only facade over intelligence loaders; honest `unknown` degradation makes it
portable BEFORE intelligence. Committed at 141d101. Difficulty MODERATE. Order Phase 9.

### 2.9 Providers & secrets — `provider/*` (≈1,806) + `secrets.ts` (264)

12 OpenAI-compatible adapters via raw fetch (base 184, kage7 216, gemini/anthropic 126,
openai/mistral/kimi/groq/cerebras/nvidia/novita/openrouter thin); credentialStore AES-256-GCM
seed chain `sha256(seed+':aura-provider-v2')`, env `AURA_PROVIDER_SECRET`;
errorTranslator; registry/modelValidation/detector. Difficulty MODERATE-HARD (streaming
cancellation + usage accounting). Order Phase 9 (streaming after engine exists).

### 2.10 Intelligence suite — `ai-service/src/intelligence/*` (20 files, 4,741) + satellites

identity 561 (largest), architecture 400, validation 388, contextAssembler 349,
repositoryIntent 348… Heuristic/textual, no ML deps. Consumes governance/knowledge-*/
engineering-memory/predictive/retrieval packages. Difficulty VERY-HARD cumulatively.
Order Phase 11 (pipeline/indexing), satellites Phase 12 per D2.

### 2.11 Mission system — `mission/*` (25 files, ≈3,441)

goalGraph 244, DAG 199, execution engine 601, checkpoints/replay, strategies, quality,
risk. Deep interdependent model. VERY-HARD. Order Phase 12 (D2).

### 2.12 Diagnosis — `diagnosis/*` (22 files ≈1,900) — **PERMANENT TS SIDECAR (D1)**

Imports `typescript` compiler API in 5 files. No Python equivalent. Served over
`POST /projects/:id/diagnose` SSE; Python will proxy to TS sidecar indefinitely.

### 2.13 Cross-cutting

| Concern | Location | Notes |
| --- | --- | --- |
| Config/settings | settings.ts (25), persist.ts (47) | AURA_HOME home; atomic tmp+rename writes |
| Secrets hygiene | secrets.ts, summarizeInput, redaction in beats/runs | names-only surfaces |
| Environment scan | environment.ts (251) + connected-environment probes | platform-verify suite |
| Error handling | json(res,…)`{error}` everywhere | no error middleware layer |
| Logging/actions log | `~/.aura/actions.log`, logs dir | append text |
| Telemetry | none (no external telemetry found) | — |

## 3. Verification assets (regression constitution)

| Suite | Checks | Status @141d101 |
| --- | --- | --- |
| verify-workflow-automation.mjs | 674 | PASS |
| platform-verify / node-attribution / process-timeout / agent-failure-recovery | 35/9/16/22 | PASS |
| node-policy / node-routing / agent-delegate | 25+1/23+1/24+1 | env-dependent fail each (machine policy medium=ask-user) |
| verify-providers | — | 10 pre-existing failures |
| install-verify / packaging-verify | skipped | mutating / needs free port |
| ui-workflow / ui-dryrun / ui-automation / ui-agent / ui-agent-noprovider (Playwright) | 68/72/58/98/40 | PASS |
| ui-approval-test | 17 fails | pre-existing (Mission Control unreachable) |

## 4. Migration classification (capability/node matrix seed)

Every manifest capability is one of:
- **MIGRATED-PYTHON** (target state),
- **SIDECAR-TS** — diagnosis surface only (D1),
- **UNSUPPORTED-BY-DESIGN** — browser.*, github.* (declared, no executors today),
- **NOT-YET-MIGRATED** — everything during transition.

Full executor matrix lands with Phase 4/5 docs; no node may silently disappear.

## 5. Dependency-ordered migration order (evidence-based)

```
P0 contracts (DONE) → P1 foundations → P2 security(policy/approval/audit/exec)
→ P3 persistence formats → P4 fabric core → P5 workspace/env/executors
→ P6 workflow domain → P7 automation → P8 agent runtime
→ P9 context+providers → P10 API strangler → P11 pipeline/intelligence
→ P12 missions+satellites → P13 retire TS (diagnosis sidecar remains)
```
