# AURA Agent — Security Threat Model

> **Status:** PROPOSED — awaiting review
>
> This document performs a full threat model for the AURA Central Agent,
> covering every attack surface introduced or extended by the agent layer.
> For each threat: the attack, impact, mitigation, which AURA component it
> targets, and how it is tested.

---

## 1. Security Principles

### 1.1 Inherited from AURA Hub

These invariants are non-negotiable (from Master Handoff §3):

1. **One policy engine** — no second authority
2. **One execution authority** — every effect through `fabric.invoke()`
3. **Three disjoint binary allow-lists** — never merged
4. **Node governance is deny-only** — no configuration lowers floors
5. **The renderer cannot execute** — six IPC commands, no shell
6. **Named, not located** — resolvers reject path-like inputs

### 1.2 New Principles (for the Central Agent)

7. **The Agent reasons; it does not execute.** No side effects without Fabric.
8. **AI-generated content is untrusted.** Workflows, tool configs, and
   descriptions from models are validated, never trusted.
9. **Authority never silently increases.** The Agent cannot accumulate
   permissions through repeated invocations.
10. **Evidence is mandatory.** Every Agent action produces audit records.
11. **Floors are absolute.** No component, including the Agent, can lower them.

---

## 2. Threat Catalogue

### 2.1 Prompt Injection

| Field | Detail |
| --- | --- |
| **ATTACK** | Malicious text in project files, tool outputs, or user input tricks the Agent into performing unintended actions. |
| **IMPACT** | Agent performs actions outside user intent. Could write files, execute commands, or access credentials. |
| **MITIGATION** | (1) Tool output is fenced as `<untrusted-data>` in agent transcripts. (2) The Agent's tool set is fixed before the first token — injected text cannot expand it. (3) Every tool call still goes through Fabric policy. (4) Floors cannot be bypassed by any prompt. |
| **AURA COMPONENT** | `workflow/agent/loop.ts` (existing `<untrusted-data>` fence), `capability-fabric/src/policy.ts` (floors) |
| **TEST** | Inject malicious instructions into tool output. Verify Agent does not execute them. Verify Fabric still evaluates policy. |

### 2.2 Tool Poisoning

| Field | Detail |
| --- | --- |
| **ATTACK** | An MCP server or external tool provides a description that contains hidden instructions, causing the model to call the tool with dangerous arguments. |
| **IMPACT** | Agent calls a tool with unintended arguments. Could exfiltrate data or perform unauthorized actions. |
| **MITIGATION** | (1) MCP tool descriptions are treated as UNTRUSTED at the protocol level. (2) Tool descriptions are validated against schema — extra fields are dropped. (3) The Agent's tool set is resolved from the Fabric manifest, not from server descriptions. (4) Every call goes through policy evaluation. |
| **AURA COMPONENT** | `mcp/gateway.py` (new), `capability-fabric/src/policy.ts` (existing) |
| **TEST** | Supply MCP tool with poisoned description. Verify description is treated as untrusted. Verify policy still evaluates correctly. |

### 2.3 Confused Deputy

| Field | Detail |
| --- | --- |
| **ATTACK** | The Agent is tricked into using a high-privilege capability when it should use a low-privilege one. For example, using `terminal.execute` to run `rm -rf` when the user asked to "clean up temporary files." |
| **IMPACT** | Destructive action performed under the guise of a benign request. |
| **MITIGATION** | (1) The Agent's task planner maps intents to specific capabilities — it does not select arbitrary tools. (2) Each capability has a fixed risk level in the manifest. (3) High-risk capabilities require approval. (4) The `irreversible-floor` and `destructive-floor` cannot be bypassed. |
| **AURA COMPONENT** | `intent/compiler.py` (new), `capability-fabric/src/manifest.ts` (existing), `policy.ts` (floors) |
| **TEST** | Give Agent a benign request that could be misinterpreted. Verify it selects the correct low-risk capability. Verify high-risk alternatives require approval. |

### 2.4 Credential Theft

| Field | Detail |
| --- | --- |
| **ATTACK** | The Agent or an MCP server accesses API keys, tokens, or passwords and exfiltrates them through tool outputs or network calls. |
| **IMPACT** | Credentials exposed. Account compromise. |
| **MITIGATION** | (1) Credentials are stored in `providers.json` with AES-256-GCM encryption. (2) `SecretStore.redactor()` scrubs known secrets from all recorded text. (3) The Agent never sees raw credentials — `{{secret:NAME}}` is resolved at the Fabric boundary only. (4) Audit records redact secret values. (5) MCP servers have no access to the credential store. |
| **AURA COMPONENT** | `secrets.ts` (existing), `workflow/governor.ts` (existing redaction), `capability-fabric/src/fabric.ts` (existing `summarizeInput`) |
| **TEST** | Verify credentials never appear in audit records, agent traces, or MCP responses. Verify `redactor()` scrubs all known secrets. |

### 2.5 Data Exfiltration

| Field | Detail |
| --- | --- |
| **ATTACK** | The Agent or an MCP server sends project data, code, or user information to an external server without authorization. |
| **IMPACT** | Intellectual property leaked. Privacy violation. |
| **MITIGATION** | (1) Network access requires `network.outbound` permission. (2) MCP servers run through the Fabric — policy evaluates network calls. (3) `http-request` nodes have URL validation and host tracking in the authority envelope. (4) The envelope reports which hosts a workflow can reach. (5) Unknown hosts trigger approval. |
| **AURA COMPONENT** | `workflow/envelope.ts` (existing host tracking), `policy.ts` (network.outbound), `capability-fabric/src/types.ts` (PermissionScope) |
| **TEST** | Attempt to exfiltrate data through MCP server response. Verify network policy blocks unauthorized hosts. Verify envelope reports dynamic hosts. |

### 2.6 Arbitrary Tool Invocation

| Field | Detail |
| --- | --- |
| **ATTACK** | The Agent or an injected prompt calls a tool that was not part of the planned task, or calls a tool with arguments that perform a different action than intended. |
| **IMPACT** | Unintended side effects. Could modify files, execute commands, or access resources. |
| **MITIGATION** | (1) The Agent's tool set is fixed at session start — it cannot expand during execution. (2) Unknown tool names become refusal beats, not calls. (3) Every tool call goes through Fabric validation (input schema check). (4) Arguments are validated against the capability's input schema. (5) The audit trail records every invocation with its arguments. |
| **AURA COMPONENT** | `workflow/agent/loop.ts` (existing `allowedSet`), `capability-fabric/src/fabric.ts` (existing `validate`) |
| **TEST** | Inject tool name into model output that is not in the allowed set. Verify it becomes a refusal. Verify unknown tool names never reach `fabric.invoke()`. |

### 2.7 Privilege Escalation

| Field | Detail |
| --- | --- |
| **ATTACK** | The Agent accumulates permissions across multiple invocations, effectively gaining more authority than any single invocation would grant. |
| **IMPACT** | Agent can perform actions that individually would require approval. |
| **MITIGATION** | (1) `approvedCapabilities` is per-invocation, not per-session. (2) Each invocation is evaluated independently by the policy engine. (3) Floors are checked on every invocation. (4) The `stricter()` function only escalates, never weakens. (5) Approval is single-use — consumed on execution. |
| **AURA COMPONENT** | `capability-fabric/src/fabric.ts` (existing per-invocation evaluation), `policy.ts` (stricter) |
| **TEST** | Run Agent through multiple invocations. Verify each is evaluated independently. Verify no accumulated permissions. Verify floors hold on every call. |

### 2.8 Supply Chain Attacks

| Field | Detail |
| --- | --- |
| **ATTACK** | A malicious MCP server, workflow template, or plugin introduces compromised tool behavior. |
| **IMPACT** | Compromised tool behavior. Data theft. Code injection. |
| **MITIGATION** | (1) MCP servers are evaluated for trust before connection. (2) Imported workflows are validated against the manifest. (3) The authority envelope is computed and shown before execution. (4) Unknown capabilities are rejected. (5) The node catalogue is the single source of truth for what tools exist. |
| **AURA COMPONENT** | `mcp/gateway.py` (new trust evaluation), `workflow/validate.ts` (existing), `workflow/envelope.ts` (existing) |
| **TEST** | Import a workflow with unknown capabilities. Verify validation rejects it. Connect an untrusted MCP server. Verify tools are high-risk by default. |

### 2.9 Agent Self-Authorization

| Field | Detail |
| --- | --- |
| **ATTACK** | The Agent attempts to approve its own actions, bypassing the human approval gate. |
| **IMPACT** | High-risk actions executed without human consent. |
| **MITIGATION** | (1) The Agent never carries a per-invocation authorization — it always parks on `awaiting-approval`. (2) `requestApproval` is implemented by the host (UI), not by the Agent. (3) The Agent cannot call `decideApproval` — it is not in the Agent's tool set. (4) Approval is single-use and fingerprint-bound. |
| **AURA COMPONENT** | `workflow/agent/loop.ts` (existing — no `resumeApprovalId` on normal calls), `capability-fabric/src/fabric.ts` (existing `decideApproval`) |
| **TEST** | Verify Agent tool set does not include `approval.decide`. Verify Agent cannot self-approve. Verify `awaiting-approval` parks the run. |

### 2.10 Workflow Generation Attacks

| Field | Detail |
| --- | --- |
| **ATTACK** | The AI generates a workflow that contains malicious node configurations, references non-existent capabilities, or requests excessive permissions. |
| **IMPACT** | Malicious workflow executed. Excessive permissions granted. |
| **MITIGATION** | (1) Workflow validation against NODE_SPECS catches unknown node types. (2) Capability binding validation catches non-existent capabilities. (3) Authority envelope is computed and shown to the user before execution. (4) Envelope diff shows privilege creep. (5) User must approve the envelope before execution. |
| **AURA COMPONENT** | `planning/workflow_compiler.py` (new validation), `workflow/validate.ts` (existing), `workflow/envelope.ts` (existing) |
| **TEST** | Generate workflow with invalid nodes. Verify validation rejects. Generate workflow with excessive permissions. Verify envelope shows and user must approve. |

### 2.11 Session Hijacking

| Field | Detail |
| --- | --- |
| **ATTACK** | An attacker gains access to an Agent session and performs actions as the user. |
| **IMPACT** | Unauthorized actions performed under user's authority. |
| **MITIGATION** | (1) Agent sessions are local to the machine. (2) No remote session access. (3) The Tauri shell owns the service process. (4) The service listens on localhost only. (5) Session state is stored locally with filesystem permissions. |
| **AURA COMPONENT** | `ai-service/src/server.ts` (existing localhost binding), `apps/desktop/src-tauri/src/service.rs` (existing process ownership) |
| **TEST** | Verify service binds to localhost only. Verify session files have restricted permissions. |

### 2.12 Denial of Service

| Field | Detail |
| --- | --- |
| **ATTACK** | The Agent is fed an extremely complex intent that causes excessive resource consumption (tokens, time, API calls). |
| **IMPACT** | Service becomes unresponsive. User cannot interact. |
| **MITIGATION** | (1) Token budget per session (configurable). (2) Token budget per task (derived from complexity). (3) Wall clock timeout on every execution. (4) Max iterations on bounded agent. (5) Workflow execution has `MAX_NODE_EXECUTIONS` and `DEFAULT_RUN_TIMEOUT_MS`. (6) Model calls have per-request timeouts. |
| **AURA COMPONENT** | `workflow/agent/types.ts` (existing bounds), `workflow/engine.ts` (existing timeouts), `intent/compiler.py` (new budget management) |
| **TEST** | Feed Agent extremely complex intent. Verify token budget is enforced. Verify timeouts fire. Verify service remains responsive. |

### 2.13 Audit Trail Tampering

| Field | Detail |
| --- | --- |
| **ATTACK** | An attacker modifies or deletes audit records to hide malicious activity. |
| **IMPACT** | Evidence of malicious activity destroyed. Accountability lost. |
| **MITIGATION** | (1) Audit records are append-only (`AuditPersistence.append`). (2) No `save(all)` method — the store cannot be rewritten. (3) Records are persisted to disk immediately. (4) A failing store does not take down execution. (5) In-memory trail stays correct even if disk write fails. |
| **AURA COMPONENT** | `capability-fabric/src/types.ts` (existing `AuditPersistence`), `capability-fabric/src/fabric.ts` (existing `record`) |
| **TEST** | Verify audit persistence is append-only. Verify no API to rewrite trail. Verify records survive restart. |

### 2.14 Model Provider Compromise

| Field | Detail |
| --- | --- |
| **ATTACK** | A model provider returns malicious responses (compromised model, MITM attack, provider outage returning garbage). |
| **IMPACT** | Agent acts on malicious model output. Could perform unintended actions. |
| **MITIGATION** | (1) Model output is parsed and validated before execution. (2) Invalid JSON becomes a retry, not an execution. (3) Unknown tool names become refusals. (4) The Fabric still evaluates policy on every tool call. (5) Provider health monitoring detects anomalies. (6) Fallback providers available. |
| **AURA COMPONENT** | `workflow/agent/loop.ts` (existing `parseStep` validation), `provider/registry.ts` (existing health monitoring) |
| **TEST** | Return malicious model output. Verify parsing catches invalid JSON. Verify unknown tool names are refused. Verify Fabric still enforces policy. |

---

## 3. Defense in Depth

The security model relies on multiple layers, not any single control:

```
Layer 1: Intent Validation
  └── Intent compiler validates user input
  └── Constraints from Context Fabric applied

Layer 2: Task Planning
  └── Task planner maps to specific capabilities
  └── Cannot select arbitrary tools

Layer 3: Capability Validation
  └── Manifest validation catches unknown capabilities
  └── Input schema validation catches bad arguments

Layer 4: Authority Envelope
  └── Computed before execution
  └── Shown to user for approval

Layer 5: Policy Evaluation
  └── Floors enforced on every invocation
  └── Node governance deny-only
  └── `stricter()` only escalates

Layer 6: Approval Gates
  └── High-risk actions require human decision
  └── Single-use, fingerprint-bound

Layer 7: Execution
  └── Through Capability Fabric only
  └── No bypass path

Layer 8: Verification
  └── Outcome checked against expectation
  └── Unverified results reported honestly

Layer 9: Audit Trail
  └── Every invocation recorded
  └── Append-only, immutable
  └── Survives restart

Layer 10: Evidence
  └── User sees what happened
  └── With proof, not claims
```

---

## 4. Security Testing Plan

### 4.1 Unit Tests

| Test | What It Verifies |
| --- | --- |
| `test_prompt_injection_blocked` | Injected instructions in tool output do not become actions |
| `test_tool_poisoning_descriptions_ignored` | MCP tool descriptions treated as untrusted |
| `test_unknown_tool_refused` | Tool names outside allowed set become refusals |
| `test_floor_enforcement` | Irreversible actions always require approval |
| `test_approval_single_use` | Consumed approval cannot be reused |
| `test_fingerprint_mismatch_rejected` | Modified arguments fail fingerprint check |
| `test_audit_append_only` | No API to rewrite audit trail |
| `test_secret_redaction` | Credentials never in audit records |
| `test_session_isolation` | Sessions cannot access each other |
| `test_budget_enforcement` | Token and time budgets enforced |

### 4.2 Integration Tests

| Test | What It Verifies |
| --- | --- |
| `test_e2e_approval_flow` | Agent requests approval → user decides → execution proceeds or stops |
| `test_e2e_malicious_mcp_server` | Untrusted MCP server tools are high-risk |
| `test_e2e_workflow_validation` | Generated workflows validated before execution |
| `test_e2e_envelope_honesty` | Envelope accurately reflects workflow capabilities |
| `test_e2e_audit_completeness` | Every invocation has an audit record |

### 4.3 Security Audit Checklist

- [ ] All tool calls go through `fabric.invoke()`
- [ ] No bypass path exists around the policy engine
- [ ] Floors cannot be lowered by any configuration
- [ ] Agent cannot approve its own actions
- [ ] Credentials never appear in logs, audit, or agent traces
- [ ] MCP tool descriptions are treated as untrusted
- [ ] Generated workflows are validated before execution
- [ ] Authority envelope is computed and shown before execution
- [ ] Approval is single-use and fingerprint-bound
- [ ] Audit trail is append-only and survives restart
- [ ] Session state is local and filesystem-protected
- [ ] Service binds to localhost only
- [ ] Token budgets are enforced
- [ ] Timeouts fire on all long-running operations
- [ ] Model output is parsed and validated before execution
