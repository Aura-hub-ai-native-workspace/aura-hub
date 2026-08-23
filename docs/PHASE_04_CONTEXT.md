# Phase 4 (part 2) — the Context Fabric

**Status: COMPLETE**, with two named divergences that belong to later
phases and are pinned rather than tolerated.
**TypeScript reference:** `packages/ai-service/src/context/types.ts` (294),
`compose.ts` (539), `contract.ts` (269), the `load*` half of
`intelligence/`, `intelligence/changeIntelligence.ts`,
`mission/gitSignals.ts`, and the read half of `mission/store.ts`.
**Python destination:** `backend/src/aura_backend/context/` and
`backend/src/aura_backend/intelligence/`.
**Difficulty: HIGH.**

---

## 1. What this phase is for

One project's understanding, at one moment, in a shape every downstream
surface can consume without re-deriving it — and with the **provenance of
each part attached**.

Two rules carry the whole design:

1. **Unknown is not empty.** A section never computed is `unknown`; a
   section computed and found empty is `fresh` with an empty payload. An
   agent that mistakes "nobody looked" for "there is nothing" is the
   precise failure the three-state model exists to prevent.
2. **Nothing is invented.** Every value is projected from an authority
   that already owns it. Where an authority cannot answer, the field says
   `unknown` and says why.

The Context Fabric is **read-only**. It calls `load_*` and `get_*`, never
`generate_*`, `save_*` or `create_version`, and a negative control
asserts that by walking `compose.py`'s AST rather than its prose.

---

## 2. What was migrated

| TypeScript | Python | Note |
| --- | --- | --- |
| `context/types.ts` | `context/types.py` | Vocabulary only |
| `context/compose.ts` | `context/compose.py` | The façade, nine sections |
| `context/contract.ts` | `context/contract.py` | The agent text contract |
| `intelligence/index.ts` `isCacheStale` | `intelligence/staleness.py` | The **one** staleness rule |
| `intelligence/*` `load*` | `intelligence/artifacts.py` | Readers only — see §3 |
| `intelligence/changeIntelligence.ts` | `intelligence/change.py` | Velocity, hotspots, patterns |
| `mission/gitSignals.ts` | `intelligence/git_signals.py` | Read-only, never raises |
| `mission/store.ts` (read half) | `intelligence/missions.py` | See §3 and §6 |
| `server.ts` context block | `api/routes/context.py` | 2 routes |
| `server.ts` agent-context seam | `api/routes/fabric.py` | See §5 |

Two new single-authority modules came out of the defects in §6:

| Module | Owns |
| --- | --- |
| `core/node_time.py` | What `mtimeMs` means. One definition, four call sites. |
| `core/js_number.py` | How a number becomes text and JSON. |

---

## 3. Two deliberate scope boundaries

**Loaders, not generators.** `compose.ts` only ever *loads*: identity,
module summary, repository profile, health, version. Generation belongs
to `runIntelligencePipeline`, which is the remaining Phase 4 work. Porting
the 561-line identity scan to make a section non-`unknown` would be
inventing understanding the engine has not produced — and the Fabric's own
"unknown is not empty" design already makes a partially-populated fabric
**honest** rather than a lie.

**The mission reader does not hydrate.** The reference reads every mission
through `MissionExecutionEngine.hydrate` + `refreshStatus`, which
synthesizes and recomputes `execution.status`. That derivation is the
engine's, and the engine is Phase 11. Reimplementing it here would create
a **second authority for mission status**, which is exactly what must not
happen. The consequence is measured, bounded and pinned — see §6.3.

---

## 4. Verification

### 4.1 The differential — 20 scenarios, 254 comparisons

`parity/context_parity.py` runs the **real** `composeContextView` and
`renderContextContract` (via `scripts/run-ts.mjs`, no reimplementation)
and the Python port against the **same fixture homes**, then diffs the
composed `ContextView` field by field and the rendered contract **line by
line at all nine surfaces plus an unrecognised one**.

The fixtures exist to reach what a live service cannot be made to produce
on demand: an artifact that is fresh by the clock but stale by the
filesystem; an identity current by timestamp and wrong by fingerprint; a
change log that cannot be attributed to any project; one whose entries
belong to a **sibling directory sharing a path prefix**; a module list
that overflows every surface budget; a version pointer past the end of its
history; corrupt artifacts in every slot; and a limit of zero, which means
"everything" for activity (`slice(-0)`) and "nothing" for missions
(`slice(0, 0)`).

**What is normalized, and what is not.** Four values are wall-clock at
composition and cannot agree between two processes run seconds apart:
`composedAt` and the `generatedAt` of the git, missions and activity
sections. Those four, and nothing else. Every `generatedAt` that comes
from a fixture artifact is compared **exactly** — otherwise a port that
picked the oldest artifact instead of the newest would pass.

**Result: all 254 comparisons match.**

### 4.2 Mutation testing — the harness is shown to bite

A harness that agrees proves nothing until it is shown to disagree.
`verify/context_mutations.py` seeds 19 plausible porting mistakes into the
real source, one at a time, and requires each to be caught: inverted
freshness precedence, a staleness rule that consults the clock but not the
filesystem, `newest` read as oldest, unknown sections omitted, empty
sections rendered, the stale label dropped, truncation that no longer says
how much it dropped, change attribution by bare prefix, AURA's own
subsystems listed as runnable programs, and numbers formatted the Python
way.

The first run caught 15 of 19. **Every survivor was a hole in the
verification, and each one was closed** rather than explained away:

| Survivor | What was missing | Closed by |
| --- | --- | --- |
| staleness ignores the filesystem | no fixture where the repo moved *after* a recent artifact | scenario `touched-after-indexing` |
| newest read as oldest | all four artifacts shared one timestamp | four distinct timestamps, deliberately out of file order |
| `mtimeMs` arithmetic | **the harness computed the fingerprint the same wrong way** | the harness now spells out Node's arithmetic itself; plus `tests/test_node_time_parity.py` |
| per-surface capability budget | the in-process oracle attaches no fabric | routed to the runtime differential — which then **also** missed it, because that verifier strips the `present_but_not_drivable` block before comparing (§4.3). A separate check now asserts the block appears on exactly the two surfaces whose budget declares it. |

Two are worth naming. The third: the fixture builder was reproducing the
port's own mistake, so the two agreed — **a harness that borrows the
implementation's helper cannot test it**. The fourth: closing a
comparison gap by masking a field is itself a way to go blind, and the
masking has to be paired with a check on what was masked.

**Final: 19 of 19 caught.**

### 4.3 The runtime differential — where the fabric actually answers

`verify/context_runtime.py` starts **both backends as real processes** on
ports of their own with isolated homes, registers the same project on
each, scans the machine on each, drives real governed invocations so the
audit trail is not empty, and then diffs `GET /projects/{id}/context` and
`GET /projects/{id}/context/contract` at every surface.

This is the only place `capabilities` and `activity` can be compared for
real: 33 capabilities, each carrying the **policy engine's own decision,
rule name and reason**.

It found a genuine difference on the first run, and it was not a Context
Fabric defect: `mission.inspect`, `mission.approve`, `knowledge.graph` and
`workflow.run` have no executor in the Python backend (recorded in
`PHASE_03_WORKSPACE.md` §3). The verifier now **derives** that gap from
each backend's `/fabric/capabilities` and asserts it equals exactly the
documented set — so a capability that quietly stops working cannot hide
behind the exclusion — then compares everything else.

All checks pass, including: reading context records nothing in the audit
trail, does not mount the project, and no API key from a
`provider.connect` attempt appears in either backend's view or contract.

### 4.4 Negative controls — 33

`tests/test_context_negative_controls.py` (20) and
`tests/test_context_routes.py` (13).

An unregistered project yields `unavailable` with no view to mistake for
an empty one. An unindexed project reports `unknown` **with a reason** in
every section. A corrupt artifact becomes `unknown`, never content. A
missing version history is `null`, never a fabricated 0. A sibling
directory's change history is never claimed. Another project's missions
are never listed. Composing writes no file, touches no file in the project
directory, spawns nothing, and mounts nothing. `compose_context_view`'s
signature takes a project id and nothing else — there is no parameter by
which a caller could name a directory. An unscanned environment reads
`unknown`, not "this machine has no tools". A fabricless service reports
`unknown`, because an absent authority is not an authority saying no.

### 4.5 Full suite

**398 tests pass.** Every earlier parity harness re-run green after the
`mtimeMs` change: policy 329/329, execution 225/225, fabric 44/44,
environment all-match, profiles **5/5 now including the fingerprint**,
retrieval all-match.

---

## 5. Contracts preserved

Two routes, matching `server.ts`:

- `GET /projects/{id}/context?surface=&git=` — the view; **404** with the
  `unavailable` body for an unknown project, never an empty view.
- `GET /projects/{id}/context/contract?surface=&git=` —
  `{projectId, surface, contract}`; 404 likewise.

Only the literal string `false` turns git off, matching the reference's
`!== 'false'`. Context routes are registered before the project routes so
`/projects/{id}/context` cannot be shadowed.

**The agent context seam.** `POST /fabric/invoke` for `agent.delegate`,
within a resolved project, with no `context` key, composes the `coding`
surface contract and supplies it — because delegating to a coding agent
without AURA's context is the thing the Context Fabric exists to fix.
Composition stays on the caller side, with the one Context Fabric; the
executor only consumes. Passing `context: ""` opts out. A context that
cannot be composed degrades to delegating without one — context is an
enrichment, not a gate. Six tests pin each of those.

---

## 6. Defects found, and what they mean

### 6.1 Node's `mtimeMs` is not `st_mtime_ns / 1e6`

Node builds it the way libuv does — `tv_sec * 1000 + tv_nsec / 1e6` — and
that is a **different double** from dividing the nanoseconds once. They
differ by one unit in the last place, and their shortest string forms
differ with it:

```
ns / 1e6                  →  1787501494393.2349
tv_sec * 1000 + ns / 1e6  →  1787501494393.235    ← what Node prints
```

Measured over 200 files: **61 of 200 disagree.**

This is not cosmetic, because the value is **stringified into
fingerprints that are compared for equality**. One ULP is the difference
between "the project is unchanged" and "regenerate everything" — and
between a profile written by the TypeScript backend reading as current
under the Python one or not.

Fixed by `core/node_time.py`, which every mtime in the backend now goes
through. Covered by `tests/test_node_time_parity.py`, which diffs against
the real `fs.statSync().mtimeMs` over 60 files **and asserts the naive
computation still differs**, so the guard cannot quietly become
decoration.

### 6.2 The Phase 3 profile fingerprint was wrong, twice

Chasing 6.1 exposed a latent defect in already-shipped code:
`workspace/profile.py` computed `st_mtime * 1000` — lossy before the
multiplication — and formatted it with `%g`, which is **six significant
digits** (`1.7875e+12`). Neither could ever equal what the reference
writes.

It was invisible because **Phase 3's harness explicitly excluded
`fingerprint`** from comparison, on the reasoning that it "embeds mtimes".
That exclusion was the mistake: the field is compared for equality to
decide whether a cached profile stands. The oracle no longer excludes it,
and all five profiles now match including the fingerprint.

The lesson is recorded here because it generalizes: a field excluded from
a differential because it is *awkward* is precisely where a defect will
sit.

### 6.3 What the reference does with a malformed mission record

Fixtures found three unguarded reads on the hydration path:
`hydrate` reads `record.approval.status`, `statusForTask` reads
`record.taskRuns.find`, and `buildDag` iterates `t.dependencies` — each
without a guard. A record missing any of them throws inside
`MissionStore.list`, and `projectMissions`'s `try/catch` turns that into
**`unknown` for the entire project's missions**.

Recorded, not ported: the Python reader does not throw. Pinned as an
asserted divergence (§7.1) rather than tolerated.

### 6.4 Two serialization differences from JavaScript

- `generatedAt: null` is explicit in the reference and survives
  `JSON.stringify`; only `reason` is `undefined` when fresh and gets
  dropped. The port was compacting both.
- JavaScript has one numeric type, so `JSON.stringify` can never emit
  `41.0` for a whole number read out of an artifact. Python can, and did.
  `core/js_number.py` now normalizes the view payload and every
  fingerprint, so the wire document is **identical**, not merely
  equivalent.

---

## 7. Behavioural differences

### 7.1 Mission status is engine-derived (pinned)

`ContextMission.status` is synthesized by the mission execution engine for
any record without a persisted `execution` block (`approved` when the plan
is approved, else `idle`) and recomputed from checkpoints when execution
is live. The Python reader reports what is on disk, so those records read
`null` → `status=no plan` in the contract.

The harness **masks that one field and compares every other field of
every mission exactly**, and prints what the two said. It is a bounded,
measured difference, not a hand-wave. It resolves when Phase 11 lands the
engine.

The unhydratable-record case (§6.3) is pinned separately in
`EXPECTED_DIVERGENCE`: the harness asserts the difference is **exactly**
what was characterized, and fails if its shape changes.

### 7.2 The Python service does not scan the environment at boot

`server.ts:225` scans the machine **before serving**, with the reason
stated in the source: without it, a restart leaves every node-backed
capability denied as `no-provider` until someone triggers a scan — git
installed and working, and the Fabric still refusing `git.diff`. The
Python composition root has no equivalent, so its node projection is
empty until `POST /environment/scan`.

For the Context Fabric this means a fresh Python service reports
`environment: unknown` where the reference reports it `fresh`. The runtime
differential equalizes it by scanning both explicitly, and says so.

**This is not fixed here on purpose.** It is a service-lifecycle
behaviour belonging to the environment subsystem, and changing process
startup as a side effect of the context phase is the kind of scope drift
this migration is meant to avoid. The fix is one lifespan hook in
`api/app.py` mirroring `server.ts:225`; it is called out here so it is a
decision rather than an oversight.

### 7.3 Whitespace normalization at the edges

`identity.purpose` is collapsed with `\s+` and trimmed. JavaScript's `\s`
and `String.prototype.trim` include `U+FEFF`; Python's do not. A purpose
containing a byte-order mark would render one character differently. No
fixture produces one and no generator writes one.

---

## 8. Security findings

1. **No secret path exists.** The renderer adds no source of data — it can
   only render what `compose.py` projected, and every projection reads
   artifacts, the registry, the audit trail's already-redacted summaries,
   or a probe's `--version` output. The runtime differential proves it
   end to end: after a `provider.connect` carrying
   `sk-live-context-probe`, that string appears in **neither** backend's
   view nor contract.
2. **No environment variable is read.** Asserted directly: a fake secret
   exported into the process appears nowhere in the view or the contract,
   and neither does its name.
3. **A GET cannot spawn a process.** Reading context never triggers a
   scan; `compose.py`'s AST contains no reference to `scan`, `Popen`,
   `subprocess` or `spawn` — the only process it can start is the git
   read, which is bounded, allow-listed and shell-free, and which
   `git=false` turns off entirely.
4. **The agent contract is a governance surface.** It tells a delegated
   agent the project root it may not leave, that high-risk capabilities
   need human approval, that `unknown` means not-established, and — when
   git says the tree is dirty — that the uncommitted work must never be
   reset, cleaned, stashed or discarded. Those constraints are derived
   from observed facts, never from advice: the uncommitted-work warning
   appears only when git actually reports changed files.
5. **No authentication**, unchanged.

---

## 9. Known limitations

- **The intelligence generators are not ported.** Identity, module
  summaries, repository profiles, health and versioning are *read*, not
  produced. On a home where nothing has generated them, `repository` and
  `contextVersion` read `unknown`/`null` — which is the designed
  behaviour, and is why the design has that state at all.
- **Mission status** — §7.1, resolves with Phase 11.
- **No boot scan** — §7.2, a decision left open.
- **`knowledge.graph` and the graphify routes** remain absent; they are
  the remaining Phase 4 work.
- Windows remains BUILT, not RUNTIME VERIFIED.

---

## 10. Files

Created:

```
backend/src/aura_backend/core/{node_time,js_number}.py
backend/src/aura_backend/intelligence/{__init__,staleness,artifacts,
                                       change,git_signals,missions}.py
backend/src/aura_backend/context/{__init__,types,compose,contract}.py
backend/src/aura_backend/api/routes/context.py
backend/parity/{context_oracle.ts,context_scenarios.py,context_parity.py}
backend/verify/{context_runtime.py,context_mutations.py}
backend/tests/{test_context_negative_controls,test_context_routes,
               test_node_time_parity}.py
docs/PHASE_04_CONTEXT.md
```

Modified: `api/app.py` (context routes in the composition root),
`api/routes/fabric.py` (the agent context seam),
`environment/projection.py` (a third projection of the one scan),
`workspace/manager.py` (read-only `current_project_id`),
`workspace/profile.py` and `retrieval/scanner.py` (mtime through
`node_time`), `parity/profile_oracle.ts` and `parity/profile_parity.py`
(the fingerprint is no longer excluded).
