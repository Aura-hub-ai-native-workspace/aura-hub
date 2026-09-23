# AURA Observability Contract (Phase 1)

One documented correlation + telemetry model. No competing formats.

## IDs

| ID | Shape | Generated | Scope |
|---|---|---|---|
| `request_id` | `req-` + 12 hex | server-side, per agent HTTP leg | submit / message / approve / resume / resume-cancelled / cancel |
| `session_id` | `agt-` + 12 hex | server-side, per session | whole conversation |
| `approval_id` | `apr-` + opaque | Fabric, per parked action | single-use grant |
| `capability_run_id` | `inv…` invocation id / engine `runId` | Fabric/engine | one governed invocation |
| `worker_run_id` | engine `runId` + node assignment | execution controller | one dispatch |
| `evidence_id` | composite `(sessionId, planId, createdAt)` | EvidenceCollector | one collected bundle |
| `project_id` | registry id | project registry | session + every invocation |

A leg == one `request_id`. A leg that parks and resumes gets a NEW
`request_id` per leg; the parked record is never mutated.

## Lifecycle

```
HTTP leg (request_id) → session (session_id)
  → intent → plan → authority → [approval_id → ledger → resume(new request_id)]
  → Fabric invocation (capability_run_id) → worker (worker_run_id)
  → verification → evidence (composite id) → terminal AgentResult
```

## Propagation

- HTTP responses carry `requestId` (+ `X-Aura-Request` header on the Starlette host).
- Every `AgentEvent` payload carries `requestId` (injected by `CentralAgent._emit`; explicit caller values win).
- Invocation contexts carry `sessionId` + `requestId`; both land in Fabric audit records (`backend/aura/fabric/__init__.py:_settle`, `backend/aura/fabric/invoke.py:_settle`).
- Worker assignments and `ExecutionOutcome.request_id` carry the leg.
- Evidence bundles list contributing `requestIds`.
- Sessions persist `lastRequestId`.

## Event format

`AgentEvent{type, at, sessionId, payload}` unchanged; correlation rides
`payload.requestId`. Token frames (`answer.token`) carry only `text`;
`answer.completed` additionally carries `chars`, `provider`, `model`,
`latencyMs` — or honest `"unknown"` values when unknowable.

## Audit relationship

Audit records are the durable truth; events are observability. Both
share the same ids, so an operator can join `trail.jsonl` rows to
session events by `(sessionId, requestId, invocationId)`.

## Model telemetry

`GET /agent/model` returns the live port's secret-free snapshot:
`{configured, providers[{id, model, calls, consecutiveFailures,
lastError, circuit}], lastCall[{provider, model, latencyMs, ok,
error}]}`. Unconfigured → `configured: false`, `lastCall: null`.
Unavailable identity is reported as `"unknown"`, never fabricated.

## Privacy rules

- Telemetry contains metadata only: provider id, model name, counts,
  latencies, error strings (truncated).
- NEVER: API keys, authorization headers, raw credentials, secrets,
  full prompts, completions, file contents.
- `RoutedModelPort.telemetry()` has no code path that could include
  any of the above (keys stay in headers at call time; prompts stay
  in call arguments).
- Session files persist `lastRequestId` (observability, not secret).

## Failure behavior

- Malformed `request_id` → 409 before any state is touched.
- Missing correlation → degrade to session-only (never fabricate).
- Telemetry failure → `"unknown"`, never a fake identity.
- Telemetry/observability failures NEVER change authorization
  semantics: approval, policy, and single-use spending do not read
  telemetry.
