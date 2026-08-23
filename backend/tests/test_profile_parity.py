"""Differential verification of the project profiler.

Runs both implementations against the same real directories on this
machine and diffs every derived field.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from parity.profile_parity import compare_one

REPO = Path(os.environ.get("AURA_TS_REPO", "/mnt/storage/aura-hub"))

pytestmark = pytest.mark.skipif(
    not (REPO / "packages/ai-service/src/profile.ts").exists() or shutil.which("node") is None,
    reason=f"TypeScript reference not reachable at {REPO}; parity NOT verified",
)


@pytest.mark.slow
@pytest.mark.parametrize(
    "relative,project_id",
    [
        (".", "aura-hub"),
        ("packages/capability-fabric", "capability-fabric"),
        ("apps/desktop", "desktop"),
    ],
)
def test_the_profiler_matches_the_reference(relative, project_id):
    root = (REPO / relative).resolve()
    if not root.is_dir():
        pytest.skip(f"{root} is not present")
    differences = compare_one(REPO, root, project_id)
    assert not differences, "\n".join(differences)
