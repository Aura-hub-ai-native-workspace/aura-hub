"""Differential verification of the retrieval engine.

Skipped rather than failed when the TypeScript tree is unreachable — a
skip says parity was not checked, which is never the same as parity
holding.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from parity.retrieval_parity import run_all

REPO = Path(os.environ.get("AURA_TS_REPO", "/mnt/storage/aura-hub"))

pytestmark = pytest.mark.skipif(
    not (REPO / "packages/knowledge-coding/src/store/invertedIndex.ts").exists()
    or shutil.which("node") is None,
    reason=f"TypeScript reference not reachable at {REPO}; parity NOT verified",
)


@pytest.mark.slow
def test_the_retrieval_engine_matches_the_reference():
    differences, ts = run_all(REPO)
    assert len(ts["search"]) > 10, "the query set collapsed; parity would be vacuous"
    assert sum(len(s["hits"]) for s in ts["search"]) > 20, "no hits compared"
    assert not differences, "\n".join(differences)
