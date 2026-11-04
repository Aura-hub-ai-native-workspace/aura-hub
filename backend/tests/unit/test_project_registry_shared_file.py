"""ProjectRegistry reads the shared projects.json, never a stale startup copy.

The desktop adds and removes projects through the ai-service, which writes the
same AURA_HOME/projects.json. Regression (real desktop, 2026-10-19): after a
removal, the backend still listed the project, and a backend save would have
written the stale list back over the ai-service's file."""

from __future__ import annotations

import json

import pytest

from aura.persistence.projects import ProjectRegistry


def _rec(pid, path):
    return {"id": pid, "name": pid, "path": str(path)}


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    return tmp_path


def _write(home, records):
    (home / "projects.json").write_text(json.dumps(records), encoding="utf-8")


def _read(home):
    return json.loads((home / "projects.json").read_text(encoding="utf-8"))


def test_a_removal_by_the_other_service_is_seen(home, tmp_path):
    _write(home, [_rec("proj-a", tmp_path)])
    registry = ProjectRegistry()
    assert [p["id"] for p in registry.list_projects()] == ["proj-a"]
    _write(home, [])                      # ai-service removed it
    assert registry.list_projects() == []
    assert registry.get("proj-a") is None


def test_a_backend_add_does_not_resurrect_or_drop_projects(home, tmp_path):
    keep = tmp_path / "keep"; keep.mkdir()
    gone = tmp_path / "gone"; gone.mkdir()
    new = tmp_path / "new"; new.mkdir()
    _write(home, [_rec("proj-gone", gone)])
    registry = ProjectRegistry()
    # ai-service: removes proj-gone, adds proj-keep, after this service started.
    _write(home, [_rec("proj-keep", keep)])
    registry.add({"path": str(new)})
    ids = [p["id"] for p in _read(home)]
    assert "proj-gone" not in ids
    assert "proj-keep" in ids
    assert len(ids) == 2


def test_the_open_project_survives_a_refresh_while_registered(home, tmp_path):
    _write(home, [_rec("proj-a", tmp_path)])
    registry = ProjectRegistry()
    registry.open("proj-a")
    assert registry.current_project()["id"] == "proj-a"
    _write(home, [])                      # removed elsewhere
    assert registry.current_project() is None
