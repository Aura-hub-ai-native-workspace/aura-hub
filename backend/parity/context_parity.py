"""Differential verification of the Context Fabric.

Runs the REAL `composeContextView` / `renderContextContract` from
packages/ai-service/src/context/ and the Python port against the SAME
fixture homes, and diffs both the composed `ContextView` and the rendered
contract text at every surface.

The contract renderer is documented as deterministic — "the same view
renders the same text" — which makes it exactly diffable. The view is
compared field by field; the contract is compared line by line.

**What is normalized, and why.** Four values are wall-clock at
composition time and cannot agree between two processes run seconds
apart: `composedAt`, and the `generatedAt` of the git, missions and
activity sections. Those four are replaced with a marker on both sides,
and NOTHING else is: every `generatedAt` that comes from a fixture
artifact is compared exactly, because a port that mis-selects the newest
artifact timestamp would otherwise pass.

Usage (from backend/):
    uv run python -m parity.context_parity [--repo PATH]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from aura_backend.context import (
    ComposeOptions,
    ContextSources,
    EnvironmentSnapshot,
    compose_context_view,
    is_unavailable,
    render_context_contract,
    render_context_header,
    usable_capabilities,
)
from aura_backend.context.types import ContextGit
from aura_backend.intelligence import MissionReader
from aura_backend.workspace.projects import ProjectRegistry

from .context_scenarios import (
    EXPECTED_DIVERGENCE,
    STATUS_DERIVED_BY_ENGINE,
    SURFACES,
    UNKNOWN_SURFACE,
    build,
)

CLOCK = "<composed-at>"
ENGINE_STATUS = "<engine-derived>"
_CONTRACT_STATUS = re.compile(r"(?<= )status=.+?(?= tasks=)")
# Only these are wall-clock at composition. Everything else is a claim
# about a fixture and must match exactly.
LIVE_SECTIONS = ("git", "missions", "activity", "capabilities")


def _normalize(view: dict[str, Any]) -> dict[str, Any]:
    if view.get("status") == "unavailable":
        return view
    view = json.loads(json.dumps(view))
    view["composedAt"] = CLOCK
    for name in LIVE_SECTIONS:
        section = view.get(name) or {}
        if section.get("generatedAt"):
            section["generatedAt"] = CLOCK
    return view


def _normalize_text(text: str, mask_status: bool = False) -> str:
    lines = []
    for line in text.split("\n"):
        if line.startswith("composed_at: "):
            line = f"composed_at: {CLOCK}"
        elif mask_status and line.startswith("- ") and " tasks=" in line:
            line = _CONTRACT_STATUS.sub(f"status={ENGINE_STATUS}", line)
        lines.append(line)
    return "\n".join(lines)


def _oracle(repo: Path, job: dict[str, Any], job_file: Path) -> dict[str, Any]:
    job_file.write_text(json.dumps(job))
    proc = subprocess.run(
        ["node", str(repo / "scripts" / "run-ts.mjs"),
         str(Path(__file__).parent / "context_oracle.ts"), str(repo), str(job_file)],
        cwd=repo, capture_output=True, text=True, timeout=600, check=False,
    )
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        raise SystemExit(f"the context oracle failed on {job['name']}; cannot claim parity")
    return json.loads(proc.stdout)


def _mine(job: dict[str, Any]) -> dict[str, Any]:
    home = Path(job["auraHome"])
    env = job.get("environment")
    sources = ContextSources(
        registry=ProjectRegistry(home),
        missions=MissionReader(home),
        home=home,
        mounted_project_id=job.get("mountedProjectId"),
        fabric=None,
        environment=EnvironmentSnapshot(
            scanned_at=env.get("scannedAt"),
            nodes=env.get("nodes") or [],
            provided_capabilities=env.get("providedCapabilities") or [],
        ) if env else None,
    )
    options = ComposeOptions(
        surface=job.get("surface", "general"),
        include_git=job.get("includeGit", True),
        git=ContextGit.from_json(job["git"]) if job.get("git") else None,
        mission_limit=job.get("missionLimit", 5),
        activity_limit=job.get("activityLimit", 10),
    )
    result = compose_context_view(job["projectId"], sources, options)
    out: dict[str, Any] = {"view": result.to_json()}
    if not is_unavailable(result):
        out["contracts"] = {
            surface: render_context_contract(result, surface)
            for surface in job["surfaces"]
        }
        out["defaultContract"] = render_context_contract(result)
        out["header"] = render_context_header(result)
        out["usable"] = usable_capabilities(result)
    return out


def _mask_mission_status(view: dict[str, Any]) -> list[tuple[str, Any, Any]]:
    """Blank `status` on every mission and hand back what it was."""
    seen = []
    for mission in (view.get("missions") or {}).get("value") or []:
        seen.append((mission["id"], mission["status"]))
        mission["status"] = ENGINE_STATUS
    return seen


def _diff_view(name: str, ts: dict, py: dict, mask_status: bool = False) -> list[str]:
    ts, py = _normalize(ts), _normalize(py)
    if mask_status:
        _mask_mission_status(ts)
        _mask_mission_status(py)
    out = []
    for key in sorted(set(ts) | set(py)):
        if ts.get(key) != py.get(key):
            out.append(
                f"{name}/view.{key}\n"
                f"    TypeScript: {json.dumps(ts.get(key), sort_keys=True)[:900]}\n"
                f"    Python:     {json.dumps(py.get(key), sort_keys=True)[:900]}"
            )
    return out


def _diff_text(label: str, ts: str, py: str, mask_status: bool = False) -> list[str]:
    ts, py = _normalize_text(ts, mask_status), _normalize_text(py, mask_status)
    if ts == py:
        return []
    ts_lines, py_lines = ts.split("\n"), py.split("\n")
    for i in range(max(len(ts_lines), len(py_lines))):
        a = ts_lines[i] if i < len(ts_lines) else "<end>"
        b = py_lines[i] if i < len(py_lines) else "<end>"
        if a != b:
            return [f"{label} line {i + 1}\n    TypeScript: {a!r}\n    Python:     {b!r}"]
    return [f"{label} differs but no line differs"]  # unreachable in practice


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    args = ap.parse_args()
    repo = Path(args.repo)

    differences: list[str] = []
    compared = 0

    with tempfile.TemporaryDirectory(prefix="context-parity-") as tmp:
        work = Path(tmp)
        job_file = work / "job.json"
        jobs = build(work)

        for job in jobs:
            name = job["name"]
            reference = _oracle(repo, job, job_file)
            mine = _mine(job)

            expected = EXPECTED_DIVERGENCE.get(name)
            if expected:
                # A known difference is ASSERTED, not skipped: it must be
                # exactly the difference that was characterized, or this
                # fails like any other divergence.
                ts_section = reference["view"][expected["section"]]
                py_section = mine["view"][expected["section"]]
                for field, want in expected["typescript"].items():
                    if ts_section.get(field) != want:
                        differences.append(
                            f"{name}: the documented divergence changed — "
                            f"TypeScript {expected['section']}.{field} is "
                            f"{ts_section.get(field)!r}, expected {want!r}")
                for field, want in expected["python"].items():
                    if py_section.get(field) != want:
                        differences.append(
                            f"{name}: the documented divergence changed — "
                            f"Python {expected['section']}.{field} is "
                            f"{py_section.get(field)!r}, expected {want!r}")
                print(f"  known divergence pinned: {name} — {expected['why']}")
                compared += 1
                continue

            mask = name in STATUS_DERIVED_BY_ENGINE
            if mask:
                ts_status = dict(_mask_mission_status(json.loads(json.dumps(reference["view"]))))
                py_status = dict(_mask_mission_status(json.loads(json.dumps(mine["view"]))))
                shown = ", ".join(
                    f"{mid}: TS={ts_status[mid]!r} PY={py_status.get(mid)!r}"
                    for mid in ts_status if ts_status[mid] != py_status.get(mid)
                )
                print(f"  engine-derived mission status masked in {name!r}"
                      + (f" — {shown}" if shown else " — no difference"))

            differences += _diff_view(name, reference["view"], mine["view"], mask)
            compared += 1

            if "contracts" in reference:
                for surface in job["surfaces"]:
                    differences += _diff_text(
                        f"{name}/contract[{surface}]",
                        reference["contracts"][surface], mine["contracts"][surface],
                        mask,
                    )
                    compared += 1
                differences += _diff_text(
                    f"{name}/contract[default]",
                    reference["defaultContract"], mine["defaultContract"], mask)
                differences += _diff_text(
                    f"{name}/header", reference["header"], mine["header"])
                compared += 2
                if reference["usable"] != mine["usable"]:
                    differences.append(f"{name}/usableCapabilities differs")
                compared += 1
            elif "contracts" in mine:
                differences.append(f"{name}: Python rendered a contract, TypeScript did not")

    print(f"{len(jobs)} scenarios · {compared} comparisons · "
          f"{len(SURFACES) + 1} surfaces each (including {UNKNOWN_SURFACE!r})")
    if differences:
        print(f"\n{len(differences)} DIFFERENCE(S):\n")
        for d in differences:
            print(d)
            print()
        return 1
    print("\nRESULT: every scenario matches — view and rendered contract")
    return 0


if __name__ == "__main__":
    sys.exit(main())
