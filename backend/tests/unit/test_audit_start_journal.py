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


def test_a_failed_start_write_never_blocks_the_action_and_is_flagged(home):
    ran, events = [], []
    cfg = _cfg(home, lambda inv: ran.append(1) or {"ok": True, "detail": "read"})

    def broken(_record):
        raise OSError("disk full")

    cfg.fabric.attach_start_journal(broken)
    cfg.fabric.listen(events.append)
    r = invoke_fabric(CAP, {"path": str(home / "proj" / "f.txt")}, _ctx(), cfg)
    assert ran == [1]
    assert r["outcome"] in ("succeeded", "unverified")
    trail = _lines(home / "audit.jsonl")
    assert trail[-1]["startJournaled"] is False
    assert any(e.get("type") == "audit.persist-failed" and e.get("phase") == "start" for e in events)


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
            (home / "ready").write_text(invocation["id"])
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
    child = subprocess.Popen([sys.executable, str(script), str(BACKEND), str(home)],
                             cwd=str(BACKEND), start_new_session=True)
    try:
        end = time.monotonic() + 60
        while not (home / "ready").exists():
            assert child.poll() is None, "child exited before the action started"
            assert time.monotonic() < end, "the action never started"
            time.sleep(0.05)
        os.kill(child.pid, signal.SIGKILL)  # the crash
        child.wait(10)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(10)
    return (home / "ready").read_text(), child.pid


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
