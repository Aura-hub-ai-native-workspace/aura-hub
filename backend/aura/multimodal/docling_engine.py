"""DoclingEngine — Docling-backed conversion behind a stable AURA boundary.

Design rules:
- No Docling import at module scope: importing this module never requires
  Docling installed. Everything Docling-specific is probed lazily.
- Never claim an engine/format that failed a real import or smoke check.
- Never substitute OCR engines silently: the requested engine either runs
  or the result says OCR_FAILED / SUPPORTED_DEPENDENCY_MISSING.
- Never call cloud APIs: only local pipelines are constructed. Any option
  that would reach the network (remote VLM, managed service) is refused.
- ``raises_on_error=False`` always: failures become typed results.
"""

from __future__ import annotations

import importlib
import importlib.util
import mimetypes
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Optional

from .doctypes import (
    ConversionError,
    DocumentCapabilities,
    DocumentConversionRequest,
    DocumentConversionResult,
    DocumentEngineHealth,
    DocumentStatus,
    IsolationMode,
    OcrEngine,
    StructuredChunk,
    StructuredImage,
    StructuredTable,
)
from .process_supervisor import run_isolated
from .secure import (
    PathSecurityError,
    file_identity,
    file_size,
    resolve_secure,
    verify_same_file,
)

#: Suffix → Docling InputFormat name. Presence here means "Docling upstream
#: supports it"; whether THIS install can run it is probed separately
#: (extras, system binaries, model cache).
_SUFFIX_TO_FORMAT: dict[str, str] = {
    ".pdf": "PDF",
    ".docx": "DOCX",
    ".pptx": "PPTX",
    ".xlsx": "XLSX",
    ".html": "HTML",
    ".xhtml": "HTML",
    ".htm": "HTML",
    ".mhtml": "HTML",
    ".mht": "HTML",
    ".csv": "CSV",
    ".md": "MD",
    ".txt": "TXT",
    ".png": "IMAGE",
    ".jpg": "IMAGE",
    ".jpeg": "IMAGE",
    ".bmp": "IMAGE",
    ".tiff": "IMAGE",
    ".tif": "IMAGE",
    ".webp": "IMAGE",
    ".odt": "ODT",
    ".ods": "ODS",
    ".odp": "ODP",
    ".epub": "EPUB",
    ".eml": "EML",
    ".msg": "MSG",
    ".doc": "DOC",
    ".xls": "XLS",
    ".ppt": "PPT",
    ".rtf": "RTF",
    ".asciidoc": "ASCIIDOC",
    ".adoc": "ASCIIDOC",
    ".tex": "LATEX",
    ".vtt": "VTT",
    ".mp3": "AUDIO",
    ".wav": "AUDIO",
}

#: Formats needing the legacy-Office bridge (LibreOffice system binary).
_LIBREOFFICE_FORMATS = frozenset({"DOC", "XLS", "PPT", "RTF"})

#: Formats needing extra pip packages beyond core docling.
_EXTRA_FORMATS = frozenset({"AUDIO", "VTT", "ASCIIDOC", "LATEX"})

_ARCHIVE_SUFFIXES = frozenset(
    {".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar"})


def docling_import_path() -> Optional[str]:
    """Filesystem path of the installed docling package, else None."""
    spec = importlib.util.find_spec("docling")
    if spec is None or spec.origin is None:
        return None
    return spec.origin


def docling_version() -> str:
    try:
        from importlib.metadata import version

        return version("docling")
    except Exception:
        return ""


def tesseract_available() -> bool:
    """True when a Tesseract binary is on PATH (system dependency)."""
    return shutil.which("tesseract") is not None


def libreoffice_available() -> bool:
    return shutil.which("libreoffice") is not None or \
        shutil.which("soffice") is not None


def rapidocr_importable() -> bool:
    return importlib.util.find_spec("rapidocr_onnxruntime") is not None or \
        importlib.util.find_spec("rapidocr") is not None


def easyocr_importable() -> bool:
    return importlib.util.find_spec("easyocr") is not None


def _ocr_option_class(kind: str) -> Optional[Any]:
    """Resolve the OCR options class for `kind`, probing installed version."""
    candidates = {
        "rapidocr": ["RapidOcrOptions"],
        "tesseract": ["TesseractOcrOptions", "TesseractCliOcrOptions"],
        "easyocr": ["EasyOcrOptions"],
    }.get(kind, [])
    try:
        module = importlib.import_module("docling.datamodel.pipeline_options")
    except ImportError:
        return None
    for name in candidates:
        cls = getattr(module, name, None)
        if cls is not None:
            return cls
    return None


def detect_ocr_engines() -> list[str]:
    """Ready-to-use local OCR engines. Ordered by preference."""
    if docling_import_path() is None:
        return []
    engines: list[str] = []
    if rapidocr_importable() and _ocr_option_class("rapidocr") is not None:
        engines.append(OcrEngine.RAPIDOCR.value)
    if tesseract_available():
        tesseract_cls = _ocr_option_class("tesseract")
        if tesseract_cls is not None:
            engines.append(OcrEngine.TESSERACT.value)
    if easyocr_importable() and _ocr_option_class("easyocr") is not None:
        engines.append(OcrEngine.EASYOCR.value)
    return engines


def model_cache_dir(explicit: str = "") -> Path:
    """Dedicated AURA model-cache location (never the generic HF default)."""
    if explicit:
        return Path(explicit).expanduser()
    env = os.environ.get("AURA_DOCS_MODEL_CACHE", "")
    if env:
        return Path(env).expanduser()
    home = os.environ.get("AURA_HOME", os.path.expanduser("~/.aura"))
    return Path(home) / "models" / "docling"


def models_cached(cache: Optional[Path] = None) -> bool:
    """True when the cache dir holds a provisioned manifest."""
    cache = cache or model_cache_dir()
    manifest = cache / "MANIFEST.json"
    return manifest.is_file()


class DoclingEngine:
    """Docling-backed converter. All Docling contact happens here."""

    name = "docling"

    def __init__(self, model_cache: str = "",
                 default_timeout_s: float = 300.0) -> None:
        self._cache = model_cache_dir(model_cache)
        self._default_timeout = default_timeout_s
        self._lock = threading.Lock()
        self._converters: dict[str, Any] = {}

    # -- capability ----------------------------------------------------
    def is_installed(self) -> bool:
        return docling_import_path() is not None

    def claims(self, suffix: str) -> bool:
        return suffix.lower() in _SUFFIX_TO_FORMAT

    @staticmethod
    def is_archive(suffix: str) -> bool:
        return suffix.lower() in _ARCHIVE_SUFFIXES

    def capabilities(self,
                     ocr_requested: str = "auto") -> DocumentCapabilities:
        caps = DocumentCapabilities(
            docling_installed=self.is_installed(),
            docling_version=docling_version() if self.is_installed() else "",
            ocr_requested=ocr_requested,
            libreoffice_available=libreoffice_available(),
            tesseract_available=tesseract_available(),
            model_cache_dir=str(self._cache),
            models_cached=models_cached(self._cache),
        )
        if not caps.docling_installed:
            return caps
        for suffix, fmt in sorted(_SUFFIX_TO_FORMAT.items()):
            if fmt in _LIBREOFFICE_FORMATS and not caps.libreoffice_available:
                continue
            if fmt in _EXTRA_FORMATS and not self._extra_format_ready(fmt):
                continue
            caps.formats[suffix] = f"docling:{fmt.lower()}"
        caps.ocr_engines = detect_ocr_engines()
        caps.offline_ready = caps.models_cached and bool(caps.ocr_engines)
        return caps

    @staticmethod
    def _extra_format_ready(fmt: str) -> bool:
        # Audio/video/ascii extras are out of scope for the initial
        # subsystem: report honestly instead of claiming them.
        return False

    def health(self) -> DocumentEngineHealth:
        caps = self.capabilities()
        missing: list[str] = []
        if not caps.docling_installed:
            missing.append("docling package not installed "
                           "(pip install aura-backend[docling])")
        if not caps.models_cached:
            missing.append("model cache not provisioned "
                           "(run scripts/provision-docling-models.py)")
        if not caps.ocr_engines:
            missing.append("no local OCR engine ready "
                           "(install docling[rapidocr] or tesseract-ocr)")
        ocr_ready = bool(caps.ocr_engines)
        available = caps.docling_installed and bool(caps.formats)
        detail = (f"docling {caps.docling_version or 'absent'}; "
                  f"{len(caps.formats)} suffixes routed; "
                  f"ocr={','.join(caps.ocr_engines) or 'none'}; "
                  f"models={'cached' if caps.models_cached else 'missing'}")
        return DocumentEngineHealth(
            available=available,
            docling_installed=caps.docling_installed,
            docling_version=caps.docling_version,
            models_cached=caps.models_cached,
            ocr_ready=ocr_ready,
            ocr_engines=caps.ocr_engines,
            offline_ready=caps.offline_ready,
            missing=missing,
            detail=detail,
        )

    # -- conversion ----------------------------------------------------
    def convert(self, request: DocumentConversionRequest) -> DocumentConversionResult:
        started = time.monotonic()
        result = DocumentConversionResult(path=request.path, engine=self.name)
        try:
            resolved = resolve_secure(request.path)
        except PathSecurityError as exc:
            return self._fail(result, "error", DocumentStatus.CORRUPT,
                              f"path rejected: {exc}", "policy", started)

        suffix = resolved.suffix.lower()
        if self.is_archive(suffix):
            return self._fail(result, "skipped", DocumentStatus.UNSUPPORTED,
                              f"archive extraction is not supported: {suffix}",
                              "", started)
        if not self.is_installed():
            return self._fail(
                result, "skipped",
                DocumentStatus.SUPPORTED_DEPENDENCY_MISSING,
                "docling package not installed "
                "(pip install aura-backend[docling])", "", started)
        if not self.claims(suffix):
            return self._fail(result, "skipped", DocumentStatus.UNSUPPORTED,
                              f"unsupported file type: {suffix or '(no extension)'}",
                              "", started)
        fmt = _SUFFIX_TO_FORMAT[suffix]
        if fmt in _LIBREOFFICE_FORMATS and not libreoffice_available():
            return self._fail(
                result, "skipped",
                DocumentStatus.SUPPORTED_DEPENDENCY_MISSING,
                f"{suffix} needs LibreOffice (libreoffice/soffice not on PATH)",
                "", started)
        if fmt in _EXTRA_FORMATS:
            return self._fail(
                result, "skipped",
                DocumentStatus.SUPPORTED_DEPENDENCY_MISSING,
                f"{suffix} needs an uninstalled docling extra", "", started)

        timeout = request.timeout_s or self._default_timeout
        if request.isolation == IsolationMode.PROCESS:
            outcome = run_isolated(
                _isolated_convert_task,
                _task_payload(resolved, request, str(self._cache)),
                timeout,
            )
            elapsed_ms = outcome.elapsed_s * 1000.0
            if outcome.timed_out:
                return self._fail(result, "error", DocumentStatus.PARTIAL,
                                  f"conversion exceeded {timeout:g}s budget "
                                  "(worker terminated; no partial output trusted)",
                                  "timeout", started,
                                  extra_ms=elapsed_ms)
            if not outcome.ok:
                return self._fail(result, "error", DocumentStatus.CORRUPT,
                                  outcome.error[:300] or "isolated worker failed",
                                  "internal", started, extra_ms=elapsed_ms)
            return self._from_payload_dict(result, outcome.result,
                                           elapsed_ms, started)

        # In-process path: measured wall-clock; enforcement of the budget
        # is the caller's supervisor (see IsolationMode.PROCESS).
        try:
            converter, ocr_choice = self._converter_for(request)
            payload = _convert_in_process(resolved, request, self._cache,
                                          converter, ocr_choice)
        except _OcrUnavailable as exc:
            return self._fail(result, "error", DocumentStatus.OCR_FAILED,
                              str(exc)[:300], "policy", started)
        except Exception as exc:  # never let Docling crash AURA
            return self._fail(result, "error", DocumentStatus.CORRUPT,
                              f"conversion failed: {exc}"[:300],
                              "internal", started)
        if not verify_same_file(resolved, file_identity(resolved)):
            return self._fail(result, "error", DocumentStatus.CORRUPT,
                              "file changed during conversion; output refused",
                              "internal", started)
        return self._from_payload_dict(
            result, payload, (time.monotonic() - started) * 1000.0, started)

    # -- internals -----------------------------------------------------
    def _converter_for(self, request: DocumentConversionRequest
                     ) -> tuple[Any, str]:
        """Cached (DocumentConverter, resolved OCR engine name)."""
        engine_choice = self._select_ocr_engine(request)
        key = f"{engine_choice}|{request.ocr_lang}|{request.force_ocr}"
        with self._lock:
            converter = self._converters.get(key)
            if converter is None:
                converter = _build_converter(
                    ocr_engine=engine_choice,
                    ocr_lang=request.ocr_lang,
                    force_ocr=request.force_ocr,
                    cache=self._cache,
                )
                self._converters[key] = converter
            return converter, engine_choice

    def _select_ocr_engine(self, request: DocumentConversionRequest) -> str:
        """Resolve the OCR engine or raise an honest, typed error."""
        wanted = request.ocr_engine.value
        ready = detect_ocr_engines()
        if wanted == OcrEngine.NONE.value:
            return ""
        if wanted == OcrEngine.AUTO.value:
            if not ready:
                raise _OcrUnavailable(
                    "document needs OCR but no local OCR engine is ready "
                    "(install docling[rapidocr] or tesseract-ocr)")
            return ready[0]
        if wanted not in ready:
            raise _OcrUnavailable(
                f"requested OCR engine '{wanted}' is not ready "
                f"(ready: {','.join(ready) or 'none'}); refusing to substitute")
        return wanted

    @staticmethod
    def _fail(result: DocumentConversionResult, status: str,
              doc_status: DocumentStatus, note: str, category: str,
              started: float,
              extra_ms: Optional[float] = None) -> DocumentConversionResult:
        result.status = status
        result.document_status = doc_status
        result.note = note
        if category:
            result.errors.append(ConversionError(message=note[:300],
                                                 category=category))
        elapsed = ((extra_ms if extra_ms is not None else 0.0)
                   or (time.monotonic() - started) * 1000.0)
        result.timings_ms = {"total": elapsed}
        return result

    @staticmethod
    def _from_payload_dict(result: DocumentConversionResult, payload: dict,
                           elapsed_ms: float,
                           started: float) -> DocumentConversionResult:
        result.status = payload.get("status", "error")
        try:
            result.document_status = DocumentStatus(
                payload.get("document_status", "corrupt"))
        except ValueError:
            result.document_status = DocumentStatus.CORRUPT
        result.text = payload.get("text", "")
        result.char_count = len(result.text)
        result.ocr_used = payload.get("ocr_used", "")
        result.note = payload.get("note", "")
        result.page_count = int(payload.get("page_count", 0) or 0)
        result.mime_type = payload.get("mime_type", "")
        result.metadata = dict(payload.get("metadata", {}))
        result.docling_status = payload.get("docling_status", "")
        for t in payload.get("tables", []):
            result.tables.append(StructuredTable(
                rows=t.get("rows", []), page_no=t.get("page_no"),
                caption=t.get("caption", ""),
                markdown=t.get("markdown", "")))
        for i in payload.get("images", []):
            result.images.append(StructuredImage(
                page_no=i.get("page_no"), caption=i.get("caption", ""),
                label=i.get("label", "")))
        for h in payload.get("headings", []):
            result.headings.append(h)
        for c in payload.get("chunks", []):
            result.chunks.append(StructuredChunk(
                text=c.get("text", ""), index=c.get("index", 0),
                page_no=c.get("page_no"),
                heading_path=c.get("heading_path", []),
                kind=c.get("kind", "text"),
                start_char=c.get("start_char", 0),
                end_char=c.get("end_char", 0)))
        for e in payload.get("errors", []):
            result.errors.append(ConversionError(
                message=e.get("message", ""), category=e.get("category",
                                                             "unknown"),
                module=e.get("module", ""), page_no=e.get("page_no")))
        timings = dict(payload.get("timings_ms", {}))
        timings["total"] = elapsed_ms
        result.timings_ms = timings
        return result


class _OcrUnavailable(Exception):
    """Requested OCR cannot run. Caught and typed, never substituted."""


def _task_payload(resolved: Path, request: DocumentConversionRequest,
                  cache: str) -> dict:
    return {
        "path": str(resolved),
        "force_ocr": request.force_ocr,
        "ocr_engine": request.ocr_engine.value,
        "ocr_lang": request.ocr_lang,
        "max_pages": request.max_pages,
        "max_chars": request.max_chars,
        "want_chunks": request.want_chunks,
        "want_tables": request.want_tables,
        "cache": cache,
        "offline": bool(int(os.environ.get("AURA_DOCS_OFFLINE", "0") or 0)),
    }


def _isolated_convert_task(payload: dict) -> dict:
    """Module-level worker entry for process isolation (must stay picklable)."""
    from .doctypes import DocumentConversionRequest as _Req

    req = _Req(
        path=payload["path"],
        force_ocr=payload.get("force_ocr", False),
        ocr_engine=OcrEngine(payload.get("ocr_engine", "auto")),
        ocr_lang=payload.get("ocr_lang", "en"),
        max_pages=payload.get("max_pages", 0),
        max_chars=payload.get("max_chars", 500_000),
        want_chunks=payload.get("want_chunks", True),
        want_tables=payload.get("want_tables", True),
    )
    engine = DoclingEngine(model_cache=payload.get("cache", ""))
    if payload.get("offline"):
        os.environ["HF_HUB_OFFLINE"] = "1"
    try:
        ocr_choice = engine._select_ocr_engine(req)
        converter = _build_converter(ocr_engine=ocr_choice,
                                     ocr_lang=req.ocr_lang,
                                     force_ocr=req.force_ocr,
                                     cache=engine._cache)
        out = _convert_in_process(Path(payload["path"]), req, engine._cache,
                                  converter, ocr_choice)
    except _OcrUnavailable as exc:
        missing_status = ("ocr_required"
                          if req.ocr_engine == OcrEngine.AUTO
                          else "ocr_failed")
        out = {"status": "empty", "document_status": missing_status,
               "note": str(exc),
               "errors": [{"message": str(exc), "category": "policy"}]}
    return out


def _build_converter(ocr_engine: str, ocr_lang: str, force_ocr: bool,
                     cache: Path) -> Any:
    """Construct a local-only DocumentConverter. No remote anything.

    Model weights resolve through the HuggingFace hub cache. The engine
    defaults ``HF_HOME`` to the dedicated AURA cache (never overrides an
    explicit setting), so provisioning = warming the cache once and
    offline mode = ``HF_HUB_OFFLINE=1`` against the seeded cache.
    ``artifacts_path`` is deliberately NOT forced: pointing it at an
    unseeded directory disables auto-download and fails closed.
    """
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    os.environ.setdefault("HF_HOME", str(cache / "hf"))
    pdf_options = PdfPipelineOptions()
    if ocr_engine:
        pdf_options.do_ocr = True
        ocr_cls = _ocr_option_class(ocr_engine)
        if ocr_cls is None:
            raise _OcrUnavailable(
                f"OCR option class for '{ocr_engine}' missing in installed "
                "docling; refusing to substitute")
        try:
            ocr_options = ocr_cls(lang=[ocr_lang])
        except TypeError:
            ocr_options = ocr_cls()
            if hasattr(ocr_options, "lang"):
                ocr_options.lang = [ocr_lang]
        if force_ocr and hasattr(pdf_options, "force_full_page_ocr"):
            pdf_options.force_full_page_ocr = True
        pdf_options.ocr_options = ocr_options
    else:
        pdf_options.do_ocr = False
    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(
            pipeline_options=pdf_options)})


def _convert_in_process(resolved: Path, request: DocumentConversionRequest,
                        cache: Path, converter: Any,
                        ocr_choice: str = "") -> dict:
    """Run conversion, return a JSON-compatible payload dict."""
    from docling.datamodel.base_models import ConversionStatus

    t0 = time.monotonic()
    suffix = resolved.suffix.lower()
    mime = (mimetypes.guess_type(str(resolved))[0] or "").lower()
    kwargs: dict[str, Any] = {"raises_on_error": False}
    if request.max_pages and request.max_pages > 0:
        kwargs["max_num_pages"] = request.max_pages

    result = converter.convert(str(resolved), **kwargs)
    status_value = getattr(result.status, "value", str(result.status))
    errors = [
        {"message": getattr(e, "error_message", str(e))[:300],
         "category": getattr(getattr(e, "category", "unknown"), "value",
                             str(getattr(e, "category", "unknown"))),
         "module": f"{getattr(e, 'component_type', '')}:"
                   f"{getattr(e, 'module_name', '')}",
         "page_no": getattr(e, "page_no", None)}
        for e in (result.errors or [])
    ]

    if status_value == getattr(ConversionStatus.FAILURE, "value",
                               "failure"):
        note = "; ".join(e["message"] for e in errors[:2]) or \
            "conversion failed"
        doc_status = _classify_failure(note)
        return {"status": "error", "document_status": doc_status,
                "note": note[:300], "errors": errors,
                "mime_type": mime, "docling_status": status_value,
                "timings_ms": {"convert": (time.monotonic() - t0) * 1000.0}}
    if status_value == getattr(ConversionStatus.SKIPPED, "value", "skipped"):
        return {"status": "skipped",
                "document_status": "unsupported",
                "note": "; ".join(e["message"] for e in errors[:2])[:300],
                "errors": errors, "mime_type": mime,
                "docling_status": status_value,
                "timings_ms": {"convert": (time.monotonic() - t0) * 1000.0}}

    doc = result.document
    if doc is None:
        return {"status": "error", "document_status": "corrupt",
                "note": "converter returned no document", "errors": errors,
                "mime_type": mime, "docling_status": status_value,
                "timings_ms": {"convert": (time.monotonic() - t0) * 1000.0}}

    markdown = _safe_export(doc, "export_to_markdown")
    text = _safe_export(doc, "export_to_text") or _strip_markdown(markdown)
    tables, images, headings = _extract_structure(doc, request.want_tables)
    page_count = _page_count(doc)
    metadata = _extract_metadata(doc)
    metadata["sourceBytes"] = file_size(resolved)

    partial = status_value in (
        getattr(ConversionStatus.PARTIAL_SUCCESS, "value",
                "partial_success"), "timeout")
    timed_out = status_value == "timeout"
    chunks = _chunk_text(text, headings) if request.want_chunks else []

    limit = request.max_chars or 500_000
    note_parts: list[str] = []
    if errors:
        note_parts.append("; ".join(e["message"] for e in errors[:2]))
    if timed_out:
        note_parts.append("conversion hit the document timeout; "
                          "output covers converted pages only")
    truncated = False
    if len(text) > limit:
        text = text[:limit]
        truncated = True
        note_parts.append(f"text truncated at {limit:,} chars")

    if timed_out or partial or truncated:
        kb_status, doc_status = "partial", "partial"
    elif text.strip():
        kb_status, doc_status = "ok", "success"
    else:
        kb_status, doc_status = "empty", "partial"
        note_parts.append("no extractable text")

    return {
        "status": kb_status, "document_status": doc_status,
        "text": text, "ocr_used": ocr_choice,
        "note": "; ".join(note_parts)[:500],
        "page_count": page_count, "mime_type": mime,
        "metadata": metadata,
        "tables": [t for t in tables],
        "images": [i for i in images],
        "headings": headings,
        "chunks": chunks,
        "errors": errors,
        "docling_status": status_value,
        "timings_ms": {"convert": (time.monotonic() - t0) * 1000.0},
    }


def _classify_failure(note: str) -> str:
    lowered = note.lower()
    if any(k in lowered for k in ("encrypt", "password", "decrypt")):
        return "corrupt"  # encrypted PDFs are refused, surfaced in note
    if any(k in lowered for k in ("tesseract", "ocr", "rapidocr", "easyocr")):
        return "ocr_failed"
    return "corrupt"


def _safe_export(doc: Any, method: str) -> str:
    try:
        exporter = getattr(doc, method, None)
        if exporter is None:
            return ""
        out = exporter()
        return out if isinstance(out, str) else ""
    except Exception:
        return ""


def _strip_markdown(markdown: str) -> str:
    import re

    text = re.sub(r"^#{1,6}\s+", "", markdown, flags=re.M)
    text = re.sub(r"[*_`>|~]", "", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return text.strip()


def _page_count(doc: Any) -> int:
    try:
        pages = getattr(doc, "pages", None)
        if isinstance(pages, dict):
            return len(pages)
        if pages is not None:
            return len(pages)
    except Exception:
        pass
    return 0


def _extract_metadata(doc: Any) -> dict:
    metadata: dict[str, Any] = {}
    for attr in ("name", "origin"):
        try:
            value = getattr(doc, attr, None)
            if value is not None:
                metadata[attr] = str(value)[:200]
        except Exception:
            continue
    try:
        meta = getattr(doc, "metadata", None)
        if meta is not None:
            for key in ("title", "author", "authors", "subject", "creator",
                        "language", "description"):
                value = getattr(meta, key, None)
                if value:
                    metadata[key] = str(value)[:200]
    except Exception:
        pass
    return metadata


def _extract_structure(doc: Any,
                       want_tables: bool) -> tuple[list, list, list]:
    """Walk DoclingDocument items; degrade honestly on schema drift."""
    tables: list[dict] = []
    images: list[dict] = []
    headings: list[str] = []
    try:
        iterator = doc.iterate_items()
    except Exception:
        return tables, images, headings
    try:
        for item, _level in iterator:
            label = str(getattr(getattr(item, "label", ""), "value",
                                getattr(item, "label", "")) or "")
            try:
                page_no = getattr(getattr(item, "prov", [{}])[0],
                                  "page_no", None)
            except Exception:
                page_no = None
            if label in ("title", "section_header", "page_header"):
                text = _item_text(item)
                if text:
                    headings.append(text[:200])
            elif label == "table" and want_tables:
                table = _table_to_dict(item, page_no)
                if table:
                    tables.append(table)
            elif label in ("picture", "figure", "image"):
                images.append({
                    "page_no": page_no,
                    "caption": _item_caption(item)[:200],
                    "label": label,
                })
    except Exception:
        pass
    return tables, images, headings


def _item_text(item: Any) -> str:
    try:
        return str(getattr(item, "text", "") or "").strip()
    except Exception:
        return ""


def _item_caption(item: Any) -> str:
    try:
        captions = getattr(item, "captions", []) or []
        return " ".join(str(getattr(c, "text", c)) for c in captions)
    except Exception:
        return ""


def _table_to_dict(item: Any, page_no: Any) -> dict:
    try:
        table_data = getattr(item, "data", None)
        grid = getattr(table_data, "grid", None) if table_data else None
        rows: list[list[str]] = []
        if grid:
            for row in grid:
                rows.append([_cell_text(cell) for cell in row])
        else:
            exported = ""
            try:
                exported = item.export_to_markdown() or ""
            except Exception:
                exported = ""
            for line in exported.splitlines():
                line = line.strip()
                if line.startswith("|") and line.endswith("|"):
                    rows.append([c.strip() for c in line.strip("|").split("|")])
        if not rows:
            return {}
        md_lines = ["| " + " | ".join(r) + " |" for r in rows]
        return {"rows": rows, "page_no": page_no,
                "caption": _item_caption(item)[:200],
                "markdown": "\n".join(md_lines)}
    except Exception:
        return {}


def _cell_text(cell: Any) -> str:
    try:
        text = getattr(cell, "text", cell)
        return str(text or "").strip()
    except Exception:
        return ""


def _chunk_text(text: str, headings: list[str]) -> list[dict]:
    """Structure-light chunking: heading-aware splits, 1500/150 KB parity.

    Docling's HybridChunker needs a HF tokenizer download; to stay
    offline-safe the adapter chunks locally and records headings as
    provenance. A tokenizer-aligned chunker can replace this later
    without changing the schema.
    """
    import re

    size, overlap = 1500, 150
    # Split on markdown headings first so chunks keep section context.
    sections: list[tuple[str, str]] = []
    current_head, buf = "", []
    for line in text.splitlines(keepends=True):
        match = re.match(r"^(#{1,4})\s+(.*)", line)
        if match:
            if buf:
                sections.append((current_head, "".join(buf)))
            current_head = match.group(2).strip()[:200]
            buf = [line]
        else:
            buf.append(line)
    if buf:
        sections.append((current_head, "".join(buf)))
    if not sections:
        sections = [("", text)]

    chunks: list[dict] = []
    index, offset = 0, 0
    for head, body in sections:
        start = 0
        total = len(body)
        if not body.strip():
            offset += total
            continue
        while start < total:
            end = min(start + size, total)
            if end < total:
                for sep in ("\n\n", "\n", ". ", " "):
                    cut = body.rfind(sep, start, end)
                    if cut > start + size // 4:
                        end = cut + len(sep)
                        break
            piece = body[start:end]
            if piece.strip():
                chunks.append({
                    "text": piece, "index": index,
                    "page_no": None,
                    "heading_path": [head] if head else [],
                    "kind": "text",
                    "start_char": offset + start,
                    "end_char": offset + end,
                })
                index += 1
            if end >= total:
                break
            start = max(end - overlap, start + 1)
        offset += total
    # NOTE: `headings` also surface top-level on the result; per-chunk
    # heading_path carries the section provenance for retrieval.
    return chunks
