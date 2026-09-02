# AURA Agent — MCP + Plugin Interoperability Research

> **Status:** RESEARCH COMPLETE — NOT IMPLEMENTED
>
> This document researches the Model Context Protocol (MCP), Claude Code's
> extension architecture, and how AURA can interoperate with external tool
> ecosystems while maintaining its security model.

---

## 1. MCP Specification (2026-07-28)

### 1.1 Architecture

MCP uses a client-server architecture over JSON-RPC 2.0:

```
Host (LLM application)
  │
  ├── Client 1 ──► MCP Server A (tools, resources, prompts)
  ├── Client 2 ──► MCP Server B (tools, resources, prompts)
  └── Client N ──► MCP Server N
```

**Key components:**
- **Host:** The LLM application (e.g., Claude Desktop, AURA Hub)
- **Client:** Connector within the host, manages one server connection
- **Server:** Provides tools, resources, and prompts to the client

**Transport:**
- Local: stdio (process-based)
- Remote: HTTP with SSE (stateless as of 2026-07-28)

**Features servers offer:**
- **Tools:** Functions the AI model can execute
- **Resources:** Context and data for the user or model
- **Prompts:** Templated messages and workflows

**Features clients offer:**
- **Elicitation:** Server-initiated requests for user information

### 1.2 Security Model

MCP's security principles (from specification):
- User consent for all data access and operations
- User control over data sharing and actions
- Tool descriptions are UNTRUSTED unless from a trusted server
- Hosts must obtain consent before invoking tools

**Critical gap:** MCP does not enforce security at the protocol level.
Implementors must build their own consent and authorization flows.

### 1.3 MCP Extensions

Beyond the core protocol, MCP defines optional extensions:
- **Tasks:** Async long-running operations with polling and durable handles
- **Skills over MCP:** Structured instructions for agent workflows
- **MCP Apps:** Interactive UI elements rendered inline

### 1.4 MCP Security Vulnerabilities (Research)

Recent research (2025-2026) has identified critical vulnerabilities:

1. **Tool Poisoning (CVE-2025-54136):** Malicious instructions embedded
   in tool metadata. Average attack success rate: 36%.
2. **Prompt Injection via Sampling:** Server-initiated sampling can inject
   prompts that bypass host controls.
3. **Confused Deputy:** Tool descriptions can trick the model into calling
   tools with elevated privileges.
4. **Data Exfiltration:** Malicious servers can extract data through tool
   responses.
5. **Supply Chain Attacks:** Malicious MCP servers in package registries.

**Key finding:** Tool descriptions must be treated as UNTRUSTED data, never
as instructions. This aligns with AURA's existing `<untrusted-data>` fence
in the bounded agent.

---

## 2. AURA's Existing Tool System

### 2.1 Current Architecture

AURA already has a sophisticated tool system:

```
Capability Descriptor (CAPABILITY_MANIFEST)
  │
  ├── id, name, description, risk, permissions
  ├── input schema (CapabilityField[])
  ├── surface (aura-internal, local-process, http, browser)
  ├── verify kind (read-back, exit-code, http-status, null)
  └── requiresNodeCapability (optional)

Executor Registry (fabric.executors)
  │
  ├── Maps capabilityId → Executor
  ├── Executor.supportsNode(node) — can it drive this node?
  ├── Executor.run(invocation) → ExecutorResult
  └── Executor.verify(invocation, result) → VerificationReport

Node Catalogue (connected-environment)
  │
  ├── CATALOG — every known node
  ├── probeNode(id) — is it present?
  └── Provided capabilities → routing resolution
```

### 2.2 How MCP Maps to AURA

| MCP Concept | AURA Equivalent | Gap |
| --- | --- | --- |
| **Tool** | `CapabilityDescriptor` + `Executor` | MCP tools need capability mapping |
| **Resource** | `ContextFabric` sections | MCP resources need freshness tracking |
| **Prompt** | Workflow templates | MCP prompts need validation |
| **Server** | Connected Environment node | MCP servers need trust evaluation |
| **Client** | AURA Service | AURA acts as MCP client |
| **Transport** | HTTP (existing) | MCP uses JSON-RPC over HTTP |

### 2.3 What AURA Already Does Better

1. **Policy enforcement:** AURA evaluates policy BEFORE execution. MCP
   relies on the host to do this.
2. **Approval system:** AURA has explicit human gates. MCP has consent
   principles but no enforcement mechanism.
3. **Audit trail:** AURA records every invocation. MCP has no audit trail.
4. **Verification:** AURA verifies outcomes. MCP has no verification.
5. **Node routing:** AURA resolves which node performs. MCP assumes the
   server is the performer.
6. **Authority envelopes:** AURA computes what a workflow can do before
   execution. MCP has no equivalent.

---

## 3. AURA as MCP Client

### 3.1 Architecture

```
AURA Central Agent
  │
  ├── MCP Client 1 ──► MCP Server A (e.g., GitHub)
  ├── MCP Client 2 ──► MCP Server B (e.g., database)
  └── MCP Client N ──► MCP Server N
```

**How it works:**
1. AURA discovers available MCP servers (config + discovery)
2. For each server, AURA creates an MCP client
3. The client lists available tools from the server
4. Each MCP tool is mapped to an AURA capability descriptor
5. When the agent wants to use an MCP tool, it goes through the Fabric

### 3.2 MCP Tool → AURA Capability Mapping

```python
class McpToolMapper:
    """Maps MCP tool definitions to AURA capability descriptors."""
    
    def map_tool(self, mcp_tool: McpTool, server_id: str) -> CapabilityDescriptor:
        """
        Mapping rules:
        1. id: "mcp.{server_id}.{tool_name}"
        2. name: MCP tool name
        3. description: MCP tool description
        4. risk: Derived from tool annotations + server trust level
        5. permissions: Derived from tool description analysis
        6. surface: 'http' (MCP is HTTP-based)
        7. requiresNodeCapability: "mcp-server:{server_id}"
        """
        ...
    
    def derive_risk(self, tool: McpTool, server_trust: TrustLevel) -> RiskLevel:
        """
        Risk derivation:
        - Known server + read-only tool → low
        - Known server + write tool → medium
        - Unknown server → high
        - Tool with side effects → high
        - Tool accessing credentials → high
        """
        ...
    
    def derive_permissions(self, tool: McpTool) -> PermissionScope[]:
        """
        Permission derivation from tool description:
        - File operations → project.write
        - Shell commands → process.execute
        - API calls → network.outbound
        - Database operations → project.write
        - Credential access → account.authorize
        """
        ...
```

### 3.3 MCP Tool Execution Through Fabric

```
Agent wants to use MCP tool "github.create_issue"
    │
    ▼
MCP Client calls server's tool
    │
    ▼
Tool result returned to MCP Client
    │
    ▼
MCP Client wraps result as CapabilityResult
    │
    ▼
Fabric evaluates policy (risk, permissions, floors)
    │
    ▼
If approval needed → park and wait
    │
    ▼
Executor calls MCP server's tool
    │
    ▼
Result verified (if verification kind set)
    │
    ▼
Audit record written
    │
    ▼
Evidence attached to execution
```

**Key insight:** The MCP tool call is wrapped in a Fabric invocation. This
means policy, approval, verification, and audit all apply to MCP tools
exactly as they apply to AURA's native tools.

### 3.4 MCP Server Trust Evaluation

```python
class McpServerTrust:
    """Evaluates trust level for an MCP server."""
    
    def evaluate(self, server: McpServer) -> TrustLevel:
        """
        Trust levels:
        - verified: AURA has verified this server's behavior
        - known: Server is in a known registry, not yet verified
        - unknown: Server is not in any registry
        - untrusted: Server has been flagged
        
        Trust affects:
        - Risk derivation for tools
        - Approval requirements
        - Audit detail level
        - Tool description trust (always untrusted at protocol level)
        """
        ...
```

---

## 4. AURA as MCP Server

### 4.1 Should AURA Expose Tools via MCP?

**Research finding: Yes, but with strict controls.**

AURA should expose a subset of its capabilities as MCP tools so that
external MCP clients (Claude Desktop, other AI tools) can use AURA's
governed execution.

### 4.2 Exposed Tools

| AURA Capability | MCP Tool | Risk | Notes |
| --- | --- | --- | --- |
| `project.read` | `aura.read_project` | low | Read-only, safe |
| `context.view` | `aura.get_context` | low | Read-only, safe |
| `git.status` | `aura.git_status` | low | Read-only, safe |
| `git.diff` | `aura.git_diff` | low | Read-only, safe |
| `terminal.execute` | `aura.run_command` | medium | Governed, approval may be needed |
| `filesystem.write` | `aura.write_file` | medium | Governed, approval may be needed |

### 4.3 What AURA Should NOT Expose via MCP

- `agent.delegate` — coding agent delegation is too powerful for external clients
- `system.install` — system-floor, must go through AURA's own UI
- `provider.connect` — credential management is internal
- Any capability on a security floor — must go through AURA's approval UI

### 4.4 MCP Server Security

```
External MCP Client
    │
    ▼
AURA MCP Server
    │
    ├── Rate limiting
    ├── Authentication (API key)
    ├── Tool allowlist (only safe tools)
    ├── Policy evaluation (same engine)
    ├── Approval gates (same system)
    ├── Audit trail (same records)
    └── Verification (same system)
```

---

## 5. Claude Code Interoperability

### 5.1 Claude Code Architecture (Research)

Claude Code provides several extension mechanisms:

| Mechanism | What It Is | AURA Compatibility |
| --- | --- | --- |
| **MCP Servers** | External tool providers via MCP protocol | COMPATIBLE — AURA can act as client or server |
| **Tools** | Built-in capabilities (file, shell, browser) | PARTIAL — AURA has governed equivalents |
| **Skills** | Reusable instruction sets | COMPATIBLE — AURA can consume as MCP resources |
| **Commands** | Slash-command shortcuts | NOT DIRECTLY — AURA has its own UI |
| **Hooks** | Pre/post execution hooks | NOT DIRECTLY — Different execution model |
| **Agents** | Sub-agent spawning | COMPATIBLE — AURA has bounded agents |
| **Provider Extensions** | Model-specific features | NOT DIRECTLY — AURA abstracts providers |

### 5.2 What AURA Can Directly Support

1. **MCP Servers:** AURA can connect to any MCP server as a client. The
   MCP protocol is standardized and AURA's HTTP infrastructure supports it.

2. **MCP Resources:** AURA can consume MCP resources for context. The
   Context Fabric can incorporate MCP resource data.

3. **MCP Prompts:** AURA can use MCP prompts as templates. The workflow
   compiler can incorporate MCP prompt structures.

### 5.3 What AURA Can Wrap

1. **Claude Code Tools:** AURA can wrap Claude Code's built-in tools
   (file, shell, browser) as governed capabilities. Each tool call goes
   through the Fabric.

2. **Claude Code Skills:** AURA can consume Claude Code skills as MCP
   resources. The intent compiler can reference skill knowledge.

### 5.4 What Cannot Be Ported

1. **Claude Code's UI:** Different architecture (terminal vs desktop).
2. **Claude Code's hooks:** Different execution model.
3. **Claude Code's provider extensions:** AURA abstracts providers.

### 5.5 AURA Plugin Gateway Architecture

```
AURA Plugin Gateway
    │
    ├──► MCP Gateway (MCP servers, resources, prompts)
    │         │
    │         ├── AURA MCP Servers (internal)
    │         ├── External MCP Servers (third-party)
    │         └── Claude Code MCP Servers (compatible)
    │
    ├──► AURA Skills (reusable instruction sets)
    │         │
    │         ├── Built-in skills
    │         └── Community skills (from npx skills)
    │
    └──► External Adapters (provider-specific)
              │
              ├── Claude Code adapter (tool wrapping)
              ├── OpenAI tool adapter (function calling)
              └── Custom adapters
```

---

## 6. Compatibility Matrix

| System | Protocol | What It Provides | AURA Compatibility | Adapter Required? | Security Risk | Auth Model | Execution Model |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **MCP (core)** | JSON-RPC 2.0 | Tools, resources, prompts | HIGH | No (native) | MEDIUM | Token-based | Request-response |
| **MCP (Tasks)** | JSON-RPC 2.0 | Async long-running ops | HIGH | No (native) | MEDIUM | Token-based | Polling |
| **MCP (Skills)** | JSON-RPC 2.0 | Structured instructions | HIGH | No (native) | LOW | Token-based | Read-only |
| **Claude Code MCP** | JSON-RPC 2.0 | Tools, resources | HIGH | No (MCP compatible) | MEDIUM | Token-based | Request-response |
| **Claude Code Skills** | Markdown files | Reusable instructions | MEDIUM | Parser adapter | LOW | File-based | Read-only |
| **Claude Code Plugins** | Provider-specific | Extensions | LOW | Full adapter | HIGH | Varies | Varies |
| **OpenAI Tools** | HTTP REST | Function calling | MEDIUM | Schema mapper | MEDIUM | API key | Request-response |
| **Browser Tools** | Playwright/CDP | Browser automation | HIGH | Already planned | HIGH | N/A | Async |
| **Coding Agent Tools** | Process spawn | Code editing | HIGH | Already implemented | HIGH | N/A | Process-based |

---

## 7. MCP Security Design for AURA

### 7.1 The Fundamental Rule

**MCP tool ≠ automatic authority.**

Every MCP tool call goes through:
```
MCP Tool Request
    │
    ▼
AURA Capability Mapping
    │  - Maps MCP tool to AURA capability
    │  - Derives risk level
    │  - Derives required permissions
    ▼
Policy Evaluation
    │  - Checks against floors
    │  - Checks against overrides
    │  - Checks against node governance
    ▼
Approval (if required)
    │  - Human sees the MCP tool call
    │  - Human grants or denies
    ▼
Execution
    │  - MCP client calls the server
    │  - Result captured
    ▼
Verification
    │  - Outcome checked
    ▼
Audit
    - Full record written
```

### 7.2 MCP-Specific Threats

| Threat | Mitigation |
| --- | --- |
| Malicious MCP server | Trust evaluation, sandboxed execution |
| Tool description poisoning | Descriptions treated as untrusted data |
| Prompt injection via tool response | `<untrusted-data>` fence (existing) |
| Credential theft through MCP | Secrets never in tool arguments |
| Data exfiltration | Network policy, audit trail |
| Arbitrary code execution | Fabric policy, approval gates |
| Privilege escalation | Floors enforced, deny-only governance |

### 7.3 MCP Server Sandboxing

```python
class McpSandbox:
    """Isolates MCP server execution."""
    
    def execute_tool(
        self,
        server: McpServer,
        tool_name: str,
        arguments: dict,
        context: InvocationContext,
    ) -> ExecutorResult:
        """
        Sandbox rules:
        1. Server runs in isolated process
        2. No filesystem access outside project root
        3. No network access except whitelisted hosts
        4. No credential access
        5. Output is redacted before returning to model
        6. All calls are audited
        """
        ...
```

---

## 8. Implementation Approach

### 8.1 MCP Client (Priority: MEDIUM)

**Phase 5 of the roadmap.**

1. Add MCP client library to the service
2. Discover and connect to configured MCP servers
3. Map MCP tools to AURA capabilities
4. Wrap MCP tool calls in Fabric invocations
5. Enforce policy and audit on MCP tools

### 8.2 MCP Server (Priority: LOW)

**Future phase, after the agent is stable.**

1. Expose a subset of AURA capabilities as MCP tools
2. Add authentication and rate limiting
3. Enforce the same policy and audit as internal tools
4. Document the API for external consumers

### 8.3 Plugin Gateway (Priority: LOW)

**Future phase, after MCP is stable.**

1. Build the gateway architecture
2. Add Claude Code skill adapter
3. Add community skill discovery (npx skills)
4. Add custom adapter framework

---

## 9. Research Sources

| Source | Status | Key Finding |
| --- | --- | --- |
| MCP Specification 2026-07-28 | VERIFIED | Stateless core, extensions for tasks/skills/apps |
| MCP Security Analysis (arxiv 2601.17549) | RESEARCHED | Three fundamental protocol-level vulnerabilities |
| MCP Threat Modeling (MDPI 2026) | RESEARCHED | Tool poisoning is most prevalent attack |
| MCP Tool Poisoning (CVE-2025-54136) | RESEARCHED | 36% average attack success rate |
| CSA MCP Attack Surface (2026) | RESEARCHED | Multiple high-severity vulnerabilities |
| Palo Alto MCP Sampling Attacks | RESEARCHED | Sampling feature enables prompt injection |
| Claude Code Documentation | RESEARCHED | Extension mechanisms: MCP, skills, hooks, agents |
| AURA Hub Source Code | VERIFIED | Existing capability system, policy engine, audit trail |
