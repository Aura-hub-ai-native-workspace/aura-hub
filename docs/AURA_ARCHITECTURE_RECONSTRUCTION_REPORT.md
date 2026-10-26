# AURA Hub — Architecture Reconstruction Report (Analysis Only)

**Branch:** `feat/laya-shadow-planner` · **HEAD:** `389bead` · **Date:** 2026-10-20
**Scope:** read-only inspection. No source files were modified by this report.

---

## 1. Executive summary

AURA Hub is a monorepo (npm workspaces) with a Tauri desktop app, a Python
backend (the "Central Agent", port 4320), a Node AI service (port 4319), and
shared TS packages. The current tree carries **large uncommitted work** (113
modified, 50 deleted, 182 untracked files) on top of HEAD, much of it from prior
sessions. **3204 backend tests collect**; a recent full run reported 2978
passed / 67 skipped / 0 failed.

Key findings:

- **Sequential one-worker-at-a-time execution is already implemented and tested**
  in `backend/aura/central_agent/execution.py` (`MUTATING_CAPABILITIES`,
  `_all_parallel_runnable`, `_ready_wave` with a single `mutating_taken` flag,
  and `ProjectWorkerLeases`). It is not a missing feature.
- **Laya is not a separate process or agent.** It is the Central Agent's
  reasoning model slot (`default_model_port()` → `RoutedModelPort`), selected
  from `agent/providers.json` (operator) merged with the Node service's
  `providers.settings.json` view. "Laya" is also a name used in the shadow
  planner prompt and `laya_view.py` (a read-only candidate view that cannot
  dispatch). The actual text generator is the provider call
  (`RoutedModelPort.complete_stream`).
- **Needle 2 is not integrated anywhere.** No reference exists in source. Intent
  classification is a deterministic heuristic (`heuristic_interpret`) plus an
  optional model-backed `IntentCompiler` (JSON completion). "Confidence" is a
  heuristic score, not calibrated.
- **REA is not integrated into AURA.** It exists only as an MCP server entry in
  `~/.config/opencode/opencode.jsonc` (`rea-agents@6.7.0`, enabled). AURA's
  `McpGateway` is a foundation with **no live transport**; `available=False`
  for every mapped tool. REA cannot be reached by AURA today.
- **Provider synchronization** is a known, partially-fixed gap: the Node service
  writes a secret-free `agent/providers.settings.json` view; Python merges it.
  A chat turn reports "no reasoning model" if the operator file is absent, even
  when Settings has a model — a real UX gap, not a security one.
- **Web research** is a real, governed capability (`web.research`) that refuses
  when no gateway is configured. No endpoint is set in the isolated test home.
- **The MCP context half** (`mcp_context.py`) is a TTL cache with injectable
  clock; no timers or background tasks. Live transports are not implemented.

---

## 2. Repository state

- Root: `/mnt/storage/aura-hub`
- Branch: `feat/laya-shadow-planner`, HEAD `389bead`
  (`fix(planner): one clause splitter for every fan-out…`)
- Working tree: 113 modified, 50 deleted, 182 untracked (345 paths). 8 stashes
  (all pre-existing). Nothing staged.
- Monorepo: npm workspaces `apps/*`, `packages/*`.
  - `apps/desktop` — Tauri v2 desktop (React + Vite + Zustand).
  - `packages/{ai-service, workflow, capability-fabric, core, ui, runtime, …}`.
  - `backend/` — Python Central Agent + Fabric + policy + workers + workflows.
- Tests: `backend/tests` (pytest, 192 files), `apps/desktop/src` (Vitest),
  `packages/ai-service/src` (Vitest). 3204 backend tests collect.
- Docs: extensive (`docs/ARCHITECTURE.md`, `AURA_CENTRAL_AGENT_*`, etc.).
- Persistence: JSON files under `AURA_HOME` (`~/.aura` or override). Atomic
  writes via `write_json_atomic`. Session files: `agent/sessions/agt-*.json`.
- Config: `AURA_HOME`, `AURA_SEARCH_ENDPOINT`, `AURA_PROJECTS_DIR`,
  `AURA_MODEL_POLICY_ROUTING`, provider files.

---

## 3. Startup sequence (actual)

1. Tauri host (`apps/desktop/src-tauri`) launches the webview.
2. Vite serves the React app; `ScreenRouter` renders the active screen.
3. Backend Python service started via `scripts/serve_central_agent_api.py`
   (port 4320): creates `CentralAgent`, `FabricConfig`, `WorkflowEngine`,
   `CapabilityRegistry`, `ExecutionController`, `VerificationEngine`.
4. Node AI service (port 4319): `packages/ai-service/src/start.ts` →
   `server.ts` (HTTP + SSE), `WorkspaceManager`, mission store, pipeline.
5. Services are discovered by the frontend through health probes; the app shows
   "Connected" only after a real probe.
6. Model port resolved at `CentralAgent.__init__` from provider files
   (`default_model_port`); if absent, heuristic intent compiler is used and
   `intents.mode = "heuristic"`. Re-resolved on provider file change via
   `follows_provider_files = True`.

---

## 4. Central Agent / "Laya" reconstruction

**Entry:** `CentralAgent.submit()` (service.py:323).

Pipeline observed in source:
1. Intent compilation (`intents.compile`): heuristic or model-backed JSON.
   - Heuristic: `heuristic_interpret` (keyword rules).
   - Model: `IntentCompiler.compile` → `model_port.complete_json` → validates
     against `AgentIntent` schema; falls back to heuristic on parse failure.
2. Context assembly (`context.assemble`): capabilities, documents, workflows,
   approvals, session messages, project scan. MCP context appended if provider
   present (untrusted, fenced).
3. Planning: deterministic `TaskPlanner` (no model) for simple tasks; or
   `_plan_from_model` (model-backed, validates structured JSON against
   `TaskPlan`). Shadow planner is opt-in.
4. Discovery: `CapabilityDiscovery.available_for` (read-only, checks what
   exists).
5. Authority preflight: `AuthorityChecker.check_plan` (counts expected
   approvals; does not block).
6. Execution: `ExecutionController.execute()`:
   - `_all_parallel_runnable`: True only if every task is parallel-eligible,
     no dependency edges, no upstream handoff, no conditional gate, not a
     workflow-run route, and **at most one mutating task**.
   - `_ready_wave`: parallel-eligible tasks with all `dependsOn` settled;
     file-ownership overlap serializes; **one mutating task per wave**.
   - `_dispatch_parallel`: `ThreadPoolExecutor`, one `_invoke_single` per task.
   - Sequential path: `topo_order`, per-task stop rules.
   - `_invoke_single`: capability dispatch, role matching, worker lease, Fabric
     invoke, verification, evidence recording.
   - Recovery loop: bounded (`MAX_TASK_ATTEMPTS=2`, `MAX_RECOVERY_ROUNDS=2`);
     retries agent.delegate tasks that failed/timed-out/unverified, optionally
     on another worker (quota failover).
7. Result synthesis: `_synthesize` produces `AgentResult` with outcomes,
   verified, evidence, summary.
8. Session finish + answer recording.

**State persistence:** `AgentSessionStore` (JSON, atomic). Stores identity,
state, messages, plan/result refs, event count. Never secrets/prompts/completions.

**Cancellation:** `RunControl` with `asyncio.Event`; `_signal_tree` (TERM then KILL)
on cancel/timeout. Cancelled tasks are never retried.

**Key contracts:** `AgentIntent`, `TaskPlan`, `TaskSpecification`, `TaskOutcome`,
`AgentResult`, `EvidenceBundle` (Pydantic, in `contracts/agent.py`).

---

## 5. Sequential agent execution lifecycle (already implemented)

- `MUTATING_CAPABILITIES` includes `agent.delegate`, `filesystem.write`,
  `git.commit`, etc. — only one per wave.
- `_ready_wave` enforces `mutating_taken` flag.
- `ProjectWorkerLeases` serializes workers across separate sessions on the same
  project (acquire/release, wait with `on_wait` callback, 1-hour timeout).
- `select_workers` (plan_handoff) chains `dependsOn` so tasks run one after
  another; worker selection by task kind (frontend→kilo, backend→opencode).
- `workerChoice`: "selected" (Laya picked) vs "named" (user pinned). A selected
  agent is not a pin — recovery can reassign it.
- Failover: `_recovery_plan` excludes the failed worker on quota exhaustion.
- Worker billing: `workers/billing.py` — deny by default; unknown billing =
  potentially paid. Owner policy file `worker-policy.json`.
- `authoring_allowed()` defaults False: AURA's own model never writes files
  unless the owner opts in.

**Verified by tests:** `test_one_mutating_task_at_a_time.py` (6),
`test_parallel_dispatch_overlap.py` (12), `test_coordinator.py` (12),
`test_quota_failover.py` (19), `test_agent_architecture.py` (13),
`test_worker_billing_policy.py` (23) — all passing.

---

## 6. Project context & memory

- **Shared context** (`shared_context.py`): typed records (goal, requirement,
  decision, rejected, constraint) with keys, bodies, timestamps. Stored
  per-scope (project or session-derived). `package_for()` builds a sized context
  package for the model.
- **Context capture** (`context_capture.py`): deterministic extraction of
  statements from the user's message using regex (no model call). Records only
  the person's own words, shortened. `MAX_PER_TURN=5`, priority ordering.
- **Session messages**: stored in `AgentSession.messages` (role, content, at).
  Last 6 messages included in context bundle.
- **Verified outputs**: `result.verified_outputs` keyed by task id, carries
  node_id, agent, stdout, scope_paths, changed_paths, invocation_ids.
- **Deviation evidence**: filed when an outcome carries `scopeDeviation`.
- **Error knowledge** (`error_knowledge.py`): sanitized error records with
  retrieval, used to enrich worker briefs.
- **Run board** (`run_board.py`): shared picture (goal, acceptance, tasks, file
  ownership, verified findings, failures) rendered for each worker's brief.
- **Persistence:** session JSON, mission records, workflow versions/runs,
  audit trail, approvals ledger, fabric audit. All atomic writes.
- **Restart recovery:** `_retry_after_cancellation` restores from stored plan;
  verified evidence seeded into resumed leg. Parked (awaiting-approval) runs
  keep their token.

---

## 7. Web research

- Capability `web.research` (governed, requires `webResearch=True` consent
  stamped by planner from request-scoped preference).
- Executor `web_research.py`: SearXNG-compatible gateway. Config via
  `~/.aura/web.json` (`searchEndpoint`) or `AURA_SEARCH_ENDPOINT` env.
- Refuses when no gateway configured (`_NOT_CONFIGURED`). Never invents results.
- Results fenced as `[source=...]` untrusted data. `MAX_RESULTS_CAP=10`,
  `PER_RESULT_CHARS=1200`, `MAX_STDOUT_CHARS=8000`.
- Blocked hosts: cloud instance metadata IPs.
- Consent key: `input["webResearch"]` must be exactly `True`.
- No search gateway configured in the isolated test home (by design — the user
  must supply one). A college SearXNG instance exists at
  `http://100.84.125.4:8889/search` (verified reachable with 20 results).
- `research.py` (central agent): runs research, assembles evidence block,
  extracts citations, flags dangling references.

---

## 8. REA integration

- **REA is NOT integrated into AURA.** It exists only as an MCP server entry in
  `~/.config/opencode/opencode.jsonc` (`rea-agents@6.7.0`, enabled, local).
- AURA's `McpGateway` is a foundation with **no live transport**:
  `available=False` for every mapped tool. `sanitize_external_tool` drops
  unknown fields, clamps descriptions, forbids native-namespace collisions.
  Trust levels gate availability. Risk floors: unknown/untrusted → high risk.
- `McpContextCache` (TTL, injectable clock) exists for resource reads, but no
  live transport is implemented.
- REA can be accessed by OpenCode (which has the MCP config), not by AURA
  directly.
- **Recommendation:** REA is a reverse-engineering tool, not a replacement for
  source inspection or web research. Use it for investigating packaged
  applications/binaries when ordinary source inspection is insufficient.
  Prefer open-source references; verify licenses.

---

## 9. Intent classification & planning

- **No Needle 2 integration.** No reference in source.
- `IntentCompiler`: heuristic (keyword rules, `heuristic_interpret`) or model
  (JSON completion via `model_port.complete_json`, validated against
  `AgentIntent`). Falls back to heuristic on parse failure.
- `AgentIntent`: goal, expectedOutcome, complexity (single/multi-step/workflow),
  requiredCapabilities, webResearch, delegateTask, etc.
- Classification is a heuristic score, not calibrated confidence.
- `TaskPlanner`: deterministic for simple tasks (single-file, read-only
  inspection); model-backed (`plan_from_model`) for complex. Validates structured
  JSON against `TaskPlan` schema. Rejects unknown capabilities, malformed IDs,
  duplicate IDs, etc.
- Agent capability matching: `worker_match.py` — role → node-capability mapping.
  First eligible node in catalogue order. `match_worker`, `node_satisfies_role`.
- Model routing: `ModelRouter` (sovereign) — queries registry, filters by
  policy, cost state. Legacy path returns first healthy candidate. Only selects
  local/private models (sovereign guarantee).
- Planning retries: shadow planner (opt-in), correction loop (bounded).
- User clarification: `needs-clarification` outcome with `pendingQuestion`.

**Recommendation:** Keep one primary planning model (Llama-family or similar).
Use a lightweight classifier only if evidence shows it helps. Model execution
may be local or remote through an authorized GPU server. The planner must not
bypass authorization.

---

## 10. Security, authority, recovery

- **Policy engine** (`policy/engine.py`): `evaluate_policy` — deny if no
  provider; deny if non-human-only scope not granted; auto-execute
  agent.delegate when allowAutonomous; risk floors; configurable overrides.
  Human-only scopes: `account.authorize`, `resource.destroy`, `system.modify`.
  Irreversible actions always require approval.
- **Fabric** (`fabric/__init__.py`): single governed path. Approval ledger
  (single-use, fingerprint-bound). Audit trail (append-only). Bounded recovery
  (max 3 attempts, max 30s). Policy evaluation is the only decision point.
- **Tool permissions**: capability manifest declares permissions. Worker
  governance: OpenCode/Kilo plugin (scope check, sensitive paths, destructive
  commands), Claude hook (Edit/Write/Bash, --add-dir confinement).
- **Command execution**: `exec_/` — argv array, bounded, stdin closed, process
  group signaling on cancel. Windows .cmd/.bat routed through cmd.exe.
- **Secrets**: never read for convenience, printed, logged, committed. Redaction
  in variable/output results (`<redacted:rule-id>`).
- **Cancellation**: `RunControl` with `asyncio.Event`; `_signal_tree` (TERM then
  KILL). Cancelled tasks never retried.
- **Timeouts**: per-invocation `timeoutMs`; bounded drain (5s) after timeout.
- **Audit**: append-only `AuditStore`; every invocation settles an audit record.
- **Prompt injection**: external content treated as untrusted data (fenced,
  provenance-marked). Capability catalogue removed from chat prompt. Claims
  audit (`claims.py`) flags unsupported claims.

---

## 11. Testing & reproduction

**Existing tests:** 192 backend test files, 3204 tests collect. Recent run:
2978 passed / 67 skipped / 0 failed.

**Scenario coverage (from test files):**
- TEST 1 (simple question): `test_conversational_turn.py` — direct answer, no
  workers.
- TEST 2 (single coding task): `test_workspace_direct_execution.py` — one
  task, one worker, verified file.
- TEST 3 (sequential two-agent): `test_one_mutating_task_at_a_time.py`,
  `test_agent_architecture.py::test_tasks_run_one_at_a_time_in_plan_order`.
- TEST 4 (first agent failure): `test_coordinator.py` — failure captured,
  controlled recovery.
- TEST 5 (second agent must not start early): `test_parallel_dispatch_overlap.py`
  — overlap measured from real thread timing.
- TEST 6 (duplicate completion): `test_coordinator.py` — one outcome per task.
- TEST 7 (restart during execution): `test_restart_recovery.py`,
  `test_final_reverification.py`.

**Live testing limitations:** Windows/macOS untested (no push authorized).
Local model (1.5B) too slow/weak for complex planning. Web research needs
a gateway endpoint.

---

## 12. Key gaps and risks

1. **No live transport for MCP.** `McpGateway` is a foundation; `available=False`
   for all tools. REA cannot be reached by AURA.
2. **Provider synchronization gap.** Node writes `providers.settings.json`;
   Python reads it. A chat turn reports "no model" if the operator file is
   absent, even when Settings has one. Partially fixed (merge + re-resolve).
3. **Model quality.** qwen2.5-coder:1.5b is too weak for complex planning.
   qwen3:4b is too slow on this CPU. College server (qwen3.8:27b) is available
   and verified as optional provider.
4. **No search gateway configured** in isolated home (by design — user must
   supply one). A college SearXNG instance exists and is reachable.
5. **Windows/macOS untested** (no push authorized for CI).
6. **New-mission planning times out** on default 30s settings with the 1.5B
   model on this CPU.
7. **No error boundary** in the desktop app — a malformed mission record
   blanks the window.

---

## 13. Recommendations

1. **Keep Needle out.** The deterministic heuristic + one primary model is
   sufficient. Don't add a classifier without evidence it helps.
2. **Keep REA out of AURA's core.** It's an OpenCode MCP tool, not an AURA
   capability. Use it for reverse-engineering investigations, not planning.
3. **One primary planning model.** qwen3.8:27b (college) as primary when
   authorized; 1.5B as offline fallback. Don't introduce competing planners.
4. **Fix provider sync fully.** Make the Python backend always read the Node
   settings view as a fallback, not just merge.
5. **Add a search endpoint.** The college SearXNG instance works. Configure it
   in the isolated home for testing.
6. **Add error boundary** to the desktop app.
7. **Raise planning timeout** for local models or use streaming with idle
   timeout (already partially done).

---

## 14. Evidence limitations

- All test counts are from the most recent runs in this session.
- Live UI testing was performed on the isolated home only.
- Windows/macOS were not tested (no push authorized).
- Worker quota failover was tested with simulated errors only.
- Web research was tested with a local fixture gateway and the college SearXNG
  instance, but not with a user-configured endpoint in production.
- REA integration was verified as an OpenCode MCP config entry only; no live
  REA call was made from AURA.