# AURA Hub backend — Python implementation

This directory is the **parallel Python implementation** of the AURA Hub
backend. The TypeScript service (`packages/ai-service` + `packages/capability-fabric`
+ `packages/automation` + `packages/connected-environment`) remains the
**behavioral reference implementation** until cutover. Do not delete or modify
the TypeScript backend from this effort.

Status and per-subsystem parity live in
[`../docs/PYTHON_BACKEND_MIGRATION_MAP.md`](../docs/PYTHON_BACKEND_MIGRATION_MAP.md).

## Parallel-operation rules

Two backends must never compete for the same port, files, schedulers or
workers. The rules, enforced in `aura_backend.config`:

- `AURA_BACKEND` selects the production backend: `typescript` (default) or
  `python`.
- When `AURA_BACKEND=python`, the Python server binds `AI_PORT` (default 4319)
  and uses the real AURA home directory.
- When `AURA_BACKEND` is anything else, the Python server runs in **shadow
  mode**: it binds `AURA_PY_PORT` (default 4321) and uses a separate data
  directory (`AURA_PY_HOME`, default `~/.aura-py`). It will refuse to start
  pointed at the live data directory while in shadow mode.
- The Python server never kills a foreign process holding its port — it
  refuses the port, mirroring the desktop shell's rule.
- The scheduler (automation) runs in at most one backend: whichever
  `AURA_BACKEND` names. Shadow mode never fires schedules against live data.

## Run

```bash
cd backend
uv venv && uv pip install -e '.[dev]'
uv run python -m aura_backend            # shadow mode on :4321 by default
uv run pytest                            # unit + negative-control tests
```

## Layout

```
backend/src/aura_backend/
    config/        settings, backend selection, parallel-operation guards
    core/          errors, atomic JSON persistence, ids, redaction
    api/           HTTP app factory, routes (contract-compatible with TS)
    ...            one package per migrated subsystem (see migration map)
```

Every subsystem follows: AUDIT → IMPLEMENT → TEST → NEGATIVE CONTROL →
RUNTIME VERIFY → PARITY CHECK → DOCUMENT. BUILT ≠ VERIFIED.
