"""Differential verification against the TypeScript spawn primitive.

The negative controls prove the Python layer matches our *reading* of the
reference. This proves it matches the reference itself, by running
identical scenarios — including identical child programs — through both.

Skipped rather than failed when the TypeScript tree or node/esbuild are
not reachable. A skip says parity was not checked, which is never the same
as parity holding.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from parity.exec_parity import (
    build_scenarios,
    compare,
    run_python,
    run_typescript,
    write_fixtures,
)

REPO = Path(os.environ.get("AURA_TS_REPO", "/mnt/storage/aura-hub"))

pytestmark = pytest.mark.skipif(
    not (REPO / "packages/ai-service/src/exec/process.ts").exists()
    or shutil.which("node") is None
    or shutil.which("npx") is None,
    reason=f"TypeScript reference not reachable at {REPO}; parity NOT verified",
)


def test_python_execution_layer_matches_the_typescript_reference():
    with tempfile.TemporaryDirectory(prefix="exec-parity-test-") as tmp:
        workdir = Path(tmp)
        fixtures = workdir / "cwd"
        fixtures.mkdir()
        write_fixtures(fixtures)
        subprocess.run(["git", "init", "-q"], cwd=fixtures, check=True)

        scenarios = build_scenarios(str(fixtures))
        assert len(scenarios) > 200, "the scenario matrix collapsed; parity would be vacuous"

        ts = run_typescript(scenarios, REPO, workdir)
        py = run_python(scenarios)
        differences = compare(ts, py)
        assert not differences, "\n".join(differences)
