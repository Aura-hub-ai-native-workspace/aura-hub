# AURA Hub — Project Report
*Prepared as source content for a production-ready presentation deck*
*Snapshot date: 2026-08-07 · Branch: `presentation-v0.1` (in-flight) · Version: `0.1.0`*

---

## Slide 1 — Cover

**AURA Hub**
*The AI-Native Engineering Environment*

An AI-native desktop engineering environment — not a chat app, not a browser tab, not an editor plugin.

License: Apache 2.0 · Platform: macOS · Windows · Linux · Built with Tauri v2

---

## Slide 2 — Executive Summary

- AURA Hub is a **native desktop application** that gives software engineers one persistent, AI-grounded workspace instead of a chat panel bolted onto an editor.
- The core bet: **the environment is the product.** Every project opened in AURA gets a real, structural knowledge graph — built from static analysis, not guesswork — before any AI model is ever called.
- **11 AI providers** supported through one shared adapter interface — no vendor lock-in, bring your own API key.
- **57,500+ lines** of TypeScript/TSX across **404 source files**, organized as an **11-package monorepo** plus a Tauri-based native shell.
- Status: pre-1.0, actively developed, single-owner-governed, CI green, **not yet publicly released** (no signed installers yet — run-from-source only today).

---

## Slide 3 — The Problem

Most developer tools give you an editor with an AI panel bolted onto the side.

- Ask it something → it re-derives context from whatever's currently visible in the buffer.
- It doesn't know your architecture.
- It doesn't remember yesterday's decisions.
- Every session starts from zero.

> The chat window is a guest in someone else's house.

---

## Slide 4 — The AURA Approach

AURA inverts the relationship: the environment *is* the product.

- A project opened in AURA gets a **persistent, structural understanding of itself** — a knowledge graph from real static analysis — before any model is called.
- Engineering work (missions, workflows, architecture review, governance) runs as **first-class, resumable, inspectable processes** — not one-shot chat completions.
- AURA has **no built-in model, no hidden API account** — you bring your own key to whichever provider you trust, and the whole platform works identically regardless of which one you pick.

---

## Slide 5 — Why AURA Hub (Differentiators)

| Principle | What it means |
|---|---|
| **Grounded, not guessed** | Every AI answer built on a real, incrementally-updated knowledge graph — never a raw file dump re-read on every keystroke |
| **Deterministic where possible** | Checkable questions (dead code? public export removed?) answered by real parsing/arithmetic — the model is reserved for what only a model can do |
| **No vendor lock-in** | 11 providers behind one adapter interface; switching mid-conversation is a first-class operation |
| **Engineering memory that compounds** | Decisions, patterns, learnings persist across sessions |
| **Built for scale from day one** | Strict inward-only architecture, zero raw hex values in the design system, internals meant for years of development, not a demo |

---

## Slide 6 — Core Features

| Feature | What it is |
|---|---|
| **Workspace / Window Manager** | Floating-window "second desktop" — dock, float, tile, switch between panels instead of one fixed layout |
| **Mission Control** | Multi-step engineering work as a real dependency-aware DAG — task waves, blocked/queued/running states, critical-path view, full replay timeline. Every task needs explicit human approval. |
| **AI Workflow Builder** | Natural language → a real, validated, runnable node graph against the platform's actual node registry |
| **Automation Studio** | Visual node-based workflow engine, 10 real starter templates, event-driven automation reacting to real platform moments |
| **Knowledge Graph** | AST-based static analysis (`graphify`) — god-node detection, community structure, cross-file relationship queries, incrementally updated |
| **Architecture Blueprint** | Layered, structural system view — modules, dependencies, boundaries |
| **Engineering Intelligence** | Health scoring, architecture drift detection, technical debt tracking, deterministic risk prediction — zero fabricated metrics |
| **Engineering Memory** | Persistent, queryable memory of engineering decisions and learnings |
| **Multi-Provider AI** | 11 BYOAK providers: OpenAI, Anthropic, Gemini, Groq, Mistral, Cerebras, Kimi, NVIDIA, OpenRouter, Novita, Qwen |

**Key architectural point:** none of these are bolted-on side features — every AI-backed capability funnels through the *same* shared engine, so provider validation, error handling, retries, and context assembly are implemented once and apply everywhere automatically.

---

## Slide 7 — Product Architecture (Three Layers)

```
┌─────────────────────────────────────────┐
│         THE DESKTOP APPLICATION          │
│  Window Manager · Mission Control ·      │
│  Automation Studio · Knowledge Graph ·   │
│  Settings — one native window            │
└──────────────────┬────────────────────────┘
                   │
┌──────────────────▼────────────────────────┐
│          THE INTELLIGENCE LAYER            │
│  Local, on-device engine: builds/maintains │
│  the knowledge graph, plans & executes     │
│  missions, runs workflows, remembers       │
│  engineering decisions across sessions     │
└──────────────────┬────────────────────────┘
                   │
┌──────────────────▼────────────────────────┐
│              THE MODEL LAYER               │
│  Whichever AI provider you connect.        │
│  No built-in model, no key ever proxied    │
│  through a third party.                    │
└─────────────────────────────────────────────┘
```

Deep-dive architecture docs exist per platform: Mission Control v3, Provider Integration, Automation Engine, Engineering Intelligence, Engineering Governance, Predictive Engineering, Engineering Memory, and Engineering Twin.

---

## Slide 8 — Monorepo Dependency Direction

```
apps/desktop ──▶ @aura/ui ──▶ @aura/core
```

- **`@aura/core`** — zero UI. Design tokens, motion presets, domain types, global store, navigation model. Depends on nothing but `zustand`.
- **`@aura/ui`** — the design system. Pure, reusable, presentational components. Depends only on `core`.
- **`apps/desktop`** — composition layer. Wires design system + store into the real environment.

**Rule: dependencies point inward only.** A feature added tomorrow depends on `ui` + `core`, never the reverse — the foundation can't be broken by a feature.

Packages are consumed **as source** via Vite/TS path aliases — no per-package build step, instant hot-reload across the whole monorepo while still enforcing real module boundaries.

---

## Slide 9 — The 11 Packages

| Package | Role |
|---|---|
| `core` | Design tokens · motion · types · global store · navigation model |
| `ui` | The AURA design system |
| `ai-service` | Provider adapters, pipeline, workflow engine, Mission Control, HTTP+SSE server |
| `automation` | Event-driven automation engine (rules, triggers, action chains) |
| `governance` | Health scoring, drift detection, debt tracking, release readiness |
| `predictive` | Deterministic risk/prediction engines (no ML, no randomness) |
| `engineering-memory` | Persistent engineering memory platform |
| `intelligence` | Intent classification, prompt-enhancement pipeline |
| `retrieval` | Chunking, embeddings, ranking, context-assembly interfaces |
| `knowledge-coding` | AST-based code indexing and search |
| `knowledge-fullstack` | Full-stack entity/relationship extraction, system graph |
| `runtime` | Shared provider-neutral runtime contract |

Plus `apps/desktop` — the React + Vite + Tauri native shell.

---

## Slide 10 — Technology Stack

| Layer | Technology |
|---|---|
| UI framework | React + Vite |
| Native shell | Tauri v2 (Rust core) |
| Styling | Tailwind CSS, CSS custom-property design tokens (zero raw hex) |
| Animation | Framer Motion (shared vocabulary of spring presets) |
| State | Zustand (minimal shell-only global store) |
| Editor | Monaco Editor |
| Language | TypeScript throughout (`type: module`, npm workspaces) |
| Package management | npm workspaces (`apps/*`, `packages/*`) — one install for the entire monorepo |

**Platform support:** macOS, Windows, Linux (`bundle.targets: "all"` in Tauri config) — signed installers not yet published.

---

## Slide 11 — By the Numbers

| Metric | Value |
|---|---|
| Source files (`.ts` / `.tsx`) | **404** |
| Lines of code (TS/TSX) | **~57,500** |
| Workspace packages | **11** + 1 desktop app |
| AI providers supported | **11** (BYOAK) |
| Workflow starter templates | **10** |
| Architecture deep-dive docs | **8** platform docs |
| Documentation files (`docs/`) | **24** |
| Product screenshots (real, captured) | **12 of 14** |
| Total commits | **29** |
| Knowledge-graph size (self-analysis) | **4,469 nodes · 10,657 edges · 211 communities** across 511 files / ~611K words |

---

## Slide 12 — Governance & Team Structure

Single-owner, Maintainer-Driven Development — modeled on Kubernetes / VS Code / React's PR-first, CODEOWNERS-enforced pattern.

| Role | Owns | Push to `main` | Merge PRs | Approve PRs |
|---|---|:---:|:---:|:---:|
| **Repository Owner** ([@Gokulanand-art](https://github.com/Gokulanand-art)) | Architecture, AI Runtime, Knowledge Fabric, final reviews, releases, repo governance | ✅ | ✅ | ✅ |
| **UI-UX Team** | Desktop UI, design system, components, editor UI, animation | 🚫 | 🚫 | Review only |
| **Backend Team** | API, indexing, workflow engine, knowledge APIs | 🚫 | 🚫 | Review only |
| **Database Team** | Persistence, schema, storage, migration, search | 🚫 | 🚫 | Review only |

No direct pushes to `main`, no exceptions. Every change: PR → CODEOWNERS review → all conversations resolved → owner merges.

---

## Slide 13 — Development Workflow

```
git pull origin main
git checkout -b feature/<feature-name>
# develop
git commit   (Conventional Commits: feat(scope): summary, fix(scope): ...)
git push origin feature/<feature-name>
# open a Pull Request → CODEOWNERS review → owner merges
```

- **Branch naming:** `feature/...`, `bugfix/...`, `hotfix/...`, `docs/...`, `refactor/...`
- **CI today:** typecheck + build on every PR (no automated test suite yet — verification is manual, documented per-PR)
- **Requirements:** Node.js ≥18.18, Rust ≥1.77.2 (for native builds), one AI provider API key (Groq offers a free tier)

---

## Slide 14 — Roadmap

**Now (actively hardening):**
- 🚧 Automation Engine UI — backend is real and wired, no dedicated settings surface in-app yet
- 🚧 Test coverage — no automated test suite yet; next reliability investment
- 🚧 Screenshot gallery — 12 of 14 real captures in

**Next:**
- 📅 Signed desktop builds (macOS/Windows/Linux via Tauri — bundling configured, not yet signed/notarized)
- 📅 Provider breadth (new adapter ≈ 15-line file)
- 📅 Knowledge fabric depth — cross-repository linking (today scoped to one open project at a time)
- 📅 Team onboarding — UI-UX / Backend / Database team boundaries already defined, activates once teams have members beyond the owner

**Future (directional):**
- 📅 Public, hosted read-only knowledge-graph/architecture views
- 📅 Plugin/extension surface for third-party workflow node types
- 📅 Multi-repository Mission Control

---

## Slide 15 — Current In-Flight Work (Unreleased on `presentation-v0.1`)

Real, working, pending review before merge to `main`:

- **Mission Control v3** — full DAG execution engine (dependency-aware ordering, blocked/waiting/queued states, critical-path view, replay timeline)
- **Engineering Governance Platform** — drift detection, health scoring, debt tracking, release readiness, security review
- **Predictive Engineering Platform** — deterministic risk prediction from real platform signals (no ML, no randomness)
- **Engineering Memory Platform** — persistent, queryable engineering experience layer
- **Automation Engine** — event-driven workflow layer reacting to real platform moments
- Repository productization: LICENSE, community health files, screenshot gallery infra, changelog
- **CI reliability fix** — every historical CI run had been failing (100%, including `main`) due to committed `.tsbuildinfo` caches lying about build state on fresh checkouts; fixed, CI is green as of this release
- Repository cleanup — untracked ~35MB of unbounded knowledge-graph cache/snapshot growth, removed dead assets and an unused dependency

---

## Slide 16 — Release History

| Release | Date | Highlights |
|---|---|---|
| **Initial commit** | 2026-07-28 | Application shell, design system, project workspace, AI service, knowledge engines |
| **0.1.0 — "AURA Presentation Build"** | 2026-07-31 | First tagged milestone: shell, design system, workspace sections, workflow editor/library, knowledge graph visualization — presentable end-to-end. Added repo governance (CODEOWNERS, PR/issue templates, CI). |
| **Unreleased** | in progress | Mission Control v3, Governance/Predictive/Memory/Automation platforms, CI fix, repo cleanup (see previous slide) |

Pre-1.0 — uses date-based milestone releases rather than strict SemVer; breaking changes can land on any `0.x` release.

---

## Slide 17 — Known Gaps / Risks

Presented transparently, not glossed over:

- **No automated test suite yet** — verification is currently manual, documented per-PR
- **No signed installers** — desktop builds aren't code-signed/notarized; today's only path to running AURA is from source
- **Single-owner bottleneck** — all merge/approval authority sits with one person; team structures are defined but not yet populated
- **Knowledge graph is single-project scoped** — no cross-repository linking yet
- **Screenshot gallery incomplete** — 12 of 14 real captures done, 2 documented gaps remain

---

## Slide 18 — Get AURA Hub

Native desktop app for macOS, Windows, Linux — built on Tauri v2.

**Today, two real paths:**
1. **Run from source** — `git clone` → `npm install` → `npm run tauri dev`. Full native application running locally in a few minutes, not a toy.
2. Public informational site tracks early-access updates as packaged installers become available.

**Requires:** an API key from any one of the 11 supported providers (Groq has a free tier) — nothing AI-related works until a provider is connected.

---

## Slide 19 — Closing / Next Steps

- AURA Hub is a substantial, coherently-architected platform (~57.5K LOC, 11 packages, 8 architecture platforms) still pre-1.0 and single-owner-governed.
- Immediate priorities: land the in-flight `presentation-v0.1` work (Mission Control v3, Governance, Predictive, Memory, Automation) into `main`, then close the two biggest gaps — automated test coverage and signed installers.
- The architecture is explicitly built to support years of development, not a demo — inward-only dependencies, a token-only design system, and shared extension seams already in place for whatever ships next.

---

## Appendix A — Folder Structure

```
aura-hub/
├─ .github/                    # CODEOWNERS, issue/PR templates, CI workflow
├─ docs/                       # architecture, design, governance, screenshots
│  ├─ architecture/            # deep-dive docs per platform
│  └─ assets/                  # brand assets, screenshot gallery spec
├─ examples/                   # real, importable workflow examples
├─ scripts/                    # dev tooling (TS runner, verification, presentation build)
├─ apps/
│  └─ desktop/                 # the environment app (React + Vite + Tauri)
│     ├─ src/shell/            # AppShell, LeftNav, CommandBar, RightPanel, StatusBar
│     ├─ src/ops/               # window manager, floating panels, agent/memory/notification centers
│     ├─ src/screens/           # Home, project workspace, missions, workflows, governance
│     ├─ src/styles/            # global theme layer (CSS variables)
│     └─ src-tauri/             # native desktop wrapper (Rust)
└─ packages/                    # core · ui · ai-service · automation · governance ·
                                 # predictive · engineering-memory · intelligence ·
                                 # retrieval · knowledge-coding · knowledge-fullstack · runtime
```

## Appendix B — Key Links

- Repository: `github.com/Aura-hub-ai-native-workspace/aura-hub`
- License: Apache License 2.0
- Roadmap detail: `ROADMAP.md`, `docs/ROADMAP.md`, `docs/PROJECT_BOARD.md`
- Contribution guide: `CONTRIBUTING.md`, `docs/TEAM_GUIDE.md`
- Architecture deep dives: `docs/architecture/*.md`
- Acknowledgements: React, Vite, Tauri, Tailwind CSS, Framer Motion, Zustand, Monaco Editor

---

*End of report. All figures pulled directly from the current repository state (`presentation-v0.1` branch, working tree) on 2026-08-07 — file counts, LOC, commit counts, and knowledge-graph stats are computed, not estimated.*
