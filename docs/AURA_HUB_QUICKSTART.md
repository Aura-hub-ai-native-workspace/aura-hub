# AURA Hub — Quickstart

Onboarding in one page. For the full picture read
[AURA_HUB_MASTER_HANDOFF.md](./AURA_HUB_MASTER_HANDOFF.md); for the flow
diagrams, [AURA_HUB_ARCHITECTURE_MAP.md](./AURA_HUB_ARCHITECTURE_MAP.md).

**Current state:** v0.1.0 released · branch
`feature/workspace-execution-environment` @ `a382625` · verified 2026-08-13.

---

## What this is

A **Tauri v2 desktop app** (Rust shell + OS WebView) that owns a **local Node
service on port 4319**. The service holds all intelligence and execution. Every
capability the AI invokes passes through one governed pipeline:

```
validate → resolveNode → policy → approval → execute → verify → audit
```

There is **no Electron** anywhere in this repository.

---

## Run it

```bash
npm ci                # monorepo install (workspaces: apps/*, packages/*)

npm run ai            # AURA service        → http://127.0.0.1:4319
npm run dev           # frontend dev server → http://localhost:1420
npm run desktop:dev   # full Tauri shell (alternative to the two above)
```

Sanity check: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4319/health` → `200`.

## Build it

```bash
npm run typecheck        # ai-service + desktop project references
npm run build            # desktop frontend
npm run desktop:build    # full Tauri build (AppImage/deb on Linux)
```

## Test it

Verification suites are **plain scripts, not npm scripts**:

```bash
node scripts/node-policy-verify.mjs       # needs the service on :4319
node scripts/node-routing-verify.mjs
node scripts/process-timeout-test.mjs
node scripts/install-verify.mjs
node scripts/platform-verify.mjs

node scripts/hub-verify.mjs               # ALSO needs npm run dev on :1420
node scripts/desktop-runtime-verify.mjs   # needs a built app (xvfb if headless)
node scripts/packaging-verify.mjs         # needs port 4319 FREE
```

`npm run hub-verify` does **not** exist and will fail.

**Two suites fail on purpose — both pre-existing, neither release-blocking:**
`verify-providers` (10 failures, provider-switch lag) and `ui-approval-test`
(17 failures, Mission Control unreachable).

---

## Where things live

| You want | Look in |
| --- | --- |
| Policy, floors, approval | `packages/capability-fabric/src/policy.ts` |
| The execution pipeline | `packages/capability-fabric/src/fabric.ts` |
| Node catalogue and probes | `packages/connected-environment/src/catalog.ts` |
| Environment scanning | `packages/ai-service/src/environment.ts` |
| HTTP server + all wiring | `packages/ai-service/src/server.ts` |
| Process spawning, allow-lists | `packages/ai-service/src/exec/process.ts` |
| Installation | `packages/ai-service/src/exec/install.ts` |
| Mission engine and DAG | `packages/ai-service/src/mission/execution/` |
| AI providers | `packages/ai-service/src/provider/` |
| Desktop shell + service lifecycle | `apps/desktop/src-tauri/src/service.rs` |
| UI | `apps/desktop/src/` |

---

## The seven authorities — never duplicate these

One policy engine · one execution authority (the Fabric invoke path) · one
process primitive · one environment scanner · one node catalogue · one DAG
builder · one approval store.

If you need different behaviour, extend the existing one. A second engine is a
redesign, not a change.

## Three allow-lists, never merged

```
SAFE_BINARIES       git, ls, pwd, node, npm, npx, wc, du, grep, find, cargo, python3, go
AGENT_BINARIES      opencode, claude, codex, gemini, qwen, cursor-agent
INSTALLER_BINARIES  npm, pipx, cargo, gh
```

Merging any two of these is a security regression: `terminal.execute` would
gain the power to launch a coding agent or install software.

## Four security floors — configuration can never lower them

`irreversible-floor` · `destructive-floor` · `authorization-floor` ·
`system-floor`. Node policy is **deny-only**: an override can make a decision
stricter, never weaker.

---

## Before you touch anything

```bash
git status --short      # this tree carries long-lived user WIP
git branch --show-current
```

**Do not touch:** `main` · the 13 pre-existing dirty files (Ask AURA / frontend
WIP, `graphify-out/*`, `package-lock.json`,
`scripts/agent-failure-recovery-test.mjs`) · the floors · the allow-lists.

**Do not** reset, clean, stash-drop or delete user work.

---

## Two words to keep separate

**BUILT** = an artifact was produced. **RUNTIME VERIFIED** = the artifact was
launched and exercised on that OS. Never upgrade one into the other. If you
only built it, write **NOT RUNTIME VERIFIED**.

## One habit that mattered

When a check fails, first ask whether the *check* is wrong. During the v0.1.0
cycle four failures were faulty tests, not faulty product — a machine-specific
policy assertion, a Windows-only kill assumption, a too-short scroll wait, and
a misleading overflow metric. Fix the check honestly; never weaken it to go
green.
