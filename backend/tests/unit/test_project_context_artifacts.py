"""Project context artifacts — the requested project's understanding.

The workspace submits the registry's projectId, and the agent attaches
that project's ALREADY-DERIVED understanding (identity + module
summary, persisted by the Ask AURA pipeline under the shared AURA
home). Keyed by the requested id, never by a mount; a project AURA
knows nothing about is announced as unavailable rather than invented.

Run with `python3 -m pytest backend/tests/unit/test_project_context_artifacts.py`.
"""

from __future__ import annotations

import json
import os

import pytest

from aura.central_agent.context import (
    PROVENANCE_EXTERNAL,
    PROVENANCE_SYSTEM,
    ContextAssembler,
    load_project_artifacts,
)


@pytest.fixture()
def home(tmp_path):
    (tmp_path / "identity").mkdir()
    (tmp_path / "summaries").mkdir()
    (tmp_path / "identity" / "shop.json").write_text(json.dumps({
        "purpose": "demo shop",
        "repositoryType": "library",
        "primaryLanguage": "TypeScript",
        "entryPoints": ["src/index.ts"],
    }), encoding="utf-8")
    (tmp_path / "summaries" / "shop.json").write_text(json.dumps({
        "purpose": "demo shop",
        "modules": [{"name": "cart"}, {"name": "pay"}],
        "totalFiles": 12,
    }), encoding="utf-8")
    return tmp_path


def assembler(home, scan=None):
    return ContextAssembler(
        project_scanner=(scan or (lambda path: [])),
        project_artifacts=(lambda pid: load_project_artifacts(pid, home=home)))


class TestArtifactLoading:
    def test_identity_and_summary_load_by_id(self, home) -> None:
        artifacts = load_project_artifacts("shop", home=home)
        assert artifacts is not None
        assert artifacts["identity"]["purpose"] == "demo shop"
        assert artifacts["summary"]["totalFiles"] == 12

    def test_unknown_id_yields_nothing(self, home) -> None:
        assert load_project_artifacts("ghost", home=home) is None

    def test_garbage_file_yields_nothing(self, home) -> None:
        (home / "identity" / "bad.json").write_text("{not json", encoding="utf-8")
        assert load_project_artifacts("bad", home=home) is None

    def test_never_raises(self, home) -> None:
        assert load_project_artifacts("", home=home) is None
        assert load_project_artifacts("shop", home="/nonexistent") is None


class TestBundleGrounding:
    def test_requested_project_attaches_its_understanding(self, home) -> None:
        bundle = assembler(home).assemble(project_id="shop")
        project_items = [i for i in bundle.items if i.kind == "project"]
        assert len(project_items) == 2
        assert all(i.provenance == PROVENANCE_EXTERNAL and i.untrusted
                   for i in project_items)
        text = "\n".join(i.text for i in project_items)
        assert "demo shop" in text and "src/index.ts" in text
        assert "cart" in text
        assert not any("unavailable" in i.text for i in bundle.items)

    def test_other_projects_stay_out(self, home) -> None:
        (home / "identity" / "other.json").write_text(json.dumps({
            "purpose": "a different project entirely",
        }), encoding="utf-8")
        bundle = assembler(home).assemble(project_id="shop")
        assert "different project" not in bundle.render()

    def test_unknown_project_is_announced_not_invented(self, home) -> None:
        bundle = assembler(home).assemble(project_id="ghost")
        assert not [i for i in bundle.items if i.kind == "project"]
        notes = [i for i in bundle.items if "unavailable" in i.text]
        assert len(notes) == 1
        assert notes[0].provenance == PROVENANCE_SYSTEM
        assert "ghost" in notes[0].text

    def test_scan_findings_alone_count_as_grounded(self, home) -> None:
        bundle = assembler(home, scan=lambda p: ["top level: src/"]).assemble(
            project_id="ghost", project_path="/tmp/shop")
        assert any(i.kind == "project" for i in bundle.items)
        assert not any("unavailable" in i.text for i in bundle.items)

    def test_no_project_means_no_note(self, home) -> None:
        assert assembler(home).assemble().items == []

    def test_misshapen_fields_are_skipped_not_fatal(self, home) -> None:
        (home / "identity" / "odd.json").write_text(json.dumps({
            "purpose": ["not", "a", "string"], "entryPoints": "nope",
        }), encoding="utf-8")
        bundle = assembler(home).assemble(project_id="odd")
        # Nothing usable: the honest outcome is the unavailable note.
        assert any("unavailable" in i.text for i in bundle.items)

    def test_render_fences_project_content(self, home) -> None:
        bundle = assembler(home).assemble(project_id="shop")
        assert "<untrusted-data" in bundle.render()
