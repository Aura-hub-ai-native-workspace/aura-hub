"""Manifest snapshot freshness — manifest.json MUST equal the live TS bundle.

Regenerate after any legitimate manifest change (never hand-edit):

    node --input-type=module -e "
      const m = await import('<repo>/node_modules/.bin/../..'); // see docs
    "
…or simply re-run the Phase-4 generation snippet from the commit message of
the snapshot; this test fails loudly if the two ever drift.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import tsref  # noqa: F401  (session fixture)

from _paths import BACKEND, REPO


def test_manifest_snapshot_matches_typescript(tsref):  # noqa: F811
    script = (
        "const api = await import(process.env.TSREF_FABRIC_INDEX);\n"
        "process.stdout.write(JSON.stringify({generatedFrom:'packages/capability-fabric/src/manifest.ts',"
        "revision:'141d101',capabilities:api.CAPABILITY_MANIFEST}));"
    )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True, text=True, check=True,
        env={"TSREF_FABRIC_INDEX": str(tsref["index"]),
             "PATH": "/usr/bin:/bin:/usr/local/bin"},
    )
    live = json.loads(proc.stdout)
    committed = json.loads((BACKEND / "aura" / "fabric" / "manifest.json").read_text(encoding="utf-8"))
    assert live == committed, (
        "manifest.json drifted from the TypeScript CAPABILITY_MANIFEST — "
        "regenerate it via the documented node snippet, never by hand."
    )


def test_manifest_shape_invariants():
    caps = json.loads((BACKEND / "aura" / "fabric" / "manifest.json").read_text())["capabilities"]
    ids = [c["id"] for c in caps]
    assert len(ids) == len(set(ids)), "duplicate capability ids"
    for c in caps:
        assert set(c) >= {"id", "name", "category", "surface", "description",
                          "risk", "permissions", "output", "verify", "input"}
