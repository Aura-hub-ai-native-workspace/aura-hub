# Python migration status — machine-readable ledger

One row per subsystem × gate. Gates: `SCHEMA + GOLDEN + DIFFERENTIAL +
SECURITY + RUNTIME` (mission §26). Status vocabulary:
`NOT-STARTED · IN-PROGRESS · GATE-PASSED · CUTOVER · RETIRED · SIDECAR-PERMANENT`.

| Subsystem | Phase | TS ref | Python | Parity tests | Gate | Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| Contracts freeze (constitution) | 0 | docs/migration | — | vectors+goldens frozen | **GATE-PASSED** | — |
| Foundations: jsonutil/Node-JSON parity | 1 | persist.ts | `aura.jsonutil` | unit byte-parity (5) | **GATE-PASSED** | — |
| Canonicalization: fingerprintInvocation | 1 | fabric.ts:122 | `aura.canonical` | V1–V4 + 200 diff cases | **GATE-PASSED** | — |
| Canonicalization: graphHash | 1 | versions.ts:95 | `aura.canonical` | G1 + layout-exclusion + 120 diff cases | **GATE-PASSED** | — |
| Contract models (10 schemas) | 1 | TS types | `aura.contracts` | schema-validate + byte round-trip on all goldens | **GATE-PASSED** | — |
| Config home resolution | 1 | persist.ts:22 | `aura.config` | via jsonutil units | **GATE-PASSED** | mkdir deferred to writers by design |
| Policy engine (stricter/floors/sanitize) | 2 | policy.ts | `aura.policy` | 250-case differential + 4 invariant units | **GATE-PASSED** | — |
| Approvals (pending-only, single-use, binding) | 2 | approvalStore.ts + fabric.ts:336–670 | `aura.approvals` | 7 invariant units (decide/consume/named-usability/pending-only restore); end-to-end invoke() differential at P4 | **GATE-PASSED** (P4 e2e pending) | — |
| Audit store (append-only JSONL, caps) | 2 | auditStore.ts | `aura.audit` | 5 units incl. trim-oldest@6000→5000 + truncated-tail tolerance | **GATE-PASSED** | — |
| Exec settle() + allow-lists + TIMEOUT=124 | 2/5 | exec/process.ts | NOT-STARTED | process-timeout mirror planned | NOT-STARTED | — |
| Secrets redaction + providers envelope | 2/9 | secrets.ts, credentialStore.ts | NOT-STARTED | crypto interop test planned | NOT-STARTED | AESGCM interop vs real stores |
| Persistence: WorkflowStore | 3 | workflow/store.ts | `aura.persistence.workflows` | cross-lang op-script: values + FULL tree bytes identical; sanitize torture, duplicate/import, webhook lifecycle | **GATE-PASSED** | — |
| Persistence: WorkflowRunStore (+index/recovery) | 3 | workflow/run/store.ts | `aura.persistence.runs` | checkpoint bytes, supersede/resume chain, reconcile strings, corrupt-index silent rebuild, prune@200 terminal-only | **GATE-PASSED** | — |
| Persistence: WorkflowVersionStore | 3 | versions.ts | `aura.persistence.versions` | publish/ensure-reuse/restore-forward; literal key-order parity (note<graphHash<edges) | **GATE-PASSED** | — |
| Persistence: AutomationStore + schedule-state | 3 | automation/src/store.ts | `aura.persistence.automation` | rule sanitize torture, runs+index rebuild, runStats, schedule-state file round-trip | **GATE-PASSED** | — |
| Routing: resolveNodeFor | 5 | ai-service/fabric/index.ts:74-136 | `aura.fabric.routing` | 6 routing scenarios (unknown/lacks/unsupported×2/no-provider/auto-pick) byte-equal | **GATE-PASSED** | live probing deferred to platform phase |
| Scopes: per-run grants | 5 | fabric/scopes.ts | `aura.fabric.scopes` | narrowing units via policy differential | **GATE-PASSED** | — |
| Executors (fs/terminal/git/http/agent-refusals) | 5 | fabric/executors.ts subset | `aura.executors` | real-effect scenarios: fs triangle+traversal, terminal matrix+timeout124, git commit/branch/diff cycle, governed write spend | **GATE-PASSED** | system.install InstallSpec flow + mission/knowledge internals deferred (stay `unsupported`, truthfully) |
| Capability Fabric core (invoke pipeline) | 4 | fabric.ts (878) | `aura.fabric` | 15-scenario differential incl. events/backoff/audit snapshots; runtime restart story on real files; manifest freshness guard | **GATE-PASSED** | routing (resolveNode) lands with P5 |
| Executors registry | 5 | fabric/executors.ts | NOT-STARTED | executor matrix doc planned | NOT-STARTED | — |
| Workflow engine/runs/versions/dry-run | 6 | workflow/* | NOT-STARTED | verify-workflow-automation is the live gate | NOT-STARTED | depends P4/P5 |
| Automation engine + scheduler | 7 | automation/engine.ts+scheduler.ts | `aura.automation` | conditions matrix · retry backoff/exhaustion · queue serialization · produced linkage · schedule reconcile/tick · park-no-autoapprove via runner seam · dry-run zero-effects · corrupt-index recovery | **GATE-PASSED** | TS engine-level differential deferred (store/schedule parity proven P3); cron TS-differential GREEN (18 parse + 27 next_after oracle vectors; fixed field-count error text, dow range 0-6, bothDaysRestricted emission, day-gate advance); engine-level TS differential still pending |
| Agent runtime (bounds/loop/trace/resume) | 8 | workflow/agent/* | NOT-STARTED | ui-agent suites are live gate | NOT-STARTED | depends P6 |
| Context Fabric | 9 | context/* | NOT-STARTED | view/contract diffs planned | NOT-STARTED | unknown-degradation enables early port |
| Providers/streaming adapters | 9 | provider/* | NOT-STARTED | usage/cancel parity planned | NOT-STARTED | — |
| HTTP/SSE server (all routes, gates) | 10 | server.ts | NOT-STARTED | strangler route map planned | NOT-STARTED | depends all above |
| Pipeline/intelligence suite | 11 | intelligence/*, pipeline.ts | NOT-STARTED | tolerance-based diffs | NOT-STARTED | largest heuristic surface |
| Mission system + satellites | 12 | mission/*, governance… (D2) | NOT-STARTED | deferred | NOT-STARTED | scope per D2 |
| Diagnosis | sidecar | diagnosis/* (D1) | NEVER (proxy only) | SSE contract tests | SIDECAR-PERMANENT | TS compiler API dependency |
| TS retirement | 13 | — | — | full DoD battery | NOT-STARTED | after everything above |

## Current phase summary

**Phases 1–6 COMPLETE · Phase 7 GATE PASSED (automation converges on the canonical runner).**
Suite: `cd backend && python3 -m pytest tests -q` → 79+ passed (automation +
workflow + units + goldens; slow differential batteries green as of Phase 5/6).
The run-workflow action handler calls WorkflowRunner.start_workflow_run with
an automation trigger and NO approvedCapabilities; scheduled ask-user parks;
dry-run creates zero runs/audit/approvals.
Suite: `cd backend && python3 -m pytest tests -q` → 57 passed (differential
suites auto-borrow the main checkout's esbuild when running from a worktree).
Highlights: 6/6 frozen vectors; ~630 TS-vs-Python differential cases with
0 divergences — now INCLUDING a 57-op persistence script whose entire
AURA_HOME tree is byte-identical to the TypeScript oracle's (values, ids,
timestamps, index ordering, recovery rewrites); deterministic clock/PRNG
injection makes generated ids match exactly; retention/prune, corrupt-index
rebuild, interrupted-run recovery and atomic-write residue covered by units.
Remaining P2 item unchanged: settle() process port lands with executors (P5).

## How to run the gates

```bash
cd backend
python3 -m pytest tests/vectors      # frozen digests
python3 -m pytest tests/differential # vs REAL TS bundles (esbuild required)
python3 -m pytest tests/golden       # schema + byte round-trip
python3 -m pytest tests              # everything
```
