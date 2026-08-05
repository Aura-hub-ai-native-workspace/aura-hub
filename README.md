<div align="center">

<img src="docs/assets/brand/hero-banner.svg" alt="AURA Hub — An AI Operating Environment" width="100%" />

**An AI Operating Environment** — not a chat app, not an editor, not a browser.

[![CI](https://github.com/Aura-hub-ai-native-workspace/aura-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/Aura-hub-ai-native-workspace/aura-hub/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Node](https://img.shields.io/badge/Node-%3E%3D18.18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Quick Start](#quick-start) · [Features](#core-features) · [Screenshots](#product-screenshots) · [Architecture](#product-architecture) · [Installation](#installation) · [Contributing](#contributing) · [Roadmap](ROADMAP.md)

</div>

---

## What is AURA Hub?

Most developer tools give you an editor with an AI panel bolted onto the
side. Ask it something, and it re-derives context from whatever's
currently visible in the buffer — it doesn't know your architecture, it
doesn't remember yesterday's decisions, and every session starts from
zero. The chat window is a guest in someone else's house.

AURA Hub inverts that relationship: **the environment is the product.**
A project opened in AURA gets a persistent, structural understanding of
itself — a knowledge graph built from real static analysis, not a
best-effort text search — before any model is ever called. Engineering
work (multi-step missions, workflow automation, architecture review,
governance) runs as first-class, resumable, inspectable processes, not
one-shot chat completions. And the AI itself is never locked to one
vendor: AURA has no built-in model and no hidden API account — you bring
your own key to whichever provider you trust, and the entire platform,
every feature, works identically regardless of which one you pick.

## Why AURA Hub?

- **Grounded, not guessed.** Every AI answer is built on a real,
  incrementally-updated knowledge graph and system model — entities,
  relations, layers, health scores — computed once and queried, never
  reconstructed from a raw file dump on every keystroke.
- **Deterministic where it can be, probabilistic only where it must be.**
  Questions with one checkable answer (is this actually dead code, did
  this diff remove a public export) are answered by real parsing and
  arithmetic. The model's job is narrowed to what only a model can do:
  explain a cause in prose, draft a plausible patch.
- **No vendor lock-in.** Eleven AI providers are supported today through
  one shared adapter interface. Switching providers — or model, mid
  conversation — is a first-class, validated operation, never a
  reconfiguration.
- **Engineering memory that compounds.** Decisions, patterns, and
  learnings persist across sessions and inform future answers, instead
  of every conversation starting over.
- **Built for scale from day one.** A strict, inward-only dependency
  direction (`apps/desktop → @aura/ui → @aura/core`), a design system
  with zero raw hex values, and an architecture explicitly designed to
  support years of development rather than a demo. See
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full rationale.

## Core Features

| Feature | What it is |
|---|---|
| 🪟 **Workspace / Window Manager** | A floating-window "second desktop" inside the app — dock, float, tile, and switch between panels (AI Chat, Files, Architecture, Knowledge, Missions, and more) instead of one fixed layout. |
| 🧭 **Mission Control** | Plans and executes multi-step engineering work as a real dependency-aware DAG — auto-ordered task waves, blocked/queued/running states, a critical-path view, and a full replay timeline. Every task still requires explicit human approval before it runs, and every proposal requires explicit **Accept** before anything is written. |
| 🤖 **AI Workflow Builder** | Describe an automation in plain language; AURA generates a real, validated, runnable node graph against the platform's actual node registry — never an invented node type, never a half-broken graph. |
| ⚙️ **Automation Studio** | A visual, node-based workflow engine with 10 real starter templates (code review, security audit, bug investigation, release notes, and more — see [`examples/`](examples/)) plus an event-driven automation layer that reacts to real platform moments (mission completed, PR merged, dependency changed). |
| 🧠 **Knowledge Graph** | AST-based static analysis (`graphify`) builds a real knowledge graph of your codebase — god-node detection, community structure, cross-file relationship queries — incrementally updated, not re-scanned from scratch. |
| 🏗️ **Architecture Blueprint** | A layered, structural view of the system — modules, dependencies, boundaries — distinct from the raw code graph, built from the same real analysis. |
| 🧩 **Engineering Intelligence** | The umbrella layer tying knowledge, governance, and prediction together: health scoring, architecture drift detection, technical debt tracking, and deterministic risk prediction — all evidence-based, zero fabricated metrics. |
| 💾 **Engineering Memory** | A persistent, queryable memory of engineering decisions, patterns, and learnings — grounded in real project history, so the platform gains experience instead of re-deriving everything every session. |
| 🔌 **Multi-Provider AI** | Eleven BYOAK (bring-your-own-key) providers behind one shared adapter interface — OpenAI, Anthropic, Gemini, Groq, Mistral, Cerebras, Kimi, NVIDIA, OpenRouter, Novita, and Qwen. Adding a provider is a small, self-contained adapter, not a rewrite. |

<details>
<summary><strong>How these fit together</strong> (click to expand)</summary>

<br>

Nothing above is a separate product bolted on. **Every** AI-backed
feature — chat, Ctrl+I inline actions, the Workflow Builder, Mission
Control, Diagnosis — funnels through the same three pipeline entry
points (`ask`, `generate`, `streamEvents` in
`packages/ai-service/src/pipeline.ts`), which means provider validation,
error translation, retry/timeout handling, and context assembly are
implemented **once** and apply **everywhere**, automatically, including
to features built after this sentence was written.

</details>

## Product Screenshots

> 📸 Real, live captures of the running app against this repository —
> not mockups. One slot (Mission Execution DAG) is still pending; see
> [`docs/assets/screenshots/SCREENSHOT_GUIDE.md`](docs/assets/screenshots/SCREENSHOT_GUIDE.md)
> for the exact capture spec and an honest note on two substituted shots.

| | |
|---|---|
| ![Application Shell & Home](docs/assets/screenshots/01-app-shell-home.png) **Application Shell & Home**<br>The full environment on first launch — navigation, command bar, and the project list. | ![Window Manager](docs/assets/screenshots/02-window-manager-workspace.png) **Window Manager**<br>Floating panels — AI Chat, Mission Control — tiled together inside one project workspace. |
| ![AI Chat](docs/assets/screenshots/03-ai-chat.png) **AI Chat**<br>A grounded conversation, showing which knowledge engines and provider were used. | ![Mission Control](docs/assets/screenshots/04-mission-control.png) **Mission Control**<br>A real, live-created mission — checkpoints, execution waves, deterministic health signals. |
| ![AI Workflow Builder](docs/assets/screenshots/06-ai-workflow-builder.png) **AI Workflow Builder**<br>Natural language turned into a real, validated automation graph. | ![Automation Studio](docs/assets/screenshots/07-automation-studio.png) **Automation Studio**<br>The workflow library — real templates with real node/date metadata. |
| ![Knowledge / Intelligence](docs/assets/screenshots/08-knowledge-graph.png) **Knowledge Intelligence**<br>Live verification score, validation score, and repository statistics. | ![Architecture Blueprint](docs/assets/screenshots/09-architecture-blueprint.png) **Architecture Blueprint**<br>Layered module structure and dependency boundaries. |
| ![Engineering Memory](docs/assets/screenshots/10-engineering-memory.png) **Engineering Memory**<br>50 real persisted memories — decisions, learnings, agent proposals — filterable by kind and severity. | ![Engineering Intelligence](docs/assets/screenshots/11-engineering-governance.png) **Engineering Intelligence**<br>Module/dependency/API-surface counts derived from the real repository. |
| ![Multi-Provider AI Settings](docs/assets/screenshots/12-provider-settings.png) **Multi-Provider AI**<br>Five real BYOAK providers connected, one active, model discovery live. | ![Command Bar](docs/assets/screenshots/13-command-palette.png) **Command Bar**<br>Keyboard-first navigation across the whole environment. |
| ![Project Dashboard](docs/assets/screenshots/14-project-dashboard.png) **Project Dashboard**<br>A single project's real indexed stats — files, chunks, entities, languages. | |

## Product Architecture

```mermaid
graph TD
    subgraph Desktop["apps/desktop — React 18 + Vite + Tauri v2"]
        Shell["App Shell<br/>nav · command bar · status bar"]
        Workspace["Window Manager<br/>dockable, floating panels"]
        Screens["Mission Control · Workflows ·<br/>Governance · Knowledge · Settings"]
    end

    subgraph Design["Design System"]
        UI["@aura/ui<br/>components, themeable"]
        Core["@aura/core<br/>tokens · motion · store · nav model"]
    end

    subgraph Backend["packages/ai-service — local HTTP + SSE (127.0.0.1:4319)"]
        Pipeline["Pipeline Manager<br/>ask · generate · streamEvents"]
        Provider["Provider Adapters<br/>BYOAK, validated"]
        Workflow["Workflow Engine<br/>+ AI Workflow Builder"]
        Mission["Mission Control v3<br/>DAG execution"]
    end

    subgraph Intelligence["Engineering Intelligence"]
        Knowledge["Knowledge Engines<br/>coding · fullstack"]
        Governance["Governance Platform"]
        Predictive["Predictive Engineering"]
        Memory["Engineering Memory"]
        Automation["Automation Engine"]
    end

    Providers[("OpenAI · Anthropic · Gemini · Groq<br/>Mistral · Cerebras · Kimi · NVIDIA<br/>OpenRouter · Novita · Qwen")]

    Desktop --> Design
    Desktop -->|"HTTP + SSE"| Backend
    Backend --> Intelligence
    Provider -->|"direct, encrypted key,<br/>never proxied"| Providers
```

Dependencies point **inward only** — the design system and core never
depend on a feature, and a feature never reaches past the pipeline into
a provider directly. Full rationale, state architecture, and extension
points: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Design language
and theming: [`docs/DESIGN.md`](docs/DESIGN.md). Provider system detail:
[`docs/architecture/PROVIDER_INTEGRATION.md`](docs/architecture/PROVIDER_INTEGRATION.md).

<details>
<summary><strong>Every platform, in depth</strong> (click to expand)</summary>

<br>

| Platform | Doc |
|---|---|
| Mission Control v3 (execution engine) | [`docs/architecture/MISSION_CONTROL_V3.md`](docs/architecture/MISSION_CONTROL_V3.md) |
| Provider Integration (BYOAK runtime) | [`docs/architecture/PROVIDER_INTEGRATION.md`](docs/architecture/PROVIDER_INTEGRATION.md) |
| Automation Engine | [`docs/architecture/AUTOMATION_ENGINE.md`](docs/architecture/AUTOMATION_ENGINE.md) |
| Engineering Intelligence Platform | [`docs/architecture/ENGINEERING_INTELLIGENCE_PLATFORM.md`](docs/architecture/ENGINEERING_INTELLIGENCE_PLATFORM.md) |
| Engineering Governance Platform | [`docs/architecture/ENGINEERING_GOVERNANCE_PLATFORM.md`](docs/architecture/ENGINEERING_GOVERNANCE_PLATFORM.md) |
| Predictive Engineering Platform | [`docs/architecture/PREDICTIVE_ENGINEERING.md`](docs/architecture/PREDICTIVE_ENGINEERING.md) |
| Engineering Memory Platform | [`docs/architecture/ENGINEERING_MEMORY_ARCHITECTURE.md`](docs/architecture/ENGINEERING_MEMORY_ARCHITECTURE.md) |
| Engineering Twin | [`docs/architecture/ENGINEERING_TWIN.md`](docs/architecture/ENGINEERING_TWIN.md) |

</details>

## Technology Stack

<table>
<tr><td><strong>Frontend</strong></td><td>React 18.3 · TypeScript 5.4 · Vite 5.3 · Tailwind CSS 3.4 · Framer Motion · Zustand · Monaco Editor</td></tr>
<tr><td><strong>Backend</strong></td><td>Node.js ≥18.18 · a flat <code>http.createServer</code> router (no framework) + Server-Sent Events for streaming</td></tr>
<tr><td><strong>AI</strong></td><td>Provider-agnostic BYOAK runtime — 11 adapters (OpenAI, Anthropic, Gemini, Groq, Mistral, Cerebras, Kimi, NVIDIA, OpenRouter, Novita, Qwen) behind one shared interface</td></tr>
<tr><td><strong>Storage</strong></td><td>Local filesystem only — encrypted (AES-256-GCM) credential store, JSON-backed project/mission/memory/automation state under <code>~/.aura</code>. No external database.</td></tr>
<tr><td><strong>Native shell</strong></td><td>Tauri v2 (Rust 1.77+) — thin native core, small binaries, the same web build runs in-browser or natively</td></tr>
<tr><td><strong>Monorepo</strong></td><td>npm workspaces + TypeScript project references — packages are consumed as source, no per-package build step, instant HMR</td></tr>
<tr><td><strong>CI</strong></td><td>GitHub Actions — typecheck + production build on every PR</td></tr>
</table>

## Installation

### Requirements

| Requirement | Version | Needed for |
|---|---|---|
| [Node.js](https://nodejs.org) | ≥ 18.18 | Everything |
| npm | bundled with Node | Workspace installs |
| [Rust](https://www.rust-lang.org/tools/install) | ≥ 1.77.2 | Native desktop builds only (`npm run tauri`) — not needed for browser dev |
| An API key from **any one** supported AI provider | — | AI features. AURA has no built-in model — nothing AI-related works until you connect one. |

**Platform support:** macOS, Windows, and Linux via Tauri v2
(`bundle.targets: "all"` in `apps/desktop/src-tauri/tauri.conf.json`).
Signed installers are not yet published — see [`ROADMAP.md`](ROADMAP.md).

### Clone & install

```bash
git clone https://github.com/Aura-hub-ai-native-workspace/aura-hub.git
cd aura-hub
npm install   # npm workspaces — one install for the entire monorepo
```

### Run — development

```bash
# fastest path — no Rust needed, runs in the browser
npm run dev              # → http://localhost:1420

# native desktop window (requires the Rust toolchain)
npm run tauri dev

# the local AI service (provider adapters, pipeline, workflow engine)
npm run ai                # → http://127.0.0.1:4319
```

> The UI is identical in both modes — Vite serves the React environment
> directly, and Tauri just hosts that same build in a native window. You
> can build and verify 100% of the shell with `npm run dev` alone.

### Run — production

```bash
npm run build        # type-check + production web build
npm run tauri build  # package native installers (needs Rust + platform build tools)
```

Other scripts:

```bash
npm run typecheck   # project-wide TypeScript build, no emit
npm run clean        # remove node_modules and dist across the workspace
```

## Quick Start

1. **Connect a provider.** Open **Settings → AI Provider**, choose any
   supported provider, and paste your API key. Groq offers a free tier
   if you don't have a key handy. AURA validates the key, discovers its
   available models, and activates it — see
   [`docs/architecture/PROVIDER_INTEGRATION.md`](docs/architecture/PROVIDER_INTEGRATION.md).
2. **Add a project.** From Home, point AURA at a local folder. It's
   indexed by the Coding and FullStack knowledge engines automatically —
   no separate "start indexing" step.
3. **Open the workspace.** Opening a project drops you into its window
   manager — float or dock panels for AI Chat, Files, Architecture, and
   Knowledge as you need them.
4. **Chat with AI.** Ask a real question about the project in **AI
   Chat**. Answers are grounded in the knowledge graph, not just
   whatever's in the prompt.
5. **Create a workflow.** Open the **AI Workflow Builder** and describe
   an automation in plain language — or instantiate one of the 10 real
   templates in the Workflow Library (see [`examples/`](examples/)).
6. **Run it.** Execute the workflow against your open project and watch
   real node-by-node progress on the canvas.

## Folder Structure

```
aura-hub/
├─ .github/                    # CODEOWNERS, issue/PR templates, CI workflow
├─ docs/                       # architecture, design, governance, screenshots
│  ├─ architecture/            # deep-dive docs per platform (Mission Control, Providers, Governance, …)
│  └─ assets/                  # brand assets, screenshot gallery spec
├─ examples/                   # real, importable workflow examples (see examples/README.md)
├─ scripts/                    # dev tooling (TS runner, verification scripts, presentation build)
├─ apps/
│  └─ desktop/                 # the environment app (React + Vite + Tauri)
│     ├─ src/
│     │  ├─ shell/             # AppShell, LeftNav, CommandBar, RightPanel, StatusBar
│     │  ├─ ops/                # window manager, floating panels, agent/memory/notification centers
│     │  ├─ screens/            # Home, project workspace, missions, workflows, governance
│     │  └─ styles/             # global theme layer (CSS variables)
│     └─ src-tauri/             # native desktop wrapper (Rust)
└─ packages/
   ├─ core/                    # tokens · motion · types · global store · navigation model
   ├─ ui/                      # the AURA design system
   ├─ ai-service/               # provider adapters, pipeline, workflow engine, mission control, HTTP+SSE server
   ├─ automation/                # event-driven automation engine (rules, triggers, action chains)
   ├─ governance/                # engineering governance platform (health, drift, debt, release readiness)
   ├─ predictive/                # predictive engineering (deterministic risk/prediction engines)
   ├─ engineering-memory/        # persistent engineering memory platform
   ├─ intelligence/              # intent classification, prompt enhancement pipeline
   ├─ retrieval/                 # chunking, embeddings, ranking, context assembly interfaces
   ├─ knowledge-coding/          # AST-based code indexing and search
   ├─ knowledge-fullstack/       # full-stack entity/relationship extraction, system graph
   └─ runtime/                   # shared provider-neutral runtime contract
```

Workspace packages are consumed **as source** (via Vite/TS path
aliases) — editing any package hot-reloads instantly, no per-package
build step.

## Roadmap

See [`ROADMAP.md`](ROADMAP.md) for the current Now / Next / Future
direction, and [`docs/ROADMAP.md`](docs/ROADMAP.md) for execution-level
tracking detail. Status legend used throughout this repo: ✅ Implemented
· 🚧 In Progress · 📅 Planned.

## Contributing

AURA is a **Maintainer-Driven Development** project — every change goes
through a Pull Request and requires CODEOWNERS approval before merging
into `main`. No direct pushes, no exceptions.

| | |
|---|---|
| **Commit format** | [Conventional Commits](https://www.conventionalcommits.org/) — `feat(scope): summary`, `fix(scope): summary`, etc. |
| **Branch naming** | `feature/...`, `bugfix/...`, `hotfix/...`, `docs/...`, `refactor/...` — see [`CONTRIBUTING.md`](CONTRIBUTING.md#branch-naming) |
| **Code style** | [`docs/CODE_STYLE.md`](docs/CODE_STYLE.md) |
| **Review process** | PR → CODEOWNERS review → all conversations resolved → owner merges. See [`docs/BRANCH_PROTECTION.md`](docs/BRANCH_PROTECTION.md) for the exact `main` protection rules. |

Start here: [`CONTRIBUTING.md`](CONTRIBUTING.md) ·
[`docs/TEAM_GUIDE.md`](docs/TEAM_GUIDE.md) ·
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) ·
[`SUPPORT.md`](SUPPORT.md)

## Security

Found a vulnerability? Please don't open a public issue — see
[`SECURITY.md`](SECURITY.md) for how to report it responsibly.

## Release Notes

See [`CHANGELOG.md`](CHANGELOG.md) for what's shipped on this branch,
release by release.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

## Acknowledgements

AURA Hub is built on the shoulders of [React](https://react.dev),
[Vite](https://vitejs.dev), [Tauri](https://tauri.app),
[Tailwind CSS](https://tailwindcss.com), [Framer Motion](https://www.framer.com/motion/),
[Zustand](https://github.com/pmndrs/zustand), and [Monaco Editor](https://microsoft.github.io/monaco-editor/)
— and on every AI provider whose API it integrates with as a first-class,
validated citizen rather than an afterthought.

Governance model inspired by the Pull-Request-first, CODEOWNERS-enforced
patterns used by Kubernetes, VS Code, and React.
