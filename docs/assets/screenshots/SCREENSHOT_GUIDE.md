# Screenshot Guide

This directory holds the product screenshots referenced by the
[README](../../../README.md)'s gallery. It is intentionally empty of
images right now — **every screenshot below is a real, un-photographed
surface of the app**, not a mockup. This guide is the exact spec for
capturing them so the gallery reads as one consistent, professional set
instead of a pile of mismatched grabs from different sessions, themes,
and window sizes.

The README links to the stable filenames listed below. Once a screenshot
is captured and dropped into this folder under its named file, it appears
in the README automatically — **no documentation changes required.**

Do not use stock photography, AI-generated UI mockups, or screenshots of
a different product. Every image here must be a real capture of AURA Hub
running against a real project.

---

## Global capture standard

Apply this to every screenshot in the gallery, no exceptions:

| Setting | Value |
|---|---|
| **App window size** | 1440×900 (the app's default Tauri window size — `apps/desktop/src-tauri/tauri.conf.json`) |
| **Export resolution** | 2× (2880×1800), downscaled to 1440 wide on export — crisp on retina/high-DPI displays |
| **Theme** | Dark theme, unless the shot's purpose is specifically to show theming |
| **OS chrome** | None — crop to the app's own window content, no OS title bar / dock / taskbar |
| **Cursor** | Hidden, unless a shot is specifically demonstrating an interaction (e.g. a menu open under a click) |
| **Sample project** | One consistent, realistic sample project across *every* screenshot (see below) — never a different repo per shot, never a project named "test," "demo," or "untitled" |
| **AI provider state** | A provider genuinely connected and active (any real BYOAK provider) — never the "No provider connected" empty state, unless that specific shot's purpose is to show onboarding |
| **Populated state only** | No empty states, no zero-data placeholders, no lorem ipsum — every panel must show real, substantial content |
| **Format** | PNG, no compression artifacts |

**Sample project recommendation:** capture every screenshot against AURA
Hub's *own* repository (`aura-hub`) opened as the active project. It's a
genuinely substantial, real, professionally-structured TypeScript monorepo
— using it means every knowledge graph, architecture view, and memory
screenshot shows real, accurate, defensible output instead of a
throwaway fixture repo. It also means the screenshots stay accurate
forever: as the product evolves, re-capturing against the same repo
keeps the gallery honest.

---

## Shot list

### 01 — Application Shell & Home

- **Purpose:** First impression — establishes the overall environment, not just a feature.
- **Description:** The full app shell (left nav, command bar, status bar) with the Home screen showing the project list.
- **Camera / frame:** Full window, 1440×900, nothing cropped.
- **Window layout:** Default Home screen, left nav expanded.
- **UI state:** At least 2–3 real projects listed (not just `aura-hub` alone) so the screen doesn't look empty; status bar showing an active, connected AI provider.
- **Data:** Real project cards with names, not placeholder text.
- **Filename:** `01-app-shell-home.png`

### 02 — Window Manager (floating workspace)

- **Purpose:** AURA's floating-window "second desktop" model — the thing that makes it an *environment*, not a single-pane app.
- **Description:** The workspace canvas (`apps/desktop/src/ops/WorkspaceCanvas.tsx`) with 3–4 floating panels open simultaneously and the window switcher visible.
- **Camera / frame:** Full window.
- **Window layout:** At least 3 floating panels arranged so none fully occlude another — e.g. AI Chat panel, Architecture panel, and Files panel, tiled or cascaded.
- **UI state:** Window switcher (`WindowSwitcher.tsx`) visible showing multiple open windows; at least one panel mid-interaction (e.g. a scrolled list, not the panel's default empty scroll position).
- **Data:** Real content in every open panel — no blank panels.
- **Filename:** `02-window-manager-workspace.png`

### 03 — AI Chat (Ask AURA)

- **Purpose:** The core AI interaction surface, grounded in real project context.
- **Description:** The AI Workspace / Ask AURA panel mid-conversation, with the "grounded in" context strip visible (engines used, provider, latency).
- **Camera / frame:** The AI Chat panel, reasonably large (not a tiny floating tile) — either full-window docked or a large floating panel.
- **Window layout:** Single focused panel, or docked within the workspace.
- **UI state:** A real question asked, a completed (not mid-stream) answer with markdown formatting, citations/engine badges, and the latency/provider footer all visible.
- **Data:** A substantive real question about the sample project (e.g. "Explain the provider validation architecture") with a real, multi-paragraph grounded answer — not "hi"/"hello."
- **Filename:** `03-ai-chat.png`

### 04 — Mission Control

- **Purpose:** Shows AURA planning and executing multi-step engineering work, not just chatting.
- **Description:** Mission Control's dashboard (`screens/missions/MissionControl.tsx`) — list of missions with statuses.
- **Camera / frame:** Full window or full docked screen.
- **Window layout:** Mission list view, not a single mission's detail.
- **UI state:** Multiple missions in different real states (e.g. completed, in-progress, blocked) — demonstrates the state model, not just one green checkmark.
- **Data:** Real, descriptive mission titles tied to genuine engineering tasks on the sample project.
- **Filename:** `04-mission-control.png`

### 05 — Mission Execution (DAG + Timeline)

- **Purpose:** The v3 execution engine's signature feature — dependency-aware task ordering, not a flat to-do list.
- **Description:** A single mission's detail view (`MissionDetail.tsx` / `WorkflowCanvas.tsx`) showing the task DAG with wave/dependency structure, plus the timeline/replay strip.
- **Camera / frame:** Full window, focused on the DAG canvas.
- **Window layout:** Mission detail, DAG tab active.
- **UI state:** A mission with at least 6–8 tasks across 2+ dependency waves, at least one task in each of a few different states (completed/running/blocked/queued) so the color-coding is legible.
- **Data:** Real task names describing real engineering steps.
- **Filename:** `05-mission-execution-dag.png`

### 06 — AI Workflow Builder

- **Purpose:** Natural-language-to-automation — a flagship differentiator.
- **Description:** The AI Builder panel (`screens/workflows/AiBuilderPanel.tsx`) docked beside a freshly generated workflow graph on the canvas.
- **Camera / frame:** Full window — builder chat on one side, generated graph on the canvas.
- **Window layout:** Workflow editor with the AI Builder panel open.
- **UI state:** A real natural-language prompt in the chat, a real generated graph on the canvas (several connected nodes, not 2 boxes), builder's "Built X — N nodes, N connections" confirmation message visible.
- **Data:** Use one of the real shipped templates as the target shape (e.g. "Fetch a URL and summarize its content") so the result is guaranteed to be a good-looking, valid graph — see `examples/README.md` for the real template catalog.
- **Filename:** `06-ai-workflow-builder.png`

### 07 — Automation Studio (workflow library)

- **Purpose:** Shows the breadth of reusable automation, not just one graph.
- **Description:** The Workflow Library (`screens/workflows/WorkflowLibrary.tsx`) — grid/list of saved and template workflows by category.
- **Camera / frame:** Full window.
- **Window layout:** Library grid view.
- **UI state:** All 10 real starter templates visible (Architecture Review, Code Review, Bug Investigation, etc. — see `packages/ai-service/src/workflow/templates.ts`) plus at least one user-saved workflow, so the grid looks populated and organized by category.
- **Data:** Real template names/descriptions (already shipped — no invention needed).
- **Filename:** `07-automation-studio.png`

### 08 — Knowledge Graph

- **Purpose:** The AST-based knowledge fabric — AURA's structural understanding of a codebase.
- **Description:** The Knowledge Workspace (`screens/KnowledgeWorkspace.tsx`) showing the graph visualization (god nodes, community clusters, cross-file edges).
- **Camera / frame:** Full window, graph canvas maximized.
- **Window layout:** Knowledge tab, graph view (not the file list view).
- **UI state:** Graph zoomed to a legible cluster (not the entire 4000+ node graph as an unreadable hairball) — ideally centered on a recognizable community with node labels visible; a god-node or hotspot highlighted if the UI supports selection.
- **Data:** Real graph output from indexing the sample project (`graphify-out/graph.json` against `aura-hub` itself already exists and is real).
- **Filename:** `08-knowledge-graph.png`

### 09 — Architecture Blueprint

- **Purpose:** System-level structural view — layers, modules, dependencies — distinct from the raw knowledge graph.
- **Description:** The Architecture panel/screen (`ops/panels/ArchitecturePanel.tsx`, `components/ArchitectureBlueprint.tsx`) showing layered module structure.
- **Camera / frame:** Full window or full panel.
- **Window layout:** Architecture tab/panel, default layered view.
- **UI state:** Multiple real layers/modules shown with their relationships (e.g. `apps/desktop → @aura/ui → @aura/core`), at least one module selected showing its detail/inspector.
- **Data:** The real monorepo dependency structure — this is literally accurate for `aura-hub` itself.
- **Filename:** `09-architecture-blueprint.png`

### 10 — Engineering Memory

- **Purpose:** Persistent, queryable engineering experience — not a stateless assistant.
- **Description:** The Memory Center (`ops/MemoryCenter.tsx`, `MemoryGraph.tsx`) showing recorded decisions/patterns over time.
- **Camera / frame:** Full window or full panel.
- **Window layout:** Memory Center, list or graph view (whichever is visually richer with real data).
- **UI state:** Several real memory entries of different kinds (decision, pattern, learning) with timestamps and source links.
- **Data:** Real memory items recorded from genuine engineering activity on the sample project — do not hand-write fake memory entries; let the platform record real ones by actually using it.
- **Filename:** `10-engineering-memory.png`

### 11 — Engineering Governance / Intelligence

- **Purpose:** The "principal engineer in the loop" layer — health scoring, drift detection, release readiness.
- **Description:** The Engineering Governance screen (`screens/governance/EngineeringGovernance.tsx`) showing health scores and findings.
- **Camera / frame:** Full window.
- **Window layout:** Governance dashboard default view.
- **UI state:** Real health scores across multiple dimensions (architecture, security, docs, tech debt, etc.), at least one real finding/recommendation expanded to show detail.
- **Data:** A real governance run against the sample project — genuine scores, not fabricated "100/100 perfect" numbers (a real, credible score is more convincing than a suspiciously perfect one).
- **Filename:** `11-engineering-governance.png`

### 12 — Multi-Provider AI Settings

- **Purpose:** BYOAK — the user's own key, their choice of provider, no vendor lock-in.
- **Description:** AI Settings (`screens/ai/AiSettings.tsx`) with 3+ providers connected and one active.
- **Camera / frame:** Full window or full panel.
- **Window layout:** Settings → AI Provider screen.
- **UI state:** At least 3 connected providers listed (mix of the 11 supported: OpenAI, Anthropic, Gemini, Groq, Mistral, Cerebras, Kimi, NVIDIA, OpenRouter, Novita, Qwen), one clearly marked Active with a green health/latency indicator, model dropdown showing real discovered models for the active provider. Qwen connected and active makes a strong candidate for this shot — it demonstrates a non-Western, enterprise-cloud provider working through the exact same generic UI as every other one.
- **Data:** Real provider connections (fingerprinted key display, not raw keys — the product already redacts these).
- **Filename:** `12-provider-settings.png`

### 13 — Command Bar / Universal Search

- **Purpose:** Shows the "environment" feel — keyboard-first, everything reachable from one place.
- **Description:** The command palette (`shell/CommandBar.tsx`) or Universal Search (`ops/UniversalSearch.tsx`) open mid-query with results.
- **Camera / frame:** Full window with the palette overlay open and focused.
- **Window layout:** Palette open over the Home or Workspace screen.
- **UI state:** A real query typed with a results list showing a mix of result types (commands, projects, files, panels) — not an empty "type to search" state.
- **Data:** Real matched results from the sample project.
- **Filename:** `13-command-palette.png`

---

## After capturing

1. Drop each PNG into this folder using the exact filename above.
2. Optimize file size (`pngquant` or similar) — target under ~400KB per image without visible quality loss.
3. Remove this note once all 13 are in place — the README gallery is already wired to these paths and needs no further edits.
