# AURA Provider Bridge Contract (Phase 1.3)

Companion to `OBSERVABILITY-CONTRACT.md` (correlation) and
`RUNTIME-BOUNDARIES.md` (runtime split). This document owns one thing:
how the Python Central Agent reaches a model. It does NOT merge the
TypeScript and Python provider implementations.

## Inventory (verified 2026-09-11)

| Runtime | Provider source | Model source | Credential source | Caller | Output | Failure behavior |
|---|---|---|---|---|---|---|
| Python agent (`:4320`) | operator `providers.json` chain (`model_routing.load_providers`) | per-`ProviderSpec.model` | env var at call time, never persisted | `IntentCompiler`, `_plan_from_model`, `_stream_answer` via `ModelPort` | JSON dict / streamed text | `RoutingError` / `IntentCompilationError` → honest heuristic degradation |
| TS service (`:4319`) | `RuntimeManager` + registry, 13 adapters (`BaseOpenAICompatible` family) | active provider + validated model | AES BYOAK store; user keys POSTed inbound only | `pipeline.generate/stream` (chat, diagnosis, missions, workflows) | text + usage | typed `NormalizedError` + `ProviderHttpError` translation |
| Renderer | none (no SDK imports — verified by grep) | active label only | none outbound (fingerprints inbound on connect) | `aiClient` connect/disconnect/switch | fingerprints, model lists | honest unavailable states |

Authoritative configuration is SPLIT BY SURFACE (documented, not merged
this phase): TS BYOAK for interactive services, operator
`providers.json` for the agent. Credentials never cross that boundary
in either direction.

## Bridge shape

One narrow facade — `central_agent/provider_bridge.py:ProviderBridge`
— wrapping the existing `ModelPort`. It adds structure, not transport:

- **Inputs:** session id, request id, purpose (`intent`|`plan`|`answer`),
  system/user prompts, timeout (from spec), cancellation predicate.
- **Resolution:** first healthy provider in operator chain order;
  entries missing id/baseUrl/model/apiKeyEnv are skipped with reason;
  empty chain → `PROVIDER_NOT_CONFIGURED`; configured-but-keyless →
  honest skip (never a fake call).
- **Output:** `BridgeResult{ok, provider, model, text/data, latencyMs,
  requestId, sessionId, degraded, error_category}`.
- **Governance:** inference only. The bridge cannot plan, approve,
  execute, or verify — it returns text/data to the agent loop, which
  keeps every authority decision.

## Credential boundary

- Keys resolve from env inside the adapter at call time and travel
  only in the HTTPS `Authorization` header to the provider.
- Keys never enter: renderer state, SSE payloads, evidence, audit
  records, telemetry, exceptions surfaced to clients, or persisted
  session files.
- `redact()` helper + regression tests pin this; telemetry structures
  have no field that could carry a secret by construction.

## Failure taxonomy

| Category | Meaning |
|---|---|
| `PROVIDER_NOT_CONFIGURED` | no provider entries enabled |
| `MODEL_NOT_CONFIGURED` | entry lacks a usable model |
| `PROVIDER_UNSUPPORTED` | entry fails validation / unknown shape |
| `AUTHENTICATION_FAILED` | 401/403, missing key at call time |
| `RATE_LIMITED` | 429 |
| `PROVIDER_TIMEOUT` | connect/read timeout, stalled stream |
| `PROVIDER_UNAVAILABLE` | 5xx, network failure, empty chain after skips |
| `INVALID_PROVIDER_RESPONSE` | non-JSON / no-text where text required |
| `REQUEST_CANCELLED` | stop landed mid-call (never reported as failure) |
| `INTERNAL_PROVIDER_ERROR` | anything else, truncated, no secrets |

`RoutingError` carries `.category`; message text is unchanged for
backward compatibility.

## Observability

Every attempt joins the Phase 1 model: `sessionId`, `requestId`,
provider/model, start/end timestamps (via `latencyMs`), outcome, and
failure category ride `answer.*` payloads, `telemetry()`, and
`GET /agent/model`. Raw prompts/completions are never logged.

## Honest degradation

No provider → heuristic intent, deterministic planning, deterministic
summaries — each labeled as such in outcomes. The bridge never
substitutes another provider, never invents a model identity
(`"unknown"` when unknowable), and never claims model-backed reasoning
from heuristic paths.
