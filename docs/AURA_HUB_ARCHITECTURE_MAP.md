# AURA Hub — Architecture Map

Control and data flows, drawn from the source tree at `a382625`. Nothing here
is aspirational: every box corresponds to code named in the tables.

Companions: [Master Handoff](./AURA_HUB_MASTER_HANDOFF.md) ·
[Quickstart](./AURA_HUB_QUICKSTART.md) ·
[Release Handoff](./AURA_HUB_RELEASE_HANDOFF.md)

---

## 1. The whole system

```
┌──────────────────────────────────────────────────────────────┐
│  AURA Hub Desktop                                            │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Renderer — OS WebView (WebKitGTK / WebView2 / WKWeb)   │  │
│  │  apps/desktop/src  (React + TypeScript)                 │  │
│  └───────────┬──────────────────────────┬─────────────────┘  │
│              │ Tauri IPC (6 commands)   │ HTTP               │
│              ▼                          │                    │
│  ┌────────────────────────────┐         │                    │
│  │  Tauri shell (Rust)        │         │                    │
│  │  src-tauri/src/lib.rs      │         │                    │
│  │  src-tauri/src/service.rs  │         │                    │
│  │   • owns the service proc  │         │                    │
│  │   • health gate            │         │                    │
│  │   • port ownership         │         │                    │
│  │   • orphan prevention      │         │                    │
│  └───────────┬────────────────┘         │                    │
│              │ spawn(node ai-service.mjs)                    │
└──────────────┼──────────────────────────┼────────────────────┘
               ▼                          ▼
        ┌────────────────────────────────────────┐
        │  AURA service — 127.0.0.1:4319         │
        │  packages/ai-service/src/server.ts     │
        └───────────────┬────────────────────────┘
                        │
   ┌────────────────────┼─────────────────────┬──────────────────┐
   ▼                    ▼                     ▼                  ▼
┌─────────┐   ┌───────────────────┐   ┌──────────────┐   ┌─────────────┐
│ Mission │   │ Capability Fabric │   │  Connected   │   │  Providers  │
│ engine  │──▶│  (the authority)  │◀──│ Environment  │   │  (models)   │
└─────────┘   └─────────┬─────────┘   └──────────────┘   └─────────────┘
                        │
                        ▼
              ┌───────────────────┐
              │  exec primitives  │
              │  process / install│
              └───────────────────┘
```

**The renderer never executes a process.** It has six IPC commands
(`environment_ping`, `service_status`, `code_read_dir`, `code_read_file`,
`code_write_file`, `code_create_file`) and none is a shell.

---

## 2. The invoke pipeline — the single execution authority

Every capability, from every caller, takes this path. The Mission engine uses
it too; planning gets no private door.

```
   caller (UI · Mission engine · POST /fabric/invoke)
        │
        ▼
   ┌──────────┐   invalid ──────────────────────────────► denied
   │ validate │
   └────┬─────┘
        ▼
   ┌─────────────┐  unknown-node │ node-not-connected
   │ resolveNode │  node-lacks-capability │ node-unsupported ──► denied
   └────┬────────┘  no-provider
        │  ok: { node? }          (ok with NO node = capability needs none)
        ▼
   ┌────────┐  byRisk · overrides · nodeOverrides · nodeAllowlists
   │ policy │  combined with stricter(), then FLOORS applied
   └────┬───┘  ────────────────────────────────────────────► denied
        ▼
   ┌──────────┐  needs a human ──► awaiting-approval ──► (user decides)
   │ approval │
   └────┬─────┘
        ▼
   ┌─────────┐  Executor.supportsNode?(node) may refuse
   │ execute │  runs via the ONE process primitive
   └────┬────┘
        ▼
   ┌────────┐  did it actually do what it claimed?
   │ verify │
   └────┬───┘
        ▼
   ┌───────┐  requestedNodeId + executedNodeId, both recorded
   │ audit │  executedNodeId comes ONLY from the executor's report
   └───────┘
```

| Stage | Source |
| --- | --- |
| validate, execute, verify, audit | `packages/capability-fabric/src/fabric.ts` |
| resolveNode | `capability-fabric` + `connected-environment/src/resolver.ts` |
| policy, floors, `stricter()` | `packages/capability-fabric/src/policy.ts` |
| approval | `packages/ai-service/src/fabric/approvalStore.ts` |
| executors | `packages/ai-service/src/fabric/executors.ts` |

---

## 3. Node identity — four distinct things

```
  caller asks          routing decides        executor reports        audit keeps
 ─────────────        ────────────────       ─────────────────      ─────────────
 InvocationContext                                                  AuditRecord
   .nodeId      ──►   NodeResolution   ──►   ExecutorResult    ──►   .requestedNodeId
  (may be absent)       .node                  .nodeId               .executedNodeId
   "you choose"                              (what really ran)      (both, forever)
```

The executed node is **never inferred from the request**. That asymmetry is
what makes attribution trustworthy: a mission can prove which agent did the
work, not merely which one was asked.

---

## 4. Policy composition

```
  byRisk[risk]
       │
       ├── overrides[capabilityId]
       │
       ├── nodeOverrides["@<nodeId>"]                (node, any capability)
       │
       ├── nodeOverrides["<capabilityId>@<nodeId>"]  (node, that capability)
       │
       └── nodeAllowlists[capabilityId]
                    │
                    ▼
            stricter(a, b)          ← always the MORE restrictive
                    │
                    ▼
        ┌────────────────────────┐
        │  FLOORS (unconditional)│  irreversible · destructive
        │  no config lowers these│  authorization · system
        └────────────────────────┘
                    │
                    ▼
        allow │ requires-approval │ deny
```

**Node governance is deny-only.** An override can tighten a decision; nothing
in configuration can loosen one, and nothing can lower a floor.

---

## 5. Connected Environment

```
  CATALOG (connected-environment/src/catalog.ts)
     │  id · name · capabilities · probe command
     ▼
  probeNode(id)  ──► runs the probe, reads output
     │              (presence is NOT inferred from exit code alone)
     ▼
  scanEnvironment(ids?, refresh)
     │
     ▼
  refreshNodeAvailability()          ← server.ts, the ONLY caller
     │
     ├──► presentNodes            [NodeRef]   ← walked in CATALOG order
     │                                          (= tie-break for routing)
     └──► providedNodeCapabilities Set<string>
                    │
                    ▼
            node resolution + the UI's Connected Environment view
```

> ⚠ **Known bug (open).** `presentNodes = nodes` (`server.ts:149`) **replaces**
> rather than merges, so a *targeted* scan (`ids` supplied) narrows the global
> projection to just those nodes. A genuinely installed node can then fail
> resolution with `node-not-connected` until a full scan runs.

---

## 6. Three allow-lists, three doors

```
  terminal.execute ──► SAFE_BINARIES       git ls pwd node npm npx wc du
                       (medium risk)        grep find cargo python3 go

  agent.delegate  ──► AGENT_BINARIES       opencode claude codex
                      (irreversible-floor)  gemini qwen cursor-agent

  system.install  ──► INSTALLER_BINARIES   npm pipx cargo gh
                      (system-floor)
```

Disjoint by design and **never merged**. Merging `AGENT_BINARIES` into
`SAFE_BINARIES` would let a medium-risk capability launch a file-rewriting
agent; merging `INSTALLER_BINARIES` would turn `terminal.execute` into an
installation bypass. Both resolvers reject anything path-like (`/`, `\`, `..`)
*before* consulting their list — a caller may **name** a binary but can never
**locate** one.

---

## 7. Mission execution

```
  MissionRecord
      │
      ▼
  GoalGraph { goals, tasks }
      │
      ▼
  buildDag({ tasks, getRuntimeStatus })     ← mission/execution/dag.ts
      │
      ▼
  runnableTaskIds()  — dependencies satisfied
      │
      ▼
  MissionExecutionEngine.run…()             ← mission/execution/engine.ts
      │
      │  each task ──► THE SAME Fabric invoke pipeline (§2)
      ▼
  task status updated ──► DAG rebuilt from live statuses ──► repeat
      │
      ▼
  projection: Mission Control / Hub
```

> ⚠ **Structural limitation.**
> `TaskStatus = pending | proposed | accepted | rejected | done | error`
> — there is **no RUNNING state**. In-flight work is indistinguishable from
> pending, and a crash mid-task leaves no interrupted marker.

---

## 8. Desktop service lifecycle

```
  shell starts
      │
      ▼
  resolve_service_script()
      ├── packaged:  <resources>/ai-service.mjs
      └── dev:       <repo>/.aura/ai-service.mjs
      │               (nothing guessed; neither ⇒ "incomplete installation")
      ▼
  strip_verbatim()          ← Windows: \\?\D:\… is unusable by Node
      ▼
  resolve node + seed PATH
      ▼
  is 4319 already taken?
      ├── a compatible AURA service ──► REUSE it (do not start a second)
      ├── something else            ──► REFUSE. never kill it. explain.
      └── free                      ──► spawn
                                          │
                                          ▼
                              Windows: assign to Job Object
                              (KILL_ON_JOB_CLOSE) — only OUR child
                                          │
                                          ▼
                              health gate: window stays hidden
                              until /health answers
                                          │
                    ┌─────────────────────┴───────────────────┐
                    ▼                                         ▼
              normal quit                              abnormal kill
        POST /shutdown, force only                TerminateProcess:
        if ignored → port released                no handler runs, but the
                                                  job closes → service dies
```

Unix gets the same guarantee from SIGTERM/SIGINT/SIGHUP handlers, which Windows
has no equivalent of — hence the Job Object.

---

## 9. Release and distribution

```
  commit on feature/workspace-execution-environment
      │
      ▼
  CI matrix — every artifact BUILT AND RUN on its own native OS
      ubuntu-latest    → AppImage + deb     → 29/29 runtime checks
      windows-latest   → NSIS exe           → 34/34 (incl. Job Object)
      macos-latest     → arm64 dmg          → 29/29
      macos-15-intel   → x64 dmg            → 29/29
      │
      ▼
  stage-release-artifacts.mjs
      AURA-Hub-<version>-<platform>-<arch>.<ext>   (version from tauri.conf.json)
      │
      ▼
  SHA-256 recorded ──► GitHub Release v0.1.0 (tag on the validated commit)
      │
      ▼
  re-download all 5 public URLs ──► re-hash ──► must match
      │
      ▼
  aura-hub-website/index.html    RELEASE object = single source of truth
      │                          (Cloudflare Workers Static Assets, no build)
      ▼
  user clicks a real, permanent GitHub Release asset URL
```

Actions artifacts expire; **release assets are permanent**, which is why the
website links only to the latter.
