"""Differential verification of the catalogue and the environment scanner.

Three comparisons, each answering a different question:

  * **catalog** — is the checked-in catalogue data still identical to the
    TypeScript catalogue? It is generated rather than transcribed, and
    this is what proves it has not drifted.
  * **connectable** — do the pure catalogue functions (`is_connectable`,
    `entries_providing`, `catalog_entry`) agree for every one of the 105
    entries?
  * **scan** — run BOTH scanners against **this machine** and diff what
    they report about the same real tools. Presence, version and the
    detail sentence must match; `latencyMs` is wall-clock and cannot.

    **This comparison races a timeout, and says so.** A probe is given
    4 seconds, and several catalogued CLIs are Node programs that take
    1-2.5s warm and longer on a cold page cache. A first run can
    therefore report a genuinely installed tool absent — in EITHER
    implementation; it was observed in the reference first. Both sides
    are warmed before the compared run, and any difference that survives
    the warm-up is reported as real rather than explained away.

Usage (from backend/):
    uv run python -m parity.env_parity --repo /mnt/storage/aura-hub
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
from pathlib import Path

from aura_backend.environment import (
    AGENTS,
    CAPABILITIES,
    CATALOG,
    CATEGORY_LABELS,
    EnvironmentScanner,
    catalog_entry,
    entries_providing,
    is_connectable,
)
from aura_backend.environment.catalog import _DATA_FILE


def _oracle(repo: Path, mode: str) -> object:
    oracle = Path(__file__).parent / "env_oracle.ts"
    proc = subprocess.run(
        ["node", str(repo / "scripts" / "run-ts.mjs"), str(oracle), str(repo), mode],
        cwd=repo, capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        raise SystemExit(f"the environment oracle failed in mode {mode}; cannot claim parity")
    return json.loads(proc.stdout)


def compare_catalog(repo: Path) -> list[str]:
    reference = _oracle(repo, "catalog")
    with _DATA_FILE.open(encoding="utf-8") as f:
        stored = json.load(f)
    if reference == stored:
        return []
    differences = []
    for key in ("CATALOG", "CATEGORY_LABELS", "CAPABILITIES", "AGENTS"):
        if reference.get(key) != stored.get(key):
            if key == "CATALOG":
                ref_by_id = {e["id"]: e for e in reference[key]}
                got_by_id = {e["id"]: e for e in stored[key]}
                for missing in sorted(set(ref_by_id) - set(got_by_id)):
                    differences.append(f"catalog/{missing}: in TypeScript, absent in Python")
                for extra in sorted(set(got_by_id) - set(ref_by_id)):
                    differences.append(f"catalog/{extra}: in Python, absent in TypeScript")
                for node_id in sorted(set(ref_by_id) & set(got_by_id)):
                    if ref_by_id[node_id] != got_by_id[node_id]:
                        differences.append(
                            f"catalog/{node_id}\n"
                            f"    TypeScript: {json.dumps(ref_by_id[node_id], sort_keys=True)}\n"
                            f"    Python:     {json.dumps(got_by_id[node_id], sort_keys=True)}"
                        )
                if [e["id"] for e in reference[key]] != [e["id"] for e in stored[key]]:
                    differences.append(
                        "catalog/ORDER: entry order differs — order is the routing tie-break"
                    )
            else:
                differences.append(f"{key}: differs")
    return differences


def compare_pure(repo: Path) -> list[str]:
    reference = _oracle(repo, "connectable")
    differences = []
    for row in reference:
        entry = catalog_entry(row["id"])
        if entry is None:
            differences.append(f"pure/{row['id']}: catalog_entry returned None")
            continue
        if is_connectable(entry) != row["connectable"]:
            differences.append(
                f"pure/{row['id']}/is_connectable: "
                f"TypeScript {row['connectable']} vs Python {is_connectable(entry)}"
            )
        for capability, expected in zip(entry.capabilities, row["providing"]):
            got = [e.id for e in entries_providing(capability)]
            if got != expected:
                differences.append(
                    f"pure/{row['id']}/entries_providing({capability})\n"
                    f"    TypeScript: {expected}\n    Python:     {got}"
                )
        if row["lookedUp"] != entry.id:
            differences.append(f"pure/{row['id']}/catalog_entry: {row['lookedUp']} vs {entry.id}")
    return differences


def compare_scan(repo: Path) -> tuple[list[str], int]:
    """Both scanners, same machine, same moment.

    Warmed first: see the module docstring on the 4-second probe budget.
    """
    _oracle(repo, "scan")
    asyncio.run(EnvironmentScanner().scan(None, True))

    reference = _oracle(repo, "scan")
    result = asyncio.run(EnvironmentScanner().scan(None, True))

    ref_results = reference["results"]
    got_results = {
        node_id: {
            "present": r.present,
            "version": r.version,
            "detail": r.detail,
        }
        for node_id, r in result.results.items()
    }

    differences = []
    for missing in sorted(set(ref_results) - set(got_results)):
        differences.append(f"scan/{missing}: scanned by TypeScript, not by Python")
    for extra in sorted(set(got_results) - set(ref_results)):
        differences.append(f"scan/{extra}: scanned by Python, not by TypeScript")
    for node_id in sorted(set(ref_results) & set(got_results)):
        if ref_results[node_id] != got_results[node_id]:
            differences.append(
                f"scan/{node_id}\n"
                f"    TypeScript: {json.dumps(ref_results[node_id], sort_keys=True)}\n"
                f"    Python:     {json.dumps(got_results[node_id], sort_keys=True)}"
            )
    if reference["found"] != result.found:
        differences.append(f"scan/found: {reference['found']} vs {result.found}")
    return differences, len(ref_results)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    args = ap.parse_args()
    repo = Path(args.repo)

    all_differences: list[str] = []

    catalog_diffs = compare_catalog(repo)
    all_differences += catalog_diffs
    print(
        f"catalog:     {len(CATALOG)} entries, {len(CAPABILITIES)} capabilities, "
        f"{len(AGENTS)} agents, {len(CATEGORY_LABELS)} categories — "
        f"{'IDENTICAL' if not catalog_diffs else f'{len(catalog_diffs)} differences'}"
    )

    pure_diffs = compare_pure(repo)
    all_differences += pure_diffs
    print(
        f"pure funcs:  {len(CATALOG)} entries checked — "
        f"{'MATCH' if not pure_diffs else f'{len(pure_diffs)} differences'}"
    )

    scan_diffs, scanned = compare_scan(repo)
    all_differences += scan_diffs
    print(
        f"live scan:   {scanned} nodes probed on this machine — "
        f"{'MATCH' if not scan_diffs else f'{len(scan_diffs)} differences'}"
    )

    for d in all_differences:
        print(f"\nDIFF {d}")
    if not all_differences:
        print("\nAll environment comparisons match the reference.")
    return 1 if all_differences else 0


if __name__ == "__main__":
    raise SystemExit(main())
