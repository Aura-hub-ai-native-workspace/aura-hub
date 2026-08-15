# AURA Hub — Connected Environment

> Replaces "Extended Environment". This is not an iteration on it; the previous
> concept did not exist as an implementation, and the mental model it implied
> was wrong for what the platform needs to become.
>
> Branch: `feature/connected-environment-v2`

---

## 1. Why the previous architecture was insufficient

The honest finding first: **there was no Extended Environment implementation to
replace.** The nav destination `marketplace` routed to `PlaceholderScreen` with
the copy *"Modules, models and templates install into the same design language
and command surface you already use."* That was the entire feature —
`ScreenRouter.tsx:93`, before this branch.

So the insufficiency is not in the code. It is in the concept the code was
reserving space for, and that concept was wrong in three ways:

**It was a marketplace.** A marketplace is a place you visit to acquire things.
The nav key was literally `marketplace` and the icon was a shopping cart. That
frames external tools as *inventory* — items you browse, install and own. But a
developer does not have a shortage of tools. They have a shortage of coherence
between the tools they already have.

**It was scoped to documents.** "Extend AURA with modules, models and templates"
describes a plugin surface for content. Word, Excel, PowerPoint, files. That
scope cannot grow into the thing the platform actually needs, because the
interesting external systems are not documents — they are *executors*. Docker
builds. GitHub hosts. Railway deploys. Playwright verifies. A document connector
architecture has nowhere to put "run this and tell me if it worked."

**It had no capability indirection.** A plugin system binds a feature to a
product: "the Figma plugin", "the Slack plugin". Every plan written against it
names products, so every plan breaks when the product changes. There is no way
to express "this step needs somewhere to deploy" and let the environment answer.

The replacement inverts all three: the environment is not acquired but
*discovered*; its members are executors, not documents; and everything is
planned against capabilities, never against brands.

---

## 2. Philosophy

```
        Before                              Now

        User                                User
          │                                   │
    ┌─────┴─────┐                              ▼
    ▼     ▼     ▼   …                     AURA HUB
  VS Code GitHub Docker                        │
  Terminal Vercel Figma                        ▼
    │     │     │                        Finished work
    └─────┴─────┘
          │
    the user is the
     integration layer
```

The user should be the only thing in the system that states intent. Everything
else — deciding which tools are involved, in what order, with what fallback —
is the Hub's job. That is the whole premise, and it has one hard consequence
that shapes every file in this design:

> **The Hub must be able to answer "what can I actually do right now?" honestly,
> at any moment, without asking the user.**

An orchestration layer that cannot tell truth from hope is worse than no
orchestration layer, because it fails late and confidently. So the architecture
spends most of its structure on knowing — and stating — exactly how real each
connection is.

---

## 3. Architecture

```
  ┌──────────────────────────────────────────────────────────────┐
  │  Prompt Intelligence      raw request → EnrichedBrief         │
  │  promptIntelligence.ts    intent · surfaces · stack · features│
  │                           assumptions · open questions        │
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Mission Planner          brief → Mission (a task DAG)        │
  │  missionPlanner.ts        every task declares:                │
  │                             requires: CapabilityId[]          │
  │                             dependsOn: taskId[]               │
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Agent Orchestrator       DAG → parallel execution waves      │
  │  orchestrator.ts          topological levelling + late-bound  │
  │                           routing against the live environment│
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Environment Manager      capability → node                   │
  │  registry.ts · resolver.ts  binding, gaps, ranked candidates  │
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Connected Environment    105 catalogued systems              │
  │  catalog.ts               identity · capabilities · transport │
  │                           auth · licence · health · permissions│
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Execution Nodes          NodeTransport implementations       │
  │  ai-service/environment.ts   execFile · fetch · internal      │
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼
                          External Systems
```

Each layer knows only the one below it. `@aura/connected-environment` imports
no React, no Node, and performs no I/O — every side effect enters through the
`NodeTransport` port, which the host supplies.

### The central indirection

```
   task.requires: ['app-hosting']          ← the plan names a job
              │
              ▼
   connectedProviders(nodes, 'app-hosting') ← the environment answers
              │
              ├─ Railway     (connected)
              ├─ Fly.io      (installed, not connected)
              └─ Docker      (connected)
              │
              ▼
   bindNode() → the node covering the most of this task's requirements
```

A plan never names a product. This is why the same mission runs on Railway
today and Fly tomorrow with no replanning, and why adding an integration is a
**data change** — a new `CatalogEntry` declaring its capabilities — rather than
a code change to the planner, orchestrator, registry or UI.

---

## 4. What is genuinely real, and what is not

This is the section to read before believing any other section.

| Layer | Status | Evidence |
|---|---|---|
| Capability taxonomy, 105-entry catalog | **Real** | `catalog.ts`, verified 105 entries / 105 unique ids |
| Local tool detection | **Real** | `execFile` runs the actual command; 21 of 61 measurable nodes found on the dev machine, with real versions |
| Local model server detection | **Real** | HTTP probe against Ollama / LM Studio / AnythingLLM endpoints |
| Prompt Intelligence | **Real**, deterministic | No model required; runs offline at zero cost |
| Mission planning + DAG | **Real** | 0 dangling deps, 0 ordering violations across 9 intents |
| Wave computation + routing | **Real** | 0 misrouted tasks; routing recomputed on every environment change |
| Capability gap resolution | **Real** | Ranked candidates with stated reasoning |
| Permissions model | **Real** state, **not yet enforced** | Nothing executes, so there is nothing to enforce against yet |
| **Task execution** | **Interface only** | No transport implements `execute` |
| OAuth SaaS connectors | **Catalogued only** | No OAuth application exists for this project |

### The honesty mechanism

Rather than relying on discipline, honesty is encoded in the type system and
enforced at one function:

```ts
// catalog.ts — the single source of truth for
// "would clicking Connect do something"
export function isConnectable(entry: CatalogEntry): boolean {
  switch (entry.transport) {
    case 'internal':      return true;
    case 'local-process': return Boolean(entry.probe);
    case 'http':          return Boolean(entry.endpoint);
    case 'api-key':       return true;   // routes into the shipped BYOAK system
    case 'oauth':         return false;  // no OAuth app exists
  }
}
```

The UI never renders a Connect button where this returns `false`. A node in
that state gets the terminal status `no-connector`, which is fully plannable and
recommendable and visibly not connectable. That distinction is what lets the
catalog hold 105 systems without lying about any of them.

A second honesty rule sits in the probe layer: a `local-process` entry with no
dependable cross-platform executable (Warp, Unity, Unreal, Android Studio,
Puppeteer) deliberately carries **no probe**. Reporting "not installed" for a
tool that is installed but has no CLI would be a confident wrong answer, which
is worse than an admitted unknown.

---

## 5. Security boundary

The local service binds a port, so probing is the one genuinely dangerous
surface in this design. Two properties make it safe:

1. **Commands come from the catalog, never the request.** A client asks to
   probe the node with id `docker`; it cannot ask to run a string. The command
   and args are looked up from the `CatalogEntry`.
2. **`execFile`, not `exec`.** No shell is involved, so there is no
   metacharacter interpretation.

Verified against the running service:

```
POST /environment/probe {"id":"rm -rf /"}
  → {"present":false,"detail":"That node is not in the catalog."}

POST /environment/probe {"id":"git","command":"touch","args":["/tmp/pwned"]}
  → {"present":true,"version":"2.55.0", ...}     /tmp/pwned: does not exist
```

Probes are additionally bounded by a 4s timeout, a 256KB output cap,
`windowsHide`, and a concurrency limit of 8 so a full scan cannot spawn a
hundred processes at once.

---

## 6. Folder changes

### New

```
packages/connected-environment/          @aura/connected-environment
  src/
    types.ts               domain model — nodes, transports, briefs, missions
    capabilities.ts        the capability vocabulary (48 capabilities)
    catalog.ts             105 catalogued systems across 7 categories
    registry.ts            node state machine, as pure transitions
    promptIntelligence.ts  request → EnrichedBrief (deterministic)
    missionPlanner.ts      brief → task DAG
    orchestrator.ts        DAG → parallel waves + late-bound routing
    resolver.ts            capability gap → ranked candidates
    agents.ts              14 specialist roles
    language.ts            every user-facing state phrase, in one table
    index.ts

packages/ai-service/src/environment.ts   the real transport (execFile + fetch)

apps/desktop/src/environment/
  environmentClient.ts     fetch wrappers over /environment
  transports.ts            NodeTransport implementation (the I/O seam)
  environmentStore.ts      live environment + mission, derived in one place
  presentation.ts          domain state → AURA's visual vocabulary
  ConnectedEnvironment.tsx the screen
  MissionComposer.tsx      the single input + live brief reading
  MissionBoard.tsx         waves, tasks, routing
  GapPanel.tsx             autonomous tool discovery
  NodeCard.tsx             one live execution card
  NodeInspector.tsx        full node contract, in a window
  windows/
    windowManager.ts       content-agnostic floating window model
    FloatingSurface.tsx    drag · resize · snap · min · max · close
```

### Changed

- `packages/core/src/types.ts` — `NavKey`: `'marketplace'` → `'environment'`
- `packages/core/src/navigation.ts` — label, icon (`marketplace` → `link`)
- `packages/ai-service/src/server.ts` — `/environment/{catalog,scan,probe}`
- `apps/desktop/src/screens/ScreenRouter.tsx` — routes to the real screen; the
  environment joins the fixed-viewport screens
- `apps/desktop/src/shell/useCommands.ts` — command palette entry
- `tsconfig.base.json`, `apps/desktop/tsconfig.json`, `vite.config.ts` — paths

### Deleted (dead code audit)

- `apps/desktop/src/screens/PlaceholderScreen.tsx`
- `apps/desktop/src/shell/sections.ts`

`marketplace` was the last consumer of `PlaceholderScreen`, which was the only
consumer of `SECTION_IDENTITY`. With no placeholder screens left in the app,
both were unreachable.

---

## 7. New abstractions

**`CapabilityId`** — the vocabulary plans are written in. The indirection that
makes integrations additive.

**`CatalogEntry` / `EnvironmentNode`** — knowledge about a system, separated
from its live measured state. The catalog never changes at runtime; the node
never claims anything that was not measured.

**`NodeTransport`** — the single I/O port. Implementing `execute` on it is the
entire remaining work to make missions run; no other layer changes.

**`BriefEnricher`** — the optional model pass. `enrich()` runs the deterministic
reading first and treats the model as an upgrade whose failure is invisible.
This is why the Hub never dead-ends on a missing or misbehaving provider.

**`OrchestrationPlan`** — `plan = orchestrate(mission, nodes)`, recomputed after
every change to either side. The plan, the gaps and the task states can never
disagree with each other or with reality, because they are all derived in one
function (`environmentStore.ts::derive`).

---

## 8. Migration strategy

**Nothing to migrate.** The replaced surface was a placeholder with no state, no
persistence and no user data. The nav key rename is compile-time enforced —
`NavKey` is a union, so every reference had to be updated for the build to pass.

The one real migration this branch *defers* is windowing. The Workspace's
`ops/layoutStore.ts` + `ops/FloatingWindow.tsx` are bound to `PanelKind`, a
closed union; the Connected Environment needs windows over catalog entries,
which are open data. Rather than modify the Workspace (out of scope on this
branch), a content-agnostic manager was built alongside it.

Two window managers now coexist. That is a real cost, recorded here rather than
hidden. The migration is mechanical: reimplement `layoutStore` on
`windowManager` keyed by `contentId: PanelKind`, and delete the duplicate
interaction code in `FloatingWindow.tsx`.

---

## 9. Scalability analysis

**Catalog growth** — `O(1)` per integration in code terms; a new entry is data.
The largest cost is bundle size: the catalog is ~92KB of the lazy-loaded
`ConnectedEnvironment` chunk (25KB gzipped) and does not touch the main bundle.
Past a few hundred entries it should move behind the service's
`/environment/catalog` route, which already exists for exactly this reason.

**Scan cost** — bounded by design: only the ~61 measurable nodes are probed, at
concurrency 8, with a 4s timeout and a 30s result cache. Full scan on the dev
machine completes in a few seconds.

**Planning cost** — `O(V + E)` for levelling, `O(V · C · N)` for routing where C
is capabilities per task (1–3) and N is connected nodes. For realistic sizes
this is microseconds; it runs synchronously in the store.

**Capability vocabulary** — the one thing that does *not* scale for free.
Adding a capability widens what the planner can express and is a deliberate act.
This is correct: an unbounded vocabulary would make routing meaningless.

**State** — nothing persists. A relaunch re-scans, because a remembered
"Docker is connected" that is no longer true is worse than not knowing.

---

## 10. Validation performed

```
npm run typecheck        clean  (ai-service + desktop project references)
npm run build            clean  (33s; ConnectedEnvironment 92.79 KB / 25.32 KB gz)
```

Live service, real machine:

```
POST /environment/scan   21 of 61 measurable nodes found
                         git 2.55.0 · gh 2.97.0 · cursor 3.7.27 · node 26.7.0
                         bun 1.3.14 · python 3.12.7 · chromium 151.0.7922.108 …
```

Domain harness (9 intents, empty and fully-connected environments):

```
dangling dependencies      0
ordering violations        0
misrouted tasks            0
catalog id collisions      0
probes with no args        0
build-product plan         21 tasks · 13 waves · widest wave 3
```

**One real bug found and fixed by this validation.** Version extraction reported
Node as `7.0` instead of `26.7.0`: the regex began with `\b`, and in `v26.7.0`
there is no word boundary between `v` and `2` (both word characters), so the
match started at `7.0`. Fixed in `ai-service/src/environment.ts` and re-verified.

Reviews performed: architecture (layering holds, no upward imports), dead code
(2 files and 8 exports removed), state management (single `derive` point),
dependency (one new workspace package, no new third-party dependencies),
performance (bounded scan, lazy chunk), extensibility (integration = data).

---

## 11. Honest limitations

1. **Nothing executes yet.** `NodeTransport.execute` is declared and
   unimplemented. Missions plan, route and surface gaps; they do not run work.
   The orchestrator reports this rather than pretending dispatch occurred.
2. **OAuth services are catalogued, not connectable** — Figma, Notion, Slack,
   Jira, Linear, Drive and the rest. No OAuth application exists for this
   project. They are plannable and recommendable, and never offered a Connect
   button.
3. **`node.activity` is always empty.** The live progress bars on node cards
   render nothing because no executor populates them. `upsertActivity` is the
   single documented entry point for when one lands. (This mirrors the existing
   `hasUnread` honest-gap note in `ops/layoutStore.ts`.)
4. **Permissions are held but not enforced.** There is no execution to enforce
   them against. Enforcement belongs in the same commit as the first executor.
5. **Prompt Intelligence is keyword-driven.** It handles common phrasings well
   and will misread unusual ones. It shows every assumption precisely so a
   misreading is visible before planning, and `BriefEnricher` is the upgrade path.
6. **Two window managers coexist** — see §8.
7. **Parallelism is real but modest for build-product missions**: 21 tasks over
   13 waves. That is an honest property of the work, not a planner weakness —
   understand → architect → scaffold → implement → verify → release is a
   genuinely serial spine. Refactor and fix missions widen more.
8. **`api-key` AI providers defer to AI Settings** rather than duplicating the
   shipped BYOAK connection flow. Correct reuse, but it means connecting one is
   currently a two-screen journey.

---

## 12. Roadmap

**Next** — implement `execute` for the `local-process` transport behind the
permission model, starting with the narrowest useful set (`git`, `npm`/`bun`,
`terminal`). This is the single change that turns the layer from planning to
execution, and it touches no other file.

**Then** — enforce permissions at dispatch; populate `NodeActivity` so the live
cards move; stream node logs into the inspector.

**Then** — migrate the Workspace onto `windowManager` and delete the duplicate
window code.

**Then** — a real `BriefEnricher` backed by the existing AI service, so the
brief reading sharpens when a provider is connected and degrades cleanly when
it is not.

**Later** — OAuth connectors, once an OAuth application exists; capability
learning (which node actually succeeded at which capability, fed back into the
resolver's ranking); multi-machine environments.
