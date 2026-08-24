# AURA Central Agent — Implementation

> **Status:** IMPLEMENTED (milestone 1) · RUNTIME VERIFIED
>
> This document records what was actually built on
> `feature/aura-central-agent`, how it maps to the research and architecture
> documents, what is verified, and what remains.
>
> Companions: [Research](./AURA_CENTRAL_AGENT_RESEARCH.md) ·
> [Architecture](./AURA_CENTRAL_AGENT_ARCHITECTURE.md) ·
> [Roadmap](./AURA_CENTRAL_AGENT_ROADMAP.md) ·
> [Security Model](./AURA_AGENT_SECURITY_MODEL.md) ·
> [Component Map](./AURA_AGENT_COMPONENT_MAP.md)

---

## 1. Language boundary (binding)

The project language boundary is now absolute:

- **Frontend:** TypeScript / React.
- **Backend:** Python (`backend/aura/…`) — the canonical backend.
- **TypeScript backend** (`packages/ai-service`, `packages/capability-fabric`):
  transitional reference for migration and differential testing. It receives
  NO new backend functionality.

The Central Agent is Python-native. Nothing in it imports, spawns, or calls
the TypeScript runtime. The forbidden chain `Python agent → Node → TS` does
not exist anywhere in this implementation.

## 2. Where the code lives

```
backend/aura/
├── contracts/agent.py          Agent-layer contracts (new canonical schemas)
├── fabric/                     Governance spine (migration P2/P4 subset)
│   ├── manifest.py             Capability descriptors ported deliberately
│   ├── invoke.py               THE one invocation path (validate → policy →
│   │                           approval → execute → verify → audit)
│   └── executors.py            workflow.create / workflow.list executors
└── central_agent/
    ├── intent.py               IntentCompiler + ModelPort + heuristic mode
    ├── planner.py              TaskPlanner (bounded templates + DAG checks)
    ├── discovery.py            Capability discovery (manifest + MCP tools)
    ├── authority.py            AuthorityChecker (read-only policy preflight)
    ├── workflow_compiler.py    Plan → candidate graph + structural validation
    ├── execution.py            ExecutionController (drives aura.fabric only)
    ├── verification.py         VerificationEngine (performed ≠ verified)
    ├── evidence.py             EvidenceCollector (reads the audit trail)
    ├── session.py              AgentSessionStore (~/.aura/agent/sessions)
    ├── events.py               EventBus (AgentEvent tail; future SSE feed)
    ├── mcp_gateway.py          MCP trust boundary (sanitize/map/floor)
    ├── service.py              CentralAgent facade (the whole loop)
    └── __main__.py             CLI: python3 -m aura.central_agent

backend/tests/unit/             Contracts, invoke pipeline, intent, planner/
                                compiler/MCP, vertical-slice integration
backend/scripts/verify_central_agent.py   Runtime verification gate
```

The layout edit to `docs/migration/python-backend-architecture.md` (adding
`central_agent/`) was made in the same commit as the code, per that file's
own rule.

## 3. The loop, as implemented

```
USER INTENT (natural language)
  ↓ IntentCompiler          natural language → AgentIntent (model or heuristic;
  │                         malformed model output fails CLOSED)
  ↓ TaskPlanner             AgentIntent → TaskPlan (≤8 tasks, DAG-checked,
  │                         capability-bound, never executes)
  ↓ CapabilityDiscovery     live manifest + sanitized external tools → ToolDescriptor[]
  ↓ AuthorityChecker        read-only describe_authority() per capability —
  │                         decisions come from aura.policy, mirrored verbatim
  ↓ WorkflowCompiler        plan → candidate graph over the FROZEN node
  │                         vocabulary; unknown type = compile error;
  │                         structural validation (connectivity, acyclicity)
  ↓ ExecutionController     every task becomes ONE aura.fabric invoke with
  │                         actor=agent; approval parks the run, never decides
  ↓ VerificationEngine      performed vs verified, per VerificationRequirement
  ↓ EvidenceCollector       links immutable AuditRecords into an EvidenceBundle
  ↓ AgentResult             status + evidence + honest failure reasons
```

## 4. What already existed vs what was built

Reused unchanged (no second authority created):

| Concern | Module | Role |
| --- | --- | --- |
| Policy decisions | `aura.policy` (migrated `c418714`) | The ONLY decision point. The agent reads results; it never evaluates policy itself. |
| Approval lifecycle | `aura.approvals` (migrated `11a2323`) | Pending-only persistence, single-use spend, fingerprint binding. |
| Audit trail | `aura.audit` | Append-only JSONL; every settled invocation recorded. |
| Canonicalization | `aura.canonical` | `fingerprint_invocation` binds approvals to exact arguments; `graph_hash` verifies stored graphs. |
| Serialization | `aura.jsonutil` | Node-byte-compatible JSON stores. |
| Frozen contracts | `aura.contracts.workflow_def` etc. | Compiled graphs validate against the frozen WfNodeType vocabulary at construction. |

Built new:

| Component | Notes |
| --- | --- |
| `fabric/invoke.py` | Port of `capability-fabric/src/fabric.ts invoke()` stage order: unknown → contract → policy → approval(park/spend) → execute → verify → settle+audit. Every early return still settles an audit record. |
| `fabric/manifest.py` | Minimal deliberate subset (`workflow.create`, `workflow.list`). TS manifest stays the reference catalogue; ids are ported with their executors, never half-exist. |
| `contracts/agent.py` | AgentSession, AgentIntent, TaskSpecification(+inputFrom), TaskPlan, CapabilityRequirement, ToolDescriptor, AuthorityRequirement, ExecutionPlan, VerificationRequirement, AgentVerificationReport, EvidenceBundle, AgentResult, AgentEvent. extra="allow"; camelCase wire naming. |
| All of `central_agent/` | See §2. |

## 5. Security posture (implemented controls)

Mapped to `docs/AURA_AGENT_SECURITY_MODEL.md` threats:

| Threat | Control in this milestone | Verified by |
| --- | --- | --- |
| Prompt injection via model output | Model output validated against schema; invalid → IntentCompilationError (fail closed); injected capability names stripped unless well-formed ids; all tool content fenced as data by construction (heuristic path has no prompt surface) | `test_invalid_schema_fails_closed`, `test_injected_capability_names_stripped` |
| Arbitrary capability invocation | Planner binds only manifest-backed capability ids; discovery reports missing capabilities BEFORE execution; unknown id at invoke time → `unknown-capability` settlement | `test_unmappable_intent_never_touches_the_fabric`, `test_unknown_capability_fails_with_audit` |
| Privilege escalation / self-authorization | The agent carries NO decideApproval anywhere; ask-user/require-approval park the run with a persisted request; grants are single-use and argument-fingerprint-bound; replay/tamper refused | `test_approval_park_surfaces_request_and_waits`, `test_named_grant_spends_once_then_replay_refused`, `test_tampered_arguments_fail_fingerprint_binding` |
| Confused deputy | Risk floors come from manifest descriptors through aura.policy floors; deny stops the whole plan before any execution | `test_policy_deny_blocks_plan_before_execution` |
| Malicious generated graph | Node types validated against frozen Literal vocabulary at construction; dangling edges, disconnected nodes, cycles rejected pre-persistence | `TestWorkflowCompilerValidation.*` |
| Tool poisoning (MCP) | External descriptors sanitized: allow-listed fields only, clamped printable descriptions, native-namespace collision refused, permissions NEVER inferred, untrusted servers ⇒ high risk ⇒ require-approval floor, availability gated until a transport exists | `TestMcpTrustBoundary.*` |
| Secret leakage | inputSummary redacted+bounded at settlement (apiKey/token/secret/password); persisted session/workflow/audit state scanned clean by the runtime gate | `test_input_summary_redacts_secretish_fields`, `no_secrets_in_persisted_state` |
| Unbounded autonomy | MAX_TASKS=8, no automatic retries of side-effectful failures, ambiguous intents blocked with zero invocations | `test_bounds_enforced`, `clarification_blocks_without_effects` |

## 6. Verification status

Words used precisely (Master Handoff convention):

**RUNTIME VERIFIED**
- `python3 backend/scripts/verify_central_agent.py` — 8/8 checks against the
  real governance spine in a disposable AURA_HOME:
  status slice end-to-end; authoring slice (compiled graph stored +
  read-back hash verified); evidence references real append-only records;
  ambiguous-intent block with zero effects; approval park → human decide →
  single-use spend with replay refusal; policy deny pre-execution;
  session reload; no credential material in persisted state.

**VERIFIED (pytest, `cd backend && python3 -m pytest tests/unit -q`)**
- Contract shape/round-trip/vocabulary freeze (10 tests)
- Invoke pipeline order, floors, parking, single-use spend, fingerprint
  binding, executor faults, redaction (17 tests)
- Intent compiler rules + fail-closed model mode (12 tests)
- Planner bounds/DAG, compiler structure, MCP trust boundary (19 tests)
- Vertical-slice integration over real stores (11 tests)
- Pre-existing suites remain green (49 baseline tests).

**PARTIALLY VERIFIED**
- `describe_authority` parity vs TS `fabric.evaluate()` is structurally
  faithful but has NO differential battery yet (P4's planned differential
  harness covers it when it lands).
- MCP gateway is a boundary without a transport: sanitization/mapping/risk
  flooring tested; no live server connection exists to verify.

**NOT IMPLEMENTED (deliberate, next milestones)**
- Process-backed executors (exec/settle port), node routing, connected
  environment — required for capabilities beyond the internal store.
- Python workflow ENGINE (running compiled graphs). Compiled artifacts are
  inert, valid data awaiting P6; nothing executes them today.
- API/SSE route layer (P10): the frontend contract is the Pydantic models +
  AgentEvent vocabulary; React wiring comes after the route layer.
- Live MCP transports; plugin adapters beyond the mapping boundary.
- Context Fabric integration (P9): intents carry contextRefs; composition
  awaits the canonical module.
- Mission-system integration (explicitly out of scope per Component Map §4).

## 7. Frontend contract (for the next milestone)

No UI was built (per mission §23: contracts first). The eventual React
surface consumes:

1. `CentralAgent.submit(message, projectId)` — wrapped by the P10 HTTP route.
2. `AgentEvent` stream — same payloads as `bus.tail`; SSE framing at P10.
3. `AgentResult` + `EvidenceBundle` — result surfaces render evidence ids,
   which resolve against existing audit/run views.
4. `ApprovalRequest` — parked runs surface existing approval-inbox UX; the
   decide action belongs to the human-only path that already exists.

TS types mirroring these contracts should be generated from the Pydantic
models (or hand-synced) when the API routes land — the models are the source
of truth.

## 8. Known limitations

- Heuristic interpretation is transparent keyword matching, not AI. The
  ModelPort seam accepts any provider; none is wired by default. Claimed
  honestly: intent compilation quality is UNTESTED against a live model.
- `workflow.list/create` cover the internal store only; "check my project
  and fix test failures" correctly BLOCKS with a clarification question
  rather than pretending (verified behavior).
- Compiled workflows persist but cannot run (no engine). They are inert,
  schema-valid artifacts.
- Approval dedup keys follow TS semantics: standalone invocations key per-
  attempt; durable question identity requires mission/task or run/node
  correlation ids (both supported).
- The parallel TypeScript→Python migration is ACTIVE: commits `c418714`
  (policy engine) and `11a2323` (approvals+audit) landed from another
  builder during this milestone and were integrated, not duplicated.

## 9. Next milestone (smallest coherent step)

1. Executors for process-backed capabilities behind the P2 `settle()` port
   (unblocks terminal.execute-class work end-to-end in Python).
2. Differential battery: `fabric.invoke` outcomes vs TS fabric on a seeded
   matrix (policy × input × approval state).
3. Workflow engine port (P6) beginning with pure/read-only node classes, so
   compiled graphs can execute under governance.
4. API/SSE routes exposing submit/events/result; then the React surface.
