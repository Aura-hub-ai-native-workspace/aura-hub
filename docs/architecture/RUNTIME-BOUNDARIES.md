# AURA Runtime Boundaries (Phase 1 — explicit, not yet unified)

Three dualities exist by history. Each has a canonical side per use.
Nothing here creates a third implementation of anything.

## Context

- `packages/ai-service/src/context/compose.ts` — **TS runtime context**
  (rich `ContextView`): chat, diagnosis, Home surfaces on `:4319`.
- `backend/aura/central_agent/context.py` — **canonical agent execution
  context** (bounded `ContextBundle` + fenced editor items): every
  Central Agent run on `:4320`, plus per-task briefs for
  `agent.delegate` workers.
- Rule: the renderer assembles neither; editors pass bounded snapshots
  (`editorContext`) treated as untrusted data. Convergence is P9 work;
  until then, do not add a third assembler.

## Providers

- `packages/ai-service/src/provider/` (`RuntimeManager`, 13 adapters,
  encrypted BYOAK store) — **TS runtime**, user-configured keys.
- `backend/aura/central_agent/model_routing.py` (`RoutedModelPort`,
  operator `providers.json` + env keys at call time) — **agent
  runtime**. Keys are never persisted, logged, or bridged between
  stores.
- Operator configures the agent model via `~/.aura/agent/providers.json`
  (see `model_routing.load_providers`); absence means honest
  heuristic degradation, never silent fallback.

## Workflows

- TS `mission/execution` + `workflow/` on `:4319` — **active runtime
  for Mission Control / Automation Studio**.
- Python `backend/aura/workflow/` + automation + scheduler — **ported
  substrate** backing agent `agent.delegate` legs and verification.
- Do not rewrite either in Phase 1. Unification needs a per-surface
  retirement plan (see audit G-roadmap L-02).

## API hosts

- `aura.api.server.create_app` — **the one canonical production
  factory** (Starlette).
- `aura.api.build_default_api` — **deprecated** stdlib host kept only
  for `backend/scripts/verify_central_agent.py`; emits
  `DeprecationWarning`.
