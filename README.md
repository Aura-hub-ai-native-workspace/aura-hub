# AURA Hub

**An AI Operating Environment** — not a chat app, not an editor, not a
browser. AURA is a premium native/web environment where AI-native
project intelligence lives: knowledge graphs, workflow automation, and
provider-agnostic AI runtime, all inside one coherent shell.

[![CI](https://github.com/Aura-hub-ai-native-workspace/aura-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/Aura-hub-ai-native-workspace/aura-hub/actions/workflows/ci.yml)

---

## Vision

Most developer tools are either a chat window bolted onto an editor, or
an editor with an assistant panel bolted on. AURA inverts that: the
**environment** is the product. Projects are first-class objects with
their own workspace — knowledge graph, backend, database, workflows,
memory, research — and AI is a capability woven through all of them,
not a separate mode.

## Features

- **Application shell** — left nav, command bar, collapsible context
  panel, status bar; a fixed frame hosting interchangeable project
  surfaces (state-driven navigation, not URL routing)
- **Project workspace** — per-project tabs: Overview, Architecture,
  Backend, Database, Frontend, Knowledge, Memory, Research, Tasks,
  Deployment, Documentation, Settings
- **Knowledge fabric** — AST-based knowledge graphs (`graphify`) with
  god-node detection, community structure, and cross-file relationship
  queries
- **AI runtime** — provider-agnostic adapters (Anthropic, OpenAI, Gemini,
  Groq, Mistral, NVIDIA, OpenRouter, Kimi) with model discovery, streaming,
  and credential management
- **Workflow engine** — node-based automation with templates and a
  visual editor
- **Retrieval layer** — chunking, embeddings, ranking, and context
  assembly across chat/coding/fullstack/research engines
- **Design system** (`@aura/ui`) — Button, Card, Dialog, Menu, Dropdown,
  Table, Tabs, Command Palette, and a bespoke icon set, themeable at
  runtime (light/dark, no rebuild)
- **Native wrapper** — Tauri v2, thin Rust core, one clean OS seam

## Architecture

```
apps/desktop ──▶ @aura/ui ──▶ @aura/core
                    │             ▲
                    └─────────────┘

packages/ai-service ──▶ provider adapters, workflow engine, intelligence
packages/retrieval   ──▶ chunking, embeddings, ranking, context assembly
packages/knowledge-coding / knowledge-fullstack ──▶ indexing, graph store, search
packages/intelligence ──▶ intent classification, prompt enhancement
packages/runtime     ──▶ shared runtime contracts
```

Dependencies point inward only — the design system and core never
depend on a feature. Full rationale, state architecture, and extension
points: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Design language:
[`docs/DESIGN.md`](docs/DESIGN.md).

## Screenshots

<!-- Add screenshots or a short demo GIF of the shell + a project workspace here before the v0.1 presentation. -->

## Roadmap

Current milestone: **`AURA Presentation v0.1`**. Full roadmap and
sequencing: [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Development setup

```bash
# 1. install (npm workspaces — one install for the whole monorepo)
npm install

# 2a. run the environment in the browser (fastest — no Rust needed)
npm run dev            # → http://localhost:1420

# 2b. run it as a native desktop app (requires the Rust toolchain)
npm run tauri dev

# 2c. run the AI service (bundles + starts packages/ai-service)
npm run ai
```

> The UI layer is identical in both modes. Vite serves the React
> environment directly; Tauri simply hosts that same build in a native
> window. You can build 100% of the shell with `npm run dev` alone.

Other scripts:

```bash
npm run build       # type-check + production web build
npm run typecheck   # project-wide TypeScript build (no emit)
npm run tauri build # package native installers (needs Rust + icons)
npm run clean       # remove node_modules and dist across the workspace
```

## Contributing

AURA is a **Maintainer-Driven Development** project — every change goes
through a Pull Request and requires CODEOWNERS approval before merging
into `main`. No direct pushes, no exceptions.

Start here:
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — workflow, branch naming, commit convention
- [`docs/TEAM_GUIDE.md`](docs/TEAM_GUIDE.md) — teams, ownership, permissions
- [`docs/CODE_STYLE.md`](docs/CODE_STYLE.md) — code style and formatting
- [`docs/BRANCH_PROTECTION.md`](docs/BRANCH_PROTECTION.md) — exact `main` protection settings
- [`docs/PROJECT_BOARD.md`](docs/PROJECT_BOARD.md) — how work is tracked

## Repository structure

```
aura-hub/
├─ .github/               # CODEOWNERS, PR/issue templates, CI workflows
├─ docs/                  # architecture, design, team, roadmap, governance docs
├─ apps/
│  └─ desktop/            # the environment app (React + Vite + Tauri)
│     ├─ src/
│     │  ├─ shell/        # AppShell, LeftNav, CommandBar, RightPanel, StatusBar
│     │  ├─ screens/      # Home, Projects, project workspace, workflows
│     │  └─ styles/       # global theme layer (CSS variables)
│     └─ src-tauri/       # native desktop wrapper
└─ packages/
   ├─ core/                  # tokens · motion · types · store · navigation
   ├─ ui/                    # the AURA design system
   ├─ ai-service/            # provider adapters, workflow engine, server
   ├─ intelligence/          # intent classification, prompt enhancement
   ├─ retrieval/             # chunking, embeddings, ranking, context assembly
   ├─ knowledge-coding/      # code indexing and search
   ├─ knowledge-fullstack/   # full-stack extraction and graph store
   └─ runtime/               # shared runtime contracts
```

Workspace packages are consumed **as source** (via Vite/TS path aliases),
so editing any package hot-reloads instantly with no per-package build
step.

## License

No license has been published yet — all rights reserved by the
repository owner pending a license decision. Do not redistribute.

## Future plans

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for AI runtime hardening,
knowledge fabric depth, workflow engine persistence, signed desktop
builds, and team onboarding once UI-UX, Backend, and Database teams are
staffed.
