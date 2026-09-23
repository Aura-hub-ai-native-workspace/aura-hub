# AURA Industrialization — Status Report

**Date:** 2026-09-11 · **Mode:** audit completion, no implementation.
Labels used below: **VERIFIED** (observed this session), **INFERRED**
(derived from observed evidence), **UNKNOWN** (could not verify),
**ENV-LIMITED** (blocked by environment, not by architecture).

## Current Repository State (VERIFIED)

- Branch: `feature/enhancement-of-extended-environment`
- HEAD: `a87cc7b` ("feat(desktop): refine AURA agent workspace UI")
- `main`: `2473659` — current branch is +35/-0 in earlier census; HEAD has
  since advanced two commits (network allowlist, workspace UI refine).
- Remote: `origin` (Aura-hub-ai-native-workspace/aura-hub); 66 refs;
  tags `archive/central-agent-a4f86c8`, `v0.1.0`–`v0.1.5`.
- Working tree: mixed own-phase WIP + concurrent-agent WIP (listed
  §Current Branch and Working Tree). No reset/clean/restore performed.
- Deleted only: `/mnt/storage/aura-hub/.aura-suite.txt` — VERIFIED
  generated (untracked pytest progress log, 1886 bytes, not in git).

## Current Branch and Working Tree (VERIFIED)

Modified (own industrialization line): `.gitignore`, `centralAgentClient.ts`,
`AgentPhaseStrip.tsx`, editor Ctrl+I files, `AiWorkspace.tsx`,
`backend/aura/api/*`, `central_agent/*` (context, evidence, execution,
intent, model_routing, service, session), `contracts/agent.py`,
`fabric/*`, `test_api_closure.py`, `AURA_CENTRAL_AGENT_API.md`,
plus new: `correlation.py`, `editor_context.py`, `useAgentConversations.ts`,
`agentEventStream.ts`, Phase 1/2 + audit docs, `ui-agent-events.mjs`,
`test_{correlation,approval_binding,hygiene,event_spine,answer_streaming,ctrl_i_editor_context}.py`.

Concurrent-agent files present and UNTOUCHED this session (VERIFIED via
`git status`, no edits by this agent):
`backend/aura/environment/software/`,
`backend/tests/unit/test_software_discovery.py`,
`apps/desktop/src/environment/AuraEverything.tsx`,
`apps/desktop/src/workspace/AddWorkerPanel.tsx`,
`backend/aura/api/server.py` (shared — see note),
`apps/desktop/src/environment/environmentClient.ts`,
`apps/desktop/src/screens/WorkspaceScreen.tsx`,
`apps/desktop/src/screens/workspace/neon/LeftControlPanel.tsx`.

Note (INFERRED): `server.py`, `WorkspaceScreen.tsx`, `LeftControlPanel.tsx`
are shared-surface files with interleaved changes from both lines; any
future merge must diff hunk-by-hunk, not file-by-file.

## Test Status (VERIFIED with qualification)

As reported: **1,264 passed, 25 skipped, 0 failed, 0 errors** — with the
mandatory qualification: **13 real-worker E2E tests excluded**
(`tests/central_agent/test_final_reverification.py`,
`tests/central_agent/test_real_spine_e2e.py`). The report must NOT say
"all green" without this line.

## Excluded E2E Tests (VERIFIED root cause, bounded diagnosis)

- **Why they hang:** both files read the agent SSE stream with plain
  `client.get(...)` waiting for a terminating `data: [DONE]`
  (e.g. `test_real_spine_e2e.py:78-82`,
  `test_final_reverification.py:376-380`). Phase 2 intentionally made
  `/agent/sessions/{id}/events` a never-terminating live-follow stream,
  so these reads block forever. Confirmed with a bounded 100s run
  (exit 124, deterministic).
- **Not the cause:** worker subprocess leak, provider wait, process wait,
  stale oracle bundles — none evidenced; the hang precedes any of those
  paths (it blocks on the first events GET).
- **Classification:** test reliability defect (P2), induced by an
  intentional contract change. Production behavior is correct per
  `docs/architecture/LIVE-EVENT-CONTRACT.md`.
- **Fix direction (not implemented per stop condition):** migrate these
  reads to bounded socket/live-server pattern (as done for
  `test_api_closure.py::test_agent_events_stream_replays_tail` and
  `tests/unit/test_event_spine.py`); do NOT restore `[DONE]`.

## Full Branch Status (VERIFIED)

- 66 refs enumerated; audit `docs/audit/branches.json` covers all but 5,
  and re-check shows all 5 have **zero unique commits vs `main`**:
  `backup/pre-merge-20260830-200622-integration-v0.1.5` (F),
  `bugfix/qa-runtime-pass` (F), `origin/feature/workspace-execution-environmentV2`
  (UNKNOWN content, ahead 0 — merge-base only, no unique work),
  `fix/context-contract-types` (package-lock sync, F),
  local `enhance/workspace-ui` missing (remote copy already triaged G).
- No branch outside the audit holds unintegrated unique work. Branch
  coverage is now complete.

## Current Subsystem Inventory (VERIFIED from source)

Desktop/Tauri (`apps/desktop/src-tauri`, 10 scoped commands) ·
React workspace (`screens/`, `workspace/`, `shell/`) · editor + Monaco
(`editor/`, incl. `aurabug/`) · Central Agent
(`backend/aura/central_agent/`, 27 modules incl. `correlation.py`) ·
Context Fabric dual (TS `context/` + agent `ContextBundle`) ·
Capability Fabric dual (py canonical for agent, TS for legacy service) ·
policy (`policy/engine.py` + `policy.ts`) · approval
(`approvals/` ledger) · providers (TS 13 adapters + `RoutedModelPort`) ·
execution environment (`connected-environment`, node registry, proven
opencode worker) · **software discovery** (`backend/aura/environment/software/`,
  concurrent-agent line, UNTRIED by this agent) · worker discovery
(`useWorkers.ts`, `workerClient`) · Workflow Engine dual · Mission
Control · AuraBug · Ctrl+I (`useAiAction.ts`) · Project Ask AURA
(`useAgentConversations.ts` + `AiWorkspace.tsx`) · Home Ask AURA
(`AskAuraHero.tsx`, `AskAuraChatbox.tsx`) · persistence (atomic JSON
stores) · observability (audit JSONL, EventBus+seq, telemetry) ·
testing (unit/api/integration/differential/golden + Playwright smoke
`scripts/ui-agent-events.mjs` + vitest `agentEventStream.test.ts`) ·
packaging/CI (per-OS Tauri, tag-gated publish) · cross-platform
adapters + tests.

## Existing Industrial Audit Status (VERIFIED)

All seven artifacts exist and are current:
`docs/AURA-INDUSTRIAL-ARCHITECTURE-AUDIT.md`,
`docs/audit/{branches,subsystems,gaps,workstreams,architecture-contracts,roadmap}.json`.
Branch coverage re-verified complete (above). Subsystem list extended
with software discovery + worker discovery + GUI smoke + vitest harness
(this report). Gap register stands; G-09 corrected: `graphify-out/`
live files stay tracked **by repo convention** (`.gitignore` comment),
only caches/backups ignored.

## Confirmed Industrial Gaps (VERIFIED)

P1-A…P1-F implemented (deprecated host, exact approval binding,
correlation IDs, telemetry, hygiene, regression tests) except:
G-03 shared context (P9, untouched), G-04 provider bridge (documented
only), G-06 live-follow (done in Phase 2 — audit now stale on this
point, update recommended), G-07 branches, G-08 docs sprawl (growing),
G-10 GUI harness (done for agent surfaces). New: excluded-E2E test
migration (P2, §Excluded E2E Tests).

## Proposed Three-Slot UI Assessment (VERIFIED from code)

The proposed "fixed three-slot workspace UI" is **already implemented**
in the working tree — there is nothing to build:

- `apps/desktop/src/workspace/hubStore.ts:34` — `ACTIVE_TOOL_SLOTS = 3`,
  documented as a workspace property; `add()` refuses a 4th tool;
  hydrate caps legacy layouts on read without deleting behind the user.
- `apps/desktop/src/workspace/toolSlots.ts:55-63` — `deriveToolSlots`
  always returns exactly 3 slots; extras ignored, missing drawn empty.
- `apps/desktop/src/screens/workspace/neon/OrchestrationGraph.tsx:25-33,330-333`
  — fixed row + padding; the old `tools.slice(0, 3)` collapse is named
  as the already-fixed defect.
- Consumers: `AddNodeDialog`, `WorkspaceScreen`, `OrchestrationGraph`
  only — presentation/layout, no execution/policy/capability consumer.

Answers to the 10 questions:
1. **Why three?** Workspace property matching the fixed graph row; a
   fourth entry would be unshowable/unremovable (hubStore.ts:28-33).
2. **Four or more?** `add()` returns false; hydrate caps on read;
   `deriveToolSlots` ignores extras — silent at data level, honest at
   UI level (`hasFreeSlot` gates the add affordance).
3. **Selected vs active?** `toolSlots.ts:39-48` — ACTIVE = store's own
   `connected` flag; SELECTED = placed with no machine claim;
   UNAVAILABLE = probe absence/verdict; EMPTY = no id. SELECTED makes
   no claim by design.
4. **Availability source of truth?** `environmentStore` live probes
   (`hubStore.ts:10-18`); layout never persists status.
5. **After restart?** Layout rehydrates from `aura.workspace.layout`;
   nodes show `unknown`/re-probed state, never cached green.
6. **Worker disappears?** Slot keeps its id; state recomputes to
   UNAVAILABLE with reason — never vanishes silently
   (`toolSlots.ts:19-21`).
7. **Selected worker unavailable?** Rendered UNAVAILABLE with the probe
   verdict; no execution path reads the store, so nothing dispatches
   differently.
8. **Execution authority?** Unaffected — zero capability/policy/fabric
   consumers of hubStore/toolSlots (VERIFIED by grep).
9. **Presentation only?** Yes — layout + availability restatement.
10. **Tests?** None found for hubStore/toolSlots/OrchestrationGraph
    (UNKNOWN — no test file references them; vitest harness now exists
    to add some cheaply).

Classification: **NOT REQUIRED as implementation** (already shipped).
Residual test gap for the slot logic is P4 (pure presentation, honest
empty states, no authority impact).

## Priority Ranking

| Item | Sev | User | Sec | Rel | Arch | Risk | Verdict |
|---|---|---|---|---|---|---|---|
| Excluded-E2E test migration | P2 | med | low | high | med | low | **TODAY** |
| G-01 legacy API host (deprecated, verify script still uses) | P2 | low | low | med | med | low | TODAY |
| G-04 provider bridge story | P2 | high | med | med | med | med | NEXT |
| G-03 shared context (P9) | P2 | med | low | med | high | high | NEXT (design first) |
| G-10 GUI harness gaps (Ctrl+I dialog) | P2 | med | low | med | low | low | NEXT |
| G-07 branch convergence | P2 | low | low | low | med | med | NEXT |
| G-08 docs sprawl | P3 | low | low | low | low | low | LATER |
| G-06 live-follow follow-ups | P3 | low | low | low | low | low | LATER |
| Three-slot UI implementation | — | — | — | — | — | — | **NOT REQUIRED** (done) |
| Three-slot UI unit tests | P4 | low | none | low | none | none | LATER (optional) |

## TODAY / NEXT / LATER

- **TODAY:** migrate the 13 excluded E2E reads to bounded live-server
  pattern; confirm `verify_central_agent.py` still passes with the
  deprecated host (or migrate it to `create_app` + close G-01).
- **NEXT:** provider bridge story; Ctrl+I dialog smoke; branch archival
  per `branches.json`; P9 context design (no code yet).
- **LATER:** docs consolidation; optional slot-logic unit tests.
- **NOT REQUIRED:** three-slot workspace UI (verify: already shipped).

## Phase 1.1 Implementation Record (2026-09-11)

- **Changed files:**
  `backend/tests/central_agent/sse_live.py` (new: bounded live-SSE
  helper — ephemeral uvicorn boot, socket reads, terminal-event stop,
  deadline, deterministic close, session-correlated diagnostics),
  `backend/tests/central_agent/__init__.py` (new: package marker for
  relative imports),
  `backend/tests/central_agent/test_real_spine_e2e.py` (migrated 1
  hanging SSE test to live-server bounded reads; `?since=` mapped to
  the documented `?after=` cursor),
  `backend/tests/central_agent/test_final_reverification.py` (migrated
  1 hanging SSE test incl. `?after=` + Last-Event-ID cursor proofs and
  second-server restart persistence),
  `backend/tests/central_agent/test_sse_live_helper.py` (new: 5 helper
  regression tests),
  `backend/scripts/verify_central_agent.py` (`api_surface_live` migrated
  off `build_default_api` onto `create_app`; G-01).
- **Root cause:** plain `client.get()` against the live-follow
  `/agent/sessions/{id}/events` route, which intentionally never
  terminates (LIVE-EVENT-CONTRACT.md); TestClient cannot even open such
  a stream. TEST RELIABILITY DEFECT, not a production defect.
- **Production code changed:** no. The route, bus, contracts, ledger,
  and execution paths are untouched this task.
- **Focused test result:** 13/13 previously-excluded tests PASS
  (4 spine + 9 reverification); 5/5 helper tests PASS.
- **Full suite result:** 1292 collected across unit/api/fabric/
  workflow/stores/integration/mcp/providers/central_agent — 0 failed,
  0 errors (25 skipped, pre-existing ENV skips retained).
- **Real-worker E2E result:** included above (live opencode worker legs
  inside the migrated files execute for real; no mocks added).
- **G-01 verification:** `verify_central_agent.py` 10/12 — the migrated
  API check PASSES on `create_app` (was failing on pristine HEAD with
  `build_default_api`); zero production callers of the deprecated
  factory remain. The 2 other failures
  (`approval_park_and_single_use_spend`, scenario A —
  "no CapabilityFabric wired into FabricConfig") reproduce identically
  on pristine HEAD via isolated worktree: PRE-EXISTING verify-script
  setup defects (FabricConfig built without `fabric=`), out of scope,
  recorded as P2 test-setup debt, not G-01.
- **Remaining limitations:** TestClient still cannot hold infinite SSE
  (harness limitation, documented in-test); automation node-driver
  fixture name mismatch persists (ENV-LIMITED, pre-existing).
- **P2 status:** the excluded-E2E hang is CLOSED (suite runs bounded,
  no exclusions); G-01 is CLOSED for the factory migration (deprecation
  + zero callers + passing check). G-01-adjacent script-setup defects
  remain OPEN as new P2 test-setup debt.

## Phase 1.2 Implementation Record (2026-09-11)

- **Changed files:**
  `backend/aura/central_agent/__main__.py` (`build_fabric_config`
  gains optional `policy_config`, synced onto the live fabric via the
  established `set_policy(sanitized_policy())` convention),
  `backend/scripts/verify_central_agent.py` (`strict_cfg` built through
  the canonical factory; scenario-A assertion aligned to the documented
  honest-null-check contract),
  `backend/tests/unit/test_fabric_config_paths.py` (new: 5 construction
  contract tests).
- **Root causes:**
  (1) `strict_cfg` was a hand-rolled `FabricConfig` without a live
  `fabric=` instance, so the first governed invoke raised
  "no CapabilityFabric wired" — a setup defect, since the scenario
  intends the normal configured path with strict policy.
  (2) Scenario A asserted `audit verified is True` for `git.status`,
  which has no executor-level verifier BY DESIGN (parity with the TS
  reference: "where no check exists the executor omits `verify`");
  the Fabric honestly records a null check while agent-level
  exit-code verification passes.
- **Contract decisions:** strict gate checks use the canonical factory
  (no duplicate factory); the null-check stays as-is (no production
  verification semantics changed to satisfy a script).
- **Verification result before:** 10/12. **After:** 12/12 PASS
  (`python3 backend/scripts/verify_central_agent.py`).
- **Focused test result:** 5/5 new path tests PASS; agent/fabric/
  approval/api regression subset green (75 tests, exit 0).
- **G-01 verification script: 12/12 PASS.** G-01 implementation
  migration: CLOSED. Remaining verify-script-adjacent debt: none open.
- **Remaining limitations:** automation node-driver fixture mismatch
  persists (ENV-LIMITED, pre-existing, untouched).

## Recommended Next Implementation

[DONE Phase 1.1 — see record above. Next:](#) fix the two
pre-existing verify-script setup defects (`strict_cfg`/scenario-A
`FabricConfig` without `fabric=`), then NEXT items (provider bridge,
Ctrl+I dialog smoke, branch archival).

[DONE Phase 1.2 — 12/12, see record above. Next:](#) provider bridge
story, Ctrl+I dialog smoke, branch archival per `branches.json`;
P9 context design (no code yet).

## Explicit Non-Goals

Three-slot UI build; Context Fabric rewrite; provider unification;
branch merges; Workflow Engine rewrite; touching concurrent-agent
files (`environment/software/`, `AuraEverything.tsx`,
`AddWorkerPanel.tsx`, neon run panels); deleting legacy `/stream`,
`/code/action`, or the deprecated host.
