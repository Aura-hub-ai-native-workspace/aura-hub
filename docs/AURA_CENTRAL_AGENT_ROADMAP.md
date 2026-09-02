# AURA Central Agent — Implementation Roadmap

> **Status:** IN IMPLEMENTATION — milestone 1 landed
> (`feature/aura-central-agent`), see
> [AURA_CENTRAL_AGENT_IMPLEMENTATION.md](./AURA_CENTRAL_AGENT_IMPLEMENTATION.md)
> for what exists and what is verified.
>
> This document defines the implementation roadmap for the AURA Central Agent,
> organized into phases that each produce a working increment.

---

## Status snapshot (2026-08-24)

| Phase | State |
| --- | --- |
| Phase 0 — contracts | **DONE** — runtime-verified round-trips; honest outcome vocabulary (`denied`/`timeout`) |
| Phase 1 — intent compiler | **DONE** — structured schema (entities/ambiguity/confidence), real provider wire path verified against an OpenAI-compatible HTTP fixture; deterministic clarification policy owns blocking |
| Phase 2 — planner + capability checker | **DONE** — direct git.status / fs.write_file / run-workflow templates |
| Phase 3 — workflow compiler | **DONE** — frozen-vocabulary graphs incl. governed export-file synthesis from write clauses |
| Phase 4 — execution + verification | **DONE both routes** — Python engine executes stored graphs node-by-node through the Fabric; park/resume across restarts |
| Phase 5 — integration + MCP | **SUBSTANTIALLY DONE** — stdio transport, HTTP/SSE API with continuation routes (`/message`, `/approve`, `/plan`); plan-review hides reasoning; React consumption pending |

The original phase plan below is preserved unchanged for reference.

---

## Overview

The roadmap is organized into 6 phases, each building on the previous.
Every phase produces testable, verifiable output. No phase requires all
previous phases to be complete — only the ones it depends on.

```
Phase 0: Architecture + Contracts (no code, pure design)
Phase 1: Intent Compiler (entry point)
Phase 2: Task Planner + Capability Checker
Phase 3: Workflow Compiler + Validation
Phase 4: Execution Controller + Verification
Phase 5: Full Agent Integration + MCP Gateway
```

---

## Phase 0: Architecture + Contracts

**Duration:** 1-2 weeks
**Goal:** Finalize all interfaces, schemas, and contracts before writing code.

### Deliverables

1. **TypeScript/Python type definitions** for all schemas:
   - `IntentSpec`
   - `TaskPlan`
   - `PlannedTask`
   - `CapabilityCheckResult`
   - `VerifiedPlan`
   - `ExecutablePlan`
   - `EvidenceBundle`
   - `VerificationReport`

2. **API contract definitions:**
   - `POST /agent/intent` — intent compilation
   - `POST /agent/plan` — task planning
   - `POST /agent/compile` — workflow compilation
   - `POST /agent/execute` — execution
   - `GET /agent/runs/{runId}` — status
   - `GET /agent/events` — SSE stream

3. **Integration test plan:**
   - Test cases for each component
   - Mock definitions for external dependencies
   - Verification script outline

4. **Security review:**
   - Authority boundary documentation
   - Threat model validation
   - Floor enforcement verification plan

### Exit Criteria

- [ ] All schemas reviewed and approved
- [ ] API contracts reviewed and approved
- [ ] Integration test plan reviewed
- [ ] Security review complete

---

## Phase 1: Intent Compiler

**Duration:** 2-3 weeks
**Goal:** Transform natural language into structured intent.

### Components

1. **`intent/compiler.py`** — Main compiler class
   - Takes user message + context
   - Calls model to classify intent
   - Validates output against schema
   - Returns IntentSpec

2. **`intent/classifier.py`** — Intent type classification
   - Classifies intent as query/fix/setup/automation/review
   - Estimates complexity
   - Identifies required surface

3. **`intent/schemas.py`** — Type definitions
   - IntentSpec, TaskPlan types
   - Validation functions

### Dependencies

- AI provider (existing `provider/registry.ts` or Python equivalent)
- Context Fabric (existing `context/compose.ts`)

### Testing

- Unit tests: mock model responses, verify schema output
- Integration tests: real model, real context, verify intent quality
- Test cases:
  - Simple query: "What's the status of my project?"
  - Code fix: "Fix the failing test in auth.test.ts"
  - Setup: "Set up a workflow for daily code review"
  - Automation: "Every morning check GitHub issues"
  - Complex: "Review my recent changes, fix any issues, and create a PR"

### Exit Criteria

- [ ] Intent Compiler handles all test cases
- [ ] Schema validation catches malformed output
- [ ] Context integration works correctly
- [ ] Performance: < 2s for intent compilation

---

## Phase 2: Task Planner + Capability Checker

**Duration:** 2-3 weeks
**Goal:** Decompose intents into ordered, capability-verified sub-tasks.

### Components

1. **`planning/decomposer.py`** — Task decomposition
   - Takes IntentSpec + context
   - Calls model to decompose into tasks
   - Maps tasks to capabilities
   - Returns TaskPlan

2. **`planning/capability_check.py`** — Pre-flight verification
   - Takes TaskPlan + CapabilityFabric
   - Checks each task's capability availability
   - Evaluates policy for each task
   - Returns CapabilityCheckResult

### Dependencies

- Intent Compiler (Phase 1)
- Capability Fabric (existing `fabric.ts`)
- Connected Environment (existing `catalog.ts`)

### Testing

- Unit tests: mock capabilities, verify decomposition
- Integration tests: real fabric, verify policy evaluation
- Test cases:
  - Single capability task
  - Multi-capability task
  - Task requiring approval
  - Task with unavailable capability
  - Task with denied capability

### Exit Criteria

- [ ] Task Planner decomposes all test intents correctly
- [ ] Capability Checker identifies approval requirements
- [ ] Policy evaluation matches existing Fabric behavior
- [ ] Performance: < 3s for planning

---

## Phase 3: Workflow Compiler + Validation

**Duration:** 3-4 weeks
**Goal:** Generate valid workflow graphs from task plans.

### Components

1. **`planning/workflow_compiler.py`** — Graph generation
   - Takes TaskPlan + CapabilityCheckResult
   - Maps tasks to node types
   - Generates node configurations
   - Connects edges
   - Validates against manifest
   - Computes authority envelope
   - Returns Workflow + AuthorityEnvelope

2. **`planning/validator.py`** — Graph validation
   - Validates node types against NODE_SPECS
   - Validates capability bindings against manifest
   - Validates edge connectivity
   - Detects cycles and orphans
   - Computes and validates envelope

### Dependencies

- Task Planner (Phase 2)
- NODE_SPECS (existing `nodes.ts`)
- CAPABILITY_MANIFEST (existing `manifest.ts`)
- Authority Envelope (existing `envelope.ts`)

### Testing

- Unit tests: verify graph generation and validation
- Integration tests: real manifest, verify envelope computation
- Test cases:
  - Simple linear workflow (3 nodes)
  - Branching workflow (condition node)
  - Loop workflow (loop node)
  - Workflow with agent node
  - Invalid workflow (missing capability)
  - Invalid workflow (unknown node type)
  - Invalid workflow (orphan nodes)
  - Envelope computation for each case

### Exit Criteria

- [ ] Workflow Compiler generates valid graphs for all test plans
- [ ] Validator catches all invalid cases
- [ ] Envelope computation matches existing `envelope.ts` behavior
- [ ] Generated workflows can be executed by existing Workflow Engine
- [ ] Performance: < 5s for compilation

---

## Phase 4: Execution Controller + Verification

**Duration:** 2-3 weeks
**Goal:** Orchestrate execution and verify outcomes.

### Components

1. **`execution/controller.py`** — Execution orchestration
   - Takes TaskPlan or Workflow
   - Delegates to Workflow Engine or Capability Fabric
   - Monitors execution via events
   - Handles failures (retry, replan, escalate)
   - Returns ExecutionResult

2. **`execution/observer.py`** — Event monitoring
   - Subscribes to RunEvent and FabricEvent streams
   - Tracks execution progress
   - Reports status updates

3. **`verification/engine.py`** — Outcome verification
   - Takes plan + results + audit records
   - Compares expected vs actual
   - Returns VerificationReport

4. **`verification/evidence.py`** — Evidence collection
   - Takes audit records + verification + outputs
   - Composes EvidenceBundle
   - Returns human-readable evidence

### Dependencies

- Workflow Engine (existing `engine.ts`)
- Capability Fabric (existing `fabric.ts`)
- Audit Trail (existing `fabric.ts`)
- Verification System (existing `VerificationReport`)

### Testing

- Unit tests: mock execution, verify controller behavior
- Integration tests: real workflow engine, verify end-to-end
- Test cases:
  - Successful single invocation
  - Successful workflow execution
  - Failed execution (recovery)
  - Approval-gated execution
  - Timeout handling
  - Evidence collection for each case

### Exit Criteria

- [ ] Execution Controller handles all test scenarios
- [ ] Verification Engine correctly identifies outcomes
- [ ] Evidence Collector produces complete evidence bundles
- [ ] Performance: execution overhead < 500ms

---

## Phase 5: Full Agent Integration + MCP Gateway

**Duration:** 3-4 weeks
**Goal:** Wire everything together and add MCP support.

### Components

1. **`server.py`** — FastAPI application
   - Exposes all agent endpoints
   - Manages agent sessions
   - Handles SSE streaming

2. **`context/manager.py`** — Context management
   - Composes agent-specific context
   - Manages conversation history
   - Tracks task state

3. **`routing/model_router.py`** — Model selection
   - Selects provider/model per task
   - Tracks token usage
   - Handles fallbacks

4. **`mcp/gateway.py`** — MCP server management
   - Discovers MCP servers
   - Maps MCP tools to AURA capabilities
   - Enforces security policies
   - Proxies tool calls through Fabric

### Dependencies

- All previous phases
- MCP Python SDK
- Existing provider system

### Testing

- System tests: full agent with real service
- Integration tests: MCP server connectivity
- Test cases:
  - Full intent → plan → compile → execute → verify flow
  - MCP tool discovery and execution
  - Multi-provider fallback
  - Session persistence across restarts
  - Background task management

### Exit Criteria

- [ ] Full agent handles end-to-end scenarios
- [ ] MCP gateway discovers and executes tools
- [ ] Session persistence works correctly
- [ ] Performance: full flow < 10s for simple tasks
- [ ] Verification script passes: `node scripts/central-agent-verify.mjs`

---

## Phase 6+: Future Phases (Not in Initial Scope)

These are documented for planning but NOT part of the initial implementation:

### Phase 6: Memory + Learning
- User preference learning
- Workflow template generation from patterns
- Decision outcome tracking

### Phase 7: Background Autonomy
- Scheduled task management
- Event-driven automation
- Long-running task persistence

### Phase 8: Browser Agent
- Playwright integration
- Screenshot-based reasoning
- DOM interaction through Fabric

### Phase 9: Code Agent
- Repository inspection
- File editing through Fabric
- Test execution and iteration

### Phase 10: Multi-Agent Coordination
- Specialized agent configurations
- Parallel execution coordination
- Shared evidence and context

---

## Risk Mitigation

| Risk | Mitigation | Phase |
| --- | --- | --- |
| Intent misinterpretation | Confirmation before execution for ambiguous intents | 1 |
| Workflow compilation errors | Strict validation against manifest | 3 |
| Token budget exhaustion | Budget tracking, graceful degradation | 2 |
| Provider failures | Fallback providers, graceful degradation | 5 |
| Scope creep | Fabric enforcement, floors, audit | All |
| Complexity growth | Strict boundaries, single authority | All |

---

## Success Metrics

| Metric | Target | Measurement |
| --- | --- | --- |
| Intent classification accuracy | > 90% | Test suite |
| Workflow compilation success rate | > 80% | Test suite |
| End-to-end completion rate | > 70% | System tests |
| Average response time (simple) | < 5s | Performance tests |
| Average response time (complex) | < 30s | Performance tests |
| Audit trail completeness | 100% | Verification script |
| Floor enforcement | 100% | Security tests |

---

## Dependencies on Existing Codebase

| Existing Component | Dependency Type | Risk |
| --- | --- | --- |
| Capability Fabric | Core dependency | LOW — stable, well-tested |
| Policy Engine | Core dependency | LOW — stable, well-tested |
| Workflow Engine | Core dependency | LOW — stable, well-tested |
| Context Fabric | Read dependency | LOW — stable, read-only |
| AI Providers | Service dependency | MEDIUM — may need Python adapters |
| Connected Environment | Read dependency | LOW — stable, read-only |
| NODE_SPECS | Reference dependency | LOW — stable, well-defined |
| CAPABILITY_MANIFEST | Reference dependency | LOW — stable, well-defined |
| Authority Envelope | Logic dependency | LOW — stable, well-tested |
| Automation Engine | Integration dependency | MEDIUM — may need API changes |
| Mission System | Optional dependency | LOW — not required for MVP |

---

## Estimated Timeline

| Phase | Duration | Cumulative |
| --- | --- | --- |
| Phase 0: Architecture + Contracts | 1-2 weeks | 1-2 weeks |
| Phase 1: Intent Compiler | 2-3 weeks | 3-5 weeks |
| Phase 2: Task Planner | 2-3 weeks | 5-8 weeks |
| Phase 3: Workflow Compiler | 3-4 weeks | 8-12 weeks |
| Phase 4: Execution + Verification | 2-3 weeks | 10-15 weeks |
| Phase 5: Integration + MCP | 3-4 weeks | 13-19 weeks |
| **Total (MVP)** | **13-19 weeks** | |

**MVP Definition:** Phases 0-5 produce a working Central Agent that can:
1. Accept natural language intent
2. Decompose into tasks
3. Compile workflows
4. Execute through the Capability Fabric
5. Verify outcomes
6. Report with evidence

This proves the architecture and can be incrementally expanded.
