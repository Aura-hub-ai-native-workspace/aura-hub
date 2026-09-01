# Agent UI — what has been verified, and how

> **Scope:** the frontend Agent surface only. No backend file was modified
> to produce anything in this document. No `AgentTrace` was injected, no
> beat was fabricated, and no `NodeRunRecord` was mocked. Every claim below
> was produced by the real service, the real Workflow Engine, the real
> agent runtime and the real Capability Fabric.

Recorded 2026-08-23.

## The provider question, stated precisely

AURA is BYOAK — it ships no model. An agent node therefore needs a
connected provider to do anything beyond opening its ledger.

**On the machine this was verified on, a provider *was* connected**
(`GET /health` → `key.configured: true`, `fingerprint: "Mistral AI"`), so
the full lifecycle was observable and *was* observed. The no-provider path
was verified separately, against a second isolated service started with an
empty `AURA_HOME` and no key — a real keyless service, not a simulated
failure.

Both paths are covered by suites, so neither depends on how the machine
running them happens to be configured:

| Path | Suite | Service |
|---|---|---|
| Provider connected | `scripts/ui-agent-test.mjs` | the developer's, on `:4319` |
| No provider | `scripts/ui-agent-noprovider-test.mjs` | one it starts itself, keyless, on `:4320` |

## Full lifecycle — observed, with a provider connected

One run, one approval, one resume, against a disposable git repository:

| Stage | Observed | Evidence |
|---|---|---|
| `intent` | yes | leg A, live on the stream and in the persisted trace |
| `plan` | yes | leg A |
| `proposal` | yes | leg A — `filesystem.write` with concrete arguments |
| `permission` | yes | leg A — the Fabric's `ask-user` decision and its rule |
| approval (`intervention`) | yes | a real `apr-…` request, granted through the existing `ApprovalGate` |
| `execution` | yes | leg B, carrying `evidence.invocationId` |
| `observation` | yes | leg B, `untrusted: true` |
| `decision` | yes | seen on a separate tool-free run (`intent → plan → decision → result`) |
| `result` | yes | both legs |
| persisted trace | yes | `partial: false`, `stopReason`, `effectiveBounds`, `evidence` |
| RunView | yes | asserted against the same run's persisted record |

Side effects were real: `lifecycle.txt` was written to the sandbox, the
audit trail recorded the invocation, and the execution spanned a two-leg
resume chain.

**So full-lifecycle UI verification is *not* currently blocked here.** It
would be blocked on a machine with no provider connected, and that is the
only thing that blocks it — every other contract the lifecycle needs is
live and consumed.

## No provider — observed, on a real keyless service

The service reaches the agent runtime and produces real beats before it
stops:

```
[0] intent/system  Summarise this repository in one sentence.
[1] result/system  The AI provider rejected the request (no_provider):
                   No AI provider connected. Add your API key in Settings…
```

and persists a real, finished ledger:

- `partial: false`, `stopReason: 'failed'`, `port: 'failed'`
- `effectiveBounds` recorded (the clamped values the runtime enforced)
- `evidence: []`, `refusedTools: []` — nothing ran, so nothing is cited
- `resumable: false`, `notResumableReason: "No node completed, so there is
  no checkpoint to resume from."`

The UI renders that honestly with no special-casing: the failure notice
carries the provider's own words including where to fix it, the ledger
shows both real beats, the stop reason is stated rather than hidden, and
the bounds the run executed under are shown.

### The one thing added for this path

`AgentNodePanel` now warns *before* a run that no provider is connected,
read from `GET /health` `key.configured`. It is deliberately **not**
inferred from a failed run, and `null` (service unreachable, or not yet
asked) stays silent rather than guessing — unreachable is not the same as
unconfigured. The complement is asserted in `ui-workflow-test.mjs`: with a
provider connected the notice must be **absent**, or it would be permanent
noise on a working install.

## Trace states — all three handled

| State | Shape | Rendered as | Observed |
|---|---|---|---|
| none | `agentTrace` undefined | "No trace to show" — never an example run | yes |
| partial | `{ beats, partial: true }` | `PartialTrace` — beats, and an explicit "not a verdict" | yes — 16 consecutive mid-run snapshots |
| final | full `AgentTrace` | `FinishedTrace` — bounds, stop reason, evidence, output | yes |

`AgentTrace` and `PartialAgentTrace` are separate members of a union, so
reading a verdict off a snapshot does not compile. This was a real defect:
the previous narrowing required `effectiveBounds` and `stopReason` and
therefore rejected every partial trace, meaning anyone who opened a
*running* agent saw no ledger at all.

An empty ledger (`beats: []` on a finished trace) renders "No reasoning
recorded yet." That path is **code-only** — the runtime always emits at
least an `intent`, so it has not been observed and is not claimed as such.

## Live SSE rendering

Verified against real streams on both services:

- `RunEvent` `{ type: 'agent', nodeId, runId, beat }` reaches the UI
- every live beat reappears in the persisted ledger at the same `seq`, and
  is byte-identical to it
- `seq` ascends strictly, including across a resume
- beats are folded by `seq` (`foldBeat` in `useWorkflows.ts`), so a
  duplicate from a reconnect replaces rather than doubles, and an
  out-of-order arrival sorts back into place
- the persisted trace remains authoritative; the stream is an early view

## Approval and resume

Verified against real approvals and real resume chains:

- a parked agent raises a real Fabric approval, decided through the
  existing `ApprovalGate` — there is no second approval system
- the approval is spent by fingerprint across legs, so a resumed leg uses
  the grant the person actually gave
- a superseded leg is marked `supersededBy` / `supersededAt`,
  `resumable: false`, and leaves the "waiting for you" list while keeping
  its `awaiting-approval` state
- `GET /workflows/:id/runs/:runId/chain` renders as one execution across
  several records, navigable from either end

## Not observed, and not claimed

- `consecutive-failures`, `denied` and `cancelled` stop reasons. They
  render from the same typed path as the six that were exercised, but
  reproducing them needs a policy override written to the user's own
  configuration, or model scripting.
- An empty (`beats: []`) finished ledger — see above.
- A provider that connects but then fails mid-run. Distinct from
  `no_provider`, and not reproduced.
