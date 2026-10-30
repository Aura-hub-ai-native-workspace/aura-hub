"""DOCX, XLSX and PDF work without Docling (F-28).

The packaged application shipped none of the document libraries, and, found
while fixing that, the document engine sent DOCX/XLSX/PDF only to Docling (a
multi-gigabyte optional stack that is not shipped). Without it every one of
those files was answered "docling package not installed", so bundling pypdf,
python-docx and openpyxl alone would have changed nothing. LightOfficeEngine is
the fallback: used only when Docling is missing, it reads the three formats
with the small libraries, says so in the result, and refuses honestly what it
cannot do (no OCR, no password-protected files, no archives that unpack
absurdly, no missing library passed off as success).

Run against the real libraries and the real engine and executors.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

docx = pytest.importorskip("docx")
openpyxl = pytest.importorskip("openpyxl")
pytest.importorskip("reportlab")
pypdf = pytest.importorskip("pypdf")

from aura.multimodal import light as light_module  # noqa: E402
from aura.multimodal.doctypes import DocumentConversionRequest, DocumentStatus  # noqa: E402
from aura.multimodal.document_engine import DocumentEngine, EngineConfig  # noqa: E402

# ── fixtures ───────────────────────────────────────────────────────────────

def hide_library(monkeypatch, name):
    """Make `import name` (and any `from name.sub import x`) fail, as if the
    library were not installed. Submodules already cached in sys.modules must
    be hidden too, or `from name.sub import x` would still succeed."""
    for loaded in [m for m in sys.modules if m == name or m.startswith(name + ".")]:
        monkeypatch.setitem(sys.modules, loaded, None)
    monkeypatch.setitem(sys.modules, name, None)


def make_docx(path: Path, paragraphs=("DOCX-MARKER first paragraph",), table=None, heading=None):
    d = docx.Document()
    if heading:
        d.add_heading(heading, level=1)
    for text in paragraphs:
        d.add_paragraph(text)
    if table:
        t = d.add_table(rows=len(table), cols=len(table[0]))
        for r, row in enumerate(table):
            for c, value in enumerate(row):
                t.cell(r, c).text = value
    d.save(str(path))
    return path


def make_xlsx(path: Path, sheets=None):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in (sheets or {"Budget": [["Item", "Cost"], ["XLSX-MARKER widgets", 42]]}).items():
        ws = wb.create_sheet(name)
        for row in rows:
            ws.append(row)
    wb.save(str(path))
    return path


def make_pdf(path: Path, pages=("PDF-MARKER page one",)):
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path))
    for text in pages:
        if text:
            c.drawString(72, 720, text)
        else:
            c.rect(72, 600, 100, 100)             # a page with no text layer
        c.showPage()
    c.save()
    return path


@pytest.fixture()
def engine(monkeypatch):
    """The engine as it is in the packaged app: Docling not installed."""
    eng = DocumentEngine(EngineConfig.from_env())
    monkeypatch.setattr(eng.docling, "is_installed", lambda: False)
    return eng


def convert(engine, path, **kw):
    return engine.convert(str(path), DocumentConversionRequest(path=str(path), **kw) if kw else None)


# ── extraction ─────────────────────────────────────────────────────────────

def test_docx_text_headings_and_tables_are_extracted(engine, tmp_path):
    path = make_docx(tmp_path / "a.docx", ["First paragraph DOCX-MARKER", "Second paragraph"],
                     table=[["Name", "Qty"], ["bolts", "12"]], heading="Quarterly plan")
    r = convert(engine, path)
    assert r.document_status == DocumentStatus.SUCCESS and r.engine == "light"
    assert "DOCX-MARKER" in r.text and "Second paragraph" in r.text
    assert "bolts | 12" in r.text                          # table rows survive
    assert "Quarterly plan" in r.text
    assert r.chunks and r.char_count == len(r.text)


def test_xlsx_every_sheet_is_extracted_with_values(engine, tmp_path):
    path = make_xlsx(tmp_path / "a.xlsx", {
        "Budget": [["Item", "Cost"], ["XLSX-MARKER widgets", 42], [None, None], ["gadgets", 7.5]],
        "Notes": [["second sheet note"]],
    })
    r = convert(engine, path)
    assert r.document_status == DocumentStatus.SUCCESS and r.engine == "light"
    assert "## Sheet: Budget" in r.text and "## Sheet: Notes" in r.text
    assert "XLSX-MARKER widgets | 42" in r.text and "gadgets | 7.5" in r.text
    assert "second sheet note" in r.text
    assert r.page_count == 2


def test_a_workbook_with_only_uncached_formulas_is_not_a_success(engine, tmp_path):
    path = tmp_path / "f.xlsx"
    wb = openpyxl.Workbook()
    wb.active["A1"] = "=1+1"                              # openpyxl stores no cached value
    wb.save(str(path))
    r = convert(engine, path)
    assert r.document_status == DocumentStatus.PARTIAL and r.text == ""
    assert "no cell values" in r.note


def test_pdf_text_is_extracted_with_page_markers(engine, tmp_path):
    path = make_pdf(tmp_path / "a.pdf", ["PDF-MARKER one", "second page text"])
    r = convert(engine, path)
    assert r.document_status == DocumentStatus.SUCCESS and r.engine == "light"
    assert "[page 1]" in r.text and "PDF-MARKER one" in r.text
    assert "[page 2]" in r.text and "second page text" in r.text
    assert r.page_count == 2


def test_the_fallback_says_it_was_used_and_why(engine, tmp_path):
    r = convert(engine, make_docx(tmp_path / "a.docx"))
    assert "lightweight reader, not Docling" in r.note
    assert "docling package not installed" in r.note
    assert r.docling_status == "supported_dependency_missing"


@pytest.mark.parametrize("n", [50, 200])
def test_a_character_budget_truncates_and_says_so(engine, tmp_path, n):
    long_text = "word " * 500
    cases = [
        make_docx(tmp_path / "a.docx", [long_text]),
        make_xlsx(tmp_path / "a.xlsx", {"S": [[long_text]]}),
        make_pdf(tmp_path / "a.pdf", [long_text[:120]]),
    ]
    for path in cases[:2]:
        r = convert(engine, path, max_chars=n)
        assert r.document_status == DocumentStatus.PARTIAL, path.name
        assert len(r.text) <= n and "truncated" in r.note


# ── the engine keeps Docling first ─────────────────────────────────────────

def test_when_docling_converts_the_fallback_is_not_used(monkeypatch, tmp_path):
    from aura.multimodal.doctypes import DocumentConversionResult

    eng = DocumentEngine(EngineConfig.from_env())
    called = []
    ok = DocumentConversionResult(path="x", status="ok", document_status=DocumentStatus.SUCCESS,
                                  text="from docling", engine="docling")
    monkeypatch.setattr(eng.docling, "convert", lambda req: ok)
    monkeypatch.setattr(eng.light, "convert", lambda req: called.append(req))
    r = eng.convert(str(make_docx(tmp_path / "a.docx")))
    assert r.engine == "docling" and r.text == "from docling"
    assert called == []


def test_capabilities_name_the_light_reader_only_for_libraries_that_import(engine, monkeypatch):
    assert {engine.capabilities().formats[s] for s in (".pdf", ".docx", ".xlsx")} == {"light:text"}
    hide_library(monkeypatch, "pypdf")
    formats = engine.capabilities().formats
    assert formats.get(".pdf") != "light:text"            # an unimportable library is not advertised
    assert formats[".docx"] == "light:text"


# ── a library that cannot load is a typed refusal, never an empty success ──

@pytest.mark.parametrize("suffix, module, extra", [
    (".docx", "docx", "multimodal"), (".pdf", "pypdf", "multimodal"), (".xlsx", "openpyxl", "artifacts")])
def test_a_missing_library_is_a_dependency_error_that_names_the_extra(engine, tmp_path, monkeypatch, suffix, module, extra):
    makers = {".docx": make_docx, ".pdf": make_pdf, ".xlsx": make_xlsx}
    path = makers[suffix](tmp_path / f"a{suffix}")
    hide_library(monkeypatch, module)                      # the import now fails
    r = convert(engine, path)
    assert r.document_status == DocumentStatus.SUPPORTED_DEPENDENCY_MISSING
    assert extra in r.note and "not installed" in r.note
    assert "docling" in r.note.lower()                    # both gaps are reported
    assert r.text == "" and r.chunks == []


# ── damaged and hostile files ──────────────────────────────────────────────

@pytest.mark.parametrize("name, payload", [
    ("garbage.docx", b"\x00\x01 not a zip at all"), ("garbage.xlsx", b"PK\x03\x04 truncated"),
    ("garbage.pdf", b"%PDF-1.7 \xff\xfe broken"), ("empty.docx", b""), ("empty.pdf", b"")])
def test_a_corrupt_file_is_a_typed_result_not_an_exception(engine, tmp_path, name, payload):
    path = tmp_path / name
    path.write_bytes(payload)
    r = convert(engine, path)
    assert r.document_status == DocumentStatus.CORRUPT
    assert r.text == "" and r.errors


def test_a_container_that_unpacks_absurdly_is_refused_before_any_parser_runs(engine, tmp_path, monkeypatch):
    path = make_docx(tmp_path / "bomb.docx", ["x " * 5000])
    monkeypatch.setattr(light_module, "MAX_UNPACKED_BYTES", 1024)

    def never(*a, **k):
        raise AssertionError("the parser must not be reached")

    monkeypatch.setattr(docx, "Document", never)
    r = convert(engine, path)
    assert r.document_status == DocumentStatus.CORRUPT and "unpacks to" in r.note


def test_an_oversized_source_is_refused(engine, tmp_path, monkeypatch):
    path = make_pdf(tmp_path / "big.pdf")
    monkeypatch.setattr(light_module, "MAX_SOURCE_BYTES", 100)
    r = convert(engine, path)
    assert r.document_status == DocumentStatus.CORRUPT and "larger than" in r.note


def test_a_password_protected_pdf_is_refused_not_read(engine, tmp_path):
    plain = make_pdf(tmp_path / "plain.pdf", ["SECRET-PDF-TEXT"])
    writer = pypdf.PdfWriter(clone_from=str(plain))
    writer.encrypt("hunter2")
    locked = tmp_path / "locked.pdf"
    with locked.open("wb") as fh:
        writer.write(fh)
    r = convert(engine, locked)
    assert r.document_status == DocumentStatus.CORRUPT and "password-protected" in r.note
    assert "SECRET-PDF-TEXT" not in r.text


def test_a_scanned_pdf_with_no_text_layer_is_ocr_required(engine, tmp_path):
    r = convert(engine, make_pdf(tmp_path / "scan.pdf", [""]))
    assert r.document_status == DocumentStatus.OCR_REQUIRED
    assert r.text == "" and "OCR" in r.note


def test_an_empty_docx_is_not_a_success_with_content(engine, tmp_path):
    r = convert(engine, make_docx(tmp_path / "empty.docx", []))
    assert r.document_status == DocumentStatus.PARTIAL and r.text == ""


def test_an_unclaimed_suffix_is_not_taken_by_the_light_reader(engine, tmp_path):
    path = tmp_path / "a.pptx"
    path.write_bytes(b"x")
    assert engine.light.claims(".pptx") is False
    assert engine.convert(str(path)).engine != "light"


# ── through the real executors: generate, ingest, search, confinement ──────

@pytest.fixture()
def tools(tmp_path, monkeypatch):
    from aura.executors import multimodal_executors
    from aura.knowledge.store import KnowledgeBase

    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    monkeypatch.setattr("aura.multimodal.docling_engine.DoclingEngine.is_installed", lambda self: False)
    project = tmp_path / "project"
    project.mkdir()
    kb = KnowledgeBase(tmp_path / "kb")
    by_id = {e.capabilityId: e for e in multimodal_executors(kb, tmp_path / "artifacts")}
    return kb, by_id, project


def call(by_id, project, cap, project_id="proj-1", **inp):
    inv = {"id": "inv", "input": inp,
           "context": {"cwd": str(project), "projectId": project_id, "actor": {"kind": "agent", "id": "central-agent"}}}
    return asyncio.run(by_id[cap].run(inv))


SPEC = {"title": "Report", "sections": [
    {"heading": "Summary", "body": "E2E-MARKER the quarter went well"},
    {"heading": "Table", "rows": [["Item", "Cost"], ["valves", "9"]], "list_items": ["alpha", "beta"]}]}


@pytest.mark.parametrize("kind", ["docx", "xlsx", "pdf"])
def test_generate_then_ingest_then_search_round_trips_each_format(tools, kind):
    kb, by_id, project = tools
    made = call(by_id, project, "artifact.generate", spec={**SPEC, "artifact_type": kind}, output_path=f"out.{kind}")
    assert made["ok"] is True, made
    assert (project / f"out.{kind}").stat().st_size > 0
    ingested = call(by_id, project, "document.ingest", path=f"out.{kind}")
    assert ingested["ok"] is True, ingested
    assert ingested["output"]["engine"] == "light" and ingested["output"]["chunkCount"] > 0
    found = call(by_id, project, "knowledge.search", query="quarter went well")
    assert "E2E-MARKER" in json.dumps(found)
    # and it is this project's only
    other = call(by_id, project, "knowledge.search", project_id="proj-2", query="quarter went well")
    assert "E2E-MARKER" not in json.dumps(other)


def test_ingest_of_an_ocr_required_pdf_is_a_failure_and_indexes_nothing(tools):
    kb, by_id, project = tools
    make_pdf(project / "scan.pdf", [""])
    result = call(by_id, project, "document.ingest", path="scan.pdf")
    assert result["ok"] is False
    assert result["documentStatus"] == "ocr_required"
    assert kb.documents(project_id="proj-1") == []


@pytest.mark.parametrize("module, kind", [("docx", "docx"), ("openpyxl", "xlsx"), ("reportlab", "pdf")])
def test_generation_with_a_missing_library_fails_honestly_and_writes_nothing(tools, monkeypatch, module, kind):
    kb, by_id, project = tools
    hide_library(monkeypatch, module)
    made = call(by_id, project, "artifact.generate", spec={**SPEC, "artifact_type": kind}, output_path=f"out.{kind}")
    assert made["ok"] is False
    assert "not installed" in made["detail"] or "missing" in made["detail"].lower()
    assert not (project / f"out.{kind}").exists()          # no half-written file posing as an artifact


def test_ingest_with_a_missing_library_fails_and_indexes_nothing(tools, monkeypatch):
    kb, by_id, project = tools
    make_docx(project / "a.docx")
    hide_library(monkeypatch, "docx")
    result = call(by_id, project, "document.ingest", path="a.docx")
    assert result["ok"] is False and "not installed" in result["detail"]
    assert kb.documents(project_id="proj-1") == []


@pytest.mark.parametrize("kind", ["docx", "pdf"])
def test_an_image_outside_the_project_is_refused_and_nothing_is_written(tools, tmp_path, kind):
    from PIL import Image

    kb, by_id, project = tools
    outside = tmp_path / "private.png"
    Image.new("RGB", (8, 8), "red").save(outside)
    spec = {"artifact_type": kind, "title": "T", "sections": [{"body": "x", "image_path": str(outside)}]}
    made = call(by_id, project, "artifact.generate", spec=spec, output_path=f"out.{kind}")
    assert made["ok"] is False and "image was refused" in made["detail"]
    assert not (project / f"out.{kind}").exists()


@pytest.mark.parametrize("kind", ["docx", "pdf"])
def test_an_image_inside_the_project_is_embedded(tools, kind):
    from PIL import Image

    kb, by_id, project = tools
    Image.new("RGB", (8, 8), "blue").save(project / "pic.png")
    spec = {"artifact_type": kind, "title": "T", "sections": [{"body": "with a picture", "image_path": "pic.png"}]}
    made = call(by_id, project, "artifact.generate", spec=spec, output_path=f"out.{kind}")
    assert made["ok"] is True, made
    assert (project / f"out.{kind}").stat().st_size > 0


def test_an_output_outside_the_project_is_still_refused_and_nothing_is_written(tools, tmp_path):
    kb, by_id, project = tools
    target = tmp_path / "elsewhere.docx"
    made = call(by_id, project, "artifact.generate", spec={**SPEC, "artifact_type": "docx"}, output_path=str(target))
    assert made["ok"] is False and not target.exists()


def test_ingest_of_a_document_outside_the_project_is_still_refused(tools, tmp_path):
    kb, by_id, project = tools
    outside = make_docx(tmp_path / "outside.docx", ["OUTSIDE-SECRET"])
    result = call(by_id, project, "document.ingest", path=str(outside))
    assert result["ok"] is False and kb.documents(project_id="proj-1") == []
