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

## Run 4 — Phase 3 audit (2026-10-26, audit only)

**Source:** `df2cc92` (unchanged). No application source or configuration was modified. No commits, pushes, branch switches, resets, cleans, stashes, or reverts. No tests were run.

**Deliverables:**
- `docs/audit/FEATURE_TOOL_MATRIX.md` — new. Baseline/working-tree state, 24-capability inventory (registration, executor output shape, `_TEXT_RESULT_CAPS` membership, test-file counts, platform assumptions), intent/planning/authorization summary, F-03 classification, dropped-output/cancellation/error-reporting audit (confirmed D-01..D-04, suspected H-01..H-05), prioritized findings, implementation order, required tests.
- `docs/audit/PRIORITIZED_FINDINGS.md` — updated (append-only) with F-03 classification, F-07 triage scope, and new findings F-12..F-15. Historical entries preserved.
- `docs/audit/VALIDATION_REPORT.md` — this entry.

**Confirmed defects found (no fixes applied):**
- D-01: `git.branch` result dropped (not in `_TEXT_RESULT_CAPS`).
- D-03: risk grading mismatch for branch operations.
- D-04: 65 empty `except …: pass` blocks (F-07).

**Suspected (not confirmed):** H-01..H-05 (see matrix §6.2).

**F-03 candidates:** 3 classified — Windows scope (port, independently verifiable), readable fallback (port), informational routing (investigate + port behind tests). None merged.

**Validation:** none run in this step. Prior green baseline (3208 passed / 75 skipped / 0 failed at `df2cc92`) stands.

## Run 5 — Phase 3 Step 3.1: Windows drive-letter path handling (2026-10-26)

**Scope:** port only Windows drive-letter path handling for governance scope validation. No deterministic summaries, informational routing, frontend, or worker changes.

**Changes:**
- `backend/aura/governance/actions.py`: added `_WIN_DRIVE_RE` (`^[A-Za-z]:/`) and `_abs_marker()`; `_inside_scope` now treats drive-letter absolute paths (with separator) as absolute and resolves against cwd. Drive-relative (`C:foo`), UNC, traversal, out-of-scope, and sensitive paths remain denied.
- `backend/aura/governance/opencode.py`: added `isAbs` mirror in the compiled plugin (requires separator after colon).
- `backend/tests/unit/test_governance_windows_paths.py`: new (ported + extended security vectors).

**Validation:**
1. `python -m pytest backend/tests/unit/test_governance_windows_paths.py backend/tests/unit/test_action_governance.py -q` → exit 0, **83 passed**.
2. Plugin mirror subset (`-k PluginMirror`) → exit 0, **3 passed** (node available).
3. `python -m pytest backend/tests/unit/test_read_only_requests.py backend/tests/unit/test_git_status_grounding.py backend/tests/unit/test_requested_outcomes.py backend/tests/unit/test_intent_compiler.py backend/tests/unit/test_intent_route_and_research.py -q` → exit 0, **111 passed**.

**Security verification (platform-independent, on Linux):** in-scope drive paths allowed; backslash variants allowed; out-of-cwd drive paths denied hard; traversal (`..`) denied; sensitive (`.env`) denied; relative in-scope still allowed; POSIX absolute unchanged; drive-relative `C:evil.txt` denied; UNC outside cwd denied; mixed separators allowed; different drive denied; tilde/empty denied; Linux absolute `/etc/passwd` denied. Filesystem-level Windows behavior not claimed tested on Linux.

**Not run:** full backend suite (not required by scope); no commit/push.

## Run 6 — Phase 3 Step 3.2: `git.branch` result propagation (F-12), entry reconstructed (2026-10-27)

The earlier session that made this change did not record a Run 6 (its note says the report update was blocked by a harness error), and the register marked F-12 resolved with no recorded result. This entry is written by a later session from its own runs; it does not reproduce the earlier session's numbers.

**What was checked:** `backend/aura/executors/__init__.py` (`git_branch`) and `backend/tests/unit/test_git_branch_result.py`, as uncommitted changes on top of `df2cc92`. Inspection (`rev-parse`) now fails on a non-zero exit with the real output and code, instead of reporting a branch; creation and switching return `stdout`, `branch` and `exitCode`; a failed checkout returns the real exit code and message.

| Step | Command | Exit | Result |
|---|---|---|---|
| Branch result, Windows scope, action governance | `python -m pytest backend/tests/unit/test_git_branch_result.py backend/tests/unit/test_governance_windows_paths.py backend/tests/unit/test_action_governance.py -q -p no:cacheprovider` | 0 | 89 passed |
| Plugin mirror under Node 22 | `python -m pytest backend/tests/unit/test_governance_windows_paths.py -q -p no:cacheprovider -k PluginMirror` | 0 | 3 passed |
| Same new tests against a copy of `df2cc92` extracted outside the working tree | `python -m pytest tests/unit/test_governance_windows_paths.py tests/unit/test_git_branch_result.py` | 1 | 8 failed, 20 passed (the new behaviour is what makes them pass) |

**Limit:** the Windows path tests are Linux-hosted simulations of Windows path strings; none was executed on Windows.

## Run 7 — Alpha loop: security and lifecycle fixes (2026-10-27)

**Source:** `df2cc92` (one commit ahead of `origin/feat/laya-shadow-planner`, not pushed) plus uncommitted changes: the earlier sessions' Phase 3 work (verified in Run 6) and this run's fixes. No commit or push was made. Logs are kept outside the repository in `scratchpad/phase4/`. Regression tests were also run against a copy of `df2cc92` extracted outside the working tree, to show they fail without the fix.

### Fixes and their regression tests

| Finding | New or changed tests | On committed code |
|---|---|---|
| F-13 branch-create graded low-risk | `test_git_risk_grading.py` (10) | 1 fails |
| F-15 `http.request` non-2xx (not a defect, guarded) | `test_http_request_status.py` (6) | n/a (guard) |
| F-17 sovereign policy fail-open | `test_sovereign_policy_failclosed.py` (10) | 6 fail |
| F-18 `sandbox.execute` outside project, any program; H-02 cancellation | `test_sandbox_confinement.py` (17), `test_terminal_cancellation.py` (3) | 14 and 2 fail |
| F-19 `document.ingest` / `artifact.generate` outside project | `test_executor_path_confinement.py` (13) | 11 fail |
| F-07 silent progress and crash-recording failures | `test_progress_callback_failures.py` (5) | 3 behavioural fail |

Existing tests whose setup changed because the executors now confine to a project root and apply the terminal allow-list (assertions unchanged; success preconditions added where a test would otherwise pass vacuously): `test_new_executors.py` (5 sandbox, 4 ingest/artifact), `test_document_artifact_pipeline.py` (7 paths moved into the project), `test_inspection_to_approval_note.py` (3), `test_acceptance_gate.py` A16.

### Gates

| Gate | Command | Exit | Result |
|---|---|---|---|
| Backend, first run on this tree | `python -m pytest backend/tests -q -p no:cacheprovider` | 1 | 3293 passed, 75 skipped, **7 failed** (the existing tests above whose setup put files outside the project or ran off-list commands) |
| **Backend, final source** | `python -m pytest backend/tests -q -p no:cacheprovider` | **0** | **3300 passed, 75 skipped, 0 failed** (590.28 s) |
| Typecheck | `npm run typecheck` | 0 | 0 errors |
| Desktop tests | `npm run test:front` | 0 | 44 files, 412 passed |
| Node service tests | `npm run test:service` | 0 | 19 files, 163 passed |
| Lint (ruff) on changed files | `python -m ruff check <file>` vs the committed version | n/a | no new findings in existing files; new test files clean. Pre-existing findings remain (for example import order in `service.py`, `server.py`, `test_acceptance_gate.py`) |

### Not run in this step
Packaged build, packaged smoke test and packaged acceptance (see the packaging entry below if present); the Windows execution of any path test; a live-model end-to-end request through the real UI after these changes.

### Run 7 — packaging and packaged smoke (2026-10-27, same tree as the gates above)

| Gate | Command / method | Result |
|---|---|---|
| Package build | `npm run desktop:build` | Exit 1 **only** at updater signing (`A public key has been found, but no private key ... TAURI_SIGNING_PRIVATE_KEY`). Both bundles were produced: AppImage `AURA Hub_0.1.20_amd64.AppImage` (2026-10-27 19:57:49, sha256 `1707f131a4f93921a4e63ce61c46071dfc2c3112f0d639c216367745e54766f6`) and the `.deb`. **Unsigned.** No key was created or bypassed. |
| Bundle matches source | `cmp` of the eight changed backend files against `resources/python/backend` | all eight identical |
| Packaged smoke (isolated home and display, disposable repo with one uncommitted change, local Ollama `qwen3.5:2b`) | launch, health, identity proofs, unauthenticated read | both services healthy; both identity proofs returned; unauthenticated read refused with 401 |
| Packaged request: "Show me the git status." | UI, then audit and session record | correct answer (branch `main`, one changed path); `git.status` succeeded, auto-execute; run verified; repository unchanged |
| Packaged request: "Show me the git diff." (failed before F-02) | same | real diff shown including `+uncommitted line`; `git.diff` succeeded, agent actor; run verified; repository unchanged |
| Packaged request: "Read README.md" | same | file text returned; `filesystem.read` succeeded; run verified; repository unchanged |
| Acceptance B, foreign backends on both ports | disposable servers on 4319 and 4320 with a wrong identity proof | app refused both ports; UI showed "Backend identity mismatch — connection refused"; the foreign servers received **0 requests**, so no token or payload reached them |

**Not run on this build:** acceptance C (takeover; its exact procedure was not available to this run); packaged exercise of the `sandbox.execute`, `document.ingest` and `artifact.generate` confinement (the app holds the instance token, so it is covered by unit tests and by the bundle matching the source); any Windows execution; a GUI automation harness (F-08); signing and notarization (F-09, blocked: no private key).

**Process note:** one cleanup command matched its own shell by command-line text and was killed (exit 144). It stopped only test-owned processes; ports were free afterwards and OpenCode was untouched.

## Run 8 — second Alpha loop: F-20, F-27, F-17, F-07 (2026-10-27, all uncommitted on `df2cc92`)

**Fixes and tests:** F-20 `http.request` destination policy in Python and Node (`test_http_destination_policy.py` 53, `httpPolicy.test.ts` 47); F-27 `web.research` fetch (`test_web_research_destination.py` 5); F-17 revalidated with a 16-case probe (`probe_f17.py`, all as specified) and documented; F-07 triage of 193 Python handlers (`test_governance_hook_unavailable.py` 12, `test_server_swallowed_errors.py` 3, `test_observer_failures_logged.py` 5). Against `df2cc92` the behavioural tests fail (hook 9 of 12, server 2 of 3, observer 3 of 5, web research 2 redirect/DNS cases, Node executor 9 of 15, Python agent-method case).

| Gate | Command | Exit | Result |
|---|---|---|---|
| Backend, final source | `python -m pytest backend/tests -q -p no:cacheprovider` | 0 | **3378 passed, 75 skipped, 0 failed** (540.28 s) |
| Typecheck | `npm run typecheck` | 0 | 0 errors |
| Desktop tests | `npm run test:front` | 0 | 44 files, 412 passed |
| Node service tests | `npm run test:service` | 0 | 20 files, 210 passed |
| Lint (ruff), changed files | per file, against the committed version | n/a | no new findings; new files clean |
| Package build | `npm run desktop:build` | 1 | exit only at updater signing (`TAURI_SIGNING_PRIVATE_KEY` missing). AppImage 2026-10-27 21:15:07, sha256 `ab099801e1b435aca18d09e32baca0b0b885e652ee5494f656692755e82cb5cd`, plus `.deb`. **Unsigned; no key created or bypassed.** |
| Bundle matches source | `cmp` of every changed backend file incl. new `http_policy.py`; extracted AppImage copy of `http_policy.py`; `ai-service.mjs` contains the policy | n/a | PASS |
| **Packaged-runtime confinement** | extracted AppImage, its bundled `python3` and backend, own token, REST `/fabric/invoke` (`pkg2/harness.py`, `result-2.txt`) | 1 | **21 of 22 PASS**: unauthenticated 401; sandbox cwd outside refused, same command inside works, off-list program and shell operators refused; ingest outside refused, inside works and is retrievable, outside text not retrievable; artifact output outside refused and nothing written; http: agent GET works, agent POST/PUT/PATCH/DELETE refused and never sent, user PUT allowed, metadata refused for agent and user, redirect to metadata refused; audit records actor kind. The 22nd (artifact output *inside* the project works) is **BLOCKED by F-28**. A first run (`result.txt`) had vacuous checks and is superseded. This ran the packaged Python code, not the packaged UI. |
| Acceptance B (foreign services on both ports) | new AppImage | n/a | **PASS**: both ports refused, UI "Backend identity mismatch — connection refused", foreign servers received 0 requests |
| Acceptance C (takeover) | **my reconstruction** from the earlier one-line record: healthy app, its own Node service stopped, foreign server on its port | n/a | **PASS at the network level, with a wording correction**: the foreign server received 66 requests, **all** identity-proof challenges (`GET /instance/proof?challenge=<nonce>`, no secret); **0** data requests, **0** token headers, **0** bodies. UI showed "Backend identity mismatch — connection refused" and "Backend offline". The earlier record's "0 requests" counted data requests only. |
| Packaged UI smoke on the new build | git status / diff / read through the UI | n/a | **NOT RUN**: the local Ollama was saturated (load average about 21; a one-word prompt did not answer in 120 s), so provider verification never completed. The previous build's smoke (sha `1707f131…`) remains historical evidence for the git, diff and read paths; none of this loop's changes touch them, but they are not re-proved on this build. |
| Windows execution | no Windows host | n/a | **NOT RUN** |
| Signing | no private key | n/a | **BLOCKED** |

**Process notes:** one early cleanup matched its own shell by command-line text (exit 144, no harm; recorded as a failure); later cleanups used executable path and parent lineage.

## Run 9 — Alpha loop 3: F-23, F-24, F-26, F-28 and revalidation of loop 2 (2026-10-28, all uncommitted on `df2cc92`)

**Source:** `df2cc92` (one commit ahead of `origin/feat/laya-shadow-planner`, not pushed) plus uncommitted changes: the earlier sessions' work, loop 2, and this loop. No commit or push was made. Raw evidence for the packaged checks is kept in the repository under `docs/audit/evidence/loop3/`.

**Evidence caveat (read this first).** The machine rebooted during this loop and cleared the temporary filesystem that held the logs of the four source-gate runs below and of the first packaging-verifier run. The numbers in the "Source gates" table were observed in the session when each command finished and were recorded in the shared context store at the time; the raw log files no longer exist. Everything under "Packaged application" below was re-run after the reboot, and its logs are in the repository.

### What changed
- **F-23:** the Claude hook exits 2 (and logs `DENY`) for an unreadable, empty, malformed or invalid scope document, bad input, an unloadable governance core, an unexpected error, and any verdict other than `ALLOW`; a genuinely absent scope keeps its meaning and is logged `UNSCOPED`; the launch command maps any exit other than 0/2 to 2; `agent.delegate` refuses a scoped task whose governance cannot be staged. `tests/unit/test_governance_hook_unavailable.py` (43; 37 fail on `df2cc92`).
- **F-24:** the three Stop paths distinguish requested / confirmed / already-finished / failed; the automation cancel route answers 409 for a finished run. `ai/cancellation.test.ts` 19, `ai/generalChatStop.test.ts` 11, `data/stopRunStates.test.ts` 20, `tests/unit/test_automation_cancel_states.py` 2.
- **F-26:** knowledge is scoped per project with a required `project_id`, per-project indexes, unscoped legacy records, REST requiring a registered project; cross-project access denied (no authorization mechanism exists). `tests/unit/test_knowledge_project_scope.py` 39, `ai/knowledgeScope.test.ts` 7; the original leak was reproduced on `df2cc92`.
- **F-28:** the build vendors the `multimodal` and `artifacts` extras; and, found on the way, DOCX/XLSX/PDF ingestion needed Docling (not shipped), so a lightweight fallback engine was added; image paths in artifact sections are now confined. `tests/unit/test_light_office_engine.py` 37, `tests/unit/test_bundled_document_extras.py` 5.
- Four existing document-engine tests that pinned the old Docling-only behaviour for fake files were adapted (the scenario they describe is now "neither Docling nor the small libraries"; assertions unchanged).

### Source gates (final tree; observed, raw logs lost in the reboot)
| Gate | Command | Exit | Result |
|---|---|---|---|
| Backend | `python -m pytest backend/tests -q -p no:cacheprovider` | 0 | **3492 passed, 75 skipped, 0 failed** (877.74 s). The run before it (previous tree) had 4 failures, all the stale tests above. |
| Typecheck | `npm run typecheck` | 0 | 0 errors |
| Desktop tests | `npm run test:front` | 0 | 48 files, **469 passed** |
| Node service tests | `npm run test:service` | 0 | 20 files, **210 passed** |
| Lint on changed files | ruff, per file against the committed version | n/a | no new findings (existing findings unchanged) |

### Loop 2 revalidation (targeted, before the full run)
F-17 independent probe: 16 file/environment cases, all as specified. F-20/F-27/F-07 and the confinement suites: 130 backend tests passed; Node `httpPolicy` 47 passed. The same cases were exercised again in the packaged runtime (below).

### Packaged application (package 3)
**Artifact:** `AURA Hub_0.1.20_amd64.AppImage`, built 2026-10-28 01:06:34, 190,274,040 bytes, sha256 `cbb445ec01c0d75246dd170b0debbbb88f5bb0fa47dad2dc5f77c729460ad548` (the `.deb` was built beside it). `npm run desktop:build` exits 1 **only** at updater signing (`TAURI_SIGNING_PRIVATE_KEY` not set). **The artifact is unsigned; no key was created or bypassed.** Vendored for the bundled CPython 3.12: python-docx 1.2.0, openpyxl 3.1.5, reportlab 5.1.0, pypdf 6.21.3, Pillow 13.0.0, lxml 6.1.3 (+14 MB). All 20 changed or new backend Python files plus the fabric manifest were byte-identical in the staged bundle (observed before the reboot); the extracted artifact was re-checked after it and contains all six libraries.

| Check | Method | Result |
|---|---|---|
| **Packaged-runtime harness** (extracted AppImage, its bundled Python and backend, own token, REST; `evidence/loop3/packaged_runtime_harness3.py`) | `python3 -I harness3.py` | **PASS 60/60** |
| — documents | DOCX, XLSX, PDF generated inside the project and ingested (engine `light`); also files produced by the host's libraries, i.e. not written by the packaged code; search retrieves text from each, including a second XLSX sheet | PASS |
| — missing library | with `pypdf`/`python-docx`/`openpyxl` made unloadable, each format answers dependency-missing and names both Docling and the small library | PASS |
| — errors | scanned PDF (OCR required), password-protected PDF, corrupt DOCX, corrupt PDF are refused and indexed nowhere | PASS |
| — F-26 | tool search in another project sees nothing; no project identity and an input naming another project are refused; REST 400 without a project, 404 for an unregistered one, owning project finds it, other does not | PASS |
| — confinement (retest) | sandbox cwd/program/operators; ingest outside; artifact output outside refused and **artifact output inside the project now works** (it was blocked by F-28 in Run 8); image outside refused, inside embedded (DOCX and PDF); http agent GET allowed, agent POST/PUT/PATCH/DELETE refused and never sent, user PUT allowed, metadata refused for both, redirect to metadata refused; audit records the actor kind | PASS |
| — F-24 backend | Stop on a finished automation run → 409 "already completed"; unknown run → 404 | PASS |
| — F-23 | the packaged hook run by the packaged interpreter: valid scope allows/denies, absent scope allowed and logged `UNSCOPED`, truncated/empty/array/invalid-field/garbage-input/directory all deny with a `DENY` record, a missing interpreter becomes exit 2 | PASS |
| **Packaging verifier** | `DISPLAY=:98 node scripts/packaging-verify.mjs` (re-run after the reboot) | **FAIL overall: 43 PASS, 17 FAIL, exit 1** — see below |
| — new checks | 1m (document libraries packaged), 1n (the packaged interpreter alone writes and reads DOCX, XLSX and PDF) | **PASS** |
| Acceptance B (foreign services on both ports) | UI launch of package 3 | **PASS**: both ports refused, banner "Backend identity mismatch — connection refused", Verify disabled, **0** requests received |
| Acceptance C (takeover) — **my reconstruction** of an earlier one-line record | healthy app; its own Node service stopped; foreign server on its port; 45 s idle plus a UI action | **PASS**: **0** requests received (log never created); UI "Backend identity mismatch — connection refused" and "Backend offline"; the real Python backend stayed connected. (My first attempt was invalid and is not counted: the Node child ignored a guarded kill, so the foreign server never bound the port.) Loop 2's run saw only identity-proof challenges; both satisfy the invariant. |
| Packaged UI smoke (git status/diff/read via the model) | — | **NOT RUN**: after the reboot the Ollama service does not start (its unit points at `/usr/local/bin/ollama`; the binary is `/usr/bin/ollama`). Not changed: system configuration needs root. The previous builds' smoke remains historical evidence. |
| F-24 GUI click-through of the three Stop buttons | — | **NOT RUN**: no GUI automation exists (F-08); covered by store/client and backend tests only. |
| Windows execution | — | **NOT RUN** (no Windows host) |
| Signing | — | **BLOCKED** (no private key) |

### The 17 verifier failures, with evidence for each cause
The verifier is not a reliable gate in its current form. I did not change it to pass.
- **15 checks (4a–4g, 5a–5f, 5c–5e among them) never reach the app's capabilities.** The script sends no instance token, and the app answers exactly as designed: `instance-token-required — This backend did not present the token of the instance it belongs to`. The script predates the ownership handshake; 5c–5e also assert an approval gate that was removed on purpose. The same capabilities were exercised, with a token, in the harness above.
- **3d, 3e** use `wmctrl -lp`, which needs a window manager; the virtual display has none (`Cannot get window manager info`). The window itself rendered (screenshots in the evidence folder).
- **8c4** expects the old wording "in use by another program"; the actual message ("Port 4319 is already in use … only attaches to a backend it started itself") is equally plain. The behaviour checks 8c1–8c3 (the impostor keeps its port, is not killed, is not attached to) **passed**.

## Run 10 — Alpha loop 4: F-32 verifier, F-29 automation lifecycle, Ollama, final artifact (2026-10-28, all uncommitted on `df2cc92`)

**Source:** `df2cc92` (one commit ahead of `origin/feat/laya-shadow-planner`, not pushed) plus uncommitted changes (earlier sessions, loops 2–4). Nothing was committed or pushed. **Every gate below was recorded by `docs/audit/evidence/loop4/run_gate.sh`** (command, working directory, start/end time, host and tool versions, repository state, full output, exit code) into `docs/audit/evidence/loop4/`; no credentials or launch tokens are recorded (a scan of the saved verifier log found no token-like string, no token header name and no token variable name). The raw logs of loop 3's four source gates were lost in a reboot, which is why this loop re-ran everything on the final tree.

### Changes
- **F-32 (verifier, `scripts/packaging-verify.mjs`):** it now learns each backend's launch token from the process tree it launched (never a file, log or command line), proves ownership with the service's own HMAC challenge before using it, sends each token only to its own port, redacts tokens from all output (new check 3j); reports the window checks as `BLOCKED` (exit code 2) when the display has no window manager; asserts the current port-conflict wording; replaces the approval-gate checks (5c–5e) with checks of the irreversible floor under the current contract; adds 5g (Stop on a finished automation run answers 409 through the Node service). The ownership guard was not bypassed or weakened.
- **F-29 (automation lifecycle):** both engines (TypeScript, the one the desktop app uses, and its Python mirror): first terminal state wins; a Stop never rewrites a failed run; a retry never undoes a Stop or overwrites a paused run; one `done` event per run; Python makes check-then-write and persistence atomic under a lock (this fixed a real lost update found by a cross-thread race test: the stored record stayed `running` for a cancelled run). The Node route answers 409 for a finished run; the UI reconciles an automation refusal with the run record.
- Test-infrastructure fix: the differential test's TypeScript oracle bundle was reused whenever it existed, so it silently compared against an outdated build after any engine edit; it is now rebuilt when the TypeScript source is newer.

### Gates (final tree)
| Gate | Command | Exit | Result |
|---|---|---|---|
| Backend | `python -m pytest backend/tests -q -p no:cacheprovider` | 0 | **3506 passed, 75 skipped, 0 failed** (666.94 s) |
| Typecheck | `npm run typecheck` | 0 | 0 errors |
| Desktop tests | `npm run test:front` | 0 | 48 files, **478 passed** |
| Node service tests | `npm run test:service` | 0 | 21 files, **224 passed** |
| Lint on changed files | ruff, each modified file against `df2cc92`; new files alone | n/a | no file worse than committed. 4 findings remain in two other-session test files (`test_git_branch_result.py`, `test_governance_windows_paths.py`). No TypeScript lint is configured; typecheck is the TS gate. |
| Targeted, before the full run | F-23, F-26, F-28 source tests, loop-2 security suites, F-29 lifecycle | 0 | backend 339 passed / 2 skipped; Node service 224; desktop ai+data 242 |
| F-29 tests against the committed engines | the new lifecycle files run on `df2cc92` | — | Python 7 of 14 fail there; TypeScript 6 of 14 fail there |

### Final artifact
`AURA Hub_0.1.20_amd64.AppImage`, built 2026-10-28 19:34:21, 190,274,040 bytes, **sha256 `fca9a7af2f65b642ddffb8f61ce256caba710a247d429100ded5abfb612c2772`** (`.deb` beside it). `npm run desktop:build` exits 1 **only** at updater signing (`TAURI_SIGNING_PRIVATE_KEY` not set): **unsigned; signing BLOCKED; no key was created or bypassed.** It supersedes loop 3's package (`cbb445ec…`), which predates the F-29 and F-32 changes. 20 of 20 changed or new backend Python files plus the fabric manifest are byte-identical in the staged bundle; the Node bundle contains the new engine and the 409 route text; the six document libraries are inside (python-docx 1.2.0, openpyxl 3.1.5, reportlab 5.1.0, pypdf 6.21.3, Pillow 13.0.0, lxml 6.1.3).

### Packaged results on this artifact
| Check | Method | Result |
|---|---|---|
| Packaged-runtime harness (extracted artifact, bundled Python and backend, own token, REST) | `packaged_runtime_harness.py` | **PASS 60/60** (DOCX/XLSX/PDF generate + ingest + search incl. files the packaged code did not write; scanned/locked/corrupt files refused; F-26 scoping through tool and REST; confinement retest incl. output inside the project; http policy; finished-run Stop 409; packaged governance hook) |
| Packaging verifier | `DISPLAY=:98 node scripts/packaging-verify.mjs`, under a minimal `i3` window manager started on the virtual display | **PASS: exit 0, 62 passed, 0 failed, 0 blocked** |
| Acceptance B (foreign services on both ports) | UI launch | **PASS**: refused, banner shown, **0** requests received |
| Acceptance C (takeover) — **my reconstruction** of an earlier one-line record | healthy app; its Node child (verified by lineage and resolved name) stopped; foreign server on its port; 45 s idle plus a UI action | **PASS**: **0** requests received; UI "Backend identity mismatch — connection refused" / "Backend offline"; the real Python backend stayed connected |
| Packaged UI smoke | real UI, model connected after ~55 s, disposable repository | **PASS**: "Show me the git status." (branch `main`, ` M README.md`), "Show me the git diff." (real diff incl. `+uncommitted line`), "Read README.md" (file text); audit `git.status`, `git.diff`, `filesystem.read` all succeeded; each run verified; repository HEAD and diff unchanged |
| F-24 GUI (Start Building Stop button) | real UI, long answer, Stop pressed | **PARTIAL**: 1 s after Stop the button reads "Stopping…" with "Stop requested. Waiting for the agent to confirm." (not "Stopped"); the same at +10 s; at +40 s "Stopped. Stopped before the answer finished." after the agent confirmed. Not exercised through the GUI: failed stop, stop racing completion, repeated stop, and the workflow and automation Stop buttons. |
| Windows execution | no Windows host | **NOT RUN** |
| Signing | no private key | **BLOCKED** |

### Verifier failure breakdown (F-32)
| Run | Result | What it was |
|---|---|---|
| 0 — original (loop 3, package 3) | 43 PASS / **17 FAIL** | **11** token-related (4a–4g, 5a, 5a2, 5b, 5f: no instance token was sent, so the guard refused them, correctly); **3** stale approval-gate assertions (5c–5e); **2** window checks that need a window manager (3d, 3e); **1** stale wording (8c4). Loop 3's report said "15 token-related", which double-counted 5c–5e; the split here is the correct one. |
| A — token support added, no window manager (package 3) | 56 PASS / 3 FAIL / 2 BLOCKED | 4x/5x/8c4 now pass; 3d/3e correctly `BLOCKED`; 5c–5e still asserted the removed approval gate (the old 5c actually started a real worker: `agent.delegate` is autonomous now, rule `autonomous-delegation`) |
| Final — all of the above plus the rewritten 5c–5e and the new 5g, under a window manager (final artifact) | **62 PASS / 0 FAIL / 0 BLOCKED, exit 0** | 5c–5e now assert what the product does: `policy.ts` applies the irreversible floor as `stricter(decision, 'deny')`, so `git.push` is denied before it runs, nothing is queued, and the denial is audited |

**Environment limitation:** the clean pass needs a window manager on the display. Without one, 3d and 3e report `BLOCKED` and the run exits 2 (not a clean pass). Run under a desktop session, or start a window manager on the virtual display.

### Ollama (environment)
`/etc/systemd/system/ollama.service` (admin-made, `User=ollama`) has `ExecStart=/usr/local/bin/ollama serve`, but the `ollama` 0.40.10 package put the binary at `/usr/bin/ollama` on Oct 24 and ships its own unit, which the admin unit shadows; the service restart-loops (`activating`). The models (`qwen3.5:2b`, `nomic-embed-text`) are in `/mnt/storage/.ollama`, the logged-in user's store, **not** in the service user's `/var/lib/ollama`, so correcting `ExecStart` alone would serve no models. No system service was changed (no passwordless root). For the smoke I ran `ollama serve` **as the user** (loopback only) and stopped it afterwards; the broken unit is unchanged. Owner action needed for a permanent fix: see the register (F-33).

## Run 11 — Alpha loop 5: cross-platform audit, process-tree cancellation, Ollama diagnosis (2026-10-28, all uncommitted on `df2cc92`)

**Scope:** audit of the platforms the repository claims (`docs/INSTALL.md`, Tauri configs, `ci.yml`), fixes with regression tests, F-33 diagnosis, GUI cancellation coverage, rebuild and packaged re-validation. **Nothing was committed, pushed, signed or released; no system service was changed.**
**Full matrix, findings, reproductions and native-validation commands:** `docs/audit/CROSS_PLATFORM_MATRIX.md`. **Evidence:** `docs/audit/evidence/cross-platform/` (each gate recorded by `run_gate.sh`: command, cwd, timestamps, host/tool versions, repository state, full output, exit code; no tokens or keys).

### Platform reality (what ran where)
Only an **Arch Linux x86_64** host exists. **Windows: NOT RUN. macOS: NOT RUN. Ubuntu/Debian runtime: BLOCKED** (Docker daemon not running, `systemd-nspawn` needs root); only a static glibc analysis was possible. Linux tests that simulate Windows are not counted as Windows passes.

### Defects found and fixed (each regression test failed before its fix)
- **X-01 (P2, all platforms)** — the Node service's subprocess runner ended only the direct child on Stop/timeout (`execFile` signals one process and silently ignores `detached`); a timeout with a surviving worker never returned. Fixed in `packages/ai-service/src/exec/process.ts` (spawn + process-group termination; `taskkill /T` on Windows, unverified natively). Test: `exec/processTree.test.ts` (3, 2 failed before). The install-guard test's spy was extended to `spawn`, otherwise its "never spawns" assertions would have passed vacuously.
- **X-02 (P3, Windows)** — installer executor killed one process on Windows (no `taskkill /T`). Fixed in `backend/aura/environment/executor.py`. Test: `test_install_executor_windows_tree_kill.py` (3, 1 failed before; Linux simulation).
- **X-03 (P3)** — `StdioMcpClient.close()` stranded the MCP server's workers. Fixed in `backend/aura/central_agent/mcp_transport.py`. Test: `test_mcp_transport_tree_cleanup.py` (1, failed before).
- **X-04 (P2, Windows only, found by code trace, not observed natively)** — the Windows graceful-shutdown request lacked the launch token the ownership guard now requires, so every Windows quit became a 5 s wait plus hard kill. Fixed in `apps/desktop/src-tauri/src/service.rs` (platform-independent `post_request`). Tests: Rust `shutdown_request_tests` (2, run on Linux) and an `instanceGuard.test.ts` contract case. **The Linux artifact does not contain this code (compiled out), so it is unverifiable until a Windows build runs.**
- **Not fixed:** X-05 (the Python backend has no shutdown route; on Windows it is always hard-terminated after 5 s), X-08 (INSTALL.md lacks a glibc/WebKitGTK requirement), X-09 (CI runs pytest on Linux only).
- **Added, no defect:** `test_hostile_project_paths.py` (4: filesystem, git, DOCX ingest in a project path with spaces, `#`, `%`, `&`, non-ASCII), `scripts/glibc-floor-verify.mjs`.
- **Checked, not defective:** `localhost`/IPv6, SQLite URI construction (verified with hostile characters), `fcntl`/`os.getuid()` guards, `exec_/` and `procexec` Windows handling, `AURA_HOME` resolution, Rust `/usr/...` fallbacks (all `cfg(unix)`).

### Gates (final tree; exit codes from `docs/audit/evidence/cross-platform/*.exit`)
| Gate | Command | Exit | Result |
|---|---|---|---|
| Backend | `python -m pytest backend/tests -q -p no:cacheprovider` | 0 | **3514 passed, 75 skipped, 0 failed** (603.33 s); loop 4 was 3506 (+8 new tests) |
| Typecheck | `npm run typecheck` | 0 | 0 errors |
| Desktop tests | `npm run test:front` | 0 | 48 files, **478 passed** |
| Node service tests | `npm run test:service` | 0 | 22 files, **228 passed** (loop 4: 224; +3 +1) |
| Rust unit tests | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` | 0 | **18 passed, 0 failed, 1 ignored** |
| glibc floor | `node scripts/glibc-floor-verify.mjs <binary> <resources>` | 0 | PASS, 46 ELF files, none above 2.34 (static) |
| Lint (changed files) | `ruff` vs `HEAD` per file | — | **0 files worse than committed**; 4 pre-existing findings in two other-session test files (`test_git_branch_result.py`, `test_governance_windows_paths.py`). No TypeScript lint is configured. |
| Targeted regression, per finding | see `regression-targeted.txt` | — | F-12 6; Windows-path suites 96 (+2 skipped); F-17 57; F-20/F-27 58; F-23 43; F-24/F-08 backend 17; F-26 39; F-28 72; F-29 35 (+2 skipped); TS lifecycle/guard/cancellation 73 |

### Final artifact
`AURA Hub_0.1.20_amd64.AppImage`, built **2026-10-28 20:41:34**, 190,278,136 bytes, **sha256 `9da5c9c273d481906afdf39c074bf03d132e94117a66777339b4817d94d383c5`**; `.deb` sha256 `e9ec1f738774e6c6ee8f683c274ab2a8e0fa94d7157d9d734fc1596d3082a839`. Built with `npm run desktop:build` (exit **1 only at updater signing**; no `TAURI_SIGNING_PRIVATE_KEY`; **unsigned, signing BLOCKED, no key created or bypassed**). It supersedes loop 4's `fca9a7af...`, which predates this loop's changes. Parity: 22 of 22 changed backend Python files byte-identical in the staged bundle; the Node bundle contains the new runner; the Linux binary does not contain the Windows-only shutdown code (expected).

### Packaged results on this artifact
| Check | Result |
|---|---|
| Packaged-runtime harness (`packaged_runtime_harness.py`, bundled Python + libraries) | **PASS 60/60**, exit 0 |
| Packaging verifier (`DISPLAY=:98 node scripts/packaging-verify.mjs`, own Xvfb + minimal i3) | **PASS, exit 0, 62 pass / 0 fail / 0 blocked** (needs a window manager for checks 3d/3e) |
| Acceptance B (foreign services on both ports) | **PASS** (0 requests to the foreign servers; app refused both ports). UI banner not re-captured. |
| Acceptance C (takeover; my reconstruction) | **PASS** (0 requests in 45 s idle; real Python backend stayed alive). UI banner not re-captured. |
| Graceful quit | whole process tree gone in 1.9 s and 2.7 s |
| GUI cancellation (chat Stop, real model) | **PARTIAL**: "Stopping..." + "Stop requested. Waiting for the agent to confirm." (never "Stopped" prematurely) → "Stopped. Stopped before the answer finished." after confirmation; four rapid Stop clicks: one state, no error; completed run shows Send, no Stop. Not driven through the GUI: failed/unconfirmed cancel, retry-wait, workflow Stop, automation Stop, Stop racing completion. |
| Network | one socket snapshot: loopback only, 0 non-loopback peers (not a continuous capture) |
| Secrets | evidence and app logs contain no token or key material |
| UI smoke (git status / diff / read in a project) | **NOT RUN on this artifact** (loop 4's PASS is for `fca9a7af...`) |
| Windows | **NOT RUN** · macOS **NOT RUN** · Ubuntu/Debian runtime **BLOCKED** · signing **BLOCKED** |

### Method corrections recorded
- A first acceptance-C attempt was invalid (my process helper signalled only the AppImage runtime, leaving the app running) and was discarded; the leftover tree was identified by a unique `AURA_HOME` marker and stopped with SIGKILL after it ignored SIGTERM. Cause not established; recorded as an unconfirmed observation (see `evidence/cross-platform/packaged-acceptance-and-gui.txt`). The corrected runs identify processes by environment marker only.
- A per-user tmp quota (`EDQUOT`) interrupted one command; I deleted only my own just-created extraction in the scratch directory.
- My first reading of the glibc check ("requires 2.39") was wrong: those references are weak; the real floor is 2.34.

## Run 12 — Alpha loop 6: X-05, X-08, X-09, cancellation semantics, hardening (2026-10-28, all uncommitted on `df2cc92`)

**Nothing was committed, pushed, signed or released; no system service was changed; no CI run was triggered.** Evidence: `docs/audit/evidence/loop6/` (each gate via `run_gate.sh`). Still **Arch Linux x86_64 only**: Windows **NOT RUN**, macOS **NOT RUN**, Ubuntu/Debian runtime **BLOCKED**.

### Changes
- **X-05 (Python graceful shutdown) — implemented.** `POST /shutdown` (`backend/aura/api/shutdown.py`, route in `api/server.py`, entry script `scripts/serve_central_agent_api.py` now runs `uvicorn.Server` and binds the route to its `should_exit`). It requires the instance token (enforced by the existing guard) **and** a configured token **and** `x-aura-shutdown: 1`; with no token configured it is refused (403), so an inert guard never means an open stop route. Idempotent (`alreadyRequested`), non-blocking (flag flip, no join in the handler), truthful (503 when no server is bound, 500 on a failed stop without latching), bounded (`timeout_graceful_shutdown=3`, under the shell's 5 s force-kill fallback). The Node `/shutdown` got the same no-token refusal (`shutdownRefusal`). The Rust shell's request is generic over the handle, so the Python backend (port 4320) uses it once a Windows build runs.
- **X-08 (install requirements) — documented.** `docs/INSTALL.md`: the claim "Node is required and not bundled" was **false** for the installers (Node 22.23.2 and Python 3.12.14 are bundled; resolution `AURA_NODE` → bundled → system) and is corrected. New System requirements section marks every item measured / declared / inferred; glibc ≥ 2.34 (measured), WebKitGTK 4.1 + GTK3 + libsoup3 (measured, declared by the .deb); distributions are *not* claimed supported beyond Arch (the only one executed).
- **X-09 (native CI) — prepared, NOT RUN.** `.github/workflows/ci.yml`: the `backend` job is now a matrix over `ubuntu-latest`, `windows-latest`, `macos-latest` (arm64) with bash steps, `-ra` (skips listed with reasons), a junit report and summary, and a per-platform record of runner, Python, Node and Rust versions; `desktop-build` also records its toolchain. No `continue-on-error`. Validated locally only as parseable YAML. Prediction (not measurement): 35 backend test files use POSIX-only constructs with no platform guard, so the first Windows run will likely report real failures.
- **Cancellation semantics (in-flight action) — implemented.** A Stop is acknowledged immediately (`status: cancelled`, nothing further starts, retries stop, the abort signal reaches the in-flight action), and the run now carries `cancellation: { phase: 'winding-down' | 'complete', actionId, label }`: `winding-down` while an action that was running has not returned, `complete` after. Persisted and emitted in both engines (TypeScript `packages/automation`, Python `engine.py`); the UI says "Cancelled — an action is still winding down" and classifies the Stop as *requested* (not confirmed) until the phase is complete; a legacy record without the field claims nothing about residual work.
- **X-01/X-02/X-04 review.** Added tests: pre-aborted signal and abort-after-finish for the Node runner; a Rust test that pins the shutdown request's header names to the names the Node and Python guards enforce. No defect found in the existing fixes.

### Cancellation semantics, as implemented
| Question | Answer |
|---|---|
| Does Stop interrupt the current action? | It delivers the abort signal. `run-workflow` (into the workflow engine) and `run-diagnosis` honour it; `run-governance-audit`, `run-security-review`, `run-docs-review`, `update-knowledge` and `save-memory` ignore it and run to completion. |
| Does it prevent later actions? | Yes: the run is terminal, the loop breaks, retries stop (tests: mid-flight, retry-wait). |
| When is it persisted? | At the Stop (`cancelled` + phase) and again when the in-flight action returns (phase `complete`). |
| Can a cancelled action still cause side effects? | Yes, for an action already running that does not watch the signal, and nothing already done is rolled back; this is now visible as `winding-down`. |
| Cleanup | Node runner and MCP client end whole process trees (loop 5); in-process handlers return on their own. |
| Remaining limit | A non-cooperative handler cannot be interrupted from outside; the UI says so instead of claiming it stopped. |

### Gates (final tree; `docs/audit/evidence/loop6/*.exit`)
| Gate | Command | Exit | Result |
|---|---|---|---|
| Backend | `python -m pytest backend/tests -q -p no:cacheprovider` | 0 | **3526 passed, 75 skipped, 0 failed** (635 s); loop 5: 3514 (+7 shutdown, +5 cancellation) |
| Typecheck | `npm run typecheck` | 0 | 0 errors |
| Desktop tests | `npm run test:front` | 0 | 48 files, **480 passed** |
| Node service tests | `npm run test:service` | 0 | 22 files, **236 passed** |
| Rust unit tests | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` | 0 | **19 passed**, 1 ignored |
| CI workflow | YAML parse | 0 | parses (not executed) |
| Lint | `ruff` vs `HEAD` per file | — | **0 files worse**; remaining findings are in other sessions' files (`test_git_branch_result.py`, `test_governance_windows_paths.py`, `scripts/extract_toc_pages.py`, `scripts/generate_dpr_docx.py`) |

### Final artifact
`AURA Hub_0.1.20_amd64.AppImage`, built **2026-10-28 21:40:13**, 190,278,136 bytes, **sha256 `c1796be75d7b187a59230b37fc55da93082f2ea35ccf5b5bf3ed0eadaeb29622`**; `.deb` `e831bdf458dfef6e809de9c8f5fdf64542c0d9317daa2749d50255d324193917`. `npm run desktop:build` exit **1 only at updater signing** (no key): **unsigned, signing BLOCKED**. Parity: 23/23 changed backend files and the entry script byte-identical in the bundle; the Node bundle contains the new code. Supersedes loop 5's `9da5c9c2…`.

### Packaged results on this artifact
| Check | Result |
|---|---|
| Packaged-runtime harness | **PASS 60/60**, exit 0 |
| Packaging verifier (own Xvfb + minimal i3) | **PASS, exit 0, 62 pass / 0 fail / 0 blocked** |
| Packaged `POST /shutdown` (bundled Python 3.12.14, random token) | no token 401, header only 401, wrong token 401, token without header 403 (backend kept running); authorized 200 → **clean exit status 0 in 234 ms**, port freed; repeat while stopping 200 (idempotent); token absent from logs and record |
| Acceptance B (foreign servers on both ports) | **PASS**: app refused both ports, 0 foreign requests |
| Acceptance C (takeover; reconstruction) | **PASS**: 0 foreign requests in 45 s, real Python backend alive, graceful quit |
| GUI Stop on this artifact | **NOT RUN.** The chat-Stop GUI evidence (loop 5) belongs to the previous artifact; this loop's UI change is automation-only and is covered by unit tests, not driven through the GUI. |
| UI smoke (git status / diff / read) | **NOT RUN** on this artifact |
| Windows / macOS | **NOT RUN** · Ubuntu/Debian runtime **BLOCKED** · signing **BLOCKED** |
Process handling: every app process was identified by a unique `AURA_HOME` marker; my Xvfb and i3 were stopped after verifying identity; the user's `i3` (1220) and Ollama (132494) were never touched.

## Run 13 — Loop 8: autonomous Workspace behaviour, screenshot bug, sequential chaining (2026-10-29, uncommitted on `df2cc92`)

Request (typed by the owner): prompt-only use; the central agent decides, assigns, reviews and re-assigns with no approval gates; agents chain one after another; web search works like GPT/Claude; cross-platform. Executed on Arch Linux only; Windows/macOS NOT RUN. The app was **not rebuilt** and the GUI was **not re-driven**: nothing here is verified in the packaged artifact.

**Recovery note.** At 2026-10-29 18:43:08 IST `execution.py`, `service.py` and three audit documents were rewritten by an unidentified actor, which removed the first Loop 8 code and this section. The code was re-applied from the recorded session commands; the cause of the rewrite is unknown. The pre-recovery gate (3538 passed) is superseded by the one below.

- **Screenshot bug:** the `diagnosis.run` task carried no `projectId`, which its contract requires, although the project was open. `execution.py` `_fill_session_inputs` fills a missing/empty required `projectId` from the session; an explicit value is kept. Tests: `test_session_project_input.py` (3).
- **Decide, don't ask:** `central_agent/autonomy.py`, called from `service.py`: a model-raised clarification is settled by the agent when a project is open, the message has at least 3 words and the intent is not judged impossible. Tests: `test_central_agent_decides.py` (3).
- **Review → rework by default:** a reviewed change goes back to a worker when the review reports problems; `remediate` skips itself on a clean review. Set in `planner.py` and in `intent.py` (read-only requests excluded). Five tests that pinned the old shape were updated.
- **Sequential chaining (new):** `planner.py` `_plan_sequential_workers`: workers named in order with "then / after that / next" become a chain, each stage pinned to its named worker, depending on and receiving the previous stage's verified output; parallel and read-only requests are unchanged. Tests: `test_planner_sequential_workers.py` (5).
- **Web search (fixed and verified live):** the keyless DuckDuckGo provider was answered with a bot check (HTTP 202) on this machine, so search returned nothing. The built-in provider now tries Bing, then DuckDuckGo, and uses the first readable answer (`executors/web_research.py`: `parse_bing_results`, `_builtin_search`); a configured gateway still wins, a bad explicit endpoint is still refused, consent and destination policy are unchanged. Live run on this machine: `python 3.13 release notes` returned 5 results and read 3 pages. Tests: `test_builtin_web_search.py` (8). The composer toggle defaults ON. Other networks may be blocked or rate-limited by either engine; the failure text names each engine tried.

Gate (`docs/audit/evidence/loop8/backend-full-after-recovery.txt`): `python -m pytest backend/tests -q -p no:cacheprovider` exit 0, **3543 passed, 75 skipped** (605 s). Typecheck and desktop/package tests were not rerun after recovery; this session changed no TypeScript.

Not done: (live web search is now verified, see above); a passed review does not yet trigger a *further* worker unless the request names the chain; AppImage not rebuilt; GUI not driven; live web search and a live multi-agent run not executed.

## Run 14 — Redesign: project-centred layout, four-tab Settings, Connected tools, Workspace web search (2026-10-29, uncommitted on `df2cc92`)

Request (owner's product concept): sidebar only Home and Automations; Workspace lives inside each project (Overview | Workspace; Overview with Overview, Context, Architecture, Code); Settings tabs Connections, Connected tools, AI Runtime, Updates; Connected tools split Installed | Recommended; web search that works like ChatGPT/Claude. Executed on Arch Linux only; Windows/macOS NOT RUN.

- **Navigation:** `NavKey` is `home | workflows | settings`; `ProjectTab` is `overview | context | architecture | code`; new `projectMode`, `settingsTab`, `openWorkspace`, `openSettings` in the store. `ProjectWorkspace.tsx` has the Overview | Workspace switch; the Workspace is kept mounted (hidden) after first visit. Ten unreachable section files and the project "Let's Chat" button were removed.
- **Settings:** `screens/settings/SettingsScreen.tsx` with four tabs; Sovereign Mode and Knowledge cache moved into Connections → Reliability; the AppImage install panel sits under Updates.
- **Connected tools:** `backend/aura/environment/recommended.py`, `POST /environment/recommended`, `preview` on `POST /environment/install` (runs nothing); `claude-code` and `codex-cli` gained npm install specs; `ConnectedToolsTab.tsx` (Installed: search, filter, load more, re-scan over the existing `/environment/inventory`; Recommended: consent dialog showing the exact command, root commands shown and never run).
- **Web search:** the Workspace now researches real questions on chat-only turns when the toggle is on; answers carry `[n]` citations and a deterministic Sources footer built from the pages actually fetched.

Gates: `python -m pytest backend/tests -q` exit 0, **3579 passed, 75 skipped** (577 s), evidence `docs/audit/evidence/loop8/backend-full-after-redesign.txt`; `npm run typecheck` 0 errors; desktop vitest **491 passed**.

GUI: the Vite dev build was opened in a browser: sidebar shows Home and Automations; Settings shows the four tabs; no console errors. The backend refuses a plain browser (identity check needs the desktop shell), so the Installed list, the Recommended list and a project's Overview | Workspace were **NOT seen with real data**.

Not done: model-based search routing and query rewriting, optional keyed search providers with a Settings box, a visible "search failed" state in the Workspace, packaged-app run, AppImage rebuild; the now-unrouted `EnvironmentStatusTable.tsx` is kept for its tests.

### Run 14 addendum — packaged build and packaged run (2026-10-29 21:07 – 21:25 IST)

- **Build:** `npm run desktop:build` (evidence `docs/audit/evidence/loop8/desktop-build.txt`) produced `AURA Hub_0.1.20_amd64.AppImage` (190,286,328 bytes, built 21:07:31, **sha256 `cf0e9490fccb9cbde2f015c25b586b1f24d0fc69484be8809cddf0aa209e9acb`**) and the `.deb`; the command exited **1 only at updater signing** (`TAURI_SIGNING_PRIVATE_KEY` unavailable), as in earlier runs. The artifact is unsigned. Previous artifact (sha256 `fca9a7af…2772`) was replaced.
- **Run:** the AppImage was launched with `AURA_HOME` and `XDG_*` pointed at a scratch directory (no real AURA data touched); status bar showed Connected and Environment: connected. Window screenshots were captured with `maim`.
- **Seen working with real data:** sidebar (Home, Automations, Settings, collapse); Settings with four tabs; Connections (Providers, Status, Test connection); Connected tools → Installed (**1,439 found**: 46 applications, 617 CLI tools, 1 runtime, 775 packages, from pacman); Recommended (Claude Code, Codex CLI, OpenCode, Kilo Code, Qwen Code, Cursor, Ollama shown installed with versions; Gemini CLI offers Install; LM Studio offers Get); AI Runtime (5 agents detected, 5 of 5 configured); Updates (0.1.20 up to date, Installation panel); a project added from a throwaway folder opened on **Overview | Workspace** with a four-item Overview sub-nav, and the Workspace showed its composer with Web Research ON.
- **Not exercised:** an Install was not clicked (it would change the machine); no Workspace conversation or live web-search answer was run in the packaged app; the packaged harness and packaging verifier were not rerun; the window was 956 px wide, so wide-layout behaviour was not seen; Windows/macOS NOT RUN.
- **Observed issue:** the Installed list is alphabetical, so libraries appear before applications and AI tools; the plan's "AI agents, applications first" ordering is not implemented.

### Run 14 addendum 2 — Home, centred tabs and packaged check (2026-10-29 21:30 – 22:10 IST)

- **Changes:** project Overview | Workspace switch and the Settings tab strip are centred pills directly under the top search bar; Home lost the Quick actions and AI Runtime cards and gained an animated AURA core (`screens/home/HomeCore.tsx`, styles in `styles/global.css`) with the agents really detected by `/agent-runtime/discover` orbiting it, plus an "N AI agents connected" caption.
- **Findings from the packaged app (WebKit):** CSS variables inside `@keyframes` are not applied, so orbit labels tilted; fixed with plain nested transforms and by keying the orbit by its agent list so the orbit and the labels' counter-spin start together. The caption overlapped the status line; fixed with normal flow spacing.
- **Bug found and fixed in source (not yet in the last build):** Home loaded the project list once at mount; if the backend was still starting, the failure was swallowed and Home showed "No projects yet" until revisited. Home now refreshes when the backend first answers.
- **Packaged build 5** (`desktop-build-5`, exit 1 only at updater signing): sha256 `a6bb78f9e28efc9457774bc7c9f948b6e0a2e30ed9897ce4862035b228b5042a`. Seen working: Home with five orbiting real agents and upright labels; project Overview | Workspace pill centred under the search bar with the four-item Overview sub-nav; Workspace tab; Settings with four centred tabs.
- **Not seen:** the Home project-list refresh fix in a build; a wide-window Workspace layout (window was 956 px); an actual chat or web-search answer; Windows/macOS NOT RUN.

### Run 14 addendum 3 — Home redesigned with the design skill (2026-10-29 22:40 – 23:05 IST)

- **Direction:** the owner rejected the orbit Home as childish and the terminal Home as too terminal-like and asked for an Apple-like premium feel. The `design-taste-frontend` app-screen run was followed: `draw.mjs --app --kind workspace --screens home --theme dark` dealt `true-black-flat` (sheet saved under `.taste-skill/app-dark/`); its workspace-home pattern was applied with the app's own theme tokens, so light and dark both work.
- **Built:** `screens/home/HomeSections.tsx` (greeting title with date and one finding line, inverted pill primary action, four count tiles, Projects and Agents panels of row cards with pale identity-tint initials); `DevConsole.tsx` and `HomeCore.tsx` removed; all Home figures come from live state. `lint.mjs` on `Home.tsx` and `HomeSections.tsx`: clean after four legacy flags in the project library were fixed (shadow, monospace, hairline). `inspect.mjs --app` was **not run** (needs a served page; the app's backend only trusts the desktop shell).
- **Packaged build 7** (`desktop-build-7`, exit 1 only at updater signing): sha256 `9bb2834b05d6fa7733b3ccc5bb546fbbe5ab49b8eeb426523a668da5d77b7019`. Seen at 956x1016 in dark and light: greeting, finding line, pills, four tiles, Projects and Agents panels with real data (5 of 6 agents, 1 project, 3 chunks, Environment Ready). Not seen: a wide-window layout of this Home; Settings and the project screens in the same visual style; Windows/macOS NOT RUN.

### Run 14 addendum 4 — black-and-white theme (2026-10-29 23:10 – 00:05 IST)

- **Request:** the owner found the Apple-like Home still not good and asked for the whole product in black and white.
- **Change:** `styles/global.css` token blocks rewritten for light (#f5f5f7 canvas, white surfaces, #1d1d1f ink accent) and dark (#000 canvas, #111 surfaces, #f5f5f7 accent), with a new `--on-accent` token and Tailwind `on-accent` so text on an accent fill flips with the theme; a script greyed hard-coded blue, violet and cyan hex/rgba values and Tailwind palette classes across about 40 source files (the two service-package data-colour files it also touched were restored from HEAD); `tailwind.config.ts` tint and glow shadows greyed; the logo is shown in black and white by `--logo-filter` (the PNG itself is unchanged, which departs from the code comment that says never to restyle the mark); project icons ignore the backend's per-project colour; Overview tile icons are neutral. Small semantic status colours (green status dots and text, red errors) are kept on purpose.
- **Contrast bugs found by looking at the packaged app and fixed:** active tab pill white-on-white (Settings and project), blank user avatar, white text on near-white neon-gradient buttons in the Workspace.
- **Gates:** `npm run typecheck` 0 errors; desktop vitest 491 passed; `test:service` 246 of 247 passed in a full run (one `projectScoping` test failed once under parallel load and passed alone; it is unrelated to colour).
- **Packaged build 10** (`desktop-build-10`, exit 1 only at updater signing): sha256 `d974c2e108ebcf3fa22df165c38c0f5ebd092d73d06c5e3cfb7f476442ae51b1`. Seen at 956x1016 in the light theme: Home, project Overview with the centred Overview | Workspace pill; earlier builds showed dark Settings, Connected tools, Workspace and the welcome step in black and white. The final build was not re-captured in dark.
- **Not done:** the owner's specific objection to the Home layout is unknown; a pure black-and-white pass over remaining semantic green is optional; Windows/macOS NOT RUN.

### Run 14 addendum 5 — prompt-first Home (2026-10-30 00:20 IST)

- **Request:** the owner accepted the black-and-white colours and rejected the Home layout (tiles and panels).
- **Change:** Home is now prompt-first, matching the stated concept that the user only prompts: a two-tone greeting and question, a large composer that starts the general chat with the typed text as a fresh conversation (`GeneralChat` gained an `initialMessage` prop), three suggestion pills, up to four project cards, and one agent-presence line with a Manage link to Settings → AI Runtime (`screens/home/HomeSections.tsx`, `screens/Home.tsx`). `lint.mjs` clean on both files (a composer shadow was removed); typecheck 0; desktop vitest 491.
- **Packaged build 11** (`desktop-build-11`, exit 1 only at updater signing): sha256 `d07a1a6690ee28713bc01029798491966f821327c5535a3b9422bceaad3135a0`. Seen in the dark theme at 956x1016 and at 1920x1080 (full screen): greeting, composer, pills, project card, agent line with real data (5 agents ready). Not done: sending a real prompt through the Home composer (would call a model), a light-theme capture of this build, Windows/macOS NOT RUN.

### Run 14 addendum 6 — full-page chat, Workspace connections and the agent approval flow (2026-10-30 00:00 IST)

- **Request:** typing an idea on Home opened a floating chat; the owner wanted a full-screen chat like GPT, the Workspace to show connected tools, and the "Hide capabilities" button removed.
- **Chat:** `components/GeneralChat.tsx` is now a page inside the shell (sidebar and top bar stay), with a Home link, New chat, an Earlier menu, a centred column, plain assistant text, a soft user bubble and a rounded composer with a round send/stop button. `GeneralChat` takes an `initialMessage`, so Home's prompt starts a fresh conversation.
- **Workspace:** `WorkspaceShell` no longer has a capabilities toggle; the rail is always shown and stacks on a narrow window. `workspace/autoProvision.ts` (+7 tests) and `useAutoProvision.ts` place installed, drivable AI workers and the preferred developer tools in the free slots and connect them one at a time, once per session. Root cause of "no tools connecting": removing the old Connected Environment screen removed the only place tools got connected.
- **Measured finding:** the agents still read "Not connected" because `backend/aura/workers/billing.py` refuses to run or connect any worker until the owner authorizes it in `<AURA_HOME>/worker-policy.json` (reason `BILLING_POLICY`); this was confirmed by a direct `/workers/connect` call. Auto-connect never bypasses it. The backend also reports `invocable=false` for Codex CLI and Qwen Code, so those two cannot be connected at all today.
- **Owner decision and build:** the owner chose "all five agents" with a one-click Allow. `billing.authorize()` and `POST /workers/authorize` (called only by the app's Allow click, not a capability; accepts only known workers, preserves other policy keys, atomic write; `tests/unit/test_worker_authorize.py`, 4 tests) record the approval; the graph shows "Needs approval", and a click on such an agent authorizes and connects it. Auto-connect skips workers awaiting approval.
- **Gates:** `npm run typecheck` 0 errors; desktop vitest 498 passed; backend worker/billing tests 375 passed; **full backend suite exit 0, 3583 passed, 75 skipped** (632 s), evidence `docs/audit/evidence/loop8/backend-full-after-approval.txt`.
- **Packaged build 13** (`desktop-build-13`, exit 1 only at updater signing): sha256 `00fd72c40af9f4c15a8df2dfcd1a0708119d8deae2c5884c0d27235fbdcaf590`. Seen at 1920x1080: "Needs approval" on OpenCode, Claude Code and Kilo Code; after Allow clicks on OpenCode and Kilo Code only (to avoid billable readiness round-trips on paid agents), both showed Connected about two minutes later. Claude Code was not authorized in the test copy; the test copy's policy file lives in a scratch `AURA_HOME`, not the owner's real one.
- **Not done:** Codex CLI and Qwen Code invocation support; the three environment tool slots are cut off by the rail's height at 1080p; chat model notices span the full width instead of the column; auto-connected tools (git, node, python) were not checked in the GUI; Windows/macOS NOT RUN.
- **Process note:** at one point the app window had moved to another workspace and a click and a screen capture landed on the owner's other terminal; the capture was deleted unused and every later GUI step checks that the window is viewable first.

### Run 14 addendum 7 — search bar removed, Workspace header removed (2026-10-30 00:50 IST)

- **Request:** in the Workspace remove the project name at top right and left and the Back to Home button (Workspace only), and remove the top search bar completely, in code as well as UI.
- **Change:** `shell/CommandBar.tsx` lost the search trigger and shows the project name in its breadcrumb only outside the Workspace; `App.tsx` no longer mounts the global `CommandPalette` or the Cmd+K shortcut; `shell/useCommands.ts` was deleted; the right panel's "Command Bar" action, and the `paletteOpen`, `setPaletteOpen`, `recentCommandIds` and `pushRecentCommand` store state were removed; the Workspace chat pane's project dropdown and its props were removed; `ProjectWorkspace.tsx` renders the project header (Back to Home, icon, name, badges, path) only in Overview. Kept on purpose: the code editor's own palette (`@aura/ui` `CommandPalette`), the Cmd+Shift+K window switcher, the `UniversalSearch` panel and the backend search routes.
- **Gates:** typecheck 0 errors; desktop vitest 498 passed; no source file references `paletteOpen` or `useCommands`.
- **Packaged build 14** (`desktop-build-14`, exit 1 only at updater signing): sha256 `1bc1dafca87342ae8100f527f8f9a04fcc79117c539f0d4d5dcd5dcb510cf447`. Seen at 956x1016: no search bar on Home, Overview or Workspace; Overview still shows Back to Home and the project header; Workspace shows neither, no project dropdown, and a breadcrumb of just "Home". The status bar at the bottom still shows the project name. Not checked: the full backend suite was not rerun for this front-end-only change; Windows/macOS NOT RUN.

### Run 14 addendum 8 — bottom status bar removed (2026-10-30 01:05 IST)

- **Request:** remove the bottom bar completely.
- **Change:** deleted `shell/StatusBar.tsx`, `shell/statusBarIndex.ts` and its test, and `ops/statusStore.ts` (the 15-second poller that fed only that bar: backend connection, project, git branch, provider, knowledge index); `AppShell` no longer mounts it; the full-page chat's bottom offset went from 32px to 0. The connection, branch and provider indicators the bar showed no longer appear anywhere.
- **Gates:** typecheck 0 errors; desktop vitest 495 passed (3 tests for the deleted helper removed). The backend was not touched.
- **Packaged build 15** (`desktop-build-15`, exit 1 only at updater signing): sha256 `0bb5627095a893b92fbb916d962cb8c231692421f35d16ce7e8e3ccec860c1a3`. Seen at 956x1016: Home and the full-page chat end at the window's bottom edge with no bar; the chat composer sits at the bottom. Not rechecked in this build: Workspace and Settings bottom edges; Windows/macOS NOT RUN.

### Run 14 addendum 9 — Overview | Workspace switch moved into the top bar (2026-10-30 01:35 IST)

- **Request:** put the project's Overview | Workspace switch in the top bar, where the search field used to be.
- **Change:** new `shell/ProjectModeSwitch.tsx`; `shell/CommandBar.tsx` is a three-column grid (breadcrumb left, the switch centred only while a project is open, view controls right); `screens/project/ProjectWorkspace.tsx` no longer renders the strip or its tab component, and the Overview header's top padding was adjusted. Typecheck 0 errors; desktop vitest 495 passed; the design lint was run on the two shell files.
- **Packaged build 16** (`desktop-build-16`, exit 1 only at updater signing): sha256 `9ceaa0f4a83b4760530e79bc054f985359f34c070d012d0d64b544dc9c015582`. Seen at 956x1016 with visibility checks: on Overview and Workspace the pill sits centred in the top bar and the page content starts directly beneath it; on Home the middle of the bar is empty. At this half-width window the capability graph is squeezed out of the stacked Workspace layout (it needs about 1000 px or more to sit beside the chat); the cut-off tool row noted earlier is still open. While the test app was starting, stray typed characters appeared in its welcome form that the test run did not type; they came from outside the run.

### Run 14 addendum 10 — top bar stripped, notifications and right panel deleted (2026-10-30 02:10 IST)

- **Request:** remove the breadcrumb, the notification bell, the other side-panel toggle and the round account circle from the top bar, in code and not only on screen.
- **Change:** `shell/CommandBar.tsx` now holds only the project's Overview | Workspace switch (centred, while a project is open) and the theme toggle. Deleted: `shell/RightPanel.tsx`, `ops/NotificationCenter.tsx`, `ops/useNotificationsFeed.ts`, `ops/notificationsStore.ts`, `updater/useUpdateNotifications.ts`. Removed: the right-panel aside in `AppShell`, the notification feed, the update-notification hook and the Cmd+. shortcut in `App.tsx`, `rightPanelOpen` and `toggleRightPanel` in the core store, and the two `notify()` calls in `ops/agentEngine.ts` (the engine itself is kept). Consequence: nothing in the app raises notifications now; update checking remains available in Settings → Updates; agent improvement results have no surface.
- **Gates:** typecheck 0 errors; desktop vitest 495 passed; service tests 247 passed; a search finds no remaining reference to the deleted modules.
- **Packaged build 17** (`desktop-build-17`, exit 1 only at updater signing): sha256 `6df6f4fae0240e3718d9ffc279d513868d879b75ad57eb41fa0e943462dad496`. Seen at 1920x1080 with visibility checks: Home's top bar shows only the theme toggle; inside a project the centred Overview | Workspace pill and the theme toggle are the only items; the Workspace now shows its whole capability graph at full height: OpenCode and Kilo Code Connected, Claude Code "Needs approval", Codex CLI and Qwen Code "Not connected" (not drivable), Gemini CLI "Not installed", and the three auto-placed environment tools Node.js, Git and GitHub CLI Connected after the machine scan finished. The earlier cut-off tool row is resolved by the removed bottom bar and the compact header.
- **Not done:** chat notice width; Codex CLI and Qwen Code invocation support; the owner's own Allow for Claude Code; the full backend suite was not rerun for these front-end-only changes; Windows/macOS NOT RUN.

### Run 14 addendum 11 — no top bar; theme switch moved to Settings (2026-10-30 02:40 IST)

- **Request:** remove the line/band at the top that took space on every page, remove the theme switch button and put it in Settings, and let every page fill that space.
- **Change:** deleted `shell/CommandBar.tsx`; `AppShell` renders no top bar, so every page starts at the top of the window; the full-page chat is now `inset-y-0`; the theme toggle sits at the right end of the Settings tab row; `ProjectWorkspace.tsx` carries a sticky, transparent `h-14` strip holding `ProjectModeSwitch` (the only chrome left at the top, on project pages only, costing about 56 px there). Typecheck 0 errors; desktop vitest 495 passed; design lint run on the three changed screen files.
- **Packaged build 18** (`desktop-build-18`, exit 1 only at updater signing): sha256 `3f3947d1443934a8df284fb8058a345a89461eb8ad743a784143eb0f900084f9`. Seen at 956x1016 with visibility checks: Home starts at the top edge with no band or line; Settings has the tab pill at the top and the theme toggle at its right; the project Overview and the Workspace show the floating Overview | Workspace pill, with the page content directly below. At this half-width window the Workspace stacks and its capability graph is squeezed out; at 1920 px it was fully visible (build 17).
- **Not done:** chat notice width; Codex CLI and Qwen Code invocation support; the owner's Allow for Claude Code; the full backend suite was not rerun for these front-end-only changes; Windows/macOS NOT RUN.
