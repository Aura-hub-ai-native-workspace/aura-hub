# AURA Hub — Repository Map

**Baseline:** branch `feat/laya-shadow-planner`, HEAD `0d6c43fa54c6ac2f6242f8b8da5976f2c6b92273` (= `origin/feat/laya-shadow-planner`), captured 2026-10-26.
**Method:** read from the code (entry points, module docstrings, route tables, imports, CI). Directory names and existing docs were not taken as evidence on their own.
**Supersedes for current state:** `docs/audit/subsystems.json` (2026-09-23) and the analysis-only `docs/AURA_ARCHITECTURE_RECONSTRUCTION_REPORT.md` (2026-10-20, at `389bead`). Those remain as history.

## 1. Shape of the system

AURA Hub is an npm-workspaces monorepo (`apps/*`, `packages/*`) plus a Python backend. At runtime it is **three processes**, all started and owned by the desktop shell:

```
 Tauri desktop shell (Rust, apps/desktop/src-tauri)
   │  per-launch identity token → HMAC proof check before any use
   ├── webview: React UI (apps/desktop/src)
   ├── Node AI service, 127.0.0.1:4319  (packages/ai-service, bundled as resources/ai-service.mjs)
   └── Python backend,  127.0.0.1:4320  (backend/aura, bundled with its own Python runtime)
 Local model server (user's Ollama, default 127.0.0.1:11434) — not started by AURA
```

Every request from the UI to either backend goes through `apps/desktop/src/backend/backendSession.ts::backendFetch`, which asks the shell to prove ownership of that backend (`backend_verify`) immediately before the request and attaches the launch token. A backend that cannot prove the launch's identity receives no request.

## 2. Subsystems

### 2.1 Desktop shell — `apps/desktop/src-tauri/src` (Rust, ~2.6k lines)
- `lib.rs`: Tauri commands (`service_status`, `environment_backend_status`, `backend_session`, `backend_verify`, code read/write commands, AppImage install/uninstall, update kind), startup of both backends on threads.
- `service.rs`: spawns and supervises children; `refuse_if_occupied` (never attaches to a process it did not start); `prove`/`verify` (fresh challenge, HMAC answer, constant-time compare); shutdown only of owned children.
- `instance.rs`: token and challenge generation (OS RNG), HMAC-SHA256 over `sha2`, known-answer tests shared with Python.
- `appimage.rs`: AppImage self-install into the user's applications folder.
- Entry: `main.rs` → `lib.rs::run`. Packaged by `npm run desktop:build` (Tauri bundler; AppImage + deb). Updater signing requires `TAURI_SIGNING_PRIVATE_KEY` (absent here → bundles unsigned).

### 2.2 Desktop UI — `apps/desktop/src` (React/Vite/TS, 310 tracked files)
- `screens/` (80): Home, Workspace (AURA Agent workspace), Workflows/Automation, Missions, Engineering dashboard, Settings/AI settings.
- `ai/` (41): HTTP clients — `aiClient` (Node: projects, providers, workflows, workflow-runs, conversations), `fabricClient` and `automationClient` (Node), `centralAgentClient` (Python: agent sessions, governance), `missionClient`, `runObserver`, `missionStatus`, `useAgentConversations`.
- `backend/`: `backendSession.ts` — the only route to either backend (identity gate, startup verdict).
- `ops/` (45): Agent Center campaign engine/store, notifications, status store, memory recorder.
- `editor/` (29): code editor, AI actions, AuraBug diagnosis UI.
- `onboarding/` (18): first-run flow; `ModelServerSetup` + `servicePoll` (waits for the service; stops with the shell's reason when startup failed).
- `environment/`, `shell/` (status bar, environment labels), `updater/`, `data/`, `workspace/`.
- Entry: `main.tsx` → `App.tsx`. Tests: vitest, node environment (no DOM); 44 files.

### 2.3 Node AI service — `packages/ai-service` (port 4319, 173 tracked files)
- `server.ts`: hand-rolled HTTP router; route groups `agent ask automation code environment fabric governance graph health index inspect missions models predictive projects providers reindex retrieve secrets settings shutdown stream workflow-runs workflows workspace workspaces`.
- `instanceGuard.ts`: same token/proof contract as Python; `/health` and `/instance/proof` open, everything else needs the token.
- `workspace.ts` (`WorkspaceManager`): projects, indexing, provider connect/verify (`verifySelfHosted`), missions.
- `provider/`: provider registry + adapters (Ollama, OpenAI-compatible, Anthropic…), credential store.
- `fabric/`: executors and `auditStore` (`~/.aura/fabric-audit.jsonl`); invokes `@aura/capability-fabric`.
- `workflow/`: workflow engine, runner, run store (legacy parked runs end as failed), governor, agent loop.
- `mission/`: goal graph, execution engine, task generation.
- Tests: vitest, 19 files.

### 2.4 Python backend — `backend/aura` (port 4320, 213 tracked files)
Entry: `scripts/serve_central_agent_api.py` → `aura.api.server.create_app` (stdlib HTTP + Starlette pieces), `InstanceGuard` middleware. Route groups: `agent agent-runtime artifacts automation documents environment events fabric governance health instance knowledge missions network projects providers secrets webhook workers workflow-runs workflows`.

| Subsystem | Lines | Responsibility (from its own docstring and code) |
|---|---|---|
| `central_agent/` | 16.9k | Orchestration: intent → plan → execute → verify → synthesize. "The agent reasons; `aura.policy` decides; `aura.fabric` executes and audits." Intent (`intent.py`, model + deterministic rules), planner, execution controller (`execution.py`, ad-hoc workflow route + direct fabric invoke), verification (plan criteria + request-grounded checks), synthesis (`service.py`), sessions, worker leases, supervisor/correction loop, research, run board. |
| `environment/` | 10.6k | Connected Environment: node discovery, probing, installation. Feeds `/environment`. |
| `api/` | 3.3k | HTTP surface, `instance_guard.py`. |
| `sovereign/` | 3.1k | Sovereign policy and model registry (`~/.aura/sovereign.json`). |
| `agent_runtime/` | 3.0k | AI runtime control plane (agent config). |
| `workflow/` | 2.8k | Re-exports the one execution path; workflow engine incl. `run_ad_hoc` single-node runs used by the central agent. |
| `multimodal/`, `knowledge/`, `artifacts/` | 3.5k | Local document ingestion, knowledge base, DOCX/XLSX/PDF generation. |
| `fabric/` | 2.7k | Python port of `fabric.ts`: resolve → policy → execute → verify → audit; the governed path for side effects. |
| `executors/`, `exec_/` | 2.7k | Executors (filesystem, terminal, git, agent.delegate…) and the process boundary (disjoint allow-lists). |
| `policy/` | 0.4k | The one policy engine (mirror of `capability-fabric/src/policy.ts`); decisions auto-execute or deny. |
| `governance/`, `workers/`, `capabilities/` | 4.5k | Worker governance, worker identities (opencode, claude-code, …), measured capability registry. |
| `persistence/`, `contracts/`, `audit/`, `secrets/` | 3.0k | Stores, Pydantic contracts, audit store (`~/.aura/audit/trail.jsonl`), secret store. |
| `engineering/` | 2.5k | Physical engineering domain model (CAD/EDA orchestration foundation). |

### 2.5 Shared packages — `packages/*`
| Package | Imported by (files) | Role |
|---|---|---|
| `@aura/ui` | 109 | Design system (React components). |
| `@aura/core` | 93 | Tokens, motion, shared types. |
| `@aura/capability-fabric` | 24 | Manifest, policy, fabric (TS side of the governed path). |
| `@aura/runtime`, `@aura/connected-environment` | 19 each | Runtime contract; connected-environment layer (TS). |
| `@aura/knowledge-coding`, `-fullstack`, `@aura/automation`, `@aura/governance` | 5–6 | Knowledge engines, automation, governance (TS). |
| `@aura/intelligence`, `@aura/retrieval`, `@aura/engineering-memory`, `@aura/predictive`, `@aura/workflow` | 2–3 | Smaller foundations; low coupling. |
| `@aura/ai-service` | 0 (bundled, not imported) | The Node service itself. |

### 2.6 Other tracked areas
`docs/` (135 files, many overlapping audits/handoffs), `scripts/` (74: packaging, release verification, desktop runtime verification, UI scripts), `website/`, `partnership/`, `examples/`, `graphify-out/` (generated code graph, tracked), `.github/workflows/ci.yml`.

## 3. How the parts talk

| From | To | Mechanism |
|---|---|---|
| UI | Shell | Tauri `invoke` (`backend_verify`, `service_status`, …). |
| UI | Node 4319 | `backendFetch` + token: projects, providers/onboarding, workflows, fabric, automation, conversations. |
| UI | Python 4320 | `backendFetch` + token: `/agent/*` (central agent sessions, SSE events), `/environment/*`, governance. |
| Shell | both backends | spawn with token in env; `/instance/proof?challenge=` before trust. |
| Python central agent | its own fabric/workflow engine | in-process; executors run git, filesystem, terminal, worker CLIs. |
| Node service | `@aura/capability-fabric` | in-process; Node executors. |
| Either backend | Ollama | HTTP (OpenAI-compatible and native endpoints). |

## 4. Duplicated surfaces (architectural risk)

Both backends implement 12 route groups: `agent automation environment fabric governance health missions projects providers secrets workflow-runs workflows`. The UI uses the **Node** versions of workflows, fabric, automation, projects and providers, and the **Python** versions of agent and environment. Policy, fabric, executors, secrets and audit therefore exist twice (TS original, Python port); the audit trail is split between `~/.aura/fabric-audit.jsonl` (Node) and `~/.aura/audit/trail.jsonl` (Python). Divergence between the two has already caused defects (the approval workflow lived on in the Node policy after removal from Python).

## 5. Tests and gates (CI: `.github/workflows/ci.yml`)
- `npm run typecheck` (ai-service, workflow, `tsc -b`).
- `npm run test:front && npm run test:service` (desktop vitest; Node service vitest).
- `python -m pytest backend/tests` (unit, api, automation, central_agent, differential, e2e, fabric, golden, integration, mcp, providers, stores, workflow, acceptance).
- `npm run build`; release jobs: AppImage patching, tarball, `desktop-runtime-verify.mjs` under xvfb, release verification.
No GUI/DOM test harness for the agent surfaces; packaged acceptance (A/B/C) has been run by hand.
