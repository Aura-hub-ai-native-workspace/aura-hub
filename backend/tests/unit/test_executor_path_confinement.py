"""document.ingest and artifact.generate stay inside the project (F-19).

With the human approval step gone, a capability that auto-executes must be safe
at its own boundary. Two were not:

- document.ingest took any path: it ingested files outside the project
  (credentials included) into the knowledge base, where knowledge.search
  returns them to the model;
- artifact.generate wrote generated document bytes to any `output_path`,
  overwriting any file the process could write.

The default artifact location (the AURA artifacts folder) needs no project and
is unchanged. Everything here uses temporary directories.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

SECRET = "OUTSIDE-SECRET-TOKEN-4242"


def _inv(params: dict, cwd: str | None = None) -> dict:
    return {"input": params, "context": {"cwd": cwd or "", "projectId": "proj-test"}}


@pytest.fixture()
def world(tmp_path):
    from aura.executors import multimodal_executors
    from aura.knowledge.store import KnowledgeBase

    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "notes.txt").write_text("Inside the project: quarterly planning notes.")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text(f"credential = {SECRET}")
    os.symlink(outside, proj / "link-out")
    kb = KnowledgeBase(store_dir=tmp_path / "knowledge")
    adapters = {a.capabilityId: a for a in multimodal_executors(kb, tmp_path / "artifacts")}
    return adapters, kb, proj, outside


def _ingest(adapters, proj, path):
    return adapters["document.ingest"].run(_inv({"path": path}, cwd=str(proj)))


# ── document.ingest ────────────────────────────────────────────────────────

async def test_a_file_inside_the_project_is_ingested_by_relative_or_absolute_path(world):
    adapters, _, proj, _ = world
    for path in ("notes.txt", str(proj / "notes.txt")):
        result = await _ingest(adapters, proj, path)
        assert result["ok"], result


@pytest.mark.parametrize("where", ["absolute-outside", "parent", "symlink", "tilde"])
async def test_a_file_outside_the_project_is_refused_and_never_indexed(world, where):
    adapters, kb, proj, outside = world
    path = {"absolute-outside": str(outside / "secret.txt"),
            "parent": "../outside/secret.txt",
            "symlink": "link-out/secret.txt",
            "tilde": "~/secret.txt"}[where]
    before = len(kb.list_documents()) if hasattr(kb, "list_documents") else None
    result = await _ingest(adapters, proj, path)
    assert result["ok"] is False
    assert "leaves the project directory" in result["detail"]
    if before is not None:
        assert len(kb.list_documents()) == before
    search = await adapters["knowledge.search"].run(_inv({"query": SECRET}, cwd=str(proj)))
    assert search["output"]["results"] == []    # the secret cannot come back through search


async def test_nothing_is_ingested_without_a_project_directory(world):
    adapters, _, _, outside = world
    result = await adapters["document.ingest"].run(_inv({"path": str(outside / "secret.txt")}))
    assert result["ok"] is False
    assert "Open a project first" in result["detail"]


# ── artifact.generate ──────────────────────────────────────────────────────

SPEC = {"artifact_type": "docx", "title": "Note", "sections": [{"heading": "H", "body": "B"}]}


@pytest.fixture()
def docx():
    pytest.importorskip("docx")


async def test_an_artifact_can_be_written_inside_the_project(world, docx):
    adapters, _, proj, _ = world
    for relative in ("note.docx", "reports/note.docx"):  # the folder need not exist yet
        result = await adapters["artifact.generate"].run(
            _inv({"spec": SPEC, "output_path": relative}, cwd=str(proj)))
        assert result["ok"], result
        assert (proj / relative).stat().st_size > 100


@pytest.mark.parametrize("where", ["absolute-outside", "parent", "symlink", "overwrite-existing"])
async def test_an_artifact_is_never_written_outside_the_project(world, docx, where):
    adapters, _, proj, outside = world
    victim = outside / "important.cfg"
    victim.write_text("do not overwrite")
    target = {"absolute-outside": str(outside / "new.docx"),
              "parent": "../outside/new.docx",
              "symlink": "link-out/new.docx",
              "overwrite-existing": str(victim)}[where]
    result = await adapters["artifact.generate"].run(
        _inv({"spec": SPEC, "output_path": target}, cwd=str(proj)))
    assert result["ok"] is False
    assert "leaves the project directory" in result["detail"]
    assert not (outside / "new.docx").exists()
    assert victim.read_text() == "do not overwrite"


async def test_a_chosen_output_path_needs_a_project_directory(world, docx):
    adapters, _, _, outside = world
    result = await adapters["artifact.generate"].run(
        _inv({"spec": SPEC, "output_path": str(outside / "x.docx")}))
    assert result["ok"] is False
    assert not (outside / "x.docx").exists()


async def test_the_default_artifact_location_needs_no_project(world, docx, tmp_path):
    adapters, _, _, _ = world
    result = await adapters["artifact.generate"].run(_inv({"spec": SPEC}))
    assert result["ok"], result
    assert Path(result["output"]["path"]).parent == tmp_path / "artifacts"
