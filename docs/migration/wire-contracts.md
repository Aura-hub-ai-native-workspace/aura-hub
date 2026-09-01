# Wire contracts — HTTP surface, conventions, SSE

Extracted from `packages/ai-service/src/server.ts` at `141d101`. The Python backend
must serve this surface byte-compatibly; the React/Tauri frontend is never modified.

---

## 1. Transport and conventions

- **Loopback only, port 4319** (`AI_PORT` default; shell health-gates on it).
- Request bodies are JSON (`readJson`); responses are JSON via a single `json(res,
  status, body)` helper.
- **camelCase field names everywhere.**
- **Error bodies are exactly `{ "error": string }`.** 404 for unknown ids/routes;
  403 for gate violations; 400 for malformed input where TS rejects early.
- Success envelopes vary per route but are stable objects — see route table; when in
  doubt the `.mjs` suites and `apps/desktop/src/ai/*Client.ts` consumers are the
  executable truth.
- `GET /health` →
  `{ health, key: keyStatus(), index: indexStatus(), project: currentProject() }`
  (server.ts:241). The desktop shell treats this as the readiness gate.

## 2. Gates (security-relevant)

- **CORS** (server.ts:46, 235): reflect `Origin` only if it matches
  ```
  ^(https?://(localhost|127\.0\.0\.1)(:\d+)?|tauri://localhost|https?://tauri\.localhost)$
  ```
- **Shutdown gate**: `/shutdown` requires header `x-aura-shutdown: 1`, else
  `403 {error:"shutdown requires the x-aura-shutdown header"}` (server.ts:254–255).

## 3. Route table

Method + shape summary per family. `:id` = path segment. All under seg-routing on
`seg[0]`; unknown → 404 `{error}`.

| Family | Notable routes (method → response highlights) |
| --- | --- |
| `/health` | GET → §1 payload |
| `/shutdown` | POST (header-gated) |
| `/settings` | GET config; PUT/POST update; `/settings/key` key status ops |
| `/providers` | GET store summary (never secret values); POST `/connect` `/disconnect` `/switch`; GET `/models` |
| `/environment` | GET catalog / scan / probe endpoints (connected-environment projections) |
| `/fabric` | GET `/capabilities`; GET/PUT `/policy`; GET `/approvals` (+POST decide per id); POST `/invoke` → `InvocationResult`; GET `/audit` |
| `/projects` | GET list; POST create; `/:id` GET/DELETE; `/:id/context[?surface=]` → Context Fabric view; `/:id/context/contract`; `/:id/graph`, `/:id/intelligence`, `/:id/diagnose` (SSE), `/:id/missions` (SSE create; GET list), `/:id/missions/:mid/{approve,reject,start,execute(SSE)}` |
| `/missions` | global listing/stats surfaces used by Mission Control UI |
| `/workflows` | GET list/summaries + `/specs` `/templates`; POST `/import` `/generate`; `/:id` GET/PUT/DELETE; `/:id/validate`; `/:id/dry-run`; `/:id/envelope`; `/:id/versions` GET/POST(publish); `/:id/run` **SSE** RunEvent; `/:id/runs/:rid/{chain,cancel,resume(**SSE**)}`; `/:id/export` (webhookToken excluded); webhook trigger via token path |
| `/workflow-runs` | GET index/list; `/stats`; `/awaiting`; `/reindex`; `/:id` full record incl. `agentTrace` |
| `/automation` | GET `/templates` `/rules` `/runs` `/schedules`; POST `/rules{,/:id/{dry-run,run,pause,resume}}`; POST `/events` (host push); GET `/events/stream` **SSE subscription**; POST `/validate` |
| `/secrets` | names-only surface; values leave once toward Fabric invoke |
| `/agent` | GET `/bounds` → `{defaults, ceilings}`; GET `/tools?…` → resolved+envelope+describe blocks (server.ts:807–812) |
| `/ask`, `/stream` | POST chat completion; POST `/stream` **SSE** chat chunks |
| `/index`, `/reindex` | indexing triggers/status for pipeline |
| `/inspect`, `/retrieve`, `/graph` | intelligence read surfaces |
| `/code/action` | code action dispatch |
| `/governance`, `/predictive`, `/workspace/intelligence`, `/models` | satellite/intelligence reads |

## 4. SSE streams (all seven)

Shared framing (server.ts:638 et al.):

```
HTTP/1.1 200
content-type: text/event-stream
cache-control: no-cache
connection: keep-alive
<CORS headers per §2>
```

Events written as `data: <json>\n\n`. Six of seven streams terminate with a final
`data: [DONE]\n\n` then `end()` (server.ts:652, 689, 724, 1008, 1033, 1365). The
seventh — automation's subscription stream — stays open without `[DONE]`.

| # | Endpoint | Line | Event union |
| --- | --- | --- | --- |
| 1 | `POST /projects/:id/diagnose` | :638 | diagnosis progress events (TS sidecar per D1) |
| 2 | `POST /projects/:id/missions` | :680 | mission creation progress |
| 3 | `POST /projects/:id/missions/:mid/execute` | :713 | task execution events |
| 4 | `POST /workflows/:id/run` | :1016 area | **RunEvent[]** below |
| 5 | `POST /workflows/:id/runs/:rid/resume` | :995 | **RunEvent[]** below |
| 6 | `GET /automation/events/stream` | :1095 | AutomationEvent subscription (no [DONE]) |
| 7 | `POST /stream` | :1359 | chat token chunks |

### 4.1 RunEvent union (`packages/ai-service/src/workflow/types.ts:158–191`) — frozen

```ts
{ type:'start'; workflowId; at; runId?; versionId? }
{ type:'node';   nodeId; status: NodeRunState; ms?; summary?; error? }
{ type:'log';    nodeId: string|null; level:'info'|'warn'|'error'; text; at }
{ type:'output'; nodeId; title; text }
{ type:'agent';  nodeId; runId?; beat: AgentBeat }        // SAME object as persisted trace
{ type:'done';   status:'completed'|'failed'; ms; error?; runState?; runId? }
```

Hard rules:
- `NodeRunState` is the 10-value LIVE vocabulary (`queued running waiting completed
  failed skipped awaiting-approval denied cancelled timed-out`) — deliberately NOT the
  durable `NodeState` (9 values, no `waiting`). Do not unify them.
- `done.status` stays two-valued for compatibility; honest state travels in
  `runState`. A cancelled run reports `status:'failed', runState:'cancelled'`.
- The `agent` beat payload IS the `AgentBeat` that will be persisted — same `seq`,
  same redaction, same `untrusted` flag. Clients reconcile by `(runId, nodeId,
  beat.seq)`. Persisted trace remains authoritative; the stream may drop/duplicate.
- An `execution` beat carries `evidence.invocationId`; THAT, not event arrival, proves
  something ran.

### 4.2 Chat stream

Token chunks as `data:` JSON lines, terminated by `[DONE]` (:1365). Shape follows the
provider adapter chunk projection consumed by `apps/desktop/src/ai/aiClient.ts`.

## 5. Frontend consumer inventory (compat targets)

From read-only inspection of `apps/desktop/src/ai/aiClient.ts`, `automationClient.ts`,
and screens (~35 call shapes): every endpoint family above is exercised by real UI
code. Highest-friction compat points:

1. RunEvent/AgentBeat exactness and `(runId,nodeId,seq)` reconciliation.
2. Unflattened run states (`awaiting-approval`, `denied`, `timed-out`,
   `notResumableReason`, `supersededBy`).
3. `/agent/tools` composition: `{...resolved, envelope, describe:[…]}` and
   `/agent/bounds` `{defaults, ceilings}` literals.
4. Context view 404-on-unknown-id semantics with `unknown:` honesty lines.
5. Error-shape `{error}`, camelCase, and the two gates of §2.
