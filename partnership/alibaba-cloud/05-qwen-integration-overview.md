# Qwen Integration — Technical Overview

## Summary

Qwen (Alibaba Cloud Model Studio) is integrated into AURA Hub as a
first-class AI provider — the same standing as OpenAI, Anthropic, or
Groq. It was built and verified against Alibaba's own documentation and
a live endpoint, not assumed.

## Integration facts

| Item | Value |
|---|---|
| Adapter | `packages/ai-service/src/provider/adapters/qwen.ts` |
| Base URL | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (international/Singapore DashScope endpoint) |
| Auth | `Authorization: Bearer <DASHSCOPE_API_KEY>` |
| Default model | `qwen-plus` (from Alibaba's own quickstart examples) |
| Protocol | OpenAI-compatible `chat/completions`, including SSE streaming |
| Lines of Qwen-specific code | 47 (mostly a documentation comment justifying two deliberate decisions — see below) |

## Two deliberate decisions, made explicit

1. **International endpoint over the workspace-scoped variant.** Alibaba
   documents a `{WorkspaceId}.{region}.maas.aliyuncs.com` variant in
   addition to the fixed `dashscope-intl.aliyuncs.com` endpoint. The
   workspace-scoped form would require collecting a second piece of
   per-user configuration beyond an API key — inconsistent with every
   other provider in AURA, where "paste a key" is the entire flow. The
   fixed international endpoint was chosen to keep the user experience
   identical across all 11 providers.
2. **No key-prefix auto-detection.** DashScope keys share the generic
   `sk-` prefix OpenAI's adapter already claims, so Qwen's `detect()`
   deliberately returns `false` — a user picks Qwen explicitly from the
   provider list rather than AURA guessing wrong. The same honest choice
   already applies to NVIDIA, OpenRouter, Gemini, and Novita.

## What Qwen gets automatically, by construction

Because Qwen extends the same shared base adapter class every
OpenAI-compatible provider in AURA uses, it inherited — with zero
additional code — chat, streaming, JSON-mode-compatible generation,
capped-retry on transient failures, configurable timeout, model
discovery (`GET /models`), health checks, and the platform's shared
error-classification (auth / billing / rate limit / network / model /
server error), all with Qwen-labeled, user-facing messages instead of
raw provider payloads.

It is also available, with no additional wiring, in every AI-driven
surface of the product: AI Chat, in-editor Ctrl+I actions, the AI
Workflow Builder, Automation Studio's node graphs, Mission Control's
planning/review steps, and Engineering Intelligence's diagnosis
pipeline — because every one of those already calls through the same
three provider-agnostic entry points (`pipeline.ask` / `.generate` /
`.streamEvents`).

## Verification performed

- Typecheck and build clean (`tsc -b`, Vite production build).
- Live request against the real DashScope endpoint: an unauthenticated
  request returns HTTP 401 (proving the route exists, not a 404), and a
  full `/providers/connect` round-trip with a deliberately invalid key
  returns AURA's real classified response —
  `{"ok":false,"error":"Invalid API key (401)"}"` — sourced from
  Alibaba's actual servers.
- CI green on the commit that ships the adapter
  (GitHub Actions — typecheck + build).

**Honest limitation:** no live DashScope API key was available in the
development environment used to build this integration, so successful
end-to-end inference (a real chat completion, real streamed tokens)
has not yet been exercised — only the auth/connectivity path has been
proven live. Everything downstream of a valid key is the same,
already-proven runtime code path six other providers use in production
today. We'd be glad to close this last gap directly with API access or
credits — see [`01-partnership-proposal.md`](01-partnership-proposal.md).

## Why Qwen, specifically

- **Technical fit.** Qwen's OpenAI-compatible API meant it slotted into
  AURA's existing adapter abstraction with no special-casing — a real
  stress test of that abstraction's soundness, not just a marketing
  claim about "no vendor lock-in."
- **Model breadth.** Alibaba's Qwen family spans multiple capability/
  latency tiers, which fits AURA's per-task model-switching workflow
  (a user can pick a lighter tier for inline edits and a stronger tier
  for architecture-level generation without leaving the app).
- **Reach.** Alibaba Cloud gives AURA a path to developers who are
  already inside the Alibaba Cloud ecosystem, and gives those developers
  a serious, non-Western-centric model choice inside a developer tool
  that treats provider choice as a first-class, switchable decision
  rather than an afterthought.
