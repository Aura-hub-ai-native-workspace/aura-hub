"""Pytest bootstrap: make `aura` importable when running from anywhere."""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
for p in (str(BACKEND),):
    if p not in sys.path:
        sys.path.insert(0, p)

# Frozen-contract locations, shared by vector/golden suites.
MIGRATION_DOCS = REPO / "docs" / "migration"
VECTORS_FILE = MIGRATION_DOCS / "canonicalization-vectors.json"
GOLDEN_DIR = MIGRATION_DOCS / "golden"
SCHEMA_DIR = MIGRATION_DOCS / "schemas"
