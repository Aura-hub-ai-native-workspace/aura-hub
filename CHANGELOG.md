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

## [0.1.10] - 2026-09-13 — Verification

A maintenance release. The shipped application is functionally identical
to 0.1.9 — no runtime, backend, packaging or UI code changed between the
two tags. What changed is the packaging suite's ability to tell the truth
about a build, which is worth a version of its own because the previous
two releases each shipped a defect it should have caught and did not.

### Changed

- **The packaged-backend check verifies resolution instead of a string.**
  It asserted that the binary contained no CI checkout path. Every build
  embeds one — `CARGO_MANIFEST_DIR` is the development fallback — so the
  check failed correct artifacts and passed locally only because a
  developer's build path looks different. It now reads the actual
  invariant: the packaged resource lookup must precede the development
  fallback.
- **The Python backend is exercised at runtime for the first time.** Every
  existing assertion spoke to the Node service; the environment backend
  was never started, asked for health, or asked where it came from. Two
  checks now do: the path the packaged application reports must be inside
  its own resources rather than any source tree, and that backend must
  answer its own health endpoint. This is the gap 0.1.8 fell through.
- **The suite gives the application a usable interpreter.** It launches
  with a deliberately minimal PATH to prove PATH seeding works, which on a
  machine whose only suitable Python lives in pyenv or conda made the
  backend refuse for reasons that said nothing about the package. One
  directory — the interpreter's, and only when it genuinely imports what
  the backend needs — is now added; everything else stays hostile.

## [0.1.9] - 2026-09-13 — Packaged Backend

v0.1.8 shipped a desktop application that supervised the Python
environment backend correctly and still could not start it. The backend
was never in the package, and the shell looked for it at the path of the
machine that compiled the binary — so the artifact worked for whoever
built it and for nobody who installed it.

### Fixed

- **The Python backend is part of the package now.** `serve_central_agent_api.py`
  and the `aura` package are staged into `resources/python/`, keeping
  `scripts/` beside `backend/` so the entry script's own
  `parents[1] / "backend"` lookup needs no packaging special case. The
  interpreter and the third-party wheels are still NOT bundled: the shell
  discovers a Python on the machine and refuses any that cannot import
  starlette, uvicorn and `aura.api.server`, so a machine without them gets
  the same honest refusal it always did.
- **The packaged application resolves the backend from its own resource
  directory**, mirroring how the Node service has always been found.
  `env!("CARGO_MANIFEST_DIR")` is a compile-time constant, so the previous
  build carried `/home/runner/work/...` inside it and looked for the
  backend on the CI runner's disk. The repository path remains as a
  development fallback only.

### Changed

- **The packaging suite runs everywhere.** Its repository root was a
  hardcoded absolute path to one developer's checkout, so on every other
  machine — CI included — it exited with "no packaged artifact to test"
  and none of its assertions ran.
- **Two security invariants now state what they mean.** The process check
  counted spawn sites and demanded exactly one, which broke when the shell
  legitimately began supervising a second backend; it now asserts that
  every spawned executable is a resolved interpreter, that no shell is
  ever spawned, and that any `-c` payload is a fixed literal. The
  capability check demanded a permission set that stopped being accurate
  when the updater landed; it now pins the exact approved set with each
  grant's justification, and separately rejects any permission that would
  grant arbitrary execution.

## [0.1.8] - 2026-09-13 — Environment Backend Startup

v0.1.7 shipped a desktop app whose environment backend never started. The
renderer asked `127.0.0.1:4320` for the machine inventory, found nobody
listening, and reported "0 installed" on a machine with hundreds of
packages on it. Two defects stood between the shell and a working
backend; both are fixed here, and the fix is verified on the packaged
binary rather than in a source checkout.

### Fixed

- **The desktop shell now starts the Python environment backend.** It was
  supervising only the Node AI service on 4319 and nothing ever launched
  the Python API on 4320, so Connected Environment, Machine Inventory and
  the Workspace session all failed against a port with no listener. The
  backend is now a second slot in the supervisor that already ran the
  Node service — the same handle, health check and shutdown path, not a
  second process model. A port is adopted only when `/health` answers in
  AURA's shape **and** reports `"backend":"python"`, so the Node service
  is never mistaken for the environment backend.
- **AppImage no longer breaks the interpreter it launches.** The AppImage
  runtime exports `PYTHONHOME` pointing into its own mount, which holds
  no standard library. Every candidate interpreter inherited it and died
  before running a line of user code, reporting `<no Python frame>` —
  identically, whatever was actually installed. `PYTHONHOME` is now
  removed from the spawned environment; an interpreter knows its own
  home, and inheriting another process's is never right.

### Verified

Checked against the real packaged AppImage, not a source tree: the
backend starts automatically, `/health` reports `backend: python` and a
ready index, the Capability Fabric answers, a machine scan returns real
counts, the inventory returns named tools with versions, and a Workspace
session loads. Stopping the backend produces an explicit unreachable
state rather than an empty inventory that looks like a valid result, the
Node service on 4319 is unaffected, and relaunching restores the
inventory.

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
