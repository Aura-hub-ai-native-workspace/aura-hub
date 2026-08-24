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
