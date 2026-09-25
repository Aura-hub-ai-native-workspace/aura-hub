"""DocumentEngine — stable dispatch boundary for document intelligence.

Claude (integrator) touches this module, not Docling internals::

    from aura.multimodal.document_engine import DocumentEngine, EngineConfig

    engine = DocumentEngine(EngineConfig.from_env())
    print(engine.health().to_dict())
    result = engine.convert("report.pdf")

Routing: archives are rejected outright; native text formats stay on the
dependency-free NativeTextEngine; everything else goes to DoclingEngine,
which reports SUPPORTED_DEPENDENCY_MISSING instead of crashing when the
package, a system binary, or the model cache is absent.
"""

from __future__ import annotations

import mimetypes
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .docling_engine import DoclingEngine
from .doctypes import (
    DocumentCapabilities,
    DocumentConversionRequest,
    DocumentConversionResult,
    DocumentEngineHealth,
    DocumentStatus,
    IsolationMode,
    OcrEngine,
)
from .native import NATIVE_SUFFIXES, NativeTextEngine
from .process_supervisor import max_workers_for_machine
from .secure import PathSecurityError, resolve_secure


@dataclass
class EngineConfig:
    """Tunable behavior; every field overridable from the environment."""

    preferred: str = "auto"          # auto | native | docling
    ocr_engine: OcrEngine = OcrEngine.AUTO
    ocr_lang: str = "en"
    force_ocr: bool = False
    model_cache: str = ""
    max_chars: int = 500_000
    max_file_bytes: int = 50 * 1024 * 1024   # upload parity: 50 MB
    max_pages: int = 0                       # 0 = no adapter-level cap
    timeout_s: float = 300.0
    isolation: IsolationMode = IsolationMode.IN_PROCESS
    max_workers: int = 2
    confinement_root: str = ""               # "" = no root confinement

    @classmethod
    def from_env(cls) -> "EngineConfig":
        get = os.environ.get

        def _int(name: str, default: int) -> int:
            try:
                return int(get(name, "") or default)
            except ValueError:
                return default

        def _float(name: str, default: float) -> float:
            try:
                return float(get(name, "") or default)
            except ValueError:
                return default

        ocr = (get("AURA_DOCS_OCR", "auto") or "auto").lower()
        try:
            ocr_engine = OcrEngine(ocr)
        except ValueError:
            ocr_engine = OcrEngine.AUTO
        isolation = (get("AURA_DOCS_ISOLATION", "in_process") or
                     "in_process").lower()
        try:
            isolation_mode = IsolationMode(isolation)
        except ValueError:
            isolation_mode = IsolationMode.IN_PROCESS
        workers = _int("AURA_DOCS_MAX_WORKERS", 0) or \
            max_workers_for_machine(2)
        return cls(
            preferred=(get("AURA_DOCS_ENGINE", "auto") or "auto").lower(),
            ocr_engine=ocr_engine,
            ocr_lang=get("AURA_DOCS_OCR_LANG", "en") or "en",
            force_ocr=(get("AURA_DOCS_FORCE_OCR", "") or "").lower() in
            ("1", "true", "yes", "on"),
            model_cache=get("AURA_DOCS_MODEL_CACHE", "") or "",
            max_chars=_int("AURA_DOCS_MAX_CHARS", 500_000),
            max_file_bytes=_int("AURA_DOCS_MAX_BYTES", 50 * 1024 * 1024),
            max_pages=_int("AURA_DOCS_MAX_PAGES", 0),
            timeout_s=_float("AURA_DOCS_TIMEOUT_S", 300.0),
            isolation=isolation_mode,
            max_workers=max(1, workers),
            confinement_root=get("AURA_DOCS_ROOT", "") or "",
        )


class DocumentEngine:
    """Owns routing, budgets, batching, capability discovery, health."""

    def __init__(self, config: Optional[EngineConfig] = None) -> None:
        self.config = config or EngineConfig.from_env()
        self.native = NativeTextEngine(max_chars=self.config.max_chars)
        self.docling = DoclingEngine(model_cache=self.config.model_cache,
                                     default_timeout_s=self.config.timeout_s)
        self._batch_sem = threading.Semaphore(max(1, self.config.max_workers))

    # -- discovery -----------------------------------------------------
    def capabilities(self) -> DocumentCapabilities:
        caps = self.docling.capabilities(
            ocr_requested=self.config.ocr_engine.value)
        for suffix in sorted(NATIVE_SUFFIXES):
            caps.formats.setdefault(suffix, "native:text")
        return caps

    def health(self) -> DocumentEngineHealth:
        doc_health = self.docling.health()
        # Native text is always available: the engine as a whole degrades
        # to text-only rather than reporting fully down, so `available`
        # reflects "can convert at least one format right now" (always
        # true) while `missing` carries every honest gap.
        return DocumentEngineHealth(
            available=True,
            docling_installed=doc_health.docling_installed,
            docling_version=doc_health.docling_version,
            models_cached=doc_health.models_cached,
            ocr_ready=doc_health.ocr_ready,
            ocr_engines=doc_health.ocr_engines,
            offline_ready=doc_health.offline_ready,
            missing=list(doc_health.missing),
            detail=f"native=text-ok; docling: {doc_health.detail}",
        )

    # -- conversion ----------------------------------------------------
    def convert(self, path: str | Path,
                request: Optional[DocumentConversionRequest] = None
                ) -> DocumentConversionResult:
        started = time.monotonic()
        req = self._with_defaults(path, request)
        precheck = self._precheck(req)
        if precheck is not None:
            precheck.timings_ms = {
                "total": (time.monotonic() - started) * 1000.0}
            return precheck
        suffix = Path(req.path).suffix.lower()
        if self.config.preferred == "native" or self.native.claims(suffix):
            if self.native.claims(suffix):
                return self.native.convert(req)
        result = self.docling.convert(req)
        if (result.document_status
                == DocumentStatus.SUPPORTED_DEPENDENCY_MISSING
                and self.native.claims(suffix)):
            return self.native.convert(req)
        return result

    def convert_batch(self, paths: list[str | Path],
                      request: Optional[DocumentConversionRequest] = None
                      ) -> list[DocumentConversionResult]:
        """Bounded-concurrency batch; order matches input."""
        workers = max(1, self.config.max_workers)

        def _one(p: str | Path) -> DocumentConversionResult:
            with self._batch_sem:
                return self.convert(p, request)

        with ThreadPoolExecutor(max_workers=workers) as pool:
            return list(pool.map(_one, paths))

    # -- internals -----------------------------------------------------
    def _with_defaults(self, path: str | Path,
                       request: Optional[DocumentConversionRequest]
                       ) -> DocumentConversionRequest:
        if request is None:
            return DocumentConversionRequest(
                path=str(path),
                force_ocr=self.config.force_ocr,
                ocr_engine=self.config.ocr_engine,
                ocr_lang=self.config.ocr_lang,
                max_pages=self.config.max_pages,
                max_chars=self.config.max_chars,
                timeout_s=self.config.timeout_s,
                isolation=self.config.isolation,
            )
        if not request.path:
            request.path = str(path)
        return request

    def _precheck(self, req: DocumentConversionRequest
                  ) -> Optional[DocumentConversionResult]:
        """Size, confinement, and archive gates before any engine runs."""
        result = DocumentConversionResult(path=req.path, engine="none")
        suffix = Path(req.path).suffix.lower()
        if NativeTextEngine.is_archive(suffix) or \
                DoclingEngine.is_archive(suffix):
            result.status = "skipped"
            result.document_status = DocumentStatus.UNSUPPORTED
            result.note = f"archive extraction is not supported: {suffix}"
            result.mime_type = (mimetypes.guess_type(req.path)[0] or "")
            return result
        root = self.config.confinement_root or None
        try:
            resolved = resolve_secure(req.path, root=root)
        except PathSecurityError as exc:
            result.status = "error"
            result.document_status = DocumentStatus.CORRUPT
            result.note = f"path rejected: {exc}"
            return result
        try:
            size = resolved.stat().st_size
        except OSError:
            size = -1
        if size >= 0 and size > self.config.max_file_bytes:
            result.status = "error"
            result.document_status = DocumentStatus.CORRUPT
            result.note = (f"file exceeds {self.config.max_file_bytes:,} "
                           f"byte limit ({size:,} bytes)")
            result.mime_type = (mimetypes.guess_type(str(resolved))[0] or "")
            return result
        return None
