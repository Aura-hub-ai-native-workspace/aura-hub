"""Differential harness fixtures — build REAL TypeScript reference bundles.

Uses the repo's own esbuild (node_modules/.bin/esbuild) to bundle the genuine
implementations:
  - packages/capability-fabric/src/fabric.ts      → fingerprintInvocation
  - packages/ai-service/src/workflow/versions.ts  → hashGraph

Bundles land in /tmp/opencode/tsref (pre-approved scratch). If esbuild or the
sources are missing, the differential tests SKIP with an explicit reason —
they never silently pass.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
TSREF = Path("/tmp/opencode/tsref")
ESBUILD = REPO / "node_modules" / ".bin" / "esbuild"
DRIVER = Path(__file__).parent / "ts_driver.mjs"


def _build_bundle(entry: Path, out: Path, extra: list[str]) -> None:
    TSREF.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(ESBUILD), str(entry),
        "--bundle", "--format=esm", "--platform=node",
        *extra,
        f"--outfile={out}",
    ]
    subprocess.run(cmd, cwd=REPO, check=True, capture_output=True, text=True)


@pytest.fixture(scope="session")
def tsref() -> dict[str, Path]:
    if not ESBUILD.exists():
        pytest.skip("repo esbuild not installed (node_modules/.bin/esbuild missing)")
    fabric_out = TSREF / "fabric.mjs"
    index_out = TSREF / "fabric-index.mjs"
    versions_out = TSREF / "versions.mjs"
    try:
        _build_bundle(
            REPO / "packages/capability-fabric/src/fabric.ts",
            fabric_out,
            ["--alias:@aura/connected-environment=./packages/connected-environment/src/index.ts"],
        )
        _build_bundle(
            REPO / "packages/capability-fabric/src/index.ts",
            index_out,
            ["--alias:@aura/connected-environment=./packages/connected-environment/src/index.ts"],
        )
        _build_bundle(
            REPO / "packages/ai-service/src/workflow/versions.ts",
            versions_out,
            ["--external:typescript"],
        )
        _build_bundle(
            REPO / "packages/ai-service/src/workflow/store.ts",
            TSREF / "wfstore.mjs", [],
        )
        _build_bundle(
            REPO / "packages/ai-service/src/workflow/run/store.ts",
            TSREF / "runstore.mjs", [],
        )
        _build_bundle(
            REPO / "packages/automation/src/store.ts",
            TSREF / "autostore.mjs", [],
        )
        _build_bundle(
            REPO / "packages/ai-service/src/workflow/run/types.ts",
            TSREF / "runtypes.mjs", [],
        )
    except subprocess.CalledProcessError as e:
        pytest.skip(f"failed to build TS reference bundles: {e.stderr[-400:]}")
    return {
        "fabric": fabric_out, "index": index_out, "versions": versions_out,
        "wfstore": TSREF / "wfstore.mjs", "runstore": TSREF / "runstore.mjs",
        "autostore": TSREF / "autostore.mjs", "runtypes": TSREF / "runtypes.mjs",
    }


def run_ts_batch(tsref_paths: dict[str, Path], func: str, cases: list[dict]) -> list[str]:
    """One node process per batch; cases in, digests out, order preserved."""
    env_driver = {
        "TSREF_FABRIC": str(tsref_paths["fabric"]),
        "TSREF_VERSIONS": str(tsref_paths["versions"]),
        "PATH": "/usr/bin:/bin:/usr/local/bin",
    }
    import json
    proc = subprocess.run(
        ["node", str(DRIVER)],
        input=json.dumps({"func": func, "cases": cases}),
        capture_output=True, text=True, env=env_driver, check=True,
    )
    return json.loads(proc.stdout)["digests"]
