"""Public data model for the AURA document-intelligence subsystem.

This module is intentionally dependency-free (stdlib only) so that the rest
of AURA can import the integration contract without installing Docling.

It reuses the existing knowledge-base vocabulary (``ExtractionStatus`` /
``ExtractionResult`` from :mod:`aura.multimodal.ingestor`) instead of
duplicating it, and adds the explicit conversion statuses the Docling
integration design requires.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class DocumentStatus(str, Enum):
    """Explicit outcome vocabulary for document conversion.

    No silent fallback: every conversion ends in exactly one of these.
    """

    SUCCESS = "success"                        # fully converted
    PARTIAL = "partial"                        # converted with issues (see errors/note)
    SUPPORTED = "supported"                    # format supported (capability query)
    SUPPORTED_DEPENDENCY_MISSING = "supported_dependency_missing"
    OCR_REQUIRED = "ocr_required"              # scan detected, no OCR backend ready
    OCR_FAILED = "ocr_failed"                  # OCR attempted and failed
    UNSUPPORTED = "unsupported"                # no engine claims this format
    CORRUPT = "corrupt"                        # file unreadable/encrypted/invalid


class OcrEngine(str, Enum):
    """Local OCR engine selection. Cloud OCR is never an option."""

    AUTO = "auto"                  # first ready engine: rapidocr → tesseract
    RAPIDOCR = "rapidocr"          # RapidOCR via ONNX (pip package, no system dep)
    TESSERACT = "tesseract"        # Tesseract via tesserocr bindings or CLI
    EASYOCR = "easyocr"            # EasyOCR via torch (heavy; optional)
    NONE = "none"                  # OCR disabled; scans yield OCR_REQUIRED


class IsolationMode(str, Enum):
    """How a conversion is executed."""

    IN_PROCESS = "in_process"      # same process; fastest, shares model cache
    PROCESS = "process"            # separate process; hard timeout enforceable


@dataclass
class ConversionError:
    """One structured conversion failure. Mirrors Docling's ErrorItem."""

    message: str
    category: str = "unknown"      # e.g. backend_failure, inference_failure,
    # policy, timeout, source_unavailable, internal
    module: str = ""               # component that raised
    page_no: Optional[int] = None  # 1-based page, if attributable


@dataclass
class StructuredTable:
    """A table preserved as structure, never flattened beyond recognition."""

    rows: list[list[str]] = field(default_factory=list)
    page_no: Optional[int] = None
    caption: str = ""
    markdown: str = ""             # markdown rendering of this table

    @property
    def num_rows(self) -> int:
        return len(self.rows)

    @property
    def num_cols(self) -> int:
        return max((len(r) for r in self.rows), default=0)

    def to_dict(self) -> dict:
        return {
            "rows": self.rows,
            "pageNo": self.page_no,
            "caption": self.caption,
            "markdown": self.markdown,
            "numRows": self.num_rows,
            "numCols": self.num_cols,
        }


@dataclass
class StructuredImage:
    """An image or figure reference found in the document."""

    page_no: Optional[int] = None
    caption: str = ""
    label: str = ""                # e.g. chart, diagram, figure
    path: str = ""                 # exported artifact path, if any


@dataclass
class StructuredChunk:
    """One retrieval-ready chunk with source provenance."""

    text: str
    index: int = 0
    page_no: Optional[int] = None
    heading_path: list[str] = field(default_factory=list)
    kind: str = "text"             # text | table | list | heading | caption
    start_char: int = 0
    end_char: int = 0

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "index": self.index,
            "pageNo": self.page_no,
            "headingPath": list(self.heading_path),
            "kind": self.kind,
            "startChar": self.start_char,
            "endChar": self.end_char,
        }


@dataclass
class StructuredDocument:
    """Normalized document representation produced by any engine."""

    text: str = ""
    markdown: str = ""
    tables: list[StructuredTable] = field(default_factory=list)
    images: list[StructuredImage] = field(default_factory=list)
    headings: list[str] = field(default_factory=list)
    chunks: list[StructuredChunk] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    page_count: int = 0

    def to_dict(self, include_text: bool = False) -> dict:
        payload: dict[str, Any] = {
            "pageCount": self.page_count,
            "headings": list(self.headings),
            "tables": [t.to_dict() for t in self.tables],
            "images": [vars(i) for i in self.images],
            "chunks": [c.to_dict() for c in self.chunks],
            "metadata": dict(self.metadata),
            "charCount": len(self.text),
        }
        if include_text:
            payload["text"] = self.text
            payload["markdown"] = self.markdown
        return payload


@dataclass
class DocumentConversionRequest:
    """One conversion request. Never raises at construction."""

    path: str
    force_ocr: bool = False        # OCR even when a text layer exists
    ocr_engine: OcrEngine = OcrEngine.AUTO
    ocr_lang: str = "en"           # BCP-47 tag, e.g. en, de, fr
    max_pages: int = 0             # 0 = engine default / unlimited
    max_chars: int = 500_000       # soft cap on output text (KB parity)
    timeout_s: float = 300.0       # wall-clock budget per document
    isolation: IsolationMode = IsolationMode.IN_PROCESS
    want_chunks: bool = True
    want_tables: bool = True


@dataclass
class DocumentConversionResult:
    """Result of one conversion. Methods never raise for missing engines."""

    path: str
    status: str = "error"          # ExtractionStatus value (KB-compatible)
    document_status: DocumentStatus = DocumentStatus.CORRUPT
    text: str = ""
    engine: str = "none"           # native | docling | none
    ocr_used: str = ""             # e.g. rapidocr, tesseract, ""
    note: str = ""
    page_count: int = 0
    mime_type: str = ""
    char_count: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    tables: list[StructuredTable] = field(default_factory=list)
    images: list[StructuredImage] = field(default_factory=list)
    headings: list[str] = field(default_factory=list)
    chunks: list[StructuredChunk] = field(default_factory=list)
    errors: list[ConversionError] = field(default_factory=list)
    timings_ms: dict[str, float] = field(default_factory=dict)
    docling_status: str = ""       # raw upstream status, when applicable

    def to_extraction_result(self):  # -> ExtractionResult (lazy import)
        """Down-convert to the existing KB vocabulary (lossy by design)."""
        from .ingestor import ExtractionResult, ExtractionStatus

        try:
            kb_status = ExtractionStatus(self.status)
        except ValueError:
            kb_status = ExtractionStatus.ERROR
        return ExtractionResult(
            path=self.path,
            text=self.text,
            status=kb_status,
            note=self.note,
            page_count=self.page_count,
            mime_type=self.mime_type,
            metadata=dict(self.metadata),
        )

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "status": self.status,
            "documentStatus": self.document_status.value,
            "engine": self.engine,
            "ocrUsed": self.ocr_used or None,
            "note": self.note or None,
            "pageCount": self.page_count,
            "mimeType": self.mime_type,
            "charCount": len(self.text),
            "metadata": dict(self.metadata),
            "tables": [t.to_dict() for t in self.tables],
            "headings": list(self.headings),
            "chunkCount": len(self.chunks),
            "errors": [vars(e) for e in self.errors],
            "timingsMs": dict(self.timings_ms),
            "doclingStatus": self.docling_status or None,
            # Text is NOT included: callers access .text directly.
        }


@dataclass
class DocumentCapabilities:
    """Installed-capability discovery. Nothing here is claimed; all probed."""

    docling_installed: bool = False
    docling_version: str = ""
    formats: dict[str, str] = field(default_factory=dict)  # suffix → engine
    ocr_engines: list[str] = field(default_factory=list)   # ready engines
    ocr_requested: str = "auto"
    libreoffice_available: bool = False
    tesseract_available: bool = False
    models_cached: bool = False
    model_cache_dir: str = ""
    offline_ready: bool = False

    def supports(self, suffix: str) -> bool:
        return suffix.lower() in self.formats

    def to_dict(self) -> dict:
        return {
            "doclingInstalled": self.docling_installed,
            "doclingVersion": self.docling_version,
            "formats": dict(self.formats),
            "ocrEngines": list(self.ocr_engines),
            "ocrRequested": self.ocr_requested,
            "libreofficeAvailable": self.libreoffice_available,
            "tesseractAvailable": self.tesseract_available,
            "modelsCached": self.models_cached,
            "modelCacheDir": self.model_cache_dir,
            "offlineReady": self.offline_ready,
        }


@dataclass
class DocumentEngineHealth:
    """Health report distinguishing install / models / OCR / offline."""

    available: bool = False        # can convert at least one format now
    docling_installed: bool = False
    docling_version: str = ""
    models_cached: bool = False
    ocr_ready: bool = False
    ocr_engines: list[str] = field(default_factory=list)
    offline_ready: bool = False
    missing: list[str] = field(default_factory=list)  # honest gap list
    detail: str = ""

    def to_dict(self) -> dict:
        return {
            "available": self.available,
            "doclingInstalled": self.docling_installed,
            "doclingVersion": self.docling_version,
            "modelsCached": self.models_cached,
            "ocrReady": self.ocr_ready,
            "ocrEngines": list(self.ocr_engines),
            "offlineReady": self.offline_ready,
            "missing": list(self.missing),
            "detail": self.detail,
        }
