# Phase 3 — Workspace and project registry

**Status: COMPLETE.**
**TypeScript reference:** `packages/ai-service/src/projects.ts` (135),
`profile.ts` (385), `memory.ts` (126), `conversations.ts` (146), and the
project-facing half of `workspace.ts` (1336).
**Python destination:** `backend/src/aura_backend/workspace/`.
**Difficulty: HIGH.**

This is the phase the previous three were waiting on. It was skipped when
the migration jumped to Phase 6, and it has been the named blocker since.

---

## 1. What this phase is actually for

One thing above all others: **an execution's working directory comes from
the registry, by project id, and never from a request.**

Before this phase, `/fabric/invoke` set `cwd=None`, so every executor that
touches a project — filesystem, terminal, git, agent — refused with "No
project directory is set for this invocation." That is safe, and useless.

`WorkspaceManager.cwd_for(project_id)` is now the only source of a working
directory. A caller names a **project**; there is no field anywhere in the
HTTP surface by which it can name a **directory**. A negative control
asserts the signature itself, so if a `cwd` parameter is ever added, that
test is what should stop it.

---

## 2. What was migrated

| TypeScript | Python | Note |
| --- | --- | --- |
| `projects.ts` | `workspace/projects.py` | Registry, slugging, unique ids |
| `profile.ts` | `workspace/profile.py` | 385 lines of folder derivation |
| `memory.ts` | `workspace/memory.py` | Keyword recall — **not** embeddings |
| `conversations.ts` | `workspace/conversations.py` | Per-project, never mixed |
| `workspace.ts` (project half) | `workspace/manager.py` | A **narrow** façade — see §3 |
| `server.ts` `/projects/*` | `api/routes/projects.py` | 15 routes |
| `executors.ts` (6 of 10 internal) | `tools/internal_executors.py` | See §3 |

Executors went from 12 to **18**: `project.list`, `project.create`,
`project.open`, `project.inspect`, `memory.search` and `governance.audit`
now have real implementations.

---

## 3. Two deliberate scope boundaries

**The façade is narrow on purpose.** The reference's `WorkspaceManager` is
1336 lines because it also owns missions, workflows, diagnosis, providers
and intelligence. Porting the class now would mean stubbing five
subsystems, and a stub that answers is worse than a capability that says
`unsupported`.

**Four internal executors stay deferred**, and are not stubbed:

| Capability | Waiting on |
| --- | --- |
| `mission.inspect`, `mission.approve` | the mission store (Phase 11) |
| `knowledge.graph` | the knowledge graph (Phase 4) |
| `workflow.run` | the workflow engine (Phase 9) |

They remain in the manifest so callers can plan around them, and report
`unsupported` when invoked. A `knowledge.graph` that returned an empty
graph would be a capability lying about what it did.

---

## 4. Verification

### 4.1 The reference suites: 18 both-fail → 3

The runner now registers the `hub-exec-test` project the suites assume
exists and never create, then runs them against **both** backends with
isolated homes.

| Suite | Before Phase 3 | After |
| --- | --- | --- |
| `node-routing-verify` | 12 fail on both | **1 fail on both** |
| `node-policy-verify` | 6 fail on both | **2 fail on both** |
| `install-verify` | 0 fail | 0 fail |

**109/109 checks still agree — zero divergence between backends.** The
execution half of the routing suite now runs for real: a coding agent is
spawned against a disposable project, the executed node is attributed, and
the audit records the requested and executed node separately.

The three remaining failures fail **identically on both implementations**,
and the cause is now known rather than assumed: `terminal.execute` is
medium-risk, the **shipped default** policy maps medium to `ask-user`, and
the suites invoke it without a grant — so it parks at
`awaiting-approval`. They were written against a home configured to
auto-execute it. That is a policy-configuration fact of the environment,
and the runner now says so precisely instead of blaming a missing project.

### 4.2 The profiler, differentially — and the systematic bug it found

`profile.ts` is the largest single thing ported here, so it gets its own
oracle: both implementations run `buildProfile` against the **same real
directories** and every derived field is diffed.

The first run showed four of five matching and one differing — the
`languages` array on the AURA repo itself. Counts were identical
(508 TypeScript, 90 Markdown, 27 JavaScript, 10 HTML, 4 Rust, 1 Python,
1 CSS); only the order of the two one-file entries differed.

Chasing it found two real porting errors:

1. **The walk budget was off by one.** The reference writes
   `if (budget-- <= 0) break` — it tests the OLD value and then
   decrements, so it stops one entry *later* than a decrement-first loop.
   On a repository large enough to exhaust the 20,000-entry budget, that
   one entry changes which files are counted at all.
2. **Directory read order differs between the runtimes.** Node's
   `readdirSync` comes back **sorted** (libuv scans with `alphasort`);
   Python's `iterdir` yields raw directory order. This is systematic, not
   cosmetic: walk order sets the insertion order of the language map, both
   implementations then sort *stably* by count, so a tie is broken by walk
   order — and `primaryLanguage` is `languages[0]`. Two languages tied at
   the top would have produced a different primary language.

With directory reads sorted, **all five profiles match field for field**.
Neither bug would have been visible without running both against a real
tree.

### 4.3 Negative controls — 42/42

`tests/test_workspace_negative_controls.py`. The `cwd` boundary:
an unregistered project yields nothing; a registered path that has since
been deleted, or replaced by a file, yields nothing rather than a
directory that no longer is one; and `cwd_for`'s signature takes an id and
nothing else.

Registration: a file, a missing path and a duplicate (including a
differently-spelled duplicate) are all refused; a refused registration
never creates the folder it declined; a project **name** containing a path
separator is refused before it can become a directory; removing a project
never deletes the folder.

Ids: eight hostile names all slug to something safe as a path segment,
because they become one.

Profiles: an empty folder invents nothing; `node_modules` is not walked; a
corrupt `package.json` does not break profiling; the cache is reused until
the fingerprint changes.

Scoping: memory and conversations never leak between projects; recall of
an empty store returns nothing rather than something plausible; and
`remove_last_assistant` can never remove a user turn.

End to end: with a project registered, execution reaches its own files —
**and still cannot escape them**; `../secret.txt` is refused and its
contents appear nowhere in the result.

### 4.4 Full suite

**317 tests pass.** All five parity harnesses remain green: policy
329/329, execution 225/225, fabric 44/44, environment all-match, profiles
5/5. Runtime: process 16/16, fabric 22/22, tools 21/21.

---

## 5. Contracts preserved

Fifteen routes under `/projects`, matching `server.ts`:
list/add; `{id}/open`; `{id}/profile`; memory list/add/pin/delete;
conversations list/create/get/rename/delete, append message, delete last
assistant message; and `{id}` PATCH/POST/DELETE.

Route order is declared **literal-first** because the reference is a
hand-written segment cascade in which earlier blocks shadow later ones —
`/projects/{id}/open` must be declared before `/projects/{id}`.

`POST /projects/{id}/conversations/{cid}/message` answers **200 with an
error body** when the conversation is gone, matching the reference:
appending to a vanished conversation is not a transport failure.

---

## 6. Security findings

1. **An empty `path` registers the process's working directory.**
   `Path("").resolve()` is the cwd, which is a real directory, so
   registration succeeds — and that directory then becomes a valid `cwd`
   for execution. The reference behaves identically (`path.resolve('')` is
   cwd there too), so this is **preserved and recorded, not fixed**:
   changing it is a contract decision. Covered by a test that documents
   the behaviour rather than asserting a refusal that does not happen.
2. **The profile fingerprint covers manifests only.** An edit to a source
   file that touches no manifest leaves the cached profile standing. That
   is the reference's design — the profile describes shape, not content —
   but it means "languages" can lag reality.
3. **No authentication**, unchanged.

---

## 7. Known limitations

- **`pipeline.mount` has no equivalent.** The reference's `open()` also
  mounts the indexing pipeline; there is no pipeline until Phase 4, so
  `open()` here records the active project and builds the profile, and
  nothing else. `IndexStatus` is therefore absent from the open response.
- **Engineering memory, knowledge graph, context and graphify routes are
  absent.** They belong to Phase 4.
- **`memory.search`'s executor filters by substring**, matching the
  reference's executor — which is *not* the same as `ProjectMemory.recall`'s
  keyword-overlap ranking. Both are ported; the executor uses the one the
  reference's executor uses.
- Windows remains BUILT, not RUNTIME VERIFIED.

---

## 8. Files created

```
backend/src/aura_backend/workspace/{__init__,projects,profile,memory,
                                    conversations,manager}.py
backend/src/aura_backend/tools/internal_executors.py
backend/src/aura_backend/api/routes/projects.py
backend/parity/{profile_oracle.ts,profile_parity.py}
backend/tests/{test_workspace_negative_controls,test_profile_parity}.py
docs/PHASE_03_WORKSPACE.md
```

Modified: `api/app.py` (workspace in the composition root),
`api/routes/fabric.py` (`cwd` resolved from the registry),
`verify/reference_suites.py` (registers the project; corrected
explanation), `verify/fabric_runtime.py` (supported set now 18).
