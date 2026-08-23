"""Differential verification of the project profiler.

`profile.ts` is 385 lines of derivation from a real folder — languages,
frameworks, entry points, surfaces, coding style. This runs BOTH
implementations against the SAME real directories and diffs everything
they derive.

`generatedAt` is excluded — it is wall-clock. **`fingerprint` is not**:
it is compared for equality to decide whether a cached profile stands, so
a profile written by the TypeScript backend must read as current under
the Python one. It was excluded in Phase 3 and that concealed two real
defects (a lossy `st_mtime * 1000`, and `%g` formatting).

Usage (from backend/):
    uv run python -m parity.profile_parity --repo /mnt/storage/aura-hub
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from aura_backend.workspace.profile import build_profile


def _oracle(repo: Path, project_root: Path, project_id: str) -> dict:
    oracle = Path(__file__).parent / "profile_oracle.ts"
    proc = subprocess.run(
        ["node", str(repo / "scripts" / "run-ts.mjs"), str(oracle), str(repo),
         str(project_root), project_id],
        cwd=repo, capture_output=True, text=True, timeout=600, check=False,
    )
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        raise SystemExit("the profile oracle failed; cannot claim parity")
    return json.loads(proc.stdout)


def compare_one(repo: Path, project_root: Path, project_id: str) -> list[str]:
    reference = _oracle(repo, project_root, project_id)
    got = build_profile(project_id, str(project_root))
    mine = got.to_json()
    mine.pop("generatedAt", None)

    differences = []
    for key in sorted(set(reference) | set(mine)):
        if reference.get(key) != mine.get(key):
            differences.append(
                f"{project_id}/{key}\n"
                f"    TypeScript: {json.dumps(reference.get(key), sort_keys=True)[:400]}\n"
                f"    Python:     {json.dumps(mine.get(key), sort_keys=True)[:400]}"
            )
    return differences


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    args = ap.parse_args()
    repo = Path(args.repo)

    # Real, varied directories: a large TypeScript monorepo, a Python
    # package, and a couple of subtrees with different shapes.
    targets = [
        (repo, "aura-hub"),
        (Path(__file__).resolve().parents[1], "aura-backend-python"),
        (repo / "packages" / "capability-fabric", "capability-fabric"),
        (repo / "apps" / "desktop", "desktop"),
        (repo / "website", "website"),
    ]

    total = 0
    all_differences: list[str] = []
    for root, project_id in targets:
        if not root.is_dir():
            print(f"{project_id:24s} SKIPPED (not present)")
            continue
        total += 1
        differences = compare_one(repo, root, project_id)
        all_differences += differences
        print(
            f"{project_id:24s} {'MATCH' if not differences else f'{len(differences)} differing fields'}"
        )

    for d in all_differences:
        print(f"\nDIFF {d}")
    if not all_differences:
        print(f"\nAll {total} profiles match the reference field for field.")
    return 1 if all_differences else 0


if __name__ == "__main__":
    raise SystemExit(main())
