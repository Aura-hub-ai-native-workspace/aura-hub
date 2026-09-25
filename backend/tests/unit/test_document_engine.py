"""Unit tests for the document-intelligence subsystem (mocked, offline).

No Docling import here: every test passes in AURA's base environment.
Real-Docling coverage lives in
``backend/tests/integration/test_docling_engine.py`` (gated, never
counted as passed when skipped).
"""

import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from aura.multimodal.doctypes import (  # noqa: E402
    DocumentCapabilities,
    DocumentConversionRequest,
    DocumentConversionResult,
    DocumentEngineHealth,
    DocumentStatus,
    IsolationMode,
    OcrEngine,
)
from aura.multimodal.document_engine import (  # noqa: E402
    DocumentEngine,
    EngineConfig,
)
from aura.multimodal.native import NativeTextEngine  # noqa: E402
from aura.multimodal.process_supervisor import (  # noqa: E402
    max_workers_for_machine,
    run_isolated,
)
from aura.multimodal.secure import (  # noqa: E402
    PathSecurityError,
    file_identity,
    managed_temp_dir,
    managed_temp_file,
    resolve_secure,
    verify_same_file,
)

# ----------------------------------------------------------------------
# doctypes
# ----------------------------------------------------------------------

def test_result_to_dict_excludes_text():
    result = DocumentConversionResult(path="/x/a.md", text="secret body")
    payload = result.to_dict()
    assert "secret body" not in str(payload)
    assert payload["charCount"] == len("secret body")


def test_result_to_extraction_result_roundtrip(tmp_path):
    target = tmp_path / "a.txt"
    target.write_text("hello", encoding="utf-8")
    result = DocumentConversionResult(path=str(target), status="ok",
                                      text="hello")
    extraction = result.to_extraction_result()
    assert extraction.status.value == "ok"
    assert extraction.text == "hello"
    assert "hello" not in str(extraction.to_dict())


def test_document_status_vocabulary_complete():
    values = {s.value for s in DocumentStatus}
    assert {"success", "partial", "supported", "supported_dependency_missing",
            "ocr_required", "ocr_failed", "unsupported", "corrupt"} <= values


def test_capabilities_supports_lookup():
    caps = DocumentCapabilities(formats={".pdf": "docling:pdf"})
    assert caps.supports(".PDF")
    assert not caps.supports(".zip")


# ----------------------------------------------------------------------
# secure
# ----------------------------------------------------------------------

def test_resolve_secure_missing_raises(tmp_path):
    with pytest.raises(PathSecurityError):
        resolve_secure(tmp_path / "nope.txt")


def test_resolve_secure_refuses_escape(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("x", encoding="utf-8")
    with pytest.raises(PathSecurityError):
        resolve_secure(outside, root=root)


def test_resolve_secure_allows_inside(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    inside = root / "a.txt"
    inside.write_text("x", encoding="utf-8")
    assert resolve_secure(inside, root=root) == inside


def test_resolve_secure_refuses_symlink_escape(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_text("classified", encoding="utf-8")
    link = root / "link.txt"
    link.symlink_to(outside)
    # strict resolve lands outside the root → refused
    with pytest.raises(PathSecurityError):
        resolve_secure(link, root=root)


def test_verify_same_file_detects_swap(tmp_path):
    first = tmp_path / "a.txt"
    first.write_text("one", encoding="utf-8")
    identity = file_identity(first)
    assert verify_same_file(first, identity)
    second = tmp_path / "b.txt"
    second.write_text("two", encoding="utf-8")
    assert not verify_same_file(second, identity)


def test_managed_temp_file_cleaned(tmp_path):
    with managed_temp_file(suffix=".pdf", base=tmp_path) as handle:
        assert handle.exists()
        leaked = handle
    assert not leaked.exists()


def test_managed_temp_dir_cleaned_on_error(tmp_path):
    with pytest.raises(RuntimeError):
        with managed_temp_dir(base=tmp_path) as handle:
            leaked = handle
            raise RuntimeError("boom")
    assert not leaked.exists()


# ----------------------------------------------------------------------
# native engine
# ----------------------------------------------------------------------

def _write(tmp_path, name, content):
    target = tmp_path / name
    target.write_text(content, encoding="utf-8")
    return str(target)


def test_native_markdown_ok(tmp_path):
    engine = NativeTextEngine()
    path = _write(tmp_path, "doc.md", "# Title\n\nBody text here.\n")
    result = engine.convert(DocumentConversionRequest(path=path))
    assert result.status == "ok"
    assert result.document_status == DocumentStatus.SUCCESS
    assert "Body text" in result.text
    assert result.chunks, "expected at least one chunk"


def test_native_csv_ok(tmp_path):
    engine = NativeTextEngine()
    path = _write(tmp_path, "data.csv", "a,b\n1,2\n")
    result = engine.convert(DocumentConversionRequest(path=path))
    assert result.status == "ok"
    assert "1,2" in result.text


def test_native_unsupported_suffix(tmp_path):
    engine = NativeTextEngine()
    path = _write(tmp_path, "doc.pdf", "%PDF fake")
    result = engine.convert(DocumentConversionRequest(path=path))
    assert result.status == "skipped"
    assert result.document_status == DocumentStatus.UNSUPPORTED


def test_native_archive_rejected(tmp_path):
    engine = NativeTextEngine()
    target = tmp_path / "a.zip"
    target.write_bytes(b"PK\x03\x04fake")
    result = engine.convert(DocumentConversionRequest(path=str(target)))
    assert result.document_status == DocumentStatus.UNSUPPORTED
    assert "archive" in result.note


def test_native_missing_file(tmp_path):
    engine = NativeTextEngine()
    result = engine.convert(DocumentConversionRequest(
        path=str(tmp_path / "gone.txt")))
    assert result.status == "error"
    assert result.document_status == DocumentStatus.CORRUPT


def test_native_truncation_is_partial(tmp_path):
    engine = NativeTextEngine(max_chars=10)
    path = _write(tmp_path, "big.txt", "x" * 100)
    result = engine.convert(DocumentConversionRequest(path=path,
                                                      max_chars=10))
    assert result.status == "partial"
    assert result.document_status == DocumentStatus.PARTIAL
    assert len(result.text) == 10


def test_native_chunk_boundaries(tmp_path):
    engine = NativeTextEngine(chunk_chars=20, chunk_overlap=5)
    chunks = engine.chunk_text("word " * 50)
    assert len(chunks) > 1
    joined = "".join(c.text for c in chunks)
    assert "word" in joined
    assert chunks[0].start_char == 0
    assert all(c.end_char > c.start_char for c in chunks)


# ----------------------------------------------------------------------
# dispatcher without docling
# ----------------------------------------------------------------------

def _engine_without_docling(tmp_path, **overrides):
    engine = DocumentEngine(EngineConfig(
        max_file_bytes=overrides.pop("max_file_bytes", 50 * 1024 * 1024),
        confinement_root=str(tmp_path),
        **overrides))
    engine.docling.is_installed = lambda: False  # force missing path
    return engine


def test_dispatch_native_txt(tmp_path):
    engine = _engine_without_docling(tmp_path)
    path = _write(tmp_path, "n.txt", "plain words")
    result = engine.convert(path)
    assert result.engine == "native"
    assert result.status == "ok"


def test_dispatch_pdf_without_docling_is_honest(tmp_path):
    engine = _engine_without_docling(tmp_path)
    target = tmp_path / "d.pdf"
    target.write_bytes(b"%PDF-1.4 fake")
    result = engine.convert(str(target))
    assert result.document_status == \
        DocumentStatus.SUPPORTED_DEPENDENCY_MISSING
    assert "docling" in result.note.lower()


def test_dispatch_archive_rejected_before_engines(tmp_path):
    engine = _engine_without_docling(tmp_path)
    target = tmp_path / "a.tar"
    target.write_bytes(b"fake")
    result = engine.convert(str(target))
    assert result.document_status == DocumentStatus.UNSUPPORTED


def test_dispatch_oversized_rejected(tmp_path):
    engine = _engine_without_docling(tmp_path, max_file_bytes=10)
    path = _write(tmp_path, "big.txt", "x" * 100)
    result = engine.convert(path)
    assert result.status == "error"
    assert "exceeds" in result.note


def test_dispatch_confinement_root_enforced(tmp_path):
    engine = _engine_without_docling(tmp_path)
    outside = tmp_path.parent / "outside-doc.txt"
    outside.write_text("nope", encoding="utf-8")
    try:
        result = engine.convert(str(outside))
    finally:
        outside.unlink(missing_ok=True)
    assert result.document_status == DocumentStatus.CORRUPT
    assert "escapes" in result.note or "rejected" in result.note


def test_batch_preserves_order(tmp_path):
    engine = _engine_without_docling(tmp_path)
    paths = [_write(tmp_path, f"{i}.txt", f"body {i}") for i in range(5)]
    results = engine.convert_batch(paths)
    assert [r.text for r in results] == [f"body {i}" for i in range(5)]


def test_config_from_env_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_DOCS_OCR", "rapidocr")
    monkeypatch.setenv("AURA_DOCS_OCR_LANG", "de")
    monkeypatch.setenv("AURA_DOCS_FORCE_OCR", "1")
    monkeypatch.setenv("AURA_DOCS_MAX_BYTES", "1234")
    monkeypatch.setenv("AURA_DOCS_ISOLATION", "process")
    config = EngineConfig.from_env()
    assert config.ocr_engine == OcrEngine.RAPIDOCR
    assert config.ocr_lang == "de"
    assert config.force_ocr is True
    assert config.max_file_bytes == 1234
    assert config.isolation == IsolationMode.PROCESS


def test_config_from_env_bad_values_fall_back(monkeypatch):
    monkeypatch.setenv("AURA_DOCS_OCR", "cloud-magic")
    monkeypatch.setenv("AURA_DOCS_ISOLATION", "teleport")
    config = EngineConfig.from_env()
    assert config.ocr_engine == OcrEngine.AUTO
    assert config.isolation == IsolationMode.IN_PROCESS


# ----------------------------------------------------------------------
# supervisor
# ----------------------------------------------------------------------

def _quick_task(payload):
    return {"echo": payload.get("value", 0)}


def _sleep_task(payload):
    import time as _time

    _time.sleep(payload.get("seconds", 30))
    return {"slept": True}


def test_supervisor_fast_task_ok():
    outcome = run_isolated(_quick_task, {"value": 7}, timeout_s=20.0)
    assert outcome.ok and not outcome.timed_out
    assert outcome.result == {"echo": 7}


def test_supervisor_timeout_kills_worker():
    started = time.monotonic()
    outcome = run_isolated(_sleep_task, {"seconds": 60}, timeout_s=5.0)
    elapsed = time.monotonic() - started
    assert outcome.timed_out and not outcome.ok
    assert outcome.result is None
    assert elapsed < 30, f"supervisor failed to kill worker ({elapsed:.1f}s)"


def test_max_workers_sane():
    assert max_workers_for_machine(2) in (1, 2)
    assert max_workers_for_machine(0) >= 1


def test_health_without_docling_reports_gaps(tmp_path):
    engine = _engine_without_docling(tmp_path)
    health = engine.health()
    assert isinstance(health, DocumentEngineHealth)
    assert health.available is True  # native text always works
    assert health.docling_installed is False
    assert health.missing, "expected honest gap list"
