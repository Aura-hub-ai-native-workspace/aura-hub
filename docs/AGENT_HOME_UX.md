# Agent Home UX — the flagship Central Agent surface

> Owner: Agent 3 (frontend/UI-UX). Backend contracts referenced here are
> owned by Agents 1–2; this document describes how the desktop consumes
> them and the honesty rules the UI follows.

## The loop on Home

```
AskAuraHero            "What do you want to accomplish?"
   ↓ submit                POST /agent/sessions
INTENT                    backend compiles (never shown as reasoning)
PLAN                      GET …/plan — actions/capabilities/risk only
APPROVAL                  Approve/Deny → POST …/approve (same single-use ledger)
EXECUTION                 backend engine runs through the Fabric
VERIFICATION              read-back / exit-code per plan requirement
RESULT                    outcome label + summary + evidence counts
```

Live SSE frames (`GET …/events`) stream while a session is open, but they
are **observability only** — the durable result always comes from the
submit/approve response body, so a dropped stream can never fabricate one.

## Sections (all real-contract driven)

| Section | Source | Honest states |
| --- | --- | --- |
| ACTIVE | `runIndex({state:'running'})`, live automation runs, pending approvals | service unreachable · nothing running |
| WORKSPACE | project library (existing) | empty → Add Project |
| AUTOMATIONS | `useAutomation.schedules` | unreachable · none · schedule error · missed N |
| ACTIVITY | succeeded index runs **with evidenceCount > 0** | unreachable · no verified runs yet |

## State vocabulary

Run/automation states render through `components/states/StatusChip` — the
one vocabulary table. Agent outcomes render the backend's words verbatim:
`Completed · Waiting for you · Needs your input · Denied by policy · Failed ·
Timed out · Cancelled · Blocked · Not available yet`. Nothing is collapsed
into generic "done"/"failed".

## Non-negotiables enforced in code

1. **No fabricated data.** Unreachable source ⇒ explicit unavailable state;
   empty ⇒ next-action prompt. There is no placeholder activity anywhere.
2. **No chain-of-thought.** The plan review endpoint is reasoning-free by
   contract; the UI renders steps/capabilities/risk and never model text.
3. **Approval is human.** Approve/Deny calls the backend route that records
   the decision in the same single-use ledger the Fabric spends; replays
   surface the backend's 409 refusal verbatim.
4. **One client per service.** `centralAgentClient` (Python agent, default
   `http://127.0.0.1:4320`, override `VITE_AGENT_URL`) alongside — never
   replacing — `aiClient` (workflow/AI service, :4319).

## Accessibility & responsiveness

- Intent input labelled; result region `aria-live="polite"`; transport
  failures `role="alert"`; busy state `role="status"`.
- Every row/button has an accessible name; icon-only controls use Tooltip +
  `aria-label` (rail pattern).
- Focus-visible outlines preserved through custom buttons.
- Breakpoints: sections stack below `xl` (1280px); rows truncate with
  `min-w-0`; secondary metadata hides under `sm`. No horizontal overflow at
  1024 / 1280 / 1440. Dark and light themes via semantic tokens only.

## Milestone 4 — session interaction + convergence

### Complete session interaction (AskAuraHero)
- **Phase strip** (`AgentPhaseStrip`): INTENT → PLAN → PERMISSION →
  EXECUTION → VERIFICATION → RESULT, driven only by real SSE event types
  and the terminal outcome. Unknown event types never guess a phase.
- **Clarification loop**: `Needs your input` state renders the backend's
  question with an answer field; the reply continues the SAME session via
  `POST …/message`. Verified in-browser: ambiguous ask answered → completed.
- **Cancel** while working (`POST …/cancel`).
- **ApprovalGate reuse**: when parked, the hero fetches the real request
  from the AGENT ledger (`centralAgentClient.pendingApprovals()`) and
  renders the existing `ApprovalGate`. Two-ledger note: agent-parked ids
  live on :4320; `useFabric` reads the workflow service's (:4319) — an
  agent id must never be resolved through useFabric.
- **Approve/Deny** call `POST …/approve` (decide+resume, same single-use
  ledger). Replay returns the backend's **409** verbatim.
- **Run linkage**: a result carrying `runId` shows "Inspect run" →
  `agentLinkStore.requestRunInspection` → Automation domain opens that
  exact run in the existing RunView (real ids end to end).

### Command palette (⌘K)
`Ask AURA`, `Open active Agent session`, `Decide approval: <title>` (when
one is pending) join Navigate/Actions. Keyboard model unchanged.

### Runtime verification
`scripts/ui-central-agent-home.mjs` — Playwright against the REAL stack
(dev server :1420 · workflow/AI service :4319 · Python agent API :4320 on a
disposable AURA_HOME). 13 checks:
T1 read-only intent → Completed + evidence + phase strip reached RESULT;
T2 governed write parks → canonical ApprovalGate → approve → Completed,
replay refused 409; T3 clarification loop completes; plus liveness,
no-chain-of-thought rendering, hero render.

### Dev proxy (CORS)
The agent API does not answer OPTIONS preflights yet (**BACKEND CONTRACT
REQUIRED — OWNER: Agent 2** — `aura.api` must handle OPTIONS +
`access-control-allow-*` for packaged/Tauri builds where no dev proxy
exists). Interim frontend solution: Vite proxies `/agent-api` → :4320 and
the client defaults to the proxied path under `import.meta.env.DEV`.

### Suite status (this tree)
ui-workflow 68/68 · ui-agent 98/98 · ui-automation 58/58 · ui-dryrun 72/72 ·
ui-central-agent-home 13/13 · typecheck ✓ · build ✓.
Pre-existing failures unrelated to this milestone: `ui-approval-test`
(stale decline-input selector vs current ApprovalGate), `ui-agent-noprovider`
(harness TypeError before assertions), backend `tests/unit/
test_persistence_invariants.py` (parallel builder WIP).

## Milestone 5 — RunView agent-native tab, unified approvals, SSE hardening

### RunView · Agent tab
Existing RunView gained an **Agent** tab (no second run viewer). It renders
`workflows/agent/RunAgentPanel.tsx`: intent, per-step plan with live states,
effective bounds (iterations / wall-clock / tokens), the full AgentTrace
(reusing `agent/AgentTrace.tsx` — reasoning-free beats only), evidence count,
stop reason, and superseded/resume chain. COMPLETED ≠ VERIFIED is preserved:
verification state renders from evidence, never from run success alone.

### Unified approvals inbox
`ApprovalsInbox` now merges TWO real ledgers into one consequence-ranked list:
the Workflow Fabric ledger (:4319 via `useFabric`) and the Central Agent
ledger (:4320 via `useAgentApprovals`). Each item is tagged `Fabric`/`Agent`.
Decisions go through each source's own backend route — one decision semantic,
two ledgers, clearly labelled. Superseded legs are excluded from waiting lists;
non-resumable runs are excluded from resume prompts.

### SSE reconnect hardening (`centralAgentClient.events`)
Exponential backoff 250ms→8s cap; backoff resets on any delivered frame;
frames deduplicated by `type@at` so post-reconnect replay never double-renders;
every reconnect emits honest `stream.reconnecting`; the durable result always
comes from approve/submit response bodies or a `getSession` reconciliation poll
(after approve, the hero reconciles against durable session state up to 12s),
so stream loss can neither fabricate nor erase an outcome.

### Backend contract required (OWNER: Agent 2)
`aura.api` does not answer CORS `OPTIONS` preflights. Dev works via Vite
proxy; packaged/Tauri builds need preflight + `access-control-allow-*` on
`aura.api`. Also useful later: plan-review payload gaining dependency/scope
fields, and `WorkflowRun.agentTrace` typed on the wire contract.
