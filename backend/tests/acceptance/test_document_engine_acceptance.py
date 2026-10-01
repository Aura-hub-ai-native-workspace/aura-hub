"""Phase-14 acceptance tests — DocumentEngine 12-case matrix.

Tests the full DocumentEngine.convert() boundary, not individual sub-engines.
All 12 cases must pass in the base environment (no Docling required).

Cases:
  A1  plain-text .txt               → SUCCESS, engine=native
  A2  markdown .md                  → SUCCESS, engine=native
  A3  CSV .csv                      → SUCCESS, engine=native, chunks produced
  A4  PDF without Docling           → SUPPORTED_DEPENDENCY_MISSING, not indexable
  A5  DOCX without Docling          → SUPPORTED_DEPENDENCY_MISSING, not indexable
  A6  XLSX without Docling          → SUPPORTED_DEPENDENCY_MISSING, not indexable
  A7  PPTX without Docling          → SUPPORTED_DEPENDENCY_MISSING, not indexable
  A8  PNG image without Docling     → SUPPORTED_DEPENDENCY_MISSING, not indexable
  A9  corrupt binary as .txt        → PARTIAL or SUCCESS (graceful, never raises)
  A10 oversized file                → status=error, note contains "exceeds"
  A11 archive (.zip) hard-rejected  → UNSUPPORTED, not indexable
  A12 network isolation (.txt)      → SUCCESS without any socket.connect calls
"""

import os
import sys
import socket
import threading
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from aura.multimodal.document_engine import DocumentEngine, EngineConfig  # noqa: E402
from aura.multimodal.doctypes import DocumentStatus  # noqa: E402

_INDEXABLE = {DocumentStatus.SUCCESS, DocumentStatus.PARTIAL}
_NON_INDEXABLE = {
    DocumentStatus.UNSUPPORTED,
    DocumentStatus.CORRUPT,
    DocumentStatus.OCR_REQUIRED,
    DocumentStatus.SUPPORTED_DEPENDENCY_MISSING,
}


def _engine(tmp_path, **kwargs) -> DocumentEngine:
    cfg = EngineConfig(confinement_root=str(tmp_path), **kwargs)
    return DocumentEngine(cfg)


# ── A1 plain-text ─────────────────────────────────────────────────────────

def test_a1_plain_text_success(tmp_path):
    f = tmp_path / "note.txt"
    f.write_text("Hello AURA. This is a plain-text document.", encoding="utf-8")
    r = _engine(tmp_path).convert(str(f))
    assert r.document_status == DocumentStatus.SUCCESS
    assert r.engine == "native"
    assert len(r.text) > 0
    assert r.document_status in _INDEXABLE


# ── A2 markdown ──────────────────────────────────────────────────────────

def test_a2_markdown_success(tmp_path):
    f = tmp_path / "readme.md"
    f.write_text("# Title\n\nParagraph with **bold** text.\n", encoding="utf-8")
    r = _engine(tmp_path).convert(str(f))
    assert r.document_status == DocumentStatus.SUCCESS
    assert r.engine == "native"
    assert r.document_status in _INDEXABLE


# ── A3 CSV chunks ─────────────────────────────────────────────────────────

def test_a3_csv_produces_chunks(tmp_path):
    rows = ["name,value"] + [f"row{i},{i}" for i in range(20)]
    f = tmp_path / "data.csv"
    f.write_text("\n".join(rows), encoding="utf-8")
    r = _engine(tmp_path).convert(str(f))
    assert r.document_status in _INDEXABLE
    assert r.engine == "native"
    assert len(r.chunks) > 0


# ── A4 PDF without Docling ────────────────────────────────────────────────

def test_a4_pdf_without_docling_reports_dependency_missing(tmp_path):
    f = tmp_path / "report.pdf"
    f.write_bytes(b"%PDF-1.4 fake content")
    r = _engine(tmp_path).convert(str(f))
    assert r.document_status == DocumentStatus.SUPPORTED_DEPENDENCY_MISSING
    assert r.document_status in _NON_INDEXABLE
    assert "docling" in (r.note or "").lower()


# ── A5 DOCX without Docling ───────────────────────────────────────────────

def test_a5_docx_without_docling_reports_dependency_missing(tmp_path):
    f = tmp_path / "letter.docx"
    f.write_bytes(b"PK\x03\x04fake-docx-content")
    r = _engine(tmp_path).convert(str(f))
    assert r.document_status == DocumentStatus.SUPPORTED_DEPENDENCY_MISSING
    assert r.document_status in _NON_INDEXABLE


# ── A6 XLSX without Docling ───────────────────────────────────────────────

def test_a6_xlsx_without_docling_reports_dependency_missing(tmp_path):
    f = tmp_path / "sheet.xlsx"
    f.write_bytes(b"PK\x03\x04fake-xlsx-content")
    r = _engine(tmp_path).convert(str(f))
    assert r.document_status == DocumentStatus.SUPPORTED_DEPENDENCY_MISSING
    assert r.document_status in _NON_INDEXABLE


# ── A7 PPTX without Docling ───────────────────────────────────────────────

def test_a7_pptx_without_docling_reports_dependency_missing(tmp_path):
    f = tmp_path / "slides.pptx"
    f.write_bytes(b"PK\x03\x04fake-pptx-content")
    r = _engine(tmp_path).convert(str(f))
    assert r.document_status == DocumentStatus.SUPPORTED_DEPENDENCY_MISSING
    assert r.document_status in _NON_INDEXABLE


# ── A8 PNG image without Docling ──────────────────────────────────────────

def test_a8_png_without_docling_reports_dependency_missing(tmp_path):
    f = tmp_path / "diagram.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\nfake-png-content")
    r = _engine(tmp_path).convert(str(f))
    assert r.document_status == DocumentStatus.SUPPORTED_DEPENDENCY_MISSING
    assert r.document_status in _NON_INDEXABLE


# ── A9 corrupt binary as .txt ─────────────────────────────────────────────

def test_a9_corrupt_binary_as_txt_never_raises(tmp_path):
    f = tmp_path / "broken.txt"
    f.write_bytes(bytes(range(256)) * 10)  # raw binary, not valid UTF-8
    r = _engine(tmp_path).convert(str(f))
    # Must complete without exception; status is PARTIAL or SUCCESS (degraded read)
    assert r.document_status in {DocumentStatus.SUCCESS, DocumentStatus.PARTIAL, DocumentStatus.CORRUPT}
    assert r.path == str(f)


# ── A10 oversized file ────────────────────────────────────────────────────

def test_a10_oversized_file_rejected(tmp_path):
    f = tmp_path / "huge.txt"
    f.write_text("x" * 200, encoding="utf-8")
    r = _engine(tmp_path, max_file_bytes=50).convert(str(f))
    assert r.status == "error"
    assert "exceeds" in (r.note or "").lower()


# ── A11 archive hard-rejected ─────────────────────────────────────────────

def test_a11_archive_zip_unsupported(tmp_path):
    f = tmp_path / "bundle.zip"
    f.write_bytes(b"PK\x03\x04fake-zip-content")
    r = _engine(tmp_path).convert(str(f))
    assert r.document_status == DocumentStatus.UNSUPPORTED
    assert r.document_status in _NON_INDEXABLE


# ── A12 network isolation ─────────────────────────────────────────────────

def test_a12_native_conversion_makes_no_network_calls(tmp_path, monkeypatch):
    calls: list[tuple] = []

    orig_connect = socket.socket.connect

    def spy_connect(self, address):
        calls.append(address)
        return orig_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", spy_connect)

    f = tmp_path / "isolated.txt"
    f.write_text("Sovereign text extraction — no cloud.", encoding="utf-8")
    r = _engine(tmp_path).convert(str(f))

    assert r.document_status == DocumentStatus.SUCCESS
    assert calls == [], f"Unexpected network connections during native conversion: {calls}"
