"""NativeTextEngine — dependency-free fallback for plain-text formats.

Handles what needs no ML: .txt .md .rst .csv .json .yaml .yml.
Everything else yields UNSUPPORTED so the dispatcher can try Docling.

Never imports Docling. Never touches the network. Never raises for
expected conditions (missing file, bad encoding, over-budget text all
become typed results).
"""

from __future__ import annotations

import mimetypes
import time

from .doctypes import (
    ConversionError,
    DocumentConversionRequest,
    DocumentConversionResult,
    DocumentStatus,
    StructuredChunk,
)
from .secure import (
    PathSecurityError,
    file_identity,
    file_size,
    resolve_secure,
    verify_same_file,
)

#: Suffixes this engine claims. Images and office formats are NOT here.
NATIVE_SUFFIXES = frozenset({
    ".txt", ".md", ".rst", ".csv", ".json", ".yaml", ".yml",
})

_ARCHIVE_SUFFIXES = frozenset({
    ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
})


class NativeTextEngine:
    """Plain-text extraction with budgets and provenance-preserving chunks."""

    name = "native"

    def __init__(self, max_chars: int = 500_000,
                 chunk_chars: int = 1500, chunk_overlap: int = 150) -> None:
        self._max_chars = max_chars
        self._chunk_chars = chunk_chars
        self._chunk_overlap = chunk_overlap

    # -- capability ----------------------------------------------------
    def claims(self, suffix: str) -> bool:
        return suffix.lower() in NATIVE_SUFFIXES

    @staticmethod
    def is_archive(suffix: str) -> bool:
        return suffix.lower() in _ARCHIVE_SUFFIXES

    # -- conversion ----------------------------------------------------
    def convert(self, request: DocumentConversionRequest) -> DocumentConversionResult:
        started = time.monotonic()
        result = DocumentConversionResult(path=request.path, engine=self.name)
        try:
            resolved = resolve_secure(request.path)
        except PathSecurityError as exc:
            result.status = "error"
            result.document_status = DocumentStatus.CORRUPT
            result.note = f"path rejected: {exc}"
            result.errors.append(ConversionError(message=str(exc),
                                                 category="policy"))
            return result

        suffix = resolved.suffix.lower()
        if self.is_archive(suffix):
            result.status = "skipped"
            result.document_status = DocumentStatus.UNSUPPORTED
            result.note = f"archive extraction is not supported: {suffix}"
            return result
        if not self.claims(suffix):
            result.status = "skipped"
            result.document_status = DocumentStatus.UNSUPPORTED
            result.note = f"unsupported file type: {suffix or '(no extension)'}"
            return result

        mime = (mimetypes.guess_type(str(resolved))[0] or "").lower()
        result.mime_type = mime or "text/plain"
        identity = file_identity(resolved)

        text: str = ""
        for encoding in ("utf-8", "utf-8-sig", "latin-1"):
            try:
                text = resolved.read_text(encoding=encoding)
                break
            except (UnicodeDecodeError, ValueError):
                continue
            except OSError as exc:
                result.status = "error"
                result.document_status = DocumentStatus.CORRUPT
                result.note = f"read failed: {exc}"[:200]
                result.errors.append(ConversionError(message=str(exc)[:200],
                                                     category="source_unavailable"))
                return result
        else:
            result.status = "error"
            result.document_status = DocumentStatus.CORRUPT
            result.note = "file is not valid text (binary?)"
            return result

        if not verify_same_file(resolved, identity):
            result.status = "error"
            result.document_status = DocumentStatus.CORRUPT
            result.note = "file changed during read; refusing half-read content"
            result.errors.append(ConversionError(message=result.note,
                                                 category="internal"))
            return result

        size = file_size(resolved)
        result.metadata = {"sourceBytes": size, "encoding": "utf-8"}
        result.page_count = 0

        limit = request.max_chars or self._max_chars
        if len(text) > limit:
            text = text[:limit]
            result.note = f"text truncated at {limit:,} chars"
            result.document_status = DocumentStatus.PARTIAL
            result.status = "partial"
        else:
            result.status = "ok" if text.strip() else "empty"
            result.document_status = (DocumentStatus.SUCCESS if text.strip()
                                      else DocumentStatus.PARTIAL)
            if not text.strip():
                result.note = "file readable but contains no text"

        result.text = text
        result.char_count = len(text)
        if request.want_chunks and text.strip():
            result.chunks = self.chunk_text(text)
        result.timings_ms = {"total": (time.monotonic() - started) * 1000.0}
        return result

    # -- chunking (KB parity: 1500 chars / 150 overlap, sentence backoff)
    def chunk_text(self, text: str) -> list[StructuredChunk]:
        size, overlap = self._chunk_chars, self._chunk_overlap
        chunks: list[StructuredChunk] = []
        start, index = 0, 0
        total = len(text)
        while start < total:
            end = min(start + size, total)
            if end < total:
                for sep in ("\n\n", "\n", ". ", " "):
                    cut = text.rfind(sep, start, end)
                    if cut > start + size // 4:
                        end = cut + len(sep)
                        break
            piece = text[start:end]
            if piece.strip():
                chunks.append(StructuredChunk(
                    text=piece, index=index, start_char=start, end_char=end))
                index += 1
            if end >= total:
                break
            start = max(end - overlap, start + 1)
        return chunks
