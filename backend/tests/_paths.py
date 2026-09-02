"""Shared frozen-contract locations (unique module name to avoid conftest shadowing)."""

from __future__ import annotations

from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
MIGRATION_DOCS = REPO / "docs" / "migration"
VECTORS_FILE = MIGRATION_DOCS / "canonicalization-vectors.json"
GOLDEN_DIR = MIGRATION_DOCS / "golden"
SCHEMA_DIR = MIGRATION_DOCS / "schemas"
