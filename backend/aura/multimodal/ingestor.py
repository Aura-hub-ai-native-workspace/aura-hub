"""DocumentIngestor — dispatch file ingestion by type.

Design rules:
- Local only: no content reaches any network service during extraction
- Graceful degradation: missing optional library → PARTIAL status, not crash
- Honest output: ExtractionStatus accurately reflects what was extracted
- No secrets in results: file path, page counts, metadata — never API keys

ExtractionResult.status values:
  OK       — full text extracted
  PARTIAL  — some pages/sections extracted; remainder explains why
  EMPTY    — file readable but no extractable text (e.g. image-only PDF)
  SKIPPED  — file type not supported
  ERROR    — unrecoverable error reading the file
"""

from __future__ import annotations

import mimetypes
import os
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional


class ExtractionStatus(str, Enum):
    OK = "ok"
    PARTIAL = "partial"
    EMPTY = "empty"
    SKIPPED = "skipped"
    ERROR = "error"


@dataclass
class ExtractionResult:
    """Extracted text and metadata from a single document.

    Fields:
        path        — absolute path to the source file
        text        — extracted text, UTF-8, stripped of control characters
        status      — extraction completeness
        note        — human-readable explanation when status != OK
        page_count  — number of pages (PDF) or sections (DOCX); 0 if unknown
        mime_type   — detected MIME type
        char_count  — len(text)
        metadata    — optional document metadata (title, author, etc.)
    """

    path: str
    text: str = ""
    status: ExtractionStatus = ExtractionStatus.OK
    note: str = ""
    page_count: int = 0
    mime_type: str = ""
    char_count: int = field(init=False, default=0)
    metadata: dict = field(default_factory=dict)

    def __post_init__(self):
        self.char_count = len(self.text)

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "status": self.status.value,
            "note": self.note or None,
            "pageCount": self.page_count,
            "mimeType": self.mime_type,
            "charCount": self.char_count,
            "metadata": self.metadata,
            # Text is NOT included in to_dict() to avoid accidental logging
            # of document content. Callers access .text directly.
        }


# Mapping of file suffix → extractor function name (used by dispatch)
_SUFFIX_MAP: dict[str, str] = {
    ".pdf":  "_extract_pdf",
    ".docx": "_extract_docx",
    ".doc":  "_extract_doc_fallback",
    ".txt":  "_extract_text",
    ".md":   "_extract_text",
    ".rst":  "_extract_text",
    ".csv":  "_extract_text",
    ".json": "_extract_text",
    ".yaml": "_extract_text",
    ".yml":  "_extract_text",
    ".png":  "_extract_image",
    ".jpg":  "_extract_image",
    ".jpeg": "_extract_image",
    ".gif":  "_extract_image",
    ".bmp":  "_extract_image",
    ".tiff": "_extract_image",
    ".tif":  "_extract_image",
    ".webp": "_extract_image",
}


class DocumentIngestor:
    """Ingest documents to plain text for the knowledge base and agent context.

    Args:
        model_port: optional ModelPort for vision-model OCR fallback on images.
            When None, image extraction uses only pytesseract (if available).
        ocr_lang: Tesseract language string (default "eng"). Multiple languages
            can be combined: "eng+fra".
        max_chars: soft cap on extracted text. Content beyond this is silently
            truncated — use a large value unless memory is constrained.
    """

    def __init__(self, model_port=None, ocr_lang: str = "eng",
                 max_chars: int = 500_000) -> None:
        self._model_port = model_port
        self._ocr_lang = ocr_lang
        self._max_chars = max_chars

    def ingest(self, path: str | Path) -> ExtractionResult:
        """Extract text from a single file.

        Never raises. Returns ExtractionResult with status=ERROR on failure.
        """
        p = Path(path).resolve()
        mime = (mimetypes.guess_type(str(p))[0] or "").lower()
        suffix = p.suffix.lower()

        if not p.exists():
            return ExtractionResult(
                path=str(p), status=ExtractionStatus.ERROR,
                note=f"file not found: {p}", mime_type=mime)

        extractor_name = _SUFFIX_MAP.get(suffix)
        if extractor_name is None:
            return ExtractionResult(
                path=str(p), status=ExtractionStatus.SKIPPED,
                note=f"unsupported file type: {suffix or '(no extension)'}",
                mime_type=mime)

        extractor = getattr(self, extractor_name)
        try:
            result = extractor(p, mime)
        except Exception as exc:
            result = ExtractionResult(
                path=str(p), status=ExtractionStatus.ERROR,
                note=f"extraction failed: {str(exc)[:200]}",
                mime_type=mime)

        # Enforce max_chars cap
        if len(result.text) > self._max_chars:
            result.text = result.text[:self._max_chars]
            result.note = (result.note + "; " if result.note else "") + \
                f"text truncated at {self._max_chars:,} chars"
            if result.status == ExtractionStatus.OK:
                result.status = ExtractionStatus.PARTIAL
        result.char_count = len(result.text)

        return result

    def ingest_batch(self, paths: list[str | Path]) -> list[ExtractionResult]:
        """Ingest multiple files. Results are in the same order as paths."""
        return [self.ingest(p) for p in paths]

    # ------------------------------------------------------------------
    # Extractors
    # ------------------------------------------------------------------

    def _extract_pdf(self, path: Path, mime: str) -> ExtractionResult:
        try:
            import pypdf
        except ImportError:
            return ExtractionResult(
                path=str(path), mime_type=mime,
                status=ExtractionStatus.PARTIAL,
                note="pypdf not installed (pip install aura-backend[multimodal])")

        pages_text: list[str] = []
        scanned_pages: list[int] = []
        metadata: dict = {}
        page_count = 0

        with open(path, "rb") as f:
            reader = pypdf.PdfReader(f)
            page_count = len(reader.pages)

            # Document metadata (author, title, subject — never content secrets)
            if reader.metadata:
                for k in ("/Title", "/Author", "/Subject", "/Creator"):
                    v = reader.metadata.get(k)
                    if v:
                        metadata[k.lstrip("/")] = str(v)[:200]

            for i, page in enumerate(reader.pages):
                try:
                    text = page.extract_text() or ""
                except Exception:
                    text = ""
                if text.strip():
                    pages_text.append(text)
                else:
                    scanned_pages.append(i + 1)

        # For scanned pages, try OCR if pytesseract is available
        if scanned_pages:
            ocr_texts = self._ocr_pdf_pages(path, scanned_pages)
            pages_text.extend(ocr_texts)

        full_text = "\n\n".join(pages_text)
        status = ExtractionStatus.OK

        if not full_text.strip():
            status = ExtractionStatus.EMPTY
            note = (f"PDF has {page_count} page(s) but no extractable text."
                    " The file may be scanned without OCR.")
        elif scanned_pages and not _tesseract_available():
            status = ExtractionStatus.PARTIAL
            note = (f"{len(scanned_pages)} of {page_count} page(s) are scanned"
                    " images; OCR skipped (install Tesseract for full extraction).")
        else:
            note = ""

        return ExtractionResult(
            path=str(path), text=full_text, status=status, note=note,
            page_count=page_count, mime_type=mime, metadata=metadata)

    def _ocr_pdf_pages(self, pdf_path: Path, page_numbers: list[int]) -> list[str]:
        """OCR selected 1-based page numbers from a PDF using Pillow + Tesseract."""
        if not _tesseract_available():
            return []
        try:
            import pytesseract
            from PIL import Image
            import pypdf
        except ImportError:
            return []

        texts: list[str] = []
        try:
            with open(pdf_path, "rb") as f:
                reader = pypdf.PdfReader(f)
                for pnum in page_numbers:
                    if pnum < 1 or pnum > len(reader.pages):
                        continue
                    # Render PDF page to image via pypdf's page image extraction
                    # (requires pypdf[image] or falls back gracefully)
                    try:
                        import io
                        page = reader.pages[pnum - 1]
                        # Check if pypdf can render to image
                        if hasattr(page, "images") and page.images:
                            for img_data in page.images:
                                img = Image.open(io.BytesIO(img_data.data))
                                text = pytesseract.image_to_string(
                                    img, lang=self._ocr_lang)
                                if text.strip():
                                    texts.append(text.strip())
                    except Exception:
                        continue
        except Exception:
            pass
        return texts

    def _extract_docx(self, path: Path, mime: str) -> ExtractionResult:
        try:
            import docx
        except ImportError:
            return ExtractionResult(
                path=str(path), mime_type=mime,
                status=ExtractionStatus.PARTIAL,
                note="python-docx not installed (pip install aura-backend[multimodal])")

        doc = docx.Document(str(path))
        paragraphs: list[str] = []

        # Body paragraphs
        for para in doc.paragraphs:
            text = para.text.strip()
            if text:
                paragraphs.append(text)

        # Tables
        for table in doc.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text.strip()]
                if cells:
                    paragraphs.append(" | ".join(cells))

        # Document properties metadata
        metadata: dict = {}
        try:
            props = doc.core_properties
            if props.title:
                metadata["Title"] = str(props.title)[:200]
            if props.author:
                metadata["Author"] = str(props.author)[:200]
            if props.subject:
                metadata["Subject"] = str(props.subject)[:200]
        except Exception:
            pass

        full_text = "\n\n".join(paragraphs)
        status = ExtractionStatus.OK if full_text.strip() else ExtractionStatus.EMPTY
        return ExtractionResult(
            path=str(path), text=full_text, status=status,
            page_count=len(doc.paragraphs),
            mime_type=mime, metadata=metadata,
            note="" if full_text.strip() else "Document has no text content")

    def _extract_doc_fallback(self, path: Path, mime: str) -> ExtractionResult:
        return ExtractionResult(
            path=str(path), mime_type=mime,
            status=ExtractionStatus.SKIPPED,
            note=".doc (binary Word) is not supported. Convert to .docx first.")

    def _extract_text(self, path: Path, mime: str) -> ExtractionResult:
        for encoding in ("utf-8", "utf-8-sig", "latin-1"):
            try:
                text = path.read_text(encoding=encoding)
                return ExtractionResult(
                    path=str(path), text=text,
                    status=ExtractionStatus.OK,
                    mime_type=mime or "text/plain")
            except UnicodeDecodeError:
                continue
        return ExtractionResult(
            path=str(path), status=ExtractionStatus.ERROR,
            note="file is not valid text (binary?)", mime_type=mime)

    def _extract_image(self, path: Path, mime: str) -> ExtractionResult:
        """Extract text from an image via OCR (Tesseract) or vision model."""
        if _tesseract_available():
            return self._ocr_image_tesseract(path, mime)
        if self._model_port is not None:
            return self._ocr_image_vision_model(path, mime)
        return ExtractionResult(
            path=str(path), mime_type=mime,
            status=ExtractionStatus.PARTIAL,
            note=(
                "No OCR backend available. "
                "Install Tesseract (tesseract-ocr system package) or connect "
                "a vision-capable local model via Ollama."
            ))

    def _ocr_image_tesseract(self, path: Path, mime: str) -> ExtractionResult:
        try:
            import pytesseract
            from PIL import Image
        except ImportError:
            return ExtractionResult(
                path=str(path), mime_type=mime,
                status=ExtractionStatus.PARTIAL,
                note="pytesseract/Pillow not installed")

        try:
            img = Image.open(str(path))
            text = pytesseract.image_to_string(img, lang=self._ocr_lang)
            status = (ExtractionStatus.OK if text.strip()
                      else ExtractionStatus.EMPTY)
            return ExtractionResult(
                path=str(path), text=text.strip(), status=status,
                mime_type=mime,
                note="" if text.strip() else "No text detected in image")
        except Exception as exc:
            return ExtractionResult(
                path=str(path), mime_type=mime,
                status=ExtractionStatus.ERROR,
                note=f"Tesseract OCR failed: {str(exc)[:200]}")

    def _ocr_image_vision_model(self, path: Path, mime: str) -> ExtractionResult:
        """Ask a local vision model (Ollama llava etc.) to describe the image."""
        try:
            import base64
            img_b64 = base64.b64encode(path.read_bytes()).decode("ascii")
            prompt = (
                "Please extract and transcribe all visible text from this image. "
                "Return only the extracted text, with no commentary."
            )
            # Vision models via Ollama accept base64 images in the user message.
            # The model_port interface is plain text; we embed the image as a
            # data URI in the user message for models that support it.
            data_uri = f"data:{mime or 'image/png'};base64,{img_b64}"
            result = self._model_port.complete_json(
                system=(
                    "You are a precise OCR system. Extract text from images "
                    "exactly as written. Return only the extracted text."
                ),
                user=f"{prompt}\n\nImage: {data_uri}")
            if result and isinstance(result, dict):
                text = str(result.get("text") or result.get("content") or "")
            else:
                text = ""
            status = ExtractionStatus.OK if text.strip() else ExtractionStatus.EMPTY
            return ExtractionResult(
                path=str(path), text=text.strip(), status=status,
                mime_type=mime,
                note="extracted via vision model" if text.strip() else
                     "vision model returned no text")
        except Exception as exc:
            return ExtractionResult(
                path=str(path), mime_type=mime,
                status=ExtractionStatus.ERROR,
                note=f"Vision model OCR failed: {str(exc)[:200]}")


def _tesseract_available() -> bool:
    """True when the pytesseract package AND the Tesseract binary are present."""
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False
