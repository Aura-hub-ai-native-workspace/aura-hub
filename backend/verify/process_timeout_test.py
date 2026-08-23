"""process-timeout-test — regression tests for exit-status truthfulness.

A Python port of scripts/process-timeout-test.mjs, check for check.

These exist because the shared spawn primitive used to report a killed
child as exit code 0. A ten-minute agent run cut short by its timeout came
back as "succeeded", which is the worst class of bug this codebase can
have: a confident wrong answer.

Every case below drives the REAL Python primitive, not a
reimplementation of it. The check numbering matches the TypeScript suite
so the two can be read side by side.

Usage:  uv run python -m verify.process_timeout_test [--repo PATH]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from aura_backend.execution import (
    AGENT_BINARIES,
    SAFE_BINARIES,
    TIMEOUT_EXIT_CODE,
    ProcessRefused,
    SpawnOptions,
    git,
    resolve_agent_binary,
    run_agent,
    safe_shell,
    safe_shell_with_code,
)

failed = False


def check(name: str, ok: bool, extra: str = "") -> None:
    global failed
    print(f"{'PASS' if ok else 'FAIL'}  {name}{f' — {extra}' if extra else ''}")
    if not ok:
        failed = True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    args = ap.parse_args()
    repo = args.repo

    with tempfile.TemporaryDirectory(prefix="proc-cwd-") as tmp:
        d = Path(tmp)
        (d / "x.txt").write_text("hello\n", encoding="utf-8")
        # Fixtures as files, not `-e` one-liners: parse_command rightly
        # refuses shell metacharacters, and `=>` / `;` contain some.
        (d / "slow.js").write_text("setTimeout(function(){}, 60000)\n", encoding="utf-8")
        (d / "exit3.js").write_text("process.exit(3)\n", encoding="utf-8")
        (d / "sigterm.js").write_text(
            'process.kill(process.pid, "SIGTERM")\n', encoding="utf-8"
        )
        (d / "partial.js").write_text(
            'console.log("partial"); setTimeout(function(){}, 60000)\n', encoding="utf-8"
        )
        cwd = str(d)

        # ── 1. normal exit 0 → success ───────────────────────────────
        r = safe_shell_with_code("node --version", SpawnOptions(cwd=cwd))
        check(
            "1. exit 0 reports code 0",
            r.code == 0 and not r.killed and not r.timed_out,
            f"code={r.code} out={r.out[:20]}",
        )

        # ── 2. normal non-zero exit → real code ──────────────────────
        r = safe_shell_with_code("node exit3.js", SpawnOptions(cwd=cwd))
        check(
            "2. non-zero exit reports the REAL code, not 0 and not 1",
            r.code == 3 and not r.timed_out,
            f"code={r.code}",
        )

        # ── 3. timeout → 124, never 0 ────────────────────────────────
        r = safe_shell_with_code("node slow.js", SpawnOptions(cwd=cwd, timeout_ms=600))
        check("3. a timed-out process is a FAILURE, not exit 0", r.code != 0, f"code={r.code}")
        check("3b. timeout reports the deterministic 124", r.code == TIMEOUT_EXIT_CODE,
              f"code={r.code}")
        check(
            "3c. timeout is flagged and explained",
            r.timed_out is True and "timed out" in r.out.lower(),
            f"timedOut={r.timed_out} out={r.out!r}",
        )

        # ── 4. signal termination → failure, signal preserved ────────
        r = safe_shell_with_code("node sigterm.js", SpawnOptions(cwd=cwd))
        check(
            "4. signal termination is a failure with the signal preserved",
            r.code != 0 and (r.signal == "SIGTERM" or r.code == 143),
            f"code={r.code} signal={r.signal}",
        )

        # ── 5. git: timeout must not read as clean ───────────────────
        subprocess.run(["git", "-C", cwd, "init", "-q"], check=True)
        good = git(["status", "--porcelain"], SpawnOptions(cwd=cwd))
        check("5. git status still works normally", good.code == 0, f"code={good.code}")

        # Deliberately real work on a real repo: `git status` in an empty
        # directory can finish inside a 1ms window, which would make this a
        # race rather than a test. Walking thousands of commits cannot.
        bad = git(["log", "--stat", "-n", "5000"], SpawnOptions(cwd=repo, timeout_ms=2))
        check(
            "5b. a timed-out git is NOT reported as exit 0",
            bad.code != 0 and bad.timed_out is True,
            f"code={bad.code} timedOut={bad.timed_out}",
        )

        # ── 6. safe_shell raises rather than returning partial output ─
        rejected = False
        message = ""
        try:
            safe_shell("node partial.js", SpawnOptions(cwd=cwd, timeout_ms=600))
        except ProcessRefused as e:
            rejected = True
            message = str(e)
        check(
            "6. safe_shell rejects a killed process instead of returning its partial output",
            rejected,
            message[:60],
        )

        # ── 7. the agent allow-list is separate and enforced ─────────
        check(
            "7. SAFE_BINARIES and AGENT_BINARIES are disjoint",
            "git" not in AGENT_BINARIES
            and "node" not in AGENT_BINARIES
            and "opencode" in AGENT_BINARIES
            and not (SAFE_BINARIES & AGENT_BINARIES),
            f"agents=[{', '.join(sorted(AGENT_BINARIES))}]",
        )
        for bad_name in [
            "/home/Groot/.opencode/bin/opencode",
            "../../bin/sh",
            "sh",
            "opencode; rm -rf /",
        ]:
            res = resolve_agent_binary(bad_name)
            check(f"7b. rejected: {bad_name!r}", res.ok is False, res.reason[:70])
        check('7c. accepted: "opencode"', resolve_agent_binary("opencode").ok is True)

        # ── 8. a timed-out AGENT is a failure ────────────────────────
        # Real binary, real spawn, deliberately impossible deadline.
        try:
            r = run_agent(
                "opencode", ["run", "--dir", cwd, "say hi"],
                SpawnOptions(cwd=cwd, timeout_ms=1500),
            )
            check(
                "8. a timed-out agent reports 124, never 0",
                r.code == TIMEOUT_EXIT_CODE and r.timed_out is True,
                f"code={r.code} timedOut={r.timed_out}",
            )
        except Exception as e:  # noqa: BLE001
            # Reported, never silently skipped: an unrunnable check is not a
            # passing one.
            check("8. a timed-out agent reports 124, never 0", False, f"could not run: {e}")

    print("\nRESULT: FAILED" if failed else "\nRESULT: ALL CHECKS PASSED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
