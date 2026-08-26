# Frontend ↔ Final Python Backend Reconciliation

> Author: Agent 3 (frontend). Date: 2026-08-26. Target: `migration/python-backend`
> @ `b23219c` (`backend/aura/api/server.py`, Starlette, 17 routes).
>
> Nothing in the frontend fakes a contract. Where a route is missing below,
> the affected UI already renders an honest unavailable/blocked state rather
> than a convincing blank.

## 1. What the final Python backend serves (verified live)

`GET /health` → `{health:{status:"ok",backend:"python"},key:{configured},index:{status},project}` ·
`GET/POST /workflows`, `GET/PUT/DELETE /workflows/{wid}` ·
`POST /workflows/{wid}/run` · `POST /workflows/{wid}/dry-run` ·
`GET /workflows/{wid}/versions` · `GET /runs` → `{runs:[…]}` ·
`GET /runs/{rid}` · `GET /fabric/capabilities` · `GET /fabric/policy` ·
`GET /automation/rules` · `GET /automation/runs` · `GET /secrets` → `[names]` ·
`GET /events/workflow` (SSE, currently emits `{type:"start"}` then `[DONE]`).

## 2. Consumed by the frontend but ABSENT from the final backend

These are the exact contracts required to light up existing, committed UI.
Until they land, those surfaces stay on their honest offline states.

### 2a. Central Agent session surface (blocks Ask AURA end-to-end)

Documented contract: `docs/AURA_CENTRAL_AGENT_API.md`. The frontend client
(`apps/desktop/src/ai/centralAgentClient.ts`) mirrors the Pydantic contracts
in `aura/contracts/agent.py` verbatim (camelCase wire, closed vocabularies).

- `POST /agent/sessions` → `{result: AgentResult, sessionId}`
- `GET  /agent/sessions/{id}` → full persisted `AgentSession`
- `POST /agent/sessions/{id}/message` → `{result}`
- `POST /agent/sessions/{id}/approve` → `{approval, result}`, 409 on replay
- `POST /agent/sessions/{id}/resume` → `{result}` (400 not-parked, 403 grant)
- `POST /agent/sessions/{id}/cancel` → `{cancelled}`
- `GET  /agent/sessions/{id}/plan` → reasoning-free `PlanReview`
- `GET  /agent/sessions/{id}/evidence` → flat bundle or `{evidence: null}`
- `GET  /agent/sessions/{id}/events` → SSE tail-replay + live `AgentEvent`s

Blocked UI: Home Ask-AURA hero, command-palette agent actions, agent deep-link
tab in RunView, agent-ledger rows in ApprovalsInbox, `useAgentApprovals`.

### 2b. Approval ledger surface (blocks every decision gate)

The ONE-ledger rule stands: decisions go through `/fabric/approvals`, and the
agent's approve route spends the same entries.

- `GET  /fabric/approvals` → pending `ApprovalRequest[]`
- `POST /fabric/approvals/{id}/decide` → `{approval}`, 409 on replay

Blocked UI: ApprovalGate everywhere (hero, RunView, trace), ApprovalsInbox
(both ledgers), PermissionEnvelope risk reads that pair with pending items.

### 2c. Fabric invoke/audit/mission

- `POST /fabric/invoke` · `GET /fabric/audit` · `GET /fabric/mission/{pid}/{mid}`

### 2d. Workflow-editor extras consumed via `aiClient`

templates · specs · duplicate/import · `GET /workflows/{id}/envelope` ·
validate · per-workflow run history (`GET /workflows/{id}/runs[/:runId]`) ·
run cancel/resume · resume chain (`GET …/runs/:runId/chain`). Note the final
backend's flat `GET /runs`/`GET /runs/{rid}` exist — a thin compatibility
mapping or client repoint covers the read side once shapes are confirmed.

### 2e. Automation write/action surface

rule create/update/delete · `run/pause/resume` · per-rule runs ·
`GET /automation/events/stream` · schedules read · server-side validation ·
cross-rule stats/reindex. (Final backend has the two READ routes only.)

### 2f. Real workflow SSE

`GET /events/workflow` is a placeholder frame + sentinel. Required: real
RunEvent streaming with tail replay, reconnect/Last-Event-ID semantics
(migration report §9 defers exactly this).

## 3. Shape deltas on routes that DO exist

- `/health`: old TS returned `{ok:true,service:"ai-service"}`; final returns a
  richer object without top-level `ok`. Any consumer keying on `ok` needs the
  one-line adaptation when clients repoint.
- Dry-run report: verify field parity against `DryRunReport.tsx` expectations
  during the repoint milestone (zero-side-effect semantics confirmed upstream).

## 4. CORS — verified defect (blocks packaged/Tauri builds)

Live probe against the real uvicorn instance, 2026-08-26:

```
OPTIONS /workflows
  Origin: http://localhost:1420
  Access-Control-Request-Method: POST
→ HTTP 400 "Disallowed CORS origin"
```

Cause: `CORSMiddleware(allow_origins=["http://localhost:*", …])` — Starlette
matches origins literally; `"http://localhost:*"` is not a glob. Required
backend fix (one line, Agent 1's file):

```python
allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
# plus tauri://localhost / https://tauri.localhost kept as exact entries
```

Dev remains unaffected (Vite same-origin proxy `/agent-api`). Until the fix
lands, direct-from-Tauri builds must keep `BLOCKED — BACKEND CONTRACT`.

## 5. Verification labels used by the frontend

TYPECHECKED · BUILT · UI TESTED (scripted browser suites) · RUNTIME VERIFIED
(real services, disposable home) · NOT VERIFIED. No label is claimed without
the corresponding run; see the milestone report for which surfaces carry
which label against WHICH backend tree.
