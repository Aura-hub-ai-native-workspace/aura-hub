"""Differential verification against the TypeScript policy engine.

The negative-control tests prove the Python engine matches our *reading*
of the reference. This one proves it matches the reference itself, by
running both over the same generated case matrix.

Skipped rather than failed when the TypeScript tree is not reachable —
but never silently: a skip says parity was not checked, which is not the
same as parity holding.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from parity.policy_parity import build_cases, run_python, run_typescript

REPO = Path(os.environ.get("AURA_TS_REPO", "/mnt/storage/aura-hub"))

pytestmark = pytest.mark.skipif(
    not (REPO / "packages/capability-fabric/src/policy.ts").exists()
    or shutil.which("node") is None,
    reason=f"TypeScript reference not reachable at {REPO}; parity NOT verified",
)


def test_python_policy_engine_matches_the_typescript_reference():
    cases = build_cases()
    assert len(cases) > 300, "the case matrix collapsed; parity would be vacuous"

    ts = run_typescript(cases, REPO)
    py = run_python(cases)

    differences = [
        f"{t['name']}: TS({t['decision']}, {t['rule']}) vs PY({p['decision']}, {p['rule']})"
        for t, p in zip(ts, py)
        if t["decision"] != p["decision"] or t["rule"] != p["rule"]
    ]
    assert not differences, "\n".join(differences)
