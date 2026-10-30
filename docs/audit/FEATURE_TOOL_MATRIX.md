# AURA Hub — Feature / Tool Matrix (Phase 3 audit)

**Status:** Phase 3, Step 3.0 audit only. No application source or configuration was changed. No commits, pushes, branch switches, resets, cleans, stashes or reverts were performed.
**Baseline:** `feat/laya-shadow-planner` @ `df2cc92a79f4eecb79a43dce3abf7f5a565ff5a1` (committed). Working tree still carries the pre-existing uncommitted `graphify-out/` modifications and scratch files; those are untouched.
**Evidence:** static inspection of `backend/aura/executors/__init__.py`, `backend/aura/capabilities/tools.py`, `backend/aura/central_agent/{execution,intent,planner,verification,requested,service}.py`, governance modules, and the tests named below. Tests were not rerun in this step.

---

## 1. Baseline and working-tree state

| Item | Value |
|---|---|
| Branch | `feat/laya-shadow-planner` |
| HEAD | `df2cc92a79f4eecb79a43dce3abf7f5a565ff5a1` |
| Last commit | `df2cc92 fix: resolve F-01, F-02 read-only routing and background lifecycle race` |
| Working tree | 4 tracked modifications (`graphify-out/*`) + many untracked scratch/generated files; no source changes beyond those already in `df2cc92` |
| Backend suite at `df2cc92` | 3208 passed, 75 skipped, 0 failed (full run, see VALIDATION_REPORT.md Run 3) |
| Audit records present | `REPOSITORY_MAP.md`, `BRANCH_AUDIT.md`, `VALIDATION_REPORT.md` (Runs 1–3), `PRIORITIZED_FINDINGS.md` |

---

## 2. Capability inventory

Capabilities are the fabric-level actions AURA can plan and execute. They are registered in two places:

- `EXECUTOR_TABLE` in `backend/aura/executors/__init__.py` (24 entries).
- `CANONICAL_INTERNAL_CAPABILITIES` / `internal_executors()` (project.*, workflow.*).

`backend/aura/capabilities/tools.py` declares machine **tool** specs (git, node, npm, python, …) used for discovery/provisioning; these are *not* directly executable capabilities — they feed the fabric/registry. The executable capability ids below are what the planner and executor actually use.

Output column: shape returned by the executor. "dict" means a mapping (survives `_recorded_output`); "str/list" means a non-dict (survives only if listed in `_TEXT_RESULT_CAPS`); "conditional" depends on success/failure path.

| # | Capability | Executor returns | `_TEXT_RESULT_CAPS` | Tests (files) | Notes |
|---|---|---|---|---|---|
| 1 | `filesystem.list` | dict `{ok, detail, output: list}` | yes | 13 | output list recorded as stdout (F-02) |
| 2 | `filesystem.read` | dict `{ok, detail, output: str}` | yes | 36 | file text recorded as stdout (F-02); size cap 64KB-ish; path confinement via `inside()` |
| 3 | `filesystem.write` | dict `{ok, detail, output: {path}}` | n/a (dict) | 82 | verify read-back; content cap 64KB |
| 4 | `terminal.execute` | dict `{ok, detail, output: {stdout, exitCode}}` or failure dict with `output` | n/a | 61 | parse_command allow-list; 30s timeout; exit-code verify |
| 5 | `agent.delegate` | dict `{ok, detail, output: {nodeId, agent, stdout, exitCode, …}}` | n/a | 171 | worker lease, governance, network policy; heavy path |
| 6 | `git.status` | dict `{ok, detail, output: {stdout, branch, changes, exitCode}}` | n/a | 98 | ad-hoc engine path; answer synthesis fixed in F-02-era work; read-only |
| 7 | `git.diff` | **str** (text) | yes | 8 | recorded as stdout (F-02); 60KB cap |
| 8 | `git.branch` | **str** (text or name) | **no** | 9 | **Dropped output** — `_recorded_output` returns `{}` for a non-dict, non-capped cap. Confirmed latent defect (see §4.1) |
| 9 | `git.commit` | dict `{ok, detail, output: {committed, message}}` | n/a | 18 | verify read-back HEAD subject |
| 10 | `git.push` | dict `{ok, detail, output: {remote, branch, exitCode}}` or failure dict with `output` | n/a | 25 | exit-code verify; network egress |
| 11 | `http.request` | dict `{ok, detail, output: {status, text}}` | n/a | 27 | SSRF guard (metadata hosts); method allow-list; 30s cap |
| 12 | `web.research` | dict `{ok, detail, output: {query, results, count, pagesFetched, stdout}}` | n/a | 25 | requires SearXNG configured; fails closed when not configured (pinned by tests) |
| 13 | `tool.provision` | dict | n/a | 6 | provisioning flow |
| 14 | `knowledge.search` | dict `{ok, detail, output: {results, query, stdout}}` | n/a | 30 | stdout emitted for synthesizer |
| 15 | `document.ingest` | dict `{ok, detail, output: {status, chunkCount, …}}` (or failure dict without `ok`) | n/a | 21 | verify chunk_count > 0 |
| 16 | `artifact.generate` | dict `{ok, detail, output: gen.to_dict()}` (or failure dict with `output`) | n/a | 21 | verify file exists and size > 0 |
| 17 | `sandbox.execute` | dict `{ok, detail, output: {exitCode, stdout, timedOut}}` or failure dict with `output` | n/a | 16 | 30s cap; timed-out reported via `timedOut` flag |
| 18 | `project.list` | list | yes | 7 | recorded as stdout (F-02) |
| 19 | `project.create` | dict `{ok, detail, output: record}` | n/a | 7 | verify read-back by name |
| 20 | `project.open` | dict `{ok, detail, output: record}` | n/a | 7 | verify active project changed |
| 21 | `project.inspect` | dict `{ok, detail, output: profile}` | n/a | 7 | returns `_no` when no profile |
| 22 | `workflow.create` | dict `{ok, detail, output: {workflowId, nodeCount, edgeCount}}` | n/a | 27 | verify read-back node count |
| 23 | `workflow.list` | list | yes | 27 | recorded as stdout (F-02) |
| 24 | `agent.delegate` (also listed as #5) | — | — | — | see row 5 |

**Machine tool specs** (`capabilities/tools.py`): git, node, npm, python, cargo, go, java, docker, curl, chromium, playwright, sqlite, ollama, shell. These drive discovery/provisioning, not direct execution. Their risk grades: read-only / low-risk / modify / destructive. `git` spec exposes `git.branch` as low-risk but the executor's `git.branch` can create/switch branches (modify) — a grading mismatch worth noting (the executor guards with `_flag_value_error`).

---

## 3. Intent recognition and planning

- `intent.heuristic_interpret` + `intent._validated` decide whether a message is work, conversation, or a read-only request.
- F-02 added deterministic routing for read-only requests (`requested.read_only_request`) ahead of a model's conversational label, plus planner templates (`planner.plan_read_only`).
- F-02 also moved `filesystem.list` into `_DIRECT_FILE_CAPS` so a model-planned `filesystem.list` with a path stays direct instead of being rerouted to `agent.delegate`.
- The fix branch (F-03 candidate) adds `_INFO_PROJECT_RE` informational-question routing (see §5).
- `requested.asks_for_current_branch` / `READ_ONLY_BLOCKERS` / `READ_ONLY_LABELS` guard "change" phrasings from being treated as reads.

## 4. Authorization and policy

- `authority.py` checks capability + node against policy; `governance/actions.py::_inside_scope` enforces scope paths.
- Policy parity between Node (4319) and Python (4320) backends was fixed 2026-10-08 (autonomous-delegation rule).
- `provider.connect` is denied by policy (F-06, known, deferred to Phase 4).
- Web research is excluded and fails closed (pinned by `test_web_research_excluded.py`).

## 5. F-03 audit — `fix/v0.1.21-cross-platform-reliability`

Branch `fix/v0.1.21-cross-platform-reliability` (commit `aa5915d`) diverges from current HEAD at merge-base `10b2ce5`. It touches 12 files: `intent.py`, `service.py`, `governance/actions.py`, `governance/opencode.py`, two new tests, plus TS frontend files.

### Classification of each candidate change

| Change | File(s) | Classification | Evidence / notes |
|---|---|---|---|
| Windows drive-letter absolute paths in `_inside_scope` / `isAbs` | `governance/actions.py`, `governance/opencode.py` | **Potentially useful, independently verifiable** | Mirrors current `_abs_marker` logic; current HEAD does NOT have this (grep shows no `_WIN_DRIVE_RE`/`isAbs`). Confirmed gap on Windows: drive-letter targets treated as relative → in-scope write denied → worker exit 42. Tests: `test_governance_windows_paths.py` (212 lines) in fix branch. Independently verifiable on Linux by simulating Windows paths. **Recommend port.** |
| Informational-question routing (`_INFO_PROJECT_RE`) | `intent.py` | **Potentially useful, needs investigation** | Large new regex + `informational` flag. Current HEAD's F-02 changes overlap in `heuristic_interpret` and `_validated`. Risk of conflict/regression. The fix branch's tests: `test_informational_questions.py` (98 lines). Must be ported by hand (per PRIORITIZED_FINDINGS F-03) and re-run git-status regressions. **Recommend investigate + port behind its own tests.** |
| Readable deterministic fallback (`_deterministic_summary`) | `service.py` | **Potentially useful, independently verifiable** | Replaces orchestration-record fallback with human-readable summary. Overlaps current `service.py` bg-flake changes (submit path) — different region, likely mergeable. **Recommend port, with tests for summary content.** |
| Worker names / readable fallback | TS frontend files | **Potentially useful** | UI-only; needs packaged check. |
| Frontend `useAgentConversations` changes | TS | **Requires investigation** | May conflict with current frontend. Not in scope of backend audit. |
| `governance/actions.py` other changes | — | Check diff only showed scope fix. | Safe. |

### Already present on current branch
- None of the three core changes (Windows scope, informational routing, readable fallback) are present on current HEAD (verified by grep for `_WIN_DRIVE_RE`, `_INFO_PROJECT_RE`, `_deterministic_summary`).

### Incompatible / unsafe
- Blind merge of the whole branch is unsafe: it reverts/rewrites `intent.py` and `service.py` regions that current work depends on (F-02 routing, bg-flake submit ordering). Port by hand, behind tests, per F-03.

---

## 6. Dropped outputs, cancellation, and error reporting

### 6.1 Confirmed defects

| ID | Defect | Evidence | Impact |
|---|---|---|---|
| D-01 | `git.branch` returns a `str` (current branch name or switched-to name) but is not in `_TEXT_RESULT_CAPS`, so `_recorded_output` normalizes it to `{}`. Result dropped from verified record and answer. | `execution.py:29` `_TEXT_RESULT_CAPS` lacks `git.branch`; `executors/__init__.py:1020,1029` returns `res.out` / `name` (str). | Read-only-ish result lost; answer omits branch name. |
| D-02 | `_recorded_output` only preserves `stdout` for capped caps; other fields of a capped cap's dict (e.g. `git.diff` returns a bare str, fine; but `filesystem.list` returns a list → recorded as `{"stdout": text}` losing the structured list) — already accepted for text caps. For non-capped dict caps, the whole dict survives, so no loss. | `_recorded_output` logic. | Low; text caps are intentionally flattened. |
| D-03 | `git.branch` can create/switch branches (modify) but `capabilities/tools.py` grades the `branch` action as `_low` ("Create a branch") and the `git` tool's `branch-create` as low-risk; the executor performs checkout/create. Grading understates risk. | tools.py git spec; executor git_branch. | Policy/UX understates risk of a branch switch. |
| D-04 | 65 empty `except …: pass` blocks in `backend/aura`, concentrated in governance/netgate (10), environment/procexec (6), exec_/ (4), environment/executor (3), api/server (5), service (2). Several are on execution/verification/audit paths and may swallow failures. | Static count above. | Silent failures; F-07. |

### 6.2 Suspected / hypotheses (not confirmed)

| ID | Hypothesis | Status |
|---|---|---|
| H-01 | `agent.delegate` worker output may be truncated at 8KB stdout cap; large worker results lose tail. | By design (cap); not a defect unless answer needs it. |
| H-02 | Cancellation accepted but a spawned subprocess (terminal.execute/sandbox.execute) may continue if the cancel token is not threaded into `safe_shell_with_code`/`_run_file`. | Needs code trace; tests `test_cancellation.py`, `test_run_file_timeout_drain.py` exist. Not confirmed. |
| H-03 | `http.request` swallows `URLError` reason into `_no` (failure), correctly reported; but `HTTPError` non-2xx returns `_ok` with status — a 4xx/5xx is reported as success at the fabric level, then verify fails on status. Fabric outcome "succeeded" with ok=True for a 404 may mislead intermediate consumers. | Code inspection. Partially by design (status in output). |
| H-04 | `document.ingest` returns `ok=False` without `output` on non-indexable status; `_recorded_output` returns `{}`. Detail survives via `detail`, but structured fields lost. | Minor. |
| H-05 | Partial output on timeout: `sandbox.execute` reports `stdout` truncated to 8000 and `timedOut=True`; terminal.execute uses 400-char trim in detail but full `res.out` in output. Inconsistent but not lossy. | Cosmetic. |

### 6.3 Cancellation audit summary

- `RunControl` token crosses threads (tested).
- Cancel before run starts is seen (tested).
- Cancelled token not dropped by normal path (tested).
- Execution loop checks `cancel_token.cancelled` before dispatching each task and marks `cancelled_before` (code inspection).
- Subprocess-level cancellation (terminal/sandbox) is the main unverified seam — H-02.

### 6.4 Error reporting / UI agreement

- F-02 fixed result-loss for read-only caps; `read_only_answer.describe` now surfaces text.
- `git.status` answer synthesis fixed earlier (branch + clean/dirty).
- UI startup identity mismatch fixed (B/C acceptance).
- Remaining: deterministic fallback summary (F-03 candidate) improves readability; not a correctness defect.

---

## 7. Prioritized findings (Phase 3 additions)

Update to `PRIORITIZED_FINDINGS.md`:

- **F-03** remains P1, now with concrete candidate classification (§5). Port Windows scope fix first (smallest, independently verifiable, clear test), then readable fallback, then informational routing behind its own tests.
- **F-07** (silent errors): 65 empty except-pass blocks; triage execution/verification/audit paths first (netgate, procexec, exec_, executor, service, api/server). Reclassify any that hide a failed action as P1; document intentional best-effort.
- **New F-12 (P2):** `git.branch` result dropped (D-01). Fix: add `git.branch` to `_TEXT_RESULT_CAPS` (or make executor return a dict with stdout). Small, testable. Proposed alongside F-02's read-only work.
- **New F-13 (P2):** risk grading mismatch for `git.branch` (D-03). Reclassify `branch-create`/branch switch as modify in `capabilities/tools.py` and tool spec.
- **New F-14 (P3):** inconsistent stdout caps (terminal 400-char detail vs full output; sandbox 8000). Cosmetic; document.
- **New F-15 (P3):** http.request treats non-2xx as `_ok` (H-03). Consider fabric outcome mapping; verify already fails on status. Low priority.

F-04..F-11 unchanged.

### Proposed implementation order

1. Port Windows scope fix (F-03 candidate 1) + its test. Smallest, highest cross-platform value.
2. F-12: git.branch output capture.
3. F-07 triage on execution/verification/audit paths.
4. Readable deterministic fallback (F-03 candidate 2).
5. Informational routing (F-03 candidate 3) behind new tests, with git-status regression rerun.
6. F-13 risk grading.

---

## 8. Tests required to validate proposed fixes

| Fix | Required tests |
|---|---|
| Windows scope (F-03 c1) | `test_governance_windows_paths.py` (port from fix branch); Linux-simulated drive-letter targets; assert in-scope write allowed, out-of-scope denied. |
| git.branch output (F-12) | Unit: `git.branch` result appears in verified_outputs stdout and answer; mutation test restoring old behavior fails. |
| F-07 triage | Per-block: convert swallowed exceptions to logged/recorded; add tests that a failing subprocess surfaces in detail. |
| Readable fallback (F-03 c2) | Unit: summary contains objective, per-task capability, verification state; no audit/task ids in summary line. |
| Informational routing (F-03 c3) | Port `test_informational_questions.py`; rerun `test_git_status_grounding.py`, `test_read_only_requests.py`. |
| Risk grading (F-13) | Unit: capability risk grade for branch operations is `modify`. |

---

## 9. What was NOT done in this step

- No application source or configuration changed.
- No commits, pushes, branch switches, resets, cleans, stashes, or reverts.
- No tests run (audit-only). Existing evidence (3208 passed at df2cc92) stands.
- `graphify-out/` modifications and scratch files left untouched.