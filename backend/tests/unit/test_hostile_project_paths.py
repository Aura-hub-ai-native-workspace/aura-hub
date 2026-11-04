"""Tools work in a project whose path has spaces, '#', '%', '&', and non-ASCII text.

A Windows user named "José Müller" or a macOS folder "My Projects" produces exactly
this, and path handling that works for `/tmp/proj` can fail here (unquoted
arguments, URL-style encoding, ASCII-only decoding, filename normalisation).
Nothing in the suite exercised the real tools under such a path. This runs the
filesystem, git and document-ingest executors there on Linux; it does not prove
Windows (drive letters, UNC, 8.3 names) or macOS (NFD filename normalisation).
"""
from __future__ import annotations

import subprocess
import unicodedata
from pathlib import Path

import pytest

from aura.executors import all_executors

HOSTILE = "José Müller's proj #1 100% & co ünï 日本"


def _ex(home, cap):
    return next(e for e in all_executors(home) if e.capabilityId == cap)


def _inv(cwd, **params):
    return {"input": params, "context": {"cwd": str(cwd), "projectId": "p"}}


@pytest.fixture()
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    root = tmp_path / HOSTILE
    root.mkdir()
    (root / "naïve notes.txt").write_text("héllo wörld\n", encoding="utf-8")
    git = lambda *a: subprocess.run(["git", *a], cwd=root, check=True, capture_output=True)
    git("init", "-q")
    git("config", "user.email", "t@example.invalid")
    git("config", "user.name", "T")
    git("add", "-A")
    git("commit", "-qm", "init")
    (root / "naïve notes.txt").write_text("héllo wörld\nsecond line ✓\n", encoding="utf-8")
    return root


@pytest.mark.asyncio
async def test_filesystem_read_and_list(project):
    read = await _ex(project, "filesystem.read").run(_inv(project, path="naïve notes.txt"))
    assert read.get("ok") is not False, read
    assert "second line ✓" in str(read)
    listing = await _ex(project, "filesystem.list").run(_inv(project, path="."))
    assert listing.get("ok") is not False, listing
    assert "naïve notes.txt" in str(listing)


@pytest.mark.asyncio
async def test_git_status_and_diff_report_the_unicode_change(project):
    status = await _ex(project, "git.status").run(_inv(project))
    assert status.get("ok") is not False, status
    assert "notes.txt" in str(status)            # git quotes non-ASCII names; the file must still be named
    diff = await _ex(project, "git.diff").run(_inv(project))
    assert diff.get("ok") is not False, diff
    assert "second line ✓" in str(diff)          # the non-ASCII content survives the round trip


@pytest.mark.asyncio
async def test_a_docx_made_in_such_a_project_can_be_ingested_back(project):
    pytest.importorskip("docx")
    import docx

    path = project / "Résumé – Q3 (final).docx"
    d = docx.Document()
    d.add_paragraph("Quarterly zebra-7731 figures für ünï")
    d.save(str(path))
    from aura.executors import multimodal_executors
    from aura.knowledge.store import KnowledgeBase

    kb = KnowledgeBase(store_dir=project.parent / "kb")
    ing = next(e for e in multimodal_executors(kb, project.parent / "art") if e.capabilityId == "document.ingest")
    res = await ing.run(_inv(project, path=str(path)))
    assert res.get("ok") is not False, res
    hits = kb.search("zebra-7731", project_id="p")
    assert hits, "the ingested text must be searchable in the project it was ingested for"
    assert not kb.search("zebra-7731", project_id="other"), "and invisible to another project (F-26)"


def test_nfc_and_nfd_spellings_name_the_same_file_on_macos_only(tmp_path):
    """Documents the platform fact the code must tolerate rather than asserting it here:
    HFS+/APFS normalise names to NFD, ext4/NTFS keep what was written. Both spellings differ as str."""
    nfc, nfd = unicodedata.normalize("NFC", "é.txt"), unicodedata.normalize("NFD", "é.txt")
    assert nfc != nfd and Path(nfc).name != Path(nfd).name
