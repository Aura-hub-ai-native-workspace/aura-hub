# AURA Industrialization — Phase 1 Report

**Baseline:** `feature/enhancement-of-extended-environment` @ `1d9144e` (audit docs at `docs/AURA-INDUSTRIAL-ARCHITECTURE-AUDIT.md` + `docs/audit/*.json`).
**Scope:** P1-A…P1-F only. No context convergence, no provider unification, no workflow unification, no neon UI, no legacy-path deletion.

## Baseline

80-test backend slice green before changes (agent slice, cancellation, Ctrl+I, approvals, audit, API closure). `tsc` + Vite build green. Working tree carried pre-existing WIP (Tauri shell, agent migration, governance, uv.lock, package.json) — all preserved untouched.

## Changes

### P1-A — Canonical API host
`create_app` (Starlette) confirmed canonical — it is already the sole alias target (`create_api_server` delegates to it) and the only production entry (`scripts/serve_central_agent_api.py`). `build_default_api` kept as a **deprecated compatibility wrapper** (emits `DeprecationWarning`, docstring names the canonical factory) because `backend/scripts/verify_central_agent.py:240` still drives its stdlib threading host and `AgentApiServer` is used directly by `test_milestone3_hardening.py`. Stale doc pointer in `AURA_CENTRAL_AGENT_API.md` corrected.

### P1-B — Approval exact-ID correlation
- New `CentralAgent.check_approval_binding()`: session must be parked; approval id must be in the session's own evidence ids (exact path), else project match + parked-task match on legacy rows (never guessing). Runs **before** `ledger.decide`, so mismatches record nothing.
- Both approve routes (Starlette + legacy host) enforce it → 409 on cross-session, cross-project, unknown, non-parked, or already-decided approvals. `resume()` failure modes now map to 409 instead of 500 on the Starlette host.
- Frontend: removed both `pendingApprovals()[0]` fallbacks (`useAiAction`, `useAgentConversations`); missing evidence id is now a deterministic error state. `pendingApprovals` remains only for exact-id lookup in approval gates.
- Finding: `resume()` already spent grants exclusively from the session's own evidence — the binding was sound at spend time; the hole was decision-recording without binding, now closed.

### P1-C — Correlation IDs
New `central_agent/correlation.py` (`req-`+12hex, generated server-side, validated at boundaries). One id per leg, returned in every leg response (+ `X-Aura-Request` header), injected into all `AgentEvent` payloads, `ExecutionOutcome.request_id`, invocation contexts, worker assignments, Fabric audit records (both `_settle` implementations), `evidence.requestIds`, and persisted `session.lastRequestId`. No new ids where canonical ones exist (run/worker/evidence reuse `invocationId`/`runId`/composite). Telemetry/observability failures cannot alter authorization (approval/policy paths never read correlation).

### P1-D — Model observability
`RoutedModelPort.telemetry()` (secret-free: ids, models, counts, failures, circuits, last-call `{provider, model, latencyMs, ok, error}`), `GET /agent/model` on both hosts, provider/model/latency on `answer.completed` with honest `"unknown"` fallback. `health_snapshot()` kept as alias for its one caller. Verified no key/header/prompt/completion can enter telemetry structures.

### P1-E — Hygiene
Root `.gitignore` gains `__pycache__/`, `*.py[cod]`, `.pytest_cache/`, `.ruff_cache/`, `.mypy_cache/`; 10 accidentally-tracked `.pyc` files untracked via `git rm --cached` (worktree files intact). Correction to audit G-09: `graphify-out/` live deliverables stay tracked **by repo convention** (see `.gitignore` graphify section) — pinned by test.

### P1-F — Regression tests
New: `test_correlation.py` (11), `test_approval_binding.py` (11), `test_hygiene.py` (3). All Phase-1 contracts covered: factory deprecation (import-clean), exact binding (9 scenarios incl. HTTP 404/409), propagation (events/audit/evidence/worker), telemetry present/honest/secret-free, hygiene both directions.

## Files Modified

Backend: `central_agent/{service,execution,evidence,intent(config unchanged),model_routing,correlation(new),session(untouched)}`, `contracts/agent.py` (`EvidenceBundle.requestIds`), `fabric/{__init__,invoke}.py` (audit fields), `api/{__init__,server}.py` (binding checks, requestIds, `/agent/model`, deprecation).
Frontend: `centralAgentClient.ts` (requestId/modelStatus types), `useAiAction.ts`, `useAgentConversations.ts` (exact-only), `AiWorkspace.tsx` (request id in dev panel), `AgentPhaseStrip.tsx` (unchanged this phase).
Docs: `AURA_CENTRAL_AGENT_API.md`, new `architecture/OBSERVABILITY-CONTRACT.md`, `architecture/RUNTIME-BOUNDARIES.md`, this report. `.gitignore`.

## Architectural Contracts Added
Leg correlation model (§P1-C above); observability contract doc; runtime-boundary doc (context/provider/workflow/API-host dualities made explicit).

## Approval Hardening
Decisions now require session⊃evidence⊃approval binding verified pre-decision on both hosts; UI cannot nominate foreign approvals; replays/stale/denied handled by the single-use ledger (unchanged, now with binding tests).

## Correlation Architecture
`request → request_id → session → legs → approvals/capabilities/workers → evidence`, all joined in audit + events. Overhead: one dict insert + payload key per emit (unmeasurable at desktop scale); approval lookup unchanged (linear ledger scan, tiny n).

## Provider Observability
As §P1-D; `/agent/model` verified live (`configured:false`, `lastCall:null` in keyless env).

## Generated Artifact Hygiene
As §P1-E + 3 pinning tests.

## Tests
- New: 25 tests, all green.
- Full `tests/unit` green; `tests/api` (closure/server/worker) green; `tests/{integration,fabric,central_agent,providers,stores}` green.
- `tests/workflow`, `tests/mcp` green; `tests/automation` has 2 pre-existing ENV-LIMITED errors (node driver fixture `/tmp/opencode/tsref/agentrunner.mjs` absent — file is `stub-agentrunner.mjs`; untouched by this phase, fails identically without it).
- `tsc` + Vite build green. Live E2E (real server): requestId body+header, event/session/evidence propagation, `/agent/model`, 409 paths — 5/5.
- One flaky observation: `test_deviate_park_correct_verify` failed once in a large parallel run (IsADirectoryError), then passed in isolation, paired, and full-combo reruns. Recorded, not attributed to this phase.

## Security Validation
Static sweeps: no provider SDKs / fs / shell in agent UI paths; no first-pending guessing; telemetry structures contain no secret paths. Failure-safety preserved: malformed ids → 409 pre-state; missing approval ref → deterministic error; unknown model → `"unknown"`; telemetry never consulted by policy/ledger.

## Performance
No optimization performed. Correlation adds O(1) map operations per leg/emit; telemetry is a dict snapshot. No measurable change (heuristic submit latency unchanged, single-digit ms in-process).

## Backward Compatibility
Ctrl+I, Ask AURA (project + home), AuraBug, Mission Control, workflows, provider config, sessions, audit data: untouched paths verified via existing suites + grep proofs. `EvidenceBundle.requestIds` and response `requestId` fields are additive (pydantic/TS optional). Legacy host behavior extended compatibly (extra body fields only).

## Remaining Gaps
G-03 (shared context), G-04 bridge story (documented, not built), G-06 live-follow SSE, G-07 branches, G-08 docs sprawl (this report adds one file by mandate), G-10 GUI harness — all carried to NEXT/LATER per roadmap.

## P0/P1/P2/P3/P4 Findings
- P1 (fixed): cancelled-during-stream mislabeled `answer.failed` (prior session; verified still fixed).
- P2: none introduced; G-01..G-05 narrowed as specified.
- P3: first-pending fallback removed (was the audit's P3); snapshot-SSE polling retained (NEXT).
- P4: empty-synthesis noise retained (honest, documented).
- Pre-existing, untouched: automation node-driver ENV failure (2 tests).

## Next Recommended Phase
NEXT items from `docs/audit/roadmap.json`: live-follow events, correlation IDs are done — proceed to operator provider onboarding + Playwright smoke + parity-harness consolidation; then P9 shared context decision.
