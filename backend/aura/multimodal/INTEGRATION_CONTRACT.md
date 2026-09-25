# INTEGRATION CONTRACT — Docling subsystem → AURA Hub

Audience: Claude Code (integrator). Do not import Docling outside
`backend/aura/multimodal/docling_engine.py` and `provision.py`.

## 1. Public imports and interfaces

```python
from aura.multimodal.document_engine import DocumentEngine, EngineConfig
from aura.multimodal.doctypes import (
    DocumentConversionRequest, DocumentConversionResult, DocumentStatus,
    DocumentCapabilities, DocumentEngineHealth, OcrEngine, IsolationMode,
)
from aura.multimodal.docling_engine import DoclingEngine, model_cache_dir
```

Entry points: `DocumentEngine(EngineConfig.from_env())`,
`engine.convert(path[, request]) -> DocumentConversionResult`,
`engine.convert_batch(paths[, request])`,
`engine.capabilities() -> DocumentCapabilities`,
`engine.health() -> DocumentEngineHealth`.
Legacy `DocumentIngestor`/`ExtractionResult`/`ExtractionStatus` unchanged.

## 2. Installation and provisioning

```bash
python3 -m venv /opt/aura/venv-docling   # or any isolated venv
/opt/aura/venv-docling/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
/opt/aura/venv-docling/bin/pip install "aura-backend[docling]"
AURA_DOCS_MODEL_CACHE=/var/lib/aura/models/docling \
HF_HOME=/var/lib/aura/models/docling/hf \
  python scripts/provision-docling-models.py
```

Measured footprint (this machine): venv **1.9 GB**, model cache **506 MB**.

## 3. Configuration (environment variables)

`AURA_DOCS_ENGINE` (auto|native|docling, default auto) ·
`AURA_DOCS_OCR` (auto|rapidocr|tesseract|easyocr|none, default auto) ·
`AURA_DOCS_OCR_LANG` (BCP-47, default en) ·
`AURA_DOCS_FORCE_OCR` (1 = full-page OCR attempt) ·
`AURA_DOCS_MODEL_CACHE` (default `$AURA_HOME/models/docling`) ·
`AURA_DOCS_OFFLINE` (1 = no runtime downloads) · `HF_HUB_OFFLINE=1` for
air-gap · `AURA_DOCS_MAX_BYTES` (default 52428800) ·
`AURA_DOCS_MAX_PAGES` (0 = unlimited) · `AURA_DOCS_MAX_CHARS` (500000) ·
`AURA_DOCS_TIMEOUT_S` (300) · `AURA_DOCS_ISOLATION`
(in_process|process) · `AURA_DOCS_MAX_WORKERS` (default ≤2) ·
`AURA_DOCS_ROOT` (optional confinement root).

## 4. Health-check usage

```python
health = engine.health().to_dict()
# available, doclingInstalled, doclingVersion, modelsCached, ocrReady,
# ocrEngines, offlineReady, missing[], detail
```

Gate serving on `modelsCached and ocrReady` for scan workloads;
text formats work with `available` alone. Surface `missing[]` verbatim
in the SovereignMonitorPanel — it is the honest gap list.

## 5. Conversion examples

```python
result = engine.convert("/srv/aura/documents/report.pdf")
if result.document_status == DocumentStatus.SUCCESS:
    kb.add_document(result.path, result.to_extraction_result())
    chunks = [c.to_dict() for c in result.chunks]  # retrieval-ready
```

OCR control: `DocumentConversionRequest(path, ocr_engine=OcrEngine.RAPIDOCR,
ocr_lang="de", force_ocr=True)`. Hard budgets:
`DocumentConversionRequest(path, timeout_s=120,
isolation=IsolationMode.PROCESS, max_pages=50)`.

## 6. Error and status mapping

`DocumentStatus`: success → index; partial → index + surface note;
ocr_required → prompt to provision OCR (never fake text);
ocr_failed → error with engine message; supported_dependency_missing →
install/provision hint; unsupported (incl. archives) → 400-class reject;
corrupt (incl. encrypted) → 400/422 with note, nothing indexed.
`result.to_extraction_result()` down-converts to the KB vocabulary
(ok/partial/empty/skipped/error). `result.errors[]` carries
`{message, category, module, page_no}` for logs (never raw content).

## 7. Structured output schema

`result.text` (plain), `result.tables[]` `{rows, pageNo, caption,
markdown, numRows, numCols}`, `result.headings[]`,
`result.images[]` `{pageNo, caption, label}`,
`result.chunks[]` `{text, index, pageNo, headingPath[], kind,
startChar, endChar}`, `result.metadata{}` (source-claimed only),
`result.ocr_used`, `result.timings_ms{}`. `to_dict()` excludes text.

## 8. Chunking and KB integration

Chunks are 1500/150 chars with heading provenance — a drop-in for
`KnowledgeBase.add_document` via `to_extraction_result()`. Table cells
live in `StructuredTable.rows`, not flattened. Future vector work can
swap the local chunker for a tokenizer-aligned one without schema
changes. Suggested KB record extension: `{engine, ocrUsed,
doclingStatus}` alongside `extraction_status`.

## 9. Required API changes (yours, not mine)

- `POST /documents/ingest`: add `engine/status/ocrUsed/chunkCount` to
  the 200 payload; new `GET /documents/engines` ← `engine.capabilities()`;
  surface `DocumentStatus` strings to the desktop shell.
- Keep the 50 MB cap (adapter default matches); keep temp-file hygiene.
- Route `document.ingest` executor through `DocumentEngine` when the
  extra is installed, else legacy `DocumentIngestor` (unchanged fallback).

## 10. Required desktop UI changes (yours, not mine)

- DocumentsPanel: engine + status + OCR badges per document;
  dependency-missing hint with the exact provisioning command.
- SovereignMonitorPanel: model-cache state from `health()`
  (cached version, offline readiness).

## 11. Security assumptions (composite holds only if all hold)

Caller confines uploads (temp dir + basename as today); adapter enforces
size/page/timeout/concurrency budgets, symlink-escape refusal, archive
rejection, temp cleanup in `finally`. PROCESS isolation is the only
enforced timeout; IN_PROCESS measures only. No memory cap exists.
No network use at conversion time (asserted by zero-egress tests when
the cache is seeded).

## 12. Known limitations

No enforced memory limit · `.msg` backend-dependent (probed) ·
audio/video/AsciiDoc/LaTeX extras unclaimed · legacy Office needs a
LibreOffice binary · WMF images Windows-only (upstream) · title/author
extraction partial upstream, never fabricated · local heading-aware
chunking, not tokenizer-aligned · first conversion pays model load
(~16 s cold, ~2.3 s warm for a 1-page PDF on this 8-CPU box).

## 13. Exact test commands

```bash
# base env (no docling needed):
cd backend && python3 -m pytest tests/unit/test_document_engine.py -q
# isolated env (after install + provision):
export AURA_DOCS_MODEL_CACHE=/var/lib/aura/models/docling
export HF_HOME=$AURA_DOCS_MODEL_CACHE/hf
/path/to/venv/bin/python -m pytest tests/unit/test_document_engine.py -q
/path/to/venv/bin/python -m pytest tests/integration/test_docling_engine.py -q
python3 -m ruff check backend/aura/multimodal/ scripts/provision-docling-models.py \
  backend/tests/unit/test_document_engine.py \
  backend/tests/integration/test_docling_engine.py
```
