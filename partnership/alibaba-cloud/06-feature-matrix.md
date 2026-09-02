# AURA Hub — Feature Matrix

All rows below describe code that exists and runs in the repository today
(`Aura-hub-ai-native-workspace/aura-hub`, branch `presentation-v0.1`), not
roadmap items, unless explicitly marked **Planned**.

| Capability | What it does | Status |
|---|---|---|
| Multi-provider AI runtime (BYOAK) | 11 providers behind one shared adapter interface — OpenAI, Anthropic, Gemini, Groq, Mistral, Cerebras, Kimi, NVIDIA, OpenRouter, Novita, **Qwen**. No built-in model; nothing AI-related works until a user connects their own key. | Shipped |
| Provider validation & error translation | Every provider's raw HTTP failures are classified into stable categories (auth, billing, rate limit, network, model, server error) with friendly, provider-labeled messages — shared logic, zero per-provider branching. | Shipped |
| Retry & timeout | Capped exponential backoff on retryable failures; configurable timeout, shared across every provider and every AI entry point. | Shipped |
| Streaming | Token-level SSE streaming for chat and generation, shared runtime class. | Shipped |
| AI Chat ("Ask AURA") | Conversational assistant grounded in the open project's real knowledge graph and memory — not a bare LLM wrapper. | Shipped |
| Ctrl+I inline code actions | In-editor, selection-scoped AI edits with inline diff review. | Shipped |
| AI Workflow Builder | Natural language → a real, executable node graph on the automation canvas. | Shipped |
| Automation Studio | Visual node-based workflow engine; 10 real starter templates (code review, security audit, bug investigation, dependency analysis, release notes, and more). | Shipped |
| Mission Control | Multi-step engineering task planning and execution with dependency-aware (DAG) task ordering and a replay timeline. | Shipped |
| Knowledge Graph | AST-derived structural graph of a codebase — god nodes, community clustering, cross-file relationships — queryable, not just visual. | Shipped |
| Architecture Blueprint | Layered module/dependency view distinct from the raw knowledge graph. | Shipped |
| Engineering Memory | Persistent record of real engineering events (decisions, patterns, learnings) that inform future answers — not per-session amnesia. | Shipped |
| Engineering Governance / Intelligence | Rule-based health scoring, drift detection, and diagnosis (root cause, patch generation, review) layered on top of Engineering Memory. | Shipped |
| Floating multi-window workspace | A tiled/floating "second desktop" model for working across panels simultaneously. | Shipped |
| Desktop app | Tauri v2 native shell (macOS/Windows/Linux) around a React/Vite frontend. | Shipped |
| CI | GitHub Actions — typecheck + build gate on every push/PR. | Shipped, green |
| Public release on `main` | Current work lives on a feature branch, not yet merged to `main`. | **Not yet done** |
| Captured product screenshots | A full shot list and capture spec exist (`docs/assets/screenshots/SCREENSHOT_GUIDE.md`); no images have been captured yet. | **Not yet done** |
| Hosted/live demo | None — the app runs locally today (`npm run dev` + `npm run ai`, or a Tauri build). | **Not yet done** |

## Where Qwen sits in this matrix

Qwen has the exact same row-for-row standing as OpenAI, Anthropic, or any
other provider above — chat, streaming, retry, timeout, error
translation, model discovery, health checks, and every AI surface
(Chat, Ctrl+I, Workflow Builder, Automation Studio, Mission Control,
Engineering Intelligence) all work through it identically. See
[`05-qwen-integration-overview.md`](05-qwen-integration-overview.md) for
detail.
