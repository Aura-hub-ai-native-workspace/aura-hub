"""Real-time governed worker execution — AURA-side authority core.

AURA governs externally actionable worker operations, never private
model reasoning. The enforcement points live in the worker runtimes
themselves (opencode permission config + `tool.execute.before` plugin
deny; claude tool allow-list + directory confinement + PreToolUse
hooks), all AUTHORED per-invocation by AURA from the task contract.
This package is the deterministic core both sides share:

- actions.py: WorkerActionRequest/Event + decide_action (pure,
  deterministic, no model, no I/O) — the same logic compiled into
  worker plugins/hooks and evaluated by AURA when ingesting logs.
- opencode.py: per-invocation config + governance plugin compiler.
- claude.py: per-invocation settings + directory confinement compiler.

Nothing here grants authority: it only restates the task contract
(scope, cwd, allow-lists) as per-action ALLOW/DENY verdicts.
Post-execution snapshot/delta verification is untouched and still runs.
"""
