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

## Phase 3 additions (2026-10-26, audit only, no source changes)

### F-03 update — cross-platform reliability port (still open)
Full classification in `docs/audit/FEATURE_TOOL_MATRIX.md` §5. Summary:

- Candidate 1 — Windows drive-letter absolute paths in `_inside_scope` / `isAbs` (`governance/actions.py`, `governance/opencode.py`): **potentially useful, independently verifiable**. Not present on current HEAD. Clear test exists on the fix branch (`test_governance_windows_paths.py`). **Recommend port first.**
- Candidate 2 — readable deterministic fallback `_deterministic_summary` (`service.py`): **potentially useful**, overlaps current `service.py` only in a different region. **Recommend port second.**
- Candidate 3 — informational-question routing `_INFO_PROJECT_RE` (`intent.py`): **potentially useful, needs investigation**. Large new regex; overlaps F-02's `heuristic_interpret`/`_validated` changes. Port by hand behind its own tests; rerun git-status regressions. **Recommend port third.**
- Frontend/worker-name changes: **requires investigation** (TS overlap with current frontend).
- Do not merge or cherry-pick the branch blindly; do not switch branches.

### F-07 update — silent error triage (still open)
65 empty `except …: pass` blocks confirmed, concentrated in `governance/netgate.py` (10), `environment/procexec.py` (6), `exec_/` (4), `environment/executor.py` (3), `api/server.py` (5), `central_agent/service.py` (2). Triage execution/verification/audit paths first; reclassify any that hide a failed action as P1; document intentional best-effort.

### New findings

- **F-12 (P2) — RESOLVED (Step 3.2).** `git.branch` now returns a dict with `stdout`/`exitCode` (and `branch` on mutation), so inspection and mutation results propagate honestly; non-zero exits return `ok=False` with real output. Regression tests: `backend/tests/unit/test_git_branch_result.py` (6 passed). `_TEXT_RESULT_CAPS` membership no longer needed because the executor returns a dict.
- **F-13 (P2) — risk grading mismatch for branch operations.** `capabilities/tools.py` grades `git` branch creation as low-risk, but `git.branch` can create/switch branches (modify). Reclassify as modify in the tool spec.
- **F-14 (P3) — inconsistent stdout caps.** `terminal.execute` trims detail to 400 chars while keeping full output; `sandbox.execute` caps stdout at 8000. Cosmetic; document.
- **F-15 (P3) — `http.request` reports non-2xx as `_ok`.** Fabric outcome "succeeded" with `ok=True` for a 404; verification then fails on status. Intermediate consumers may be misled. Low priority (verify already fails).

F-04, F-05, F-06, F-08, F-09, F-10, F-11 unchanged.

## Alpha loop run — 2026-10-27 (all fixes uncommitted on top of `df2cc92`)

Earlier entries above are kept as written. This section records what this run verified, corrected and found. Status uses: open, fixed, verified, accepted limitation, decision needed. "Fails on committed code" means the regression test was run against a copy of `df2cc92` extracted outside the working tree and failed there.

### Context that explains most of the new security findings
Before approvals were removed, the policy gated every medium-risk capability with a human approval (`LEGACY_DEFAULT_BY_RISK`: low auto-execute, medium ask-user, high require-approval). Removing approvals mapped `ask-user` to auto-execute and `require-approval` to deny. A medium-risk executor therefore runs with no human in front of it, and has to be safe at its own boundary. A sweep of every auto-executing capability found three that were not, and one design choice that needs a decision.

### Corrections to earlier register entries
- **F-12 was marked RESOLVED with no recorded run.** Verified now: `test_git_branch_result.py` passes and 3 of its tests fail on the committed code. **Status: verified.**
- **F-15 is not a defect (corrected).** The register said a 404 comes out as `succeeded`. Through the real fabric it is `unverified`, with verification failed and the real status and body kept. Pinned by `tests/unit/test_http_request_status.py` (6 tests; a guard, so there is no fail-before). **Status: closed, not a defect.**
- **F-13 fixed.** `capabilities/tools.py` graded `branch-create` low-risk; it is now `modify`, like stage and commit. The fabric manifest, which enforces, was already correct (`git.branch` medium with `project.write`; `git.push` high and irreversible). The tool table's `push` label is `modify` against the manifest's high/irreversible; it is only a label (nothing enforces on it), pinned as a floor. `tests/unit/test_git_risk_grading.py` (10); the branch-create case fails on the committed code. **Status: fixed, verified.**

### F-16 (P1 security, Windows hosts) — drive-letter paths judged in scope — fixed in working tree
- **Evidence:** on `df2cc92`, `_inside_scope("D:/Windows/System32/evil.dll", [], "C:/repo")` returns True. A drive-letter absolute path is not recognised as absolute, is treated as relative, and an empty scope list allows it. The Node plugin mirror had the same flaw.
- **Fix (made by an earlier session, verified here):** `governance/actions.py` `_abs_marker` and the `isAbs` mirror in `governance/opencode.py`. Independent probe: 13 vectors correct (in-scope drive path, backslash form, traversal after the strip, different directory with the same suffix, other drive, prefix collision, drive-relative `C:foo`, UNC, no cwd, mixed platform, case difference denies).
- **Tests:** `test_governance_windows_paths.py` and the action-governance suite, 89 pass; the plugin mirror runs under Node (3 pass). 8 of the new tests fail on the committed code.
- **Limit:** these are Linux-hosted simulations of Windows path strings. No test was executed on Windows. **Status: fixed in working tree, verified on Linux, not verified on Windows.**

### F-17 (P1 security) — a damaged sovereign policy file silently turned sovereign mode off — fixed
- **Reproduced:** with `{"sovereignMode": true}` written, a truncated file, an empty file or a JSON array gave `sovereign_mode=False` (cloud allowed), with a warning on stderr only. A binary file raised `UnicodeDecodeError` out of the loader; `service.py` swallowed it and `api/server.py` set the policy to `None`, which the agent runtime treats as no enforcement.
- **Fix:** `sovereign/policy.py` catches `(OSError, ValueError)`; a file that exists but cannot be read, or is not a JSON object, turns sovereign mode ON (cloud blocked, local and private classes keep working) with `source="unreadable-file"`. A missing file still means never configured. An explicit `AURA_SOVEREIGN_MODE` still decides. New `fail_closed_policy()` is used by `service.py` and `api/server.py` instead of `pass` / `None`.
- **This is a deliberate behaviour change:** the loader's docstring had documented "fail-open for policy load failures". Reviewers should confirm it.
- **Tests:** `tests/unit/test_sovereign_policy_failclosed.py` (10); 5 fail on the committed code, plus the API-server case. **Status: fixed, verified.**

### F-18 (P1 security) — `sandbox.execute` ran any program in any directory — fixed
- **Reproduced two ways:** through the real fabric (`id` ran; a file was written outside the project), and through the agent's planner and dispatch (a model-proposed plan with `cwd` outside the project was accepted, auto-executed, and the run reported completed).
- **Cause:** the executor took `cwd` from its own input and ran `shlex.split(command)` with no allow-list. Its manifest says it runs "inside the project root". It was a third route around the three disjoint allow-lists in `exec_/`.
- **Fix:** the same single-command rule as `terminal.execute` (allow-listed binaries, no shell operators, no installs); `cwd` must be inside the invocation's project root (set by the controller, never by the input); no project root means refuse. Shared helper `confine_to_project`.
- **Tests:** `tests/unit/test_sandbox_confinement.py` (17); 14 fail on the committed code, including the agent-path reproduction. Five existing sandbox tests in `test_new_executors.py` and the acceptance test A16 ran `echo`, `false`, `sleep` or `sys.executable` with no project root; their setup now uses allow-listed commands and a project root. Their assertions on exit code, stdout, timeout and verification are unchanged.
- **Residual:** allow-listed `node`, `npm`, `python3` and `go` can still run arbitrary project code, as in `terminal.execute`. "Sandbox" is a misnomer: there is no process-level isolation. **Status: fixed, verified; the naming and isolation limit is an accepted limitation.**

### F-19 (P1 security) — `document.ingest` read any file, `artifact.generate` wrote anywhere — fixed
- **Reproduced:** `document.ingest` ingested a file outside the project, so `knowledge.search` could return its contents. A chain of ingest, search and `http.request` could exfiltrate any readable file. `artifact.generate` with an `output_path` outside the project wrote there, and on the committed code overwrote an existing file.
- **Fix:** both paths are confined to the project root with `confine_to_project` (relative paths resolve against the root; absolute, `..`, `~` and symlink escapes are refused; no root means refuse). The default artifact folder in the AURA home needs no project and is unchanged.
- **Tests:** `tests/unit/test_executor_path_confinement.py` (13); 11 fail on the committed code. Seven existing tests across `test_new_executors.py`, `test_document_artifact_pipeline.py`, `test_inspection_to_approval_note.py` put documents outside the project they named; their files now live inside it. Two "secret text not in the output" tests would have passed vacuously once ingestion failed, so each now asserts the ingest really succeeded.
- **Status: fixed, verified.**

### H-02 (P2) — stopping a run did not stop a running command — fixed for `terminal.execute` and `sandbox.execute`
- **Reproduced:** a stop at 1 s let a 6 s script finish and write its marker; a run already stopped still launched the command. The existing cancellation tests replace `invoke_fabric` with a fake, so they never saw this.
- **Fix:** both executors pass the run's stop signal to the process runner, which terminates the whole process group (TERM, then KILL), and decide cancellation from the token as the worker path does. A command that exited on its own before the stop is not marked cancelled.
- **Tests:** `test_terminal_cancellation.py` (3), and two in `test_sandbox_confinement.py`. They check that no process from the command survives, instead of sleeping. **Status: fixed, verified.**

### F-07 (P2) — silent error handling — partly fixed, rest triaged
- AST census: 200 handlers whose whole body is `pass`, `continue` or a constant return (the earlier 65 was a narrower text search).
- **Fixed (a lost record was invisible):** the four `on_task_start` / `on_task_complete` blocks in `execution.py` (`_progress` helper), the queue save in `service.py`, and the last-resort handler for a crashed background run. They keep the run going and now log with a traceback. `tests/unit/test_progress_callback_failures.py` (5); the three behavioural tests fail on the committed code.
- **Triaged, intentional best-effort, left as is:** telemetry emits, memory notes, advisory classification, orphan cleanup, process-kill and socket teardown.
- **Open (P3):** `git_is_repo` answers False on any exception, so a missing git binary or a timeout reads as "not a git repository". About 150 handlers outside `service.py`, `execution.py`, `exec_/` and `governance/netgate.py` were not individually reviewed. **Status: partly fixed; triage incomplete.**

### F-20 (P2 security) — `http.request` reaches loopback and private hosts with any method — decision needed
- **Evidence:** an agent actor sent GET, POST, PUT and DELETE to a loopback service through the real fabric, and the service received all four. The code says so on purpose ("Loopback stays allowed — local model servers are a supported setup"); only cloud metadata hosts are blocked.
- **Why it matters now:** the human approval that used to stand in front of this call is gone. An unauthenticated local service, for example the local model server's delete call, is reachable by an autonomous plan, including one steered by text from a web page.
- **Not changed:** this reverses a documented design choice. **Options:** (a) agent actors may use only GET and HEAD against loopback, private and link-local addresses; (b) refuse those addresses for agent actors; (c) accept the exposure and document it.

### Accepted limitation
- **F-21 (P3):** `project.create` with a `parentPath` makes empty directories anywhere the user can write. It never overwrites (a name collision gets a `-2` suffix) and writes no files.

### Low priority
- **F-22 (P3):** the Node service keeps a vestigial mission approval state and the `mission.approve` capability. Nothing gates on a human any more: the mission engine approves plans itself ("Plan ready — execution unlocked"), so an agent approving a mission opens nothing. It is clutter from the approval removal and should go in a dedicated change.

### Capabilities swept and found sound
`filesystem.list/read/write` (symlink-confined), `terminal.execute` (allow-listed, now cancellable), `tool.provision` (validated allow-list of node ids; every other input discarded).

## Owner decisions applied — 2026-10-27 (second Alpha loop; all changes uncommitted on top of `df2cc92`)

The owner decided F-20 and F-17. This section appends to the register above; nothing earlier is rewritten.

### F-20 (P2 security) — `http.request` to local and private services — FIXED, both services
- **Decision:** an autonomous request to a loopback, private-network or otherwise non-public address may use GET and HEAD only; POST, PUT, PATCH, DELETE and anything else is refused. Local model-server reads keep working. A user-initiated request (actor kind `human`) is not limited and stays distinguishable in the audit trail by its actor. A missing or unknown actor is treated as autonomous. GET and HEAD are **not** claimed to be side-effect free; they are the narrowest methods that keep read access.
- **Where:** Python `backend/aura/executors/http_policy.py` (used by `http_request`); Node `packages/ai-service/src/fabric/httpPolicy.ts` (used by the fabric `http.request`). The authorization model (policy, manifests, risk grades) is unchanged.
- **How it holds:**
  - The check runs on the address actually connected to, so a name that resolves to a private address cannot get past a check on the URL text. All DNS answers are judged before any is connected, and the connection goes to the address that was checked (resolved once, no second lookup).
  - Every redirect hop is checked again (Python: same opener; Node: redirects followed by hand). A redirect to a non-http(s) scheme is not followed.
  - Cloud-metadata addresses (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`, including IPv4-mapped forms) are refused for **every** actor, after resolution as well.
  - Environment proxies are off for autonomous requests (a proxy would hide the real destination from the check).
  - Address classes treated as non-public: loopback, private, link-local, CGNAT, unspecified, reserved, multicast, IPv4-mapped IPv6.
- **Defect found while testing the Node side:** Node does not call `lookup` for a literal-address URL, so a first version never checked `127.0.0.1` or `169.254.169.254`. Literal hosts are now judged explicitly before connecting. The Python side always resolves, so it was not affected.
- **Tests:** `backend/tests/unit/test_http_destination_policy.py` (53) and `packages/ai-service/src/fabric/httpPolicy.test.ts` (47). Against `df2cc92`, the agent-method and metadata tests fail (Python), and 9 of the 15 executor-level Node tests fail.
- **Residual:** a hostname answered with a public address is not limited by this policy (it cannot be told from any other internet host). A service on a non-loopback address that is reachable only because it is public is out of scope. Scheduled or automation-triggered workflow runs default to a human actor (F-25).

### F-27 (P2 security) — `web.research` fetch had the same metadata bypass — FIXED
- **Found by sweeping the sibling of F-20:** the metadata block screened the URL text only, so a redirect from an ordinary page, or a name resolving to the metadata address, reached it.
- **Fix:** the fetch uses the same checked opener (GET only; local gateways stay readable; environment proxies still apply, with a literal-metadata check on each redirect hop).
- **Tests:** `backend/tests/unit/test_web_research_destination.py` (5); the redirect and DNS cases fail on `df2cc92`.

### F-17 — sovereign policy fail-closed — CONFIRMED, revalidated, documented
- The owner confirmed it. Behaviour unchanged from the earlier fix: a policy file that exists but is malformed, truncated, empty, binary, not a JSON object, a directory, or unreadable keeps sovereign mode ON (cloud blocked; local and private classes keep working). A missing file is still "never configured"; an explicit `AURA_SOVEREIGN_MODE` still decides.
- **Revalidated** with an independent probe of 16 file and environment cases (all as specified) and the 10 regression tests. The module header of `backend/aura/sovereign/policy.py` now states the failure behaviour; the loader docstring already did. The Node service has no second reader of `sovereign.json` (its `sovereignMode` is an in-memory default), so there is one source of truth.

### F-07 — silent error handling — triage COMPLETE for Python; TypeScript triaged
- AST census of 193 handlers whose whole body is `pass`, `continue` or a constant return; each was read in context, none was replaced mechanically.
- **Fixed (a failure was invisible, behaviour kept):** governance hook now records an `UNAVAILABLE` decision when its input, its scope document or its argument is unreadable (it still exits 0, see F-23; `test_governance_hook_unavailable.py`, 12); API server logs a failed startup recovery of interrupted sessions, an unexpected session-load failure and a failed event-bus publish (`test_server_swallowed_errors.py`, 3; the publish handler sits in a streaming driver and is not covered by a test); event subscribers, workflow listeners and a temporary workflow that could not be removed are logged; the provisioner logs a failure to record a confirmed tool (`test_observer_failures_logged.py`, 5).
- **Fixed (wrong direction):** `claude_code._is_live_path`, the guard against writing to the live Claude settings file, answered "not live" when it could not resolve a path; it now answers "live" (refuse).
- **Reviewed and left, with reason:** network-class classification (`model_routing`) already fails closed to `unknown` (treated as cloud); the staging `chmod` handler is harmless because the hook is run as `python3 <path>`; socket, process, cancel and teardown handlers; OCR and metadata extraction that degrade to less text; telemetry.
- **TypeScript:** 11 literally empty `catch` blocks, each with a stated best-effort reason; about 50 `.catch(() => null)` UI loaders where null means "unavailable". Three discard a **cancel** failure, so a stop that did not work looks as if it did (F-24).

### New findings from this loop
- **F-23 (P2, decision needed) — governance hook fails open when it cannot read its scope document.** Exit 0 means allow; the runtime's own `--add-dir` confinement remains. The file is one AURA staged itself, so its absence means governance is not configured. It is now **recorded** (F-07) but still not **blocked**. Options: (a) keep, with the record; (b) deny on an unreadable scope document only (our own file), keep open on unreadable stdin. Not changed: it reverses a documented decision, and (b) would stop a run on a staging fault.
- **F-24 (P3) — three cancel paths discard the failure:** `useGeneralChat.ts:170`, `useWorkflows.ts:506`, `useAutomation.ts:227`. UI behaviour; needs a GUI check that is not available here (F-08).
- **F-25 (P3, observation) — scheduled or automation-triggered workflow runs default to a human actor** (`workflow/runner.py`). The agent has no capability that creates a rule or schedule, so a person must schedule or run an agent-authored workflow; that is an explicit user act. Noted so F-20's "human" exemption is not mistaken for an agent path.
- **F-26 (P3, design) — `knowledge.search` searches one global index.** Content ingested from project A can be returned in an agent run for project B. Everything belongs to one local user, so this is not an exploit, but it cuts against the per-project confinement of ingestion (F-19). Needs a design decision (scope the index by project).

### Capabilities swept in this loop and found sound
`git.status/diff/branch/commit` (option-injection guard, working directory fails closed), `git.push` (denied for agent **and** human through the fabric; a local bare remote received nothing), `workflow.create` (stores a definition only), `agent.delegate` (fails closed at dispatch on no project directory, unknown role, malformed scope, binary not on the allow-list, owner's billing policy; the worker's own file actions are governed by the hook and plugin, see F-23), `project.open/inspect/list`.

### F-28 (P2 product, packaging) — document libraries are not bundled — OPEN, decision needed
- **Evidence:** the packaged AppImage's bundled Python has no `python-docx`, `openpyxl`, `reportlab` or `pypdf` (declared in `backend/pyproject.toml`, absent from `resources/python/site-packages`). In the packaged runtime `artifact.generate` for docx fails with "python-docx not installed", and docx/pdf ingestion cannot extract. The failure is honest (no false success). Predates this loop.
- **Not changed:** bundling needs platform-specific wheels (`lxml`, Pillow) in the build script; the owner should decide whether Alpha ships these features or documents them as unavailable.

### F-20 residual note
The actor on `/fabric/invoke` (Python and Node) is asserted by the caller of that route. Only the desktop UI, holding the per-launch instance token, calls it, so the user's exemption is not reachable from agent-internal calls (they set their own actor). A webhook-triggered run carries a `system` actor, which is limited like an agent.

## Alpha loop 3 — 2026-10-28 (owner decisions on F-23, F-24, F-26, F-28; all changes uncommitted on top of `df2cc92`)

Earlier entries are kept as written. Statuses here state what was verified and where; packaged-application results are in `VALIDATION_REPORT.md` Run 9.

### F-23 (P2 security) — governance hook failed open — FIXED (owner decision: fail closed)
- **Decision:** a governance scope file that exists but is unreadable or invalid must not authorize the operation. Missing-file and valid-policy semantics are preserved.
- **What was wrong, beyond the scope-file case:** Claude treats only exit code 2 as a block. The hook exited 0 on unreadable input, an unreadable scope document and a governance core that could not load, and any other failure (a crash, `python3` missing, a bad `seq` value raising an uncaught exception) is a non-blocking error, i.e. an allow. It also allowed on any verdict other than `DENY`. And `agent.delegate` carried on, ungoverned, when staging a scoped task's governance crashed ("proceeding under pre-existing boundaries only").
- **Fix:**
  - `claude_hook.py` exits 2 and logs a `DENY` (reason "governance unavailable: …") for: hook input that is not a JSON object; a scope document that exists but cannot be read, is empty, malformed, not an object, or has wrong-typed fields; a governance core that cannot load; any unexpected error; any verdict that is not an explicit `ALLOW`. Valid scope behaves as before.
  - **Genuinely missing** (no scope argument, or no file at the staged path) keeps its documented meaning: runtime confinement only. It is recorded as `UNSCOPED`, a decision of its own, not as an allow by the governance core and not counted as `ALLOW`.
  - `governance/claude.py` `hook_command` wraps the launch so any exit code other than 0 and 2 becomes 2 (POSIX), and quotes the paths (a path with a space previously split the command).
  - `executors._stage_governance` returns a failure for a scoped task whose governance cannot be staged or loaded, and `agent.delegate` refuses before spawning anything (`blocked: governance-staging-failed`, network boundary closed).
- **Tests:** `tests/unit/test_governance_hook_unavailable.py` (43): valid scope, missing file, no argument, empty/truncated/binary/array/scalar/null content, a directory, a dangling symlink, a mode-000 file, eight invalid-field cases, bad stdin, core load failure, unexpected error, three non-ALLOW verdicts, the launch wrapper (real hook, missing interpreter, crashing hook, never-staged hook, spaces in paths) and the dispatch refusal for both OpenCode and Claude with a control that the same task runs when staging works. Each deny is asserted on both the exit code and the logged decision. 37 of 43 fail on `df2cc92`.
- **Residual risks (stated, not hidden):** a **deleted** scope file is indistinguishable from "no scope staged" and is allowed with an `UNSCOPED` record, as the owner's missing-file rule requires; the worker cannot reach the staged files (outside its cwd), so this needs something with filesystem access. On Windows the launch wrapper is not applied, so a missing interpreter there is not converted to a deny. The OpenCode/Kilo plugin has its policy compiled in (no scope file to lose); whether a runtime refuses to start when its plugin fails to load was not tested here.

### F-24 (P2) — three Stop buttons discarded the result of the stop — FIXED at code and test level; GUI validation NOT RUN
- **What was wrong:** Start Building's `stop()` fired the cancel, swallowed any failure and aborted the stream at once; the workflow `stopRun` did `.catch(() => null)` and then set the run to "cancelled"; automation `cancelRun` fired and forgot. A failed or unanswered stop looked like a stopped run, and a run that finished first was relabelled. Both service clients return the response body whatever the HTTP status, so a 409 or 404 never even reached those handlers.
- **Fix:** four distinct states, shared classifier `ai/cancellation.ts`: *requested* (not yet confirmed, never shown as stopped), *confirmed* (the engine's own record or outcome says cancelled), *already-finished* (real outcome kept), *failed* (nothing changed, the run is still running, reason on screen).
  - Start Building: a landed request leaves the turn "stopping" with the stream kept; only the agent's own `outcome: cancelled` confirms; a failure restores "streaming" with a note; a repeated press joins the request in flight; an answer that finished first is shown as done with a note. Leaving the conversation still sends the stop and logs a failure.
  - Workflow runs: never "cancelled" unless the engine says so; the run record is read to confirm within a bounded window (8 × 400 ms); the stream's `done` event is read through its real `runState`; "Stopping…" and a visible note in the editor.
  - Automation: `cancelRun` returns the classified result and the run view shows it. Backend: the cancel route now answers **409** for a run that had already finished and 404 only for one that does not exist (it answered 404 "not found" for both).
- **Tests:** `ai/cancellation.test.ts` 19, `ai/generalChatStop.test.ts` 11, `data/stopRunStates.test.ts` 20 (successful, failed, repeated and completion-racing stops, run through the real stores and clients against a faked `fetch`), and `tests/unit/test_automation_cancel_states.py` 2 (fail on `df2cc92`). The UI tests were not run against the committed UI code; the old behaviour is shown by reading it.
- **Not validated:** no GUI automation exists (F-08), so a real click-through of the three Stop buttons was not performed. **GUI validation: NOT RUN.**
- **F-29 (P3, residual):** the automation engine's `cancel_run` still turns a run that already **failed** into "cancelled". Its behaviour is pinned against the original TypeScript engine by a differential test, so it was not changed; the UI offers Stop only on active runs.

### F-26 (P2 security) — knowledge search is now project-scoped — FIXED
- **Contract:** knowledge belongs to one project. The project identity comes from the invocation context (the controller sets `projectId` on every agent invocation; a caller, never the tool input, sets it) or, for REST, from a **registered** project the caller names (400 if missing, 404 if not registered). A missing identity is a refusal and never a global scope. Naming a different project in a tool's input is refused. **No cross-project authorization mechanism exists in the architecture, so none is granted; cross-project access is always denied.**
- **Enforcement is in the KnowledgeBase API** (a required keyword `project_id`, no default), so the tools, the three REST routes and any other caller apply one policy: `add_document`, `search`, `search_with_context`, `remove_document` and `documents` all require it. Records carry their project; a document id includes the project (the same file in two projects is two documents); each project has its **own BM25 index**, so ranking scores do not depend on another project's text. The monitoring snapshot no longer lists documents.
- **Old records:** records written before projects were tracked, and records with a damaged project value, load as **unscoped**: kept, counted (`unscopedDocuments`), never returned, never adopted by a project automatically. Ingesting the file again inside its project brings it under that project; the old record stays unreachable. No automatic migration was done: a record's path cannot establish ownership (REST uploads store only a file name), so inferring it would invent trust.
- **UI:** the composer, the documents panel and the client methods pass the open project and refuse with "Open a project first" before any request.
- **Tests:** `tests/unit/test_knowledge_project_scope.py` (39: isolation, missing/invalid identity for every operation, score independence, restart, legacy and damaged records, the tool with and without identity, an input naming another project, the real fabric, REST 400/404/scoping, and the tool and REST route agreeing for the same project) and `ai/knowledgeScope.test.ts` (7). The original leak was reproduced on `df2cc92` (project B's search returned project A's text). Eight existing test files were adapted (API/context only, assertions unchanged).
- **Test lesson recorded:** the tool echoes the query in its reply, so a search for a word proves nothing; the tests assert on a marker that exists only in the document text.

### F-28 (P2 product) — document libraries and document ingestion — FIXED in the build; packaged proof in Run 9
- **Three findings, not one:**
  1. The bundle build installed only `[project] dependencies`; `python-docx`, `openpyxl`, `reportlab`, `pypdf` (in the `multimodal` and `artifacts` extras) were never shipped.
  2. **Deeper:** `DocumentEngine` sent DOCX, XLSX and PDF **only to Docling**, a multi-gigabyte optional stack that is not shipped. Without it, ingesting any of the three failed with "docling package not installed" even where `pypdf` and `python-docx` were present; `DocumentIngestor` (which uses those libraries) was exported and unused. This also explains the 61 skipped tests. Bundling the wheels alone would have changed nothing.
  3. `artifact.generate` read any image named in a section's `image_path` from anywhere the process could read and embedded it in the document (same class as F-19).
- **Fix:** `scripts/build-service-bundle.mjs` reads the `multimodal` and `artifacts` extras from `backend/pyproject.toml` (one declaration of each constraint) and installs them in the same pip run as the backend's dependencies, for the bundled interpreter; `docling` is deliberately excluded. New `aura/multimodal/light.py` `LightOfficeEngine` reads PDF, DOCX and XLSX with `pypdf`, `python-docx` and `openpyxl`, used **only when Docling reports itself missing** (a machine with Docling keeps today's behaviour), and says so in the result. Guards: 100 MB source cap, 300 MB unpacked cap on the zip containers (refused before a parser runs), password-protected PDFs refused, a PDF with no text layer is `OCR_REQUIRED`, uncached-formula workbooks are not reported as success, a missing library is a typed dependency error naming the extra, never an empty success. Image paths in a section must be inside the project or the request is refused. `scripts/packaging-verify.mjs` gained 1m (libraries are in the artifact) and 1n (the packaged interpreter alone writes and reads each format).
- **Tests:** `tests/unit/test_light_office_engine.py` (37) and `tests/unit/test_bundled_document_extras.py` (5).
- **Limits:** no OCR, no layout or table reconstruction beyond rows and cells, no formulas (cached values only), no `.doc`/`.xls`/`.pptx`. Compiled parts (`lxml`, Pillow) resolve for the **bundled** CPython (3.12); a system Python of another version used as a fallback would not have them and would answer with the honest dependency error.

### F-32 (P3, tooling) — the packaging verifier no longer matches the product — OPEN
`scripts/packaging-verify.mjs` fails 17 of its 60 checks on a correctly built package, so it cannot currently gate a release. Causes (evidence in `VALIDATION_REPORT.md` Run 9): it sends no per-launch instance token, so every capability check is refused by the ownership guard; it asserts an approval gate that was removed on purpose; its window checks need a window manager; one check looks for superseded wording. It does still verify the artifact's contents and structure (1a–1n, 3a–3c, 6, 7, 8a–8c3 all pass). A packaged capability proof is currently done by a separate harness run against the extracted artifact (`docs/audit/evidence/loop3/packaged_runtime_harness3.py`). Fixing the verifier needs a way for an external script to obtain the launch token (or to launch the bundled backend itself), which is a design decision.

### Loop 3 status summary (see Run 9)
- **F-23, F-26, F-28:** fixed; verified in source and in the packaged runtime. **F-24:** fixed and verified at store, client and backend level; GUI click-through **NOT RUN**. Packaged UI smoke **NOT RUN** (Ollama service broken after reboot).
- **Open, unchanged:** F-08 (no GUI harness), F-09 (signing blocked), F-16 (Windows unverified), F-29, F-32. (The image-path and Docling-only-routing defects were found and fixed inside F-28.)

## Alpha loop 4 — 2026-10-28 (all changes uncommitted on top of `df2cc92`)

### Corrections to loop 3
- **The desktop app uses the Node service for automation (port 4319), not the Python backend.** Loop 3's automation 409 and its packaged check were on the Python route only; the Node route still answered 404 for a finished run. Both now answer 409, and the Node route is checked in the packaged verifier (5g).
- Loop 3 said the automation engine's cancel behaviour was "pinned by a differential test". The differential covered only cancelling a **queued** run, not a failed one.
- Loop 3 counted the 17 verifier failures as "15 token-related". The correct split is 11 / 3 / 2 / 1 (see `VALIDATION_REPORT.md` Run 10).

### F-29 (P2) — automation run lifecycle — FIXED in both engines
- **Defects (present in the TypeScript original and its Python port):** `cancelRun` treated only completed and cancelled as finished, so a **failed** run was rewritten as "cancelled"; every retry attempt reset the run's status, so a Stop during a retry wait was silently undone (and a paused run overwritten); a failure arriving after a Stop replaced "cancelled" with "failed" and emitted a second, contradictory `done` event; in the Python engine the check-then-write ran across the API thread and the event loop with no lock, and (found by a cross-thread race test) a stale snapshot could be written after the Stop, leaving the **stored record `running` for a cancelled run**.
- **Contract now:** completed, failed and cancelled are terminal and the first one reached wins; a Stop on a finished run does nothing (the Node and Python routes answer 409, 404 only for an unknown run); a Stop on an active run cancels it, and the in-flight action keeps its own outcome on its own state without changing the run; exactly one `done` event, naming the final status; the stored record always agrees with the last event. The Python engine serializes settling and saving under a lock; the clock is read in the original order so the differential against the TypeScript engine still holds.
- **UI:** the automation Stop reconciles a non-transport refusal with the run's own record before saying it "may still be running".
- **Tests:** `backend/tests/automation/test_automation_lifecycle.py` (14; 7 fail on `df2cc92`, including a 60-iteration cross-thread race), `packages/ai-service/src/automationLifecycle.test.ts` (14; 6 fail on the committed TypeScript engine), three new differential scenarios, `ai/cancellation.test.ts` and `data/stopRunStates.test.ts` (+8). The old differential did not encode the bug, so nothing was replaced or deleted.
- **Test-infrastructure defect found on the way:** the differential's TypeScript oracle bundle was reused whenever it existed, so after any engine edit it compared Python against an outdated build; it is now rebuilt when the source is newer.
- **Residual:** pause/resume in the differential, and a Stop racing a live run across the two engines in lock-step, are covered by the lifecycle tests only. A Stop does not interrupt an action already running (it signals the run's abort flag, which actions may not honour); the run's record says cancelled while that action finishes.

### F-32 (P3 tooling) — packaging verifier — RESOLVED
Final run on the final artifact: 62 passed, 0 failed, 0 blocked, exit 0. The token is obtained from the launched process tree (not a bypass), ownership is proven first, the token is redacted, and the checks match the current contract. **Limitation:** needs a window manager on the display for 3d/3e (otherwise `BLOCKED`, exit 2); the token discovery reads `/proc/<pid>/environ` of processes descended from the app it launched, so it is Linux-only like the rest of the script.

### F-24 (P2) — status update
GUI validation of the Start Building Stop button is now **PARTIAL**: "Stopping…" with "Stop requested. Waiting for the agent to confirm." observed, then "Stopped." only after the agent confirmed (evidence in `docs/audit/evidence/loop4/gui-stop-*.png`). The failed-stop, finished-first and repeated-stop states, and the workflow and automation Stop buttons, were not driven through the GUI.

### F-33 (P3, environment) — Ollama service does not start — OPEN, owner action
Cause and facts in `VALIDATION_REPORT.md` Run 10. The unit is shadowing the package's and points at a missing path, and the models live in the user's store, not the service user's. Options for the owner (not executed; they need root):
- **A (recommended while the models live in `/mnt/storage/.ollama`):** stop the restart loop and run Ollama as the user: `sudo systemctl disable --now ollama`, then start it as the user (for example `OLLAMA_HOST=127.0.0.1:11434 ollama serve`).
- **B:** keep a service but make it serve the models: edit `/etc/systemd/system/ollama.service` to `ExecStart=/usr/bin/ollama serve`, run it as the user that owns the store (`User=Groot`, `Group=Groot`) or set `Environment=HOME=/home/Groot` and `Environment=OLLAMA_MODELS=/mnt/storage/.ollama/models`, then `sudo systemctl daemon-reload && sudo systemctl restart ollama`.
- Removing the admin unit so the packaged one applies would serve an empty store (`/var/lib/ollama`) unless the models are moved or `OLLAMA_MODELS` is overridden.

### Status after loop 4
Fixed and verified in source and in the packaged artifact: F-23, F-26, F-28, F-29, F-32. **Open:** F-08 (no GUI automation; F-24's remaining GUI states), F-09 (signing), F-16 (Windows verified on Linux only), F-33 (Ollama service, owner action), and the documented residuals (a deleted scope file is read as "no scope"; a Stop does not interrupt a running action).

## Alpha loop 5 — cross-platform audit — 2026-10-28 (all changes uncommitted on top of `df2cc92`)

Full detail, reproductions and the 13-row matrix: `docs/audit/CROSS_PLATFORM_MATRIX.md`. Executed only on Arch Linux x86_64. **Windows and macOS were not executed; Ubuntu/Debian runtime is blocked.**

| ID | Sev | Status | Summary |
|---|---|---|---|
| X-01 | P2 | **FIXED** (Linux-verified; Windows branch unverified) | Stop/timeout ended only an agent's own process; its workers kept running and a timeout could hang forever. `execFile` ignores `detached`. Runner now uses process groups (`taskkill /T` on Windows). Test `exec/processTree.test.ts`. |
| X-02 | P3 | **FIXED** (Linux simulation only) | Installer executor killed one process on Windows. |
| X-03 | P3 | **FIXED** | MCP client `close()` left the server's workers running. |
| X-04 | P2 | **FIXED in source, UNVERIFIED** | Windows graceful shutdown lacked the launch token; every Windows quit = 5 s wait + hard kill. Found by code trace; Rust/Node unit tests pin the request; needs a Windows run. |
| X-05 | P3 | **OPEN** | Python backend has no shutdown route; hard-terminated on Windows. |
| X-06 | info | recorded | glibc floor 2.34 (Ubuntu 22.04+/Debian 12+ statically loadable); `scripts/glibc-floor-verify.mjs`. |
| X-07 | — | added | hostile-path coverage test (no defect). |
| X-08 | P3 docs | **OPEN** | INSTALL.md lacks glibc/WebKitGTK requirements. |
| X-09 | info | **OPEN** | CI runs pytest on Linux only. |
| F-33 | P3 env | **OPEN, owner action** | Ollama unit points at a missing binary, models are in the user's store; proposed units prepared, nothing installed. |
| F-24/F-08 | P2 | **PARTIAL** | Chat Stop verified in the GUI (stopping → stopped only after confirmation; repeated Stop; completed run). Failed/unconfirmed cancel, retry-wait, workflow and automation Stop covered by tests only. A Stop does not interrupt an action already running in the automation engine. |
| F-09 | — | **BLOCKED** | no signing key. |
| F-16 | — | **NOT RUN** | Windows and macOS never executed. |

Unchanged and revalidated (targeted + full suites, packaged harness/verifier): F-12, F-17, F-20/F-27, F-23, F-26, F-28, F-29, F-32.
Unconfirmed observation: an orphaned `aura-hub` ignored SIGTERM after its AppImage runtime was signalled; graceful SIGTERM to `aura-hub` exits cleanly; not reproduced through the supported quit path.

### Proposed logical commits (NOT executed; `†` = file shared across commits, needs hunk-level staging)
1. **Confinement and hardening** (earlier loops): `backend/aura/executors/__init__.py`†, `capabilities/tools.py`, `governance/actions.py`, `governance/opencode.py`, `sovereign/policy.py`, `central_agent/{execution,service,events,provisioner}.py`, `workflow/__init__.py`, `agent_runtime/adapters/claude_code.py`, `api/server.py`†, with their tests.
2. **HTTP destination policy** (F-20/F-27): `executors/http_policy.py`, `executors/web_research.py`, `packages/ai-service/src/fabric/httpPolicy.ts` (+test), `fabric/executors.ts`†, `test_http_destination_policy.py`, `test_web_research_destination.py`.
3. **Governance fail-closed** (F-23): `governance/claude_hook.py`, `governance/claude.py`, `test_governance_hook_unavailable.py`.
4. **Knowledge scoping** (F-26): `knowledge/store.py`, `executors/__init__.py`†, `api/server.py`†, UI client/composer/documents panel, `test_knowledge_project_scope.py`, and the adapted acceptance/integration/e2e/executor tests.
5. **Cancellation and lifecycle** (F-24, F-29): UI `cancellation.ts`, `useGeneralChat.ts`, `GeneralChat.tsx`, `useWorkflows.ts`, `useAutomation.ts`, `AutomationRunView.tsx`, `WorkflowEditor.tsx` and tests; `automation/engine.py`, `api/server.py`†, lifecycle tests; `packages/automation/src/engine.ts`, `ai-service/src/server.ts`, `automationLifecycle.test.ts`, differential test.
6. **Process-tree termination on Stop/timeout (this loop)**: `packages/ai-service/src/exec/process.ts`, `exec/processTree.test.ts`, `fabric/terminalInstallGuard.test.ts`, `backend/aura/environment/executor.py`, `central_agent/mcp_transport.py`, `test_install_executor_windows_tree_kill.py`, `test_mcp_transport_tree_cleanup.py`.
7. **Windows graceful shutdown carries the launch token (this loop)**: `apps/desktop/src-tauri/src/service.rs`, `packages/ai-service/src/instanceGuard.test.ts`.
8. **Document libraries** (F-28): `multimodal/light.py`, `multimodal/document_engine.py`, `scripts/build-service-bundle.mjs`, document tests.
9. **Packaging and cross-platform tooling**: `scripts/packaging-verify.mjs` (F-32), `scripts/glibc-floor-verify.mjs`, `backend/tests/unit/test_hostile_project_paths.py`.
10. **Audit documentation and evidence**: `docs/audit/*.md`, `docs/audit/CROSS_PLATFORM_MATRIX.md`, `docs/audit/evidence/`.
**Do not commit:** `graphify-out/`, `common-context.json` files, `.commandcode/`, `.kilo/`, `.verify-claude/`, `backend/work/`, scratch `gq_*.txt`, `scripts/*toc*`, `generate_dpr_docx.py`, generated report `.docx`/`.pdf`.

## Alpha loop 6 — 2026-10-28 (uncommitted on `df2cc92`)

| ID | Sev | Status |
|---|---|---|
| X-05 | P3 | **FIXED** (Linux-verified): token-guarded, idempotent `POST /shutdown` on the Python backend; Node route also refuses when no token is configured. Windows execution NOT RUN. |
| X-08 | P3 docs | **DONE**: `INSTALL.md` corrected (Node/Python ARE bundled) and requirements added with measured/declared/inferred labels. |
| X-09 | info | **PREPARED, NOT RUN**: `ci.yml` backend job is a Linux/Windows/macOS-arm64 matrix; expect first-run Windows findings (35 test files use POSIX constructs unguarded — prediction). |
| X-10 | P2 | **FIXED**: an automation Stop was shown as fully "cancelled" while an in-flight action could still be running. Now `cancellation.phase` winding-down → complete in both engines and the UI. Residual: handlers that ignore the abort signal (audit, security review, docs review, update-knowledge, save-memory) cannot be interrupted; side effects are not rolled back. |
| X-11 | P3 | **OPEN**: `desktop-build` CI legs do not run `cargo test --lib` (the Windows shutdown request tests). |
| F-33 | P3 env | **OPEN, owner action** (see `evidence/loop6/ollama-recommendation.txt`). |
| F-24/F-08 GUI | P2 | automation/workflow Stop and failed-cancel states still not GUI-driven; NOT RUN on this artifact. |
| F-09 / F-16 | — | signing BLOCKED; Windows and macOS NOT RUN. |

### Updated proposed commits (NOT executed; `†` = shared file, hunk-level staging)
1–5, 8, 9, 10 as in the loop 5 plan, with these additions:
- **5 (cancellation and lifecycle)** now also: `packages/automation/src/types.ts`, `packages/automation/src/engine.ts`†, `backend/aura/automation/engine.py`†, `apps/desktop/src/ai/cancellation.ts`, `apps/desktop/src/ai/automationClient.ts`, `apps/desktop/src/screens/automation/AutomationRunView.tsx`, and their tests (`automationLifecycle.test.ts`, `test_automation_lifecycle.py`, `cancellation.test.ts`).
- **6 (process trees)** unchanged; add the new cases in `exec/processTree.test.ts`.
- **7 (Windows shutdown)** now: `apps/desktop/src-tauri/src/service.rs`, `packages/ai-service/src/instanceGuard.ts`, `instanceGuard.test.ts`, `packages/ai-service/src/server.ts`† (Node route), plus **new** `backend/aura/api/shutdown.py`, `backend/aura/api/server.py`† (route), `scripts/serve_central_agent_api.py`, `backend/tests/unit/test_backend_graceful_shutdown.py`.
- **11 (new): cross-platform CI** — `.github/workflows/ci.yml`.
- **12 (new): install documentation** — `docs/INSTALL.md`.
- **10 (docs/evidence)** adds `docs/audit/evidence/loop6/` and this update.
**Do not commit:** `graphify-out/`, `common-context.json` files, `.commandcode/`, `.kilo/`, `.verify-claude/`, `backend/work/`, scratch `gq_*.txt`, `scripts/*toc*`, `generate_dpr_docx.py`, generated report `.docx`/`.pdf`.
