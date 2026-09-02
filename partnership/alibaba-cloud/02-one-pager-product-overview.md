# AURA Hub — One-Page Product Overview

**What it is.** AURA Hub is an AI-native engineering workspace — a
desktop application that pairs a code editor with an AI assistant that
actually understands the codebase it's sitting in: a real, AST-derived
knowledge graph of the project, a persistent memory of engineering
decisions, and a rule-based governance layer, all feeding a model the
developer chooses and connects with their own API key.

**Why it's different.** Most AI coding tools either bundle one model
provider or bolt AI onto an editor as an afterthought. AURA is built the
opposite way: no built-in model at all (bring-your-own-key, 11 providers
supported behind one shared interface — including Qwen), and every AI
answer is grounded in a real structural graph of the actual code, not
just a context window of recently-opened files.

**Core capabilities.**
- **AI Chat** grounded in the project's real knowledge graph and memory.
- **Ctrl+I** inline, in-editor code actions.
- **AI Workflow Builder** — natural language → a real, executable
  automation graph.
- **Automation Studio** — a visual workflow engine with 10 real starter
  templates (code review, security audit, dependency analysis, etc.).
- **Mission Control** — multi-step engineering task planning and
  execution with dependency-aware ordering.
- **Knowledge Graph & Architecture Blueprint** — structural understanding
  of the codebase, not just text search.
- **Engineering Memory & Governance** — decisions and patterns persist
  across sessions; health scoring and diagnosis are rule-based, with the
  model narrowed to explaining and drafting, not inventing numbers.

**Stack.** Tauri v2 (desktop shell) + React/Vite (frontend) + Node.js
(local AI orchestration service), TypeScript throughout, Monaco editor.

**Stage.** Early. Repository created 2026-07-28, single maintainer,
public, Apache-2.0 licensed. Substantial, working, CI-green codebase on
a feature branch not yet merged to `main`. No hosted demo or captured
screenshots yet. We are pursuing this partnership on the strength of the
architecture and the Qwen integration's technical merit, not on
traction — see [`01-partnership-proposal.md`](01-partnership-proposal.md)
for the full, honest picture.

**Repository:** `github.com/Aura-hub-ai-native-workspace/aura-hub`
