# AURA Hub — Validation Report

## Run 1 — Phase 0 baseline (2026-10-26)

**Source:** `feat/laya-shadow-planner` @ `0d6c43f` (= `origin/feat/laya-shadow-planner`); uncommitted: 4 regenerated `graphify-out/` files and 81 untracked non-source files. No source was changed for this run.
**Environment:** Linux, Python 3.12.7, Node via the repo's npm workspaces; Ollama with `qwen3.5:2b` available locally.
**Commands:** exactly those in `.github/workflows/ci.yml`. Logs are kept outside the repository in `scratchpad/phase0/`.

| Gate | Command | Exit | Result |
|---|---|---|---|
| Typecheck | `npm run typecheck` | 0 | 0 errors |
| Desktop tests | `npm run test:front` | 0 | 44 files, 412/412 passed |
| Node service tests | `npm run test:service` | 0 | 19 files, 163/163 passed |
| Backend tests (all) | `python -m pytest backend/tests` | **1** | **3168 passed, 75 skipped, 1 failed** (8m30s) |

### The failing test
`backend/tests/integration/test_real_model_e2e.py::TestProviderFailures::test_rate_limit_then_recovery_over_real_wire`

- **What it checks:** after an HTTP 429 from the model endpoint, the retried request succeeds and the *model's* intent reply is used.
- **Assertion:** `i.goal == "show repository status"` (the model's wording).
- **Actual:** `'show my git status please'` (the user's wording).
- **Cause:** the Alpha stabilization in `0d6c43f` made `intent._validated` replace the goal with the user's own words for read-only git status requests. That way the verifier judges the request that was actually made, and a model labelling the turn as conversation can't skip the git run. The test uses the goal as its marker that the model reply arrived.
- **How it slipped through:** before committing, only `tests/unit` (2882 passed) was run, not the full `backend/tests` that CI runs. **The pushed baseline therefore fails CI.** Recorded as finding F-01.
- **Correct fix (not yet applied):** keep the test's purpose by asserting fields only the model reply sets and the git rule leaves alone (`confidence == 0.94`, `requestedOutcome == "branch and changed files listed"`). That still separates "model reply used after 429" from "heuristic fallback". Optionally also assert that the goal is now the user's words. Do not delete or skip the test.

### Other evidence carried forward (same source)
- Full `backend/tests/unit`, `python3 -m pytest -q -p no:cacheprovider tests/unit` from `backend/`: exit 0, 2882 passed, 2 skipped (2026-10-26 21:04).
- Packaged acceptance on the AppImage built 2026-10-26 20:37:02, sha256 `62f621ec3acd9d902bef35f6f488acb55c53aaaec578768bd35a576a923fd413`: **A PASS** (git status answer matches git and the audit; repo unchanged), **B PASS** (foreign services on 4319/4320: identity-mismatch alert, 0 requests received), **C PASS** (takeover: identity mismatch, 0 requests to the foreign service). The package is **unsigned** (`TAURI_SIGNING_PRIVATE_KEY` unavailable).

### Not covered by any run
- No DOM/GUI automated tests: UI behavior is verified only by hand (packaged acceptance) and by logic-level tests.
- 75 backend tests skipped (reasons recorded per test; includes retired oracle-parity suites) and further skip markers in TS suites.
- `npm run build` and the CI release jobs (`desktop-runtime-verify.mjs`, AppImage patching, release verification) were not rerun in this Phase 0 pass. The packaged build above was produced with `npm run desktop:build`.

## Run 2 — Phase 2: F-01 and F-02 (2026-10-26)

**Source:** `0d6c43f` plus uncommitted F-01 (one test) and F-02 (backend) changes. Logs are kept outside the repository in `scratchpad/phase2/`.

| Step | Command | Exit | Result |
|---|---|---|---|
| F-01 single test | `python -m pytest "backend/tests/integration/test_real_model_e2e.py::TestProviderFailures::test_rate_limit_then_recovery_over_real_wire"` | 0 | 1 passed |
| Full backend after F-01 | `python -m pytest backend/tests` | 0 | 3169 passed, 75 skipped, 0 failed |
| F-02 tests before the fix | `python -m pytest backend/tests/unit/test_read_only_requests.py` | 1 | 36 failed, 1 passed (the path-escape test, already safe) |
| F-02 tests after the fix (+ git status, objective acceptance, requested-outcome suites) | `python -m pytest backend/tests/unit/test_read_only_requests.py backend/tests/unit/test_git_status_grounding.py backend/tests/unit/test_objective_acceptance.py backend/tests/unit/test_requested_outcomes.py` | 0 | 87 passed (the F-02 file itself: 38 passed) |
| Full backend, F-02 (37 of the 38 new tests present) | `python -m pytest backend/tests` | 0 | 3206 passed, 75 skipped, 0 failed |
| Full backend, final source (all 38) | `python -m pytest backend/tests` | **1** | **3206 passed, 75 skipped, 1 failed** |

### The one failure in the final run: a flaky test that predates F-02
`backend/tests/central_agent/test_background_lifecycle.py::test_a_crashing_background_thread_still_records_a_failed_result`
- **Symptom:** the session stays `started` for the whole 90 s window instead of recording the injected crash as `orchestration-crashed`.
- **Intermittent:** run alone 5 times on the final source: 1 failed, 4 passed. Each pass takes about 4 s; each failure waits out the full 90 s.
- **Not caused by F-02:** the committed baseline `0d6c43f` was extracted with `git archive` (outside the working tree; the import path was confirmed to be the baseline code, which lacks the F-02 classifier) and run alone 10 times: **2 failed, 8 passed**.
- **Status:** pre-existing intermittent failure in the background-orchestration crash path. Not investigated or fixed in this step (outside F-02's scope). Until it is, CI on this branch can fail at random.

### Not rerun in this step
`npm run typecheck`, `npm run test:front`, `npm run test:service`: no TypeScript or Node source changed in F-01 or F-02 (backend-only edits). Last results: Run 1. No packaged build or packaged acceptance was run for F-02.

## Run 3 — Phase 2: background-lifecycle race fixed (2026-10-26)

**Source:** `0d6c43f` plus uncommitted F-01 (one test), F-02 (backend) and the background-lifecycle fix. Logs outside the repository in `scratchpad/phase2/`.

### Root cause (confirmed by save-order probe `scratchpad/phase2/probe_bg_race.py`)
`submit()` saved the `started` result *after* `_run` had already started the orchestration thread. A fast-ending run (an injected crash) saved its terminal result concurrently; session saves are full-snapshot atomic renames with no ordering between writers, so the last rename wins. The `started` save could land after the terminal save and overwrite it, leaving the session `started`/running forever. This is the intermittent failure named in Run 2.

### Fix (service.py only)
`_run` no longer starts the thread; it registers it in `_pending_orchestration`. `submit()` starts the thread via `_start_pending_orchestration` only after its own `started` save completes (in the `finally` of the submit path); if the leg did not end `started`, the prepared thread is dropped unstarted. Ordering is now always `request:started` then `thread:failed`; 40/40 probe runs pass.

### Regression test
`backend/tests/central_agent/test_background_lifecycle.py::test_a_quickly_ending_run_is_not_overwritten_by_the_started_save` forces the losing write order (`request:started` after `thread:failed`) by waiting on the thread's save; it fails 3/3 on the baseline extraction and passes on the fix. The original crash test (`test_a_crashing_background_thread_still_records_a_failed_result`) was also run 20 times in isolation: 20/20 pass after the fix (baseline: 2 failed in 10).

### Validation

| Step | Command | Exit | Result |
|---|---|---|---|
| Original crash test, 20 runs | `python -m pytest ...::test_a_crashing_background_thread_still_records_a_failed_result` (×20) | 0 | 20/20 pass |
| New race regression test, 3 runs | `python -m pytest ...::test_a_quickly_ending_run_is_not_overwritten_by_the_started_save` (×3) | 0 | 3/3 pass |
| central_agent suite | `python -m pytest backend/tests/central_agent` | 0 | 26 passed |
| Related unit subset (background/session/resume/recover/cancel/lifecycle) | `python -m pytest` (subset) | 0 | 115 passed |
| **Full backend** | `python -m pytest backend/tests -q -p no:cacheprovider` | **0** | **3208 passed, 75 skipped, 0 failed** (693.63 s) |

### Outcome
The pre-existing intermittent failure from Run 2 is resolved. The full backend suite is green. No TypeScript or Node source changed; `npm run typecheck`, `npm run test:front`, `npm run test:service` were not rerun (backend-only edits). No packaged build or packaged acceptance was run for this fix.
