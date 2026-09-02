# API Usage Overview — How AURA Hub Calls DashScope

*For Alibaba Cloud engineers evaluating the integration's real request
patterns.*

## Endpoints called

| DashScope endpoint | Called from | Frequency trigger |
|---|---|---|
| `GET /compatible-mode/v1/models` | `discoverModels()`, `validate()`, `checkHealth()` | On connect, on provider switch, on manual "Test connection", periodic health polling |
| `POST /compatible-mode/v1/chat/completions` (non-streaming) | `generate()` | Any non-streaming AI action: workflow generation nodes, mission planning/review steps, diagnosis (root cause, patch generation) |
| `POST /compatible-mode/v1/chat/completions` (`stream: true`) | `stream()` | AI Chat, streaming Ctrl+I responses |

All requests use standard OpenAI-compatible bodies — `model`, `messages`,
`stream`, optional `temperature`/`max_tokens`, and
`stream_options: { include_usage: true }` on streaming requests so token
usage is captured from the same response stream (no separate usage call).

## Request shape (representative, non-streaming)

```json
POST /compatible-mode/v1/chat/completions
Authorization: Bearer <user's own DashScope key>
{
  "model": "qwen-plus",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "stream": false,
  "temperature": 0.4,
  "max_tokens": 4096
}
```

## Volume characteristics

- **Bring-your-own-key.** AURA operates no shared/pooled API account —
  every request is billed to the individual end user's own DashScope
  key. AURA itself makes zero DashScope calls outside of a session where
  a user has explicitly connected Qwen.
- **User-driven, not batch.** Requests are interactive (chat turns,
  single code-action invocations, one generation step per workflow
  node) — there is no background polling, crawling, or bulk-inference
  workload against the API.
- **Timeout/retry behavior.** Client-side timeout defaults to 30s
  (user-configurable, 5–120s); failed requests classified as
  retryable (rate limit, network, 5xx) get up to `maxRetries` (default 2,
  user-configurable 0–5) retries with capped exponential backoff
  (500ms × 2^attempt, max 4s) — this bounds retry-storm risk on
  Alibaba's side by design, not as an afterthought.
- **Discovery calls are infrequent and cached.** `GET /models` is called
  on connect/switch/manual test only; the result is cached locally and
  reused, not polled per-request.

## What a credits/partnership relationship would change

Today, every request against DashScope is paid for by the individual
developer using AURA with their own key — Alibaba Cloud sees exactly the
usage a normal DashScope customer would generate, at whatever scale AURA
Hub's user base reaches organically. A credits or collaboration
relationship (see
[`01-partnership-proposal.md`](01-partnership-proposal.md)) would let us
develop and validate the integration end-to-end (including the
authenticated-inference verification currently missing — see
[`05-qwen-integration-overview.md`](05-qwen-integration-overview.md))
and would let us build the demo assets and example content that
showcase Qwen specifically, without asking a small early team to fund
that from a personal account.
