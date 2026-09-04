# AURA Hub — Master Handoff

> **Read this first.** This document exists so that a future Claude Code
> session, an OpenCode session, or a human developer can open this repository
> and reach roughly the same understanding of it as the session that shipped
> v0.1.0, without that session being available.
>
> Companion documents:
> [Quickstart](./AURA_HUB_QUICKSTART.md) ·
> [Architecture Map](./AURA_HUB_ARCHITECTURE_MAP.md) ·
> [Release Handoff](./AURA_HUB_RELEASE_HANDOFF.md)
>
> **Written:** 2026-08-13, against commit `a382625` on
> `feature/workspace-execution-environment`.
> Every claim below was checked against the source tree at that commit.
> Where a claim could not be verified, it says so.

---

## How to read this document

Statuses are used precisely and are not interchangeable:

| Word | Means |
| --- | --- |
| **IMPLEMENTED** | The code exists and is wired into the running system. |
| **VERIFIED** | A verification script or CI run exercised it and passed. The evidence is named. |
| **PARTIAL** | Some of it works; the gap is described. |
| **DESIGNED** | Documented and reasoned about; no working code. |
| **NOT IMPLEMENTED** | Absent on purpose. Do not assume it is coming. |

Two words in particular are never blurred: **BUILT** means an artifact was
produced; **RUNTIME VERIFIED** means the artifact was launched and exercised
on that operating system. A build is not a run. If you only built it, say
**NOT RUNTIME VERIFIED**.

---

## Section 1 — Project identity

### What AURA Hub is

AURA Hub is a desktop **AI-native engineering environment**: a single
application that indexes a codebase, plans work against it, and executes
that work through governed capabilities rather than an unrestricted shell.

It is a **Tauri v2 desktop shell** (Rust) wrapping a web UI (React +
TypeScript), which talks over HTTP to a **local Node service** (the "AURA
service") that owns all intelligence, execution and state.

### The problem it solves

An LLM that can run commands is useful and dangerous in the same breath. The
usual answers are to give the model a shell (fast, unsafe) or to hand-approve
every action (safe, unusable). AURA Hub's answer is a **Capability Fabric**:
the model requests a named capability, a single policy engine decides whether
it may run, an approval system handles the cases that need a human, and every
outcome is audited with the node that actually performed it.

### Relationship to AURA OS / the broader ecosystem

The repository contains AURA Hub, the desktop product. Documents in `docs/`
refer to a wider AURA ecosystem (engineering memory, governance, predictive
engineering). **Not verified by this handoff:** the current state of any
component outside this repository. Treat references to "AURA OS" in older docs
as context, not as a live dependency — nothing in the runtime path imports it.

### Current maturity

**v0.1.0 — first desktop release.** Real, installable, and honest about its
edges: unsigned on Windows and macOS, requires Node.js 18+ on the machine, and
several UI surfaces are not reachable yet. The governed-execution core is the
mature part; the UI shell around it is the least mature.

---

## Section 2 — Repository map

Verified against the tree at `a382625`. Only paths that exist are listed.

```
aura-hub/
├── apps/
│   └── desktop/                  React UI + Tauri shell (the only app)
│       ├── src/                  UI: screens, shell, workspace, environment
│       └── src-tauri/            Rust desktop shell
│           ├── src/lib.rs        IPC commands, window/service setup
│           ├── src/service.rs    AURA service lifecycle (the critical file)
│           ├── src/main.rs       thin entry point
│           ├── capabilities/     Tauri ACL (core:default only)
│           ├── resources/        bundled service + node_modules (build output)
│           └── tauri.conf.json   productName "AURA Hub", version 0.1.0
├── packages/
│   ├── ai-service/               THE service. Server, mission, providers, exec
│   ├── capability-fabric/        Policy, approval, execution authority
│   ├── connected-environment/    Node catalogue, probes, resolution
│   ├── core/                     Shared types, store, navigation
│   ├── ui/                       Shared UI components
│   ├── runtime/ automation/ governance/ intelligence/
│   ├── knowledge-coding/ knowledge-fullstack/
│   ├── engineering-memory/ predictive/ retrieval/
├── scripts/                      Verification suites (.mjs) + build helpers
├── docs/                         Architecture and handoff documentation
├── website/                      MIRROR of the public site (not deployed)
├── examples/ partnership/        Samples and partner material
├── graphify-out/                 Knowledge-graph artifacts (user-owned)
└── dist-release/                 Staged installers (gitignored)
```

### What should and should not be modified

| Path | Guidance |
| --- | --- |
| `packages/capability-fabric/src/policy.ts` | **Never casually.** Security floors live here. |
| `packages/ai-service/src/exec/process.ts` | **Never casually.** The three allow-lists and the process primitive. |
| `apps/desktop/src-tauri/src/service.rs` | High care. Service lifecycle, port ownership, platform-specific cleanup. |
| `packages/ai-service/src/server.ts` | High care. Single wiring point for fabric, nodes, providers. |
| `scripts/*-verify.mjs`, `scripts/*-test.mjs` | Change only to make a check *more* honest, never to make it pass. |
| `graphify-out/*` | **User-owned.** Do not stage, revert or delete. |
| `website/` | Mirror only. The deployed site is a different repository (§16). |

---

## Section 3 — Architecture

### Dependency direction

Dependencies point inward. The UI knows about the service; the service knows
about the fabric; the fabric knows about capabilities and nodes; **nothing
inner imports the UI**.

```
apps/desktop (React UI)
      │  HTTP (localhost:4319)
      ▼
packages/ai-service  ──────────────► packages/capability-fabric
      │                                     │
      │                                     ▼
      └──────────────────────────► packages/connected-environment
```

Full control flow is in [AURA_HUB_ARCHITECTURE_MAP.md](./AURA_HUB_ARCHITECTURE_MAP.md).

### The layers

| Layer | Where | Responsibility |
| --- | --- | --- |
| **Desktop shell** | `apps/desktop/src-tauri` | Owns the window and the service process. Starts, health-gates, and stops the service. Exposes six IPC commands, no shell. |
| **Frontend** | `apps/desktop/src` | Screens, workspace canvas, Connected Environment UI, Mission Control. Talks HTTP only. |
| **AI service** | `packages/ai-service` | HTTP server, mission engine, provider manager, environment scanner, executors, persistence. |
| **Capability Fabric** | `packages/capability-fabric` | The single execution authority: validate → resolve node → policy → approval → execute → verify → audit. |
| **Connected Environment** | `packages/connected-environment` | The node catalogue, what each node provides, and how a node is resolved. |
| **Execution primitives** | `packages/ai-service/src/exec` | One process spawner, three disjoint binary allow-lists, the installer. |

### Architectural invariants

Each of these was confirmed in source at `a382625`. **They are invariants, not
preferences — breaking one is a redesign, not a change.**

1. **One policy engine.** `packages/capability-fabric/src/policy.ts` is the
   only place a decision is made. Verified: single `stricter()` and a single
   floor list.
2. **One execution authority.** Everything goes through the Fabric's invoke
   path. The mission engine calls the same path as a direct
   `POST /fabric/invoke` (see `server.ts`, `manager.attachFabric(fabric)`).
3. **One process primitive.** `exec/process.ts` — a single `settle()`
   governs exit codes, signals and timeouts for every child process.
4. **One environment scanner.** `scanEnvironment` in
   `packages/ai-service/src/environment.ts`, called from exactly one place in
   `server.ts` (`refreshNodeAvailability`).
5. **One node catalogue.** `connected-environment/src/catalog.ts` (`CATALOG`),
   which is also the tie-break order when several nodes provide a capability.
6. **One mission model, one DAG builder.** `mission/types.ts` and
   `mission/execution/dag.ts` (`buildDag`).
7. **One approval system.** `fabric/approvalStore.ts`.
8. **Three disjoint binary allow-lists**, never merged: `SAFE_BINARIES`,
   `AGENT_BINARIES`, `INSTALLER_BINARIES`.
9. **One desktop shell — Tauri v2, not Electron.** There is no Electron
   dependency anywhere in the tree. The renderer is the platform WebView
   (WebKitGTK on Linux, WebView2 on Windows, WKWebView on macOS).
10. **The renderer cannot execute processes.** The IPC surface is six
    commands, none of which is a shell (§13, §22).

---

## Section 4 — Connected Environment

**Status: IMPLEMENTED · VERIFIED** (`platform-verify`, and the detection
phases of `desktop-runtime-verify` on all four platforms).

### What it does

It answers "what is actually on this machine?" by probing, never by assuming.
A node counts as present only when it answered a probe.

- **Catalogue** — `connected-environment/src/catalog.ts` defines every known
  node: id, name, capabilities it provides, and how to probe it.
- **`probeNode(id, refresh)`** — `ai-service/src/environment.ts`. Runs the
  node's probe command and returns `{ present, version?, detail }`.
  Presence is deliberately *not* inferred from exit code alone: some tools
  exit non-zero while being perfectly present, so the probe interprets output.
- **`scanEnvironment(ids?, refresh)`** — scans the whole catalogue, or only
  the named ids when `ids` is supplied.
- **Capability discovery** — a present node contributes its declared
  capabilities to `providedNodeCapabilities`.

### How the UI gets its state

`POST /environment/scan` → `refreshNodeAvailability()` → `scanEnvironment()`
→ recomputes `presentNodes` and `providedNodeCapabilities` → the UI reads the
scan result. `apps/desktop/src/environment/` holds the client, store and views
(`ConnectedEnvironment.tsx`, `NodeInspector.tsx`, `GapPanel.tsx`).

### Real detection, verified

On CI runners the scan reports genuine versions, and absent tools are reported
absent rather than faked: Linux 20/61 present, Windows 11/61, macOS arm64
22/61, macOS Intel 21/61 — with real versions (`git 2.55.0.windows.3`,
`node 22.23.2`, `zsh 5.9`, `go 1.24.13`). `desktop-runtime-verify` check `3e`
asserts no probe result claims a version while reporting absent.

### ⚠ Known issue — targeted scans narrow the global projection

**Still present at `a382625`.** In `packages/ai-service/src/server.ts`,
`refreshNodeAvailability(ids)` builds `nodes` from only the scanned entries and
then assigns unconditionally:

```ts
providedNodeCapabilities = provided;
presentNodes = nodes;          // server.ts:149 — replaces, does not merge
```

So a **targeted** scan (`POST /environment/scan` with specific ids) replaces
the global present-node projection with just that subset. Every node not named
in the targeted scan appears to vanish until a full scan runs again.

**Impact:** node resolution can fail with `node-not-connected` for a node that
is genuinely installed, if a targeted scan ran last. **Not fixed here** — this
is a documentation task. Fixing it means merging rather than replacing when
`ids` is supplied, and that change must be re-verified with
`node-routing-verify` and `platform-verify`.

---

## Section 5 — Node routing

**Status: IMPLEMENTED · VERIFIED** (`node-routing-verify`,
`node-attribution-test`).

### Why it exists

Before node routing, "run this capability" could not express *where* it should
run, and an audit record could not say *what actually ran it*. With several
tools able to provide the same capability, both questions became load-bearing:
a mission that delegated to a coding agent could not prove which agent did the
work.

### The four node identities

Distinguishing these is the whole point. They are separate fields on purpose.

| Identity | Field | Meaning |
| --- | --- | --- |
| **Requested** | `InvocationContext.nodeId` | What the caller asked for. May be absent — "you choose". |
| **Resolved** | `NodeResolution.node` | What routing selected. |
| **Executed** | `ExecutorResult.nodeId` | What the executor reports it actually used. |
| **Recorded** | `AuditRecord.requestedNodeId` / `.executedNodeId` | Both, kept separately, forever. |

The executed node is written **only** from the executor's own report — never
inferred from the request. That is what makes attribution trustworthy.

### The pipeline

```
validate → resolveNode → policy → approval → execute → verify → audit
```

Every stage can deny. Node resolution happens **before** policy, so policy
always evaluates against a concrete node.

### Resolution failures

All five deny before execution (`capability-fabric/src/types.ts:172-178`):

| Code | Meaning |
| --- | --- |
| `unknown-node` | The requested id is not in the catalogue. |
| `node-not-connected` | Known, but not present on this machine. |
| `node-lacks-capability` | Present, but does not provide what was asked. |
| `node-unsupported` | Provides it, but AURA cannot drive that particular tool. |
| `no-provider` | Nothing present provides the capability at all. |

`NodeResolution` with `ok: true` and **no** node is valid and means the
capability needs no node (an AURA-internal action).

### Selection

`Executor.supportsNode?(node)` lets an executor refuse a node it cannot drive.
When the caller names no node and several are present, **catalogue order is the
tie-break** — `CATALOG` is walked in order in `refreshNodeAvailability`, so
ordering in `catalog.ts` is a behavioural contract, not cosmetic.

---

## Section 6 — Node governance / policy

**Status: IMPLEMENTED · VERIFIED** (`node-policy-verify`).

One engine: `packages/capability-fabric/src/policy.ts`.

### Inputs

- **`PolicySubject`** — the capability, its risk, the actor, the node.
- **`byRisk`** — default decision per risk level.
- **`overrides`** — per-capability decisions.
- **`nodeOverrides`** — per-node decisions, keyed two ways:
  - `"@<nodeId>"` — that node, any capability
  - `"<capabilityId>@<nodeId>"` — that node, that capability
- **`nodeAllowlists`** — which nodes may serve a capability.
- **`allowAutonomous`** — whether unattended execution is permitted at all.

### Combination rule

`stricter(a, b)` (`policy.ts:123`). Decisions combine by taking the **more
restrictive**, never the more permissive. This is why adding node governance
could not weaken anything that already existed.

### Security floors

Four floors, applied after everything else (`policy.ts:224-237`):

| Floor | Applies to |
| --- | --- |
| `irreversible-floor` | Anything that cannot be undone. |
| `destructive-floor` | Anything that destroys something. |
| `authorization-floor` | Anything requiring the user's authority. |
| `system-floor` | Anything touching the system (installation lives here). |

### The decision that matters most

**Node policy is deny-only. A node override can make a decision stricter; it
can never make it weaker, and it can never lower a floor.**

Why: node governance is configuration, and configuration is the thing most
likely to be wrong, copied from somewhere else, or edited by whoever has the
file. If a node override could lift `irreversible-floor`, then "which machine
am I on" would decide whether an irreversible action needs a human. The floors
exist precisely so that no configuration can answer that question.

---

## Section 7 — OpenCode

**Status: IMPLEMENTED · VERIFIED** (`agent-delegate-verify`,
`agent-failure-recovery-test` — both pass against a real OpenCode binary).

### What it is, and what it is not

OpenCode is an **external coding agent binary** that AURA may delegate work to.
It is explicitly **not**:

| Not | Because |
| --- | --- |
| a Workspace node | Workspace is the UI projection; OpenCode is a process. |
| the Mission engine | Mission plans and sequences; OpenCode performs one delegated task. |
| the Fabric | The Fabric governs; OpenCode is governed. |
| an AI model provider | Providers answer chat/completions (§11). OpenCode is spawned, not called over HTTP. |

### The path

```
agent.delegate (capability)
  → node routing picks a coding-agent node
  → policy: irreversible-floor applies
  → approval
  → resolveAgentBinary(name) against AGENT_BINARIES
  → spawn in the project cwd, with a timeout
  → capture stdout/stderr, exit code
  → verify → audit with executedNodeId
```

### Guarantees

- **`AGENT_BINARIES`** = `opencode, claude, codex, gemini, qwen, cursor-agent`
  — a list **separate from `SAFE_BINARIES` and never merged into it**. Source
  comment states the reason: an agent rewrites files on its own judgement,
  which is a categorically larger grant than running `npm test`. Consequence:
  `terminal.execute` can never launch an agent, by any crafted command.
- **Named, not located.** `resolveAgentBinary` rejects anything path-like
  (`/`, `\`, `..`), so a caller can name an agent but never point execution at
  an arbitrary executable.
- **cwd confinement** — the agent runs in the registered project directory.
- **Timeouts** — enforced by the shared primitive (§8).
- **Attribution** — the audit record names the agent node that executed.

### Verified version

`agent-delegate-verify` passed against a real installed OpenCode
(**1.18.16** observed during the v0.1.0 cycle). The version is whatever is
installed; re-check before quoting it.

### Known limitation

Detection depends on the binary being on a PATH AURA seeds. A custom npm
prefix such as `~/.npm-global/bin` is **not** covered, so OpenCode installed
there is reported absent (§19).

---

## Section 8 — Process execution

**Status: IMPLEMENTED · VERIFIED** (`process-timeout-test`).

One primitive: `packages/ai-service/src/exec/process.ts`.

| Export | Purpose |
| --- | --- |
| `settle()` (internal, `:282`) | The single place a process outcome is decided. |
| `TIMEOUT_EXIT_CODE = 124` (`:256`) | Timeout is reported as a real failure exit code. |
| `safeShell(cmd, opts)` (`:415`) | Run and return stdout; throws on failure. |
| `safeShellWithCode(cmd, opts)` (`:441`) | Run and return `{ code, stdout, stderr }`. |
| `runAgent(...)` | Delegated-agent spawn (§7). |
| Signal map (`:260`) | `SIGHUP:1, SIGINT:2, SIGQUIT:3, SIGKILL:9, SIGTERM:15`. |

### The false-success timeout bug

Historically a timed-out process could settle as **success**: the timeout killed
the child, the close handler saw no error, and the absence of a non-zero code
was read as "fine". A long-running command that was killed therefore reported
success, and a mission would proceed on the strength of work that never
finished.

The fix is structural rather than a patch at the call site: **one `settle()`**
decides every outcome, a timeout sets `code = TIMEOUT_EXIT_CODE (124)`, and
settlement happens exactly once. `process-timeout-test` covers it and passes.

**Rule for future work:** never add a second place that interprets a child
process's exit. Route it through `settle()`.

---

## Section 9 — Mission system

**Status: IMPLEMENTED · PARTIAL (UI)** — engine VERIFIED
(`hub-mission-verify`, `hub-execution-verify`); Mission Control UI is not
reachable (§19).

### Shape

- **`MissionRecord`** (`mission/types.ts`) — the mission, its goal graph, task
  states, proposals.
- **`GoalGraph`** — `{ goals, tasks }`.
- **DAG** — `mission/execution/dag.ts`, `buildDag(input)` plus
  `runnableTaskIds`. A task becomes runnable when its dependencies are done.
- **Engine** — `mission/execution/engine.ts`, class
  `MissionExecutionEngine`, rebuilding the DAG from live task statuses as
  execution proceeds.
- **Execution** goes through the **same Fabric invoke path** as any other
  capability — planning does not get a private door.
- Supporting modules: `checkpoints.ts`, `replay.ts`, `metrics.ts`,
  `reviewer.ts`, `risk.ts`, `strategies.ts`, `taskGen.ts`.

### ⚠ Structural limitation — there is no RUNNING state

Verified at `mission/types.ts:186`:

```ts
export type TaskStatus = 'pending' | 'proposed' | 'accepted' | 'rejected' | 'done' | 'error';
```

There is no in-flight state. A task being executed right now is
indistinguishable in the projection from one that has not started. Consequences:

- the UI cannot honestly show "running" from task state alone;
- a crash mid-task leaves the task looking `accepted`/`pending`, not
  interrupted;
- progress is inferred, not recorded.

Adding a state is a **model change**: it touches the DAG, the projection, the
UI and every consumer of `TaskStatus`. It was deliberately not attempted during
the release cycle.

### Node attribution

`MissionTask` carries the node that performed it, written **only** from an
executor's own report — the same rule as §5.

---

## Section 10 — system.install

**Status: IMPLEMENTED · VERIFIED** (`install-verify`).

Source: `packages/ai-service/src/exec/install.ts`, with the binary gate in
`exec/process.ts`.

### Shape

- **`InstallSpec`** — what to install, which installer, expected binary.
- **Installer catalogue** — only known installers with known behaviour.
- **`INSTALLER_BINARIES`** = `npm, pipx, cargo, gh` — a **third** allow-list,
  disjoint from `SAFE_BINARIES` and `AGENT_BINARIES` and never merged.
- **`resolveInstallerBinary`** — rejects anything path-like before consulting
  the list, exactly like the agent resolver.
- **Privilege split** — the spec records whether an install writes somewhere
  the user owns (e.g. `cargo` into `~/.cargo/bin`) or needs root.
- **Verification / read-back** — after installing, the tool is probed. Success
  means "it answered a probe", not "the installer exited 0".
- **`system-floor`** — installation always sits on a floor, so it can never be
  auto-approved by policy configuration.

### Why `terminal.execute` cannot be an installation bypass

This is the load-bearing part of the design. `terminal.execute` is medium-risk
and runs binaries from `SAFE_BINARIES`, which contains `npm`, `cargo`, `go`
and `python3` — all of which can install software. If the lists were merged,
or if `terminal.execute` accepted arbitrary arguments to them, a medium-risk
capability would silently gain the power of a `system-floor` one.

Installing forms are therefore refused through `terminal.execute` — including:

```
npm install -g …        cargo install …
go install …            python3 -m pip install …
```

An install must go through `system.install`, which means the catalogue, the
privilege split, the read-back and the floor.

### Limitations

- **Root installs** are constrained; AURA does not silently escalate.
- **No uninstall** — `system.install` installs only. Removal is out of scope.
- **`npx`** is on `SAFE_BINARIES`, and its execute-arbitrary-package nature is
  a known sharp edge (documented, not resolved).
- **"Installing" state** is not richly modelled in the UI.

---

## Section 11 — AI providers

**Status: IMPLEMENTED · PARTIAL** — `kage7-provider-verify` passes;
`verify-providers` has 10 pre-existing failures (§19).

### Architecture

- **Registry** — `provider/registry.ts` maps provider id → adapter and → the
  environment variable that auto-connects it (e.g. `kage7: 'KAGE7_API_KEY'`).
- **Adapters** — `provider/adapters/`: `anthropic, cerebras, gemini, groq,
  kage7, kimi, mistral, novita, nvidia, openai, openrouter, qwen`, over a
  shared `base.ts`.
- **Transport** — most adapters are **OpenAI-compatible**: `GET /models` for
  discovery, `POST /chat/completions` for inference, with streaming, usage
  accounting and cancellation.
- **Model registry / validation** — `modelValidation.ts`.
- **Health** — per-provider health state, persisted.
- **Error translation** — `errorTranslator.ts` turns provider errors into
  AURA-shaped ones.

### Credential storage — read this carefully

`provider/credentialStore.ts`. Keys are stored in **`providers.json` under the
AURA home directory**, encrypted with **AES-256-GCM** (random IV per key, auth
tag stored). A `fingerprint` (`first4…last4`) is kept for display.

The encryption key is derived as `sha256(seed + ':aura-provider-v2')` where
`seed` is:

1. `process.env.AURA_PROVIDER_SECRET` if set, otherwise
2. a random 32-byte seed **stored in the same `providers.json` file**.

**Honest characterisation:** with the default (2), the key material sits beside
the ciphertext. This protects against casual reading, shoulder-surfing and
accidental sharing of the file's visible contents — it does **not** protect
against an attacker who has the file. Setting `AURA_PROVIDER_SECRET` moves the
seed out of the file and is the stronger configuration. This is not an OS
keychain integration; that is **NOT IMPLEMENTED**.

No key is ever written to logs, and no key appears in any release artifact
(verified: all five v0.1.0 artifacts scanned, clean).

### Verified models

`kage7-provider-verify` passes. **Do not quote a model list from this
document** — models come from live discovery against the gateway and change.
Read them from the running service.

---

## Section 12 — Kage7

**Status: IMPLEMENTED · VERIFIED** (`kage7-provider-verify`).

Kage7 is a **model provider** — an OpenAI-compatible gateway consumed as a
normal BYOAK (bring-your-own-API-key) provider. Source:
`provider/adapters/kage7.ts`.

It is **NOT** a Workspace node, a Fabric capability, a coding agent, an
execution node, part of the Mission engine, or a dependency of OpenCode.

### Two things that make it not-quite-standard

Both are documented in the adapter's own header:

1. **The base URL is deployment-specific.** The gateway is deployed per
   operator, so `KAGE7_BASE_URL` overrides the default constant. A wrong base
   produces `/v1/v1/models` and a 404 that looks like a broken key rather than
   a misconfiguration.
2. **`/v1/models` is not strictly OpenAI-shaped.** Gateways may answer
   `{ data }`, `{ models }`, or a bare array, and may carry context/output
   limits worth keeping. Discovery normalises all three.

Validated behaviour: discovery, authentication, model selection, real
inference, streaming, usage accounting, health, invalid-model handling,
invalid-key handling and cancellation.

---

## Section 13 — Tauri desktop

**Status: IMPLEMENTED · VERIFIED** on all four platform targets
(`desktop-runtime-verify`).

**Tauri v2. There is no Electron architecture in this repository.** The
renderer is the OS WebView: WebKitGTK (Linux), WebView2 (Windows), WKWebView
(macOS).

### The three Rust files

| File | Role |
| --- | --- |
| `main.rs` | Thin entry point. |
| `lib.rs` | IPC commands, window setup, service-script resolution. |
| `service.rs` | The AURA service lifecycle. The most safety-critical file in the shell. |

### Service lifecycle

1. **Resolve the script** — `resolve_service_script()`: the packaged resource
   directory first, then the repo's `.aura/ai-service.mjs` for development.
   Nothing is guessed; if neither exists the shell reports an incomplete
   installation.
2. **Resolve Node** — a candidate search plus a PATH seeded with the usual
   install locations (`~/.local/bin` and friends).
3. **Spawn**, then **health-gate**: the window is **not shown** until the
   service answers. `desktop-runtime-verify` asserts `visible=false` before
   ready.
4. **Reuse** — if a compatible AURA service already owns port **4319**, the
   shell attaches to it instead of starting a second one.
5. **Foreign refusal** — if something else holds 4319, AURA **refuses to take
   the port and never kills the process**, and says so in plain language.
   Verified by `packaging-verify` checks `8c1`–`8c4`.
6. **Shutdown** — graceful first: `POST /shutdown`, force only if ignored.
7. **Orphan prevention** — Unix installs SIGTERM/SIGINT/SIGHUP handlers;
   Windows uses a **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
   (§14).

### Port

`AI_PORT`, default **4319** (`start.ts:16`, `server.ts:991`).

### IPC surface — six commands, no shell

```
environment_ping, service_status,
code_read_dir, code_read_file, code_write_file, code_create_file
```

Every filesystem command goes through `resolve_within_root()`, which
canonicalises both the root and the candidate and rejects anything that does
not remain inside the root (`"Path escapes project root"`). The Tauri
capability ACL grants **`core:default` only**.

### Two platform bugs found by running it (both fixed)

- **Windows verbatim paths.** `canonicalize()` and Tauri's resolver return
  `\\?\D:\…`. Node cannot use one as a main module — it parses the device root
  and dies with `EISDIR: lstat 'D:'`. `strip_verbatim()` removes the prefix
  before spawning. Guarded with `cfg!(windows)` rather than `#[cfg(windows)]`
  **on purpose**, so Linux builds still type-check the Windows branch.
- **Windows orphaning.** `TerminateProcess` (Task Manager "End task") runs no
  handler and no `RunEvent::Exit`, so the service survived holding 4319. The
  Job Object fixes this in the kernel. Only a service *this process spawned* is
  assigned to the job — a reused service belongs to its own owner.

---

## Section 14 — Cross-platform release

Evidence: CI run **`31693075020`**, head `a382625`, all five jobs success.

| | Linux x64 | Windows x64 | macOS ARM64 | macOS Intel x64 |
| --- | --- | --- | --- | --- |
| **Build** | BUILT | BUILT | BUILT | BUILT |
| **Runtime** | **RUNTIME VERIFIED** 29/29 | **RUNTIME VERIFIED** 34/34 | **RUNTIME VERIFIED** 29/29 | **RUNTIME VERIFIED** 29/29 |
| **Detection** | VERIFIED 20/61 | VERIFIED 11/61 | VERIFIED 22/61 | VERIFIED 21/61 |
| **Service lifecycle** | VERIFIED | VERIFIED (normal **and** abnormal) | VERIFIED | VERIFIED |
| **Installer** | VERIFIED (deb install→launch→detect→uninstall; AppImage direct) | VERIFIED (NSIS silent install→launch→detect→uninstall) | VERIFIED (DMG mount→copy→launch→detect) | VERIFIED (DMG mount→copy→launch→detect) |
| **Architecture** | x64 native | x64 native | arm64 native | x64 native (`macos-15-intel`) |
| **Signing** | NOT APPLICABLE | **NOT CONFIGURED** | **NOT CONFIGURED** | **NOT CONFIGURED** |

Windows carries five extra checks because of the abnormal-termination phase
(Job Object): shell killed with `taskkill /F`, service pid confirmed gone,
port released with no graceful shutdown having run.

### Artifacts

| Artifact | Format |
| --- | --- |
| `AURA-Hub-0.1.0-linux-x64.AppImage` | ELF static-pie |
| `AURA-Hub-0.1.0-linux-x64.deb` | Debian 2.0 (`depends: nodejs`) |
| `AURA-Hub-0.1.0-windows-x64.exe` | NSIS / PE32 |
| `AURA-Hub-0.1.0-macos-arm64.dmg` | Apple DMG v4 |
| `AURA-Hub-0.1.0-macos-x64.dmg` | Apple DMG v4 |

### Signing — stated plainly

Nothing is signed. macOS builds are **unsigned and not notarized**, so
Gatekeeper quarantines them; the Windows installer is **unsigned**, so
SmartScreen warns. This is the single gap between v0.1.0 and a public-facing
release. `docs/INSTALL.md` names the certificates and CI secrets required.

---

## Section 15 — GitHub Release

See [AURA_HUB_RELEASE_HANDOFF.md](./AURA_HUB_RELEASE_HANDOFF.md) for the full
detail, including SHA-256 values and the repeatable procedure.

| Field | Value |
| --- | --- |
| Tag | `v0.1.0` |
| Commit | `a3826253e713b36134fd1cf479d8462f6d68d9f5` |
| URL | https://github.com/Aura-hub-ai-native-workspace/aura-hub/releases/tag/v0.1.0 |
| Assets | the five artifacts above |
| Source | CI run `31693075020` — **downloaded, not rebuilt** |

Every asset was SHA-256 verified before upload and re-downloaded and re-hashed
after publication.

---

## Section 16 — Website download system

### ⚠ The most important website fact

**`website/` in this repository is a mirror. It does not deploy anything.**

The live site deploys from a **separate repository**:
`Aura-hub-ai-native-workspace/aura-hub-website`, on **Cloudflare Workers
Static Assets** (`wrangler.jsonc`, `assets.directory: "./"`, **no build step**).
Cloudflare was misdetecting this monorepo as a Worker/Node project, which is
why the site was split out.

Editing `website/index.html` here changes nothing that users see.

### The download section

One static `index.html`; no framework, no backend, no database, no API.

A single `RELEASE` object is the source of truth for version, release URL and
all five asset filenames — **`v0.1.0` appears nowhere in the markup**. A new
release is an edit to that one object.

All five downloads are always visible. Platform detection only adds a
"Recommended for your system" highlight and never hides, disables or reorders
anything. **macOS architecture is deliberately not guessed**: Safari reports
the same platform string for Apple Silicon and Intel, and a Rosetta-translated
browser reports Intel on an M-series machine, so both builds are offered side
by side. The page states Node.js 18+, unsigned Windows, and unsigned +
not-notarized macOS.

### The two website commits

| Repo | Commit |
| --- | --- |
| `aura-hub-website` (`main`) | `f42a7bb3dbec868309ad68d26a8aad9e4e20853c` |
| `aura-hub` (`feature/website-deployment`) | `265e690f19a38e66a3c9adc21ceeea14bc004ec3` |

Both are `feat(website): add AURA Hub v0.1.0 downloads`. The mirror was synced
**from** the deployed file, not over it — the deployed copy was ahead by 14
lines of canonical/OpenGraph/Twitter metadata that a naive copy would have
reverted.

### Live URL

`https://aurahub.is-a.dev` returned **HTTP 403** (a Cloudflare error page) when
checked on 2026-08-13, browser User-Agent included. Reported as observed, not
diagnosed — it may be an access rule, bot protection, or an unbound domain. The
repo's own lychee CI excludes this domain from link checking.

---

## Section 17 — CI/CD

`.github/workflows/ci.yml`. Two jobs.

**`build`** (`ubuntu-latest`) — `npm ci`, `npm run typecheck`, `npm run build`.

**`desktop-build`** — a matrix, `fail-fast: false`:

| `os` | `label` | bundles |
| --- | --- | --- |
| `ubuntu-latest` | `linux-x64` | `appimage,deb` |
| `windows-latest` | `windows-x64` | `nsis` |
| `macos-latest` | `macos-arm64` | `app,dmg` |
| `macos-15-intel` | `macos-x64` | `app,dmg` |

Steps: install deps → **build (retried 3×)** → xvfb on Linux → **runtime
verification** → stage artifacts → **installer verification** → upload.

### Why native runners

A compile on Linux is not a build on Windows or macOS, and a build is not a
run. Every artifact is produced by its native toolchain and then **executed on
that same OS**. This is what turns "BUILT" into "RUNTIME VERIFIED" — and it is
not theoretical: the Windows verbatim-path bug and the Windows orphaning bug
were both found this way and could not have been found on Linux.

### Two CI facts worth remembering

- **The build step is retried 3×** because Tauri downloads bundler tooling at
  build time (AppRun/linuxdeploy on Linux, NSIS binaries on Windows) and
  GitHub's CDN intermittently drops those connections, surfacing as
  `failed to bundle project: io: Peer disconnected`. A genuine build error
  still fails — three times.
- **`macos-13` was retired in December 2025.** A retired runner label does not
  fail a job, it **queues it forever** — eight consecutive runs sat unassigned
  for ten hours looking exactly like runner scarcity. The Intel leg is now
  `macos-15-intel`, which GitHub has said is planned to be the **last** Intel
  image.

### Artifact naming

`scripts/stage-release-artifacts.mjs` renames bundles to
`AURA-Hub-<version>-<platform>-<arch>.<ext>`, reading the version from
`tauri.conf.json` — never inventing it.

---

## Section 18 — Test suite

All are plain scripts: **`node scripts/<name>.mjs`**. They are *not* npm
scripts — `npm run hub-verify` does not exist and will fail.

Most require the AURA service on **:4319** (`npm run ai`). The three
UI suites additionally require the dev server on **:1420** (`npm run dev`).

| Script | Validates | Last result | Real or mock | Limitation |
| --- | --- | --- | --- | --- |
| `hub-verify.mjs` | Hub UI end-to-end | **PASS** | Real browser + real service | Needs `:1420` |
| `hub-mission-verify.mjs` | Mission integration | **PASS** | Real | Needs `:1420` |
| `hub-execution-verify.mjs` | Governed execution, real tasks | **PASS** | Real execution | Needs `:1420` |
| `node-policy-verify.mjs` | Node governance, floors, `stricter()` | **PASS** | Real | — |
| `node-routing-verify.mjs` | Resolution + all failure codes | **PASS** | Real | — |
| `node-attribution-test.mjs` | requested vs executed node in audit | **PASS** | Real | — |
| `agent-delegate-verify.mjs` | `agent.delegate` via real OpenCode | **PASS** | **Real binary** | Needs OpenCode on a seeded PATH |
| `agent-failure-recovery-test.mjs` | Agent failure paths | **PASS** | Real | Locally modified (uncommitted, user-owned) |
| `process-timeout-test.mjs` | Timeout ⇒ exit 124, no false success | **PASS** | Real | — |
| `install-verify.mjs` | `system.install`, floors, bypass refusal | **PASS** | Real | — |
| `platform-verify.mjs` | Environment detection | **PASS** | Real | — |
| `kage7-provider-verify.mjs` | Kage7 discovery→inference→cancel | **PASS** | Real gateway | Needs a key |
| `packaging-verify.mjs` | Deep Linux packaging, port ownership | **40/44** | Real | 4 env-dependent (§19) |
| `desktop-runtime-verify.mjs` | Packaged shell on the native OS | Linux 29/29 · Win 34/34 · mac arm64 29/29 · mac x64 29/29 | Real packaged app | Windows-only phase 10 |
| `verify-providers.ts` (via `scripts/run-ts.mjs`) | Provider switching | **FAIL — 10** | Real | Pre-existing (§19) |
| `ui-approval-test.mjs` (`npm run test:ui`) | Approval UI | **FAIL — 17** | Real browser | Pre-existing (§19) |

Also present: `verify-automation.ts`, `verify-automation-runtime.ts`,
`verify-predictive.ts` — **not run** during the v0.1.0 cycle; status unknown.

---

## Section 19 — Known failures

Verified on 2026-08-13 at `a382625`. Nothing here is hidden or waved away.

### 1. `verify-providers` — 10 failures · PRE-EXISTING · NOT release-blocking

Provider **switching** lags by one: after switching to `groq`, the active
provider still reads `mistral`, and the runtime answers as the previous
provider.

```
✗ switch to cerebras activates runtime
✗ active provider id is groq — mistral
✗ groq runtime is active — [mistral:mistral-large-latest] hello from the mock runtime
```

Reproduced at HEAD without the release changes, in an isolated worktree.
**Intentionally untouched** — provider architecture was out of scope.

### 2. `ui-approval-test` — 17 failures · PRE-EXISTING · NOT release-blocking

The Mission Control unreachability regression from earlier Workspace work.
**Intentionally untouched** — awaiting an architectural decision.

### 3. `packaging-verify` — 4 of 44 · ENVIRONMENT-DEPENDENT · NOT release-blocking

```
FAIL 4e. a tool outside the launcher PATH is still detected — opencode present=false
FAIL 5c/5d/5e. high-risk capability gated — rule=unknown-node, 0 approval requests
```

One root cause: on the development machine `opencode` exists **only** at
`/home/Groot/.npm-global/bin/opencode` — a custom npm prefix AURA's PATH
seeding does not cover (it seeds `~/.local/bin` and similar). With no agent
node present, the high-risk call is denied at `unknown-node` instead of at the
irreversible floor, so no approval request is recorded.

**Safety is unaffected**: the outcome is still `denied` with `attempts=0`.
This same suite passed earlier the same day; the `opencode` symlink was created
at 23:14, after that run. Confirm by symlinking `opencode` into `~/.local/bin`
and re-running.

### 4. Mission Control and ~19 command-palette surfaces are unreachable

Pre-existing; the cause of failure 2. Not release-blocking for a downloadable
build, but it does mean the shipped app has UI a user cannot open.

---

## Section 20 — Technical debt

Priorities reflect *observed* impact, not ambition.

### High

1. **Targeted scans narrow the global node projection** (§4) — can make a
   present node unroutable. A correctness bug in a live path.
2. **Mission has no RUNNING state** (§9) — in-flight work is unobservable and
   interrupted work is indistinguishable from pending.
3. **Mission Control unreachable** (§19) — shipped UI a user cannot open.

### Medium

4. **Provider-switch activation lag** (§19) — 10 failing checks.
5. **PATH seeding misses custom npm prefixes** (§19) — real tools reported
   absent.
6. **Credential seed stored beside the ciphertext** (§11) — set
   `AURA_PROVIDER_SECRET`, or integrate an OS keychain.
7. **No code signing** (§14) — blocks public distribution.

### Low

8. **The early-access modal in the website is now unreferenced** — left in
   place deliberately rather than deleting existing content.
9. **`npx` on `SAFE_BINARIES`** (§10) — a known sharp edge.
10. **Pre-existing mobile overflow on the website** from decorative `.orb`
    elements — invisible to users because `body { overflow-x: hidden }`.
11. **`verify-automation*` / `verify-predictive` unrun** — unknown status.

---

## Section 21 — Not implemented

Absent on purpose. Do not assume any of it is in progress.

- **Code signing and notarization** — Windows and macOS both.
- **Linux ARM and Windows ARM builds.**
- **`system.install` uninstall** — install only.
- **A notification-specific test suite** — none exists. Do not invent one to
  claim coverage.
- **OS keychain credential storage** — file-based only (§11).
- **New agent adapters** beyond `AGENT_BINARIES`.
- **A backend, database or API for the website** — static assets only.
- **Auto-update** — no updater is configured.
- **A Mission RUNNING state** (§9).

---

## Section 22 — Security model

### Boundaries

| Boundary | Mechanism |
| --- | --- |
| **Renderer cannot execute** | Six IPC commands, none a shell. `core:default` ACL. Zero exec/spawn/shell invokes in the UI. |
| **Project confinement** | `resolve_within_root()` canonicalises both sides and rejects escapes. Service-side execution runs in the registered project cwd. |
| **Binary allow-lists** | `SAFE_BINARIES` (terminal), `AGENT_BINARIES` (delegation), `INSTALLER_BINARIES` (installation) — **three disjoint sets, never merged**. |
| **Named, not located** | Agent and installer resolvers reject `/`, `\`, `..` before consulting their list. |
| **Policy floors** | `irreversible-`, `destructive-`, `authorization-`, `system-floor`. No configuration lowers them. |
| **Node governance is deny-only** | An override may only make a decision stricter (§6). |
| **Approval** | Anything on a floor reaches a human. |
| **Audit** | Requested and executed node both recorded, from the executor's own report. |
| **Port ownership** | A foreign process on 4319 is refused and **never killed**. |
| **Secrets** | AES-256-GCM at rest; never logged; verified absent from all five artifacts. |

### What cannot be bypassed

- Launching a coding agent through `terminal.execute` — different list.
- Installing software through `terminal.execute` — different list, and a floor.
- Auto-approving an irreversible action by editing node policy — deny-only.
- Reading or writing outside the project root through the IPC filesystem
  commands — canonicalised containment.
- Taking over port 4319 from another process — refusal is unconditional.

### What is *not* claimed

Local file access defeats the credential store's default configuration (§11).
An attacker with the user's filesystem is outside this model.

---

## Section 23 — Development workflow

All commands verified against `package.json` at `a382625`.

```bash
npm ci                     # install (monorepo workspaces: apps/*, packages/*)

npm run ai                 # bundle + start the AURA service on :4319
npm run dev                # frontend dev server on :1420
npm run desktop:dev        # Tauri shell in dev mode

npm run typecheck          # ai-service tsconfig + desktop project references
npm run build              # build the desktop frontend
npm run desktop:build      # full Tauri build (NO_STRIP=true)
npm run service:bundle     # bundle the service for packaging
npm run test:ui            # ui-approval-test (currently 17 failures, §19)
npm run clean              # rimraf node_modules and dist
```

Verification suites are **not** npm scripts:

```bash
node scripts/node-policy-verify.mjs        # service on :4319 required
node scripts/hub-verify.mjs                # ALSO needs npm run dev on :1420
node scripts/desktop-runtime-verify.mjs    # needs a built app; xvfb on headless Linux
node scripts/packaging-verify.mjs          # needs port 4319 FREE
node scripts/run-ts.mjs scripts/verify-providers.ts
```

Website (the deployed repo, not `website/`):

```bash
git clone https://github.com/Aura-hub-ai-native-workspace/aura-hub-website
# no build step; open index.html, or `npx wrangler deploy` per wrangler.jsonc
```

---

## Section 24 — Release workflow

**DO NOT TOUCH `main` UNLESS EXPLICITLY APPROVED.**

1. **Branch check** — `git status --short`, `git branch --show-current`.
   Confirm no user WIP is about to be swept up.
2. **Local validation** — `npm run typecheck`, the regression suites (§18),
   `node scripts/packaging-verify.mjs`.
3. **Native CI** — push the branch; every platform builds and **runtime
   verifies** on its own runner. Do not accept a green build as a green run.
4. **Artifact verification** — download the CI artifacts and record SHA-256.
5. **GitHub Release** — tag the **validated commit**:
   ```bash
   gh release create v<version> --target <sha> --title "AURA Hub v<version>" \
     --notes-file <notes> <five artifact paths>
   ```
   Notes must state: platforms supported, Node.js 18+, Windows unsigned, macOS
   unsigned and **not notarized**. Never claim signed, notarized,
   self-contained or zero-install.
6. **Post-publish verification** — download all five public URLs and re-hash
   against step 4. Confirm file types differ per platform (no substitution).
7. **Website** — update the `RELEASE` object in the **`aura-hub-website`**
   repo (§16). Then sync the mirror **from** the deployed file.
8. **Download validation** — verify every link resolves, no CI-artifact URLs,
   version displayed, all platforms visible.
9. **Final git verification** — local `HEAD == origin` for every repo touched;
   `main` unchanged; user WIP untouched.

---

## Section 25 — Continuation rules

For the next Claude Code or OpenCode session. These are derived from what
actually went wrong in this repository, not from generic advice.

1. **Read this document first**, then
   [`WORKSPACE_EXECUTION_ARCHITECTURE.md`](./WORKSPACE_EXECUTION_ARCHITECTURE.md).
2. **Run `git status --short` before touching anything.** This tree carries
   long-lived user WIP.
3. **Never reset, clean, stash-drop or delete user work.** Specifically:
   the Ask AURA / frontend WIP, `graphify-out/*`, `package-lock.json`,
   `scripts/agent-failure-recovery-test.mjs`.
4. **Never modify `main` without explicit approval.** Never merge it to "catch
   up".
5. **Do not create a second authority.** No second policy engine, execution
   engine, environment scanner, node catalogue, DAG builder, approval store or
   process primitive. If you need different behaviour, extend the existing one.
6. **Reuse the Fabric invoke path.** Anything that executes goes through
   validate → resolveNode → policy → approval → execute → verify → audit.
7. **Never merge the three binary allow-lists**, and never add an agent to
   `SAFE_BINARIES`.
8. **Never let configuration lower a floor.** Node policy is deny-only.
9. **Never claim verification you did not perform.** Keep BUILT, RUNTIME
   VERIFIED and NOT RUNTIME VERIFIED distinct, always.
10. **Never fix a test by weakening it.** If a check fails, first establish
    whether the product or the check is wrong — in this cycle, *four separate
    times*, the check was wrong (a machine-specific floor assertion, a
    Windows-only abnormal-kill assumption, a 600 ms smooth-scroll wait, and a
    `scrollWidth` overflow metric). Fix the check honestly and say so.
11. **Re-run the regression suites after any architectural change** (§18), and
    re-run `desktop-runtime-verify` after touching `service.rs` or `lib.rs`.
12. **Platform-specific code must still compile everywhere.** Use
    `cfg!(windows)` over `#[cfg(windows)]` where practical, so the branch that
    only *runs* on one OS is still *type-checked* on the others.
13. **Never expose credentials.** No key in logs, diffs, artifacts or docs.
14. **The website in this repo deploys nothing.** Live changes go to
    `aura-hub-website` (§16).
15. **When two sources disagree, document the disagreement** (§29). Do not
    silently pick one, and do not change code to make a document true.

---

## Section 26 — Current git state

Recorded 2026-08-13. Verify before relying on it.

| Ref | Commit |
| --- | --- |
| `main` | `052063f9da6bc4ddd57fff9bb5c7ec0d01ed3225` |
| `feature/workspace-execution-environment` (local **and** remote) | `a3826253e713b36134fd1cf479d8462f6d68d9f5` |
| `feature/website-deployment` (local **and** remote) | `265e690f19a38e66a3c9adc21ceeea14bc004ec3` |
| `aura-hub-website` `main` | `f42a7bb3dbec868309ad68d26a8aad9e4e20853c` |
| Release tag | `v0.1.0` → `a382625` |

### Milestone commits on `feature/workspace-execution-environment`

```
a382625  ci: ask the Windows installer where it installed, instead of guessing
6ea37a4  ci: build macOS Intel on a runner that still exists
87a1de6  ci: find the Windows app by the name the installer actually gives it
5b7f919  test(desktop): prove the shell owns the service it is judged on
d98f484  fix(desktop): enable Win32_Security so CreateJobObjectW actually exists
150eb7c  fix(desktop): stop Windows orphaning the service when the shell is killed
d9758eb  ci: retry the desktop build past transient bundler downloads
090aa86  test(desktop): close the shell the way a user closes it
57a886e  fix(desktop): resolve the service script Node can actually open on Windows
072d41d  fix(verify): make the high-risk floor check machine-independent
af7e3ab  feat(desktop): make AURA Hub distributable across platforms
49459ab  feat(ai): add Kage7 model provider
04da489  feat(release): make AURA Hub build and run on Windows and macOS
ec5d89b  feat(fabric): add governed installation via system.install
612a648  feat(desktop): package AURA Hub as a Tauri desktop application
b06e935  feat(workspace): add node-aware governance
6e7374c  feat(workspace): introduce first-class node routing
4293aa0  feat(workspace): harden governed agent execution
9690dc4  feat(workspace): complete phase 2 mission integration
19c197c  feat(workspace): establish execution environment phase 1
```

### Pre-existing dirty files — DO NOT TOUCH

Present and uncommitted before the release work began, and still uncommitted:

```
 M apps/desktop/src/screens/Home.tsx
 M apps/desktop/src/screens/ScreenRouter.tsx
 M apps/desktop/src/screens/ai/AiWorkspace.tsx
 M apps/desktop/src/screens/project/ProjectWorkspace.tsx
 M apps/desktop/src/shell/RightPanel.tsx
 M graphify-out/.graphify_labels.json
 M graphify-out/.graphify_root
 M graphify-out/GRAPH_REPORT.md
 D graphify-out/graph.html
 M graphify-out/graph.json
 M package-lock.json
 M packages/core/src/store/appStore.ts
 M scripts/agent-failure-recovery-test.mjs
```

This is user work in progress. **Do not stage, commit, revert or clean it.**

---

## Section 27 — Master timeline

Chronological, by commit.

| Milestone | Commit | What it established |
| --- | --- | --- |
| Governed mission fabric | `af146ed` | The Fabric as execution authority. |
| Notification overlay repair | `880a8c7` | UI fix. |
| Execution environment phase 1 | `19c197c` | Workspace execution foundation. |
| Mission integration phase 2 | `9690dc4` | Mission ↔ execution wiring. |
| Hardened agent execution | `4293aa0` | Agent delegation safety. |
| **Node routing** | `6e7374c` | Requested / resolved / executed / recorded. |
| **Node governance** | `b06e935` | Deny-only node policy under the floors. |
| **Tauri packaging** | `612a648` | Desktop shell + service lifecycle. |
| **system.install** | `ec5d89b` | Governed installation, third allow-list. |
| Frontend integration | `0c3c12c` | Merge of approved frontend work. |
| Windows/macOS build | `04da489` | Cross-platform build capability. |
| **Kage7 provider** | `49459ab` | OpenAI-compatible gateway adapter. |
| **Cross-platform distribution** | `af7e3ab` | Native CI matrix, installers, staging. |
| Windows path fix | `57a886e` | Verbatim `\\?\` paths broke Node. |
| Windows orphan fix | `150eb7c`+`d98f484` | Job Object cleanup. |
| Ownership-proving tests | `5b7f919` | Tests that can tell spawned from reused. |
| Intel runner | `6ea37a4` | `macos-13` retired → `macos-15-intel`. |
| **GitHub Release v0.1.0** | tag on `a382625` | Five verified artifacts published. |
| **Website downloads** | `f42a7bb` / `265e690` | Real download section, live repo + mirror. |

---

## Section 28 — If you are a new Claude session, read this first

**AURA Hub** is a Tauri v2 desktop app: a Rust shell that owns a local Node
service (`:4319`) which runs every capability through one governed pipeline.

- **Branch:** `feature/workspace-execution-environment` @ `a382625`
- **Release:** v0.1.0, published, four platforms runtime-verified
- **Architecture docs:** this file, then `WORKSPACE_EXECUTION_ARCHITECTURE.md`,
  `CAPABILITY_FABRIC.md`, `CONNECTED_ENVIRONMENT.md`

**Start it:**
```bash
npm ci && npm run ai        # service on :4319
npm run dev                 # UI on :1420   (needed by hub-* suites)
npm run desktop:dev         # or the full desktop shell
```

**Already finished:** governed execution, node routing + governance, OpenCode
delegation, `system.install`, Kage7 provider, Tauri packaging, four-platform
release, GitHub Release, website downloads.

**Do not touch:** `main`; the pre-existing WIP in §26; `graphify-out/*`; the
security floors; the three binary allow-lists.

**The authorities** (never duplicate them): policy engine
(`capability-fabric/src/policy.ts`), Fabric invoke path, process primitive
(`exec/process.ts`), environment scanner (`environment.ts`), node catalogue
(`connected-environment/src/catalog.ts`), DAG builder
(`mission/execution/dag.ts`).

**Validate changes:** `npm run typecheck`, then the suites in §18 with
`node scripts/<name>.mjs`, then `desktop-runtime-verify` if you touched the
shell. Expect `verify-providers` (10) and `ui-approval-test` (17) to fail —
those are pre-existing (§19).

---

## Section 29 — Source of truth

When sources disagree, this is the order — most authoritative first:

1. **The source code at the current commit.** It is what runs.
2. **CI / release evidence** — a runtime-verified CI run or a published,
   hash-verified artifact is stronger than any prose, because it observed real
   behaviour on a real machine.
3. **Verification scripts** — they encode expected behaviour executably, but a
   check can itself be wrong (four were, this cycle).
4. **Git history and commit messages** — they record *why*, which the code
   cannot.
5. **Architecture documentation** (`docs/`) — intent, sometimes ahead of or
   behind the code.
6. **The website repository** — authoritative only for what is published to
   users.

### What to do when they disagree

**Document the disagreement; do not silently pick a winner, and never edit
code to make a document true.** State both positions, name the commit and file
that support each, and let a human decide.

### Disagreements found while writing this document

- **`website/README.md`** says the folder "is the deployable source so it can
  be hosted anywhere real" while its own banner says the site deploys from
  `aura-hub-website`. Both are literally true — it is deployable, but it is
  **not what is deployed**. Resolved by stating the deployed repo explicitly
  (§16); the README was left unmodified.
- **`website/README.md`** describes "Download AURA Hub" as opening an
  early-access modal because "there's no signed installer yet". As of `f42a7bb`
  the buttons link to real v0.1.0 assets. The README is now **stale**; it was
  left unmodified (documentation task, and it lives in the mirror).
- **`docs/` contains older architecture documents** (`ARCHITECTURE.md`,
  `docs/architecture/*`) predating the Capability Fabric. They are not wrong so
  much as **superseded**; where they conflict with this document, the source
  tree and this handoff win.

---

## Section 30 — Handoff status

```
AURA HUB v0.1.0 HANDOFF STATUS

PROJECT:                IMPLEMENTED — first desktop release shipped
RELEASE:                VERIFIED    — v0.1.0 published, 5 assets hash-verified
DESKTOP:                VERIFIED    — Tauri v2 shell, 4 platforms runtime-verified
AI SERVICE:             IMPLEMENTED — :4319, health-gated, graceful shutdown
WORKSPACE:              PARTIAL     — execution verified; several UI surfaces unreachable
MISSION:                PARTIAL     — engine verified; no RUNNING state; UI unreachable
FABRIC:                 VERIFIED    — single authority, floors intact
CONNECTED ENVIRONMENT:  IMPLEMENTED — real detection on 4 platforms; targeted-scan bug open
NODE ROUTING:           VERIFIED    — 5 failure codes, attribution from executor
NODE GOVERNANCE:        VERIFIED    — deny-only, cannot lower a floor
OPENCODE:               VERIFIED    — real delegation, separate allow-list
SYSTEM.INSTALL:         VERIFIED    — third allow-list, system-floor, no uninstall
KAGE7:                  VERIFIED    — model provider only
TAURI:                  VERIFIED    — v2, no Electron, 6 IPC commands
LINUX:                  RUNTIME VERIFIED (29/29) — AppImage + deb + uninstall
WINDOWS:                RUNTIME VERIFIED (34/34) — NSIS + Job Object cleanup
MACOS:                  RUNTIME VERIFIED — arm64 29/29, Intel x64 29/29, DMG flow
WEBSITE:                IMPLEMENTED — live repo + mirror; live URL returned 403
GITHUB RELEASE:         VERIFIED    — tag on a382625, all 5 URLs hash-verified
DOCUMENTATION:          IMPLEMENTED — this handoff + 3 companions

SIGNING:                NOT IMPLEMENTED — blocks public distribution
```
