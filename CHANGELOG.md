# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses date-based milestone releases rather than strict
[SemVer](https://semver.org/) while it's pre-1.0 — breaking changes can
land on any `0.x` release.

## [Unreleased]

Committed to `presentation-v0.1`, pending review before any merge to
`main`:

- **Mission Control v3** — a real DAG execution engine on top of
  planning/approval: dependency-aware task ordering, blocked/waiting/
  queued states, a critical-path view, and a frame-per-mutation replay
  timeline. See [`docs/architecture/MISSION_CONTROL_V3.md`](docs/architecture/MISSION_CONTROL_V3.md).
- **Engineering Governance Platform** — architecture drift detection,
  multi-dimension health scoring, technical debt tracking, release
  readiness, and security review. See
  [`docs/architecture/ENGINEERING_GOVERNANCE_PLATFORM.md`](docs/architecture/ENGINEERING_GOVERNANCE_PLATFORM.md).
- **Predictive Engineering Platform** — deterministic, ML-ready risk
  prediction (hotspots, regressions, architecture drift, mission
  failure probability) from real platform signals, no ML/randomness.
  See [`docs/architecture/PREDICTIVE_ENGINEERING.md`](docs/architecture/PREDICTIVE_ENGINEERING.md).
- **Engineering Memory Platform** — persistent, queryable engineering
  experience layer (decisions, patterns, learnings) grounded in real
  project history. See
  [`docs/architecture/ENGINEERING_MEMORY_ARCHITECTURE.md`](docs/architecture/ENGINEERING_MEMORY_ARCHITECTURE.md).
- **Automation Engine** — event-driven workflow layer reacting to real
  platform moments (mission completed, diagnosis accepted, file/README/
  dependency changes, PR merged) with conditions, retries, and a full
  execution timeline. See
  [`docs/architecture/AUTOMATION_ENGINE.md`](docs/architecture/AUTOMATION_ENGINE.md).
- Repository productization: LICENSE, community health files, screenshot
  gallery infrastructure, and this changelog.
- **CI reliability fix** — every historical CI run had failed (100%,
  including on `main`): committed `.tsbuildinfo` incremental-build
  caches made `tsc -b` falsely believe composite packages were already
  built on a fresh checkout, when their `dist/` output was correctly
  never committed. Untracked the stale caches and fixed the typecheck
  script's build order. CI is green as of this release.
- **Repository cleanup** — untracked `graphify-out/`'s AST cache and
  historical daily snapshot backups (unbounded growth, ~35MB), removed
  a dead unreferenced static asset, and removed an unused `three`
  dependency.
- Fixed three broken relative-path links across existing architecture
  docs.

Not yet committed to this branch (real, working locally, pending a
separate, deliberate commit — not included here to avoid claiming
unshipped work as shipped): provider system hardening (centralized
provider/model validation, error translation), the Novita AI adapter,
and a window-manager rework (floating panels, workspace canvas).

## [0.1.0] - 2026-07-31 — AURA Presentation Build

The first tagged milestone build: application shell, design system,
project workspace sections, workflow editor/library, and knowledge graph
visualization, presentable end-to-end.

### Added
- Repository governance: CODEOWNERS, PR/issue templates, CI workflow,
  `CONTRIBUTING.md`, team ownership docs.
- Presentation deck build pipeline (`scripts/presentation/`).

### Fixed
- Provider metric row layout in the presentation deck.

## [Initial commit] - 2026-07-28

- Initial commit of the AURA Hub codebase: application shell, design
  system (`@aura/ui`, `@aura/core`), project workspace, AI service
  (provider adapters, workflow engine, intelligence pipeline), and the
  knowledge engines (`@aura/knowledge-coding`, `@aura/knowledge-fullstack`).

[Unreleased]: https://github.com/Aura-hub-ai-native-workspace/aura-hub/compare/c671a0b...HEAD
[0.1.0]: https://github.com/Aura-hub-ai-native-workspace/aura-hub/compare/991f9cc...c671a0b
