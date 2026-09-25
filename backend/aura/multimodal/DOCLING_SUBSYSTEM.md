# Docling Document-Intelligence Subsystem

Owner: subsystem implementer · Integrator: Claude Code.
Branch: `feat/docling-document-engine` (isolated worktree only).

## What this is

A stable adapter boundary between AURA Hub and Docling. AURA code calls
`DocumentEngine`; Docling-specific imports exist only inside
`backend/aura/multimodal/docling_engine.py` (+ `provision.py`).

## Module map

| Module | Role | Docling import? |
|---|---|---|
| `doctypes.py` | Public contracts (stdlib only) | never |
| `document_engine.py` | `DocumentEngine` dispatcher, budgets, batch | never |
| `native.py` | `NativeTextEngine` (txt/md/rst/csv/json/yaml) | never |
| `docling_engine.py` | `DoclingEngine`, OCR probing, structure walk | lazy only |
| `secure.py` | confinement, temp hygiene, file identity | never |
| `process_supervisor.py` | hard-timeout process isolation | never |
| `provision.py` | model-cache warmup + MANIFEST | lazy only |
| `ingestor.py` (existing) | legacy extractor, unchanged | never |

## Key behaviors

- `DocumentEngine.convert(path)` never raises for bad input; failures are
  typed (`DocumentStatus`: success/partial/unsupported/corrupt/ocr_required/
  ocr_failed/supported/supported_dependency_missing).
- Archives (zip/tar/…) are rejected before any engine runs.
- OCR engines are probed, never assumed; a missing/unready engine yields
  `OCR_REQUIRED`/`SUPPORTED_DEPENDENCY_MISSING`, never a silent swap.
- Only local pipelines are constructed. No remote VLM, no managed service.
- `IsolationMode.PROCESS` gives a wall-clock budget enforced by process
  termination (the only honest timeout against hung native code).
- Memory limits are NOT claimed: no cgroup/process-RLIMIT enforcement is
  implemented (see Known limitations).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AURA_DOCS_ENGINE` | `auto` | `auto` / `native` / `docling` preference |
| `AURA_DOCS_OCR` | `auto` | `auto` / `rapidocr` / `tesseract` / `easyocr` / `none` |
| `AURA_DOCS_OCR_LANG` | `en` | BCP-47 OCR language tag |
| `AURA_DOCS_FORCE_OCR` | unset | `1` forces full-page OCR |
| `AURA_DOCS_MODEL_CACHE` | `$AURA_HOME/models/docling` | dedicated model cache |
| `AURA_DOCS_OFFLINE` | `0` | `1` forbids runtime model downloads |
| `AURA_DOCS_MAX_BYTES` | `52428800` | pre-conversion size gate (50 MB) |
| `AURA_DOCS_MAX_PAGES` | `0` | page budget (0 = unlimited) |
| `AURA_DOCS_MAX_CHARS` | `500000` | output text cap (KB parity) |
| `AURA_DOCS_TIMEOUT_S` | `300` | per-document budget |
| `AURA_DOCS_ISOLATION` | `in_process` | `in_process` / `process` |
| `AURA_DOCS_MAX_WORKERS` | auto (≤2) | batch concurrency cap |
| `AURA_DOCS_ROOT` | unset | optional confinement root |
| `HF_HUB_OFFLINE` | unset | set `1` (with seeded cache) for air-gap |

## Install / provision / verify

```bash
python3 -m venv /path/to/venv
/path/to/venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
/path/to/venv/bin/pip install "aura-backend[docling]"
python scripts/provision-docling-models.py
/path/to/venv/bin/python -m pytest backend/tests/unit/test_document_engine.py -q
/path/to/venv/bin/python -m pytest backend/tests/integration/test_docling_engine.py -q
```

## Benchmarks (this machine: 8 CPU, 6 GB RAM, CPU-only torch)

Cold process, 1-page text PDF: ~16–18 s (model load) → SUCCESS.
Warm process, same PDF: ~2.2–2.3 s → SUCCESS.
1x1 blank PNG: ~4.7 s → PARTIAL/EMPTY (correct: no text).
Native md/csv (~2 KB): <0.01 s → SUCCESS.
Full integration suite (30 tests, real conversions): ~3 min wall.
Footprint: isolated venv 1.9 GB (torch CPU + docling + RapidOCR
ONNX + fixture libs); model cache 506 MB (layout-heron + pipeline
bundle + HF metadata). Record your own numbers before tuning.

## Known limitations

1. No enforced memory cap (documented, not claimed).
2. `.msg` support depends on the installed Docling backend; probed, not assumed.
3. Audio/video, AsciiDoc, LaTeX extras intentionally unclaimed.
4. Legacy Office (doc/xls/ppt/rtf) needs a LibreOffice system binary.
5. WMF images in Office files render on Windows only (upstream limitation).
6. Automatic title/author extraction is partial upstream; adapter fills from
   document metadata only, never fabricates.
7. Chunking is heading-aware local chunking (1500/150 KB parity), not a HF
   tokenizer-aligned chunker (which would need a tokenizer download).
8. First conversion warms the model cache (slow); provision ahead of use.
