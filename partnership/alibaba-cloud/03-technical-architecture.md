# AURA Hub — Technical Architecture Overview

*Prepared for technical partnership discussion with Alibaba Cloud.*
*Repository: `Aura-hub-ai-native-workspace/aura-hub` (public, Apache-2.0).*

## 1. What AURA Hub is

AURA Hub is an **AI-native engineering workspace** — a desktop application
(Tauri v2 + React) paired with a local AI orchestration service (Node.js)
that gives a developer a single environment combining: an AI assistant
grounded in the real structure of their codebase, a visual workflow
automation engine, multi-step autonomous task execution (Mission
Control), a persistent engineering memory, and rule-based engineering
governance (health scoring, diagnosis) — all running against the
developer's own project, with **no built-in AI model**. Every AI
capability is bring-your-own-key (BYOAK): the platform has no
intelligence until the user connects a provider.

## 2. High-level architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Desktop App (apps/desktop) — Tauri v2 shell, React + Vite       │
│  Editor (Monaco) · Workflow Canvas · Mission Control · Knowledge │
│  Graph View · Engineering Governance · Settings                 │
└───────────────────────────┬───────────────────────────────────┘
                             │ HTTP + Server-Sent Events (localhost)
┌───────────────────────────▼───────────────────────────────────┐
│  AI Service (packages/ai-service) — Node.js, flat http router    │
│  ┌───────────────┐ ┌────────────────┐ ┌────────────────────┐  │
│  │ Provider       │ │ Pipeline        │ │ Workflow Engine     │  │
│  │ Runtime Manager│ │ (ask/generate/  │ │ (nodes, execution,  │  │
│  │ + Credential   │ │  streamEvents)  │ │  AI-assisted graph  │  │
│  │ Store (AES-256)│ │ retry/timeout/  │ │  generation)        │  │
│  │                │ │ error translate │ │                      │  │
│  └───────┬────────┘ └────────┬────────┘ └──────────┬──────────┘  │
│          │                   │                       │            │
│  ┌───────▼───────────────────▼───────────────────────▼────────┐  │
│  │  11 Provider Adapters (one shared interface)                 │  │
│  │  OpenAI · Anthropic · Gemini · Groq · Mistral · Cerebras ·   │  │
│  │  Kimi · NVIDIA · OpenRouter · Novita · Qwen                  │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Knowledge Engines — Coding KE, FullStack KE, Engineering    │  │
│  │  Memory, Engineering Learning, Governance/Diagnosis           │  │
│  └────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
                             │
                    Real project on disk (AST-parsed → graph)
```

## 3. The provider abstraction — why it matters for a partner

Every AI provider implements one interface:

```ts
interface ProviderAdapter {
  readonly metadata: ProviderMetadata;
  detect(apiKey: string): boolean;
  validate(apiKey: string): Promise<{ ok: boolean; error?: string }>;
  discoverModels(apiKey: string): Promise<DiscoveredModel[]>;
  createRuntime(apiKey: string, model?: string): Runtime;
  checkHealth(apiKey: string): Promise<ProviderHealth>;
}
```

Most OpenAI-compatible providers (including Qwen) need **zero method
overrides** beyond declaring their base URL and default model — a shared
base class (`BaseOpenAICompatible`) implements validation, model
discovery, health checks, streaming, retry-eligible error classification,
and timeout handling once. No feature, panel, or workflow node in the
product ever branches on a provider id. This is a structural guarantee,
not a convention: adding a new OpenAI-compatible provider is a
single ~20-line file plus a one-line registry entry, and it is
automatically available in every AI surface of the product — chat,
inline code actions, the workflow builder, automation templates, mission
planning, and engineering diagnosis — simultaneously.

**This is the property that made integrating Qwen a clean, first-class
addition rather than a bolt-on** — see
[`05-qwen-integration-overview.md`](05-qwen-integration-overview.md).

## 4. The workflow / automation engine

A workflow is a directed graph of typed nodes: source nodes (real
project files, git diff, memory), intelligence nodes (the Coding/
FullStack knowledge engines), generation nodes (routed through the
active provider), logic nodes (condition/loop/delay), and action nodes
(save memory, write a file, run a shell command, HTTP request). Nothing
in a workflow is simulated — every node executes for real against the
open project. The AI Workflow Builder turns a natural-language
description into one of these graphs directly, using the same
provider-agnostic generation path.

## 5. Knowledge and memory layers

- **Knowledge Graph** — an AST-derived structural graph of the codebase
  (god nodes, community detection, cross-file relationships), used to
  ground AI answers in real code rather than free-floating context.
- **Engineering Memory** — a persistent record of real engineering events
  (decisions, patterns, learnings), so the assistant's understanding
  compounds across sessions instead of resetting every conversation.
- **Engineering Governance** — deterministic, rule-based health scoring
  and drift detection layered on top of memory; the model's role is
  narrowed to explaining causes and drafting patches, not inventing
  scores.

## 6. Security & key handling

API keys are never sent to any AURA-operated server — there is none.
Keys are encrypted at rest (AES-256-GCM) in a local store and only a
fingerprint (first 4 / last 4 characters) is ever surfaced in the UI.

## 7. Current maturity — stated plainly

This is an early-stage, single-maintainer project (repository created
2026-07-28). The work described above is real and runs today, but it
currently lives on a feature branch (`presentation-v0.1`) that has not
yet been merged to `main`; there is no hosted demo and no publicly
captured screenshot set yet. We are raising this architecture for
technical discussion on its merits, not on traction — see
[`01-partnership-proposal.md`](01-partnership-proposal.md) for the
honest framing of where this stands and what we're asking for.
