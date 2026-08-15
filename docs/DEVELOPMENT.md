# Development Guide

This document is for people building or contributing to AURA Hub
itself — not for people using the app. If you just want to run AURA
Hub, see the main [README](../README.md#get-aura-hub).

## Requirements

| Requirement | Version | Needed for |
|---|---|---|
| [Node.js](https://nodejs.org) | ≥ 18.18 | Everything |
| npm | bundled with Node | Workspace installs |
| [Rust](https://www.rust-lang.org/tools/install) | ≥ 1.77.2 | Building the native desktop app |
| An API key from any one supported AI provider | — | AI features — AURA has no built-in model |

**Platform support:** macOS, Windows, and Linux via Tauri v2
(`bundle.targets: "all"` in `apps/desktop/src-tauri/tauri.conf.json`).
Signed installers are not yet published — see [`ROADMAP.md`](../ROADMAP.md).

## Clone & install

```bash
git clone https://github.com/Aura-hub-ai-native-workspace/aura-hub.git
cd aura-hub
npm install   # npm workspaces — one install for the entire monorepo
```

## Run — development

```bash
# native desktop window (requires the Rust toolchain) — this is the real app
npm run tauri dev

# browser-only shell, for fast UI iteration without Rust
npm run dev               # → http://localhost:1420

# the local AI service (provider adapters, pipeline, workflow engine)
npm run ai                 # → http://127.0.0.1:4319
```

The interface is identical in both modes — Vite serves the React
environment, and Tauri hosts that same build in a native window.
`npm run dev` is a development convenience for iterating on the UI
without the Rust toolchain, not a second product; `npm run tauri dev`
is how AURA Hub actually runs.

## Run — production

```bash
npm run build        # type-check + production build
npm run tauri build  # package native installers (needs Rust + platform build tools)
```

Other scripts:

```bash
npm run typecheck   # project-wide TypeScript build, no emit
npm run clean        # remove node_modules and dist across the workspace
```

## Technology Stack

| Layer | Stack |
|---|---|
| Frontend | React 18.3 · TypeScript 5.4 · Vite 5.3 · Tailwind CSS 3.4 · Framer Motion · Zustand · Monaco Editor |
| Backend | Node.js ≥18.18 · a flat `http.createServer` router (no framework) + Server-Sent Events for streaming |
| AI | Provider-agnostic BYOAK runtime — 11 adapters (OpenAI, Anthropic, Gemini, Groq, Mistral, Cerebras, Kimi, NVIDIA, OpenRouter, Novita, Qwen) behind one shared interface |
| Storage | Local filesystem only — encrypted (AES-256-GCM) credential store, JSON-backed state under `~/.aura`. No external database. |
| Native shell | Tauri v2 (Rust 1.77+) — thin native core, small binaries |
| Monorepo | npm workspaces + TypeScript project references — packages are consumed as source, no per-package build step, instant HMR |
| CI | GitHub Actions — typecheck + production build on every PR |

## Folder Structure

```
aura-hub/
├─ .github/                    # CODEOWNERS, issue/PR templates, CI workflow
├─ docs/                       # architecture, design, governance, screenshots
│  ├─ architecture/            # deep-dive docs per platform (Mission Control, Providers, Governance, …)
│  └─ assets/                  # brand assets, screenshot gallery spec
├─ examples/                   # real, importable workflow examples (see examples/README.md)
├─ scripts/                    # dev tooling (TS runner, verification scripts, presentation build)
├─ website/                    # the marketing site (website/README.md for deploy instructions)
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

Workspace packages are consumed as source (via Vite/TS path aliases) —
editing any package hot-reloads instantly, no per-package build step.

## Architecture (technical detail)

The system-level architecture diagram, dependency direction, state
model, and extension points live in [`ARCHITECTURE.md`](ARCHITECTURE.md).
Provider system detail: [`architecture/PROVIDER_INTEGRATION.md`](architecture/PROVIDER_INTEGRATION.md).
Design language and theming: [`DESIGN.md`](DESIGN.md).

## Contributing

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the PR process, commit
format, branch naming, and code style, and
[`docs/TEAM_GUIDE.md`](TEAM_GUIDE.md) for ownership boundaries.
