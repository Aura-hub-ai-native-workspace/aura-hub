"""Issue #109 — a governed action that was authorized and started is on disk
before it runs, and a crash cannot erase that.

The audit trail (``trail.jsonl``) holds one record per *settled* invocation
(docs/migration/invariants.md §3), written in ``_settle``. A process killed
mid-execution therefore left no record that the action was ever authorized
or started. The start journal (``started.jsonl``, beside the trail) records
authorization + start before the executor runs; on the next startup an
unsettled start of a dead process is marked as such, once.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from aura.audit import AuditStore
from aura.fabric import invoke_fabric

from test_fabric_invoke import make_cfg

BACKEND = Path(__file__).resolve().parents[2]
CAP = "filesystem.read"


def _lines(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class _Exec:
    capabilityId = CAP

    def __init__(self, on_run):
        self._on_run = on_run

    async def run(self, invocation):
        return self._on_run(invocation)


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    (tmp_path / "proj").mkdir()
    (tmp_path / "proj" / "f.txt").write_text("x")
    return tmp_path


def _cfg(home, on_run):
    cfg = make_cfg(home, executors={CAP: _Exec(on_run)})
    cfg.fabric.attach_start_journal(cfg.audit_store.starts().append)
    return cfg


def _ctx():
    return {"actor": {"kind": "agent", "id": "central-agent"}, "projectId": "p",
            "sessionId": "agt-0000000000aa", "taskId": "t1", "requestId": "req-1"}


def test_the_start_record_is_on_disk_before_the_executor_runs(home):
    seen = {}

    def on_run(invocation):
        seen["starts"] = _lines(home / "started.jsonl")
        seen["trail"] = _lines(home / "audit.jsonl")
        seen["id"] = invocation["id"]
        return {"ok": True, "detail": "read"}

    cfg = _cfg(home, on_run)
    r = invoke_fabric(CAP, {"path": str(home / "proj" / "f.txt")}, _ctx(), cfg)
    assert r["outcome"] in ("succeeded", "unverified")
    starts = [s for s in seen["starts"] if s["invocationId"] == seen["id"]]
    assert len(starts) == 1, "no durable start record existed while the action ran"
    s = starts[0]
    assert s["phase"] == "started" and s["capabilityId"] == CAP
    assert s["decision"] == "auto-execute" and s["decisionRule"]
    assert s["actor"] == {"kind": "agent", "id": "central-agent"}
    assert s["sessionId"] == "agt-0000000000aa" and s["taskId"] == "t1"
    assert s["pid"] == os.getpid() and s["at"] and s["inputSummary"]
    assert seen["trail"] == [], "the settled record must not exist before the action ends"


def test_the_trail_contract_is_unchanged_when_healthy(home):
    cfg = _cfg(home, lambda inv: {"ok": True, "detail": "read"})
    invoke_fabric(CAP, {"path": str(home / "proj" / "f.txt")}, _ctx(), cfg)
    trail = _lines(home / "audit.jsonl")
    assert len(trail) == 1, "still exactly one trail record per settled invocation"
    assert "phase" not in trail[0] and "startJournaled" not in trail[0]
    assert trail[0]["outcome"] in ("succeeded", "unverified")


def test_denied_invocations_write_no_start_record(home):
    cfg = _cfg(home, lambda inv: pytest.fail("a denied action must not run"))
    cfg.fabric.policy = {**cfg.fabric.policy, "overrides": {CAP: "deny"}}
    r = invoke_fabric(CAP, {"path": str(home / "proj" / "f.txt")}, _ctx(), cfg)
    assert r["outcome"] == "denied"
    assert _lines(home / "started.jsonl") == []
    assert len(_lines(home / "audit.jsonl")) == 1


def _broken(_record):
    raise OSError("disk full")


def test_a_failed_start_write_still_runs_a_low_risk_action_and_flags_it(home):
    """Owner policy: low-risk, reversible actions run, with the failure flagged."""
    ran, events = [], []
    cfg = _cfg(home, lambda inv: ran.append(1) or {"ok": True, "detail": "read"})
    cfg.fabric.attach_start_journal(_broken)
    cfg.fabric.listen(events.append)
    r = invoke_fabric(CAP, {"path": str(home / "proj" / "f.txt")}, _ctx(), cfg)
    assert ran == [1]
    assert r["outcome"] in ("succeeded", "unverified")
    trail = _lines(home / "audit.jsonl")
    assert trail[-1]["startJournaled"] is False
    assert any(e.get("type") == "audit.persist-failed" and e.get("phase") == "start" for e in events)


class _WriteExec:
    capabilityId = "filesystem.write"

    def __init__(self, ran):
        self._ran = ran

    async def run(self, invocation):
        self._ran.append(1)
        return {"ok": True, "detail": "written"}


def test_a_failed_start_write_blocks_a_non_low_risk_action(home):
    """Owner policy: anything not low-risk is blocked before it runs."""
    ran, events = [], []
    cfg = make_cfg(home, executors={"filesystem.write": _WriteExec(ran)})
    cfg.fabric.attach_start_journal(_broken)
    cfg.fabric.listen(events.append)
    r = invoke_fabric("filesystem.write", {"path": "g.txt", "content": "x"}, _ctx(), cfg)
    assert ran == [], "a medium-risk action ran without its start record"
    assert r["outcome"] == "denied"
    assert r["policy"]["rule"] == "audit-start-unwritable"
    assert "could not be written" in r["detail"] and "medium" in r["detail"]
    trail = _lines(home / "audit.jsonl")
    assert trail[-1]["outcome"] == "denied" and trail[-1]["decisionRule"] == "audit-start-unwritable"
    assert trail[-1]["startJournaled"] is False
    assert any(e.get("type") == "audit.persist-failed" for e in events)
    assert any(e.get("type") == "invocation.denied" for e in events)


@pytest.mark.parametrize("declared,evaluated,allowed", [
    ("low", "low", True),
    ("medium", "medium", False),
    ("high", "high", False),
    ("low", "high", False),      # the stricter view wins
    ("high", "low", False),      # never downgraded
    (None, "low", False),        # unclassified is treated as high
    ("weird", "low", False),     # unrecognised is treated as high
    ("low", None, False),
])
def test_only_low_risk_by_both_views_may_run_without_a_start_record(declared, evaluated, allowed):
    from aura.fabric import CapabilityFabric

    cap = {} if declared is None else {"risk": declared}
    ev = {} if evaluated is None else {"risk": evaluated}
    assert CapabilityFabric._may_run_without_start_record(cap, ev) is allowed


CHILD = textwrap.dedent("""
    import asyncio, os, sys, time
    from pathlib import Path
    sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[1] + "/tests/unit")
    home = Path(sys.argv[2])
    os.environ["AURA_HOME"] = str(home)
    from test_fabric_invoke import make_cfg
    from aura.fabric import invoke_fabric

    class Hang:
        capabilityId = "filesystem.read"
        async def run(self, invocation):
            (home / "ready").write_text(f"{invocation['id']}\\n{os.getpid()}")
            await asyncio.sleep(600)
            return {"ok": True, "detail": "never"}

    cfg = make_cfg(home, executors={"filesystem.read": Hang()})
    cfg.fabric.attach_start_journal(cfg.audit_store.starts().append)
    invoke_fabric("filesystem.read", {"path": str(home / "proj" / "f.txt")},
                  {"actor": {"kind": "agent", "id": "central-agent"}, "projectId": "p",
                   "sessionId": "agt-0000000000bb", "taskId": "t9"}, cfg)
""")


def _crash_mid_invocation(home: Path) -> tuple[str, int]:
    script = home / "child.py"
    script.write_text(CHILD)
    posix = os.name == "posix"
    child = subprocess.Popen([sys.executable, str(script), str(BACKEND), str(home)],
                             cwd=str(BACKEND), start_new_session=posix)
    try:
        end = time.monotonic() + 60
        while not (home / "ready").exists():
            assert child.poll() is None, "child exited before the action started"
            assert time.monotonic() < end, "the action never started"
            time.sleep(0.05)
        time.sleep(0.2)  # let the writer finish the two-line ready file
        inv_id, pid = (home / "ready").read_text().split("\n")
        # The crash: an unhandleable kill of the process running the action
        # (SIGKILL on POSIX; on Windows os.kill is TerminateProcess). Its own
        # pid, because on Windows a venv python.exe may be a launcher whose
        # child does the work. Nothing in the process gets to clean up.
        os.kill(int(pid), signal.SIGKILL if posix else signal.SIGTERM)
        child.wait(30)
    finally:
        if child.poll() is None:
            if posix:
                os.killpg(child.pid, signal.SIGKILL)
            else:
                child.kill()
            child.wait(10)
    return inv_id, int(pid)


def test_a_crash_mid_invocation_leaves_authorization_and_start_on_disk(home):
    inv_id, pid = _crash_mid_invocation(home)
    trail = _lines(home / "audit.jsonl")
    assert all(r["invocationId"] != inv_id for r in trail), "the action never settled"
    starts = [s for s in _lines(home / "started.jsonl") if s["invocationId"] == inv_id]
    assert len(starts) == 1
    assert starts[0]["decision"] == "auto-execute" and starts[0]["pid"] == pid
    assert starts[0]["sessionId"] == "agt-0000000000bb" and starts[0]["taskId"] == "t9"
    # Loaded through the store like any other journal record (usability gate).
    assert any(r["invocationId"] == inv_id for r in AuditStore(home / "audit.jsonl").starts().load())


def test_restart_marks_the_crashed_invocation_unsettled_exactly_once(home):
    from aura.audit import reconcile_unsettled_starts

    inv_id, _ = _crash_mid_invocation(home)
    audit = AuditStore(home / "audit.jsonl")
    marked = reconcile_unsettled_starts(audit)
    assert marked == [inv_id]
    markers = [r for r in _lines(home / "started.jsonl") if r.get("phase") == "unsettled-after-restart"]
    assert len(markers) == 1 and markers[0]["invocationId"] == inv_id
    assert markers[0]["capabilityId"] == CAP and markers[0]["startedAt"]
    assert "no outcome" in markers[0]["detail"]
    assert reconcile_unsettled_starts(audit) == [], "idempotent across restarts"


def test_reconciliation_leaves_settled_and_live_invocations_alone(home):
    from aura.audit import reconcile_unsettled_starts

    cfg = _cfg(home, lambda inv: {"ok": True, "detail": "read"})
    invoke_fabric(CAP, {"path": str(home / "proj" / "f.txt")}, _ctx(), cfg)  # settled
    journal = cfg.audit_store.starts()
    journal.append({"invocationId": "inv-live", "capabilityId": CAP, "at": "2026-11-26T00:00:00Z",
                    "phase": "started", "pid": os.getpid()})  # a live process
    assert reconcile_unsettled_starts(cfg.audit_store) == []


# ── liveness: a separate process with its own pid (review finding 2) ─────────
# The test above uses this process's own pid, which reconciliation skips before
# it ever asks whether a process is alive. These use an independent child, so
# the real check runs, on Linux, macOS and Windows alike.

def _sleeping_child() -> subprocess.Popen:
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    assert child.pid != os.getpid()
    return child


def test_pid_state_of_a_separate_child_is_alive_then_dead():
    from aura.audit import ALIVE, DEAD, pid_state

    child = _sleeping_child()
    try:
        assert pid_state(child.pid) == ALIVE
    finally:
        child.kill()
        child.wait(30)
    assert pid_state(child.pid) == DEAD


@pytest.mark.skipif(os.name == "nt" or not hasattr(os, "waitid")
                    or not hasattr(os, "WNOWAIT"),
                    reason="waitid(WNOWAIT) is required to observe an unreaped exit")
def test_pid_state_reports_an_unreaped_zombie_as_dead():
    from aura.audit import DEAD, pid_state

    child = subprocess.Popen([sys.executable, "-c", "import os; os._exit(0)"])
    try:
        os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT)
        assert child.returncode is None, "the child must still be unreaped"
        assert pid_state(child.pid) == DEAD
    finally:
        child.wait(30)


def test_concurrent_reconciliation_appends_one_marker(home):
    journal = AuditStore(home / "audit.jsonl").starts()
    journal.append({"invocationId": "inv-race", "capabilityId": CAP,
                    "at": "2026-11-26T00:00:00Z", "phase": "started", "pid": 99999999})
    code = textwrap.dedent("""
        import sys, time
        from pathlib import Path
        sys.path.insert(0, sys.argv[1])
        from aura.audit import DEAD, AuditStore, reconcile_unsettled_starts
        def delayed(_pid):
            Path(sys.argv[3]).touch()
            time.sleep(2)
            return DEAD
        reconcile_unsettled_starts(AuditStore(sys.argv[2]), pid_state=delayed)
    """)
    ready1, ready2 = home / "ready-one", home / "ready-two"
    cmd1 = [sys.executable, "-c", code, str(BACKEND), str(home / "audit.jsonl"), str(ready1)]
    cmd2 = [sys.executable, "-c", code, str(BACKEND), str(home / "audit.jsonl"), str(ready2)]
    first = subprocess.Popen(cmd1)
    deadline = time.monotonic() + 10
    while not ready1.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert ready1.exists(), "first reconciler did not reach its liveness check"
    second = subprocess.Popen(cmd2)
    try:
        assert first.wait(15) == 0
        assert second.wait(15) == 0
    finally:
        for process in (first, second):
            if process.poll() is None:
                process.kill()
                process.wait(5)
    markers = [r for r in _lines(home / "started.jsonl")
               if r.get("phase") == "unsettled-after-restart"]
    assert len(markers) == 1


def test_reconcile_never_marks_a_separate_live_process_and_marks_it_once_dead(home):
    from aura.audit import reconcile_unsettled_starts

    journal = AuditStore(home / "audit.jsonl").starts()
    child = _sleeping_child()
    try:
        journal.append({"invocationId": "inv-child", "capabilityId": CAP,
                        "at": "2026-11-26T00:00:00Z", "phase": "started", "pid": child.pid})
        assert reconcile_unsettled_starts(AuditStore(home / "audit.jsonl")) == []
        assert [r["invocationId"] for r in _lines(home / "started.jsonl")] == ["inv-child"]
    finally:
        child.kill()
        child.wait(30)
    assert reconcile_unsettled_starts(AuditStore(home / "audit.jsonl")) == ["inv-child"]
    assert reconcile_unsettled_starts(AuditStore(home / "audit.jsonl")) == []


def test_unknown_liveness_preserves_the_start_and_is_reported(home):
    from aura.audit import UNKNOWN, reconcile_unsettled_starts

    journal = AuditStore(home / "audit.jsonl").starts()
    journal.append({"invocationId": "inv-denied", "capabilityId": CAP,
                    "at": "2026-11-26T00:00:00Z", "phase": "started", "pid": 4242})
    before = (home / "started.jsonl").read_bytes()
    undetermined: list = []
    marked = reconcile_unsettled_starts(AuditStore(home / "audit.jsonl"),
                                        pid_state=lambda _pid: UNKNOWN, undetermined=undetermined)
    assert marked == [] and undetermined == ["inv-denied"]
    assert (home / "started.jsonl").read_bytes() == before, "the start record must be preserved untouched"


class _FakeWinApi:
    def __init__(self, handle=0, error=0, code=None):
        self._handle, self._error, self._code, self.closed = handle, error, code, False

    def open(self, _pid):
        return self._handle

    def last_error(self):
        return self._error

    def exit_code(self, _handle):
        return self._code

    def close(self, _handle):
        self.closed = True


@pytest.mark.parametrize("api,expected", [
    (_FakeWinApi(handle=0, error=87), "dead"),              # no such process
    (_FakeWinApi(handle=0, error=5), "unknown"),            # access denied: exists, never "dead"
    (_FakeWinApi(handle=0, error=6), "unknown"),            # any other failure proves nothing
    (_FakeWinApi(handle=1, code=259), "alive"),             # STILL_ACTIVE
    (_FakeWinApi(handle=1, code=0), "dead"),                # exited
    (_FakeWinApi(handle=1, code=None), "unknown"),          # exit code unreadable
])
def test_windows_liveness_decision(api, expected):
    """The Windows decision logic, on every platform; the real API runs in the
    separate-child tests above when CI runs on Windows."""
    from aura.audit import _pid_state_windows

    assert _pid_state_windows(1234, api) == expected
    if api._handle:
        assert api.closed, "an opened handle is always closed"


def test_api_startup_marks_unsettled_starts(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    starts = tmp_path / "audit" / "started.jsonl"
    starts.parent.mkdir(parents=True)
    starts.write_text(json.dumps({"invocationId": "inv-crashed", "capabilityId": CAP,
                                  "at": "2026-11-26T00:00:00Z", "phase": "started",
                                  "pid": dead.pid}) + "\n")
    from aura.api.server import _wire

    _wire()
    markers = [r for r in _lines(starts) if r.get("phase") == "unsettled-after-restart"]
    assert [m["invocationId"] for m in markers] == ["inv-crashed"]
