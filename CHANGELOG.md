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

## [0.1.7] - 2026-09-13 — Central Agent

The Central Agent becomes the one path a request travels: it reads what
you asked for, plans it, checks authority, dispatches a worker, and
verifies the result before reporting it.

### Added

- **Central-agent orchestration** — governed plan/authority/execute/verify
  loop with model-proposed plans validated into `agent.delegate` DAGs,
  role-matched workers, inter-task result handoff, a bounded correction
  loop, objective acceptance beyond per-task success, and restart-safe
  resume from persisted plans and verified evidence.
- **Conversational intent routing** — a deterministic floor that tells a
  question from a job. Greetings and "what can you do?" are answered in
  words; engineering work and failure diagnosis reach a worker; known
  read-only capabilities such as `git status` answer directly instead of
  dispatching one. The conversational path reaches no planner, no
  authority check and no executor, so it can report no work because it
  has no way to do any.
- **Worker and tool workspace** — six worker slots and three tool slots
  as first-class saved placements, a live orchestration graph, a
  conversation pane over the agent's own event stream, and streamed
  answer tokens rendered from the existing `answer.*` frames.
- **Software discovery** — identity, classification and installability
  resolution for the machine's real software, behind the environment API.

### Security

- **Per-domain network egress allowlist** enforced by an AURA-owned door,
  with platform enforcement adapters that stay honest on Windows and
  macOS rather than claiming a guarantee they cannot make.
- **Kernel-enforced network denial** and real run cancellation.
- Worker task contracts enforce declared scope: changes outside it park
  the run for a decision instead of being accepted.

### Validation

- Conversation routing, conversational-turn, event-spine, correlation,
  approval-binding, provider-bridge and worker-selection suites brought
  under version control, alongside frontend coverage for the conversation
  pane, orchestration graph and slot model.

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
