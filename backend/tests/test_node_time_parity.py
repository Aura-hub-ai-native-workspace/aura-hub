"""`mtimeMs` must be the number Node reports, digit for digit.

Not a property test against a formula — a differential against the real
`fs.statSync().mtimeMs`, over enough files to hit the nanosecond values
where the two plausible computations disagree.

This is the primitive underneath every fingerprint in the backend. One
unit in the last place is the difference between "the project is
unchanged" and "regenerate everything", and between a profile written by
the TypeScript backend reading as current under the Python one or not.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from aura_backend.core.js_number import js_number
from aura_backend.core.node_time import date_ms_from_stat, mtime_ms

# Enough files that the nanosecond fractions vary; the two computations
# agree on most values and differ on a minority, so a handful is not a
# test.
FILE_COUNT = 60

PROBE = """
const fs = require('node:fs');
const dir = process.argv[1];
const out = {};
for (const name of fs.readdirSync(dir).sort()) {
  out[name] = String(fs.statSync(dir + '/' + name).mtimeMs);
}
process.stdout.write(JSON.stringify(out));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_mtime_ms_matches_node_exactly(tmp_path: Path) -> None:
    for i in range(FILE_COUNT):
        (tmp_path / f"f{i:03d}").write_text("x" * i)

    proc = subprocess.run(
        ["node", "-e", PROBE, str(tmp_path)],
        capture_output=True, text=True, timeout=120, check=True,
    )
    reference: dict[str, str] = json.loads(proc.stdout)
    assert len(reference) == FILE_COUNT

    mismatches = [
        (name, expected, js_number(mtime_ms(tmp_path / name)))
        for name, expected in reference.items()
        if js_number(mtime_ms(tmp_path / name)) != expected
    ]
    assert not mismatches, f"{len(mismatches)} of {FILE_COUNT} differ: {mismatches[:5]}"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_the_naive_computation_really_does_differ(tmp_path: Path) -> None:
    """The guard this module exists for is a real hazard, not a theory.

    If `st_mtime_ns / 1e6` ever stopped differing from Node's arithmetic,
    `node_time` would be dead weight and this test says so rather than
    letting it quietly become decoration.
    """
    for i in range(FILE_COUNT):
        (tmp_path / f"f{i:03d}").write_text("y" * i)

    proc = subprocess.run(
        ["node", "-e", PROBE, str(tmp_path)],
        capture_output=True, text=True, timeout=120, check=True,
    )
    reference: dict[str, str] = json.loads(proc.stdout)

    naive_differs = sum(
        1 for name, expected in reference.items()
        if js_number((tmp_path / name).stat().st_mtime_ns / 1e6) != expected
    )
    assert naive_differs > 0, (
        "st_mtime_ns / 1e6 agreed with Node on all "
        f"{FILE_COUNT} files — the hazard this module guards may be gone"
    )


DATE_PROBE = """
const fs = require('node:fs');
const dir = process.argv[1];
const out = {};
for (const name of fs.readdirSync(dir).sort()) {
  out[name] = fs.statSync(dir + '/' + name).mtime.getTime();
}
process.stdout.write(JSON.stringify(out));
"""

# Nanosecond offsets chosen to straddle the half-millisecond boundary,
# which is the only place the three plausible conversions disagree.
BOUNDARY_NS = [0, 1, 100_000, 499_999, 500_000, 500_001, 700_000, 999_999,
               1_000_000, 1_500_000, 2_500_000, 9_999_999]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_stat_mtime_date_matches_node_at_the_half_millisecond(tmp_path: Path) -> None:
    """`stat.mtime.getTime()` rounds half UP, and this proves it.

    Files created back-to-back almost never land on a `.5` fraction, so
    the boundary is set explicitly with `utime` rather than hoped for.
    """
    import os

    base = 1_787_506_916_000_000_000
    for i, offset in enumerate(BOUNDARY_NS):
        target = tmp_path / f"f{i:02d}"
        target.write_text("x")
        os.utime(target, ns=(base + offset, base + offset))

    proc = subprocess.run(
        ["node", "-e", DATE_PROBE, str(tmp_path)],
        capture_output=True, text=True, timeout=120, check=True,
    )
    reference: dict[str, int] = json.loads(proc.stdout)

    mismatches = [
        (name, expected, date_ms_from_stat(os.stat(tmp_path / name)))
        for name, expected in reference.items()
        if date_ms_from_stat(os.stat(tmp_path / name)) != expected
    ]
    assert not mismatches, mismatches

    # And the two tempting alternatives are genuinely wrong here.
    import math

    trunc_wrong = sum(
        1 for name, expected in reference.items()
        if math.trunc(mtime_ms(tmp_path / name)) != expected
    )
    even_wrong = sum(
        1 for name, expected in reference.items()
        if round(mtime_ms(tmp_path / name)) != expected
    )
    assert trunc_wrong > 0 and even_wrong > 0, (
        f"trunc wrong on {trunc_wrong}, banker's wrong on {even_wrong} — "
        "the boundary this guards may have moved"
    )
