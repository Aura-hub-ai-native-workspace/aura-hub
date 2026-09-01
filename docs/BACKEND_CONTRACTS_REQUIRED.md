# Backend contracts the Workflow UI needs

Status: **open requests to the Backend Builder**, written after the
Workflow Automation frontend was built against the service as it stands.

Nothing in the UI fakes a contract. Where one is missing, the affected
surface says so in plain language rather than rendering a convincing
blank. This file lists only what is *still* missing — the large gaps that
existed when this work started (run persistence, versioning, the authority
envelope, Fabric-governed nodes, the agent loop) have since landed and the
frontend consumes them directly.

**Two more closed on 2026-08-23**: the live agent beat channel (§15) and
resume chaining (§16). Both are kept in this file rather than deleted,
because what they now say is what the frontend relies on — and because §15
records a defect the frontend predicted from the source, then confirmed
against a real run, and the service then fixed. §14 is the one request
still outstanding.


## Already delivered, and consumed

| Contract | Route | Consumed by |
|---|---|---|
| Automation rules | `GET/POST/PUT/PATCH/DELETE /automation/rules[/:id]` | `AutomationLibrary.tsx`, `RuleBuilder.tsx` |
| Rule execution | `POST /automation/rules/:id/run\|pause\|resume` | `useAutomation`, rule cards, `RunNowDialog.tsx` |
| Automation runs | `GET /automation/rules/:id/runs[/:runId]`, `.../cancel` | `AutomationRunView.tsx` |
| Live engine events | `GET /automation/events/stream` | `useAutomation.watch()` |
| `run-workflow` bridge | action handler → `WorkflowRunner` | the rule → workflow → Fabric chain |
| Schedule trigger + scheduler | `schedule` trigger, `GET /automation/schedules`, schedule folded into `GET /automation/rules` | rule cards' next fire, `RuleBuilder` cron field |
| Workflow dry run | `POST /workflows/:id/dry-run` | `DryRunReport.tsx`, editor Preview tab, `RuleDryRun.tsx` |
| Workflow validation | `GET /workflows/:id/validate` | dry-run findings |
| Structured produced link | `ActionRunState.produced`, `AutomationRun.produced` | `AutomationRunView`, `AllAutomationRuns` |
| Cross-rule run index | `GET /automation/runs` (+ `/stats`, `/reindex`) | `AllAutomationRuns.tsx` |
| Server-side rule validation | `POST /automation/validate` | `RuleBuilder` — the service's verdict on a refused save |
| Authority envelope + version diff | `GET /workflows/:id/envelope` | `PermissionEnvelope.tsx`, library cards, agent tool scoping |
| Version history | `GET/POST /workflows/:id/versions`, `.../:v/restore` | `WorkflowVersions.tsx` |
| Persisted runs | `GET /workflows/:id/runs`, `.../:runId` | `RunHistory.tsx`, `AllRuns.tsx`, `RunView.tsx` |
| Cancel / resume | `POST .../:runId/cancel`, `.../:runId/resume` | `useWorkflows.stopRun` / `.resumeRun` |
| Evidence references | `WorkflowRun.evidence`, `NodeRunRecord.evidence` | `RunView` Evidence tab |
| Unflattened node states | `awaiting-approval`, `denied`, `cancelled`, `timed-out` | `RunView` step rows |
| Approvals | `GET /fabric/approvals`, `POST .../decide` | `ApprovalsInbox.tsx`, `RunView`, `AgentTrace` |
| Agent bounds + trace | `workflow/agent/types.ts` | `agent/AgentContractPanel.tsx`, `agent/AgentTrace.tsx` |
| Live agent beats | `RunEvent` `{ type: 'agent', beat }` | `useWorkflows.foldBeat`, `runs.ts`, `AgentTrace` |
| Mid-run partial ledger | `NodeRunRecord.agentTrace.partial` | `PartialAgentTrace`, `RunView.asAgentTrace` |
| Resume chain | `supersededBy`/`supersededAt`, `GET .../runs/:runId/chain` | `runs.ts isPending`, `RunView` chain strip, `RunHistory`, `AllRuns` |


---

## §1 — Node specs should declare their effect

**Today.** `NodeSpecInfo` carries `type`, `label`, `category`,
`description`, `inputs`, `outputs`, `disabled`, `fields`. The authority
envelope answers *what a node is permitted to do*, but nothing tells the
inspector *what a node does in plain language*, or whether it needs the
network.

**Consequence.** `screens/workflows/effects.ts` keeps a small table of
one-sentence effect descriptions and a `needsNetwork` flag, maintained by
reading `workflow/nodes.ts`. Capability and risk are **not** in that table
— those come from the envelope — so the drift risk is limited to wording.

**Request.** Add to `NodeSpecInfo`, served from `nodeSpecInfos()`:

```ts
/** One sentence, present tense: what it does when it runs. */
effect: string;
needsNetwork: boolean;
needsProject: boolean;
```

`nodeEffect()` already prefers served values over its table, so shipping
this makes the local table a fallback rather than requiring a UI change.

---

## §2 — Field specs should declare `required`

**Today.** Required-ness is expressed only as a `throw new Error('no …
configured')` inside a node's `run`, so the editor cannot tell a user a
field is required until the run fails on it.

**Consequence.** `validation.ts` holds a `REQUIRED_FIELDS` table derived
from those guards.

**Request.** `FieldSpec.required?: boolean`.

---

## §3 — A cross-workflow runs index

**Today.** Runs are indexed per workflow (`GET /workflows/:id/runs`).

**Consequence.** `AllRuns.tsx` flattens the per-workflow summaries the
store has already fetched. It covers the workflows currently in the
library and says so; runs belonging to a deleted workflow are not listed.

**Request.** `GET /workflows/runs?limit=&outcome=&projectId=&since=`
returning `{ runs: WorkflowRunSummary[] }` across all workflows, so the
Runs surface is a real index rather than a client-side merge.

---

## §4 — Enable / disable a workflow

**Today.** A workflow has no enabled flag. A webhook token, once issued,
is live until rotated, and there is no way to park a workflow.

**Consequence.** The library offers no enable/disable control. The control
is absent rather than fake.

**Request.** `enabled: boolean` on `Workflow` and `WorkflowSummary`,
honoured by the webhook trigger route and by any future scheduler.

---

## §5 — Schedule triggers — delivered for rules, open for workflows

**Landed.** The Automation Engine now has a `schedule` trigger with a real
cron parser and a scheduler that computes `nextFireAt`, counts fires missed
while AURA was closed, and reports a cron that stopped parsing. The rules
library reads that state; it never parses cron itself.

**Still open.** A workflow has no schedule of its own — only a rule can put
one on a clock, by naming the workflow in a `run-workflow` step. That is a
reasonable composition and may be the right permanent answer; if a workflow
should be directly schedulable, it needs `enabled` (§4) first, so there is
something to arm and disarm.

---

## §6 — Workflow dry run — delivered

**Landed.** `POST /workflows/:id/dry-run` returns an ordered plan with
per-step `reachability` (`certain` / `conditional` / `unreachable`), the
Fabric's pre-flight `PolicyEvaluation` per governed step, the approvals a
real run would raise, the denials that would stop it, `wouldRunUnattended`,
`offlineCapable`, secrets required and missing, least-privilege grants, and
`sideEffects: { invocations: 0, policyEvaluations, note }`.

The UI renders it verbatim: `reachability` becomes KNOWN / CONDITIONAL /
UNKNOWN, and the inertness claim shown to the user is the service's own
`note` string rather than a promise the renderer makes on its own
authority. Inertness is verified by measurement — the suite asserts the
Fabric audit trail and the workflow run list do not grow while previews
run.

**Nothing outstanding.**

---

## §7 — Per-step resolved input

**Today.** `NodeRunRecord.output` carries the bounded checkpoint payload,
which is what a resume needs. There is no record of the merged *input* a
node actually received.

**Consequence.** The Run view can show what a step produced but not what
it was given, so "why did this node get the wrong input" is still answered
by reading upstream outputs and inferring.

**Request.** A bounded, redacted `input` alongside `output` on
`NodeRunRecord`, under the same `MAX_CHECKPOINT_TEXT` cap.

---

## §8 — Token and cost accounting on model nodes

**Today.** Model nodes report duration only. `AgentTrace` carries
`tokensUsed`, but ordinary `groq` / `generate-*` nodes do not.

**Consequence.** The run view reports milliseconds. The research's finding
that provider latency and cost dominate an AI workflow is not visible
where it would change a user's decisions.

**Request.** `tokens?: { prompt: number; completion: number }` and
`cost?: number | null` on `NodeRunRecord` (null for a local model, which
genuinely costs nothing per call — and is a differentiator worth showing).

---

## §9 — The agent node — enabled, and consumed

**Observed on the running service**, not assumed: `GET /workflows/specs`
returns the `agent` spec with `disabled` absent, and a real run through
the real engine produced a real `AgentTrace` on the run record.

| Contract | Route / field | Consumed by |
|---|---|---|
| Availability | `NodeSpecInfo.disabled` | the panel's badge and the palette — read, never hardcoded either way |
| Defaults / ceilings | `GET /agent/bounds` | per-field ceiling; a configured value above it is marked with the value the runtime would use |
| Tool scoping | `GET /agent/tools?workflowId=&requested=` | the allowlist and every refusal with the service's own reason |
| `effectiveBounds` | on `AgentTrace` | the meters read the enforced bounds, not the configuration |
| `tokenSource` | on `AgentTrace` | the token count is labelled measured / estimated / part-estimated |
| `inputProvenance`, `taskWasQuarantined` | on `AgentTrace` | states when the agent was asked to *summarise* its input rather than follow it |
| `resume` | on `AgentTrace` | the parked call, its arguments, iteration, tokens and elapsed time |
| stop reasons | `AgentStopReason` | nine endings, each with its own sentence and port |
| `agentTrace` | on `NodeRunRecord` | narrowed once and rendered inside the existing `RunView` step |

**Still missing:** the live beat channel (§15). Everything else the UI
needs for the agent is served.

## §10 — Smaller notes

| Gap | Effect on the UI |
|---|---|
| `WorkflowSummary` carries no envelope summary | The library hydrates definitions and envelopes with a capped fan-out (`useWorkflows.hydrate`). A `permissionSummary` on the summary would remove N requests per library load. |
| No `runId` on the webhook trigger response | A webhook-triggered run cannot be linked to from whatever fired it. |

---

## §11 — An automation action links to what it started — delivered

**Landed.** `ActionRunState.produced` is a discriminated `ProducedRef`
carrying `kind`, `workflowId`, `runId` and the run's own `state`;
`AutomationRun.produced` and the index rows roll it up.

**Consumed.** `producedWorkflowRun()` reads the field. The regular
expression that recovered the id from the action's summary sentence has
been **removed** — `workflowRunIdFrom` no longer exists, and no summary
string is parsed anywhere in the desktop app. Summaries are display text
only.

**Nothing outstanding.** The deprecated `workflowRunId` /
`workflowRunState` mirrors are not read by this client.

---

## §12 — Schedule state is per-rule, not on the summary

**Landed.** `GET /automation/schedules` returns the scheduler's own state
keyed by rule id — `nextFireAt`, `lastFiredAt`, `missedCount`, and an
`error` when a cron stops parsing. The rules library reads it and shows a
real next fire; event-triggered rules still say `no scheduled time`,
because for them that is true.

**Also landed.** `GET /automation/rules` now folds the scheduler's state
into a `schedule` rule's summary — `cron`, `scheduleProjectId`, and
`schedule: { nextFireAt, missedCount, lastFiredAt, error, description,
timezone: 'local' }`. The library reads it from there and keeps
`/automation/schedules` only as a fallback.

**Timezone.** The service states `timezone: 'local'` explicitly: cron is
evaluated against the machine's clock. The builder therefore offers **no
timezone control**, because offering one the scheduler ignores would be
worse than not offering it. If schedules should be timezone-aware, the
trigger needs `timezone?: string` and the scheduler needs to honour it —
until then the UI does not invent a value.

---

## §13 — A cross-rule automation runs index — delivered

**Landed.** `GET /automation/runs` filters by `ruleId`, `projectId`,
`status`, `trigger`, `workflowId`, free-text `q`, `since` and `until`, and
pages with `limit` / `offset`, returning `{ runs, total, offset, limit }`.
`/automation/runs/stats` and `/automation/runs/reindex` exist alongside it.

**Consumed.** `AllAutomationRuns.tsx`. The client-side merge of per-rule
lists is gone: search, filtering and paging are all the service's, so the
browser can no longer disagree with the index.

**Nothing outstanding.**

---

## §14 — A rule-level dry run — still missing

**Today.** `POST /automation/rules/:id/dry-run` returns 404.
`POST /automation/rules/:id/run` remains a **real** run.

**Consequence.** `RuleDryRun.tsx` composes a preview from the contracts
that do exist, and marks the rest UNKNOWN with the reason:

| Beat | Certainty | Source |
|---|---|---|
| Trigger | KNOWN | the rule |
| Conditions | **UNKNOWN** | no contract evaluates them without an event |
| Each `run-workflow` step | KNOWN / CONDITIONAL | `POST /workflows/:id/dry-run` |
| Capabilities · policy · approvals | KNOWN | that dry run's plan |
| Any other action type | **UNKNOWN** | no dry run exists for it |

Conditions are the important gap. Evaluating them in the browser would be
a second engine, so the UI says so in those words rather than guessing.

**Request.** `POST /automation/rules/:id/dry-run` taking a candidate event
payload and returning: each condition with `passed` and a note, the chain
that would then run, and for a `run-workflow` step the workflow dry-run
report (or a reference to it). Plus a per-action-type dry run for
`run-diagnosis`, `run-governance-audit`, `run-security-review`,
`run-docs-review`, `update-knowledge` and `save-memory` — today none of
them can be previewed at all.

The `RunNowDialog` already collects a payload and is the natural place for
a "Preview instead" button beside the real one.

---

## §15 — A live agent beat channel — delivered, and consumed

**Status: shipped by the service and read by the frontend.** Verified
against the running service on 2026-08-23, not inferred from the source.

### What the service now does

`RunEvent` has an `agent` variant:

```ts
| { type: 'agent'; nodeId: string; runId?: string; beat: AgentBeat }
```

emitted from `engine.ts` through the run stream the engine already owns —
one channel, one format. The payload **is** the beat that lands in the
persisted `AgentTrace`: same `seq`, same redaction, same `untrusted` flag.

Observed on a real run: four `agent` events (`intent`, `plan`, `decision`,
`result`), each naming its node and its run, with strictly ascending `seq`,
and each byte-identical to its twin in the persisted ledger.

### The mid-run snapshot, which mattered more than expected

While the agent is thinking, the service checkpoints the beats so far onto
the run record as a **partial** trace — `{ beats, partial: true }`, and
nothing else: no stop reason, no effective bounds, no evidence, no output,
because none of them are known yet. That is what lets a client that never
connected, or that dropped and came back, see the reasoning in progress
instead of a blank space until the node ends.

Observed: sixteen consecutive snapshots of one running agent, beats growing
1 → 7, every one with `stopReason === undefined` and no `effectiveBounds`;
the finished record then cleared `partial` and carried both.

**This is a distinct type in the frontend, deliberately.** `AgentTrace`
and `PartialAgentTrace` are separate members of a union, so reading a
verdict off a snapshot does not compile. The previous narrowing in
`RunView.tsx` required `effectiveBounds` and `stopReason` and therefore
rejected *every* partial trace — a reader who opened a running agent saw
no ledger at all. That is fixed.

### The `seq` collision — fixed at the source

The earlier note here recorded that `seq` restarted at `0` on every
invocation while a resume carried the previous leg's beats forward at their
original numbers, so one trace could contain the same `seq` twice. The
service took the first of the two suggested fixes: `loop.ts` now sets
`seq = max(carried.seq) + 1`, and the comment there names live-stream
de-duplication as the reason.

Confirmed on a real three-leg execution: beats numbered `0`–`18`
continuously, with the live stream carrying `10`–`18` on the third leg and
`0`–`9` carried forward. `seq` is now a stable identity within one logical
execution, which is what the live channel needs.

**Consequence for the renderer, and a trap avoided.** The resume boundary
used to be inferred from `seq` stepping backwards. That inference can no
longer fire, and would be wrong if it did. The boundary is now read from
the chain — the highest `seq` the previous leg reached (`carriedThroughFor`
in `runs.ts`) — and when the previous leg cannot be read, no marker is
drawn at all. An approximate boundary would be worse than none, because the
carried beats belong to a *different run* and presenting them as this run's
work misdescribes both.

### What the frontend consumes

| Contract | Where |
|---|---|
| `agent` run events | `WfRunEvent` in `ai/aiClient.ts`; folded by `seq` in `useWorkflows.ts` |
| out-of-order / duplicate beats | `foldBeat` dedupes by `seq` and re-sorts |
| partial traces | `PartialAgentTrace` + `isPartialTrace` in `agent/types.ts` |
| live ledger during a run | `runs.ts` attaches the beats as a partial trace |
| mid-run reconnect | `asAgentTrace` in `RunView.tsx` accepts `partial` |

The persisted trace stays the authority. The stream can miss beats (nobody
connected), repeat them (a reconnect replays) or arrive out of order, so
the UI treats it as an early view and the run record as truth — never the
other way round.

## §16 — Resume semantics — delivered, and consumed

The service answered the Phase-7 finding that approving a parked agent
produced a second run while the first stayed `awaiting-approval` forever.
The decision and its reasoning are in `docs/AGENT_RESUME_SEMANTICS.md`; the
part the UI had to change is this:

> A superseded run keeps its `awaiting-approval` state, because that is
> still the honest account of how that leg ended. What changes is that it
> is no longer **pending**.

So any list answering "is someone waiting on me?" must read the chain, not
the state. `isPending()` in `runs.ts` is the single definition, used by
both run lists; `runStateLabel`/`runStateTone` render a superseded leg as
*Continued* rather than *Waiting for you*.

Verified against a real three-leg execution:

- `supersededBy`, `supersededAt`, `resumable: false` and
  `notResumableReason: "continued as run …"` on each superseded leg;
- `GET /workflows/:id/runs/:runId/chain` navigable from either end,
  returning identical chains;
- a second resume of a superseded leg refused, naming the continuation;
- evidence never copied between legs (each leg lists only what it caused);
- the "waiting for you" filter showing `0` rows with one superseded parked
  leg present — and showing `1` when the fix is reverted, which is how we
  know the check tests something.
