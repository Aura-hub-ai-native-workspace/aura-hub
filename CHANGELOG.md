# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses date-based milestone releases rather than strict
[SemVer](https://semver.org/) while it's pre-1.0 — breaking changes can
land on any `0.x` release.

## [0.1.15] - 2026-09-22 — Windows Hardening + Project Context

Two tracks. Windows machines reported healthy tools as broken or
missing (npm shims dying with `WinError 193`, spaced paths truncated
at `C:\Program`, Store stubs answering for real interpreters,
PowerShell 5.1 failing its probe); execution is now routed through the
same governed boundary on every layer. Separately, planning and
advisory surfaces stop guessing about the machine and the project: a
capability registry reports one measured, fail-closed view, and project
context resolves through the registry with honest 404s for unknown ids.
No provider routing changes — self-hosted Local/Remote remain primary,
new cloud adapters are explicit opt-in fallback only.

### Fixed

- **Windows `.cmd`/`.bat` shim routing** — shims go through one
  pre-quoted `cmd /d /s /c call …` line in
  `aura.environment.procexec`, `aura.exec_` and the `ai-service`
  `spawnTargetFor` mirror (a quoted spaced path under bare `cmd /c`
  strips to `C:\Program`).
- **PATHEXT resolution order** — a bare name prefers the runnable
  `.cmd`/`.exe` twin over an extensionless shim instead of probing an
  unrunnable file and reporting the tool broken.
- **WindowsApps Store-alias stubs skipped** — reparse points no longer
  trigger Store popups or false failures when a real candidate
  resolves; a stub with no alternative reports honest failure, never
  "not on PATH".
- **Git Bash fallback probes** and a **PowerShell 5.1-compatible
  probe** (`$PSVersionTable.PSVersion` instead of `--version`).
- **npm global prefix** — `APPDATA`/`LOCALAPPDATA` kept in the
  sanitized probe environment; without them every npm-global plan
  silently demoted to root/guided.
- **Venv-only self-runtime exclusion** — a system interpreter running
  AURA is the machine's Python and is scanned; only real virtualenvs
  are excluded.
- **Direct-path text output crash** — executor text output crashed
  task close with `AttributeError` and failed the session as
  "Unexpected failure"; output is normalized before the
  cancelled-flag check.
- **Per-provider custom headers** — operator-written `headers` in
  `providers.json` ride stream and non-stream completions; secrets
  still belong in `apiKeyEnv`.

### Added

- **Capability registry** (`backend/aura/capabilities`) — one measured
  view uniting catalog probes, connected worker records and the tool
  table. Fail-closed throughout: unknown capabilities, actions and
  unmeasured tools resolve to `unavailable` with a reason, never a
  guessed command. Memory-only TTL cache; `refresh()` re-measures.
- **Project-scoped context plumbing** — advisory and execution paths
  resolve the working project through the registry; an unregistered id
  returns an honest 404 (`no project is registered with id`), never
  another project's context.
- **Agent approvals surface** — approval requests render with full
  context and approve/deny through the existing ledger.
- **Provider groups with PRIMARY/FALLBACK distinction** — the Settings
  UI renders the category from each adapter's `selfHosted` flag; new
  **ScaleMax** fallback adapter (`sm_` key detection, env-supplied
  key) joins the opt-in list behind Ollama. No auto-failover, no
  racing, no default switching.
- **Ctrl-I editor context and read-only investigation support** with
  project-artifact and provider-agnostic coverage tests.

### Validation

- Typecheck clean across all three projects (CI).
- Frontend + AI-service suites green on all four platform legs (CI).
- New tests: Windows shim/PATHEXT/stub/prefix coverage, agent-boundary
  parity, provider headers, direct text-output settle, capability
  registry, project context artifacts, provider architecture,
  project scoping.
- Native runtime verification on all four installers, including the
  Windows NSIS install-and-launch leg.

### Known non-blocking notes (not fixed in this release)

1. Three Windows-simulation tests fail when run on Linux
   (`CREATE_NEW_PROCESS_GROUP` under mocked `os.name`, `;`-vs-`:`
   PATH join, one outdated extensionless-match assertion):
   test-harness-only, green on real Windows runners. Fix prepared on
   a follow-up branch, deliberately not bundled here.
2. Pre-existing `tests/unit` failures also present on `main`
   (discovery/adversarial execution decisions, hygiene caches,
   `cmd /c` docstring needle) are unchanged by this release.

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

## [0.1.14] - 2026-09-20 — Ask AURA / Workspace Separation

Ask AURA advises; the Workspace executes. The two surfaces shared one
conversation engine, so every project question arrived with the
execution pipeline attached (intent strip, plan review, approval gate,
"needs-clarification"). They are now separate product boundaries over
the same provider, with an explicit handoff between them.

### Added

- **Advisory-only Ask AURA** — project conversations stream answers
  from the configured provider with project context. No sessions, no
  plans, no approvals, no workers, no file or command execution. The
  surface has no code path to the execution engine.
- **Explicit Ask AURA → Workspace handoff** — each answer offers "Send
  to Workspace", which stages an in-memory banner carrying the question
  and suggestion. Starting it sends one execution objective; dismissing
  it executes nothing.
- **Workspace execution scope** — the Central Agent transcript persists
  in its own workspace-scoped file with per-turn working-project
  tracking; a project switch mid-thread starts a fresh session rather
  than continuing another scope's conversation.
- **Self-hosted Ollama provider persistence** — verify-then-save
  onboarding (reach, model list, exact-model match, real streamed
  generation) against any reachable server, validated live with
  `qwen3.8:27b`; the save stage performs no second network validation.
- **Scope identity in conversation records** — every thread carries
  exactly one scope (`workspace` or `project`).

### Unchanged

- Central Agent execution engine (intent, planner, workers, approvals,
  verification, evidence, SSE) is intact and untouched.

### Validation

- Typecheck clean across all three projects.
- Frontend + AI-service suites: 235/235.
- Backend suites (provider bridge, autonomy, streaming, correlation,
  handoff, worker match, role prompts): 186/186.
- Real-machine browser E2E over Tauri/Vite against live Ollama
  (`qwen3.8:27b`): 19/19 — advisory streaming with no execution
  chrome, explicit handoff, model-backed execution to a real result,
  project isolation, restart restoration, provider persistence.

### Known non-blocking notes (not fixed in this release)

1. Console `ERR_CONNECTION_REFUSED` noise seen in one intermediate
   browser run did not reproduce in the final clean instrumented run
   (zero failed requests); no product behavior was affected.
2. Closing the application window mid-turn can orphan that turn's
   frontend assistant persistence while the server-side session
   continues. Pre-existing architecture; out of scope for v0.1.14.
3. `scripts/ui-agent-events.mjs` retains expectations from before the
   separation (agent spine inside Ask AURA) and is marked superseded;
   `scripts/ui-ask-workspace-split.mjs` is the current GUI acceptance.
   It was deliberately not rewritten to chase the old contract.

## [0.1.13] - 2026-09-15 — Setup That Ends

0.1.12 could trap you on the last screen of setup. Not briefly — the flow
sat on "Your AI Workspace is Ready" until the application was killed, with
a completed progress bar and no error, because nothing was actually stuck
except a decision that had no reason to be made again.

It needed a particular shape of user: someone who had set AURA up before.
A returning user whose saved model server no longer answered was sent back
through setup, and finishing it did not change the one thing the launch
gate was watching, so the gate never reconsidered. Anyone installing for
the first time sailed through, which is why it survived testing.

It affected Windows, macOS and Linux identically. The gate is ordinary
TypeScript, compiled once into every installer; a mistake there is a
mistake everywhere.

### Fixed

- **Finishing setup opens the workspace, every time.** Completion now tells
  the launch gate directly instead of the gate inferring it from a flag
  that a returning user had already set. An explicit signal cannot be
  missed the way a changed value can.

### Changed

- **The test suites run in CI, on all four platforms.** They never had.
  Two hundred and thirty tests existed — including ones written for this
  exact gate — and no job executed any of them, which is how a fault
  reachable on every platform reached every platform. They now run once
  for fast failure and again on each platform that gets packaged, because
  "platform-independent" is a claim worth checking rather than assuming.

Nothing else changed: same bundled Node and Python runtimes, same
onboarding, same artifacts as 0.1.12 apart from this fix.

## [0.1.12] - 2026-09-15 — Nothing Left To Install

0.1.11 bundled a Python interpreter and still took Node from the machine.
A computer without one could not launch AURA at all — not a degraded
screen, a dead start. And the first screen could stall: it is drawn the
instant the window appears, while AURA's own service is still coming up
behind it, and a single lost race left "Verify and Continue" permanently
disabled. A user could type a correct address and a correct model and
never be allowed past, with nothing on screen explaining why.

Both are fixed. Installing the application is now the whole of the setup.

### Added

- **The Node runtime ships with the application.** Node 22.23.2 — the
  version AURA is built and tested against — pinned by SHA-256 and
  verified before it is unpacked. Only the binary is taken: npm, headers
  and documentation are left behind, because the service is a bundle and
  never invokes them. Together with the Python interpreter from 0.1.11, a
  fresh install needs no runtime, no package manager and no administrator.

### Fixed

- **The first screen no longer stalls waiting for a service that has not
  started yet.** It retries until AURA's service answers, says which state
  it is in while waiting, and no longer makes the Continue button depend
  on a request the user cannot see or retry. A late answer never
  overwrites an address already being typed.
- **Setup does not re-ask a question it has just answered.** The check
  that revalidates a saved server on launch was also running the moment
  onboarding finished, and could throw the user back onto the screen they
  had completed. It now only challenges a configuration that predates the
  session.
- **A bundled runtime is no longer reported as installed on the machine.**
  This is the objection the code raised against bundling Node, and it was
  right: with every Node on the machine made unrunnable, the Connected
  Environment still announced "Found Node.js 22.23.2 on this machine" — it
  had found AURA's private copy on the PATH AURA itself seeds. The
  inventory describes the machine; the application runs on its own
  runtimes; the two no longer contaminate each other.

The artifacts grow again — the AppImage by roughly 60 MB — which is the
remaining cost of an application that runs when it is installed.

## [0.1.11] - 2026-09-15 — Batteries Included

The first release that installs into a working application on a machine
that has no Python set up, and the first whose first screen asks for a
model server instead of a credit card.

0.1.9 and 0.1.10 packaged the environment backend's source and then
expected the machine to already have the packages it imports; the
releases before them shipped no backend at all. A user on Arch installed
0.1.10, opened AURA, and got "Load failed", "Not scanned", "0 installed"
and `backend is not answering on http://127.0.0.1:4320` — and had to run
`pacman -S python-starlette python-pydantic` and `pip install uvicorn` by
hand before the application worked. Shipping source without its imports
was never a working product.

Bundling those packages turned out to be only half of it. It removed the
need for a *configured* Python, not for a Python: Windows ships none at
all, macOS ships 3.9 through the Command Line Tools, Ubuntu 22.04 ships
3.10 and Debian 12 ships 3.11 — every one below the 3.12 this backend
requires. So the interpreter travels too, and an installed AURA now needs
nothing from the machine: no interpreter, no pip, no package manager, no
administrator.

The artifacts are larger for it. The bundled interpreter is 30–44 MB
depending on platform and the packages add about 6.6 MB compressed, so
expect the downloads to roughly double. That is the price of an
application that works when it is installed.

### Added

- **AURA runs on an Ollama server you control.** The first screen asks for
  two things — the server's address and a model ID — and nothing else. No
  API key, no account, no cloud provider. The server may be on this
  machine or on another one: a laptop, a lab box, a shared university GPU
  server behind HTTPS. The address is classified as it is typed (this
  machine · another machine on the network · remote server), and a bare
  hostname honestly reports that its location cannot be known from a URL
  rather than guessing.
- **Nothing is saved until the model has actually answered.** "Verify and
  Continue" reaches the server, confirms it speaks Ollama, retrieves the
  model list, checks the requested model is served there *exactly*, and
  sends a real streamed prompt. Only then is the configuration written.
  Reaching an address proves a socket opened; it does not prove a model
  will load, and a workspace that opens and fails on its first question is
  worse than one that explains the problem while it can still be fixed.
  A stale configuration — a rotated tunnel, a removed model — returns to
  the connection screen instead of into a broken workspace.

### Fixed

- **A requested model is never silently swapped for another.** Asking for
  a model the server does not serve used to fall through to the first one
  it knew about: a request for `qwen3.8:27b` quietly ran a different
  model. The user believed they were running one thing while running
  another, and on a shared server that is also somebody else's GPU time.
- **Generation is no longer capped at thirty seconds.** The streaming
  timeout was attached to the request whose body *is* the stream, so it
  stayed live while tokens were arriving and killed working answers
  mid-sentence. A reasoning model that thinks for half a minute before its
  first token never got started at all. The budget now bounds silence —
  the clock resets on every chunk — so a long answer never trips it and a
  dead connection still does.
- **Disconnect now disconnects.** Removing the credential cleared the
  active pointer, which made the guard that was supposed to shut the
  runtime down compare two different things and skip it — so the
  in-memory provider kept answering for a configuration that had just been
  deleted, and health reported "connected" with nothing stored behind it.
- **Redirects cannot move inference to another machine.** `fetch` follows
  them by default and says nothing about it, so a 302 from the configured
  address could have sent prompts to a server the user never chose. Every
  request to a self-hosted server is now pinned to the destination that
  was configured: same protocol, same host, same port. A path rewrite on
  the same server is fine, which is what reverse proxies do; a
  cross-host hop, a cross-port hop, an HTTPS-to-HTTP downgrade or a loop
  is refused and named. This is a *pin*, and deliberately not the existing
  SSRF deny list, which would refuse the loopback and LAN addresses that
  are supported deployments here.

Cloud providers remain available as explicit fallbacks at the bottom of
Settings. They are never selected automatically, and AURA never silently
sends a prompt to one because a self-hosted server is unavailable.

Still required from the machine: **Node.js**. AURA runs its local service
on the Node it finds rather than a bundled copy, deliberately — it also
reports Node as a detected tool, and running on a different one than it
reports would be its own kind of lie. A machine without Node still cannot
start AURA.

### Fixed

- **The Python interpreter ships with it.** A relocatable CPython
  3.12.14, pinned by SHA-256 and verified before a single file is
  extracted — a release URL is a promise about where bytes live, not
  about what they are. It is ranked above every interpreter on the
  machine, because it is the exact CPython the bundled wheels were built
  for and cannot be upgraded out from under the application;
  `AURA_PYTHON` still overrides it, and a source checkout stages no
  runtime, so development is unchanged. What a headless API server never
  reaches for is removed — Tk, IDLE, headers, the static library, pip,
  terminfo — taking it from 101 MB to 44 MB on Linux and proportionally
  on the other platforms.
- **The backend's dependencies ship with it.** Starlette, uvicorn,
  Pydantic and their pure-Python dependencies are staged into
  `resources/python/site-packages`, and `pydantic_core` — a compiled
  extension that is not abi3, so one build genuinely cannot load into
  another CPython — is staged once per supported version under
  `resources/python/abi/cp3NN/`. The entry script selects the directory
  matching the interpreter that is running. Versions are resolved from
  `backend/pyproject.toml` rather than a list in the build script, so the
  bundle cannot drift from what the test suite runs against. An
  interpreter is still not bundled: AURA needs a Python 3.12+ on the
  machine, it no longer needs one somebody has configured.
- **Python is found where version managers put it.** A desktop launcher
  hands the application a minimal PATH that excludes pyenv shims, conda
  and per-user installs, so the one interpreter that could run the
  backend was invisible to it. Those locations are now searched by
  location rather than through PATH.
- **The window appears before the environment backend starts.** It was
  shown only after both services had been dealt with, so a machine that
  took a moment to find a Python got an invisible application — and on
  Windows an unkillable one, because a close request posted at a process
  with no window is delivered nowhere and the shell never reached its
  exit handler.
- **A probe that times out is no longer reported as a missing tool.**
  The scan gave each tool four seconds and read silence as absence, with
  a guessed reason. The same machine reported 12 tools present, then 10,
  then 8, unchanged — the first execution of a binary on Windows is slow
  because the anti-malware scanner reads the whole file first. Probes are
  now retried once, warm, and a probe that still does not answer says it
  timed out rather than claiming the tool is missing.

### Changed

- **Packaging verification proves the dependencies are sufficient, not
  merely present.** A new check imports the packaged entry point on a
  virtualenv built `--without-pip`, having first confirmed that
  virtualenv is empty. Every other check in that suite runs on a machine
  where Starlette is installed three times over and would pass on an
  artifact that silently depends on it. Three further checks cover the
  interpreter: that it is packaged AND executes, that it alone can import
  the backend, and — the one that matters — that the running application
  actually used it rather than one it found on the machine.
- **A probe that times out is no longer reported as a missing tool.** The
  environment scan gave each tool four seconds and read silence as
  absence, with a guessed reason. The same machine reported 12 tools
  present, then 10, then 8, unchanged: the first execution of a binary on
  Windows is slow because the anti-malware scanner reads the whole file
  first. Probes are retried once, warm, and one that still does not
  answer now says it timed out instead of claiming the tool is missing.
- **The window appears before the environment backend starts.** It was
  shown only after both services had been dealt with, so a machine that
  took a moment to find a Python got an invisible application — and on
  Windows an unquittable one, because a close request posted at a process
  with no window is delivered nowhere.

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

## [0.1.6] - 2026-09-13 — Central Agent

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
