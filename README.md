# AURA Hub

**An AI Operating Environment** — not a chat app, not an editor, not a browser.
This repository contains the **complete application shell and architecture**: the
premium environment where intelligence will later live. There is intentionally
**no AI, RAG, or business logic** yet — only clean extension points for it.

---

## Quick start

```bash
# 1. install (npm workspaces — one install for the whole monorepo)
npm install

# 2a. run the environment in the browser (fastest — no Rust needed)
npm run dev            # → http://localhost:1420

# 2b. run it as a native desktop app (requires the Rust toolchain)
npm run tauri dev
```

> The UI layer is identical in both modes. Vite serves the React
> environment directly; Tauri simply hosts that same build in a native
> window. You can build 100% of the shell with `npm run dev` alone.

Other scripts:

```bash
npm run build       # type-check + production web build
npm run typecheck   # project-wide TypeScript build (no emit)
npm run tauri build # package native installers (needs Rust + icons)
```

---

## What's inside

| Area | Delivered |
| --- | --- |
| **App shell** | Left nav · top command bar · main workspace · collapsible right context panel · status bar |
| **Design system** (`@aura/ui`) | Button, IconButton, Card, Input, Panel, Dialog, Menu, Dropdown, Table, Tabs, List, Badge, Progress/Ring, Skeleton, Tooltip, Toast, Command Palette + a bespoke icon set |
| **Motion system** (`@aura/core`) | Spring presets, page/stagger/pop variants, reduced-motion aware |
| **Home** | Premium bento dashboard — welcome, continue working, running tasks, activity, knowledge, quick actions, model status |
| **Project workspace** | Own environment per project with 10 tabs (Overview built out, rest reserved) |
| **Theming** | Light + dark via runtime CSS variables — retheme without a rebuild |
| **Native wrapper** | Tauri v2 (thin Rust core, one clean OS seam) |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full architectural
rationale and extension points, and [`docs/DESIGN.md`](docs/DESIGN.md) for the
design language.

---

## Monorepo layout

```
aura-hub/
├─ apps/
│  └─ desktop/            # the environment app (React + Vite + Tauri)
│     ├─ src/
│     │  ├─ shell/        # AppShell, LeftNav, CommandBar, RightPanel, StatusBar
│     │  ├─ screens/      # Home, Projects, project workspace, placeholders
│     │  └─ styles/       # global theme layer (CSS variables)
│     └─ src-tauri/       # native desktop wrapper
├─ packages/
│  ├─ core/               # tokens · motion · types · store · navigation · mock data
│  └─ ui/                 # the AURA design system (components, icons, hooks)
└─ docs/                  # architecture + design documentation
```

Workspace packages are consumed **as source** (via Vite/TS path aliases), so
editing `@aura/ui` hot-reloads instantly with no per-package build step.
