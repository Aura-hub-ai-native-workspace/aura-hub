"""P0-5: orphaned worker processes are reaped through the process boundary.

The service used to call pgrep and os.kill directly. The boundary now owns
discovery and signalling (procexec.terminate_matching). These tests start real
processes, so they check the behaviour rather than the import graph.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time

import pytest

from aura.environment import procexec

pytestmark = pytest.mark.skipif(
    shutil.which("pgrep") is None or sys.platform.startswith("win"),
    reason="orphan reaping needs pgrep on a POSIX host",
)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie still answers kill(0) until reaped; treat it as gone.
    try:
        with open(f"/proc/{pid}/stat") as fh:
            return fh.read().split()[2] != "Z"
    except OSError:
        return True


def _wait_gone(pid: int, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _alive(pid):
            return True
        time.sleep(0.05)
    return False


def test_terminates_only_the_matching_orphan(tmp_path):
    marker = "agt-0123456789ab"
    # A long sleep whose argv carries the session marker, like a worker.
    sleeper = ["-c", "import time; time.sleep(300)"]
    target = subprocess.Popen([sys.executable, *sleeper, marker])
    bystander = subprocess.Popen([sys.executable, *sleeper, "agt-ffffffffffff"])
    try:
        signalled = procexec.terminate_matching(f"time\\.sleep.*{marker}")
        assert target.pid in signalled
        assert _wait_gone(target.pid), "the matching process must be terminated"
        assert _alive(bystander.pid), "an unrelated process must be left alone"
        assert os.getpid() not in signalled
    finally:
        for p in (target, bystander):
            if p.poll() is None:
                p.kill()
            p.wait()


def test_no_match_reaps_nothing_and_does_not_raise():
    assert procexec.terminate_matching("aura-no-such-process-zzz-0001") == []


def test_pattern_must_be_bounded():
    with pytest.raises(ValueError):
        procexec.terminate_matching("")
    with pytest.raises(ValueError):
        procexec.terminate_matching("x" * 257)


def test_service_refuses_a_session_id_that_is_not_its_own_shape(monkeypatch):
    from aura.central_agent import service as svc

    calls: list[str] = []
    monkeypatch.setattr(procexec, "terminate_matching", lambda pat, **k: calls.append(pat) or [])
    agent = svc.CentralAgent.__new__(svc.CentralAgent)  # no backend needed
    agent._kill_orphaned_workers("agt-x; rm -rf /")
    agent._kill_orphaned_workers("")
    assert calls == []
    agent._kill_orphaned_workers("agt-9e30a8d5316c")
    assert calls and all("agt-9e30a8d5316c" in c for c in calls)
