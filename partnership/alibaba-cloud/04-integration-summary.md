# Integration Summary

*A one-page technical summary of the Qwen integration, for readers who
want the short version before the full architecture/overview docs.*

**What was integrated:** Qwen (Alibaba Cloud Model Studio / DashScope),
as a first-class, fully-supported AI provider inside AURA Hub — an
AI-native engineering workspace (Tauri desktop app + local Node.js AI
service).

**How:** A single adapter (`qwen.ts`, 47 lines) extending AURA's shared
`BaseOpenAICompatible` class, registered in the provider registry. No
other file in the codebase branches on "is this Qwen" — every AI feature
in the product (chat, in-editor code actions, workflow automation,
multi-step mission execution, engineering diagnosis) works through Qwen
automatically because they all route through the same provider-agnostic
pipeline.

**What was verified:** Base URL, auth scheme, and model id against
Alibaba's own documentation; a live, unauthenticated HTTP request against
the real DashScope international endpoint (401, confirming the route is
real); a full connect-flow round trip through AURA's own server against
the same real endpoint. Typecheck and build are clean; CI is green.

**What wasn't verified (honestly):** live, authenticated chat completion
— no DashScope API key was available in the build environment. The code
path is shared with six other already-working providers, but we have not
personally watched a Qwen token stream back yet.

**Where it stands today:** shipped on a feature branch
(`presentation-v0.1`) in a public repository, not yet merged to `main`.
Full documentation (setup guide, model selection, troubleshooting,
architecture reference) and product-experience work (onboarding card,
demo scripts) are complete and committed alongside the adapter.

**Repository:** `github.com/Aura-hub-ai-native-workspace/aura-hub`
(public, Apache-2.0).

**What we're asking Alibaba Cloud for:** see
[`01-partnership-proposal.md`](01-partnership-proposal.md).
