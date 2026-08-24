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
| Policy engine (stricter/floors/sanitize) | 2 | policy.ts | NOT-STARTED | differential battery planned | NOT-STARTED | needs P1 harness extension |
| Approvals (pending-only, single-use, binding) | 2 | approvalStore.ts + fabric.ts spend path | NOT-STARTED | planned | NOT-STARTED | — |
| Audit store (append-only JSONL, caps) | 2 | auditStore.ts | NOT-STARTED | planned | NOT-STARTED | — |
| Exec settle() + allow-lists + TIMEOUT=124 | 2/5 | exec/process.ts | NOT-STARTED | process-timeout mirror planned | NOT-STARTED | — |
| Secrets redaction + providers envelope | 2/9 | secrets.ts, credentialStore.ts | NOT-STARTED | crypto interop test planned | NOT-STARTED | AESGCM interop vs real stores |
| Persistence (~/.aura readers/writers) | 3 | workflow/store, run/store… | NOT-STARTED | golden round-trips exist; live-file tests pending | NOT-STARTED | — |
| Connected environment (catalog/probes) | 5 | connected-environment | NOT-STARTED | platform-verify mirror planned | NOT-STARTED | — |
| Capability Fabric core (invoke pipeline) | 4 | fabric.ts | NOT-STARTED | planned | NOT-STARTED | depends P2 |
| Executors registry | 5 | fabric/executors.ts | NOT-STARTED | executor matrix doc planned | NOT-STARTED | — |
| Workflow engine/runs/versions/dry-run | 6 | workflow/* | NOT-STARTED | verify-workflow-automation is the live gate | NOT-STARTED | depends P4/P5 |
| Automation engine + scheduler | 7 | automation/* | NOT-STARTED | cron golden cases planned | NOT-STARTED | croniter validation vs hand parser |
| Agent runtime (bounds/loop/trace/resume) | 8 | workflow/agent/* | NOT-STARTED | ui-agent suites are live gate | NOT-STARTED | depends P6 |
| Context Fabric | 9 | context/* | NOT-STARTED | view/contract diffs planned | NOT-STARTED | unknown-degradation enables early port |
| Providers/streaming adapters | 9 | provider/* | NOT-STARTED | usage/cancel parity planned | NOT-STARTED | — |
| HTTP/SSE server (all routes, gates) | 10 | server.ts | NOT-STARTED | strangler route map planned | NOT-STARTED | depends all above |
| Pipeline/intelligence suite | 11 | intelligence/*, pipeline.ts | NOT-STARTED | tolerance-based diffs | NOT-STARTED | largest heuristic surface |
| Mission system + satellites | 12 | mission/*, governance… (D2) | NOT-STARTED | deferred | NOT-STARTED | scope per D2 |
| Diagnosis | sidecar | diagnosis/* (D1) | NEVER (proxy only) | SSE contract tests | SIDECAR-PERMANENT | TS compiler API dependency |
| TS retirement | 13 | — | — | full DoD battery | NOT-STARTED | after everything above |

## Current phase summary

**Phase 1 COMPLETE (gate passed).** Suite: `cd backend && python3 -m pytest tests -q`
→ 33 passed. Includes: 6/6 frozen canonicalization vectors; 320 seeded
differential cases vs bundled-real TypeScript with **0 divergences**; all 10
goldens schema-valid, model-valid, and BYTE-stable round-tripped; extras
preservation asserted; Node-format JSON serialization pinned.

## How to run the gates

```bash
cd backend
python3 -m pytest tests/vectors      # frozen digests
python3 -m pytest tests/differential # vs REAL TS bundles (esbuild required)
python3 -m pytest tests/golden       # schema + byte round-trip
python3 -m pytest tests              # everything
```
