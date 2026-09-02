# Workflow Resume Semantics

> **Status:** audited, decision made, accidental part fixed. Written after
> frontend verification observed that approving a parked agent produces a
> *second* run while the first stays `awaiting-approval`.

## What was observed

```
run A            state = awaiting-approval
  ↓ human approves
run B            trigger = { kind: 'resume', of: A }
run A            state = awaiting-approval   ← unchanged, forever
```

Two questions fell out of that, and they have different answers.

1. **Is a resume a new run?** — Yes, deliberately.
2. **Should the original stay `awaiting-approval` afterwards?** — No. That
   was an accident, and it is the part that was wrong.

## Decision: (A) linked runs, made explicit

A resume creates a new `WorkflowRun` linked to the one it continues. That
is the intended model, for four reasons that are properties of the existing
architecture rather than preferences:

- **A run executes one version.** `versionId` is fixed at creation and the
  whole point of versioning is that a finished run's record still describes
  what actually executed. A run that could be re-entered days later, under
  a different policy and a different environment, would be one record
  describing two different executions.
- **A run has one wall clock.** `startedAt`, `finishedAt` and `ms` are
  single-valued. Re-entering a record would make `ms` meaningless — it
  would silently include however long a human took to answer.
- **Audit is partitioned by `runId`.** Every `AuditRecord` the Fabric writes
  carries the run it belongs to. Two legs with one id would make "what did
  this run do" unanswerable without also knowing when to stop counting.
- **The checkpoint is the record.** Resume works by *replaying* completed
  nodes out of the previous run's checkpoint. Writing the new leg's results
  into that same record would overwrite the thing being replayed from.

So: **one logical execution, one or more runs, explicitly chained.**

## The accident, and the fix

Leaving the original at `awaiting-approval` after it had been superseded
asserted something false. The original was not awaiting anything — its
question had been answered and its work had been picked up elsewhere. Three
things went wrong downstream:

- the approvals inbox (`listAwaitingApproval`) kept showing it;
- `resumable` stayed `true`, so the same parked run could be resumed
  repeatedly, minting a new run each time (each subsequent one failing, as
  the approval is single-use — but the button kept working);
- the Runs list showed a permanently-pending row for finished work.

**Fix:** when a resume is created, the original is stamped
`supersededBy` / `supersededAt`, `resumable` becomes `false`, and
`notResumableReason` says which run continued it. Its `state` is left
untouched — `awaiting-approval` is still the honest description of *how
that leg ended*, and rewriting history to say otherwise would lose the
reason the chain exists. What changes is that it is no longer *pending*.

No new `RunState` member was added. The state vocabulary is a frontend
contract and this needed no new state — it needed the run to stop claiming
to be actionable.

## The contract

| Field | On | Meaning |
| --- | --- | --- |
| `trigger.kind = 'resume'` | the new run | This run continues another. |
| `trigger.of` | the new run | The run it continues. **Forward link.** |
| `supersededBy` | the original | The run that picked this up. **Back link.** |
| `supersededAt` | the original | When. |
| `resumable` | the original | `false` once superseded. |
| `notResumableReason` | the original | `"continued as run <id>"` |

Both directions are now navigable, which is what a UI needs to render one
logical execution from several records.

### Run ids

Every leg keeps its own `runId`, and that id is what appears in the audit
trail, in `EvidenceRef.invocationId` correlation, and in Fabric approval
keys (`runId:workflowNodeId:capabilityId`). Approval keys are per-leg by
design: the parked leg's question is answered by naming its approval id,
and the resumed leg spends it by fingerprint — see
`docs/AGENT_CONTEXT_PROVENANCE.md` and the argument-binding in `fabric.ts`.

### Evidence

Evidence does **not** move between legs. Each run's `evidence[]` lists the
governed actions *that leg* caused. To see everything one logical execution
did, a reader walks the chain — which is now possible in both directions.
Copying evidence forward would double-count effects in the run index.

### Retry

There is no automatic retry across legs. A resume is always a deliberate
act — a human decision, or an explicit call. The Fabric's own bounded
retry (`MAX_ATTEMPTS`, transient-only) happens *inside* a single
invocation and never creates a leg.

### Cancellation

Cancellation is per-leg, because a controller only exists for a run this
process is executing. Cancelling leg B does not un-supersede leg A: A's
work still happened, and B's record says it was cancelled. The chain is
append-only in the same way the audit trail is.

### Bounds

Agent bounds are carried *across* legs, not reset — iterations continue and
elapsed time is subtracted. A resume is a continuation of one agent
execution, not a fresh one. This is the one place the "logical execution"
view is enforced in the runtime rather than merely represented.

## User-visible meaning

- A parked run reads **"waiting for you"** and offers Approve.
- Once approved and continued, it reads **"continued as …"** and offers no
  action.
- The new run reads **"resumed from …"**.
- A Runs list may collapse a chain into one row; the ids remain distinct
  underneath, and the audit trail is per-leg.

## Invariants

1. A run's `versionId` never changes.
2. A superseded run is never resumable again.
3. Evidence is never copied between legs.
4. Agent bounds are never reset by a resume.
