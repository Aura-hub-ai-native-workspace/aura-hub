# AURA Agent — Component Map

> **Status:** PROPOSED — awaiting review
>
> This document maps every existing AURA component to its role in the
> Central Agent architecture. For each component: what already exists,
> what the Agent needs from it, what extensions are required, and what
> is missing entirely.

---

## 1. Mapping Table

### 1.1 Existing Components → Agent Responsibilities

| Existing AURA Component | Location | Agent Responsibility | Required Extension | Missing Component |
| --- | --- | --- | --- | --- |
| **Capability Fabric** | `packages/capability-fabric/src/fabric.ts` | The Agent's execution interface. Every tool call goes through `fabric.invoke()`. | None — used as-is | — |
| **Policy Engine** | `capability-fabric/src/policy.ts` | Decides what the Agent may do. Floors enforced on every invocation. | None — used as-is | — |
| **`stricter()`** | `capability-fabric/src/policy.ts:123` | Combines policy decisions, only escalates. | None — used as-is | — |
| **Security Floors** | `capability-fabric/src/policy.ts:224-237` | Four floors that cannot be lowered by any configuration. | None — used as-is | — |
| **Approval System** | `capability-fabric/src/fabric.ts` (decideApproval) | Gates high-risk Agent actions. Single-use, fingerprint-bound. | None — used as-is | — |
| **Audit Trail** | `capability-fabric/src/fabric.ts` (record) | Immutable evidence of every Agent-governed action. | None — used as-is | — |
| **AuditPersistence** | `capability-fabric/src/types.ts` | Append-only audit storage. No `save(all)`. | None — used as-is | — |
| **FabricEvent** | `capability-fabric/src/types.ts` | Event stream for monitoring Agent execution. | None — used as-is | — |
| **CapabilityDescriptor** | `capability-fabric/src/types.ts` | Schema for capability definitions. Agent maps tasks to these. | None — used as-is | — |
| **InvocationContext** | `capability-fabric/src/types.ts` | Context carried on every Agent invocation. | None — used as-is | — |
| **InvocationResult** | `capability-fabric/src/types.ts` | Result of every Agent tool call. | None — used as-is | — |
| **VerificationReport** | `capability-fabric/src/types.ts` | Outcome verification for Agent actions. | Higher-level outcome verification | **Verification Engine** |
| **CAPABILITY_MANIFEST** | `capability-fabric/src/manifest.ts` | Complete list of available capabilities. Agent references for planning. | None — used as-is | — |
| **Node Catalogue** | `connected-environment/src/catalog.ts` | Discovers what tools exist on the machine. Agent queries for capability mapping. | None — used as-is | — |
| **Node Routing** | `connected-environment/src/resolver.ts` | Resolves which node performs a capability. Agent relies on for execution. | None — used as-is | — |
| **probeNode** | `ai-service/src/environment.ts` | Probes tool presence. Agent queries for capability availability. | None — used as-is | — |
| **scanEnvironment** | `ai-service/src/environment.ts` | Full environment scan. Agent triggers for capability discovery. | None — used as-is | — |
| **Workflow Engine** | `ai-service/src/workflow/engine.ts` | Executes compiled workflows. Agent delegates multi-step execution. | None — used as-is | — |
| **`runWorkflow()`** | `ai-service/src/workflow/engine.ts` | The entry point for workflow execution. Agent calls this. | None — used as-is | — |
| **WorkflowRunStore** | `ai-service/src/workflow/run/store.ts` | Persists workflow runs. Agent uses for checkpoint and resume. | None — used as-is | — |
| **WorkflowRun** | `ai-service/src/workflow/run/types.ts` | Durable run record. Agent reads for status and evidence. | None — used as-is | — |
| **NodeState** | `ai-service/src/workflow/run/types.ts` | Per-node state vocabulary. Agent observes for progress. | None — used as-is | — |
| **RunState** | `ai-service/src/workflow/run/types.ts` | Run-level state vocabulary. Agent observes for completion. | None — used as-is | — |
| **AgentTrace** | `ai-service/src/workflow/agent/types.ts` | Nine-beat ledger for agent execution. Agent reads for evidence. | None — used as-is | — |
| **AgentBeat** | `ai-service/src/workflow/agent/types.ts` | Individual beat in agent trace. Agent reads for progress. | None — used as-is | — |
| **AgentBounds** | `ai-service/src/workflow/agent/types.ts` | Hard limits on agent invocation. Agent respects for self-bounding. | None — used as-is | — |
| **runAgentLoop** | `ai-service/src/workflow/agent/loop.ts` | The bounded ReAct loop. Agent uses for reasoning within workflows. | None — used as-is | — |
| **Authority Envelope** | `ai-service/src/workflow/envelope.ts` | Computes what a workflow can do. Agent uses for pre-flight display. | None — used as-is | — |
| **`computeEnvelope()`** | `ai-service/src/workflow/envelope.ts` | Envelope computation from workflow nodes. Agent calls for generated workflows. | None — used as-is | — |
| **`diffEnvelopes()`** | `ai-service/src/workflow/envelope.ts` | Detects privilege creep across versions. Agent uses for version comparison. | None — used as-is | — |
| **Governor** | `ai-service/src/workflow/governor.ts` | Routes governed nodes through Fabric. Agent relies on for execution. | None — used as-is | — |
| **Goverened Bindings** | `ai-service/src/workflow/governed.ts` | Maps node types to capabilities. Agent references for workflow compilation. | None — used as-is | — |
| **NODE_SPECS** | `ai-service/src/workflow/nodes.ts` | Every production node type and its runtime. Agent references for graph generation. | None — used as-is | — |
| **Automation Engine** | `packages/automation/` | Event-driven rules and scheduling. Agent creates rules from intent. | None — used as-is | — |
| **AutomationStore** | `packages/automation/src/store.ts` | Persists automation rules. Agent writes new rules. | None — used as-is | — |
| **AutomationScheduler** | `packages/automation/src/scheduler.ts` | Cron-based scheduling. Agent uses for background tasks. | None — used as-is | — |
| **Context Fabric** | `ai-service/src/context/` | READ-ONLY project understanding. Agent reads for context composition. | Agent-specific context composition | **Context Manager** |
| **`composeContextView()`** | `ai-service/src/context/compose.ts` | Composes project context. Agent calls for context gathering. | None — used as-is | — |
| **ContextView** | `ai-service/src/context/types.ts` | Complete project understanding. Agent consumes for planning. | None — used as-is | — |
| **ContextSurface** | `ai-service/src/context/types.ts` | Which context slice to use. Agent selects based on intent. | None — used as-is | — |
| **Freshness** | `ai-service/src/context/types.ts` | Context staleness tracking. Agent uses to decide if refresh needed. | None — used as-is | — |
| **AI Providers** | `ai-service/src/provider/` | Multi-provider model access. Agent uses for all model calls. | Model routing logic | **Model Router** |
| **Provider Registry** | `ai-service/src/provider/registry.ts` | Maps provider id → adapter. Agent queries for available providers. | None — used as-is | — |
| **Provider Adapters** | `ai-service/src/provider/adapters/` | Transport layer for each provider. Agent uses through pipeline. | None — used as-is | — |
| **PipelineManager** | `ai-service/src/pipeline.ts` | Unified model call interface. Agent uses for all AI operations. | None — used as-is | — |
| **Project Memory** | `ai-service/src/memory.ts` | Keyword + pin ranked project knowledge. Agent reads and writes. | None — used as-is | — |
| **Engineering Memory** | `packages/engineering-memory/` | Richer project knowledge (missions, decisions). Agent reads. | None — used as-is | — |
| **Secret Store** | `ai-service/src/secrets.ts` | AES-256-GCM credential storage. Agent never sees raw credentials. | None — used as-is | — |
| **`redactor()`** | `ai-service/src/secrets.ts` | Scrubs secrets from recorded text. Agent uses for all output. | None — used as-is | — |
| **Process Execution** | `ai-service/src/exec/process.ts` | Single process primitive. Agent relies on through Fabric. | None — used as-is | — |
| **`settle()`** | `ai-service/src/exec/process.ts` | The one place process outcomes are decided. Agent relies on. | None — used as-is | — |
| **SAFE_BINARIES** | `ai-service/src/exec/process.ts` | Medium-risk binary allow-list. Agent cannot add to this. | None — used as-is | — |
| **AGENT_BINARIES** | `ai-service/src/exec/process.ts` | High-risk agent allow-list. Agent delegates to these. | None — used as-is | — |
| **INSTALLER_BINARIES** | `ai-service/src/exec/install.ts` | System-floor installer allow-list. Agent cannot bypass. | None — used as-is | — |
| **Mission System** | `ai-service/src/mission/` | Goal graphs and DAG execution. Agent can create missions. | None — used as-is | — |
| **MissionStore** | `ai-service/src/mission/store.ts` | Persists missions. Agent reads for status. | None — used as-is | — |
| **`buildDag()`** | `ai-service/src/mission/execution/dag.ts` | DAG construction from tasks. Agent references for task decomposition. | None — used as-is | — |
| **Tauri Shell** | `apps/desktop/src-tauri/` | Desktop shell, service lifecycle. Agent runs within the service. | None — used as-is | — |
| **Frontend** | `apps/desktop/src/` | UI screens, workspace, panels. Agent surfaces through existing UI. | Agent workspace integration | **Agent Workspace UI** |

### 1.2 New Components (Central Agent)

| New Component | Purpose | Dependencies | Priority |
| --- | --- | --- | --- |
| **Intent Compiler** | Natural language → structured intent | AI provider, Context Fabric | HIGH |
| **Task Planner** | Intent → decomposition | AI provider, Capability Fabric | HIGH |
| **Capability Checker** | Pre-flight capability verification | Capability Fabric | HIGH |
| **Workflow Compiler** | Tasks → workflow graph | AI provider, NODE_SPECS, CAPABILITY_MANIFEST | HIGH |
| **Workflow Validator** | Graph validation against manifest | NODE_SPECS, CAPABILITY_MANIFEST, envelope.ts | HIGH |
| **Execution Controller** | Orchestrate execution | Workflow Engine, Capability Fabric | HIGH |
| **Observation Processor** | Monitor execution via events | RunEvent stream, FabricEvent stream | MEDIUM |
| **Verification Engine** | Confirm intended outcome | Audit Trail, VerificationReport | MEDIUM |
| **Evidence Collector** | Assemble evidence bundle | Audit Records, Verification Results | MEDIUM |
| **Context Manager** | Agent-specific context composition | Context Fabric, Conversation History | MEDIUM |
| **Model Router** | Select provider/model per task | Provider Registry, Model Validation | MEDIUM |
| **MCP Gateway** | Connect external MCP servers | MCP Python SDK, Capability Fabric | MEDIUM |
| **MCP Tool Mapper** | Map MCP tools to AURA capabilities | CAPABILITY_MANIFEST, Trust Evaluation | MEDIUM |
| **Agent Session Manager** | Manage agent sessions | Persistence (JSON files) | LOW |
| **Token Budget Manager** | Track and enforce token budgets | Provider usage data | LOW |
| **Notification Manager** | Background task notifications | Automation Engine | LOW |

---

## 2. Data Flow Map

### 2.1 Intent → Execution Data Flow

```
User Input
    │
    ▼
Intent Compiler
    │  reads: ContextView, ConversationHistory
    │  calls: AI Provider (model)
    │  writes: IntentSpec
    ▼
Task Planner
    │  reads: IntentSpec, ContextView, CAPABILITY_MANIFEST
    │  calls: AI Provider (model)
    │  calls: fabric.evaluate() (per capability)
    │  writes: TaskPlan, CapabilityCheckResult
    ▼
Workflow Compiler (when multi-step)
    │  reads: TaskPlan, CapabilityCheckResult, NODE_SPECS
    │  calls: AI Provider (model)
    │  validates: against CAPABILITY_MANIFEST
    │  computes: AuthorityEnvelope
    │  writes: Workflow, AuthorityEnvelope
    ▼
Execution Controller
    │  reads: Workflow or TaskPlan
    │  delegates to: Workflow Engine (for workflows)
    │  delegates to: fabric.invoke() (for single invocations)
    │  monitors: RunEvent stream
    │  writes: ExecutionResult
    ▼
Verification Engine
    │  reads: TaskPlan, ExecutionResult, Audit Records
    │  compares: expected vs actual
    │  writes: VerificationReport
    ▼
Evidence Collector
    │  reads: Audit Records, VerificationReport, ExecutionResult
    │  composes: EvidenceBundle
    │  writes: EvidenceBundle → User
```

### 2.2 Context Data Flow

```
Context Fabric (existing)
    │  reads: Intelligence artifacts, Git state, Environment scan
    │  composes: ContextView
    ▼
Context Manager (new)
    │  reads: ContextView
    │  adds: Conversation history, Task state, Pending approvals
    │  composes: AgentContext
    ▼
Intent Compiler
    │  reads: AgentContext
    │  produces: IntentSpec with context constraints
    ▼
Task Planner
    │  reads: AgentContext
    │  produces: TaskPlan with context awareness
```

### 2.3 Evidence Data Flow

```
Capability Fabric
    │  records: AuditRecord (per invocation)
    │  records: VerificationReport (per verification)
    ▼
Workflow Engine
    │  records: WorkflowRun (per run)
    │  records: NodeRunRecord (per node)
    │  records: AgentTrace (per agent node)
    ▼
Evidence Collector
    │  reads: AuditRecord[]
    │  reads: VerificationReport[]
    │  reads: WorkflowRun
    │  reads: AgentTrace
    │  composes: EvidenceBundle
    ▼
User
    │  sees: Human-readable evidence summary
    │  sees: Links to audit records
    │  sees: Verification results
```

---

## 3. Dependency Graph

### 3.1 Component Dependencies

```
                    Intent Compiler
                         │
            ┌────────────┼────────────┐
            │            │            │
            ▼            ▼            ▼
       Context      AI Provider   Conversation
       Manager      (existing)    History
            │
            ▼
       Context Fabric (existing)
            │
            ▼
       Intelligence Artifacts (existing)


                    Task Planner
                         │
            ┌────────────┼────────────┐
            │            │            │
            ▼            ▼            ▼
       Intent       CAPABILITY    fabric.
       Compiler     MANIFEST      evaluate()
       (above)      (existing)    (existing)
            │
            ▼
       Capability Checker


                  Workflow Compiler
                         │
            ┌────────────┼────────────┐
            │            │            │
            ▼            ▼            ▼
       Task Plan    NODE_SPECS    envelope.ts
       (above)      (existing)    (existing)
            │
            ▼
       Workflow Validator


                 Execution Controller
                         │
            ┌────────────┼────────────┐
            │            │            │
            ▼            ▼            ▼
       Workflow     Capability    Bounded
       Engine       Fabric        Agent
       (existing)   (existing)    (existing)
            │
            ▼
       Observation Processor
            │
            ▼
       Verification Engine
            │
            ▼
       Evidence Collector
```

### 3.2 What Depends on What

| Component | Depends On (New) | Depends On (Existing) |
| --- | --- | --- |
| Intent Compiler | — | AI Provider, Context Fabric |
| Task Planner | Intent Compiler | AI Provider, CAPABILITY_MANIFEST, fabric.evaluate() |
| Capability Checker | Task Planner | Capability Fabric |
| Workflow Compiler | Task Planner | AI Provider, NODE_SPECS, CAPABILITY_MANIFEST, envelope.ts |
| Workflow Validator | Workflow Compiler | NODE_SPECS, CAPABILITY_MANIFEST |
| Execution Controller | Task Planner, Workflow Compiler | Workflow Engine, Capability Fabric, Bounded Agent |
| Observation Processor | Execution Controller | RunEvent stream, FabricEvent stream |
| Verification Engine | Execution Controller | Audit Trail, VerificationReport |
| Evidence Collector | Verification Engine | Audit Records, VerificationReport |
| Context Manager | — | Context Fabric, Conversation History |
| Model Router | — | Provider Registry, Model Validation |
| MCP Gateway | — | MCP SDK, Capability Fabric, Trust Evaluation |

---

## 4. What the Agent Does NOT Need

These existing capabilities are NOT required for the Central Agent MVP:

| Component | Why Not Needed |
| --- | --- |
| **Mission System** | The Agent produces workflows, not missions. Missions are a separate execution path. |
| **Knowledge Graph** | The Context Fabric provides project understanding. The Agent reads it, not the graph directly. |
| **Predictive Engineering** | Future feature. Not required for Agent MVP. |
| **Diagnosis Engine** | The Agent can trigger diagnosis through automation rules, not directly. |
| **Graphify** | User-owned knowledge graph. Not part of the Agent's execution path. |
| **Website** | Static assets. Not part of the Agent. |
| **Tauri IPC** | The Agent runs in the service, not the renderer. IPC is not needed. |

---

## 5. Migration Path

### 5.1 Additive Only

The Central Agent is an ADDITIVE layer. It does not replace or modify
existing components:

1. **Phase 1:** Add Intent Compiler as a new module. Existing UI unchanged.
2. **Phase 2:** Add Task Planner + Capability Checker. Existing workflows
   still work.
3. **Phase 3:** Add Workflow Compiler + Validator. New workflows can be
   generated. Existing workflows still work.
4. **Phase 4:** Add Execution Controller + Verification. Orchestrates
   existing engines. Existing execution paths still work.
5. **Phase 5:** Add MCP Gateway + Integration. External tools connect.
   Existing tool system unchanged.

### 5.2 Backward Compatibility

At every phase:
- Existing workflows continue to work unchanged
- Existing automation rules continue to work unchanged
- Existing UI surfaces continue to work unchanged
- The Agent is opt-in: users can still use the UI directly
- The Agent's generated workflows are normal workflows that can be
  edited in the existing workflow builder
- The Fabric, Policy, Approval, and Audit systems are unchanged

### 5.3 What Changes

The only changes to existing code:
1. **New API endpoints** — `/agent/intent`, `/agent/plan`, etc.
2. **New SSE event types** — Agent-specific events in the event stream
3. **New persistence** — Agent session files under `~/.aura/agent/`
4. **New UI surface** — Agent workspace (optional, future)

No existing code is modified. No existing behavior is changed. The Agent
is a new consumer of existing APIs.
