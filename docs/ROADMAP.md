# AURA Roadmap

## Current milestone: `AURA Presentation v0.1`

Due **Saturday, 2026-08-01**. Everything required for the presentation
build is tracked under this milestone — see the
[milestone tracker](https://github.com/Aura-hub-ai-native-workspace/aura-hub/milestone/1).

Scope for v0.1:
- Application shell (navigation, command bar, status bar) — stable
- Design system components — stable
- Project workspace sections (Overview, Architecture, Backend, Database,
  Frontend, Knowledge, Memory, Research, Tasks, Deployment, Documentation,
  Settings) — presentable end-to-end
- Workflow editor/library — functional demo path
- Knowledge graph visualization (`graphify-out`) — wired to at least one
  real project

## Beyond v0.1

Rough sequencing, not commitments:

1. **AI runtime hardening** — streaming reliability, provider fallback,
   credential management polish (`packages/ai-service/src/provider`)
2. **Knowledge fabric depth** — cross-repo linking, God-node detection,
   community structure surfaced in the UI
3. **Workflow engine** — persistence, templates, multi-step automation
   beyond the current demo nodes
4. **Desktop packaging** — signed Tauri builds for macOS/Windows/Linux
5. **Team onboarding** — once UI-UX, Backend, and Database teams have
   members, split backlog by team label and run per-team sprints

## How this roadmap is maintained

- The repository owner updates this file when milestone scope changes.
- Issues/PRs targeting the current milestone are labeled `presentation`
  and assigned to the `AURA Presentation v0.1` milestone.
- Anything not required for the current milestone belongs in `Backlog`
  on the [AURA Development project board](PROJECT_BOARD.md).
