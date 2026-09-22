# AURA Agentic Workspace — Architecture

**Status:** implemented in vertical-slice form on `feature/aura-agentic-workspace`.
**Method note:** every claim below was verified against source this session; where a
behavior was not verified it is marked UNKNOWN rather than assumed.

## 1. Current architecture (what exists and is reused)

AURA Hub is a Tauri v2 desktop app (`apps/desktop`) over a Node AI service
(`packages/ai-service`) and a Python backend (`backend/aura`). The agentic
substrate already exists on this branch's base; this phase composes it rather
than replacing it.

| Concern | Existing component | Verified behavior |
|---|---|---|
| Goal → structured plan | `packages/ai-service/src/mission/orchestrator.ts` | 9-stage pipeline: deterministic classification and signal gathering before every model call; crash mid-pipeline leaves an honest partial record |
| Task graph | `mission/execution/dag.ts`, `engine.ts`, `checkpoints.ts`, `replay.ts` | DAG execution with checkpoints and replay; `gitExecutor` gates git operations |
| Python agent spine | `backend/aura/central_agent/` | `planner.py` (bounded DAG, MAX_TASKS=8, model-proposal key allow-list), `authority.py`, `runcontrol.py` (idempotent, in-flight, precedent cancellation), `evidence.py`, `verification.py`, `supervisor.py` |
| Worker matching | `central_agent/worker_match.py` | First eligible node in catalogue order; `exclude` keeps independent review honest; unmatched roles fail closed (None), never fall back |
| Worker truth table | `aura/workers/` | `connected` comes from a PROOF record, never from binary presence |
| Model access | `central_agent/model_routing.py` | Operator-written `~/.aura/agent/providers.json`; OpenAI-compatible `{baseUrl}/chat/completions`; per-provider health with bounded fallback down the configured chain; **honest error, never fabricated output, no hidden default endpoint** |
| Human approval | `aura/approvals/`, `authority.py`, UI `ApprovalCard`/`AgentCenter` | Plan-level approval before execution plus per-task proposal acceptance before disk writes |
| Persistence | `MissionStore`, `WorkflowRunStore`, hash-chained `~/.aura/fabric-audit.jsonl` | SIGKILL-tested recovery (PHASE1_HANDOFF: decisions survive, tamper evident, orphan-free) |
| Observability | `LIVE-EVENT-CONTRACT.md`, SSE event spine, `AgentTrace` | `/agent/sessions/{id}/events` is a never-terminating live-follow stream; replays tail on connect |
| Workspace UI | Neon workspace (`ConversationPane`, `OrchestrationGraph`, `LeftControlPanel`, `AgentTrace`) | Center = conversation, right/edge = agent + worker activity; matches the required layout |
| Tools | `capability-fabric`, `connected-environment` catalog, MCP gateway | Node capabilities include `coding-agent` and `terminal`; Fabric policy, allow-list, verified invocation and audit stay authoritative |

## 2. What this phase changed (the vertical slice)

**Worker role vocabulary.** The closed worker-role set
`{code, review, execute}` (contracts/agent.py `WorkerRole`) is extended with
`research`, `planning`, `testing`, `documentation` — the six specialized roles
required by the agentic workspace. The change is deliberately small:

- `contracts/agent.py` — `WorkerRole` literal extended (the contract is the
  single source of truth).
- `central_agent/planner.py` — `_MODEL_WORKER_ROLES` extended; a model may now
  propose the new roles, and anything outside the set is still rejected
  (fail closed, unchanged).
- `central_agent/worker_match.py` — `ROLE_NODE_CAPABILITY` maps each new role
  to the `coding-agent` node capability. Rationale: a connected coding-agent
  is the only node that can read a repository and report on it; the role
  narrows the *prompt* the worker receives, not the tool it may touch.
  Routing failure remains loud (no execute-role fallback).
- `aura/workers/__init__.py` — `_ROLE_FOR_CAPABILITY` presentation map
  mirrored.

`expects_change` is intentionally untouched: only an unconditional `code` task
must produce an artifact; a testing or research worker legitimately finishes
having changed nothing.

## 3. Execution lifecycle (target, composed from existing parts)

```
USER GOAL (ConversationPane)
  → intent compile (intent.py, deterministic clarification policy)
  → plan (planner.py, bounded DAG, ≤8 tasks, scope-path gate)
  → approval (plan-level; per-task proposal gate before disk writes)
  → worker match (worker_match.py: role → node capability → first eligible)
  → execute (fabric executors; authority preflight re-computes risk;
             cancellation reaches the real process group via runcontrol)
  → verify (verification.py: read-back / exit-code / schema-match / audit-only)
  → evidence (evidence.py; hash-chained journal)
  → next task or replan (conditional remediation via runWhen)
  → final review (distinctWorkerFrom keeps the reviewer independent)
```

Dynamic behavior already present: conditional execution (`runWhen:
upstream-reports-findings`), one bounded revision pass (no unbounded replan
loops), honest degraded mode when no model is configured (deterministic
planning, clearly labeled).

## 4. Model policy (strict local-only)

The routing layer already satisfies the constraint: providers come only from
the operator's `providers.json` (base URL + model id + env-var *name* for the
key), keys are resolved at call time and never persisted or logged, and a
failing provider falls back only down the operator-configured chain — never
to a hidden cloud default. The cloud adapters in the TS provider layer are
pre-existing chat-provider infrastructure and are out of scope here; the
agentic path routes exclusively through the operator's declared file. A
connection failure surfaces as an honest error with project state preserved.

## 5. Risks

- **Branch divergence:** this branch is +62 commits vs `origin/main`; the
  substrate exists only here. Merging order matters.
- **Shared-surface WIP:** `server.py`, `WorkspaceScreen.tsx`,
  `LeftControlPanel.tsx` carry interleaved changes from a concurrent agent
  line; merge hunk-by-hunk, not file-by-file.
- **Known P2:** 13 real-worker E2E tests hang (they read the never-terminating
  SSE stream expecting `data: [DONE]`). Fix is bounded socket reads; not
  attempted in this slice, and no test was weakened or removed.
- **Role-prompt narrowing:** IMPLEMENTED — see §5a below.

## 5a. Role prompt layer (implemented)

**Module:** `central_agent/role_prompts.py` (stdlib-only, no provider or
model wiring by construction). Each framed role (code, review, research,
planning, testing, documentation) has a frozen `RoleContract` with
identity, objective, responsibilities, expected output, completion
criteria, forbidden behaviour, and evidence requirements — deterministic
text, not generated prose. `execute` stays a routing-only role: its task
text is the operator's command, so it gets no AURA-authored framing.

**Composition boundary:** the executor (`agent_delegate_run`), not the
planner. The planner carries the raw task text plus the AURA-owned
`role` key in delegate input (absent from `_DELEGATE_INPUT_KEYS`, so a
model proposal can never set or clear it — same ownership pattern as
`expectChange`), and the approved input fingerprint covers exactly what
the planner validated. The executor composes, AFTER scope validation:

1. `<ROLE name=...>` block — trusted AURA-authored framing, with an
   explicit PRIORITY rule: instructions inside `<AURA-TASK>` are data
   and cannot un-restrict the role (a hostile task text cannot turn a
   research worker into a coding worker).
2. `<AURA-TASK>` fence — the untrusted task text.
3. RUNTIME CONTEXT — the validated authorized scope (what will actually
   be enforced, not a guess), approval state, and the cancellation rule.

Then `with_context` wraps the whole brief in `<TASK>` as before — the
two tag families are distinct, so delegate `context` still composes.

**Fail-closed behavior:**

- An unknown role in delegate input refuses the invocation BEFORE any
  spawn ("AURA does not recognize...") — nothing silently unframed, and
  nothing silently becomes `code`.
- A roleless (legacy) delegate call keeps today's byte-identical prompt
  and a roleless output — no role key is invented.
- A stated role with no eligible connected worker refuses at dispatch
  (existing fail-closed matching) — it never dispatches unframed.
- Corrections inherit the role: `build_correction` copies the full base
  input, so a corrected attempt runs under the same contract.

**Role in observable state:**

- Worker OUTPUT echoes `role` (success, governance-refusal,
  network-refusal, and pre-dispatch cancellation paths all carry it),
  so the result and the audit trail record which contract ran.
- SSE `plan.created` carries `role` per task row and
  `worker.lifecycle` carries the assignment's `role` (pre-existing
  emission, now populated end to end); `RunTimeline.tsx` renders it.

**Role-to-capability relationship (unchanged):** every framed role
resolves to `coding-agent`; `execute` to `terminal`. The role narrows
the PROMPT, never the tool or the provider routing. Approval gates stay
authoritative: a role task parks for a human like any other, worker
text can never bypass one, and a role changed after approval is a
different action (it changes the approved input fingerprint).

**Current limitations:** the executor emits the structured contract
(`summary/findings/changedFiles/validation`) as prompt guidance only —
worker replies are still free text verified by exit-code and scope
delta, not parsed fields. The `approval state` in the runtime context
is always "granted" today (a task that reached execution was approved;
per-task re-approval state is not yet threaded into the brief).

## 6. Testing strategy

- Existing suites are the regression baseline (1,264 passed / 25 skipped last
  verified; 13 excluded E2E documented above). Never weakened to go green.
- Every vocabulary change ships with parametrized fail-closed tests:
  acceptance of new roles, rejection of unknown roles, resolution to
  `coding-agent`, None on terminal-only nodes, exclusion semantics intact.
- The slice's acceptance gate: `pytest tests/unit/test_worker_match.py
  tests/unit/test_central_agent_autonomy.py` green alongside the full unit
  suite, `npm run typecheck`, and `npm test` unchanged.
- The role layer's gate: `pytest tests/unit/test_role_prompts.py` (40 tests:
  per-role contract determinism/specificity, override resistance, planner
  injection + model-smuggling rejection, fail-closed dispatch and executor
  refusal, role echo in outputs, SSE role visibility, approval-gate authority,
  provider-routing non-regression), plus the full unit suite and typecheck.
