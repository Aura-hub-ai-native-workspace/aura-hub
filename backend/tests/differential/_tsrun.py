"""TS reference-bundle helpers (fixtures live in ./conftest.py)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


def run_store_ops(tsref_paths: dict[str, Path], ops: list[dict], home: str, start_ms: int) -> dict:
    """Run an identical persistence op-script through the REAL TS stores."""
    driver = Path(__file__).parent / "ts_driver.mjs"
    proc = subprocess.run(
        ["node", str(driver)],
        input=json.dumps({"func": "storeops", "ops": ops, "home": home, "startMs": start_ms}),
        capture_output=True,
        text=True,
        env={
            "TSREF_FABRIC": str(tsref_paths["fabric"]),
            "TSREF_FABRIC_INDEX": str(tsref_paths["index"]),
            "TSREF_VERSIONS": str(tsref_paths["versions"]),
            "TSREF_WFSTORE": str(tsref_paths["wfstore"]),
            "TSREF_RUNSTORE": str(tsref_paths["runstore"]),
            "TSREF_AUTOSTORE": str(tsref_paths["autostore"]),
            "TSREF_RUNTYPES": str(tsref_paths["runtypes"]),
            "PATH": "/usr/bin:/bin:/usr/local/bin",
        },
        check=True,
    )
    return json.loads(proc.stdout)


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
            "TSREF_FABRIC_INDEX": str(tsref_paths["index"]),
            "TSREF_VERSIONS": str(tsref_paths["versions"]),
            "PATH": "/usr/bin:/bin:/usr/local/bin",
        },
        check=True,
    )
    return json.loads(proc.stdout)["results"]
