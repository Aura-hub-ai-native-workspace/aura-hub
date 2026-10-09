"""Pytest bootstrap: make `aura` importable when running from anywhere.

Deferred future-feature suites
-------------------------------
Some tests describe a capability that is deliberately NOT in the current
release. They are not skipped, disabled or deleted: they are simply not
collected by default, because a suite the release is not responsible for
must not be able to fail the release. Their files are untouched and stay
where they are, so implementing the capability later is a matter of
deleting one name from ``DEFERRED_SUITES`` below.

To run them — which is how you check the work before the capability exists
and how you check it once it does — set::

    AURA_RUN_DEFERRED_TESTS=1 python -m pytest backend/tests

Today that is exactly one suite, and it is expected to FAIL while the
capability is absent: it asserts ``web.research`` is registered, and
v0.1.20 excludes it (see
``tests/unit/test_web_research_excluded.py`` for the behaviour the release
does guarantee — that a mission needing it fails closed).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
for p in (str(BACKEND),):
    if p not in sys.path:
        sys.path.insert(0, p)

#: Suites for capabilities that are not in this release, relative to this
#: directory. Collected only when AURA_RUN_DEFERRED_TESTS is set.
DEFERRED_SUITES = ("unit/test_web_research.py",)

if os.environ.get("AURA_RUN_DEFERRED_TESTS") != "1":
    collect_ignore = list(DEFERRED_SUITES)

# Frozen-contract locations, shared by vector/golden suites.
MIGRATION_DOCS = REPO / "docs" / "migration"
VECTORS_FILE = MIGRATION_DOCS / "canonicalization-vectors.json"
GOLDEN_DIR = MIGRATION_DOCS / "golden"
SCHEMA_DIR = MIGRATION_DOCS / "schemas"
