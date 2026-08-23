# Python backend migration map

> **Purpose.** This document is the inventory and the ledger for migrating the
> complete AURA Hub backend from TypeScript to Python. It records, per
> subsystem, what exists in TypeScript, what it is responsible for, where it
> lands in Python, and how far the migration has actually got.
>
> **Written against** the live working tree at
> `/mnt/storage/aura-hub` (branch `feature/workspace-execution-environment`,
> commit `a382625` **plus uncommitted work in progress**, which is in scope and
> is part of the reference behavior).
>
> **Python branch:** `feature/backend-python-migration`, worktree at
> `/mnt/storage/aura-hub-python`.
>
> **The TypeScript backend is the behavioral reference and stays runnable.**
> Nothing in this migration deletes, rewrites or resets it. Cutover happens
> only after the parity gates in §12 are met.

---

## How to read this document

Subsystem classification (what the TypeScript side *is*):

| Word | Means |
| --- | --- |
| **EXISTS** | Implemented and wired into the running service. |
| **PARTIAL** | Some of it works; the gap is named. |
| **MISSING** | Referenced or expected, but not implemented. |
| **DUPLICATED** | The same responsibility implemented more than once. |
| **DEPRECATED** | Present but superseded; do not carry it forward as-is. |
| **UNVERIFIED** | Exists, but no verification script exercises it. |

Migration status (what the Python side *has done*):

| Word | Means |
| --- | --- |
| **NOT STARTED** | No Python code. |
| **SCAFFOLDED** | Module exists, contract stubbed, no behavior. |
| **IMPLEMENTED** | Behavior written. **Not** a claim that it works. |
| **TESTED** | Unit tests and negative controls pass. |
| **RUNTIME VERIFIED** | Exercised against a running Python service. |
| **PARITY VERIFIED** | Differential-tested against the TypeScript service and matching. |

**BUILT ≠ VERIFIED.** These words are never blurred here. A module that is
written but unrun says IMPLEMENTED, not TESTED.

Migration difficulty: **LOW** (mechanical), **MEDIUM** (needs redesign in
Python idiom), **HIGH** (concurrency, process or security semantics that do not
translate directly), **CRITICAL** (a security authority — a wrong translation
is a vulnerability, not a bug).

---

## §0 — Executive summary

The AURA backend is a single Node process (`packages/ai-service`) that binds
`127.0.0.1:4319` and exposes roughly **130 HTTP routes and 6 SSE streams**. It
composes four workspace packages (`capability-fabric`, `automation`,
`connected-environment`, `engineering-memory`) plus a set of
knowledge/intelligence packages. All state is JSON files under
`$AURA_HOME` (default `~/.aura`); there is no database.

The security model has no authentication. It rests on: loopback-only binding,
a CORS origin allow-list, a single governance authority (the Capability
Fabric), three disjoint binary allow-lists, four policy floors that no
configuration can lower, and secrets that have no read-back route.

**The migration's central risk is not translation — it is duplication.** The
TypeScript design's strength is that there is exactly one policy engine, one
execution path, one process primitive, one approval store. A Python port that
grows a second one of any of those has lost the product's security properties
while appearing to work. Every Python module below is written to preserve
single-authority.

---

## §1 — Parallel operation (Phase 1, done)

Both backends must be able to run at once without competing for ports, files,
schedulers or workers.

| Concern | Rule | Where |
| --- | --- | --- |
| Backend selection | `AURA_BACKEND=typescript` (default) \| `python` | `backend/src/aura_backend/config/settings.py` |
| Production port | `AI_PORT`, default 4319 — only when `AURA_BACKEND=python` | same |
| Shadow port | `AURA_PY_PORT`, default 4321 | same |
| Production home | `AURA_HOME`, default `~/.aura` | same |
| Shadow home | `AURA_PY_HOME`, default `~/.aura-py` | same |
| Scheduler | Runs in **at most one** backend — the selected one. Shadow mode never fires schedules. | same |
| Port ownership | A busy port is **refused**; the owning process is never killed. | `backend/src/aura_backend/__main__.py` |

Shadow mode **refuses to start** if pointed at the live home directory or the
live port. That refusal is a negative control, not a convenience: two
schedulers firing the same automation rules against the same run files is a
failure that is silent when it happens.

**Status: TESTED + RUNTIME VERIFIED.** 15 tests pass; the service was started,
answered `/health`, and refused a port held by another process while leaving
that process alive.

---

## §2 — API / HTTP server

**TypeScript location:** `packages/ai-service/src/server.ts` (1325 lines),
`start.ts` (62), `index.ts` (20).
**Classification: EXISTS.**
**Python destination:** `backend/src/aura_backend/api/` (app factory +
one router module per subsystem).
**Difficulty: MEDIUM** — the surface is large but mechanical; the hazards are
in routing order and status-code conventions, not in logic.

### Composition root

`start.ts` → `startService()` → `WorkspaceManager` → `createFabric()` →
`manager.attachFabric(fabric)` → `http.createServer` → listen on `127.0.0.1`.
Boot order is load-bearing:

1. `setupProviders()`
2. `new WorkspaceManager(opts)` (constructs pipeline, project registry, automation)
3. `createFabric({manager, providedNodeCapabilities, presentNodes, runScopes})`
4. `manager.attachFabric(fabric)` — closes the cycle so mission tasks use the same Fabric
5. `manager.reconcileWorkflowRuns()` — orphaned `running` runs become honestly failed/resumable
6. `automation.scheduler.start()` — **reconciles missed fires before arming timers; missed fires are counted, never executed**
7. `manager.connectEnvProviders()`
8. `refreshNodeAvailability()` — boot environment scan

Python must preserve this order, especially 5 before 6: reconciling after
arming would let the scheduler act on runs that have not yet been marked
interrupted.

### Transport contract

| Aspect | Value | Note for Python |
| --- | --- | --- |
| Bind | `127.0.0.1` hardcoded | Never `0.0.0.0`. |
| Port | `AI_PORT` \|\| 4319 | §1. |
| Auth | **None** | Not an omission to fix silently — see §11. |
| CORS methods | `GET,POST,PUT,PATCH,DELETE,OPTIONS` | Constant on every response. |
| CORS headers | `content-type` only | `x-aura-shutdown` deliberately absent — it cannot be preflighted, so a browser page cannot send it. |
| Origin | reflected only if it matches `^(https?://(localhost\|127\.0\.0\.1)(:\d+)?\|tauri://localhost\|https?://tauri\.localhost)$` | Reflect-or-omit, never `*`. |
| `OPTIONS` | `204` + CORS constant | |
| Max body | 2 MiB → `413 request body too large` | |
| Empty body | `{}` | |
| Bad JSON | `400 malformed JSON body` | |
| Unmatched route | `404 {"error":"not found"}` | |
| Error shape | `{"error": message}`, status from `HttpError` else 500 | One handler; inner layers raise, never write HTTP. |

### Shutdown

`POST /shutdown` requires header `x-aura-shutdown: 1`, else `403`. It responds
**before** invoking the shutdown callback. `SIGINT`/`SIGTERM` route to the same
path (Windows has no SIGTERM, which is why the HTTP route exists).

**Known gap to carry as a decision, not a copy:** `close()` does not drain
in-flight SSE streams, stop the scheduler, or flush the fabric. Python should
drain and stop explicitly; this is a **documented contract change** (§13).

### Route inventory

~130 routes across these prefixes. Full method/body/response/error detail is
captured per-group in the audit; the groups and their Python destinations:

| Prefix | Routes | Python module |
| --- | --- | --- |
| `/health`, `/shutdown`, `/settings*` | 6 | `api/routes/service.py` |
| `/providers*` | 5 | `api/routes/providers.py` |
| `/index`, `/reindex`, `/environment/*` | 5 | `api/routes/environment.py` |
| `/fabric/*` | 7 | `api/routes/fabric.py` |
| `/missions/dashboard` | 1 | `api/routes/missions.py` |
| `/projects/*` (incl. conversations, context, graphify, memory, diagnose, missions) | ~45 | `api/routes/projects.py` + submodules |
| `/agent/*` | 2 | `api/routes/agent.py` |
| `/workflow-runs/*` | 5 | `api/routes/workflow_runs.py` |
| `/secrets*` | 3 | `api/routes/secrets.py` |
| `/workflows/*` | ~28 | `api/routes/workflows.py` |
| `/automation/*` | ~17 | `api/routes/automation.py` |
| `/predictive/*` | 6 | `api/routes/predictive.py` |
| `/workspace`, `/governance/*`, `/graph`, `/retrieve`, `/models`, `/code/action`, `/inspect`, `/ask`, `/stream` | 13 | `api/routes/misc.py` |

### Routing hazards that a path-param router will get wrong

The TypeScript router is a hand-written segment cascade, so **earlier blocks
shadow later ones**. These literals are reserved words and must be registered
before their parameterized siblings:

- `/workflow-runs/{stats,awaiting,reindex}` before `/workflow-runs/{runId}`
- `/workflows/{specs,templates,import,generate}` before `/workflows/{id}`
- `/automation/rules/{id}/runs` before `/automation/rules/{id}/runs/{runId}`

FastAPI matches in declaration order, so this is preserved by declaring
literals first — and pinned by a negative-control test that asserts
`GET /workflows/specs` never resolves as `GET /workflows/{id="specs"}`.

### Non-standard status conventions (preserve exactly)

- `202` — approval-gated mission task run; webhook trigger accepted.
- `409` — approval already decided (body carries the approval).
- `200` **with** `{"error": …}` — `/conversations/:cid/message`,
  `/automation/rules/:id/run`, `/fabric/invoke`. A denial is an outcome, not an
  HTTP failure. Python's `DeniedError` must not be allowed to turn these into
  403s.

### Security findings in the existing surface

Carried forward as findings, **not silently fixed** — changing them is a
contract change that needs a decision (§13):

1. `GET /providers/models/:providerId/:apiKey` puts an **API key in the URL
   path**, where it lands in logs and history.
2. `POST /governance/*` accepts `projectPath` **directly from the request
   body** — the only route that takes an arbitrary filesystem path from a
   caller, bypassing the project registry. This is exactly the boundary the
   mission brief says must not be bypassable.
3. There is no authentication of any kind; any local process can drive the
   full surface.

---

## §3 — Persistence

**TypeScript location:** `packages/ai-service/src/persist.ts` (47 lines), plus
**two verbatim duplicates** in `packages/automation/src/persist.ts` and
`packages/engineering-memory/src/utils/persist.ts`.
**Classification: DUPLICATED.**
**Python destination:** `backend/src/aura_backend/core/json_store.py` — **one**
implementation.
**Difficulty: LOW.** **Status: TESTED.**

Home resolution: `AURA_HOME` \|\| `~/.aura`, `mkdir -p` on every call.
Write discipline: `mkdir -p` → write `<file>.<pid>.tmp` → `rename` (atomic).
Read discipline: return the fallback on missing **or corrupt**.

The Python `JsonStore` matches this and adds `fsync` before rename plus
process-local write serialization. Corrupted persistence yields the default
rather than crashing — pinned by a negative-control test.

### Full `$AURA_HOME` layout

Authoritative (A) vs derived cache/index (C):

| Path | A/C | Owner |
| --- | --- | --- |
| `projects.json` | A | `projects.ts` |
| `providers.json` | A | `provider/credentialStore.ts` (encrypted keys) |
| `secrets.json` | A | `secrets.ts` (AES-256-GCM) |
| `fabric-policy.json` | A | `fabric/policyStore.ts` |
| `fabric-approvals.json` | A | `fabric/approvalStore.ts` |
| `fabric-audit.jsonl` | A | `fabric/auditStore.ts` (append-only) |
| `profiles/<projectId>.json` | C | `profile.ts` (fingerprint-invalidated) |
| `memory/<projectId>.json` | A | `memory.ts` |
| `conversations/<projectId>.json` | A | `conversations.ts` |
| `missions/<projectId>/<missionId>.json` | A | `mission/store.ts` |
| `diagnosis/<projectId>/<id>.json` | A | `diagnosis/store.ts` |
| `workflows/<workflowId>.json` | A | `workflow/store.ts` |
| `workflow-versions/<workflowId>/<vid>.json` | A | `workflow/versions.ts` |
| `workflow-runs/<workflowId>/<runId>.json` | A | `workflow/run/store.ts` |
| `workflow-runs/index.json` | **C** | rebuildable via `POST /workflow-runs/reindex` |
| `notes/<projectId>/…` | A | `workflow/nodes.ts` |
| `automation/rules/<ruleId>.json` | A | `automation/store.ts` |
| `automation/runs/<ruleId>/<runId>.json` | A | `automation/store.ts` |
| `automation/schedule-state.json` | C | `ai-service/automation.ts` (fire times + missed count only) |
| `automation/manifest-snapshots/…` | C | `automation/triggers.ts` |
| `engineering-memory/<projectId>/{missions,bugs,decisions,timeline,patterns}` | A | engineering-memory |
| `index/<projectId>/{coding,fullstack}` | C | `pipeline.ts` |
| `index/<projectId>/graphify/{graph.html,graph.json}` | C | `graphify.ts` |
| `index-state/file-mtimes.json` | C | `intelligence/performance.ts` |
| `cross-repo/graph.json`, `workspace/graph.json` | C | `intelligence/*` |
| `changes/log.json` | C | `intelligence/changeIntelligence.ts` |
| `personality/`, `repo-profile/`, `versions/`, `summaries/`, `glossary/`, `identity/`, `health/`, `reports/` | C | `intelligence/*` |

**Recovery semantics to preserve:** every C file must be rebuildable from A
files or from the user's repositories. `workflow-runs/index.json` has an
explicit rebuild route; the Python port keeps it and adds a negative control
that deleting the index and reindexing restores the same run list.

**Security finding:** `homePath(...parts)` does **not** sanitize its segments.
Safety today rests on upstream id generators (`slug()`, `genId()`, the secret
name regex), not on the persistence layer. The Python port validates segments
in the persistence layer itself — defense in depth, and it closes a traversal
that would otherwise be reachable if any id generator is ever loosened.

---

## §4 — Projects / workspace / project registry

**TypeScript location:** `projects.ts` (135), `profile.ts` (385),
`workspace.ts` (1336, modified in the working tree), `conversations.ts` (146).
**Classification: EXISTS** (`workspace.changeLog()` sub-feature **UNVERIFIED** —
nothing calls `recordChange()`, so the endpoint returns an empty log by
construction).
**Python destination:** `backend/src/aura_backend/workspace/`.
**Difficulty: HIGH** — `workspace.ts` is the domain façade the whole server
talks to; in Python it must become several collaborating services without
becoming several authorities.

Grounding rules that must survive the port:

- `add()` resolves the path, requires it to be an existing directory, and
  rejects duplicates by resolved path.
- `remove()` never deletes the user's folder.
- Ids are `slug()`ed and de-duplicated, which is what makes them safe as path
  segments.
- `createProject` rejects names containing `/`, `\`, `.`, `..`.
- `acceptDiagnosis` path-validates with `resolveInsideProject(root, filePath)`.
- `acceptMissionTask` routes its write **through the Fabric**
  (`filesystem.write` with a grant derived from the human's Accept), so policy,
  floors, path resolution and read-back all still apply.
- `startWorkflowRun` binds a run to **one project named at start** — never
  "whatever is currently mounted".
- `cwd` for any execution is resolved from the registry by `projectId`, never
  from a request body.

`runTaskThroughFabric` maps invocation outcomes to task status, and one mapping
is a deliberate safety choice worth preserving verbatim: **`unverified` →
`error`.** An effect that could not be verified is treated as a failure, not a
success. `awaiting-approval` → `pending` keeps the task queued so an approval
can resume it; `denied` → `rejected`; `unsupported`/`failed` → `error`.

**Status: NOT STARTED.**

---

## §5 — Secrets

**TypeScript location:** `packages/ai-service/src/secrets.ts` (264 lines).
**Classification: EXISTS.**
**Python destination:** `backend/src/aura_backend/secrets/`.
**Difficulty: CRITICAL.**

| Property | Value |
| --- | --- |
| At rest | `$AURA_HOME/secrets.json` |
| Cipher | AES-256-GCM, random IV per secret, auth tag stored |
| Key | `sha256(seed + ':aura-workflow-secrets-v1')` |
| Seed | `AURA_SECRET_SEED` env var, else a random 32-byte hex **persisted in the same file** |
| Name regex | `^[A-Za-z0-9_.-]{1,64}$` |
| Reference syntax | `{{secret:NAME}}` |
| Redaction token | `••••` |

Design properties that are the whole point and must be carried over exactly:

- **There is no route that returns a secret value.** `reveal()` and `touch()`
  are private. `GET /secrets` returns metadata only (name, timestamps, length,
  note).
- A missing or tampered secret fails the GCM tag check, yields `null`, and
  `resolve()` **throws with an actionable message** — it never passes the
  literal `{{secret:NAME}}` through to a provider or a process.
- `redactor()` skips values shorter than 4 characters (redacting those would
  mangle unrelated text) and sorts longest-first so an overlapping secret
  cannot leave a fragment behind.
- Secrets are resolved **at the last moment** into Fabric invocation arguments
  and redacted out of logs, audit, evidence and responses.

**Honest characterization to preserve, not paper over:** with the default seed,
the key material sits beside the ciphertext. That defeats casual reading and
accidental file sharing; it does not defeat an attacker who has the file.
Setting `AURA_SECRET_SEED` is the stronger configuration. OS keychain
integration is **NOT IMPLEMENTED** and the Python port does not get to claim
otherwise.

**Negative controls required before this is TESTED:** secret value absent from
every API response, log line, audit record, evidence record, workflow
definition export, and error message; tampered ciphertext refuses rather than
returns; `{{secret:X}}` for an unknown X throws instead of leaking the literal.

**Status: NOT STARTED.**

---

## §6 — Capability Fabric, policy, approvals

**TypeScript location:** `packages/capability-fabric/src/` (pure domain — no
`node:*`, no fetch, all I/O injected through host ports; the most portable
package in the repo), `packages/ai-service/src/fabric/` (host wiring).
**Python destination:** `backend/src/aura_backend/fabric/`, `policy/`,
`approvals/`, `audit/`.
**Difficulty: CRITICAL. This is the highest-risk migration in the project.**

### §6.1 The invoke pipeline — 7 stages, none skippable

`fabric.ts` (793 lines), `class CapabilityFabric`:

```
0. unknown capability      → settle(failed, 'unknown-capability')
1. contract validation     → settle(failed, 'invalid-input')
2. node routing            → settle(denied, rule = resolution.code)
3. policy                  → settle(denied)
4. approval                → settle(awaiting-approval)
5. execute (+ retry)       → settle(unsupported) if no executor
6. verify                  → outcome 'unverified' if passed === false
7. audit
```

`settle()` is the **single exit** and `record()` the **single audit writer**
(for both settled invocations and human approval decisions), so persistence
cannot be added on one path and forgotten on another. A failing audit store
never fails an action.

Node resolution happens **before** policy, and policy's `nodeAvailable` is
derived from that same resolution, so the floor and the router cannot disagree.

**Retry:** `MAX_ATTEMPTS = 3`, `BASE_BACKOFF_MS = 400`, exponential
`400 * 2^(n-1)`, and **only** when `isTransient(detail)` matches
`/\b(timeout|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|429|503|temporarily)\b/i`.

**Approval keying** (`approvalKey()`) collapses repeated asks:
`missionId:taskId:capability` → else `runId:workflowNodeId:capability` → else
`inv:invocationId`. Pressing Run three times on a gated task asks **one**
question.

### §6.2 The policy engine — `policy.ts` (332 lines)

`DEFAULT_POLICY`: `byRisk = {low: auto-execute, medium: ask-user, high:
require-approval}`; `overrides = {mission.approve: ask-user, provider.connect:
require-approval}`; `allowAutonomous: true`.

**Evaluation order is the security argument and must be reproduced exactly:**

1. **Hard floors, checked before any configuration is read:**
   - `nodeAvailable === false` → `deny`, rule `no-provider`
   - missing non-human-only permissions → `deny`, rule `permission-denied`
2. **Seed:** `decision = byRisk[risk]`, rule `risk-default:<risk>`
3. **The four `require-approval` floors** — a **lower bound, not a ceiling**.
   They seed via `stricter(decision, 'require-approval')` and **fall through**;
   they used to return early, which prevented `deny` rules from applying to
   irreversible capabilities. Mutually exclusive, in precedence order:

   | Floor | Trigger |
   | --- | --- |
   | `irreversible-floor` | `capability.irreversible === true` |
   | `destructive-floor` | permissions include `resource.destroy` |
   | `authorization-floor` | permissions include `account.authorize` |
   | `system-floor` | permissions include `system.modify` |

4. **Configurable layers**, each folded with `stricter()` — a weaker candidate
   changes nothing **and must not relabel a floor**:
   `overrides[capId]` → `nodeOverrides['@nodeId']` → `nodeOverrides['capId@nodeId']`
   → `nodeAllowlists[capId]` excluding the node → `deny`.
5. **Autonomy switch:** `!allowAutonomous && decision === 'auto-execute'` →
   `ask-user`, rule `autonomy-disabled`.

`stricter(a, b)` uses `RANK = {auto-execute: 0, ask-user: 1, require-approval:
2, deny: 3}` and returns the higher rank. **Policy only ever escalates.**

**`HUMAN_ONLY_SCOPES`** — `account.authorize`, `resource.destroy`,
`system.modify` — are never grantable by any node flag at any level. They are
deliberately excluded from the step-1 permission check so they are *gated*
rather than made impossible.

**`sanitizePolicy` treats the file as hostile:** unknown decision strings are
dropped; `nodeOverrides` keys must contain `@`; a malformed `nodeAllowlists`
value becomes `[]` — **fail closed, deny everything**, not "missing"
(absent ≠ empty); `allowAutonomous` present-but-not-boolean → `false`.

**`grantsFor()`** maps read/write/execute to scopes and **never** emits the
three human-only scopes, so granting "write" can never escalate into destroying
a database.

**Classification: EXISTS.** Verified by `scripts/node-policy-verify.mjs`, which
explicitly proves an "allow" rule contributes no relaxation.

### §6.3 The capability manifest — 30 capabilities, 21 executors

`manifest.ts` (391 lines) declares 30 capabilities in one flat namespace.
**Nine have no executor and report `unsupported` at call time** — the manifest
is never allowed to lie about what can run.

High-risk and floor-bearing entries:

| Capability | Risk | Floor trigger | Node capability |
| --- | --- | --- | --- |
| `provider.connect` | high | `account.authorize` | — |
| `agent.delegate` | high | `irreversible: true` | `coding-agent` |
| `git.push` | high | `irreversible: true` | `source-control` |
| `system.install` | high | `system.modify` | **none, deliberately** |

`system.install` has no `requiresNodeCapability` on purpose — installing is how
a node comes to exist. The consequence is that `executedNodeId` stays empty and
the installed node travels in the result payload as the *object*, not the actor.

Missing executors (report `unsupported`): `mission.create`, `mission.start`,
`diagnosis.run`, `provider.connect`, `github.create_repository`,
`github.create_pr`, and the five `browser.*` capabilities.
**Classification: manifest EXISTS; executors PARTIAL (21/30), honestly reported.**

### §6.4 Host decisions — `ai-service/src/fabric/index.ts`

Four decisions the Fabric refuses to make for itself, each a security boundary:

- `permissionsFor` → `runScopes.forRun(runId) ?? LOCAL_GRANTS` — **narrowing
  only**.
- `nodeAvailable` → `null` when no node capability is required; `true` for
  `surface === 'aura-internal'`; else set membership.
- `resolveNode` → a requested node is **refused, never silently substituted**.
  Denial codes: `unknown-node`, `node-not-connected`, `node-lacks-capability`,
  `node-unsupported`, `no-provider`. With nothing requested, the tie-break is
  **first present provider in CATALOG order** — catalogue ordering is a
  behavioral contract.
- `requestApproval` → true only if `approvedCapabilities` covers every item.
  **No UI means no implicit yes**, and a grant never outlives the invocation
  carrying it.

### §6.5 Approval, audit, scope stores

| Store | File | Discipline |
| --- | --- | --- |
| Approvals | `~/.aura/fabric-approvals.json` | **Only `pending` survives a restart** — an unspent grant must not outlive the process. Single-use via `consumedAt`. |
| Audit | `~/.aura/fabric-audit.jsonl` | **Append-only JSON Lines, no `save(all)` port.** `MAX_RECORDS = 5000`, trim at 6000, amortized. Unparseable lines are skipped, never discarding the trail. |
| Policy | `~/.aura/fabric-policy.json` | Read through `sanitizePolicy`; a corrupt file degrades to the shipped default. |
| Run scopes | **none — in-memory only** | A scope surviving a restart would be a standing permission for a dead run. `forRun(unknown)` returns **all-false**, not the ceiling. |

`summarizeInput()` redacts keys matching `/^(apiKey|token|secret|password)$/i`
and truncates to 60 characters before anything reaches the audit record.

`executedNodeId()` returns `undefined` unless the capability requires a node
**and** `attempts > 0` — a denied call resolves a node and never runs on it, so
the audit must not assert execution.

**Status: policy engine IMPLEMENTED + TESTED (§6.6). Rest NOT STARTED.**

### §6.6 Python policy engine — first CRITICAL subsystem migrated

`backend/src/aura_backend/policy/` — a direct behavioral port of `policy.ts`,
pure domain, no I/O. Same evaluation order, same rule strings, same
fail-closed sanitizer.

Negative controls (all passing) prove the properties that make the engine a
security boundary rather than a configuration reader:

- No configuration can lower a floor — every `byRisk`, `overrides`,
  `nodeOverrides` and allowlist combination is asserted to leave
  `require-approval` intact on floor-bearing capabilities.
- A node override can only make a decision stricter, never weaker.
- Human-only scopes are never emitted by `grants_for` at any grant combination.
- A malformed allowlist denies everything rather than allowing everything.
- Floors are evaluated before configuration is read.

---

## §7 — Execution / process layer

**TypeScript location:** `packages/ai-service/src/exec/process.ts` (457),
`install.ts` (314), `which.ts` (224).
**Classification: EXISTS.**
**Python destination:** `backend/src/aura_backend/execution/`.
**Difficulty: CRITICAL.**

### The three disjoint allow-lists — exact contents, never merged

| List | Contents |
| --- | --- |
| `SAFE_BINARIES` (13) | `git, ls, pwd, node, npm, npx, wc, du, grep, find, cargo, python3, go` |
| `AGENT_BINARIES` (6) | `opencode, claude, codex, gemini, qwen, cursor-agent` |
| `INSTALLER_BINARIES` (4) | `npm, pipx, cargo, gh` |

Deliberately absent from `INSTALLER_BINARIES`: `sudo, pacman, apt, dnf, yay,
paru`. AUR helpers are privilege-escalating even running as the user.

**`installSubcommand()` — a verb-level guard** that exists because
`SAFE_BINARIES` and `INSTALLER_BINARIES` share `npm` and `cargo`. It blocks
`npm install` with `-g`/`--global`, `cargo install`, `go install`, and
`python3 -m pip install`. Without it, medium-risk `terminal.execute` would
side-step `system-floor` entirely. The refusal names `system.install` as the
correct path.

**`parseCommand()`** rejects shell metacharacters `/[;&|<>`$\\]/` before
anything else, splits on whitespace, requires `bin ∈ SAFE_BINARIES`, then
applies the verb guard. It never shell-interprets. It is exported so the Fabric
can refuse *before* showing an approval prompt.

### `settle()` — the single place exit status is decided

It is single because it was once wrong: `typeof code === 'number' ? code : 0`
turned every timeout into a success.

| Condition | Result |
| --- | --- |
| no error | `code: 0` |
| `err.killed` (timeout) | **`code: 124`** (`TIMEOUT_EXIT_CODE`, matching `timeout(1)`), `timedOut: true` |
| signal present | **`code: 128 + SIGNAL_NUMBERS[sig]`**, where `{SIGHUP:1, SIGINT:2, SIGQUIT:3, SIGKILL:9, SIGTERM:15}`, unknown → `+0` |
| numeric `err.code` | that code |
| otherwise | **`code: 1`, never 0** |

Timeouts: git 20 s, shell 30 s, **agent 10 min**, **install 5 min**;
`MAX_BUFFER = 4 MiB`.

`safeShell` **rejects a killed process even when it printed output** — partial
output must not be mistakable for a complete run. `safeShellWithCode` surfaces
the code instead of raising, because the Fabric verifies `terminal.execute` by
exit code and needs the number.

`runAgent`/`runInstaller` pass args to `execFile` **as an array, never joined**
— a task containing shell metacharacters is data, not syntax — and close stdin
immediately (verified: identical argv completes in ~97 s with stdin closed and
hangs indefinitely without).

`resolveAgentBinary`/`resolveInstallerBinary` reject `/`, `\`, `..` and shell
metacharacters **before consulting the list**: a caller may *name* an agent,
never *locate* one.

### Installation privilege — a floor that may only rise

`install.ts` decides three things and performs no installation. The catalogue's
`privilege` value is a **floor**: an `npm-global` install whose prefix is not
writable is escalated to root, never the reverse. An unresolvable npm prefix
escalates to root ("will not assume it may write there").

`writableWithAncestors()` walks up only past directories that genuinely do not
exist; a directory that exists and is **not** writable is a real refusal. This
exists because `~/.cargo/bin` does not exist until the first `cargo install`,
and stat'ing the leaf would escalate an ordinary userspace install for no
reason.

**Root tier: AURA executes nothing.** It returns `installOutcome: 'guided'`
with the exact command for the user to run. `detectDistro()` exists only to
name the right package manager in that instruction.

**Exit 0 is a claim; the probe is the evidence.** After a userspace install,
`probeNode(nodeId, refresh=true)` runs with the cache bypass **mandatory**. Not
present ⇒ `unverified`, never `installed`. Verification passes only for
`installed`; `guided` deliberately fails verification.

**Python note:** Python's `subprocess` makes unsafe shell execution *easier*
than the safe form. The port uses `subprocess` with an argv list and
`shell=False` exclusively; there is no code path that accepts a command string.

**Status: NOT STARTED.**

---

## §8 — Environment / node catalogue

**TypeScript location:** `packages/ai-service/src/environment.ts` (251),
`packages/connected-environment/src/` (8 files, pure domain).
**Classification: EXISTS**, with one dormant seam (`upsertActivity` — no
transport implements `execute`, stated in-source as honest rather than an
oversight).
**Python destination:** `backend/src/aura_backend/environment/`.
**Difficulty: MEDIUM.**

105 catalogue entries, 48 capability ids, 11 entries with an install spec.

**The security boundary, stated in-source and worth quoting in the port:** the
probe command and arguments **always** come from the catalogue entry looked up
by id, never from the request body. A client can say "probe the node called
`docker`"; it can never say "run this string". Combined with `execFile` (no
shell), there is **no path from an HTTP request to arbitrary command
execution** — which is what makes binding a local port acceptable.

Honesty controls to preserve: presence is decided by recognizable output, not
exit code (`java -version` prints to stderr; some tools exit non-zero while
present). `extractVersion` deliberately has **no leading `\b`** — in `v24.7.0`
there is no word boundary between `v` and `2`, so `\b` would report `7.0`.

Constants: probe timeout 4 s, HTTP probe 2.5 s, cache TTL 30 s, concurrency 8.

**Known bug to carry forward as a decision (§13):** `refreshNodeAvailability(ids)`
in `server.ts` *replaces* rather than merges the global projection, so a
targeted scan makes every unscanned node appear to vanish, and a genuinely
installed node can become unroutable with `node-not-connected`. The Python port
merges. This is a **behavior change** and is recorded in §13.

**Status: NOT STARTED.**

---

## §9 — Mission system

**TypeScript location:** `packages/ai-service/src/mission/` (22 files).
**Classification: EXISTS** (engine), **PARTIAL** (UI unreachable).
**Python destination:** `backend/src/aura_backend/missions/`.
**Difficulty: HIGH.**

A nine-stage creation pipeline of which **only three stages call a model**
(intent extraction, goal graph, adversarial review) and the rest are
deterministic. Two properties are worth defending in the port because they are
easy to lose:

- **Stage 4 (strategies) is a deterministic registry of 15 category scaffolds.**
  The model is never asked to invent structure, only to fill in a real scaffold.
- **Stage 7 (risk) is 100% deterministic with zero model self-rating** — six
  weighted dimensions over real measurements.

`execution/engine.ts` is pure over injected side effects (`runTask`, `persist`,
`emit`). `acceptTask` is the **only** path that allows a write to disk.
`runOne` wraps the hook in try/except because a raised exception would
otherwise leave a task stuck mid-flight on disk forever.

**Three outcome shapes, not two:** `pending` (an approval gate) is neither
success nor failure.

**Structural limitation carried over as-is: there is no RUNNING state.**
`TaskStatus` is `pending | proposed | accepted | rejected | done | error`. A
task executing right now is indistinguishable from one that has not started, a
crash mid-task leaves it looking `accepted`, and progress is inferred rather
than recorded. Adding a state is a model change touching the DAG, the
projection, the UI and every consumer. **The Python port reproduces the
limitation rather than silently diverging** — fixing it is a product decision,
not a migration decision.

**Status: NOT STARTED.**

---

## §10 — Two name collisions that will mislead the migration

Recorded prominently because both packages sound like they belong to this
migration's core and neither does:

| Package | What the name suggests | What it actually is |
| --- | --- | --- |
| `packages/governance` | The policy/permission authority | **Engineering code-quality analysis** — debt, security review, docs health, release readiness. Orthogonal to the Fabric. The `governance.audit` capability's executor only collects inputs; it does not call this package. |
| `packages/runtime` | An execution runtime | **The provider-neutral LLM inference contract** (`Runtime`, `GenerateRequest`, `StreamChunk`). No repository, project or execution logic. |

Both are actively used. Neither is part of the governance/execution layer.

---

## §11 — Workflow engine

**TypeScript location:** `packages/ai-service/src/workflow/` (18 files, ~4,300
lines).
**Classification: EXISTS.**
**Python destination:** `backend/src/aura_backend/workflows/`.
**Difficulty: HIGH.**

### Execution model — not a topological sort

`engine.ts` is **edge-delivery driven**: `received: Map<nodeId, Map<edgeId,
io|null>>`, and a node is enqueued only when *every* in-edge has delivered.
Entry nodes have zero in-edges. Execution is a sequential FIFO `drain()` loop —
one node at a time. A Python port that reaches for a topological sort will get
skip propagation and conditional branches wrong.

**Skip propagation:** `deliver(edge, None)` is a skip token. When all in-edges
deliver `None`, the node is `skipped` and the skip cascades. A condition fires
one port and delivers `None` to the others.

**Merge:** multiple deliveries concatenate with `\n\n`, `files` flatten, `data`
takes the last delivery.

Bounds: `MAX_LOOP_ITERATIONS = 20`, `MAX_NODE_EXECUTIONS = 400`,
`DEFAULT_RUN_TIMEOUT_MS = 30 min` (floor 1000 ms).

**Single mutation point:** `setState()` → `transitionNode()` is the only place
`node.state` is assigned, which is what makes the append-only transition
history trustworthy. Reproduce that discipline exactly.

### The governance branch

`NODE_CLASS[type] === 'governed'` means the engine **never** calls `spec.run`.
It requires a governor and there is **no fallback** — a missing governor raises
a refusal. All 10 governed node runtimes are `governedOnly()` stubs that throw.
The test suite greps `nodes.ts` to prove it contains no `child_process` or
`fetch`. **The Python port must keep an equivalent assertion**: a source-level
check that the node module cannot execute anything itself.

**Capability bindings are literals keyed by node type** (`governed.ts::BINDINGS`).
No workflow definition, import, or AI generation can change which capability a
node invokes. **A workflow cannot self-grant.**

### Node catalogue — 33 types

source (6): `current-project`, `selected-files`, `changed-files`,
`current-conversation`, `project-memory`, `engineering-memory`.
intelligence (6): `coding-engine`, `fullstack-engine`, `research-engine`
(**disabled**), `intent-classifier`, `prompt-enhancer`, `agent` (**disabled**).
generate (5): `prompt`, `groq`, `generate-markdown`, `generate-code`,
`generate-json`.
logic (5): `condition`, `loop`, `delay`, `variables`, `user-input`.
action (10): `save-memory`, `create-note` (both aura-internal); `export-file`,
`shell-command`, `git-status`, `git-diff`, `git-commit`, `git-branch`,
`http-request`, `slack-notify` (all governed).
io (1): `output`.

### Versions, runs, resume

Versions are **append-only**; `restore()` publishes a *new* version carrying
`restoredFrom`. `hashGraph` is sha256 over sorted nodes/edges with **`x`, `y`
and `name` deliberately excluded** — moving a node on the canvas must not mint a
version. "Version on run, not on save."

**Replay guarantees effect-idempotence:** a replayed node is set `succeeded`
with summary `"replayed from checkpoint"` and fanned out — **never
re-executed**. On resume, the parked node is deliberately *excluded* from the
replay map so it actually runs.

**Crash recovery** (`reconcileInterrupted()`, called once at boot): runs left
`running`/`queued` become `failed` with "AURA stopped while this run was in
flight." **`awaiting-approval` runs are deliberately untouched** — they are not
interrupted, they are waiting.

`resumable` is written onto the record: `awaiting-approval` ⇒ true;
`succeeded` ⇒ false; else `succeededCount > 0`, with an explicit
`notResumableReason`.

**Least privilege per run:** `runScopes.register(runId, envelope.scopes)` at
start, `release(runId)` in a `finally` on **every** exit path.

### Gaps carried into the map

| Gap | Classification |
| --- | --- |
| Workflow-level retry policy | **MISSING** — `NodeRunRecord.attempts` is documented as retry-policy state, but there is no retry loop in `engine.ts`. Retry exists only in the Fabric and the automation chain. |
| `WorkflowVersionStore.removeAll` on delete | **MISSING** — `DELETE /workflows/:id` never calls it; version directories orphan. |
| `agent` node | **EXISTS but DISABLED** — runtime complete and verified, gated pending a trace-review UI. **The Python port keeps it disabled** per the brief. |
| `research-engine` node | **MISSING** — declared, disabled, throws. |

**Status: NOT STARTED.**

---

## §12 — Automation engine and scheduler

**TypeScript location:** `packages/automation/src/` (9 files),
`packages/ai-service/src/automation.ts` (host bindings).
**Classification: EXISTS.**
**Python destination:** `backend/src/aura_backend/automation/`.
**Difficulty: HIGH.**

9 triggers, 12 condition operators, 7 actions. Conditions are dot-path field
lookups; **all must pass**; an empty condition list matches. Unknown operator
⇒ `False`. An invalid regex returns `False` rather than raising.

**Concurrency model:** one run in flight **per rule** (a `running: Map<ruleId,
bool>` mutex), unlimited rules concurrently. `liveRuns` holds *the same object
instance* the loop mutates — which is the documented reason pause and cancel
must not re-read from disk.

**Retry:** `RetryPolicy {maxAttempts: 1 (no retry), delayMs: 1000,
backoffFactor: 2}`, delay = `round(delayMs * backoff^(attempt-1))`.

### The cron implementation

A hand-written 5-field parser, **local time**, minute resolution, no
dependency. Aliases `@hourly`…`@annually`. Explicitly **rejected with a
reason**: `@reboot`, `L`/`W`/`#` modifiers, 6-field (seconds) cron, any field
count ≠ 5. `bothDaysRestricted` implements standard OR-semantics when both day
fields are restricted. `nextAfter` is bounded by `MAX_SEARCH_DAYS = 366*4` and
returns `None` — a real answer — when nothing matches.

**Python note:** a cron library is tempting and wrong here. The exact
acceptance/rejection set, the OR-semantics, and the `None` return are
behavioral contract. Port the parser and test it against the same cases.

### The missed-fire policy — do not "improve" this

**Fire none, record that fires were missed.** `start()` calls `reconcile()`
**before** arming the timer, so launching AURA can never execute a backlog.
`reconcile()` counts occurrences between `lastFiredAt` and now (bounded at 1000
per rule) and accumulates `missedCount`. Disabled rules miss nothing.

The brief says not to introduce automatic catch-up. This is where that would
accidentally happen.

**Automation grants nothing.** `run-workflow` dispatches with actor
`{system, automation:<ruleId>}` and **no `approvedCapabilities`** — an
automation can never authorize its own high-risk action; the run parks at
`awaiting-approval` instead. A parked run is reported as a **successful action**
so the retry policy does not re-ask.

### Gaps

| Gap | Classification |
| --- | --- |
| Automation run crash recovery | **MISSING** — no analogue of the workflow engine's `reconcileInterrupted()`. An interrupted automation run stays `running` on disk forever. |
| Automation run retention / timeline bounds | **MISSING** — no `MAX_RUNS`, no timeline cap. Workflow runs have both. |
| `createTriggerScanner` auto-invocation | **PARTIAL** — no background caller in the service; file/dependency/PR triggers reach the engine mainly via `POST /automation/events`. |
| `AutomationRunEvent {type:'log'}` | **DEPRECATED** — declared, never emitted; logs ride inside the next `run` event. |

The first two are real robustness gaps rather than deliberate designs. The
Python port implements both and records them in §13 as contract changes.

**Status: NOT STARTED.**

---

## §13 — Agent runtime

**TypeScript location:** `packages/ai-service/src/workflow/agent/` (3 files).
**Classification: EXISTS but DISABLED at the node registry.**
**Python destination:** `backend/src/aura_backend/agents/`.
**Difficulty: CRITICAL.**

Ceilings `{maxIterations: 25, timeoutMs: 600_000, maxTokens: 200_000,
maxConsecutiveFailures: 5}`; defaults `{10, 60_000, 10_000, 3}`.
`resolveBounds` clamps silently and records the *effective* bounds on the trace.

**`resolveTools` narrows by four rules**, and every one is a security control:
the tool must exist in the manifest, be in the workflow's authority envelope,
**not be irreversible**, and **need no human-only scope**.

Tool descriptions come from the **manifest**, not the workflow definition —
that is the tool-poisoning control. Tool output is fenced as
`<untrusted-data>` and flagged `untrusted: true` on the record.

Nine beat kinds; only `awaiting-approval` is resumable, and bounds carry across
a resume (elapsed time subtracted, iteration counter continues). The approval
key `runId:workflowNodeId:capabilityId` is stable across a resume.

**Per the brief, the Python port keeps this disabled until fully verified.**

**Status: NOT STARTED.**

---

## §14 — AI provider layer

**TypeScript location:** `packages/ai-service/src/provider/` (12 adapters +
6 support modules).
**Classification: EXISTS**, with usage accounting **MISSING**.
**Python destination:** `backend/src/aura_backend/ai/`.
**Difficulty: MEDIUM.**

**BYOAK only — there is no built-in default.** The hub has no AI until the user
connects a provider with their own key. Twelve adapters: groq, openai,
anthropic, gemini, nvidia, openrouter, mistral, cerebras, kimi, novita, qwen,
kage7. Most are OpenAI-compatible over a shared base; anthropic and gemini have
their own runtimes.

### Credential encryption — exact parameters for store compatibility

| Parameter | Value |
| --- | --- |
| File | `~/.aura/providers.json` |
| Algorithm | AES-256-GCM |
| Key derivation | `sha256(seed + ':aura-provider-v2')` — **single SHA-256 pass, no salt, no KDF** |
| Seed precedence | `AURA_PROVIDER_SECRET` → `store.secret` → fresh `randombytes(32)` persisted into the same file |
| **IV** | `randombytes(16)` — **16 bytes, not the GCM-standard 12** |
| Encoding | hex for ciphertext and tag |
| Fingerprint | `key[:4] + '…' + key[-4:]` (U+2026), else `'****'` |

**Python must use a 16-byte nonce to interoperate** with an existing store.
This is exactly the kind of detail a "clean rewrite" loses.

**Module-import-time path capture:** `STORE_PATH` is computed when the module
is imported, so `AURA_HOME` must be set before import. Several intelligence
modules share this hazard (`changeIntelligence`, `crossRepo`, `workspace`,
`performance` all call `homePath()` at module level). **The Python port uses
lazy accessors throughout** — recorded in §15 as a contract change.

### Error translation — one authority

`errorTranslator.ts` classifies into 11 categories. **Content rules run before
status rules** because Novita reports no-credits as a 403. Retryable is exactly
`{rate_limit, network, server_error, timeout}`. 401 and 403 are deliberately
**not** merged. Raw provider payloads never reach the user except in the
`unknown` branch, truncated to 300 characters.

### Findings

- `detectProvider()` brute-forces validation across **up to 12 third-party
  endpoints**, sending the user's key to all of them. Carried as an open
  finding.
- Gemini puts the API key **in the URL query string** — a distinct redaction
  path from Bearer headers.
- **Usage accounting is MISSING**, not partial: `inputCostPer1k` /
  `outputCostPer1k` are declared but never populated and never read; token usage
  is passed through and never aggregated or persisted. A Python port that wants
  cost tracking is **building it new**, and must say so.

**Status: NOT STARTED.**

---

## §15 — Context, RAG and intelligence

**TypeScript location:** `packages/ai-service/src/context/` (4 files),
`intelligence/` (21 files), `memory.ts`, `knowledgeGraph.ts`, `pipeline.ts`,
`diagnosis/` (20 files), plus `knowledge-coding` and `knowledge-fullstack`.
**Python destination:** `backend/src/aura_backend/context/`, `intelligence/`.
**Difficulty: HIGH.**

### There is no vector RAG. Do not add one.

Retrieval is **lexical BM25 + structural graph traversal + keyword-overlap
memory recall**. The source says so in several places, emphatically:
`InvertedIndex` — "a real keyword index with BM25 ranking… **No vectors.**"
(K1 = 1.5, B = 0.75, code-aware camelCase/snake_case sub-token expansion,
exact/prefix/bounded-fuzzy). `@aura/retrieval`'s own package description reads
"No embeddings, no indexing, no vector DB." The only `EmbeddingProvider` is a
`NullEmbeddingProvider` documented as "**NOT a semantic embedding and must not
be used for real similarity search**."

A Python port must reimplement BM25 with the same K1/B and the same
multiplicative boosts (filename ×1.6, path ×1.2, symbol ×1.3, filename-filter
×1.3, recency), **not** reach for a vector database. That would be a silent
behavioral rewrite of every retrieval result in the product.

### Deterministic versus AI-driven — the line to defend

**Deterministic (no model call): everything that produces the system prompt.**
Intent classification (regex tables over 17 intent types), prompt enhancement,
identity generation (one bounded 40,000-dirent scan, weighted language counts,
scored directory patterns, file-content regex signals, README prose
extraction), retrieval, summaries, profile, glossary, health, freshness
grading, budgets, contract rendering, and `assembleContext` itself — which is a
`switch` on intent selecting which pre-computed strings to concatenate.

**AI-driven: only after assembly, as a verbalizer.** The preamble literally
instructs the model that it is "the voice of AURA… your job is to verbalize…
not to independently decide what the repository is."

Risk merging is **floor-preserving**: `mergeRisk()` takes the max of the
deterministic floor and the model's rating — "the model may add reasons but can
never downgrade a deterministic floor."

**This is the property most at risk in a Python rewrite**, because it is
tempting to let a model do assembly work that is currently a lookup table.

### Two parallel context systems — DUPLICATED by intent

| System | Consumer | Status |
| --- | --- | --- |
| `intelligence/contextAssembler.ts` | The **model** — builds the actual system prompt via `pipeline.ts` | Live |
| `context/` Context Fabric | **Agents** — HTTP only, `GET /projects/:id/context[/contract]` | Live but **not in the prompt path** |

`pipeline.ts` does **not** use the Context Fabric. Both are live; the
duplication is deliberate (agent-facing vs model-facing) but must be recorded so
the Python port does not "consolidate" them into one and silently change what
the model sees.

The Context Fabric's freshness model has two load-bearing rules worth carrying
verbatim: **"Unknown is not empty"** (never-computed ≠ computed-and-empty) and
**"Nothing is invented"** (every value projected from an existing authority).
Overall freshness is `repository.freshness` — explicitly *not* a blend and
*not* worst-of-all, because live sections would mask an unindexed project and
the workspace-wide change log would pin everything to `unknown` forever.

### Dormant and duplicated

| Item | Classification | Action |
| --- | --- | --- |
| `@aura/retrieval` runtime surface | **DORMANT** — a declared dependency with **zero imports** from the service. Kernel, engines, memory hierarchy, budget allocator and all provider dummies are unreachable. | **Do not port.** Port only `estimateTokens` and the `ContextItem`/`ContextPackage` shapes. |
| `@aura/intelligence`'s `KeywordIntentClassifier` | **DEPRECATED in effect** — computed, then overridden by `intelligence/repositoryIntent.ts`. | Port only `TemplatePromptEnhancer` and `createRequest`. |
| Three token estimators | **DUPLICATED** | One in Python. |
| Two health surfaces, two persist utilities, two git wrappers | **DUPLICATED, intentional** | Consolidate persist; keep the rest as-is with a note. |
| `pipeline.setKey` / `clearKey` | **DEPRECATED no-op shims** | Keep the routes, keep them no-ops, do not grow them. |

### The TypeScript-compiler dependency

`diagnosis/` depends on the **TypeScript compiler API** in five modules
(`signals.ts`, `simulate.ts`, `tsHelpers.ts`, `detectors/nullBug.ts`,
`detectors/brokenApi.ts`). A Python backend needs a Node sidecar, tree-sitter,
or an accepted fidelity loss. **This is a genuine migration blocker for the
diagnosis subsystem** and is listed in §17.

`graphify.ts` shells out to an external Python binary and is **the only place
the service writes into the user's repository** (`<projectPath>/graphify-out/`),
which contradicts `persist.ts`'s stated "nothing is written into the user's own
repositories." Recorded as a disagreement, not silently resolved.

**Status: NOT STARTED.**

---

## §16 — Verification inheritance

The TypeScript suites are the behavioral reference and are **reused, not
rewritten**, wherever they speak HTTP.

**Directly reusable against a Python backend, unchanged** (they only speak HTTP
to `:4319` or drive the browser):
`node-policy-verify`, `node-routing-verify`, `agent-delegate-verify`,
`agent-failure-recovery-test`, `install-verify`, `desktop-runtime-verify`,
`packaging-verify`, `hub-verify`, `hub-mission-verify`,
`hub-execution-verify`, `ui-approval-test`, `ui-workflow-test`,
`ui-automation-test`.

**Must be re-authored in Python** (they import TypeScript modules in-process):
`verify-workflow-automation.mjs` — **the single most valuable artifact in the
repository: 26 sections, 129 assertions, the executable specification of the
governed workflow and automation path** — plus `verify-automation.ts`,
`verify-automation-runtime.ts`, `process-timeout-test.mjs`,
`node-attribution-test.mjs`, `platform-verify.mjs`, `verify-providers.ts`.

**Coverage gap inherited from TypeScript.** These subsystems have **no
verification script at all** and are covered only by `tsc --noEmit`:
`context/`, all of `intelligence/`, `memory.ts`, `knowledgeGraph.ts`,
`graphify.ts`, `architectureExtractor.ts`, `codeAction.ts`, `jsonMode.ts`, all
of `diagnosis/`, `secrets.ts`, `errorTranslator.ts`. There is **no unit-test
framework in the repository** — verification is script-based end-to-end only.

The Python port has pytest, so these become **newly covered**. That is an
improvement, but it also means **there is no reference result to compare
against** for those subsystems: parity there must be established by reading the
TypeScript source, not by running it. Recorded honestly rather than claimed as
parity.

**Only `test:ui` is wired into `package.json`.** Every other suite is invoked
by path. The Python side adds an aggregate runner.

---

## §17 — Migration blockers

| # | Blocker | Affects | Options |
| --- | --- | --- | --- |
| 1 | TypeScript compiler API dependency | `diagnosis/` (5 modules) | Node sidecar · tree-sitter · accept fidelity loss. **Undecided — needs a product decision.** |
| 2 | `graphify` external Python binary | `graphify.ts`, `architectureExtractor.ts` | Already a subprocess; ports directly. Low risk. |
| 3 | No reference results for 11 unverified subsystems | Context, intelligence, diagnosis, secrets | Parity must be established by source reading. Cannot be automated. |
| 4 | 16-byte GCM IV and import-time path capture | Provider credential store | Reproduce the IV length exactly; convert paths to lazy accessors. |
| 5 | `verify-workflow-automation.mjs` re-authoring | Workflow + automation parity | 129 assertions to port. Largest single verification task. |

---

## §11 — Security posture carried into Python

Preserved exactly:

- Loopback-only bind; origin allow-list; no `*` CORS.
- One policy engine; four floors no configuration can lower; deny-only node
  overrides.
- One execution path — agent, workflow, automation, tool and API caller all go
  through the Fabric.
- Three disjoint binary allow-lists, never merged.
- Named, not located: agent and installer resolvers reject anything path-like
  before consulting their list.
- `cwd` from the project registry, never from a request.
- No secret read-back route.
- Approval grants derived from stored requests.

Improved, and therefore a documented change (§13):

- Path-segment validation moved into the persistence layer.
- Explicit SSE drain and scheduler stop on shutdown.

Carried as open findings, not silently fixed:

- No authentication on any route.
- API key in a URL path on `GET /providers/models/:providerId/:apiKey`.
- `POST /governance/*` accepts an arbitrary `projectPath` from the body.

---

## §12 — Cutover gates

The TypeScript backend is not retired until Python demonstrates, with named
evidence: functional parity, API parity, security parity, persistence parity,
workflow parity, automation parity, AI parity, context parity, Fabric parity,
approval parity, event/streaming parity, recovery parity, verification parity,
and acceptable performance.

Differential harness: `backend/parity/harness.py`. It sends identical requests
to both backends and reports every difference. It normalizes only ids,
timestamps, durations, pids, ports, version strings, backend-identity fields
and home-directory prefixes. **Its own tests assert that it cannot hide a
behavioral difference** — a missing field, a changed type, or a differing
denial reason is always reported.

**Status: TESTED** (6 harness tests, including the negative controls).

---

## §13 — Contract changes

Every deliberate divergence from the TypeScript contract is recorded here. The
list is currently short by design.

| # | Change | Rationale | Risk |
| --- | --- | --- | --- |
| 1 | Shutdown drains in-flight SSE streams and stops the scheduler before closing. | The TypeScript `close()` does neither; an interrupted stream and a still-armed timer during shutdown are real failure modes. | Low — strictly more orderly. |
| 2 | Path segments are validated inside the persistence layer, not only by upstream id generators. | Defense in depth against traversal via `homePath()`. | Low — rejects only inputs the current id generators cannot produce. |

---

## §14 — Migration ledger

| Phase | Subsystem | Classification | Difficulty | Status |
| --- | --- | --- | --- | --- |
| 0 | Backend inventory | — | — | **IN PROGRESS** (API + persistence done; fabric, workflow, AI audits pending) |
| 1 | Python infrastructure + API foundation | — | MEDIUM | **TESTED + RUNTIME VERIFIED** |
| 2 | Configuration + persistence primitives | DUPLICATED (TS) | LOW | **TESTED** |
| 3 | Workspace + project registry | EXISTS | HIGH | NOT STARTED |
| 4 | Context + RAG + intelligence | pending audit | — | NOT STARTED |
| 5 | AI service / provider layer | pending audit | — | NOT STARTED |
| 6 | Execution / process layer | pending audit | CRITICAL | NOT STARTED |
| 7 | Capability Fabric + policy + approval | EXISTS | CRITICAL | NOT STARTED |
| 8 | Tools + integrations | pending audit | — | NOT STARTED |
| 9 | Workflow engine | pending audit | HIGH | NOT STARTED |
| 10 | Automation engine + scheduler | EXISTS | HIGH | NOT STARTED |
| 11 | Agent runtime | pending audit | CRITICAL | NOT STARTED |
| 12 | Events / streaming | EXISTS | MEDIUM | NOT STARTED |
| 13 | Full integration | — | — | NOT STARTED |
| 14 | Differential verification | — | — | harness **TESTED** |
| 15 | Performance / security verification | — | — | NOT STARTED |
| 16 | Python production cutover | — | — | NOT STARTED |
| 17 | Retire TypeScript backend | — | — | **BLOCKED on §12** |
