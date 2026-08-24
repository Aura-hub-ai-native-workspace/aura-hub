"""TS reference-bundle helpers (fixtures live in ./conftest.py)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


def run_ts_batch(tsref_paths: dict[str, Path], func: str, cases: list[dict]) -> list[str]:
    """One node process per batch; cases in, digests out, order preserved."""
    driver = Path(__file__).parent / "ts_driver.mjs"
    proc = subprocess.run(
        ["node", str(driver)],
        input=json.dumps({"func": func, "cases": cases}),
        capture_output=True,
        text=True,
        env={
            "TSREF_FABRIC": str(tsref_paths["fabric"]),
            "TSREF_VERSIONS": str(tsref_paths["versions"]),
            "PATH": "/usr/bin:/bin:/usr/local/bin",
        },
        check=True,
    )
    return json.loads(proc.stdout)["digests"]
