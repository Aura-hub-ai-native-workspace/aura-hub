# AURA Hub — Prioritized Findings

**Status:** Phase 0 output (inventory and baseline). Each finding is marked **Confirmed** (reproduced or measured) or **Suspected** (indicated by evidence, not yet reproduced). Nothing here has been fixed yet.
**Baseline:** `0d6c43f`. Evidence: `VALIDATION_REPORT.md`, `REPOSITORY_MAP.md`, `BRANCH_AUDIT.md`.
**Supersedes for current state:** `docs/audit/gaps.json` (2026-09-23). Its G-01..G-10 are folded in below where they still apply.

Priorities: **P0** data loss / security boundary failure / release-blocking corruption · **P1** core workflow failure, false success, broken execution, CI red · **P2** significant incompleteness, recoverability, repeated usability failure · **P3** polish.

## P1

### F-01 — CI backend gate fails on the pushed baseline · Confirmed
- **Reproduce:** `python -m pytest backend/tests` → 1 failed: `integration/test_real_model_e2e.py::TestProviderFailures::test_rate_limit_then_recovery_over_real_wire`.
- **Expected:** green CI on the pushed branch. **Actual:** exit 1.
- **Root cause:** `0d6c43f` changed `central_agent/intent.py::_validated` to set `goal` to the user's words for read-only git status requests. The test uses `goal == model wording` as its proof that the model reply was used after a 429.
- **Impact:** CI red; no product misbehavior (the behavior change is intended).
- **Minimal fix:** assert model-only fields (`confidence == 0.94`, `requestedOutcome`) so the test still separates "model reply after retry" from "heuristic fallback"; optionally assert goal == user words. No skip, no deletion.
- **Regression test:** the corrected test itself.

### F-02 — Small-model intent can turn executable requests into chat · Confirmed for git status, Suspected for others
- **Evidence:** packaged run 5 (2026-10-26). `qwen3.5:2b` labelled "Show me the git status." as conversation, so no task ran and the reply told the user to run `git status` themselves. Fixed for git status only (deterministic rule before the conversational return).
- **Suspected scope:** any read-only request without a deterministic override (show diff, list files, run tests, read a file) can still be answered as chat with nothing executed. The verifier never sees it, because there is no plan.
- **Next step:** reproduce with scripted model replies for each supported read-only capability. Then extend the existing heuristic routing (`heuristic_interpret` already recognises many of these) into the same pre-conversational override, capability by capability, with tests.

#### F-02 update — 2026-10-26 (Phase 2, uncommitted on top of `0d6c43f`)
The original Phase 0 entry above is kept unchanged. Status: **fixed in source**; not yet verified in a packaged build.

Reproduced (probes outside the repo, `scratchpad/phase2/`; regression tests fail before the fix: 36 failed, 1 passed):
1. **Not routed.** "Show me the git diff", "What changed in the working tree?", "List the files in this repository", "Read README.md" and "What branch am I on?" asked for clarification in deterministic mode. A model labelling them as conversation executed nothing.
2. **Refused by policy.** `git.diff` was denied in the real app ("Nothing connected can perform git diff"): only `git.status` was declared as provided by the git tool and as needing git, so no node was ever connected for `git.diff`.
3. **Result dropped.** `git.diff`, `filesystem.list`, `filesystem.read`, `project.list` and `workflow.list` ran, verified and were audited. But their executors return text, a list or records, and the verified record keeps only `stdout`, so the result was discarded and the answer was "1 task(s) executed; all verifications passed".
4. **Wrong tool.** A model-planned `filesystem.list` with a path was rerouted to `agent.delegate`, an external worker.
5. **False failure.** A correct `filesystem.read` of the requested file failed verification ("Mission not verified"): the task's `input.path` did not count as addressing the file.
6. Design point: "What branch am I on?" must not use `git.branch`, which creates or switches branches. `git status --short --branch` already names the branch.

Fix (smallest change per defect):
- `requested.read_only_request` recognises the four plain reads, but not when the request also asks for a change.
- `intent.py` routes them in deterministic mode and ahead of a model's conversational label, as already done for git status.
- `planner.plan_read_only` adds a template for each. `filesystem.list` is kept direct, not rerouted.
- `capabilities/tools.py` declares that `git.diff` is provided by, and needs, git.
- `execution._recorded_output` records a read-only result as text.
- `read_only_answer.describe` shows that text as the answer.
- `verification.unaddressed_read_only` requires evidence from the request's own tool, and a file task's `input.path` now counts as addressing its file.

Policy, capability checks and path confinement are unchanged: a path outside the project is refused by the executor, and the regression test covers it.

Evidence: `backend/tests/unit/test_read_only_requests.py` (38 tests) and `VALIDATION_REPORT.md` run 2.

Remaining:
- The model-planning path is only partly covered. The real-wire fixture cannot serve the planning call, so model-proposed read-only plans were tested through `plan_from_model` plus the real dispatch, not over the wire.
- Phrasings outside the recognised patterns still depend on the model and the planner, for example `knowledge.search` worded differently. Git history (log) has no capability or executor, so it is unsupported, not unrouted.

### F-03 — Tested post-release fix stranded off the baseline · Confirmed absent; impact to be verified
- `fix/v0.1.21-cross-platform-reliability` (`aa5915d`, 2026-10-11): informational-question routing, readable fallback, Windows path scope for governance, worker names. It adds `test_informational_questions.py` and `test_governance_windows_paths.py`; neither exists in the baseline.
- **Risk:** it edits `intent.py` and `service.py`, the files changed by the stabilization. A blind merge would conflict or regress.
- **Next step:** port by hand behind its own tests. Rerun the git status regressions and acceptance A.

## P2

### F-04 — Two backends implement the same 12 route groups · Confirmed
- Node 4319 and Python 4320 both serve `agent automation environment fabric governance health missions projects providers secrets workflow-runs workflows`. The UI uses Node for workflows, fabric, automation, projects and providers, and Python for agent and environment. Policy, fabric, executors, secrets and audit exist twice (TS original, Python port).
- **Observed consequence:** behavior drift (approval logic survived in the Node policy after removal from Python).
- **Next step:** document per route which backend is authoritative. Add contract tests for the shared policy decisions (both engines given the same input must decide the same). Retire unused duplicate routes only after confirming no caller. Not a rewrite.

### F-05 — Audit trail split across two files · Confirmed
- Python writes `~/.aura/audit/trail.jsonl`; Node writes `~/.aura/fabric-audit.jsonl`. Neither alone shows every governed action.
- **Next step:** at minimum, a documented and tested merged read for the UI's audit views. Decide later whether to unify the writers.

### F-06 — Agent-driven provider connection is unsupported · Confirmed (known)
- The `provider.connect` capability is denied by policy. Onboarding and Settings use the direct `/providers` routes and work.
- **Next step (Phase 4):** design a narrow path: an explicit user request, a known provider, an address or credential validated with the existing `verifySelfHosted`/`connectProvider` checks, and an audit record. No new approval gate, no credential invention.

### F-07 — Silent error handling · Suspected
- 65 `except …: pass` blocks in `backend/aura`, 60 empty `catch`/`.catch(() => {})` in desktop and package sources (non-test).
- **Next step:** triage on execution, verification, persistence and audit paths first. Any that hides a failed action from the user or the record is P1. Leave intentional best-effort cases, but document them.

### F-08 — No automated GUI/end-to-end harness · Confirmed
- Desktop tests run in a node environment (no DOM). Acceptance A, B and C were executed by hand with xdotool. CI runs `desktop-runtime-verify.mjs` under xvfb, which boots the service but does not drive agent journeys.
- **Next step:** script acceptance A, B and C (they already exist as manual procedures with fixed evidence formats) so they can be rerun per build.

### F-09 — Signed release blocked · Blocked
- Updater signing needs `TAURI_SIGNING_PRIVATE_KEY`, which is unavailable. AppImage and DEB are unsigned. No workaround will be attempted.

## P3

### F-10 — Skipped tests · Confirmed count, reasons to review
- 75 skipped in `backend/tests` (including retired oracle-parity suites with stated reasons), plus TS skip markers. Review that each skip has a current, valid reason.

### F-11 — Repository hygiene · Confirmed
- 147 refs (119 fully merged). `graphify-out/` (generated, 21 MB `graph.json`) is tracked and regenerated locally. 81 untracked scratch/tool files. 40+ overlapping audit/handoff docs (`gaps.json` G-08).

## Phase plan (dependency order, each step independently validated)

| Phase | Steps | Exit evidence |
|---|---|---|
| 2 — Critical correctness | F-01 test correction → F-02 reproduce across read-only capabilities and extend deterministic routing → F-07 triage on execution/verification/audit paths (fix any that hide failures) | `python -m pytest backend/tests` green; new regression tests; acceptance A rerun |
| 3 — Core tool reliability | Feature/tool matrix (`FEATURE_TOOL_MATRIX.md`) with per-tool evidence; fix dropped outputs, cancellation and error reporting found there; F-03 port | Per-tool tests; matrix classifications |
| 4 — Provider and integration | F-06 narrow agent-driven provider connect; F-04 authority table and shared policy contract tests; F-05 merged audit read | Contract tests; packaged check of provider setup |
| 5 — UX reliability | Loading, failure and recovery states found in phases 3–4 | Logic-level tests; packaged checks |
| 6 — Release verification | All CI gates, `npm run build`, packaged build, acceptance A/B/C (scripted per F-08 if done) | `VALIDATION_REPORT.md` run entry; package hash; signing still BLOCKED (F-09) |

`SECURITY_REVIEW.md` and `FEATURE_TOOL_MATRIX.md` are produced in Phases 2–3. They need per-boundary and per-tool investigation that Phase 0 did not perform.
