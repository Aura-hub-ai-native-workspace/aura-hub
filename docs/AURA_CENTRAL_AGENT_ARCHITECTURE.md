# AURA Central Agent — Architecture Specification

> **Status:** PROPOSED — awaiting implementation
>
> This document specifies the complete architecture of the AURA Central Agent,
> including component interfaces, data flow, state management, and integration
> points with the existing AURA ecosystem.

---

## 1. Architecture Principles

### 1.1 Invariants (inherited from AURA Hub)

These architectural invariants from the Master Handoff MUST NOT be broken:

1. **One policy engine.** `packages/capability-fabric/src/policy.ts` remains
   the single authority for decisions.
2. **One execution authority.** Every effect goes through
   `fabric.invoke()`.
3. **One process primitive.** `exec/process.ts` remains the single process
   spawner.
4. **One approval system.** `fabric.approvalStore.ts` remains the single
   approval authority.
5. **Three disjoint binary allow-lists.** Never merged.
6. **Node governance is deny-only.** No configuration lowers floors.
7. **The Agent must NOT become a second authority.**

### 1.2 New Invariants (for the Central Agent)

8. **The Agent reasons; it does not execute.** Every side effect goes through
   the Capability Fabric.
9. **The Agent generates; the system validates.** AI-generated workflows are
   validated against the manifest before execution.
10. **The Agent observes; it does not infer.** Results come from the audit
    trail and verification system, not from the Agent's own assessment.
11. **Authority never silently increases.** The Agent cannot grant itself
    capabilities through repeated invocations.

---

## 2. System Architecture

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AURA Desktop Shell                          │
│                    (Tauri v2 — React + Rust)                        │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Frontend (React + TS)                      │  │
│  │                                                               │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │  │
│  │  │ Ask AURA    │  │ Agent        │  │ Workflow           │  │  │
│  │  │ Chatbox     │  │ Workspace    │  │ Builder            │  │  │
│  │  └──────┬──────┘  └──────┬───────┘  └────────┬───────────┘  │  │
│  │         │                │                    │               │  │
│  │         └────────────────┼────────────────────┘               │  │
│  │                          │ HTTP SSE                           │  │
│  └──────────────────────────┼────────────────────────────────────┘  │
│                             │                                       │
│  ┌──────────────────────────┼────────────────────────────────────┐  │
│  │              AURA Service (localhost:4319)                    │  │
│  │                          │                                    │  │
│  │  ┌───────────────────────┼────────────────────────────────┐   │  │
│  │  │            CENTRAL AGENT (new)                         │   │  │
│  │  │                       │                                │   │  │
│  │  │  ┌─────────────┐  ┌──┴───────┐  ┌─────────────────┐   │   │  │
│  │  │  │ Intent      │  │ Task     │  │ Workflow        │   │   │  │
│  │  │  │ Compiler    │  │ Planner  │  │ Compiler        │   │   │  │
│  │  │  └──────┬──────┘  └────┬─────┘  └────────┬────────┘   │   │  │
│  │  │         │              │                  │            │   │  │
│  │  │  ┌──────┴──────────────┴──────────────────┴────────┐   │   │  │
│  │  │  │           Execution Controller                  │   │   │  │
│  │  │  └─────────────────────┬───────────────────────────┘   │   │  │
│  │  │                        │                               │   │  │
│  │  │  ┌─────────┐  ┌───────┴──────┐  ┌─────────────────┐   │   │  │
│  │  │  │ Context  │  │ Verification │  │ Evidence        │   │   │  │
│  │  │  │ Manager  │  │ Engine       │  │ Collector       │   │   │  │
│  │  │  └─────────┘  └──────────────┘  └─────────────────┘   │   │  │
│  │  └────────────────────────────────────────────────────────┘   │  │
│  │                          │                                    │  │
│  │  ┌───────────────────────┼────────────────────────────────┐   │  │
│  │  │            EXISTING AURA SUBSYSTEMS                    │   │  │
│  │  │                       │                                │   │  │
│  │  │  ┌──────────┐  ┌─────┴─────┐  ┌──────────────────┐    │   │  │
│  │  │  │ Mission  │  │ Workflow  │  │ Automation       │    │   │  │
│  │  │  │ Engine   │  │ Engine    │  │ Engine           │    │   │  │
│  │  │  └──────────┘  └───────────┘  └──────────────────┘    │   │  │
│  │  │                       │                                │   │  │
│  │  │  ┌────────────────────┴───────────────────────────┐    │   │  │
│  │  │  │           CAPABILITY FABRIC                     │    │   │  │
│  │  │  │  validate → resolve → policy → approve →        │    │   │  │
│  │  │  │  execute → verify → audit                       │    │   │  │
│  │  │  └────────────────────┬───────────────────────────┘    │   │  │
│  │  │                       │                                │   │  │
│  │  │  ┌──────────┐  ┌─────┴─────┐  ┌──────────────────┐    │   │  │
│  │  │  │ Connected│  │ Providers │  │ Context Fabric   │    │   │  │
│  │  │  │ Env      │  │ (models)  │  │ (read-only)      │    │   │  │
│  │  │  └──────────┘  └───────────┘  └──────────────────┘    │   │  │
│  │  └────────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

```
User Intent
    │
    ▼
Central Agent
    │
    ├──► Context Manager ──► Context Fabric (read-only)
    │
    ├──► Intent Compiler ──► AI Provider (model call)
    │
    ├──► Task Planner ──► AI Provider (model call)
    │         │
    │         ├──► Capability Checker ──► Capability Fabric (evaluate)
    │         │
    │         └──► Workflow Compiler ──► AI Provider (model call)
    │                   │
    │                   └──► Manifest Validation ──► CAPABILITY_MANIFEST
    │
    ├──► Execution Controller
    │         │
    │         ├──► Workflow Engine (for workflows)
    │         │         │
    │         │         └──► Capability Fabric (for each governed node)
    │         │
    │         ├──► Capability Fabric (for single invocations)
    │         │
    │         └──► Bounded Agent (for reasoning tasks)
    │
    ├──► Observation Processor ──► SSE Event Stream
    │
    ├──► Verification Engine ──► Audit Trail + Verification Reports
    │
    └──► Evidence Collector ──► Audit Records + Verification Results
              │
              ▼
         Evidence Bundle → User
```

---

## 3. Component Specifications

### 3.1 Intent Compiler

```python
class IntentCompiler:
    """
    Transforms natural language into structured intent.
    
    This is the entry point for all user interaction with the
    Central Agent. It is stateless per request.
    """
    
    async def compile(
        self,
        user_message: str,
        context: ContextView,
        conversation_history: list[Message],
    ) -> IntentSpec:
        """
        Steps:
        1. Prepend context constraints to the prompt
        2. Call the model to classify and structure the intent
        3. Validate the output against IntentSpec schema
        4. Return structured intent
        
        The model is given:
        - The user's message
        - Context view (project, repository, capabilities)
        - Conversation history (last N turns)
        - Constraint list from context
        
        The model produces:
        - Goal: what the user wants
        - Surface: which context slice matters
        - Expected outcome: how we know it worked
        - Constraints: boundaries
        - Urgency: immediate / background / scheduled
        - Complexity: single / multi-step / workflow
        - Estimated capabilities: what might be needed
        """
        ...
```

**Prompt structure:**
```
You are AURA's intent compiler. Analyze the user's request and produce
a structured intent specification.

CONTEXT:
{context_view_summary}

CONSTRAINTS:
{constraints}

CONVERSATION:
{recent_turns}

USER REQUEST:
{user_message}

Produce a JSON IntentSpec with: goal, surface, expectedOutcome,
constraints, urgency, complexity, requiredCapabilities, approvalLikely.
```

### 3.2 Task Planner

```python
class Task Planner:
    """
    Decomposes an IntentSpec into ordered sub-tasks.
    
    Stateless per request. Uses the model for decomposition
    and the Capability Fabric for feasibility checking.
    """
    
    async def plan(
        self,
        intent: IntentSpec,
        context: ContextView,
        fabric: CapabilityFabric,
    ) -> TaskPlan:
        """
        Steps:
        1. Gather capability manifest
        2. Call model to decompose intent into tasks
        3. For each task, identify required capability
        4. Check capability availability via fabric.evaluate()
        5. Mark tasks that will need approval
        6. Return TaskPlan
        """
        ...
```

### 3.3 Workflow Compiler

```python
class WorkflowCompiler:
    """
    Generates a workflow graph from a TaskPlan.
    
    The most complex new component. Must produce valid graphs
    that pass validation against the manifest.
    """
    
    async def compile(
        self,
        plan: TaskPlan,
        manifest: list[CapabilityDescriptor],
    ) -> tuple[Workflow, AuthorityEnvelope]:
        """
        Steps:
        1. Map each task to node types
        2. Generate node configurations
        3. Connect edges based on data flow
        4. Validate against NODE_SPECS
        5. Validate capability bindings against manifest
        6. Compute authority envelope
        7. Return workflow + envelope
        
        Validation rules:
        - Every node type must exist in NODE_SPECS
        - Every governed node's capability must exist in manifest
        - Every edge must connect valid ports
        - No orphan nodes (all reachable from entry)
        - No cycles (except through loop nodes)
        - Envelope must be computed and honest
        """
        ...
    
    def validate(
        self,
        workflow: Workflow,
        manifest: list[CapabilityDescriptor],
    ) -> ValidationResult:
        """
        Validate a workflow graph against the manifest.
        
        Returns:
        - valid: bool
        - errors: list of validation errors
        - envelope: AuthorityEnvelope
        """
        ...
```

### 3.4 Execution Controller

```python
class ExecutionController:
    """
    Orchestrates execution of plans and workflows.
    
    The controller does not execute directly. It delegates to
    the Workflow Engine (for workflows) or the Capability Fabric
    (for single invocations).
    """
    
    async def execute(
        self,
        plan: TaskPlan | Workflow,
        context: ExecutionContext,
    ) -> ExecutionResult:
        """
        Steps:
        1. If workflow: delegate to Workflow Engine
        2. If single invocation: delegate to Capability Fabric
        3. Monitor execution via event stream
        4. Handle failures (retry, replan, escalate)
        5. Collect evidence
        6. Return result with evidence
        """
        ...
    
    async def monitor(
        self,
        run_id: str,
        callback: Callable[[RunEvent], None],
    ) -> None:
        """
        Subscribe to execution events and forward to callback.
        Used for live progress updates.
        """
        ...
```

### 3.5 Verification Engine

```python
class VerificationEngine:
    """
    Confirms that intended outcomes were achieved.
    
    Extends the existing Capability Fabric verification with
    higher-level outcome verification.
    """
    
    async def verify(
        self,
        plan: TaskPlan,
        result: ExecutionResult,
        audit_records: list[AuditRecord],
    ) -> VerificationReport:
        """
        Steps:
        1. For each task, compare expected vs actual outcome
        2. Check audit records for all invocations
        3. Verify that all verification checks passed
        4. Compose verification report
        """
        ...
```

### 3.6 Evidence Collector

```python
class EvidenceCollector:
    """
    Assembles verifiable evidence for the user.
    
    Reads existing audit records and verification results.
    Does not create new records.
    """
    
    def collect(
        self,
        plan: TaskPlan,
        result: ExecutionResult,
        audit_records: list[AuditRecord],
        verification: VerificationReport,
    ) -> EvidenceBundle:
        """
        Steps:
        1. Filter audit records for this execution
        2. Link verification results to invocations
        3. Compose human-readable evidence summary
        4. Return evidence bundle
        """
        ...
```

---

## 4. State Management

### 4.1 Agent State

The Agent maintains state across a session:

```python
class AgentSession:
    """State for one agent session."""
    
    session_id: str
    project_id: str
    created_at: str
    
    # Conversation
    messages: list[Message]
    
    # Active execution
    active_plan: TaskPlan | None
    active_run_id: str | None
    
    # Pending approvals
    pending_approvals: list[ApprovalRequest]
    
    # Token budget
    tokens_used: int
    token_budget: int
    
    # History
    completed_plans: list[TaskPlan]
    evidence_bundles: list[EvidenceBundle]
```

### 4.2 Persistence

Agent state persists to disk:

```
~/.aura/agent/
├── sessions/
│   ├── {session_id}.json     # Session state
│   └── ...
├── evidence/
│   ├── {run_id}.json         # Evidence bundles
│   └── ...
└── memory/
    ├── preferences.json      # User preferences
    └── patterns.json         # Learned patterns
```

---

## 5. Integration Points

### 5.1 With Capability Fabric

The Agent uses the Fabric exclusively for:
- **Capability evaluation** (`fabric.evaluate()`) — pre-flight checks
- **Tool execution** (`fabric.invoke()`) — all side effects
- **Audit trail** (`fabric.audit()`) — evidence collection
- **Approval management** — `pendingApprovals()`, `decideApproval()`

The Agent NEVER:
- Calls executors directly
- Bypasses policy evaluation
- Creates its own approval system
- Writes to the audit trail directly

### 5.2 With Workflow Engine

The Agent uses the Workflow Engine for:
- **Running compiled workflows** — via the existing run API
- **Monitoring execution** — via SSE event stream
- **Checkpoint and resume** — via the existing store

The Agent extends the Workflow Engine by:
- **Generating workflow definitions** — new capability
- **Computing authority envelopes** — uses existing `envelope.ts`
- **Coordinating multiple workflows** — new capability

### 5.3 With Automation Engine

The Agent uses the Automation Engine for:
- **Creating scheduled tasks** — via `AutomationStore`
- **Creating event-triggered rules** — via `AutomationStore`
- **Monitoring background tasks** — via `AutomationScheduler`

The Agent extends the Automation Engine by:
- **Generating automation rules from intent** — new capability
- **Generating workflows for rules to trigger** — new capability

### 5.4 With Context Fabric

The Agent uses the Context Fabric for:
- **Project understanding** — via `composeContextView()`
- **Capability awareness** — via `ContextCapability[]`
- **Freshness tracking** — via `Section.freshness`

The Agent extends the Context Fabric by:
- **Composing agent-specific context** — adding conversation history,
  task state, and pending approvals to the base context

### 5.5 With AI Providers

The Agent uses providers for:
- **Intent classification** — model call
- **Task decomposition** — model call
- **Workflow generation** — model call
- **Reasoning within agent nodes** — model call (existing bounded agent)

The Agent extends providers by:
- **Model routing** — selecting the right provider/model per task
- **Cost tracking** — aggregating usage across the plan

---

## 6. Security Architecture

### 6.1 Authority Boundary

```
User
  │
  ▼
Central Agent ──── REASONS about what to do
  │
  ▼
Capability Fabric ──── DECIDES what is allowed
  │
  ├──► Policy Engine (floors, overrides, node governance)
  ├──► Approval System (human gates)
  │
  ▼
Executor ──── PERFORMS the action
  │
  ▼
Audit Trail ──── PROVES what happened
```

The Agent CANNOT:
- Bypass the policy engine
- Grant itself capabilities
- Approve its own actions
- Write to the audit trail
- Execute without going through the Fabric
- Lower security floors

### 6.2 Threat Mitigations

| Threat | Mitigation |
| --- | --- |
| Agent generates unsafe workflow | Envelope computed before execution, shown to user |
| Agent tries to expand authority | Floors enforced, deny-only node governance |
| Agent loops on denied action | `denied` stop reason terminates the agent |
| Agent generates workflow with unknown capabilities | Manifest validation rejects before execution |
| Agent overwrites user context | Context Fabric is read-only |
| Agent bypasses approval | `awaiting-approval` parks the run, no bypass exists |

---

## 7. Testing Strategy

### 7.1 Unit Tests

Each component tested in isolation:
- Intent Compiler: mock model responses, verify schema output
- Task Planner: mock capabilities, verify decomposition
- Workflow Compiler: verify graph validation
- Verification Engine: mock audit records, verify comparison
- Evidence Collector: mock records, verify composition

### 7.2 Integration Tests

Components tested together:
- Intent → Plan → Validate: end-to-end planning
- Plan → Compile → Validate: workflow generation
- Execute → Monitor → Verify: execution pipeline

### 7.3 System Tests

Full system with real services:
- `node scripts/central-agent-verify.mjs` — end-to-end verification
- Test with real AURA service on :4319
- Test with real AI provider (kage7 or mock)

### 7.4 Security Tests

- Verify floors cannot be bypassed
- Verify approval cannot be self-authorized
- Verify audit trail is complete
- Verify envelope is honest
- Verify workflow validation catches invalid graphs

---

## 8. Performance Considerations

### 8.1 Latency Budget

| Operation | Target | Strategy |
| --- | --- | --- |
| Intent compilation | < 2s | Fast model, cached context |
| Task planning | < 3s | Fast model, cached capabilities |
| Workflow compilation | < 5s | Fast model, cached manifest |
| Capability evaluation | < 50ms | Synchronous, cached state |
| Context composition | < 200ms | Cached intelligence artifacts |
| Evidence collection | < 100ms | In-memory audit trail |

### 8.2 Caching

- **Context views:** Cached per project, invalidated on repo changes
- **Capability evaluations:** Cached per capability+project, invalidated on env scan
- **Model responses:** Cached for identical inputs (hash-based)
- **Envelope computations:** Cached per workflow definition hash

### 8.3 Concurrency

- Multiple agent sessions can run concurrently (different sessions)
- A single session processes one intent at a time (queue)
- Workflow execution is concurrent (existing engine supports parallel nodes)
- Background tasks run independently (existing automation scheduler)

---

## 9. Migration Path

### 9.1 From Existing Architecture

The Central Agent builds ON TOP of the existing architecture, not instead
of it. The migration path:

1. **Phase 1:** Add Intent Compiler as a new endpoint. Existing UI unchanged.
2. **Phase 2:** Add Task Planner. Existing workflows still work.
3. **Phase 3:** Add Workflow Compiler. New workflows can be generated.
4. **Phase 4:** Add Execution Controller. Orchestrates existing engines.
5. **Phase 5:** Add Verification + Evidence. Extends existing audit.
6. **Phase 6:** Integrate with Ask AURA chatbox. User can chat with agent.

At no point does the existing system stop working. The Agent is an additive
layer.

### 9.2 Backward Compatibility

- Existing workflows continue to work unchanged
- Existing automation rules continue to work unchanged
- Existing UI surfaces continue to work unchanged
- The Agent is opt-in: users can still use the UI directly
- The Agent's generated workflows are normal workflows that can be
  edited in the existing workflow builder
