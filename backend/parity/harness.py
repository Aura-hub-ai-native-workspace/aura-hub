"""Differential verification: TypeScript backend vs Python backend.

The TypeScript service is the behavioral reference. This harness sends
the *same* request to both and reports every difference. It normalizes
only genuinely nondeterministic fields (ids, timestamps, durations,
ports, absolute paths) — never fields that could hide a behavioral
difference. If a normalization is added here, it must be justified in
docs/PYTHON_BACKEND_MIGRATION_MAP.md.

Usage:
    python -m parity.harness --ts http://127.0.0.1:4319 \
                             --py http://127.0.0.1:4321 \
                             --cases parity/cases/*.json
"""

from __future__ import annotations

import argparse
import glob
import json
import re
import sys
from dataclasses import dataclass, field
from typing import Any

import httpx

# Fields whose values are nondeterministic by construction. Keys are matched
# at any depth. The VALUE is replaced by a placeholder; the KEY's presence and
# type are still compared, so "the field vanished" remains a difference.
NONDETERMINISTIC_KEYS = {
    "id",
    "runId",
    "requestId",
    "approvalId",
    "traceId",
    "createdAt",
    "updatedAt",
    "startedAt",
    "finishedAt",
    "completedAt",
    "timestamp",
    "durationMs",
    "elapsedMs",
    "pid",
    "port",
    "version",
    "uptime",
}

# Values that legitimately differ because the two backends are different
# programs, not because they behave differently.
BACKEND_IDENTITY_KEYS = {"backend", "shadow", "service"}

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")


def normalize(value: Any, *, home_ts: str | None = None, home_py: str | None = None) -> Any:
    """Replace nondeterministic values with type-preserving placeholders."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in BACKEND_IDENTITY_KEYS:
                out[k] = f"<{k}>"
            elif k in NONDETERMINISTIC_KEYS:
                out[k] = f"<{type(v).__name__}>"
            else:
                out[k] = normalize(v, home_ts=home_ts, home_py=home_py)
        return out
    if isinstance(value, list):
        return [normalize(v, home_ts=home_ts, home_py=home_py) for v in value]
    if isinstance(value, str):
        if _ISO.match(value):
            return "<timestamp>"
        # Longest first: one home directory is often a prefix of the other
        # (~/.aura and ~/.aura-py), and substituting the short one first
        # leaves a "-py" fragment that reads as a false difference.
        for home in sorted((h for h in (home_ts, home_py) if h), key=len, reverse=True):
            if home in value:
                return value.replace(home, "<aura-home>")
    return value


def diff(a: Any, b: Any, path: str = "") -> list[str]:
    """Every structural difference between two normalized documents."""
    if type(a) is not type(b):
        return [f"{path or '/'}: type {type(a).__name__} vs {type(b).__name__}"]
    if isinstance(a, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f"{path}/{k}: missing in TypeScript, present in Python")
            elif k not in b:
                out.append(f"{path}/{k}: present in TypeScript, missing in Python")
            else:
                out += diff(a[k], b[k], f"{path}/{k}")
        return out
    if isinstance(a, list):
        if len(a) != len(b):
            return [f"{path}: length {len(a)} vs {len(b)}"]
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff(x, y, f"{path}[{i}]")
        return out
    if a != b:
        return [f"{path or '/'}: {a!r} vs {b!r}"]
    return []


@dataclass
class Case:
    name: str
    method: str
    path: str
    body: Any = None
    # A case may legitimately expect a denial; the point is that BOTH
    # backends deny, with the same code.
    expect_status: int | None = None


@dataclass
class Result:
    case: Case
    ts_status: int
    py_status: int
    differences: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.ts_status == self.py_status and not self.differences


def run_case(client_ts: httpx.Client, client_py: httpx.Client, case: Case, **norm) -> Result:
    def send(client: httpx.Client) -> tuple[int, Any]:
        r = client.request(case.method, case.path, json=case.body, timeout=30)
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, r.text

    ts_status, ts_body = send(client_ts)
    py_status, py_body = send(client_py)
    differences = diff(normalize(ts_body, **norm), normalize(py_body, **norm))
    if ts_status != py_status:
        differences.insert(0, f"status: {ts_status} vs {py_status}")
    return Result(case, ts_status, py_status, differences)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ts", default="http://127.0.0.1:4319")
    ap.add_argument("--py", default="http://127.0.0.1:4321")
    ap.add_argument("--cases", nargs="+", required=True)
    ap.add_argument("--home-ts", default=None)
    ap.add_argument("--home-py", default=None)
    args = ap.parse_args(argv)

    paths: list[str] = []
    for pattern in args.cases:
        paths += sorted(glob.glob(pattern))
    cases = [Case(**c) for p in paths for c in json.loads(open(p).read())]
    if not cases:
        print("no parity cases found", file=sys.stderr)
        return 2

    norm = {"home_ts": args.home_ts, "home_py": args.home_py}
    failures = 0
    with httpx.Client(base_url=args.ts) as ts, httpx.Client(base_url=args.py) as py:
        for case in cases:
            result = run_case(ts, py, case, **norm)
            if result.ok:
                print(f"PASS {case.name}")
            else:
                failures += 1
                print(f"FAIL {case.name}")
                for d in result.differences:
                    print(f"       {d}")
    print(f"\n{len(cases) - failures}/{len(cases)} parity cases match")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
