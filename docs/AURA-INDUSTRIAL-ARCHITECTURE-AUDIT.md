# AURA INDUSTRIAL ARCHITECTURE AUDIT

**Date:** 2026-09-09 · **Auditor:** automated architecture census (read-only; no production code modified)
**Repo state at audit:** branch `feature/enhancement-of-extended-environment` @ `1d9144e416f6c986421613921a83102076051d67`
**Remote:** `https://github.com/Aura-hub-ai-native-workspace/aura-hub.git` · Tags: `archive/central-agent-a4f86c8`, `v0.1.0`–`v0.1.5`
**Working tree:** pre-existing WIP only (Tauri shell, agent migrations, governance); nothing added/removed by this audit.

> How to read this document: every major claim cites `branch · file · symbol`. Anything that could not be verified is marked **UNKNOWN**; anything environment-blocked is marked **ENV-LIMITED**.

---

## 1. Executive Summary

AURA Hub is a **dual-runtime system mid-migration**: a TypeScript service (`packages/ai-service`, port **:4319**) owns chat, workflows, missions, BYOAK providers and the rich `ContextView`; a Python service (`backend/aura`, port **:4320**) owns the Central Agent, Capability Fabric execution, approvals ledger, audit and evidence. The migration lineage (phase1–5 → `migration/python-backend` → `recon/6308a1f` → `central-agent-integrated`) is substantially complete on `main`; the active work branch adds the agent-native Ctrl+I + Ask AURA surfaces, `editorContext`, and `answer.token` streaming.

The architecture's **governance core is genuinely industrial** (authority → policy → single-use approval ledger → Fabric → verification → evidence, all live-tested including a real autonomous benchmark fix). The **industrialization debt is at the seams**: two policy engines, two approval ledgers, two provider credential stores, two context assemblers, two API hosts, snapshot (not live) SSE, no agent-session listing, and ~15 stale branches plus a parallel neon UI redesign that must never merge blindly.

**One-line verdict:** the brain and the hands are industrial; the nervous system between the two runtimes is still healing.

---

## 2. Repository State

| Item | Value |
|---|---|
| Current branch | `feature/enhancement-of-extended-environment` (+35 vs `main`, +0 behind) |
| HEAD | `1d9144e` (2026-09-08, network platform enforcement) |
| `main` | `2473659` (2026-09-02, PR #30 stabilization merge) |
| Remotes | `origin` only; `origin/HEAD → origin/main`; local `main` == `origin/main` |
| Tags | `v0.1.0`…`v0.1.5`, `archive/central-agent-a4f86c8` |
| Worktrees | 19 linked worktrees under `/home/Groot/aura-phases/`, `/mnt/storage/aura-*` (phase snapshots, merge staging, release prep) |
| Runtimes | Python 3.12, Node 22, Rust/Tauri, pytest 9.1.1, ruff |
| CI | `.github/workflows/ci.yml` (typecheck+build on ubuntu; native Tauri packaging per-OS on demand; tags `v*` publish) |

---

## 3. Complete Branch Inventory (ahead = commits vs `main`)

| Branch | HEAD/date | Ahead | Purpose (from commits, not name) |
|---|---|---|---|
| `feature/enhancement-of-extended-environment` (current) | `1d9144e` / 09-08 | 35 | Active mainline: Central Agent hardening, Ctrl+I + Ask AURA agent migration, `editorContext`, `answer.token` streaming |
| `migration/python-backend` | `364241d` / 08-27 | 38 | TS→Python completion gate: MCP context, resilient routing, automation fixes, CORS, approvals ledger |
| `recon/6308a1f` | `855614c` / 08-29 | 41 | Same lineage + reverification suites (largely overlapping `migration/python-backend`) |
| `central-agent-integrated` | `932186f` / 08-24 | 23 | Central Agent foundation: contracts, intent/planner/discovery/authority, Fabric pipeline, persistence parity |
| `feature/workflow-automation-unification` | `302baf8` / 08-25 | 17 | Workflow substrate port, governed browser exec, durable scheduler, MCP freshness, provider battery |
| `phase5/platform` | `ed9c343` / 08-20 | 10 | OS keychain/KDF, security attack suites, desktop-observation governance, signing pipeline |
| `phase2/nervous-system` | `8c8942b` / 08-20 | 8 | Event Spine, provider routing v1, local models, agent-in-service move |
| `phase4/reach` | `daed84c` / 08-20 | 8 | MCP drivers, browser/CDP tier + SSRF guard, context composer w/ budget, memory tiers |
| `feature/backend-python-migration` | `0f1cd89` / 08-23 | 8 | Early port passes (policy, exec, fabric, tools, retrieval, context) |
| `phase3/governed-agency` | `55f7e9e` / 08-20 | 4 | Bounded plan→act→observe loop (shipped OFF), tool broker, kill-switch, budgets |
| `origin/enhance/workspace-ui` | `dbf5091` / 09-06 | 4 | **Neon cyber-glass redesign** (`screens/workspace/neon/`, HubCanvas) — parallel visual language |
| `pr31-workspace-ui` | `41436ea` / 09-04 | 2 | Same redesign lineage (conflict resolution) |
| `feature/website-deployment` | `265e690` / 08-13 | 2 | Website downloads page only |
| `pr15-sync` | `98b4251` / 08-17 | 1 | Mission engine sync |
| ALL others (see §4) | various | 0 | Merged or fully behind `main` |

Missing locally (remote-only): `origin/feature/workspace-execution-environmentV2`. `feature/workspace-2.0-context-fabric` == `feature/agent-context-phase3` (`a382625`, identical HEAD).

## 4. Branch Genealogy

```
phase1/redaction-and-journal ─┐
phase2/nervous-system ────────┤
phase3/governed-agency ───────┼─► main (09-02, PR #30 stabilization)
phase4/reach ─────────────────┤         ▲
phase5/platform ──────────────┘         │ (+35) active work branch
central-agent-integrated ──► migration/python-backend ──► recon/6308a1f (parallel tips, overlapping)
feature/backend-python-migration ──► feature/workflow-automation-unification (port lineage)
feature/*, fix/*, bugfix/*, integration/* ──► merged into main (ahead 0)
origin/enhance/workspace-ui ── parallel, UNMERGED redesign (divergent design system)
```

Worktree checkouts (`+` in `git branch -a`) are staging snapshots, not live lines: `integration/v0.1.5`, phase2–5, agent-context-phase3, backend-python-migration, update-experience-v1, workspace-2.0-*, opencode-approval fix, wire-uninstall, update-engine, pr15-sync, recon, release candidate, install-ux.

## 5. Branch Contribution Matrix (excerpt; full data in `docs/audit/branches.json`)

| Branch | Subsystems | Unique work vs main | Merged? | Verdict |
|---|---|---|---|---|
| active work branch | agent, editor, chat, providers | Ctrl+I/AskAURA agent migration, streaming, editorContext | n/a (current) | **PRODUCTION LINE** |
| migration/python-backend ≈ recon/6308a1f | api, fabric, automation, agent | Completion fixes + reverification suites | Partially (lineage in main) | B — cherry-pick reverification suites |
| central-agent-integrated | agent, fabric, persistence | Foundation (now superseded by recon tips) | Superseded | F — archive tag exists |
| workflow-automation-unification | workflow, browser, scheduler, MCP | Browser exec, durable scheduler, provider battery | Partially | B — needs per-feature triage |
| phase2–5 | events, providers, agent loop, context, security | Historical workstreams; HANDOFF+QUESTIONS docs | Largely in main | C/D — docs valuable, code merged |
| backend-python-migration | backend port passes | Early port (superseded by recon tip) | Superseded | F |
| enhance/workspace-ui | workspace shell | Neon redesign, HubCanvas | **No** | G if merged blindly — competing design system; extract ideas only |
| pr15-sync, website, pr/21/24/27 | missions, website | Minor syncs | Trivial | E/F |

## 6. Complete Subsystem Inventory (source-derived)

- **A. Desktop/Shell** — `apps/desktop/src-tauri/` (10 `#[tauri::command]`s, tightly scoped), lifecycle/service (WIP dirty), Linux/Windows/macOS packaging, AppImage worktree, update engine (`release/update-engine-phase1`, `feature/update-experience-v1`).
- **B. Frontend** — `apps/desktop/src/{screens,editor,components,shell,ops,data,ai,environment,workspace}`; AiWorkspace (agent-native), EditorWorkspace + Ctrl+I palette, Mission Control, Workflow UI, Automation Studio, provider/settings/project/session/approval/plan/evidence UI.
- **C. Central Agent** — `backend/aura/central_agent/` (26 modules: intent, planner, discovery, authority, context+bundle, editor_context, execution, supervisor/correction, verification, evidence, runcontrol, session store, EventBus, workflow compiler, handoff, findings, worker_match, MCP gateway/transport/context, model_routing). Canonical brain.
- **D. Context Fabric** — TS: `packages/ai-service/src/context/` (compose/contract/types) + `intelligence/` (assembler, retrieval) + knowledge packages; Python: `central_agent/context.py` (bounded bundle). **Two assemblers — see §10.**
- **E. Capability Fabric** — TS `packages/capability-fabric/` (fabric/policy/manifest) + Python `backend/aura/{fabric,policy,executors,approvals,audit}`. Agent path executes on Python.
- **F. Policy/Security** — Python `policy/engine.py` + `governance/` (netgate, opencode plugin, staging, actions); TS `policy.ts`; OS keychain/KDF (phase5); risk floors in editor.
- **G. Providers** — TS: 13 adapters (openai, anthropic, gemini, kimi, qwen, mistral, groq, cerebras, novita, nvidia, openrouter, kage7, base) + RuntimeManager + encrypted BYOAK store; Python: operator `providers.json` + `RoutedModelPort` (JSON + SSE streaming, health, circuits). **Two credential stores — see §11.**
- **H. Execution Environment** — `packages/connected-environment`, node registry (`connected-nodes.json`), proven opencode worker (coding-agent + terminal, governed), git tool node.
- **I. Workflow Engine** — TS `mission/execution` + `workflow/`; Python `backend/aura/workflow/` + automation + scheduler.
- **J. Agentic Nodes** — `agent.delegate` executor, worker_match, authority envelope, handoff envelopes, resume grants.
- **K. Engineering Intelligence** — `codeAction.ts` (legacy, kept for AuraBug), diagnosis pipeline, Ctrl+I agent path.
- **L. Bug Bot** — `editor/aurabug/` (scan/panel/hooks; still on `/code/action` intentionally).
- **M. Mission Control** — `screens/missions/`, missionClient, ApprovalGate (reused by agent UI).
- **N. Git** — executor capabilities + UI panels; fixture-verified safe.
- **O. Persistence** — JSON stores, atomic writes (`jsonutil`), TS conversations/memory, agent sessions, approvals, audit JSONL, workflow stores, version stores.
- **P. Observability** — audit trail, AgentEvent bus + tail, worker lifecycle/action events, phase strips, debug views. **No metrics/trace IDs — see §26.**
- **Q. Testing** — `backend/tests/{unit,api,integration,fabric,workflow,mcp,providers,stores,differential,golden,vectors,automation}` (~40 unit files incl. red-team, cancellation, correction, cross-platform); `scripts/*-verify.mjs` gates; differential TS↔Python parity proofs.
- **R. Build/Release** — tsc + vite + Tauri per-OS CI; `v*` tags publish; uv.lock; installers/updater workstreams.
- **S. Cross-platform** — `test_cross_platform`, inventory tests, netgate platform adapters (Windows/macOS honest-unsupported paths).
- **T. Docs** — 40+ top-level docs + `architecture/` + `migration/` (rich but sprawling; CONSOLIDATION_MAP exists).
- **U. Other** — `graphify-out/` (generated, dirty — should be gitignored), `.kilo/` (untracked), prediction/retrieval packages, `presentation-v0.1`.

## 7. Current Architecture (derived from code, not docs)

```
User ─► Tauri Desktop ─► React Workspace (AiWorkspace / EditorWorkspace / MissionControl)
  ─► centralAgentClient ─► :4320 Starlette create_app (CANONICAL agent host)
  ─► CentralAgent: intent → discovery → plan → authority → [approval park]
  ─► Capability Fabric (Python): policy → ledger → executors (filesystem/process/git/agent.delegate→opencode)
  ─► verification → evidence → audit JSONL ─► answer.token SSE + AgentResult
Alongside: :4319 TS ai-service (chat /stream, workflows, missions, BYOAK, ContextView) — legacy surfaces + AuraBug/Home chat
```

## 8. Canonical Authorities (CANONICAL vs DUPLICATE vs BYPASS)

| Authority | Canonical | Duplicate / legacy | Bypass (must fix) |
|---|---|---|---|
| Execution | Python Fabric (`backend/aura/fabric/`, `executors/`) | TS `capability-fabric` (workflow/mission path) | None on agent path (grep-verified) |
| Policy | `backend/aura/policy/engine.py` | TS `policy.ts` | None found |
| Approval | `backend/aura/approvals/` ledger | TS fabric internal approvals | UI `pendingApprovals()[0]` fallback (P3) |
| Provider (agent) | `RoutedModelPort` | TS RuntimeManager (separate store, by design) | None (no SDK in UI, grep-verified) |
| Context (agent) | `ContextBundle` + registry | TS `ContextView` (richer; P9 convergence open) | None (fenced/bounded) |
| Sessions (agent) | `AgentSessionStore` | TS conversations (thread layer, by design) | None |
| Evidence | `EvidenceCollector` + audit JSONL | — | None |
| Projects | registry (`projects.json`) | — | None (server-resolved) |

## 9. User Feature Execution Paths
Ctrl+I and Ask AURA: UI → `centralAgentClient` → `:4320` → full governed loop (live-benchmarked end-to-end including a real repo fix). Home quick-chat: `aiClient.stream` → `:4319` (intentionally retained). AuraBug: `/code/action` (intentionally retained). Mission/workflow execution: TS service → TS fabric (dual-runtime seam, no bypass of *its own* policy).

## 10. Context Architecture
**Verdict: two assemblers, one discipline.** TS `composeContextView` (rich: identity/branch/env/capabilities/freshness) serves chat/diagnosis; Python `ContextBundle` (bounded, provenance-marked, +fenced `editor` items) serves the agent; `agent.delegate` workers receive AURA-composed briefs. All paths bound + fence untrusted content (red-team proven). Gap (P2): no single canonical project context shared by both runtimes — Python Context Fabric convergence is the documented P9.

## 11. Provider Architecture
Centralized per runtime: TS RuntimeManager (13 adapters, encrypted store, validation, retries) and Python `RoutedModelPort` (chain, health, circuits, JSON+SSE). Secrets: TS AES store (+OS keychain/KDF work), Python env-at-call-time (never persisted). No UI/edge bypass (grep-verified). Gap (P2): two credential stores with no operator bridging story; agent has no session-level model label for UI display.

## 12. Execution Architecture
Primitives: `filesystem.*`, process/terminal, git.*, `agent.delegate`, workflow/mission runs — all via Fabric with policy→approval→audit→verify. Timeouts, output caps (`MAX_STREAM_CHARS`, envelope caps), cancellation tokens, run scopes. No escaping path found on agent surfaces.

## 13. Security Architecture
Threat review (static + live red-team): prompt injection (fenced, tested hostile), path traversal (registry-resolved cwd, scope-checked), approval forgery (single-use ledger, 409 replays), session confusion (id-bound frames, cross-project 409), secrets (never in prompts/sessions; redacted), renderer privilege (no fs/shell in UI paths). Residual: P3 first-pending fallback; P4 empty-synthesis noise.

## 14. Persistence Architecture
Atomic JSON writes, tolerant reads, versioned-ish stores, recovery (orphan-run reconciliation, parked-leg resume, cancellation survival). No schema-migration framework (P3); no backup story (P4).

## 15. Observability Architecture
Audit JSONL + event bus + worker observations answer what/who/approved/changed/verified/how-long. Missing: metrics, trace/correlation IDs across the TS↔Python hop, model telemetry (which model decided — P2 gap).

## 16. Testing Architecture
Strong on contracts/governance/agent behavior (incl. adversarial, differential parity, golden vectors); E2E via live-server scripts + one autonomous benchmark. Gaps: no GUI harness (P2), worker-internals opacity (P3), organic-failure recovery observed only via deliberate revert (P3).

## 17. Release Architecture
CI builds+typechecks; native per-OS packaging on demand; tag-gated publish; signing pipeline (phase5). Blocker class: nothing single; distribution readiness is process, not architecture.

## 18. Cross-platform Architecture
Platform adapters with honest degradation; cross-platform + inventory tests. Debt: installer/update UX workstreams unfinished; Windows/macOS paths ENV-LIMITED in this lab.

## 19. Duplicate Systems (canonical → action)
1. TS vs Python policy engine → Python canonical for agent; TS for legacy service. **KEEP both, mark boundary** (MIGRATE only with workflow-service retirement plan).
2. TS vs Python approval ledgers → Python canonical. **KEEP both; remove UI first-pending fallback** (TODAY item).
3. TS conversations vs agent sessions → complementary layers. **KEEP; document.**
4. `composeContextView` vs `ContextBundle` → converge on P9. **LATER.**
5. `build_default_api` vs `create_app` → `create_app` canonical; deprecate the former (TODAY).
6. `backend/parity/` oracle harnesses vs `backend/tests/differential/` → consolidate (NEXT).

## 20. Dead / Legacy Systems
KEEP: `/stream` (Home chat), `/code/action` (AuraBug), `useConversations` (Home chat), TS fabric (workflow/mission runtime). DEPRECATE: `build_default_api` host. REMOVE: `graphify-out/` from git (generated), stale `__pycache__`. INVESTIGATE: `presentation-v0.1`, `pr/21/24/27`, `backup/pre-merge-*`.

## 21. Half-Migrated Systems
Approval ledger duality (functional, documented); provider stores duality (functional, no bridge); context duality (functional, P9 open); workflow engine dual runtimes (TS active for missions, Python substrate ported — needs per-feature triage from `workflow-automation-unification`).

## 22–25. Findings registers (see `docs/audit/gaps.json` for the full table)
Security: no P0/P1 open (red-teamed). Reliability: snapshot-SSE polling cadence (P3). Performance: in-process streaming sub-second; worker legs dominate honestly. Maintainability: docs sprawl (40+ files, overlapping audits — P3, consolidate around CONSOLIDATION_MAP).

## 26. Industrial Gap Register (top)
| ID | Subsystem | Problem | Sev | Fix |
|---|---|---|---|---|
| G-01 | API hosts | Legacy `build_default_api` alongside `create_app` | P2 | Deprecate + route audit |
| G-02 | Approvals UI | First-pending fallback | P3 | Remove fallback, require evidence id |
| G-03 | Context | No shared canonical context across runtimes | P2 | P9 Python Context Fabric |
| G-04 | Providers | Two credential stores, no operator bridge story | P2 | Documented operator flow + UI status |
| G-05 | Observability | No trace IDs / model telemetry | P2 | Correlation id across :4319↔:4320 |
| G-06 | Streaming | Snapshot SSE polling, no live-follow | P3 | Live-follow `agent_events` |
| G-07 | Branches | ~15 stale branches, neon parallel UI | P2 | Archive + triage (see §28) |
| G-08 | Docs | Overlapping audit/handoff docs | P3 | Consolidate |
| G-09 | Generated files | `graphify-out/`, `__pycache__` dirty the tree | P4 | gitignore |
| G-10 | Tests | No GUI harness | P2 | Playwright smoke for Ask AURA/Ctrl+I |

## 27. Subsystem Maturity Scorecard (0–5)
Central Agent 4 · Capability Fabric (py) 4 · Policy/Approvals 4 · Evidence/Audit 4 · Ctrl+I/Ask AURA integration 4 · Context (TS) 4 · Context (agent bundle) 3 · Providers (TS) 4 · Providers (agent routing) 3 · Execution env/workers 4 · Workflow engine 3 · Mission Control 3 · AuraBug 3 · Persistence 4 · Observability 3 · Testing 4 · Release/CI 3 · Cross-platform 3 · Docs 2 · Branch hygiene 2.
**Overall ≈ 3.4 (production-capable, hardening in progress).** Governance 4.0 · Execution 4.0 · AI/model 3.5 · Security 4.0 · Testing 4.0 · Operational 3.0 · Cross-platform 3.0.

## 28. Branch Value Extraction
A — must integrate: active branch (in progress); reverification suites from `recon/6308a1f`; per-feature triage of `workflow-automation-unification` (scheduler, browser exec, provider battery). B — redesign-gated: neon UI ideas (never merge as-is). C — obsolete impl, ideas live on: phase docs, port passes. D — experimental: `presentation-v0.1`, recon snapshots. E — duplicate: `central-agent-integrated`, `backend-python-migration` (superseded tips). F — obsolete: merged branches, `backup/*`, `archive/*` tag exists. G — dangerous: blind neon merge.

## 29. Missing Industrial Capabilities
Live-follow SSE; trace correlation; operator provider onboarding; GUI test harness; schema-migration framework; single canonical context; workflow-runtime unification decision.

## 30. TODAY / NEXT / LATER Roadmap (specs in `docs/audit/roadmap.json`)
**TODAY:** deprecate `build_default_api`; remove first-pending approval fallback; gitignore generated dirs; archive stale branches (tag + delete remote refs only after tag). **NEXT:** live-follow events; correlation IDs; operator provider flow; Playwright smoke; parity-harness consolidation. **LATER:** P9 shared context; workflow-runtime unification; docs consolidation.

## 31. Recommended Architecture Target
As §36 of the brief, with two rulings from evidence: (1) keep the dual-runtime split explicit — Python owns agent authority, TS owns legacy interactive services — until a per-surface retirement plan exists; (2) converge context and providers before unifying execution runtimes.

## 32. Final Verdict (questions §33 condensed)
Real architecture: dual-runtime governed agent platform (§7). Strongest: Central Agent + Fabric governance loop. Weakest: branch hygiene/docs. Valuable-but-missing: reverification suites, scheduler/browser-exec triage. Obsolete: merged lines, port passes, snapshots. Duplicates: §19 (all mapped). Debt: seams between runtimes, not the core. Bypasses remaining: none on agent paths (verified). What blocks "industrial-grade" today: G-01…G-10 above. TOP 10 fixes = G-01…G-10. Do NOT build: another agent, another provider path, another context system, another execution authority — all solved.
