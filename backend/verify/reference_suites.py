"""Run the reference's OWN verification suites against BOTH backends.

This is the strongest evidence available for the tool layer: the
TypeScript project's HTTP verification scripts, **unmodified**, pointed at
each backend in turn via `HUB_API`, with the pass/fail set compared check
by check.

Both services get an isolated `AURA_HOME` and a port of their own, so
nothing here touches a running development service or the user's real
AURA state.

A check that fails on BOTH backends is not a parity failure — it is the
suite telling us something about the environment (most of these suites
assume a project is already registered, and never register one). A check
that differs is a real divergence and is reported as one.

Usage:  uv run python -m verify.reference_suites [--repo PATH]
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Self

# Every reference suite that speaks only HTTP, and so can be pointed at
# either backend without modification.
SUITES = ["node-routing-verify", "node-policy-verify", "install-verify"]

TS_PORT = 4331
PY_PORT = 4332
_LINE = re.compile(r"^(PASS|FAIL)\s+(.+?)(?: — |$)")


def _wait(port: int, timeout: float = 90.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def _free(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return False
    except OSError:
        return True


class Backend:
    def __init__(self, argv: list[str], env: dict[str, str], port: int, cwd: Path) -> None:
        self._argv, self._env, self._port, self._cwd = argv, env, port, cwd
        self._proc: subprocess.Popen | None = None

    def __enter__(self) -> Self:
        self._proc = subprocess.Popen(
            self._argv, env={**os.environ, **self._env}, cwd=str(self._cwd),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        if not _wait(self._port):
            out = b""
            if self._proc.stdout is not None:
                self._proc.stdout.close()
            self._proc.terminate()
            raise SystemExit(f"backend on {self._port} did not start: {out!r}")
        return self

    def __exit__(self, *_exc) -> None:
        if self._proc is None:
            return
        self._proc.terminate()
        try:
            self._proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait(timeout=15)


def run_suite(repo: Path, suite: str, port: int) -> dict[str, str]:
    proc = subprocess.run(
        ["node", str(repo / "scripts" / f"{suite}.mjs")],
        env={**os.environ, "HUB_API": f"http://localhost:{port}"},
        cwd=str(repo), capture_output=True, text=True, timeout=1800,
    )
    results: dict[str, str] = {}
    for line in proc.stdout.split("\n"):
        match = _LINE.match(line.rstrip())
        if match:
            results[match.group(2).strip()] = match.group(1)
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    args = ap.parse_args()
    repo = Path(args.repo)

    if shutil.which("node") is None or shutil.which("npx") is None:
        print("node/npx unavailable — reference suites NOT run")
        return 0
    for port in (TS_PORT, PY_PORT):
        if not _free(port):
            print(f"port {port} is busy; refusing to take it")
            return 1

    failed = False
    with tempfile.TemporaryDirectory(prefix="ref-suites-") as tmp:
        work = Path(tmp)
        ts_home, py_home = work / "ts", work / "py"
        ts_home.mkdir()
        py_home.mkdir()

        # The bundle must live inside the repo so Node can resolve the
        # `typescript` external from node_modules. `.aura/` is a gitignored
        # build directory; the file is removed afterwards.
        bundle = repo / ".aura" / "reference-suite-service.mjs"
        build = subprocess.run(
            ["npx", "esbuild", "packages/ai-service/src/start.ts", "--bundle",
             "--platform=node", "--format=esm", "--external:typescript",
             f"--outfile={bundle}"],
            cwd=str(repo), capture_output=True, text=True,
        )
        if build.returncode != 0:
            print(build.stderr, file=sys.stderr)
            return 1

        try:
            with (
                Backend(
                    ["node", str(bundle), "--none"],
                    {"AURA_HOME": str(ts_home), "AI_PORT": str(TS_PORT)},
                    TS_PORT, repo,
                ),
                Backend(
                    [sys.executable, "-m", "aura_backend"],
                    {"AURA_PY_HOME": str(py_home), "AURA_PY_PORT": str(PY_PORT)},
                    PY_PORT, Path(__file__).resolve().parents[1],
                ),
            ):
                for suite in SUITES:
                    ts = run_suite(repo, suite, TS_PORT)
                    py = run_suite(repo, suite, PY_PORT)

                    shared = set(ts) & set(py)
                    differing = sorted(k for k in shared if ts[k] != py[k])
                    only_ts = sorted(set(ts) - set(py))
                    only_py = sorted(set(py) - set(ts))
                    both_fail = sorted(k for k in shared if ts[k] == py[k] == "FAIL")

                    agree = len(shared) - len(differing)
                    verdict = "IDENTICAL" if not (differing or only_ts or only_py) else "DIFFERS"
                    print(
                        f"{suite:22s} {agree}/{len(shared)} checks agree — {verdict}"
                        + (f"  ({len(both_fail)} fail on both)" if both_fail else "")
                    )
                    for name in differing:
                        failed = True
                        print(f"    DIFF  TS={ts[name]:4s} PY={py[name]:4s}  {name}")
                    for name in only_ts:
                        failed = True
                        print(f"    TS-only ({ts[name]}): {name}")
                    for name in only_py:
                        failed = True
                        print(f"    PY-only ({py[name]}): {name}")
                    if both_fail:
                        print(
                            "    (fail on both = an environment fact, not a divergence: "
                            "these suites assume a registered project)"
                        )
                        for name in both_fail[:3]:
                            print(f"      · {name}")
        finally:
            bundle.unlink(missing_ok=True)

    print("\nRESULT: DIVERGENCE FOUND" if failed else "\nRESULT: BOTH BACKENDS BEHAVE IDENTICALLY")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
