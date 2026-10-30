"""TS reference-bundle helpers (fixtures live in ./conftest.py)."""

from __future__ import annotations

import json
import os
import subprocess

#: A fixed PATH keeps the Node oracle reproducible on POSIX. Windows has no /usr/bin and needs its own
#: system directory variables for node to start, so there the real PATH is used.
_NODE_PATH = os.environ.get("PATH", "") if os.name == "nt" else "/usr/bin:/bin:/usr/local/bin"
_WIN_ENV = {k: os.environ[k] for k in ("SYSTEMROOT", "TEMP", "TMP") if k in os.environ} if os.name == "nt" else {}
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
            "TSREF_FABRICWIRING": str(tsref_paths["fabricwiring"]),
            "TSREF_WFENGINE": str(tsref_paths["wfengine"]),
            "TSREF_AUTOENGINE": str(tsref_paths["autoengine"]),
            "PATH": _NODE_PATH, **_WIN_ENV,
        },
        check=False,
    )
    if proc.returncode != 0:
        raise AssertionError(f"driver failed rc={proc.returncode}: {proc.stderr[-500:]}")
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
            "PATH": _NODE_PATH, **_WIN_ENV,
        },
        check=True,
    )
    return json.loads(proc.stdout)["results"]


def run_fabric_ops(tsref_paths: dict[str, Path], config: dict, ops: list[dict], home: str, start_ms: int) -> dict:
    """Drive the REAL CapabilityFabric through a scripted scenario."""
    driver = Path(__file__).parent / "ts_driver.mjs"
    proc = subprocess.run(
        ["node", str(driver)],
        input=json.dumps({"func": "fabricops", "config": config, "ops": ops,
                          "home": home, "startMs": start_ms}),
        capture_output=True,
        text=True,
        env={
            "TSREF_FABRIC": str(tsref_paths["fabric"]),
            "TSREF_FABRIC_INDEX": str(tsref_paths["index"]),
            "TSREF_VERSIONS": str(tsref_paths["versions"]),
            "TSREF_RUNTYPES": str(tsref_paths["runtypes"]),
            "TSREF_FABRICWIRING": str(tsref_paths["fabricwiring"]),
            "TSREF_WFENGINE": str(tsref_paths["wfengine"]),
            "TSREF_AUTOENGINE": str(tsref_paths["autoengine"]),
            "TSREF_WFSTORE": str(tsref_paths["wfstore"]),
            "TSREF_RUNSTORE": str(tsref_paths["runstore"]),
            "TSREF_AUTOSTORE": str(tsref_paths["autostore"]),
            "PATH": _NODE_PATH, **_WIN_ENV,
        },
        check=False,
    )
    if proc.returncode != 0:
        raise AssertionError(f"driver failed rc={proc.returncode}: {proc.stderr[-500:]}")
    return json.loads(proc.stdout)


def run_wf_ops(tsref_paths: dict[str, Path], workflow: dict, proj_path: str,
               home: str, start_ms: int, *, run_record=None, inputs=None,
               governor=None, replay=None) -> dict:
    driver = Path(__file__).parent / "ts_driver.mjs"
    proc = subprocess.run(
        ["node", str(driver)],
        input=json.dumps({"func": "wfops", "workflow": workflow, "projPath": proj_path,
                          "home": home, "startMs": start_ms, "run": run_record,
                          "inputs": inputs or {}, "governor": governor,
                          "replay": replay}),
        capture_output=True, text=True,
        env={"TSREF_WFENGINE": str(tsref_paths["wfengine"]),
            "TSREF_AUTOENGINE": str(tsref_paths["autoengine"]), "TSREF_RUNSTORE": str(tsref_paths["runstore"]),
             "PATH": _NODE_PATH, **_WIN_ENV},
        check=False)
    if proc.returncode != 0:
        raise AssertionError(f"driver failed rc={proc.returncode}: {proc.stderr[-500:]}")
    return json.loads(proc.stdout)
