# AURA Central AI Agent — Comprehensive Technical Research

> **Status:** RESEARCH COMPLETE — NOT IMPLEMENTED
>
> This document records the complete technical research for building AURA Hub's
> Central AI Agent. Every claim is tagged as **VERIFIED** (exists in source),
> **RESEARCHED** (from primary sources), **INFERRED** (from evidence but not
> directly observed), or **PROPOSED** (designed here, awaiting validation).
>
> Companion documents:
> [Architecture](./AURA_CENTRAL_AGENT_ARCHITECTURE.md) ·
> [Roadmap](./AURA_CENTRAL_AGENT_ROADMAP.md) ·
> [MCP + Plugin Research](./AURA_AGENT_MCP_PLUGIN_RESEARCH.md) ·
> [Security Model](./AURA_AGENT_SECURITY_MODEL.md) ·
> [Component Map](./AURA_AGENT_COMPONENT_MAP.md)

---

## 1. Executive Summary

The AURA Central Agent is the **intelligence and orchestration layer** that
sits at the center of AURA Hub. It is NOT a chatbot, NOT a shell, and NOT a
god process. It is the layer that:

1. **Understands** user intent expressed in natural language
2. **Plans** multi-step actions using the existing AURA ecosystem
3. **Discovers** what capabilities are available through the Capability Fabric
4. **Requests authority** through the existing policy engine and approval system
5. **Delegates execution** to the existing workflow engine, automation engine,
   or bounded agent runtime
6. **Observes** outcomes through the existing audit trail and evidence system
7. **Verifies** results through existing verification mechanisms
8. **Reports** with evidence, not claims

The critical design principle: **The Agent reasons. The Fabric decides what it
is allowed to do. The Executor performs the action. The Evidence system proves
what happened.**

This document maps what AURA already has, identifies what is missing, proposes
an architecture for the Central Agent, and provides a roadmap for implementation.

---

## 2. What AURA Hub Already Has

### 2.1 Existing Component Inventory

| Component | Location | Status | Central Agent Responsibility |
| --- | --- | --- | --- |
| **Capability Fabric** | `packages/capability-fabric/` | IMPLEMENTED · VERIFIED | The Agent's authority gate. Every tool call goes through Fabric invoke. |
| **Policy Engine** | `capability-fabric/src/policy.ts` | IMPLEMENTED · VERIFIED | Decides what the Agent may do. Floors cannot be overridden. |
| **Approval System** | `capability-fabric/src/fabric.ts` (decideApproval) | IMPLEMENTED · VERIFIED | Gates high-risk actions. Single-use, fingerprint-bound. |
| **Audit Trail** | `capability-fabric/src/fabric.ts` (record) | IMPLEMENTED · VERIFIED | Immutable evidence of every governed action. |
| **Node Catalogue** | `connected-environment/src/catalog.ts` | IMPLEMENTED · VERIFIED | Discovers what tools exist on the machine. |
| **Node Routing** | `connected-environment/src/resolver.ts` | IMPLEMENTED · VERIFIED | Resolves which node performs a capability. |
| **Workflow Engine** | `ai-service/src/workflow/engine.ts` | IMPLEMENTED · VERIFIED | Executes directed graphs of production nodes. |
| **Workflow Governor** | `ai-service/src/workflow/governor.ts` | IMPLEMENTED · VERIFIED | Routes governed nodes through the Fabric. |
| **Bounded Agent** | `ai-service/src/workflow/agent/loop.ts` | IMPLEMENTED · VERIFIED | ReAct loop with hard bounds, tool scoping, audit. |
| **Agent Trace** | `ai-service/src/workflow/agent/types.ts` | IMPLEMENTED · VERIFIED | Nine-beat ledger, evidence refs, resume capability. |
| **Automation Engine** | `packages/automation/` | IMPLEMENTED | Event-driven rules, scheduling, workflow triggering. |
| **Context Fabric** | `ai-service/src/context/` | IMPLEMENTED | READ-ONLY project understanding with provenance. |
| **Authority Envelope** | `ai-service/src/workflow/envelope.ts` | IMPLEMENTED | Computes what a workflow CAN do before it runs. |
| **AI Providers** | `ai-service/src/provider/` | IMPLEMENTED · PARTIAL | Multi-provider model access with credential management. |
| **Mission System** | `ai-service/src/mission/` | IMPLEMENTED · PARTIAL | Goal graphs, DAG execution, task management. |
| **Connected Environment** | `packages/connected-environment/` | IMPLEMENTED · VERIFIED | Machine capability detection, probing. |
| **Process Execution** | `ai-service/src/exec/process.ts` | IMPLEMENTED · VERIFIED | Single process primitive, three allow-lists. |
| **Secrets** | `ai-service/src/secrets.ts` | IMPLEMENTED | AES-256-GCM credential storage. |
| **Project Memory** | `ai-service/src/memory.ts` | IMPLEMENTED | Keyword + pin ranked project knowledge. |

### 2.2 What Already Solves Central Agent Problems

Several components already solve problems that would otherwise require new
infrastructure:

1. **The Capability Fabric IS the Agent's execution interface.** The Agent
   does not need its own process primitive, its own file operations, or its
   own network access. Every effect goes through `fabric.invoke()`.

2. **The Policy Engine IS the Agent's authority model.** The Agent does not
   need its own permission system. Policy floors, `stricter()` composition,
   and node governance already enforce what the Agent can and cannot do.

3. **The Approval System IS the Agent's human-in-the-loop mechanism.** The
   Agent does not need its own approval flow. `awaiting-approval` already
   parks an invocation, persists the request, and resumes on decision.

4. **The Audit Trail IS the Agent's evidence system.** Every governed action
   already records requestedNodeId, executedNodeId, outcome, verification,
   and duration. The Agent's "show me what happened" is already answered.

5. **The Bounded Agent IS the Agent's reasoning loop.** The existing ReAct
   loop in `agent/loop.ts` already handles: intent → plan → proposal →
   permission → execution → observation → decision → result. It already has
   hard bounds, tool scoping, token budgets, and resume capability.

6. **The Context Fabric IS the Agent's context system.** It already composes
   project understanding with freshness tracking and provenance.

7. **The Workflow Engine IS the Agent's multi-step execution platform.** It
   already handles DAG execution, checkpointing, replay, and governed nodes.

8. **The Authority Envelope IS the Agent's capability discovery.** It already
   computes what a workflow can do, including agent-declared tools.

### 2.3 What Is Missing for the Central Agent

Despite the above, several components are missing or incomplete:

| Missing Component | Why It's Needed | Priority |
| --- | --- | --- |
| **Intent Compiler** | Translating natural language → structured task spec → capability requirements | HIGH |
| **Workflow Compiler** | Generating workflow graphs from task specifications | HIGH |
| **Central Agent Orchestrator** | The top-level loop that coordinates intent → plan → execute → verify | HIGH |
| **Multi-Workflow Coordinator** | Orchestrating multiple workflows and automations together | MEDIUM |
| **MCP Gateway** | Connecting external MCP servers as Agent tools | MEDIUM |
| **Model Router** | Selecting the right model for each sub-task | MEDIUM |
| **Memory Manager** | Long-term knowledge accumulation across sessions | LOW |
| **Cost/Token Tracker** | Budget management across multi-step operations | LOW |
| **Notification Manager** | Background task completion notifications | LOW |

---

## 3. The Central Agent Definition

### 3.1 What It Is

The AURA Central Agent is an **intent-driven orchestration engine** that:

- Accepts natural language intent from the user
- Decomposes it into bounded, governed sub-tasks
- Routes each sub-task to the appropriate execution platform
- Monitors execution through the existing audit and evidence systems
- Recovers from failures using the existing checkpoint and replay mechanisms
- Reports results with verifiable evidence

### 3.2 What It Is NOT

| Not | Because |
| --- | --- |
| A chatbot | It produces actions, not just text |
| An autonomous agent | It operates within explicit authority bounds |
| A shell | It delegates to governed executors |
| A workflow engine | It produces workflows; the existing engine runs them |
| A policy engine | It respects the existing one; it does not replace it |
| A god process | Every action goes through the Capability Fabric |

### 3.3 Boundaries

**Inside the Agent:**
- Intent interpretation and normalization
- Task decomposition and planning
- Context gathering and composition
- Workflow compilation
- Execution orchestration
- Result observation and verification
- Failure recovery and replanning
- Evidence collection and reporting

**Outside the Agent (existing systems):**
- Capability Fabric (authority, execution, audit)
- Policy Engine (decisions, floors)
- Approval System (human gates)
- Workflow Engine (graph execution)
- Automation Engine (event-driven rules)
- Context Fabric (project understanding)
- Connected Environment (tool discovery)
- Node Routing (which tool performs)

---

## 4. Architecture

### 4.1 The Agent Loop

The Central Agent operates in a single, auditable loop:

```
USER INTENT
    │
    ▼
┌───────────────────┐
│ INTENT COMPILER   │  Natural language → structured intent
│                   │  Input: user message + context
│                   │  Output: IntentSpec
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ TASK PLANNER      │  IntentSpec → decomposition
│                   │  Input: intent + context + capabilities
│                   │  Output: TaskPlan (ordered sub-tasks)
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ CAPABILITY CHECK  │  Each sub-task → capability requirements
│                   │  Input: task plan + capability manifest
│                   │  Output: CapabilityRequest[]
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ WORKFLOW          │  Tasks → workflow graph (when multi-step)
│ COMPILER          │  Input: task plan + capability requests
│                   │  Output: Workflow definition
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ AUTHORITY CHECK   │  Pre-flight policy evaluation
│                   │  Input: workflow envelope + context
│                   │  Output: approval requirements
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ EXECUTION         │  Hand off to Workflow Engine or direct Fabric invoke
│ CONTROLLER        │  Input: workflow or single invocation
│                   │  Output: execution results
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ OBSERVATION       │  Monitor execution via events + audit trail
│ PROCESSOR         │  Input: run events + audit records
│                   │  Output: execution status
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ VERIFICATION      │  Confirm intended outcome
│ ENGINE            │  Input: expected vs actual
│                   │  Output: verification report
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ EVIDENCE          │  Collect + present evidence
│ COLLECTOR         │  Input: audit records + verification + output
│                   │  Output: evidence bundle
└────────┬──────────┘
         │
         ▼
RESULT TO USER
(with evidence, not claims)
```

### 4.2 The Agent as a Workflow Node

The Central Agent itself can be a workflow node. The existing bounded agent
(`agent/loop.ts`) already demonstrates this pattern. The Central Agent
extends it by:

1. **Operating at a higher level** — it produces workflows, not just tool calls
2. **Coordinating multiple executions** — it can launch and monitor multiple workflows
3. **Managing long-running tasks** — it persists across sessions
4. **Reasoning about capability discovery** — it knows what the system can do

### 4.3 How the Agent Connects to Existing Systems

```
                    AURA CENTRAL AGENT
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
         Intent        Workflow      Context
         Compiler      Compiler      Manager
              │            │            │
              └────────────┼────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   ONE PATH   │
                    │  fabric.     │
                    │  invoke()    │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
         Policy        Approval     Audit
         Engine        System       Trail
              │            │            │
              └────────────┼────────────┘
                           │
                           ▼
                    Capability Fabric
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
         Workflow      Bounded      External
         Engine        Agent        MCP
         (graphs)     (ReAct)      Servers
```

---

## 5. Component-by-Component Breakdown

### 5.1 Intent Compiler

**Purpose:** Transform natural language user intent into a structured
`IntentSpec` that the rest of the system can reason about.

**Input:** User message string + `ContextView`

**Output:** `IntentSpec`:
```typescript
interface IntentSpec {
  goal: string;                    // What the user wants
  surface: ContextSurface;         // Which context slice matters
  expectedOutcome: string;         // How we know it worked
  constraints: string[];           // Boundaries
  urgency: 'immediate' | 'background' | 'scheduled';
  complexity: 'single' | 'multi-step' | 'workflow';
  requiredCapabilities: string[];  // Estimated capabilities needed
  approvalLikely: boolean;         // Will policy gate this?
}
```

**State:** Stateless. Composed per request.

**Dependencies:** AI provider (for intent classification), Context Fabric

**Security:** The intent compiler must not expand authority. Its output is
a structured description, not an execution plan.

**Which AURA component:** No existing component. New module.

**Sync/Async:** Async (requires model call).

### 5.2 Task Planner

**Purpose:** Decompose an `IntentSpec` into ordered sub-tasks with
capability requirements.

**Input:** `IntentSpec` + `ContextView` + `CapabilityManifest`

**Output:** `TaskPlan`:
```typescript
interface TaskPlan {
  intent: IntentSpec;
  tasks: PlannedTask[];
  estimatedApprovals: number;
  estimatedDuration: string;
}

interface PlannedTask {
  id: string;
  description: string;
  capabilityId?: string;      // Direct capability, or...
  workflowId?: string;        // ...pre-built workflow to run
  workflowDefinition?: Workflow; // ...workflow to compile
  input: Record<string, unknown>;
  dependsOn: string[];        // Task dependencies
  risk: RiskLevel;
  reversible: boolean;
}
```

**State:** Stateless per request.

**Dependencies:** AI provider, Capability Fabric manifest, Context Fabric

**Security:** Task planning must not assume capabilities are available.
The capability check happens after planning.

**Which AURA component:** The existing `mission/taskGen.ts` provides
partial functionality. Extends to handle workflow generation.

**Sync/Async:** Async (requires model call).

### 5.3 Capability Checker

**Purpose:** Verify that each planned task's required capabilities are
actually available and what policy will say.

**Input:** `TaskPlan` + `CapabilityFabric`

**Output:** `CapabilityCheckResult`:
```typescript
interface CapabilityCheckResult {
  tasks: {
    taskId: string;
    capabilityId: string;
    available: boolean;
    policy: PolicyEvaluation;
    nodeResolution: NodeResolution;
  }[];
  blockedTasks: string[];
  approvalRequired: { taskId: string; reason: string }[];
}
```

**State:** Stateless. Reads live capability state.

**Dependencies:** Capability Fabric, Connected Environment

**Security:** This is a read-only check. It does not grant authority.

**Which AURA component:** Extension of `fabric.evaluate()` — already exists
as a per-capability check. This batches it across a plan.

**Sync/Async:** Synchronous (reads cached state, no I/O).

### 5.4 Workflow Compiler

**Purpose:** Generate a workflow graph from a `TaskPlan` when the plan
requires multiple steps.

**Input:** `TaskPlan` + `CapabilityCheckResult`

**Output:** `Workflow` (the existing `WfNode[]` + `WfEdge[]` format)

**State:** Stateless per request.

**Dependencies:** AI provider (for graph generation), `CAPABILITY_MANIFEST`

**Security:** The compiled workflow MUST be validated against the manifest.
Unknown nodes or capabilities that do not exist must be rejected. The
authority envelope must be computed and shown before execution.

**Which AURA component:** New module. Builds on `workflow/types.ts` and
`workflow/envelope.ts`.

**Sync/Async:** Async (requires model call for complex graphs).

### 5.5 Execution Controller

**Purpose:** Orchestrate the execution of a plan — either a single
invocation, a compiled workflow, or a sequence of operations.

**Input:** `TaskPlan` or `Workflow` + context

**Output:** Execution results with evidence

**State:** Tracks active executions. Persists for resume.

**Dependencies:** Workflow Engine, Capability Fabric, Bounded Agent

**Security:** All execution goes through `fabric.invoke()`. The controller
does not have its own execution path.

**Which AURA component:** New module. Orchestrates existing engines.

**Sync/Async:** Async. May run long.

### 5.6 Observation Processor

**Purpose:** Monitor execution progress through the existing event system.

**Input:** `RunEvent` stream + `FabricEvent` stream

**Output:** Structured execution status updates

**Dependencies:** Workflow Engine events, Fabric events

**Security:** Read-only observation. No authority.

**Which AURA component:** Extension of existing SSE event system.

**Sync/Async:** Event-driven.

### 5.7 Verification Engine

**Purpose:** Confirm that the intended outcome was achieved.

**Input:** Expected outcome + actual results + audit records

**Output:** Verification report

**Dependencies:** Capability Fabric verification, Audit trail

**Security:** Read-only. Compares expected vs actual.

**Which AURA component:** Extension of existing `VerificationReport` in the
Fabric. Adds higher-level outcome verification.

**Sync/Async:** Synchronous (reads results).

### 5.8 Evidence Collector

**Purpose:** Assemble verifiable evidence for the user.

**Input:** Audit records + verification reports + execution outputs

**Output:** Evidence bundle

**Dependencies:** Audit trail, Verification engine

**Security:** Read-only. Assembles existing records.

**Which AURA component:** New module. Reads existing audit records.

**Sync/Async:** Synchronous.

### 5.9 Context Manager

**Purpose:** Manage what the Agent knows about the user's world.

**Input:** `ContextView` + conversation history + task state

**Output:** Composed context for the current reasoning step

**Dependencies:** Context Fabric, Project Memory, Engineering Memory

**Security:** Read-only. No mutations.

**Which AURA component:** Extension of existing `context/compose.ts`.

**Sync/Async:** Synchronous (reads cached data).

### 5.10 Model Router

**Purpose:** Select the appropriate AI model for each reasoning step.

**Input:** Task requirements (complexity, latency, cost, privacy)

**Output:** Provider + model selection

**Dependencies:** Provider registry, model validation

**Security:** Must not expose credentials. Must respect provider limits.

**Which AURA component:** Extension of existing `provider/registry.ts`.

**Sync/Async:** Synchronous (reads cached health/state).

---

## 6. Intent → Action Pipeline

The most critical research question: how does "I want X" become AURA actions?

### 6.1 The Compilation Pipeline

```
Natural Language
    │
    ▼
Structured Intent (IntentSpec)
    │  - goal, constraints, urgency, complexity
    │  - required surface, expected outcome
    ▼
Task Specification (TaskPlan)
    │  - ordered sub-tasks
    │  - capability requirements per task
    │  - dependency graph
    ▼
Capability Requirements
    │  - which capabilities are needed
    │  - which nodes can provide them
    │  - what policy will say
    ▼
Workflow Graph (when multi-step)
    │  - nodes = capabilities or agent
    │  - edges = data flow
    │  - envelope = what it can do
    ▼
Authority Envelope
    │  - computed from graph
    │  - shown to user before execution
    │  - "This workflow can X but cannot Y"
    ▼
Dry Run (optional)
    │  - evaluate conditions
    │  - check policy
    │  - predict approvals needed
    ▼
Approval (if needed)
    │  - user sees what will happen
    │  - grants or denies
    ▼
Execution
    │  - through Capability Fabric
    │  - with full audit trail
    ▼
Verification
    │  - did the intended outcome happen?
    │  - comparison against expected
    ▼
Evidence
    - audit records
    - verification results
    - output artifacts
```

### 6.2 Schema Requirements

```typescript
// Input: what the user says
interface UserIntent {
  text: string;
  projectId: string;
  timestamp: string;
}

// Step 1: structured interpretation
interface IntentSpec {
  goal: string;
  surface: ContextSurface;
  expectedOutcome: string;
  constraints: string[];
  urgency: 'immediate' | 'background' | 'scheduled';
  complexity: 'single' | 'multi-step' | 'workflow';
  requiredCapabilities: string[];
  approvalLikely: boolean;
}

// Step 2: decomposed plan
interface TaskPlan {
  intent: IntentSpec;
  tasks: PlannedTask[];
  estimatedApprovals: number;
  estimatedDuration: string;
}

// Step 3: capability-verified plan
interface VerifiedPlan {
  plan: TaskPlan;
  checks: CapabilityCheckResult;
  compilable: boolean;
  approvalRequired: { taskId: string; reason: string }[];
}

// Step 4: executable artifact
interface ExecutablePlan {
  verified: VerifiedPlan;
  workflow?: Workflow;        // When multi-step
  singleInvocation?: {        // When single-step
    capabilityId: string;
    input: Record<string, unknown>;
  };
  envelope: AuthorityEnvelope;
}
```

---

## 7. AI-Generated Workflows

### 7.1 How the Agent Creates Workflows

When a user says "Build a workflow that monitors my project every morning...",
the Agent must:

1. **Parse intent** → daily monitoring, multi-step, requires scheduling
2. **Identify capabilities** → git.status, coding-engine, generate-markdown, etc.
3. **Decompose into tasks** → fetch changes → analyze → summarize → report
4. **Map to node types** → changed-files → coding-engine → prompt → output
5. **Connect edges** → data flows between nodes
6. **Compute envelope** → what this workflow can do
7. **Show envelope** → "This workflow reads your project but cannot write files"
8. **Get approval** → user reviews the plan
9. **Execute** → through the existing workflow engine

### 7.2 Graph Validation

A compiled workflow must be validated:

- **Node type validity** → every node type exists in `NODE_SPECS`
- **Capability availability** → every governed node's capability exists
- **Edge connectivity** → every edge connects valid ports
- **No orphan nodes** → every node is reachable from an entry
- **Envelope computation** → what it can and cannot do
- **Policy pre-check** → what will need approval

### 7.3 Deterministic vs. AI-Generated Parts

| Part | Source | Trust Level |
| --- | --- | --- |
| Node types | `NODE_SPECS` | VERIFIED |
| Capability bindings | `governed.ts` | VERIFIED |
| Edge connectivity | Graph validation | VERIFIED |
| Envelope computation | `envelope.ts` | VERIFIED |
| Node configuration | AI-generated | UNTRUSTED |
| Graph structure | AI-generated | UNTRUSTED |
| Tool selection | AI-generated | UNTRUSTED |

The key insight: **AI generates the structure, but the system validates it.**
An AI-generated workflow that references a non-existent capability is
rejected at validation time, not at execution time.

---

## 8. Agent + Workflow Relationship

### 8.1 The Hybrid Model

AURA needs a hybrid model where the Agent:

**A. Creates workflows when appropriate:**
- Multi-step operations with clear structure
- Repeated operations (schedules, automations)
- Operations the user will want to reuse

**B. Supervises workflows during execution:**
- Monitors progress through events
- Handles failures and replanning
- Reports results with evidence

**C. Acts as a workflow node:**
- The existing bounded agent already does this
- For operations requiring reasoning within a workflow
- For operations that need to decide between paths

**D. Operates directly for simple tasks:**
- Single capability invocations
- Quick queries (context gathering)
- Simple file operations

### 8.2 Decision Matrix

| Scenario | Agent Behavior |
| --- | --- |
| "What's the status of my project?" | Direct context query → answer |
| "Fix this bug" | Task plan → single agent node or direct capability |
| "Set up daily monitoring" | Workflow compiler → schedule → automation rule |
| "Review my code changes" | Task plan → workflow (git → coding-engine → generate) |
| "Deploy to production" | Workflow compiler → approval → multi-step governed execution |

---

## 9. Context Architecture

### 9.1 What the Agent Needs to Know

The Agent needs context at three levels:

**L0 — Immediate (per request):**
- User's current message
- Open project identity
- Context freshness
- Recent conversation

**L1 — Session (per conversation):**
- Previous intents and outcomes
- Pending approvals
- Active workflows
- Background tasks

**L2 — Persistent (across sessions):**
- User preferences
- Project knowledge accumulated
- Past decisions and their outcomes
- Workflow templates created

### 9.2 Context Prioritization

The agent cannot put everything into every prompt. Research on context
prioritization:

**Relevance scoring:** Each context section gets a relevance score based on
the current intent. The Context Fabric already provides `ContextSurface` which
maps intent types to context slices.

**Freshness gating:** Stale context is reported as stale, not assumed fresh.
The existing `Freshness` model (`fresh | stale | unknown`) handles this.

**Compression:** Large contexts are summarized. The existing bounded agent
already clips text to `MAX_BEAT_TEXT` and `MAX_TRANSCRIPT_ENTRIES`.

**Hierarchical memory:** Recent context is detailed; older context is
summarized. The existing `ProjectMemory` and `EngineeringMemory` provide
this.

---

## 10. Memory Architecture

### 10.1 What AURA Actually Needs

AURA does not need a "memory database." It needs:

**Short-term memory (per session):**
- Current conversation turns
- Active task state
- Pending approvals
- Already exists: `conversations.ts`, in-memory agent state

**Working memory (per task):**
- Agent trace (beats, evidence)
- Intermediate results
- Already exists: `AgentTrace`, `WorkflowRun` records

**Episodic memory (past events):**
- Previous workflow runs and their outcomes
- Past automation runs
- Already exists: `WorkflowRunStore`, `AutomationStore`

**Semantic memory (accumulated knowledge):**
- Project understanding
- User preferences
- Decision patterns
- Already exists: `ProjectMemory`, `EngineeringMemory`, `ContextFabric`

### 10.2 Memory Metadata

Every memory item should have:
- `source`: Where it came from (fabric audit, user input, model inference)
- `timestamp`: When it was recorded
- `confidence`: How reliable it is (measured vs estimated)
- `provenance`: The authority that produced it
- `scope`: Project-scoped, session-scoped, or global
- `retention`: How long it should be kept
- `sensitivity`: Whether it contains secrets

---

## 11. Model Routing

### 11.1 Routing Criteria

The Agent should route to different models based on:

| Criterion | Low Complexity | High Complexity |
| --- | --- | --- |
| **Task** | Classification, extraction | Planning, reasoning, code generation |
| **Latency** | Fast model (Groq, local) | Any model |
| **Cost** | Cheap model | Budget-permitting |
| **Context** | Small context window OK | Large context needed |
| **Privacy** | Cloud OK | Local model preferred |
| **Tool use** | Simple tool calls | Complex multi-tool reasoning |

### 11.2 Provider Abstraction

The existing provider system already supports multiple providers. The
Model Router extends it by:

1. Reading task requirements from the IntentSpec
2. Consulting provider health and capability
3. Selecting the optimal provider/model pair
4. Falling back on failure

The existing `provider/registry.ts` and `provider/adapters/` already handle
the transport layer. The Router adds selection logic on top.

---

## 12. Multi-Agent Analysis

### 12.1 Does AURA Need Multiple Agents?

**Research finding: AURA should use specialized bounded agents, NOT a
multi-agent swarm.**

Reasons:
1. **The Capability Fabric is the single authority.** Multiple agents
   competing for the same authority create coordination problems.
2. **The existing bounded agent already handles tool scoping.** Each
   agent can have a different tool set.
3. **The workflow engine already handles parallelism.** Multiple agent
   nodes can run concurrently within a workflow.
4. **Multi-agent communication introduces unbounded complexity.** Agent-to-
   agent messaging bypasses the Fabric's audit trail.

### 12.2 Recommended Approach

Use **specialized agent configurations** rather than specialized agents:

- **Planner agent:** High-reasoning model, read-only tools, produces task plans
- **Coder agent:** Code-aware model, file editing tools, verification tools
- **Researcher agent:** Large-context model, search and read tools
- **Verifier agent:** Verification tools only, reads evidence and confirms

Each is the same bounded agent loop with different bounds, tools, and system
prompts. The workflow engine sequences them. The Capability Fabric governs
them all identically.

---

## 13. Background Autonomy

### 13.1 Long-Running Tasks

The Agent needs to handle:

- "Monitor my repository" → scheduled workflow
- "Watch this website" → periodic automation rule
- "Every morning prepare my report" → cron-triggered workflow
- "Notify me when the deployment fails" → event-triggered automation

### 13.2 Implementation

The existing `AutomationEngine` + `AutomationScheduler` already handle:
- Scheduling (cron expressions)
- Event subscriptions
- Action execution
- Run persistence

The Central Agent extends this by:
- **Generating automation rules** from user intent
- **Generating workflow definitions** for the rules to trigger
- **Managing the lifecycle** of background tasks

### 13.3 State Management

Background tasks need:
- **Persistent state** → already exists: `WorkflowRunStore`, `AutomationStore`
- **Wake-up mechanism** → already exists: `AutomationScheduler`
- **Task queue** → already exists: workflow execution queue
- **Retries** → already exists: bounded recovery in `fabric.ts`
- **Cancellation** → already exists: `AbortSignal` throughout

---

## 14. Failure Recovery

### 14.1 Failure Types

| Failure | Existing Recovery | Agent Extension |
| --- | --- | --- |
| Model failure | Provider error handling | Retry with different provider |
| Tool failure | Fabric bounded recovery (3 attempts) | Replan with alternative capability |
| Network failure | Transient detection + retry | Delay + retry |
| Permission denial | Policy denial → stop | Report to user, suggest policy change |
| Timeout | Timeout exit code (124) | Replan with simpler task |
| Partial execution | Checkpoint + replay | Resume from last checkpoint |
| Application restart | Persisted approval + audit | Rehydrate agent state |

### 14.2 Recovery Strategy

The Agent must never blindly repeat side effects. Recovery follows:

1. **Read checkpoint** → what was done, what remains
2. **Assess damage** → what succeeded, what failed
3. **Replan** → adjust the remaining plan based on partial results
4. **Re-execute** → through the same governed path
5. **Verify** → confirm the adjusted outcome

---

## 15. Verification Engine

### 15.1 What Should Be Verified

| Action Type | Verification Method |
| --- | --- |
| Code change | Tests pass, build succeeds |
| File operation | File exists, hash matches |
| API call | Response status + body validation |
| Browser action | Expected page state |
| Workflow completion | All nodes succeeded |
| Agent output | Matches expected criteria |

### 15.2 Distinction: Action vs. Verification

The Agent must distinguish:
- "I performed the action" (execution succeeded)
- "I verified the intended result" (verification passed)

An action can succeed without verification succeeding (the command ran but
the test failed). The evidence must report both separately.

---

## 16. Evidence Architecture

### 16.1 Evidence as First-Class Output

AURA should not simply say "Done." It should say:

```
DONE

Evidence:
- Workflow run: wf-abc-123 (all 5 nodes succeeded)
- Capability invocation: terminal.execute (git status) — succeeded
- Capability invocation: generate-markdown — succeeded
- Audit record: inv1a2b3c — succeeded, verified
- Verification: output contains expected sections
```

### 16.2 Evidence Sources

The evidence system already exists in the audit trail. The Agent extends it
by:

1. **Collecting** audit records for all actions in a plan
2. **Linking** verification results to their invocations
3. **Composing** a human-readable evidence bundle
4. **Persisting** the bundle alongside the run record

---

## 17. Performance and Cost

### 17.1 Token Management

The Agent must manage tokens across multi-step operations:

- **Context compression:** Summarize earlier steps in long conversations
- **Model selection:** Use cheap models for classification, expensive for reasoning
- **Tool result compression:** Clip large outputs (existing `MAX_OUTPUT_TEXT`)
- **Parallel execution:** Run independent tasks concurrently

### 17.2 Cost Control

- **Token budget per session:** Configurable maximum
- **Token budget per task:** Derived from task complexity
- **Provider cost tracking:** Use usage data from provider responses
- **Caching:** Cache context views, capability evaluations, model responses

### 17.3 Performance Targets

| Metric | Target |
| --- | --- |
| Intent → first response | < 3 seconds |
| Simple task completion | < 30 seconds |
| Complex workflow compilation | < 10 seconds |
| Context composition | < 500ms |
| Capability evaluation | < 100ms |

---

## 18. Python Implementation Architecture

### 18.1 Recommended Stack

Since AURA is migrating the backend toward Python:

| Component | Technology | Rationale |
| --- | --- | --- |
| **HTTP server** | FastAPI | Async, typed, well-documented |
| **Async runtime** | asyncio | Native Python async |
| **Data models** | Pydantic | Type validation, serialization |
| **HTTP client** | httpx | Async HTTP for provider calls |
| **Browser automation** | Playwright (async) | Async, multi-browser |
| **MCP SDK** | mcp (Python SDK) | Official MCP implementation |
| **Task queues** | asyncio.Queue + persistence | Simple, no external deps |
| **Event bus** | asyncio.Event + callbacks | Lightweight |
| **State persistence** | JSON files (existing pattern) | Consistent with current codebase |
| **Plugin isolation** | subprocess + IPC | Security boundary |

### 18.2 Module Structure

```
packages/central-agent/
├── __init__.py
├── intent/
│   ├── compiler.py          # IntentSpec generation
│   ├── classifier.py        # Intent type classification
│   └── schemas.py           # IntentSpec, TaskPlan types
├── planning/
│   ├── decomposer.py        # Task decomposition
│   ├── capability_check.py  # Pre-flight capability verification
│   └── workflow_compiler.py # Graph generation
├── execution/
│   ├── controller.py        # Orchestration
│   ├── observer.py          # Event monitoring
│   └── recovery.py          # Failure handling
├── verification/
│   ├── engine.py            # Outcome verification
│   └── evidence.py          # Evidence collection
├── context/
│   ├── manager.py           # Context composition
│   └── memory.py            # Memory management
├── routing/
│   ├── model_router.py      # Model selection
│   └── capability_router.py # Tool routing
├── mcp/
│   ├── gateway.py           # MCP server management
│   ├── security.py          # Tool trust evaluation
│   └── adapter.py           # AURA capability mapping
├── types.py                 # Shared type definitions
└── server.py                # FastAPI application
```

---

## 19. API Contracts

### 19.1 Agent API

```python
# Intent processing
POST /agent/intent
  Body: { text: string, projectId: string }
  Response: IntentSpec

# Task planning
POST /agent/plan
  Body: { intent: IntentSpec }
  Response: TaskPlan

# Workflow compilation
POST /agent/compile
  Body: { plan: TaskPlan }
  Response: { workflow: Workflow, envelope: AuthorityEnvelope }

# Execution
POST /agent/execute
  Body: { plan: TaskPlan } or { workflowId: string }
  Response: { runId: string, status: string }

# Status
GET /agent/runs/{runId}
  Response: { status: string, evidence: EvidenceBundle }

# Context
GET /agent/context/{projectId}
  Response: ContextView
```

### 19.2 Event Stream

```
GET /agent/events?runId={runId}
  Response: SSE stream of AgentEvent
```

---

## 20. Example Execution Flows

### 20.1 Simple Query

```
User: "What's the status of my project?"

Agent:
1. Intent: status inquiry (read-only)
2. Context: compose ContextView for open project
3. Execute: read context view (no Fabric invocation needed)
4. Verify: context freshness is 'fresh'
5. Report: project status from context view
```

### 20.2 Code Fix

```
User: "Fix the failing test in auth.test.ts"

Agent:
1. Intent: code fix (multi-step, irreversible)
2. Context: read project, git status, test results
3. Plan:
   a. Run tests to confirm failure
   b. Read the test file and source
   c. Analyze the failure
   d. Edit the source file
   e. Run tests again
   f. Verify all tests pass
4. Compile: workflow with agent node (needs reasoning)
5. Envelope: project.write + process.execute
6. Approval: "This workflow writes to your project and runs commands"
7. Execute: workflow engine runs the graph
8. Verify: tests pass
9. Evidence: audit records for each invocation
```

### 20.3 Automation Setup

```
User: "Every morning at 9 AM, check GitHub issues and summarize them"

Agent:
1. Intent: automation setup (scheduled, multi-step)
2. Context: project GitHub configuration
3. Plan:
   a. Create automation rule with cron trigger
   b. Create workflow: git fetch → GitHub API → summarize → output
4. Compile: workflow graph + automation rule
5. Envelope: network.outbound + project.read
6. Approval: "This will access GitHub daily"
7. Execute: create rule + workflow
8. Verify: rule exists, schedule active
9. Evidence: automation rule record, workflow definition
```

---

## 21. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Intent misinterpretation | Wrong actions taken | Confirmation before execution for ambiguous intents |
| Workflow compilation errors | Invalid graphs generated | Validation against manifest before execution |
| Token budget exhaustion | Incomplete operations | Budget tracking, graceful degradation |
| Provider failures | Agent cannot reason | Fallback providers, graceful degradation |
| Scope creep | Agent becomes a god process | Fabric enforcement, floors, audit |
| Complexity growth | System becomes unmaintainable | Strict boundaries, single authority |

---

## 22. Unknowns

| Unknown | Research Needed |
| --- | --- |
| Intent classification accuracy | Benchmark against test cases |
| Workflow compilation reliability | Measure success rate of generated graphs |
| Model routing effectiveness | A/B test model selection strategies |
| Multi-workflow coordination | Prototype with 2-3 concurrent workflows |
| MCP server isolation | Prototype sandboxed MCP execution |
| Long-running agent state | Prototype persistence across restarts |

---

## 23. Recommended Implementation Order

1. **Intent Compiler** — the entry point, can be tested in isolation
2. **Task Planner** — depends on intent compiler, testable with mock capabilities
3. **Capability Checker** — thin wrapper over existing `fabric.evaluate()`
4. **Execution Controller** — orchestrates existing engines, testable end-to-end
5. **Workflow Compiler** — the most complex new component, benefits from 1-4
6. **Verification Engine** — extends existing verification, testable independently
7. **Evidence Collector** — reads existing audit records, simple to implement
8. **Context Manager** — extends existing context compose, testable independently
9. **Model Router** — extends existing provider registry, testable independently
10. **MCP Gateway** — the most external integration, benefits from all above

Each phase produces a working increment that can be tested and verified
before the next phase begins.
