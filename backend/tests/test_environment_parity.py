"""Differential verification of the catalogue and the environment scanner.

Skipped rather than failed when the TypeScript tree is unreachable. A skip
says parity was not checked, which is never the same as parity holding.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from parity.env_parity import compare_catalog, compare_pure, compare_scan

REPO = Path(os.environ.get("AURA_TS_REPO", "/mnt/storage/aura-hub"))

pytestmark = pytest.mark.skipif(
    not (REPO / "packages/connected-environment/src/catalog.ts").exists()
    or shutil.which("node") is None,
    reason=f"TypeScript reference not reachable at {REPO}; parity NOT verified",
)


def test_the_checked_in_catalogue_is_identical_to_the_reference():
    """It is generated rather than transcribed; this proves it has not drifted."""
    differences = compare_catalog(REPO)
    assert not differences, "\n".join(differences)


def test_the_pure_catalogue_functions_agree_for_every_entry():
    differences = compare_pure(REPO)
    assert not differences, "\n".join(differences)


@pytest.mark.slow
def test_both_scanners_report_the_same_thing_about_this_machine():
    """Races a 4-second probe budget against slow Node CLIs — both sides are
    warmed first. See parity/env_parity.py for why."""
    differences, scanned = compare_scan(REPO)
    assert scanned > 40, "the scan collapsed; the comparison would be vacuous"
    assert not differences, "\n".join(differences)
