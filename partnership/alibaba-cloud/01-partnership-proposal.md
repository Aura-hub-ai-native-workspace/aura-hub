# AURA Hub × Alibaba Cloud — Technical Partnership Proposal

## Purpose of this document

This is a technical partnership package, not a marketing pitch. It
explains what AURA Hub is, why we integrated Qwen as a first-class
provider, what that integration actually consists of, and what kind of
collaboration we're asking Alibaba Cloud to consider. Every claim below
is checkable against the public repository
(`github.com/Aura-hub-ai-native-workspace/aura-hub`); where something is
aspirational rather than shipped, it's labeled as such.

## 1. What AURA Hub is

AURA Hub is an AI-native engineering workspace: a desktop application
(Tauri v2 + React) paired with a local AI orchestration service that
gives a developer one environment combining a codebase-grounded AI
assistant, a visual workflow automation engine, multi-step task
execution, a persistent engineering memory, and rule-based engineering
governance. It has **no built-in AI model** — every capability is
bring-your-own-key, currently across 11 supported providers (OpenAI,
Anthropic, Gemini, Groq, Mistral, Cerebras, Kimi, NVIDIA, OpenRouter,
Novita, and Qwen) behind one shared adapter interface. Full technical
detail is in [`03-technical-architecture.md`](03-technical-architecture.md)
and the [Feature Matrix](06-feature-matrix.md).

## 2. Why we chose Qwen

Three concrete reasons, not a generic "we support many providers" line:

1. **The abstraction had to prove itself against a real, independent
   API.** AURA's provider system claims that adding a new OpenAI-
   compatible provider is a single small adapter file, no special-casing
   anywhere else in the codebase. Integrating Qwen — a real, independent,
   production API with its own endpoint conventions and regional
   structure — was the honest test of that claim. It held: the adapter is
   47 lines, and the only other change anywhere in the product was a
   one-line registry entry and a settings icon.
2. **Model breadth and quality.** Alibaba's Qwen family spans multiple
   capability/latency tiers, which fits directly into how AURA already
   lets a user switch models per task (a fast tier for inline edits, a
   stronger tier for architecture-level generation) without leaving the
   app or reconfiguring anything.
3. **Reach and philosophy fit.** AURA's core position is "no vendor
   lock-in — bring your own key, your own choice of model." Alibaba Cloud
   gives that promise real weight for developers who are already inside
   the Alibaba Cloud ecosystem, or who simply want a serious alternative
   to Western-centric provider defaults.

Full technical detail: [`05-qwen-integration-overview.md`](05-qwen-integration-overview.md).

## 3. How Qwen improves the platform

- Gives every AURA user — through AI Chat, Ctrl+I, the Workflow Builder,
  Automation Studio, Mission Control, and Engineering Intelligence — a
  genuine, first-class alternative model family, not a second-tier
  "also supported" entry.
- Strengthens the credibility of AURA's "provider-agnostic by
  construction" architecture claim with a real, independently-verified
  integration (see the verification section in
  [`05-qwen-integration-overview.md`](05-qwen-integration-overview.md)).
- Positions AURA to plausibly become a discovery surface for Alibaba
  Cloud's model family among a developer audience that may not have
  DashScope on their radar otherwise.

## 4. How developers benefit

A developer using AURA who connects a DashScope key gets Qwen with zero
second-class treatment: the same streaming, retry/timeout behavior,
error messages, and model-switching UX as every other provider, and
access to it from every AI-driven feature in the product simultaneously
— see [`06-feature-matrix.md`](06-feature-matrix.md).

## 5. Technical summary (detail in linked docs)

| Area | Summary | Detail |
|---|---|---|
| Provider Architecture | One shared adapter interface, 11 providers, zero per-provider branching outside adapters | [`03-technical-architecture.md`](03-technical-architecture.md) §3 |
| Workflow Engine | Typed node graph (source/intelligence/generate/logic/action), AI-generatable from natural language | [`03-technical-architecture.md`](03-technical-architecture.md) §4 |
| Engineering Intelligence | Rule-based health scoring + AI-assisted diagnosis on top of persistent Engineering Memory | [`03-technical-architecture.md`](03-technical-architecture.md) §5 |
| Automation Studio | Visual workflow library, 10 real starter templates, all provider-agnostic | [`06-feature-matrix.md`](06-feature-matrix.md) |
| Multi-provider System | Retry, timeout, error translation, model discovery — implemented once, shared by every provider including Qwen | [`07-api-usage-overview.md`](07-api-usage-overview.md) |

## 6. Where this honestly stands today

- Public repository, Apache-2.0, created 2026-07-28, single maintainer.
- The Qwen integration, its documentation, and its product-experience
  work are complete and committed, with CI green.
- This work currently lives on a feature branch (`presentation-v0.1`),
  not yet merged to `main`.
- No hosted demo, no captured screenshots yet — see
  [`08-demo-assets.md`](08-demo-assets.md) for the honest asset
  inventory.
- Live, authenticated Qwen inference has not personally been observed
  end-to-end — the connectivity and error-handling path is proven live
  against the real DashScope endpoint; the generation path is shared,
  already-proven code, but unexercised specifically for Qwen due to lack
  of a provisioned key.

We're raising this now, at this stage, deliberately — on the strength of
the architecture and a real, working integration, not on manufactured
traction.

## 7. What we're asking for

Five concrete, scoped asks, any subset of which would be valuable on its
own:

1. **API credits** — a small grant (on the order of a few hundred calls)
   to close the one verification gap above (live authenticated
   inference) and to produce the demo recordings and screenshots listed
   as missing in [`08-demo-assets.md`](08-demo-assets.md).
2. **Technical collaboration** — a point of contact on the Model Studio /
   DashScope team to sanity-check the integration (region/endpoint
   choice, error-handling coverage, any DashScope-specific behavior we
   might be missing) before this goes further.
3. **Early access to new Qwen model releases** — so AURA's model-
   discovery-driven dropdown (no hardcoded model list — see
   [`05-qwen-integration-overview.md`](05-qwen-integration-overview.md)
   §3) reflects new tiers as soon as they're available, and we can
   validate them against the adapter promptly.
4. **Joint engineering feedback** — a channel to report anything we learn
   about the compatible-mode API's edge cases from real usage, in case
   it's useful to the Model Studio team.
5. **Developer program participation** — if Alibaba Cloud runs a
   developer/partner program this fits into, we'd like to be considered.

## 8. Contact

See [`13-executive-summary-one-pager.md`](13-executive-summary-one-pager.md)
for the one-page version of this proposal suitable for a first email, and
[`09-outreach-email-initial.md`](09-outreach-email-initial.md)
for the drafted outreach itself.
