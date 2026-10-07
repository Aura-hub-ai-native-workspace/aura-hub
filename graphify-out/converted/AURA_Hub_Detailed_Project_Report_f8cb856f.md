<!-- converted from AURA_Hub_Detailed_Project_Report.docx -->





AURA HUB
AI-Native Engineering Workspace

DETAILED PROJECT REPORT
Project Version 0.1.19  ·  Status: STABLE ALPHA  ·  Documentation set: repository snapshot, October 2026

Submitted in partial fulfilment of the academic project requirements
Student Name: ____________________________
Department: ____________________________
College: ____________________________
Team: ____________________________
Academic Year: ____________________________
Project Guide: ____________________________
Date: ____________________________
Table of Contents

Page numbers refer to the printed pagination of this report (footer of each page).

# 1. Executive Summary
AURA Hub is a desktop application in which a student or engineer instructs an AI coordinator — Ask AURA — in plain language. AURA carries out engineering tasks by combining its own deterministic workflow engine, a curated knowledge base of the user's project, a live map of the user's machine, and a set of strictly governed external AI services and coding-agent tools. The system runs on the user's own computer and uses the user's own API keys; no AURA hosted service and no AURA account is required.
Scope of this document. The current release contains, and this report documents:
- Desktop application React 18 + TypeScript 5 + Vite 5 inside a Tauri v2 (Rust) native shell for Windows, macOS and Linux.
- Local service backend Python 3.12 Starlette server exposing a complete HTTP/SSE API for workflows, agent sessions, providers, automation, environment scanning, and knowledge.
- Workflow engine 18 node types with checkpointing, replay, approval parking, a governor and output redaction.
- Automation studio 8 event trigger types plus a 5-field cron scheduler across 6 bundled templates.
- Knowledge base document ingestion, chunking, BM25 retrieval, per-project knowledge graph, optional local embeddings.
- Machine environment catalog probes, PATH discovery, provenance and a 13-state verification status for every tool it finds.
- Provider integrations 11 AI providers under a single adapter contract, with AES-256-GCM key storage.
- Agent adapters 9 configuration adapters for installed coding agents (Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode, Aider, Kilo, Crush, Continue).
- Governance permission tiers, a capability manifest with risk levels, a network allowlist, secrets vaulting and audit trails.
The project is at version 0.1.19 and is labelled STABLE ALPHA: the implemented feature set is complete and internally consistent, and the system is suitable for demonstrations, coursework and supervised use. It is not positioned for production deployment.


# 2. Problem Statement
Modern engineering assistance is fragmented across tools that do not share context, and the tools that are powerful are hard to trust. Four concrete problems define the space AURA Hub operates in:
- Fragmentation. A developer chats in one AI window, runs shell commands in another, reads project documents in a third, and re-explains the same context to each tool.
- Context loss. Project knowledge lives in PDFs, wikis and individual heads; generic AI assistants have none of it, so answers are generic.
- Trust deficit. AI tools that execute commands and edit files rarely expose clear permission tiers, approval gates or audit trails, which makes them difficult to recommend in academic and enterprise settings.
- Lock-in. Most assistants bind the user to one vendor's model and one billing relationship, and they stop working when the network, the quota or the vendor changes.
AURA Hub addresses these four problems with a local-first workspace: one application holds the conversation, the workflows, the knowledge and the machine map, and every privileged action passes through an explicit governance layer.

# 3. Objectives
- SO-1. Provide a single desktop workspace that unifies conversation, workflows, knowledge, automation and environment awareness.
- SO-2. Implement a deterministic workflow engine whose executions are checkpointed, resumable, replayable and fully traceable.
- SO-3. Let the user choose any major AI provider through a bring-your-own-API-key model without vendor lock-in.
- SO-4. Govern every privileged operation through permission tiers, a risk-rated capability manifest and a network allowlist.
- SO-5. Keep all project data local — persistence is file-based and secrets are encrypted with AES-256-GCM.
- SO-6. Make the machine itself a first-class object: scan, verify and report the toolchains actually installed.
- SO-7. Expose the entire system through a documented HTTP/SSE API so scripts, tests and external tools can automate it.

# 4. Scope of the Project
The table states what the current implementation covers and what it deliberately does not cover.



# 5. System Overview
AURA Hub is organised as a layered system. The presentation layer is a React desktop application inside a Tauri native shell. The service layer is a local Python process that owns all logic: conversational mission control, workflow execution, automation, knowledge, environment scanning and governance. The integration layer connects the service to external AI providers and to installed coding-agent command-line tools, always through governed adapters. The persistence layer stores projects, workflows, runs, nodes, automation rules and missions as versioned JSON documents on the local disk.
A distinguishing property of the architecture is that the intelligence is orchestration, not a monolith: Ask AURA plans and delegates, the workflow engine executes deterministically, and governance decides what may run — in that order, on every request.

Figure 1: System architecture blueprint as documented in the repository (docs/assets/screenshots).

# 6. System Architecture
The repository is an npm-workspaces monorepo. The desktop application and the Python service are independently runnable and communicate over local HTTP and Server-Sent Events.

Data at rest is file-based: JSON stores under the backend manage projects, workflows (byte-parity with the TypeScript schema), workflow versions, runs, nodes, automation rules and missions. Workflow executions write checkpoint files, so a run survives a restart and can be replayed or resumed from its last completed node.

Figure 2: Project dashboard inside the desktop shell.

# 7. Functional Description
The following capabilities exist and operate in the current implementation; each is traceable to the module shown.


# 8. Ask AURA — Conversational Mission Control
Ask AURA is the conversational core of the product. A session accepts a natural-language objective; the planner compiles it into an intent and a plan; workers (installed coding-agent CLIs and built-in tools) execute the steps; and every step that touches the system in a privileged way stops at an approval gate until the user allows it. Sessions support submit, message, approve, resume, cancel, evidence retrieval and plan inspection over the HTTP API.
- Intent compilation. The central agent compiles user intent using a heuristic mode by default and a model-assisted mode when a provider is connected; routing runs over an OpenAI-compatible wire protocol.
- Worker delegation. The planner fans work out to governed workers; delegation itself is a capability in the manifest and is subject to the same policy tiers as any other operation.
- Approval gates. The approval ledger records what was requested, what was approved, when, and with what evidence; a run parked at an approval is resumable later.
- Evidence trail. Each session keeps tool traces and evidence artifacts that the UI renders next to the conversation.
- Web research and attachments. A per-request web-research toggle and document attachments (ingested into the knowledge base) are available from the composer.
- Handoffs. A handoff inbox records worker-to-worker transfers so the user sees who owns which step.

Figure 3: An Ask AURA session with tool trace, approvals and evidence.

Figure 4: Mission control view over delegated work.

# 9. Workspace & User Experience
The desktop shell boots through a guided sequence, gates first use on onboarding and provider connection, and persists sessions across restarts. A command palette (Ctrl/Cmd-K) and a window switcher (Ctrl/Cmd-Shift-K) give keyboard access to every screen; the window manager opens floating windows for secondary tools. Dedicated centres exist for agent status, memory and notifications.
Primary screens:
- Home — application entry point and project selector.
- Knowledge workspace — sources, ingestion and retrieval.
- Engineering dashboard and engineering twin — machine and project state.
- Workflows — authoring, versions, runs, dry runs.
- Missions — delegated objectives and their status.
- Governance — policies, capability audit, network rules.
- AI settings — providers, models, agent configurations.
The neon workspace is the operative view: AuraAgentWorkspace renders the chat timeline, approval gates, handoff inbox and tool trace; AuraComposer handles message input, document attachments and the per-request web-research toggle; LeftControlPanel and OrchestrationGraph draw the live topology — an AURA Agent centre node, six worker slots and three tool slots connected by branch connectors.

Figure 5: Floating window manager inside the workspace.

Figure 6: Command palette (Ctrl/Cmd-K) for keyboard-first navigation.

# 10. AI Provider Integration (Bring Your Own API Key)
AURA Hub integrates eleven AI providers through a single OpenAI-compatible adapter contract. The user supplies their own API key (BYOAK); keys are stored encrypted with AES-256-GCM and are never written to logs or configuration exports. Environment auto-connect recognises MISTRAL_API_KEY and CEREBRAS_API_KEY at startup. Each connection is testable and disconnectable from the AI settings screen; the default routing target is Groq (llama-3.3-70b-versatile).


Figure 7: Provider settings: connect, test and disconnect under BYOAK.

Figure 8: Connecting a Qwen provider account.

# 11. Workflow Engine & Automation
The workflow engine executes graphs node by node in deterministic order. Every completed node writes a checkpoint; executions can be dry-run, cancelled, resumed and replayed. A node that requires human consent parks in an awaiting-approval state until the user decides. A governor mediates each node against the policy engine, and a redaction pass strips secret material from outputs and logs.

The automation layer turns workflows into standing machinery. The AutomationEngine subscribes to eight trigger types — including mission-completed, file-changed, pr-merged and dependency-changed — evaluates conditions, runs chains, and exposes a run-workflow action over the API. The cron scheduler accepts standard 5-field expressions; a fire missed while the system is down is counted and reported, not silently executed. Six automation templates ship with the release.

Figure 9: Visual workflow builder: authoring, validation and versions.

Figure 10: Automation studio: triggers, conditions, chains and schedules.

# 12. Machine Environment Awareness
Before AURA promises to use a tool, it checks that the tool actually exists on the machine. The environment subsystem probes a catalog of known capabilities (12-second per-probe timeout, 8-probe concurrency, 30-second cache), walks PATH with bounded discovery (up to 60 unknown probes, 400 reported entries), and attaches provenance — npm, pip, cargo or pipx — to what it finds. Every discovered item carries one of thirteen explicit statuses, from verified through unverified, not-found, failed, timeout, blocked, tampered, internal, needs-auth and unsupported, so the UI can state exactly how confident the system is.
- Safe probes. GUI launchers are never executed; discovery is read-only.
- Inventory. Operating-system package inventory and location trust are collected alongside tool detection.
- Categories. Findings are grouped into cloud, ai, development and system classes.
- Consumer benefit. Delegation, workflows and the capability fabric all consult this live map, which is why the product can honestly say which tools it can drive on a given machine.

# 13. Orchestration & Delegation Model
Delegation is modelled as a first-class structure rather than hidden prompt plumbing. The OrchestrationGraph renders an AURA Agent centre node, six worker slots and three tool slots with branch connectors; the slots correspond to real runtime entities — worker slots bind to configured coding-agent CLIs, tool slots bind to governed capabilities such as terminal execution or knowledge search. The central agent's planner decides which worker receives which subtask; the policy engine decides whether each step runs automatically, asks the user, or is denied. Component tests cover tool-slot and worker-slot behaviour, including the add-tool flow and approval routing (Section 27).

# 14. Knowledge Base & Engineering Memory
The knowledge store turns project material into retrievable context. Documents — text, Markdown, PDF and DOCX via the optional multimodal extras — are ingested, chunked at 1500 characters with 150-character overlap, and indexed with BM25 for keyword-accurate retrieval; an optional local Ollama embedding path adds semantic search without sending data anywhere. A per-project knowledge graph links the ingested material to projects and missions.
Engineering memory complements retrieval with chronology: a memory recorder in the shell captures notable events and decisions, and the engineering-memory screen presents the project's timeline so context survives between working sessions.

Figure 11: Knowledge workspace: sources, ingestion and the project graph.

Figure 12: Engineering memory: the project's recorded timeline.

# 15. Engineering Intelligence Components
Several shared packages provide the analytical surfaces of the workspace; each is documented in docs/architecture/ and wired into the desktop shell:


# 16. Technology Stack

The application is Apache-2.0 licensed. The frontend comprises approximately 57,500 lines of TypeScript/TSX across 404 source files; the backend is a structured Python package (aura) with subsystems mirrored in the packages/ workspace. Type checking (npm run typecheck) and the frontend build are the continuous integration gates for the TypeScript side.

# 17. Data Flow & Interfaces
A representative governed execution flows as follows:
- The user submits an objective in the workspace composer; the shell opens an agent session over HTTP and streams progress over SSE.
- The central agent compiles the intent (heuristic or model-assisted) and the planner produces a plan of steps.
- Each step maps to a capability in the fabric manifest; the policy engine returns auto-execute, ask-user or deny for it.
- Ask-user steps park the session at an approval gate; the approval ledger records the decision and the evidence links.
- Approved work executes through the workflow engine or a delegated coding-agent CLI; secrets are injected as {{secret:NAME}} references and redacted from outputs.
- Network access passes the netgate allowlist before any external call leaves the machine.
- Artifacts are written by export-file nodes; state is checkpointed after every node; the run is resumable and replayable.
- The UI renders the tool trace, the orchestration graph updates its slots, and the memory recorder stores notable events.



# 18. Security, Privacy & Governance
- Local-first data. Projects, workflows, runs, knowledge and secrets remain in local files; no AURA cloud service participates in the current release.
- Key custody. Provider API keys are encrypted at rest with AES-256-GCM in the secrets store; configuration adapters name environment variables but never resolve or log them.
- Redaction. Secret material is stripped from workflow outputs and logs by an explicit redaction pass.
- Permission tiers. The policy engine classifies operations as auto-execute, ask-user or deny. Default policy: knowledge.search, document.ingest and artifact.generate run automatically; sandbox.execute and terminal.execute ask the user.
- Capability manifest. About thirty capabilities — from filesystem read/write through git push, github.create_pr and browser automation — carry explicit risk levels, required permissions and verify methods.
- Network governance. An allowlist (netgate) constrains outbound AI traffic to the configured provider domains, including openai.com, api.anthropic.com, api.mistral.ai, api.groq.com, openrouter.ai, api.cerebras.ai, api.novita.ai, inference.qwen.ai, api.kimi.ai and api.nvidia.com; enforcement compilers apply the same rules inside Claude Code and OpenCode configurations.
- Audit. Approval ledger, evidence trail and governance.audit provide after-the-fact review of what ran, when, and with what consent.

Figure 13: Governance console: policies, capability audit and network rules.

# 19. Bundled Workflow Templates
Ten importable templates ship in examples/workflows/:


# 20. Installation & Deployment

- Install workspace dependencies: npm install at the repository root.
- Start the local AI service: npm run ai (service listens on port 4319).
- Start the desktop shell: npm run tauri dev (native Tauri application).
- Connect at least one AI provider in AI Settings, or export a supported key (for example MISTRAL_API_KEY) for auto-connect.
- Verify the service: GET /health responds on the local service port.
- Optional: install backend extras for document and artifact support (multimodal, artifacts) as declared in backend/pyproject.toml.
Deployment today is source-run: the team and users launch the service and shell from a checkout. The backend test suite runs with pytest from backend/tests/.

# 21. Competitive Landscape
The table positions AURA Hub against widely used coding assistants at a general, publicly documented level. A tick indicates the capability is implemented in AURA Hub; Partial indicates a narrower form exists in the competitor; an em dash indicates no comparable widely documented capability. These are positioning statements, not benchmark results.

Differentiation that follows directly from the implementation:
- Governance is architectural, not cosmetic: policy tiers, a risk-rated capability manifest, a network allowlist and an approval ledger are separate modules with their own tests.
- The machine itself is modelled: environment scanning with provenance and explicit verification states has no direct equivalent in the compared tools.
- Deterministic execution sits beside conversation: the same objective can run as a one-off chat or as a checkpointed, resumable workflow.
- The user owns the AI relationship: eleven providers on one adapter contract with encrypted key custody.
- The workspace is extensible: any installed coding-agent CLI becomes a governed worker through configuration adapters with backup, verify and restore semantics.

# 22. Use Cases

In-class demo. Demonstration walkthrough (as shown in the screenshots):
- Open the desktop shell — the home screen and project selector appear (Figure 1 context).
- Connect a provider in AI Settings; the connection is tested and stored encrypted.
- Attach two project documents in the composer; they are ingested into the knowledge base.
- Submit an objective with Ask AURA; watch the plan, tool trace and approval gates on the timeline.
- Approve a terminal step; the delegated worker runs and the orchestration graph lights up the corresponding slot.
- Open Workflows, dry-run the code-review template, then execute and export the report.
- Show the governance console and the audit trail for the session.

Figure 14: Application home screen: entry point of the demo walkthrough.

# 23. Target Users & End Customers
The final customer of AURA Hub is the individual engineer or student who runs the application on their own machine and pays only for the AI usage of the providers they choose — there is no AURA subscription and no AURA-hosted service in the current release. The product is therefore self-contained: whoever downloads the repository can operate the entire system locally.


# 24. Business & Delivery Model
- Licence. The codebase is Apache-2.0 licensed; the full source of both the desktop application and the service is in the repository.
- Delivery. Source-run deployment: a checkout, npm install, one service process and one desktop process. No installer distribution exists in the current release.
- Cost structure for the user. Infrastructure is the user's own machine; AI cost is the user's own provider account under BYOAK; no AURA-side recurring fee applies to this release.
- Ecosystem position. AURA Hub is a governance and orchestration layer over the providers and coding agents a user already has — it configures and supervises them rather than replacing them.

# 25. Report of Work Done
Development is recorded in the repository at 394 commits by 10 contributors with 52 merged pull requests between July and October 2026; the current line of work is the feature/workspace-v2-aura-execution-ui branch.


# 26. Report of Work In Progress
As of this snapshot the team is finalising the workspace v2 execution UI on the current branch: orchestration-graph interaction, approval and handoff flows in AuraAgentWorkspace, and provider onboarding polish captured in the latest screenshots. The documentation set is being aligned with the implementation, and the screenshot guide records two remaining gaps in an otherwise complete 14-image set. Test coverage on the backend is broad (Section 27) while the TypeScript side relies on component tests plus typecheck/build gates; consolidating this into a full automated UI suite is recognised in the repository's own status notes as outstanding work.

# 27. Testing & Quality Assurance

Quality gates in force: typecheck and build for the TypeScript workspace, pytest for the backend, and the fixture-server harness that tests provider code without live network calls.

# 28. Limitations of the Current Implementation
- Maturity is STABLE ALPHA, version 0.1.19: suitable for demonstration and supervised use, not positioned for production deployment.
- Distribution is source-run; no signed installers exist yet in the current release.
- The TypeScript UI has component tests and CI typecheck/build, but no comprehensive automated end-to-end suite.
- The knowledge graph is scoped to a single project per store.
- The screenshot guide records 2 of 14 screenshots as pending re-capture.
- Operation requires at least one user-obtained provider API key; the system ships without bundled model access.
- The workflow engine executes nodes sequentially; parallel graph branches are not part of the current executor.
- Cron fires missed while the system is offline are counted and reported rather than executed.

# 29. Conclusion
AURA Hub stands today as a working, coherent system: a native desktop workspace, a governed local service, a deterministic workflow engine, scheduled automation, a project knowledge base, a live machine map, eleven AI providers and nine configurable coding agents — all under explicit permissions, approval gates, network rules and audit trails. Its academic significance is twofold: it is a substantial engineering artifact across two technology stacks with a large test surface, and it is a concrete demonstration that AI assistance can be made governable — every privileged action is visible, attributable and reversible by design. The report documents the system strictly as it exists in version 0.1.19 of the repository; no planned capability has been represented as present.

# 30. References & Evidence Index (Appendix)
- Project repository — branch feature/workspace-v2-aura-execution-ui, version 0.1.19, snapshot October 2026 (source of every claim in this report).
- README.md — product overview, screenshot index, quick-start.
- docs/ARCHITECTURE.md and docs/DEVELOPMENT.md — system layout and developer workflow.
- docs/architecture/ — PROVIDER_INTEGRATION, AUTOMATION_ENGINE, MISSION_CONTROL_V3, ENGINEERING_INTELLIGENCE_PLATFORM, ENGINEERING_GOVERNANCE_PLATFORM, PREDICTIVE_ENGINEERING, ENGINEERING_MEMORY_ARCHITECTURE, ENGINEERING_TWIN, OBSERVABILITY-CONTRACT, LIVE-EVENT-CONTRACT, PROVIDER-BRIDGE-CONTRACT, RUNTIME-BOUNDARIES, AGENTIC-WORKSPACE.
- backend/aura/api/server.py — canonical HTTP/SSE API surface.
- backend/aura/workflow/engine.py — workflow execution semantics.
- backend/aura/fabric/manifest.json — capability catalog with risk levels.
- backend/aura/environment/ — probe, discovery and catalog modules.
- backend/aura/secrets/, backend/aura/policy/, backend/aura/governance/ — security mechanisms.
- backend/aura/central_agent/ — Ask AURA implementation.
- backend/tests/ — pytest suites; apps/desktop/src — Vitest component tests.
- examples/workflows/ — ten bundled templates.
- docs/assets/screenshots/ — fourteen product screenshots reproduced as figures in this report.
- LICENSE — Apache-2.0. SECURITY.md, CONTRIBUTING.md, CHANGELOG.md.
- Third-party components referenced by the implementation: React, Vite, Tauri, TypeScript, Vitest, Starlette, Uvicorn, Pydantic, pytest, httpx, BM25 retrieval, cron scheduling.
| Abstract
AURA Hub is an AI-native engineering workspace that unifies conversational mission control, governed agent delegation, deterministic workflow execution, scheduled automation, institutional knowledge capture, and machine-environment awareness in a single desktop application. This report documents the system exactly as implemented in version 0.1.19 of the project repository: its architecture, modules, interfaces, security controls, testing status, use cases, and market context. Every capability described in this document is present in the current codebase. |
| --- |
| 1.  Executive Summary | 3 |
| --- | --- |
| 2.  Problem Statement | 4 |
| 3.  Objectives | 5 |
| 4.  Scope of the Project | 6 |
| 5.  System Overview | 7 |
| 6.  System Architecture | 8 |
| 7.  Functional Description | 10 |
| 8.  Ask AURA — Conversational Mission Control | 11 |
| 9.  Workspace & User Experience | 13 |
| 10.  AI Provider Integration (Bring Your Own API Key) | 15 |
| 11.  Workflow Engine & Automation | 17 |
| 12.  Machine Environment Awareness | 19 |
| 13.  Orchestration & Delegation Model | 20 |
| 14.  Knowledge Base & Engineering Memory | 21 |
| 15.  Engineering Intelligence Components | 23 |
| 16.  Technology Stack | 24 |
| 17.  Data Flow & Interfaces | 25 |
| 18.  Security, Privacy & Governance | 26 |
| 19.  Bundled Workflow Templates | 27 |
| 20.  Installation & Deployment | 28 |
| 21.  Competitive Landscape | 29 |
| 22.  Use Cases | 30 |
| 23.  Target Users & End Customers | 32 |
| 24.  Business & Delivery Model | 33 |
| 25.  Report of Work Done | 34 |
| 26.  Report of Work In Progress | 35 |
| 27.  Testing & Quality Assurance | 36 |
| 28.  Limitations of the Current Implementation | 37 |
| 29.  Conclusion | 38 |
| 30.  References & Evidence Index (Appendix) | 39 |
| Project at a glance
≈57,500 lines of TypeScript/TSX across 404 source files · 394 commits by 10 contributors · 11 AI providers · 9 coding-agent adapters · 18 workflow node types · 10 bundled workflow templates · 15 shared packages · 14 product screenshots · 150+ backend test files · Apache-2.0 licence. |
| --- |
| In scope (implemented) | Out of scope (not part of the current implementation) |
| --- | --- |
| Desktop application for Windows, macOS and Linux | Hosted or cloud version of the product |
| Local Python service with a full HTTP/SSE API | Multi-user accounts, teams or cloud sync |
| Deterministic workflow engine with 18 node types | Mobile clients |
| Scheduled and event-driven automation (8 triggers, cron) | Any form of AI model training or customisation |
| Knowledge base with BM25 retrieval and ingestion pipeline | Autonomous unsupervised operation without approval gates |
| Machine environment scanning with provenance | Bundled or resold AI model access |
| 11 AI providers and 9 coding-agent adapters (BYOAK) | Marketplace or plugin economy |
| Reading note
Every row in the left column is verified in the repository referenced in Section 30. The right column records scope boundaries of the current release only. |
| --- |
| Component | Contents |
| --- | --- |
| apps/desktop | React 18 + TypeScript 5 + Vite 5 application inside a Tauri v2 (Rust ≥ 1.77.2) native shell: boot sequence, command palette, floating window manager, workspace screens, agent and memory centres. |
| backend/aura | Python 3.12 service: Starlette API server, central agent (planner, sessions, approvals, evidence), workflow engine, automation engine and scheduler, environment probe and discovery, knowledge store, policy engine, secrets store, network governance, capability fabric, provider adapters, agent-runtime adapters, JSON persistence. |
| packages/* (15) | Shared TypeScript packages: core, ui, ai-service, automation, governance, predictive, engineering-memory, intelligence, retrieval, knowledge-coding, knowledge-fullstack, runtime, workflow, capability-fabric, connected-environment. |
| docs/ | Architecture documentation (13 documents), security and contribution guides, 14 product screenshots. |
| examples/workflows/ | Ten importable workflow templates (Section 19). |
| backend/tests/ | Pytest suites: unit, providers, workflow, automation, integration, e2e, acceptance, golden, api, fabric, stores, vectors (Section 27). |
| Capability | Where it is implemented | Behaviour |
| --- | --- | --- |
| Conversational mission control | backend/aura/central_agent/ | Sessions, planner, intent compilation, worker delegation, approval ledger, evidence, cancellation, handoffs. |
| Workflow execution | backend/aura/workflow/engine.py | Sequential node execution with checkpoints, replay, awaiting-approval parking, governor, redaction. |
| Automation | backend/aura/automation/ | AutomationEngine plus cron scheduler; 8 trigger types; run-workflow action; 6 templates. |
| Knowledge base | backend/aura/knowledge/store.py | Ingestion, 1500/150 chunking, BM25 index, optional local Ollama embeddings. |
| Machine environment | backend/aura/environment/ | Catalog probes, PATH discovery, provenance, 13-state status per tool. |
| Provider integration | backend/aura/providers/ | 11 providers on one OpenAI-compatible adapter contract. |
| Agent configuration | backend/aura/agent_runtime/adapters/ | 9 adapters that detect, back up, configure and verify installed coding-agent CLIs. |
| Capability governance | backend/aura/fabric/manifest.json | ≈30 capabilities with risk levels, permissions and verify methods. |
| Secrets | backend/aura/secrets/ | AES-256-GCM vault, {{secret:NAME}} references, output redaction. |
| Persistence | backend/aura/persistence/ | Versioned JSON stores for projects, workflows, versions, runs, nodes, automation, missions. |
| Provider | Example model exposed by the integration | Access model |
| --- | --- | --- |
| Groq (default) | llama-3.3-70b-versatile | Groq API key |
| OpenAI | Account models (chat completions) | OpenAI API key |
| Anthropic | Account models (chat completions) | Anthropic API key |
| Google Gemini | Account models (chat completions) | Google API key |
| NVIDIA | meta/llama-3.1-8b-instruct | NVIDIA API key |
| OpenRouter | Multi-vendor catalogue | OpenRouter API key |
| Mistral | mistral-large-latest | Mistral API key |
| Cerebras | llama3.3-70b | Cerebras API key |
| Kimi | Account models (chat completions) | Kimi API key |
| Novita | deepseek/deepseek-r1 | Novita API key |
| Qwen | qwen-plus | Qwen API key |
| Node group | Node types |
| --- | --- |
| Core I/O | shell-command, http-request, export-file, user-input, output |
| Repository | git-status, git-diff, changed-files |
| Control flow | condition, variables, delay, loop, agent |
| Intelligence | groq, generate-markdown, generate-code, generate-json (executed through the shared pipeline) |
| Component | Role in the current implementation |
| --- | --- |
| Engineering intelligence | Aggregates signals across sessions and runs for the engineering dashboard. |
| Predictive engineering | Trend surfaces over recorded project and machine data, presented in the twin dashboard. |
| Engineering twin | Live dashboard view of project and machine state. |
| Retrieval | Shared retrieval plumbing used by the knowledge workspace and Ask AURA. |
| Engineering memory | Recorder and timeline model behind the memory centre. |
| Capability fabric | Typed capability registry with risk levels and verify methods (Section 18). |
| Connected environment | Bridge between the machine map and workspace surfaces. |
| Layer | Technology | Version / requirement |
| --- | --- | --- |
| Desktop shell | Tauri (Rust native shell) | Tauri v2, Rust ≥ 1.77.2 |
| UI framework | React + TypeScript | React 18, TypeScript 5 |
| Build tooling | Vite | Vite 5 |
| UI tests | Vitest component tests | Node.js ≥ 18.18 |
| Service runtime | Python | Python 3.12+ |
| HTTP framework | Starlette (HTTP + SSE) | ≥ 0.37, < 1 |
| ASGI server | Uvicorn | ≥ 0.30 |
| Data models | Pydantic | ≥ 2.13 |
| Service tests | pytest, pytest-asyncio, httpx | pinned in backend/pyproject.toml |
| Optional extras | pypdf, python-docx, pillow (multimodal); openpyxl, reportlab (artifacts); docling | opt-in install |
| Platforms | Windows, macOS, Linux | source-run today |
| API group | Representative endpoints | Purpose |
| --- | --- | --- |
| Health | GET /health | Liveness for shell and scripts |
| Workflows | GET/POST /workflows, /validate, /{id}/versions, /runs, /runs/{id}/resume, /dryrun, /cancel | Authoring, validation, execution, recovery |
| Webhooks | POST /webhooks | External triggers into workflows |
| Agent sessions | POST /agent/sessions/submit, /message, /approve, /resume, /cancel; evidence; plan | Conversational mission control |
| Providers | POST /providers/connect, /disconnect; status | BYOAK key management |
| Automation | CRUD plus trigger and test endpoints | Schedules and event chains |
| Environment | POST /environment/scan | Machine capability scan |
| Knowledge | /knowledge search; /documents/ingest | Project context and ingestion |
| Source of truth
The authoritative endpoint listing is backend/aura/api/server.py in the repository; the table above is the representative surface used by the desktop shell and the test suites. |
| --- |
| Template | Purpose |
| --- | --- |
| code-review | Structured multi-node review of a change set |
| explain-project | Guided walkthrough of a repository for newcomers |
| security-audit | Checklist-driven audit pass over the codebase |
| bug-investigation | Evidence-gathering flow for a reported defect |
| architecture-review | Structure-and-boundaries review pass |
| refactor-module | Scoped refactor with verification steps |
| generate-unit-tests | Test generation with export steps |
| dependency-analysis | Dependency inventory and risk pass |
| generate-documentation | Documentation drafting and export |
| release-notes | Change-log assembly from repository state |
| Prerequisite | Requirement |
| --- | --- |
| Node.js | ≥ 18.18 (npm workspaces) |
| Rust toolchain | ≥ 1.77.2 with Tauri system dependencies |
| Python | 3.12+ with pip |
| Operating system | Windows, macOS or Linux |
| Dimension | AURA Hub | Claude Code | OpenAI Codex CLI | Gemini CLI | Cursor | OpenCode |
| --- | --- | --- | --- | --- | --- | --- |
| Runtime form | Desktop app + local governed service | Terminal CLI | Terminal CLI | Terminal CLI | Desktop IDE (VS Code fork) | Terminal CLI |
| Provider choice | 11 providers, bring-your-own-API-key | Anthropic account | OpenAI account | Google account | Multiple providers via subscription | Multiple providers / local models |
| Deterministic workflows | ✓ 18 node types, checkpoints, replay | — | — | — | — | — |
| Scheduled automation | ✓ 8 triggers + cron scheduler | — | — | — | — | — |
| Approvals & governance | ✓ policy tiers, capability manifest, allowlist, audit | Partial (permission prompts) | Partial (approval prompts) | Partial (approval prompts) | Partial (agent permissions) | Partial (permission prompts) |
| Machine environment scan | ✓ catalog probes + provenance | — | — | — | — | — |
| Project knowledge | ✓ BM25 knowledge base + graph + memory | Partial (context files) | Partial (context files) | Partial (context files) | Partial (codebase indexing) | Partial (context files) |
| Licence (this code) | Apache-2.0 (this repository) | Proprietary | Open-source CLI | Open-source CLI | Proprietary | Open-source CLI |
| Scenario | How AURA Hub serves it today |
| --- | --- |
| Supervised coursework assistant | A student asks AURA to explain a repository, then runs the generate-unit-tests template; every shell step stops at an approval gate, and the evidence trail documents each action for the guide's review. |
| Code review and security audit | The code-review and security-audit templates execute repository nodes (git-diff, changed-files) with intelligence nodes and export a written report artifact. |
| Departmental automation | A lab assistant schedules dependency-analysis on cron and chains a documentation refresh to the dependency-changed trigger; missed fires are counted and reported. |
| Documentation generation | The generate-documentation template drafts content through generate-markdown nodes and exports DOCX/Markdown artifacts via export-file. |
| Machine-lab onboarding | An environment scan reports which toolchains are actually installed, with provenance and verification status, before any workflow claims to use them. |
| Multi-agent experiments | AI-lab coursework delegates subtasks to installed CLIs (Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode) under the same permission tiers and network rules. |
| User segment | Primary need | What AURA Hub gives them |
| --- | --- | --- |
| Engineering students and final-year teams | Learn and demonstrate AI-assisted engineering safely | Approval gates, evidence trails and deterministic workflows that make every AI action inspectable |
| Solo developers and freelancers | One workspace instead of five disconnected tools | Conversation, workflows, knowledge and automation with their own provider keys |
| Academic labs and institutions | Governed AI use inside the campus network | Policy tiers, network allowlist and audit trails; data never leaves the machine except to the chosen AI provider |
| AI/agent researchers | A reproducible testbed for delegation studies | A documented HTTP/SSE API, capability fabric and 150+ backend test files to build on |
| Deliverable | Status in the repository |
| --- | --- |
| Desktop application (React + Tauri) | Implemented; 14 captured product screenshots |
| Python service (40+ HTTP endpoints, SSE) | Implemented and exercised by the api test suite |
| Workflow engine (18 node types) | Implemented with checkpoint, replay, parking and governor |
| Automation engine + cron scheduler | Implemented; cron covered by differential test vectors |
| Knowledge base (BM25 + ingestion) | Implemented; optional local embeddings behind Ollama |
| Machine environment scanner | Implemented; 13-state verification model |
| 11 provider integrations | Implemented on a shared adapter contract with harness tests |
| 9 agent configuration adapters | Implemented with backup, verify and restore semantics |
| Governance layer (policy, fabric, netgate) | Implemented and exposed in the governance console |
| Documentation set | README, 13 architecture documents, security and contribution guides, screenshot guide |
| Bundled templates | 10 workflow templates + 6 automation templates |
| Suite | Coverage focus |
| --- | --- |
| backend/tests/unit (≈75 files) | Planner fan-out, intent fallbacks, policy, secrets, knowledge, environment |
| backend/tests/providers | Provider harness against a fixture OpenAI-compatible server |
| backend/tests/workflow | Node semantics, checkpoints, replay, parking |
| backend/tests/automation | Triggers, chains, cron differential vectors |
| backend/tests/integration, e2e, acceptance, golden, api, fabric, stores, vectors | HTTP surface, capability fabric, persistence stores, embeddings |
| Frontend Vitest | Component behaviour: add-tool flow, tool slots, worker slots, agent approvals |
| Continuous integration | npm run typecheck + production build; backend pytest |
| Verification scripts | 20+ scripts/ checks for workflows, automation runtime, providers, updater and UI |