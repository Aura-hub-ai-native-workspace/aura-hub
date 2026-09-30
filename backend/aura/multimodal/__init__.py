"""Multimodal document ingestion — local-only text extraction (S6–S7).

Supported formats and their extraction strategies:

  PDF   → pypdf (text layer) + pytesseract OCR fallback for scanned pages
  DOCX  → python-docx XML traversal (pure Python, no COM, no LibreOffice)
  Images → pytesseract OCR first; Ollama vision model fallback
  TXT / MD / RST / CSV → direct read, no library required

All extraction runs locally.  No content is sent to cloud services.
Library dependencies are optional: each extractor gracefully degrades when
its library is absent, returning a partial result with an honest status.

Install optional dependencies:
    pip install aura-backend[multimodal]

Tesseract OCR (system binary, not a pip package):
    Ubuntu/Debian: apt install tesseract-ocr
    macOS:         brew install tesseract
    Windows:       https://github.com/UB-Mannheim/tesseract/wiki
AURA detects the binary at runtime — no configuration needed.

Document-intelligence subsystem (Docling-backed, optional):

    pip install aura-backend[docling]
    python scripts/provision-docling-models.py

    from aura.multimodal.document_engine import DocumentEngine, EngineConfig

    engine = DocumentEngine(EngineConfig.from_env())
    result = engine.convert("report.pdf")   # never raises for bad input
"""

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
    StructuredDocument,
    StructuredImage,
    StructuredTable,
)
from .document_engine import DocumentEngine, EngineConfig
from .ingestor import DocumentIngestor, ExtractionResult, ExtractionStatus

__all__ = [
    "ConversionError",
    "DocumentCapabilities",
    "DocumentConversionRequest",
    "DocumentConversionResult",
    "DocumentEngine",
    "DocumentEngineHealth",
    "DocumentIngestor",
    "DocumentStatus",
    "EngineConfig",
    "ExtractionResult",
    "ExtractionStatus",
    "IsolationMode",
    "OcrEngine",
    "StructuredChunk",
    "StructuredDocument",
    "StructuredImage",
    "StructuredTable",
]
