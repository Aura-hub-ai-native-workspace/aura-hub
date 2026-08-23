"""Negative controls for the Context Fabric.

The differential proves the port agrees with the reference. These prove
the properties the Context Fabric exists to hold, stated as things that
must NOT happen:

* it never invents a fact,
* it never mixes two projects,
* it never writes, mounts, spawns or indexes,
* it never carries a secret,
* and `unknown` never reads as `empty`.
"""

from __future__ import annotations

import inspect
import json
import os
from pathlib import Path

import pytest

from aura_backend.context import (
    ComposeOptions,
    ContextSources,
    EnvironmentSnapshot,
    compose_context_view,
    is_unavailable,
    render_context_contract,
    render_context_header,
)
from aura_backend.context.compose import _project_activity, _project_capabilities
from aura_backend.context.types import ContextGit, ContextUnavailable
from aura_backend.intelligence import MissionReader, compute_identity_fingerprint
from aura_backend.workspace.projects import ProjectRegistry


@pytest.fixture
def home(tmp_path: Path) -> Path:
    return tmp_path / "home"


def _register(home: Path, project_id: str, root: Path, name: str = "P") -> None:
    home.mkdir(parents=True, exist_ok=True)
    file = home / "projects.json"
    existing = json.loads(file.read_text()) if file.exists() else []
    existing.append({
        "id": project_id, "name": name, "path": str(root),
        "type": "unknown", "language": "unknown",
        "createdAt": "2026-01-01T00:00:00.000Z", "lastOpenedAt": None,
    })
    file.write_text(json.dumps(existing))


def _sources(home: Path, **kw) -> ContextSources:
    return ContextSources(
        registry=ProjectRegistry(home), missions=MissionReader(home), home=home, **kw
    )


def _compose(home: Path, project_id: str = "p1", **kw):
    options = ComposeOptions(include_git=False, **kw)
    return compose_context_view(project_id, _sources(home), options)


# ── nothing is invented ──────────────────────────────────────────────

def test_an_unregistered_project_yields_unavailable_not_an_empty_view(home: Path) -> None:
    home.mkdir(parents=True)
    result = _compose(home, "never-registered")
    assert isinstance(result, ContextUnavailable)
    assert is_unavailable(result)
    assert "never-registered" in result.to_json()["reason"]
    # There is no view to mistake for an empty one.
    assert "project" not in result.to_json()


def test_an_unindexed_project_reports_unknown_not_empty(home: Path, tmp_path: Path) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    view = _compose(home)
    for section in (view.repository, view.changes, view.git, view.environment):
        assert section.freshness == "unknown"
        assert section.value is None
        assert section.reason, "an unknown section must say why"


def test_the_contract_renders_unknown_and_omits_empty(home: Path, tmp_path: Path) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    text = render_context_contract(_compose(home))
    # Never computed: said out loud, with the reason.
    assert "<REPOSITORY_CONTEXT>\nunknown: the repository has not been indexed yet" in text
    # Computed and genuinely empty: left out entirely. `missions` is
    # `fresh` with `[]`, and an empty ACTIVE_MISSIONS block would read as
    # a claim rather than an absence.
    assert view_has_no_block(text, "ACTIVE_MISSIONS")
    assert "unknown: not established" not in text


def view_has_no_block(text: str, tag: str) -> bool:
    return f"<{tag}>" not in text


def test_a_missing_version_history_is_null_not_zero(home: Path, tmp_path: Path) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    view = _compose(home)
    assert view.context_version is None
    assert "context_version: none recorded" in render_context_contract(view)
    assert "v— " in render_context_header(view) or "v—" in render_context_header(view)


def test_a_corrupt_artifact_becomes_unknown_not_content(home: Path, tmp_path: Path) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    for sub in ("identity", "summaries", "repo-profile", "health", "versions"):
        (home / sub).mkdir(parents=True)
        (home / sub / "p1.json").write_text("{ not json at all")
    view = _compose(home)
    assert view.repository.freshness == "unknown"
    assert view.context_version is None


# ── one project, never two ───────────────────────────────────────────

def test_change_history_is_not_borrowed_from_a_sibling(home: Path, tmp_path: Path) -> None:
    root = tmp_path / "project"
    sibling = tmp_path / "project-sibling"
    root.mkdir()
    sibling.mkdir()
    _register(home, "p1", root)
    (home / "changes").mkdir(parents=True)
    (home / "changes" / "log.json").write_text(json.dumps({
        "entries": [{"file": str(sibling / "a.ts"), "timestamp": "2026-06-01T00:00:00.000Z"}] * 5,
        "patterns": [], "generatedAt": "2026-06-01T00:00:00.000Z",
    }))
    view = _compose(home)
    # A bare prefix match would have claimed all five.
    assert view.changes.value["hotspots"] == []
    assert view.changes.value["velocity"] == 0


def test_relative_change_entries_are_unknown_not_empty(home: Path, tmp_path: Path) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    (home / "changes").mkdir(parents=True)
    (home / "changes" / "log.json").write_text(json.dumps({
        "entries": [{"file": "src/a.ts", "timestamp": "2026-06-01T00:00:00.000Z"}],
        "patterns": [], "generatedAt": "2026-06-01T00:00:00.000Z",
    }))
    view = _compose(home)
    assert view.changes.freshness == "unknown"
    assert "cannot be attributed" in view.changes.reason


def test_missions_of_another_project_are_never_listed(home: Path, tmp_path: Path) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    other = home / "missions" / "p2"
    other.mkdir(parents=True)
    (other / "m.json").write_text(json.dumps({
        "id": "m", "projectId": "p2", "text": "not mine",
        "createdAt": "2026-01-01T00:00:00.000Z",
    }))
    assert _compose(home).missions.value == []


# ── read-only, by construction ───────────────────────────────────────

def test_composing_writes_nothing_into_the_home(home: Path, tmp_path: Path) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    before = {p: p.stat().st_mtime_ns for p in sorted(home.rglob("*")) if p.is_file()}
    for _ in range(3):
        render_context_contract(_compose(home))
    after = {p: p.stat().st_mtime_ns for p in sorted(home.rglob("*")) if p.is_file()}
    # The mission directory is created on read — the reference mkdirs too —
    # but no FILE may be written or rewritten.
    assert before == after


def test_composing_never_touches_the_project_directory(home: Path, tmp_path: Path) -> None:
    root = tmp_path / "p"
    root.mkdir()
    (root / "a.txt").write_text("x")
    _register(home, "p1", root)
    before = sorted((p.name, p.stat().st_mtime_ns) for p in root.rglob("*"))
    _compose(home)
    assert sorted((p.name, p.stat().st_mtime_ns) for p in root.rglob("*")) == before


def test_the_composer_cannot_be_handed_a_directory(home: Path, tmp_path: Path) -> None:
    """A caller names a PROJECT. There is no parameter for a path.

    The same boundary `cwd_for` enforces for execution: if a `root` or
    `cwd` argument is ever added here, this is what should stop it.
    """
    parameters = set(inspect.signature(compose_context_view).parameters)
    assert parameters == {"project_id", "sources", "options"}
    assert not {"root", "cwd", "path", "directory"} & set(
        inspect.signature(ComposeOptions).parameters
    )


def test_composing_does_not_scan_the_environment(home: Path, tmp_path: Path) -> None:
    """The snapshot is supplied. Nothing here can start a probe."""
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    import ast

    module = __import__("aura_backend.context.compose", fromlist=["x"])
    tree = ast.parse(inspect.getsource(module))
    # Names actually referenced by CODE — prose in the docstrings talks
    # about scanning, and a substring search would fail on that instead
    # of on a real call.
    referenced = {
        node.id for node in ast.walk(tree) if isinstance(node, ast.Name)
    } | {
        node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
    }
    forbidden = {
        "scan", "scan_environment", "Popen", "run", "subprocess", "spawn",
        "save_policy", "create_version", "write_text", "mkdir", "open",
    }
    assert not (referenced & forbidden), (
        f"compose.py references {sorted(referenced & forbidden)}"
    )
    # And it must not reach for any generator, only loaders.
    assert not {n for n in referenced if n.startswith(("generate_", "build_", "save_"))}


def test_an_unscanned_environment_is_unknown_rather_than_a_bare_machine(
    home: Path, tmp_path: Path
) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    sources = _sources(home, environment=EnvironmentSnapshot(scanned_at=None))
    view = compose_context_view("p1", sources, ComposeOptions(include_git=False))
    assert view.environment.freshness == "unknown"
    # Not "this machine has no tools" — nobody looked.
    assert view.environment.value is None


# ── no secret, ever ──────────────────────────────────────────────────

def test_no_environment_variable_reaches_the_context(home: Path, tmp_path: Path) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    os.environ["AURA_TEST_FAKE_SECRET"] = "sk-live-never-in-a-context"
    try:
        snapshot = EnvironmentSnapshot(
            scanned_at="2026-06-01T00:00:00.000Z",
            nodes=[{"id": "git", "name": "Git", "capabilities": ["vcs"], "version": "2.45"}],
            provided_capabilities=["vcs"],
        )
        view = compose_context_view(
            "p1", _sources(home, environment=snapshot), ComposeOptions(include_git=False)
        )
        rendered = json.dumps(view.to_json()) + render_context_contract(view)
        assert "sk-live-never-in-a-context" not in rendered
        assert "AURA_TEST_FAKE_SECRET" not in rendered
    finally:
        del os.environ["AURA_TEST_FAKE_SECRET"]


def test_a_fabricless_service_reports_unknown_rather_than_no_capabilities() -> None:
    """Absent authority is not an authority saying no."""
    section = _project_capabilities(None, "p1", "/tmp")
    assert section.freshness == "unknown"
    assert section.value is None
    assert "not attached" in section.reason
    activity = _project_activity(None, "p1", 10)
    assert activity.freshness == "unknown" and activity.value is None


# ── stale is never silent ────────────────────────────────────────────

def test_a_changed_fingerprint_marks_identity_stale_and_says_so(
    home: Path, tmp_path: Path
) -> None:
    root = tmp_path / "p"
    root.mkdir()
    (root / "package.json").write_text("{}")
    _register(home, "p1", root)
    (home / "identity").mkdir(parents=True)
    (home / "identity" / "p1.json").write_text(json.dumps({
        "id": "p1", "generatedAt": "2099-01-01T00:00:00.000Z",
        "fingerprint": "a-fingerprint-that-does-not-match",
        "repositoryType": "application", "architectureStyle": "layered",
        "purpose": "", "primaryLanguage": "TypeScript", "buildSystem": None,
        "frameworks": [], "entryPoints": [],
    }))
    view = _compose(home)
    assert view.freshness == "stale"
    text = render_context_contract(view)
    assert "[STALE: the project fingerprint changed]" in text
    # And the agent is told, in the constraints, not only in a header.
    assert any(c.id == "stale-context" for c in view.constraints)


def test_a_matching_fingerprint_is_not_stale(home: Path, tmp_path: Path) -> None:
    root = tmp_path / "p"
    root.mkdir()
    (root / "package.json").write_text("{}")
    _register(home, "p1", root)
    (home / "identity").mkdir(parents=True)
    (home / "identity" / "p1.json").write_text(json.dumps({
        "id": "p1", "generatedAt": "2099-01-01T00:00:00.000Z",
        "fingerprint": compute_identity_fingerprint(str(root)),
        "repositoryType": "application", "architectureStyle": "layered",
        "purpose": "", "primaryLanguage": "TypeScript", "buildSystem": None,
        "frameworks": [], "entryPoints": [],
    }))
    assert _compose(home).freshness == "fresh"


def test_uncommitted_work_is_named_only_when_git_says_so(
    home: Path, tmp_path: Path
) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    clean = compose_context_view(
        "p1", _sources(home),
        ComposeOptions(git=ContextGit("main", False, 0, [])),
    )
    assert not any(c.id == "uncommitted-work" for c in clean.constraints)

    dirty = compose_context_view(
        "p1", _sources(home),
        ComposeOptions(git=ContextGit("main", True, 7, [])),
    )
    warning = next(c for c in dirty.constraints if c.id == "uncommitted-work")
    assert "7 uncommitted change(s)" in warning.text
    assert "Never reset, clean, stash" in warning.text


def test_the_project_boundary_constraint_names_the_registry_root(
    home: Path, tmp_path: Path
) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root, name="Bounded")
    view = _compose(home)
    boundary = next(c for c in view.constraints if c.id == "project-boundary")
    assert str(root) in boundary.text
    assert "Do not read or modify files outside this root" in boundary.text


def test_every_surface_renders_and_none_leaks_another_surface(
    home: Path, tmp_path: Path
) -> None:
    root = tmp_path / "p"
    root.mkdir()
    _register(home, "p1", root)
    view = _compose(home)
    for surface in ("general", "coding", "debugging", "architecture", "git",
                    "testing", "mission", "planning", "review"):
        text = render_context_contract(view, surface)
        assert text.startswith("<PROJECT_CONTEXT>")
        assert "<CONTEXT_CONSTRAINTS>" in text
    # An unrecognised surface falls back to `general` rather than raising
    # or rendering nothing.
    assert render_context_contract(view, "not-a-surface") == render_context_contract(
        view, "general"
    )
