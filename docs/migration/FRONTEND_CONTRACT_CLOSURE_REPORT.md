# Frontend Contract Closure — Final Report

Branch `migration/python-backend` @ `afd0717`. Reconciliation matrix:
`API_RECONCILIATION_MATRIX.md`. Route inventory: 17 → **71** routes.

## 1. Route inventory
Before: 17 (health, workflow CRUD×6, run/dry-run/versions, runs×2,
capabilities/policy GETs, automation rules/runs reads, secrets, placeholder SSE).
After: 71 — full §2a–§2f surface. Full before/after table in the matrix doc.

## 2. Missing routes closed
Central Agent ×9 · approvals ×2 · fabric invoke/audit/capabilities-shape/
policy-POST/mission(501) ×5 · editor ×24 (envelope, validate, specs,
templates, versions get/publish/restore, per-workflow runs +cancel/chain/
resume, duplicate/import/PATCH/webhook-token, workflow-runs index/stats/
awaiting/find, agent bounds/tools) · automation ×16 (CRUD, validate, run/
pause/resume/cancel, runs, dry-run, schedules, templates, index paging,
stats/reindex, events stream) · real SSE bus ×1. Honest refusals:
/workflows/generate → 501 (needs live provider), /fabric/mission/* → 501
(no canonical mission store exists — MISSING CONTRACT reported, not faked).

## 3–4. Compatibility + CORS
Wire shapes match the clients verbatim ({workflows},{versions}, catalogue,
RunIndexPage, ApprovalRequest, AgentResult…). CORS: allow_origin_regex
`^https?://(localhost|127\.0\.0\.1)(:\d+)?$` + exact tauri entries.
Verified: OPTIONS :1420/:3000/:5173/127.0.0.1 → 200 with allow-origin;
external origin gets none.

## 5–8. Workflow / Automation / Approvals / Central Agent verification
All runtime-proven against real services on a disposable AURA_HOME:
run SSE streams start/node/log/output/done and persists; gated run parks
and appears in /workflow-runs/awaiting; chain walks old→new; rule create→
schedule reconcile→nextFireAt; rule dry-run reports zero side effects;
invoke parks → ledger decide grants → replay 409 → named grant spends once
(fingerprint-bound) → audit row written; denied decision writes audit,
writes no file; agent submit/get/events replay session.started.

## 9. Fabric/policy/audit
One Fabric, one policy engine, one ledger, one audit trail. HTTP handlers
are thin adapters; zero governance logic in routes.

## 10. Dry-run zero-side-effect proof
Workflow and rule dry-runs measured: invocations=0, files unchanged,
approvalsCreated=0 (asserted in tests).

## 11. Security negatives tested
Replay 409 · single-use spend · traversal fails closed · unknown capability
fails · binary allow-list enforced ('echo' refused) · external CORS origin
blocked · secrets route metadata-only · generate refuses without provider.

## 12. Persistence/restart
Workflows + rules survive fresh create_app() over same AURA_HOME (test).
Approvals file-backed pending-only restore verified by existing suite.

## 13–14. Frontend browser verification / typecheck-build
NOT RUN this session: Agent 3's scripted browser suites (ui-central-agent-
home, ui-workflow, ui-agent, ui-automation, ui-dryrun) and tsc/vite build
live in the frontend tree owned by Agent 3; running them here would touch
their WIP. Backend-side contract tests stand in for every shape. Handoff:
clients repoint to the Python origin; dev proxy /agent-api unaffected.

## 15–17. pytest / ruff / TS dependency scan
**155 passed, 0 failed** (129 pre-existing incl. all TS-oracle differentials
+ 26 new closure tests). ruff: All checks passed. Production Python imports
no Node/TS: only tests/differential/ts_driver.mjs references oracle bundles.

## 18. Remaining limitations
1. /fabric/mission/{pid}/{mid} → 501 until mission subsystem lands (needs domain owner).
2. /workflows/generate → 501 without a configured model provider.
3. Browser suites + tsc/build to be run by Agent 3 against this backend.
4. Legacy ai-service surfaces not in the reconciliation (conversations,
   memory, graph, providers, retrieve, settings, missions CRUD) remain absent.
