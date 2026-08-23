"""Negative controls for parallel operation.

These exist because the migration's first real hazard is not a wrong
translation — it is two backends quietly sharing a port, a home
directory or a scheduler.
"""

from __future__ import annotations

import pytest

from aura_backend.config.settings import (
    SHADOW_DEFAULT_PORT,
    TS_DEFAULT_PORT,
    BackendSelection,
    ParallelOperationError,
    load_settings,
)


def test_default_role_is_shadow_on_a_separate_port_and_home(tmp_path):
    s = load_settings({"AURA_PY_HOME": str(tmp_path / "py")})
    assert s.backend is BackendSelection.TYPESCRIPT
    assert s.shadow_mode is True
    assert s.port == SHADOW_DEFAULT_PORT != TS_DEFAULT_PORT
    assert s.scheduler_enabled is False


def test_python_selection_takes_the_production_port_and_live_home(tmp_path):
    s = load_settings({"AURA_BACKEND": "python", "AURA_HOME": str(tmp_path / "live")})
    assert s.shadow_mode is False
    assert s.port == TS_DEFAULT_PORT
    assert s.home == tmp_path / "live"
    assert s.scheduler_enabled is True


def test_shadow_mode_refuses_the_live_home_directory(tmp_path):
    live = tmp_path / "live"
    with pytest.raises(ParallelOperationError, match="live AURA home"):
        load_settings({"AURA_HOME": str(live), "AURA_PY_HOME": str(live)})


def test_shadow_mode_refuses_the_typescript_port(tmp_path):
    with pytest.raises(ParallelOperationError, match="port"):
        load_settings(
            {"AURA_PY_HOME": str(tmp_path / "py"), "AURA_PY_PORT": str(TS_DEFAULT_PORT)}
        )


def test_shadow_mode_never_runs_the_scheduler(tmp_path):
    s = load_settings({"AURA_PY_HOME": str(tmp_path / "py")})
    assert s.scheduler_enabled is False, "a shadow backend must not fire schedules"
