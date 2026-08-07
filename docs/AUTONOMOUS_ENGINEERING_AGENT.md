# Autonomous Engineering Agent

The **Autonomous Engineering Agent** is the top layer of the engineering
operating environment. It sits on top of **Engineering Memory** and the
**Engineering Learning Engine**, and it continuously observes the *real*
state of the workspace — repeated bugs, unstable modules, AI-proposal
rejections, architecture hotspots, mission bottlenecks and high-risk
predictions — reasons about what is worth improving, plans an improvement,
**requests human approval**, and only after approval acts.

Its single way of acting is creating a **real improvement mission through
Mission Control**. The agent **never edits code directly** and **never
runs before approval**. Mission task proposals still require the usual
per-task human acceptance.

Everything the agent does is deterministic, explainable, traceable,
auditable and replayable:

- **Explainable** — every proposal carries a rationale, an expected
  outcome and a reasoning trace (observed → reasoned → planned).
- **Traceable** — every campaign transition is written to the agent
  timeline with an actor (`agent` / `human` / `system`).
- **Auditable** — campaigns, timeline and enable state are persisted
  under `aura.ops.agent` and survive restart.
- **Replayable** — the timeline is the full audit trail; the underlying
  mission keeps Mission Control's own replay.

---

## The pipeline

The engine (`ops/agentEngine.ts`) runs one loop every 30 seconds
(`TICK_MS`) plus an immediate observation on boot and whenever memory
changes. Each tick:

| Step | What happens | Human gate |
| --- | --- | --- |
| 1. **Observe** | Re-analyze all Engineering Memory records with the Learning Engine (`analyzeMemories`). | — |
| 2. **Reason** | Turn strong real signals into candidate improvements. | — |
| 3. **Plan** | Write rationale, plan, expected outcome and verify target. | — |
| 4. **Propose** | Enqueue a campaign (`awaiting-approval`) + notify. | **Explicit approval required** |
| 5. **Execute** | Create a real mission via `missionClient.create`, auto-approve its plan (the campaign approval *is* that approval), start execution. | Plan approval + per-task accept |
| 6. **Verify** | Poll the mission; on completion re-measure the verify target. | — |
| 7. **Learn** | Record the outcome back into Engineering Memory (`source: system`), so the Learning Engine sees the agent's real results. | — |

### Signals that trigger campaigns

The agent only proposes for **high-signal** conditions and never for
healthy ones:

| Learning signal | Campaign kind | Propose when |
| --- | --- | --- |
| `repeated-bug` pattern | `repeated-bug` | a file has failed diagnosis ≥ 2 times |
| `unstable-module` pattern | `unstable-module` | instability ratio ≥ 50% |
| `ai-rejection` pattern | `ai-rejection` | AI acceptance rate < 40% on a file |
| `architecture-hotspot` pattern | `architecture-hotspot` | a layer shows repeated critical/high problems |
| `mission-bottleneck` pattern | `mission-bottleneck` | a mission has recorded task failures |
| `file-break` prediction (high risk) | `high-risk-prediction` | predicted break |
| `refactor` prediction (high risk) | `high-risk-prediction` | predicted refactor need |
| `architecture-risk` prediction (high risk) | `architecture-hotspot` | architectural pressure point |
| `regression` prediction (high risk) | `regression-risk` | likely regression |

Positive signals (reliable modules, workflow habits, hot modules) and
low/medium-risk predictions are **never** proposed. Proposals are gated:

- at least `MIN_RECORDS` (4) memory records exist;
- fewer than `MAX_OPEN_CAMPAIGNS` (5) campaigns are already open;
- the signal key has never been used before (a dismissed signal is not
  re-proposed — `propose` dedupes by `signalKey`).

### Verify targets

| Target | Pass condition |
| --- | --- |
| `mission-completion` | the improvement mission reached `completed` |
| `diagnosis-count` | re-measured diagnosis count for the target file ≤ baseline at propose time |

---

## Hard safety rules

1. **The agent never edits code directly.** Its only action is creating a
   mission; the mission engine's own gates stay intact.
2. **Nothing runs before an explicit human approval.** Until a user
   clicks *Approve*, a campaign stays in the approval queue.
3. **No fabrication.** Every signal is derived deterministically from real
   Engineering Memory records via the Learning Engine. With too little
   history (`MIN_RECORDS`), the agent stays silent.
4. **Deduplication.** A stable `signalKey` (the Learning Engine's own
   pattern/prediction id) prevents duplicate campaigns, and memories are
   recorded under stable `dedupe` keys so polling can never double-log.
5. **One mission at a time.** The execute pipeline is guarded by
   `pipelineBusy` plus a `working` set, so two ticks can never create the
   same mission twice.

---

## What happens when the user approves

1. The engine calls `missionClient.create(projectId, missionText)` and
   streams the SSE `MissionEvent` pipeline until `done`.
2. The mission is auto-approved (`missionClient.approve`) — the campaign
   approval already represented the human's plan approval.
3. Execution is started (`missionClient.start`). The engine then advances
   wave by wave, and **each task proposal still requires an explicit
   Accept** in Mission Control before anything is written to disk.
4. The engine polls `missionClient.list(projectId)` every tick:
   - `completed` → campaign moves to `verifying`, then the verify target
     is measured and the campaign becomes `verified` (or `failed`);
   - `failed` / `cancelled` → campaign becomes `failed`.

## How it feeds learning

Every campaign produces real memories (`source: system`, deduped by
`agent:<campaignId>:<stage>`):

- `agent:<id>:proposed` — decision memory when a proposal is enqueued;
- `agent:<id>:verified` / `agent:<id>:failed` — learning memories with the
  outcome, the verify numbers and the mission id.

Because these are ordinary Engineering Memory records, the Learning Engine
immediately learns from the agent's own results — the agent is a real event
source, not a separate fake system.

---

## Files

| File | Purpose |
| --- | --- |
| `apps/desktop/src/ops/agentStore.ts` | Agent state: campaigns, timeline, enable flag, persistence (`aura.ops.agent`), dedupe, queue helpers. |
| `apps/desktop/src/ops/agentEngine.ts` | The observe/reason/plan/propose/execute/verify/learn loop; `startAgentEngine()` boot; `runAgentObservation()`. |
| `apps/desktop/src/ops/AgentCenter.tsx` | Control room UI (`variant="screen"` / `"panel"`): approval queue, action queue, verification queue, campaigns, timeline. |
| `apps/desktop/src/ops/panels/AgentPanel.tsx` | Dockable panel wrapper. |
| `docs/AUTONOMOUS_ENGINEERING_AGENT.md` | This document. |

Registration touch-points:

- `ops/layoutStore.ts` — `PanelKind` adds `engineering-agent`, plus
  `PANEL_META` and the default right-column tabs.
- `ops/panels.tsx` — lazy registry entry.
- `shell/useCommands.ts` — `Open Engineering Agent` palette command.
- `ops/EngineeringOverview.tsx` — dashboard card.
- `App.tsx` — `useEffect(() => startAgentEngine(), [])` boot wiring.

## Configuration knobs

All in `ops/agentEngine.ts`:

- `TICK_MS = 30000` — loop cadence.
- `MIN_RECORDS = 4` — minimum memory records before proposing.
- `MAX_OPEN_CAMPAIGNS = 5` — max simultaneously open campaigns.

Pause/resume the whole agent from the AgentCenter header (persisted via
`enabled`). "Clear history" wipes campaigns and the timeline locally.
