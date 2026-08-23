# Phase 8 — Tools, tool lifecycle and integrations

**Status: COMPLETE, with one scope boundary stated up front.**
**TypeScript reference:** `packages/connected-environment/src/` (catalog 327,
capabilities 91, agents 45, types 313), `packages/ai-service/src/environment.ts`
(251), `packages/ai-service/src/fabric/executors.ts` (762).
**Python destination:** `backend/src/aura_backend/environment/`,
`backend/src/aura_backend/tools/`.
**Difficulty: HIGH.**

---

## 1. The scope boundary, stated first

`executors.ts` holds 22 executors in two groups. Twelve are **machine-facing**
— filesystem, terminal, agent delegation, installation, git, HTTP. Ten are
**AURA-internal** and every one delegates to `WorkspaceManager`:
`project.list`, `project.create`, `project.open`, `project.inspect`,
`mission.inspect`, `mission.approve`, `knowledge.graph`, `memory.search`,
`workflow.run`, `governance.audit`.

`WorkspaceManager` is **Phase 3**, which has not been migrated — the mandated
order ran 0 → 1 → 2 → 6 → 7 → 8 at your direction, leaving 3, 4 and 5
outstanding. Those ten executors are therefore **not ported**, and no stub was
written in their place. A stub would make the manifest lie about what can run;
their absence makes them report `unsupported`, which is true.

This phase migrates the twelve machine-facing executors, the node catalogue,
the environment scanner and the node projection.

---

## 2. What was migrated

| TypeScript | Python | Note |
| --- | --- | --- |
| `connected-environment/{catalog,capabilities,agents}.ts` | `environment/catalog_data.json` + `catalog.py` | **Generated, not transcribed** — see §3. |
| `ai-service/environment.ts` | `environment/scanner.py` | Probes, cache, concurrency bound, version extraction. |
| `server.ts` `refreshNodeAvailability` | `environment/projection.py` | Fixes a reference bug — see §6.1. |
| `fabric/executors.ts` (machine half) | `tools/executors.py` | 12 executors. |
| `server.ts` `/environment/*` | `api/routes/environment.py` | 3 routes. |

Corrections to the Phase 0 audit, settled by diffing rather than by re-reading:
the catalogue has **105 entries, 47 capabilities and 10 install specs** — the
audit said 48 capabilities and 11 install specs.

### The security boundary this layer exists to hold

A probe command and an install package come from the **catalogue, looked up by
id**, never from a request. A client can ask "probe the node called `docker`";
it can never ask "run this string". Combined with argv spawning and no shell,
there is no path from an HTTP request to arbitrary command execution — which
is what makes binding a local port acceptable at all.

---

## 3. The catalogue is carried as data, and that is a verification decision

105 hand-copied entries is 105 chances to introduce a silent difference in a
probe command — and a wrong probe command means AURA confidently reports a
tool absent that the user has installed, which is the exact failure this
codebase refuses.

So `catalog_data.json` is **generated from the TypeScript catalogue**, and
`test_environment_parity.py` regenerates it from the reference and diffs.
Drift is caught rather than assumed absent. The typed loader in `catalog.py`
gives the rest of the backend a real API over it.

**Catalogue order is preserved and asserted**, because it is the documented
routing tie-break: when several present nodes provide the same capability and
the caller named none, the first in this order wins. Reordering the file
changes which tool runs.

---

## 4. Verification

### 4.1 The reference's own suites, against both backends — 109/109 agree

This is the strongest evidence in the migration so far, and it is repeatable:
`backend/verify/reference_suites.py` starts **both** backends with isolated
homes and ports, points the TypeScript project's own HTTP verification scripts
at each in turn via `HUB_API`, and compares the pass/fail set check by check.

| Suite | Checks | Result |
| --- | --- | --- |
| `install-verify.mjs` | 59 | **59/59 PASS on both.** Zero differences. |
| `node-routing-verify.mjs` | 24 | 24/24 **agree** (12 fail on both) |
| `node-policy-verify.mjs` | 26 | 26/26 **agree** (6 fail on both) |

`install-verify` passing outright is the whole install lifecycle: allow-list
disjointness, the verb guard, path-like refusal, catalogue-only installs, the
privilege floor, and "exit 0 is a claim, the probe is the evidence".

**The 18 checks that fail do so on BOTH backends, with byte-identical failure
text.** They are not a Python gap: those suites assume a project called
`hub-exec-test` is already registered and never register one, so with a fresh
isolated home neither backend can resolve a `cwd`. That is Phase 3's
dependency showing up honestly, and the harness labels it as an environment
fact rather than a divergence.

### 4.2 Catalogue and scanner — differential

`backend/parity/env_parity.py`:

- **catalog** — 105 entries, 47 capabilities, 14 agents, 7 categories:
  **IDENTICAL**, including entry order.
- **pure functions** — `is_connectable`, `entries_providing`, `catalog_entry`
  across all 105 entries: **MATCH**.
- **live scan** — both scanners run against **this machine**, 61 nodes probed:
  **MATCH** on presence, version and the detail sentence for every node.

### 4.3 A flaky result, investigated rather than normalized

The first live-scan comparison showed **four differences**, and in a
surprising direction: Python detected `opencode`, `gemini-cli` and
`cloudflare`; TypeScript reported them absent.

Probing each in isolation, TypeScript found all three. Timing them explained
it: they are Node CLIs taking 1.2–2.5 s warm, against a **4-second probe
budget** shared with seven concurrent probes. On a cold page cache the budget
loses. Three consecutive runs of each backend afterwards reported `found=25`
identically.

So it is a timeout race present in **both** implementations, not a behavioural
difference — and it can make either backend report a genuinely installed tool
absent. The harness now warms both sides before the compared run and **says so
in its docstring**; any difference surviving the warm-up is reported as real.
The underlying fragility is recorded in §6 as a finding against both
implementations.

### 4.4 Negative controls — 39/39

`tests/test_tools_negative_controls.py`. Highlights:

- Every catalogue probe command is a bare binary name — no path, no shell
  metacharacter — across all 105 entries.
- Every catalogue install spec resolves only to an allow-listed installer.
- No entry declares a capability outside the 47.
- A hostile node id (`git; rm -rf /`, `../../bin/sh`) runs nothing.
- Path confinement: five traversal forms refused, **and a symlink pointing out
  of the project refused** — both sides are resolved before comparison, so a
  link cannot take a route the string form does not show.
- A refused filesystem write leaves no file behind.
- `terminal.execute` refuses installs, agents and shell operators before
  spawning.
- Only agents with a *verified* non-interactive invocation are drivable; a
  resolved-but-unverified agent **fails rather than being substituted**.
- The agent task is always the last argv element, never concatenated.
- Context truncation is announced in the text, not silent.
- `system.install` verification passes only for `installed`.
- `http.request` refuses `file://`, `ftp://` and `javascript:`.
- The version regex has no leading `\b`, so `v24.7.0` reports `24.7.0` and not
  `7.0`.

### 4.5 Runtime — 21/21

`backend/verify/tools_runtime.py` walks DISCOVER → DETECT → the INSTALL gate
against a real running service. It deliberately **never performs an install**:
installing software on your machine uninvited is not a verification script's
call, so it proves an install is refused, gated or handed over.

Real results: 105 entries served; a real scan found 25 of 61 with a genuine
`git 2.55.0`; no absent node claims a version; hostile ids run nothing; the
scan makes `source-control` routable so `git.status` stops being denied for
want of a provider; a targeted scan leaves the other 24 capabilities intact;
an uncatalogued install is refused; an ungranted install is gated at
`system-floor` with `attempts=0`; a root-tier install returns
`installOutcome: guided` with `sudo pacman -S --needed glab` handed over and
nothing run.

### 4.6 A check that asserted my assumption

`6d` initially asserted that a guided install *fails* verification. It does
not — the Fabric only runs a check when the executor reported success, and a
guided handoff returns `ok: false` because nothing ran, so `verify` is never
called. The reference behaves identically; its executor's `guided` verify
branch is unreachable for the same reason. The check now asserts what actually
holds: a guided install never reads as verified or succeeded.

---

## 5. Contracts preserved

Three routes, matching `server.ts`:

| Route | Note |
| --- | --- |
| `GET /environment/catalog` | `{catalog: [...]}`, camelCase, order preserved |
| `POST /environment/scan` | `{ids?, refresh?}` → `{results, scannedAt, found, providedCapabilities}` |
| `POST /environment/probe` | `{id, refresh?}` → `{id, result}`; 400 without an id |

Constants carried over exactly: probe timeout 4 s, HTTP probe 2.5 s, cache TTL
30 s, concurrency 8, probe buffer 256 KB, file read cap 512 KB, HTTP response
cap 512 KB, diff truncation 60,000 chars, agent context cap 12,000 chars.

---

## 6. Behavioral differences

### 6.1 A targeted scan merges instead of erasing

**Reference:** `refreshNodeAvailability(ids)` in `server.ts` assigns rather
than merges:

```ts
providedNodeCapabilities = provided;
presentNodes = nodes;          // replaces, does not merge
```

A targeted scan therefore replaces the global projection with just that
subset, and every node not named in it appears to vanish until a full scan
runs again — so a genuinely installed node fails routing with `no-provider`.
The master handoff records this as open technical debt (§4, §20 item 1: "a
correctness bug in a live path").

**Python:** merges. A targeted scan updates only the nodes it looked at, and a
node it found absent is removed — because that is real news about that node,
and only about that node.

Covered by `test_a_targeted_scan_merges_rather_than_erasing_everything_else`
and runtime check 5. Recorded in the migration map as difference #8.

### 6.2 `system.install` uses an injected scanner

The reference calls the module-level `probeNode`. The Python executor takes an
`EnvironmentScanner` instance, so the cache it bypasses on verification is the
same one the service scans with. Behaviourally identical; it removes a global.

---

## 7. Security findings

1. **The 4-second probe budget can report an installed tool absent** under
   concurrency, in **both** implementations — observed first in the reference
   (§4.3). It is a "confident wrong answer" of exactly the kind this codebase
   refuses elsewhere. Not changed here, because raising the budget is a product
   decision with a real cost (a full scan already takes seconds).
2. **`npx` remains on `SAFE_BINARIES`.** Carried over unchanged.
3. **The ten AURA-internal capabilities report `unsupported`.** Safe, and
   honest, but it means a caller cannot yet drive any AURA subsystem through
   the Fabric.

---

## 8. Known limitations

- **No project registry, so no `cwd`.** Every executor that operates on a
  project — filesystem, terminal, git, agent — refuses with "No project
  directory is set for this invocation." They are unit-tested against
  temporary directories, but **the execution half of the reference suites
  cannot run on either backend** until Phase 3 lands.
- **`agent.delegate` has not been driven end-to-end here.** Phase 6 spawned a
  real OpenCode and timed it out; this phase verifies routing, allow-listing
  and refusal, but a successful delegated task needs a registered project.
- **No install has actually been performed.** By choice — see §4.5.
- **HTTP and OAuth transports are untested against live services.** The HTTP
  probe path is exercised only by catalogue entries pointing at local
  endpoints that are not running, which is the "not answering" branch.
- **Windows remains BUILT, not RUNTIME VERIFIED**, unchanged from Phase 6.

---

## 9. Files created

```
backend/src/aura_backend/environment/{__init__,catalog,scanner,projection}.py
backend/src/aura_backend/environment/catalog_data.json        (generated)
backend/src/aura_backend/tools/{__init__,executors}.py
backend/src/aura_backend/api/routes/environment.py
backend/parity/{env_oracle.ts,env_parity.py}
backend/verify/{tools_runtime.py,reference_suites.py}
backend/tests/{test_tools_negative_controls,test_environment_parity}.py
docs/PHASE_08_TOOLS.md
```

Modified: `api/app.py` (scanner, projection and executors wired into the
composition root), `verify/fabric_runtime.py` (check 1b now asserts the
supported set matches the executors that exist, rather than the Phase 7
count of zero).
