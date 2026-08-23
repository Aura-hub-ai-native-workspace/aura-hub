# Phase 7 — Capability Fabric, policy and approvals

**Status: COMPLETE.**
**TypeScript reference:** `packages/capability-fabric/src/` (fabric 793,
types 539, manifest 391, policy 332) and `packages/ai-service/src/fabric/`
(index 193, scopes 115, auditStore 98, approvalStore 48, policyStore 45).
**Python destination:** `backend/src/aura_backend/fabric/`.
**Difficulty: CRITICAL. The highest-risk migration in the project.**

Executors are deliberately **not** in this phase. The reference draws the
same line: `packages/capability-fabric` contains no executors at all, and
`fabric/executors.ts` is host wiring. They arrive in Phase 8.

---

## 1. What was migrated

| TypeScript | Python | Responsibility |
| --- | --- | --- |
| `capability-fabric/types.ts` | `fabric/types.py` | The domain vocabulary, plus JSON serialization that matches the reference field-for-field. |
| `capability-fabric/manifest.ts` | `fabric/manifest.py` | **33 capabilities**, verbatim. |
| `capability-fabric/fabric.ts` | `fabric/fabric.py` | The seven-stage pipeline, approvals, retry, verification, audit. |
| `ai-service/fabric/index.ts` | `fabric/routing.py`, `fabric/host.py` | Node routing and the four host decisions. |
| `ai-service/fabric/scopes.ts` | `fabric/scopes.py` | Per-run least privilege. Narrowing only. |
| `ai-service/fabric/{policy,approval,audit}Store.ts` | `fabric/stores.py` | Durable policy, pending approvals, append-only JSONL audit. |
| `server.ts` `/fabric/*` | `api/routes/fabric.py` | Six routes, contract-compatible. |

**The manifest has 33 capabilities, not 30.** The Phase 0 audit reported
30; the differential harness settled it by comparing the whole manifest
entry-by-entry against the reference. 14 internal, 12 local, 7 extension
points. That is the kind of error a summary makes and a diff catches.

### The pipeline, reproduced exactly

```
0. unknown capability      → settle(failed, 'unknown-capability')
1. contract validation     → settle(failed, 'invalid-input')
2. node routing            → settle(denied, rule = resolution.code)
3. policy                  → settle(denied)
4. approval                → settle(awaiting-approval)
5. execute (+ bounded retry)
6. verify
7. audit
```

`_settle()` is the single exit and `_record()` the single audit writer, so
persistence cannot be added on one path and forgotten on another.

Retry: `MAX_ATTEMPTS = 3`, `BASE_BACKOFF_MS = 400`, exponential, and only
when the detail matches the transient pattern. Retrying a permission error
three times is noise, not resilience.

### Properties preserved, and why each matters

- **Approval keying** collapses repeated asks: `missionId:taskId:capability`
  → `runId:workflowNodeId:capability` → `inv:invocationId`. Pressing Run
  three times on a gated task asks **one** question.
- **A grant is single-use.** `consumed_at` stamps the spend; a second
  attempt finds nothing. A refresh, a reconnect or a replayed request
  cannot re-authorize an action that already ran.
- **Only pending approvals survive a restart.** An unspent grant is
  deliberately dropped — reinstating it would mean a restart silently
  re-authorizing an action whose user is no longer there to see it happen.
- **The audit trail restores everything.** A record is a statement about
  the past; dropping it would not be cautious, it would be forgetful.
- **`executed_node_id` means EXECUTED.** A denied call resolves a node and
  never runs on it, so `attempts > 0` gates the fallback. A capability with
  no `requires_node_capability` never claims a node at all — `system.install`
  is why: its output names the node being *installed*, the object of the
  work, not the actor.
- **An unregistered run gets nothing, not the ceiling.** "I do not know
  what this is allowed to do" means "nothing".
- **Human-only scopes** (`account.authorize`, `resource.destroy`,
  `system.modify`) are ungrantable by any flag, at any level.
- **A failing audit store never fails an action.** A lost write beats a
  lost effect.

---

## 2. The bug the fabric harness found in Phase 5's work

The first fabric parity run reported **51 differences**. Every one was the
same field: `reason`.

In Phase 5 I built the policy differential harness to compare `decision`
and `rule`, and wrote in the oracle that `reason` was excluded because it
is "user-facing prose… holding two implementations to identical English
would make the check about wording rather than about governance."

That was wrong, and this phase is where it surfaced. `evaluation.reason`
becomes `ApprovalRequest.summary` — **it is the sentence a person reads
when deciding whether to authorize an irreversible action.** The Python
engine was emitting "This cannot be undone from here." where the reference
emits "Delegate to coding agent cannot be undone from here, so it always
needs your explicit go-ahead."

The fix was structural rather than cosmetic:

- `PolicySubject` now carries `capability_name` and `node_name`, because
  the reference's prose interpolates both.
- The risk-default seed carries **no** reason and falls through to
  `reason_for(decision, name)` at the end — which is how the reference
  produces "Read file is low risk and reversible, so it runs without
  interrupting you." for a rule labelled `risk-default:low`.
- Every floor, node-override and allow-list reason now matches verbatim.
- **The policy harness now compares `reason`**, and still passes 329/329.

The lesson is recorded rather than quietly fixed: a differential harness
that excludes a field cannot find bugs in it, and "it's only wording" is
exactly the argument that lets a user-facing regression through.

---

## 3. Verification

### Differential — 44/44 scenarios, 192 compared values, 0 differences

`backend/parity/fabric_parity.py` bundles the **real** `capability-fabric`
package from source with esbuild and runs identical scripted scenarios
through both implementations. The fabric is pure domain with injected host
ports, which is what makes this a genuine comparison: the host, the nodes,
the policy and the executors are all described in JSON, so both sides see
the same inputs and the same executor behaviour.

Compared per scenario: every step's outcome, detail, rule, decision, risk,
reason, attempts, verification report and output; the **event type
sequence**; and the **entire audit trail** record by record.

Coverage (`parity/fabric_scenarios.py`, readable as a list of claims):
the full manifest; contract validation including type errors; all five
routing denial codes; catalogue-order tie-break; requested-node refusal
without substitution; every policy floor against a fully permissive
config; deny-beats-floor; allow-list denial; narrowed run scope;
park/grant/run; one-question-per-task; workflow-node keying; decline;
double-decide; inline grant; grant-does-not-cover-the-next-capability;
single-use grant (twice, once through the gate and once directly);
secret redaction; unsupported capability; transient vs non-transient
retry; throwing executor; verification pass/fail/throw/declared-but-
unimplemented/none; four attribution cases; pre-flight `evaluate`
agreement; internal capabilities; and the HTTP surface capability.

**Mutation-tested — and the first attempt exposed a gap in the harness.**

| Mutation | Caught? |
| --- | --- |
| A denied call reports the resolved node as executed | 19 differences |
| A nodeless capability's output becomes attribution | 1 difference |
| The single-use guard is removed from `consume_approval` | **NOT CAUGHT** |

The third mutation was invisible because the guard is duplicated in the
caller (`_gate` checks `consumed_at` before calling), so removing one of
the two changed nothing observable. That is correct defence in depth — and
a harness that only reaches the property through the gate cannot tell.
A scenario that decides a request and then tries to spend it **twice
directly** was added; the mutation is now caught, and all 44 pass clean.

### Runtime — 21/21 checks against a real service

`backend/verify/fabric_runtime.py` starts the actual backend as a real
process on a real port, drives it over HTTP, **restarts it mid-suite**,
and checks what survived:

- The whole 33-capability manifest is served, with `supportedCount: 0` —
  nothing claims an executor it does not have.
- A denial is **HTTP 200** with a governance outcome, not a transport
  error.
- A floor set to `auto-execute` over HTTP still parks at
  `authorization-floor`.
- A live API key is absent from the approvals surface, the audit surface,
  **and the file on disk**, with `<redacted>` visibly in its place.
- Unknown approval → 404; decide → 200; decide again → **409**, not a
  second authorization.
- Across a restart: the audit trail survives with the human decision in
  it, the decided request does not come back as pending, and the persisted
  policy is reloaded with its floor intact.
- An invented capability is refused by name; a missing `capabilityId` is a
  400; an unknown policy key is dropped rather than merged.

### Negative controls — 36/36

`tests/test_fabric_negative_controls.py`. These cover what the
differential harness structurally cannot: the host-side stores, which live
outside the reference's pure-domain package and so have no oracle.

Highlights: a gated, denied or invalid call never reaches its executor
(asserted by a recording executor, not by the outcome alone); a throwing
host is a refusal; only pending approvals survive a restart and an
unspent grant written by a dead process is dropped on reattach; the audit
file is append-only with **no save-all API to rewrite it with**; a
truncated final line costs one record, not the trail; trimming drops the
oldest and keeps the newest; a failing audit store does not fail the
action; a corrupt policy file degrades to the shipped default; and every
high-risk capability in the manifest reaches a human or is denied under
the default policy.

---

## 4. Contracts preserved

Six routes, matching `server.ts`:

| Route | Note |
| --- | --- |
| `GET /fabric/capabilities` | manifest + `supported` flag + `supportedCount` + `providedNodeCapabilities` + policy |
| `GET /fabric/audit` | the trail |
| `POST /fabric/policy` | **field allow-list merge** — an unknown key can never become configuration |
| `GET /fabric/approvals` | pending only |
| `POST /fabric/approvals/{id}/decide` | 404 unknown · **409 already decided** · 200 |
| `POST /fabric/invoke` | **always 200**; a denial is an outcome |

`cwd` is not accepted from the request body at all — the reference
resolves it from the project registry, which arrives in Phase 3. `nodeId`
is accepted from `context.nodeId` or, as a compatibility alias, the input
position, because dropping the alias would mean a caller who named a node
silently got a different one.

Timestamps are emitted in JavaScript's `toISOString()` shape
(`…T…:…:…​.mmmZ`, not `+00:00`), because the frontend parses them and the
audit trail is compared against the TypeScript backend's.

---

## 5. Behavioral differences

| # | Difference | Rationale | Risk |
| --- | --- | --- | --- |
| 1 | Fabric events carry ids in their payload rather than whole `Invocation` / `ApprovalRequest` objects. | **Nothing in the reference subscribes to fabric events** — verified by search across `packages/ai-service/src` and `apps/desktop/src`. The event *type sequence* is differentially verified and matches exactly. Event payload shapes are owned by Phase 12. | Low — unobserved surface. |
| 2 | `POST /fabric/approvals/{id}/decide` returns `resumed: false` and does not resume parked work. | The mission and workflow engines that own resumption arrive in Phases 9–11. The reference resumes a mission task here. | **Documented gap, not a design change** — must be closed in Phase 9. |
| 3 | `GET /fabric/mission/{projectId}/{missionId}` is not implemented. | It depends on `missionCapabilities.ts`, which is mission-domain and belongs with Phase 9. | Low — additive route, no behaviour changed. |

---

## 6. Security findings

Carried forward, not silently fixed:

1. **No authentication on any route**, unchanged from the reference. The
   boundary remains loopback binding plus origin allow-list.
2. **`missionCapabilities.ts` is not yet ported**, so the deterministic
   task→capability binding and the `unbound` refusal for
   `manual-operation` are absent. Nothing depends on them yet; Phase 9
   must not skip them, because "refuse to synthesise a command line" is a
   security property, not a convenience.
3. **The node projections are empty until Phase 8.** The consequence is
   safe by construction — every node-backed capability is denied with
   `no-provider` rather than allowed — and is asserted by runtime check 2.

---

## 7. Known limitations

- **No executors.** Every capability reports `unsupported` at call time.
  That is the reference's own honesty mechanism, not a stub.
- **`nodeAvailable`-only hosts are untested.** The reference supports a
  host that omits `resolveNode`; the Python port implements the branch but
  no scenario exercises it, because the service always supplies routing.
  Recorded rather than claimed.
- **Concurrency is untested.** The reference is single-threaded JavaScript;
  the Python fabric is `async` and could see interleaved invocations. The
  approval map and audit list are plain structures with no lock. Under
  `asyncio` on one event loop there is no pre-emption inside the
  synchronous sections that mutate them, so this is safe today — but it is
  an assumption, not a proof, and it must be re-examined if the fabric is
  ever driven from a thread pool. **Flagged for Phase 15.**

---

## 8. Files created

```
backend/src/aura_backend/fabric/{__init__,types,manifest,routing,scopes,
                                 host,fabric,stores}.py
backend/src/aura_backend/api/routes/{__init__,fabric}.py
backend/parity/{fabric_oracle.mjs,fabric_parity.py,fabric_scenarios.py}
backend/verify/fabric_runtime.py
backend/tests/{test_fabric_negative_controls,test_fabric_parity}.py
docs/PHASE_07_FABRIC.md
```

Modified: `policy/{engine,types}.py` (reason prose), `api/app.py`
(composition root), `parity/{policy_oracle.ts,policy_parity.py}` (compare
`reason`).
