"""Backend selection and parallel-operation guards.

The TypeScript and Python backends may exist simultaneously during the
migration, and must never compete for the same port, files, schedulers or
workers. This module is the single place that decides which role this
process plays.
"""

from __future__ import annotations

import os
from enum import Enum
from pathlib import Path

from pydantic import BaseModel

# The TypeScript service's defaults (reference: packages/ai-service/src/start.ts).
TS_DEFAULT_PORT = 4319
SHADOW_DEFAULT_PORT = 4321


class BackendSelection(str, Enum):
    TYPESCRIPT = "typescript"
    PYTHON = "python"


class ParallelOperationError(RuntimeError):
    """Raised when a configuration would let both backends compete."""


class Settings(BaseModel):
    backend: BackendSelection
    port: int
    home: Path
    # The scheduler must run in at most one backend. Only the selected
    # production backend may fire schedules.
    scheduler_enabled: bool

    @property
    def shadow_mode(self) -> bool:
        return self.backend is not BackendSelection.PYTHON


def _live_home(env: dict[str, str]) -> Path:
    # Mirrors the TypeScript service's home resolution; AURA_HOME overrides.
    raw = env.get("AURA_HOME")
    return Path(raw).expanduser() if raw else Path.home() / ".aura"


def load_settings(env: dict[str, str] | None = None) -> Settings:
    """Resolve this process's role from the environment.

    - AURA_BACKEND=python  → production role: bind AI_PORT (4319), use the
      live AURA home, scheduler enabled.
    - otherwise            → shadow role: bind AURA_PY_PORT (4321), use
      AURA_PY_HOME (~/.aura-py), scheduler disabled. Refuses to point at
      the live home while the TypeScript backend is the selected one.
    """
    env = dict(os.environ) if env is None else env
    backend = BackendSelection(env.get("AURA_BACKEND", "typescript").strip().lower())
    live_home = _live_home(env)

    if backend is BackendSelection.PYTHON:
        port = int(env.get("AI_PORT", TS_DEFAULT_PORT))
        return Settings(backend=backend, port=port, home=live_home, scheduler_enabled=True)

    port = int(env.get("AURA_PY_PORT", SHADOW_DEFAULT_PORT))
    raw_home = env.get("AURA_PY_HOME")
    home = Path(raw_home).expanduser() if raw_home else Path.home() / ".aura-py"
    if home.resolve() == live_home.resolve():
        raise ParallelOperationError(
            "Shadow mode must not use the live AURA home directory "
            f"({live_home}). Set AURA_BACKEND=python for a production run, "
            "or point AURA_PY_HOME somewhere else."
        )
    if port == int(env.get("AI_PORT", TS_DEFAULT_PORT)):
        raise ParallelOperationError(
            "Shadow mode must not bind the TypeScript backend's port "
            f"({port}). Set AURA_PY_PORT to a different port."
        )
    return Settings(backend=backend, port=port, home=home, scheduler_enabled=False)
