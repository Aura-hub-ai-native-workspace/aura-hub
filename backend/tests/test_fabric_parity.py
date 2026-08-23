"""Differential verification against the TypeScript Capability Fabric.

Skipped rather than failed when the TypeScript tree or node/esbuild are
unreachable. A skip says parity was not checked, which is never the same
as parity holding.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

import pytest

from parity.fabric_parity import compare, run_python, run_typescript
from parity.fabric_scenarios import build_scenarios

REPO = Path(os.environ.get("AURA_TS_REPO", "/mnt/storage/aura-hub"))

pytestmark = pytest.mark.skipif(
    not (REPO / "packages/capability-fabric/src/fabric.ts").exists()
    or shutil.which("node") is None
    or shutil.which("npx") is None,
    reason=f"TypeScript reference not reachable at {REPO}; parity NOT verified",
)


def test_python_fabric_matches_the_typescript_reference():
    scenarios = build_scenarios()
    assert len(scenarios) > 40, "the scenario set collapsed; parity would be vacuous"

    with tempfile.TemporaryDirectory(prefix="fabric-parity-test-") as tmp:
        ts = run_typescript(scenarios, REPO, Path(tmp))
    py = asyncio.run(run_python(scenarios))

    differences = compare(ts, py)
    assert not differences, "\n".join(differences)
