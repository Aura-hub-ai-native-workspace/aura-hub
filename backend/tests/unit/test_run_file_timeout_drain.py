"""run_file must settle after a timeout even if a descendant keeps the pipes.

On timeout run_file KILLs the worker's process group, then waits for its
output. A descendant that started its own session survives that KILL and
keeps stdout open, so an unbounded wait for the output never returns, and a
later STOP cannot reach it either: the cancel check is already behind it.
(Raised while investigating the 650 s Kilo invocation in session
agt-783c2ab7e0a9; whether that run hit this path is not established.)

No real worker: a Python child plays the worker and forks a long-lived
grandchild in a new session that inherits stdout.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
import time

import pytest

from aura.exec_ import run_file

pytestmark = pytest.mark.skipif(os.name == "nt", reason="POSIX sessions")


def test_a_timeout_settles_even_when_a_descendant_holds_the_pipes(tmp_path):
    pidfile = tmp_path / "grandchild.pid"
    worker = (
        "import subprocess, sys, time\n"
        "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],"
        " start_new_session=True)\n"
        f"open({str(pidfile)!r}, 'w').write(str(g.pid))\n"
        "time.sleep(60)\n"
    )
    started = time.monotonic()
    try:
        out = asyncio.run(asyncio.wait_for(
            run_file([sys.executable, "-c", worker], str(tmp_path), 1_000),
            timeout=30))
    finally:
        if pidfile.exists():
            try:
                os.kill(int(pidfile.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
    elapsed = time.monotonic() - started
    assert out.timedOut is True
    assert "timed out after 1000ms" in out.out
    assert elapsed < 15, f"run_file took {elapsed:.1f}s to settle after a 1s timeout"
