"""Error knowledge: written to project-local Markdown, honest about what is
known, retrievable before similar work — and wired to the real coordinator
failover path."""

from __future__ import annotations

import threading

import pytest

from aura.central_agent.error_knowledge import ErrorKnowledge, sanitize
from aura.central_agent.shared_context import SharedContext
from test_cancellation import _ok
from test_stopped_mission_view import MISSION, _agent


@pytest.fixture()
def ek(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    return ErrorKnowledge(root, project_id="p1", shared=SharedContext(tmp_path / "home"))


def test_a_record_is_readable_markdown_in_the_project(ek):
    rec = ek.record(summary="pytest failed in tests/test_api.py", diagnostic="AssertionError: 1 != 2",
                    error_class="ordinary", task_id="t1", plan_id="plan-9", session_id="agt-1",
                    worker="claude-code", tool="agent.delegate")
    path = ek.root / rec["path"]
    text = path.read_text()
    assert path.parent == ek.dir and path.suffix == ".md" and text.startswith("# pytest failed")
    for needle in ("**id:** " + rec["id"], "**status:** open", "**task:** t1", "**worker:** claude-code",
                   "AssertionError: 1 != 2", "Not established.", "Not resolved."):
        assert needle in text
    assert (ek.dir.parent / ".gitignore").read_text() == "*\n"  # never dirties the repo


def test_a_suspicion_is_never_recorded_as_a_cause_and_a_workaround_is_never_a_fix(ek):
    rec = ek.record(summary="build broke", diagnostic="exit 1")
    assert "Not established." in (ek.root / rec["path"]).read_text()
    half = ek.resolve(rec["id"], resolution="deleted the lockfile", evidence="")
    assert half["status"] == "workaround"  # tried, not verified
    assert ek.retrieve("build broke")[0]["status"] == "workaround"
    done = ek.resolve(rec["id"], resolution="pinned the dependency", evidence="npm test: 42 passed",
                      root_cause="a transitive dependency shipped a breaking change")
    assert done["status"] == "resolved"
    reread = ek.all()[0]
    assert reread["root_cause"].startswith("a transitive") and reread["evidence"] == "npm test: 42 passed"


def test_records_are_sanitized(ek):
    rec = ek.record(summary="auth failed", diagnostic=(
        "\x1b[31mERROR\x1b[0m token sk-abcdefghijklmnopqrstuv Authorization: Bearer "
        "abcdefghijklmnopqrstuvwxyz0123456789 at " + str(__import__("pathlib").Path.home()) + "/proj\n" + "x" * 5000))
    text = (ek.root / rec["path"]).read_text()
    assert "\x1b" not in text and "sk-abcdef" not in text and "abcdefghijklmnopqrstuvwxyz0123" not in text
    assert str(__import__("pathlib").Path.home()) not in text and len(text) < 3500
    assert sanitize("a" * 3000).endswith("…")


def test_the_index_in_shared_context_tracks_the_record(ek):
    rec = ek.record(summary="deploy timed out", diagnostic="waited 30s", error_class="timeout", task_id="t3")
    entry = ek.shared.get("p1", f"error:{rec['id']}")
    assert entry["kind"] == "error" and entry["taskId"] == "t3" and "status=open" in entry["body"]
    ek.resolve(rec["id"], resolution="raised the timeout", evidence="deploy ok, exit 0")
    entry = ek.shared.get("p1", f"error:{rec['id']}")
    assert "status=resolved" in entry["body"] and "raised the timeout" in entry["body"]
    assert len(ek.shared.list("p1")) == 1  # updated in place, not duplicated


def test_relevant_errors_are_retrieved_resolved_ones_first(ek):
    open_ = ek.record(summary="database migration failed", diagnostic="column exists")
    fixed = ek.record(summary="database connection refused", diagnostic="port closed")
    ek.resolve(fixed["id"], resolution="started the service", evidence="psql ok")
    ek.record(summary="css lint warning", diagnostic="unused rule")
    got = ek.retrieve("fix the database setup")
    assert [r["id"] for r in got] == [fixed["id"], open_["id"]]
    brief = ek.brief(got)
    assert "KNOWN ISSUES" in brief and "resolved by: started the service" in brief
    assert ek.retrieve("totally unrelated words here") == []
    assert ek.brief([]) == ""


def test_an_unknown_or_malformed_id_resolves_nothing(ek):
    assert ek.resolve("err-0000000000", resolution="x", evidence="y") is None
    assert ek.resolve("../../etc/passwd", resolution="x", evidence="y") is None


def test_concurrent_writers_each_get_their_own_file(ek):
    ids = []
    lock = threading.Lock()

    def go(n):
        r = ek.record(summary=f"failure {n}", diagnostic="x")
        with lock:
            ids.append(r["id"])

    ts = [threading.Thread(target=go, args=(n,)) for n in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(set(ids)) == 8 and len(list(ek.dir.glob("*.md"))) == 8


# ── through the real coordinator ──────────────────────────────────────────

def quota_then_ok(fail_nodes):
    calls = []

    def invoke(cap, payload, context, cfg):
        node = context.get("nodeId") or "claude-code"
        calls.append({"task": context["taskId"], "node": node, "context": payload.get("context", "")})
        if node in fail_nodes:
            return {"invocationId": f"inv-{len(calls)}", "outcome": "failed",
                    "detail": "You've hit your usage limit for this session.",
                    "verification": {"passed": None, "kind": "exit-code", "detail": ""},
                    "policy": {"decision": "auto-execute", "rule": "r", "risk": "high", "reason": ""},
                    "at": "2026-10-20T00:00:00Z",
                    "output": {"stdout": "", "exitCode": 1, "nodeId": node, "agent": node}}
        return _ok(f"inv-{len(calls)}", node, stdout="alpha A.")
    invoke.calls = calls
    return invoke


def test_a_quota_failover_is_recorded_and_resolved_only_because_the_retry_verified(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    (root / "alpha").mkdir(parents=True)
    (root / "alpha" / "a.txt").write_text("alpha A.\n")
    agent = _agent(tmp_path)
    invoke = quota_then_ok({"claude-code"})
    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric", invoke)
    result = agent.submit(MISSION, project_id="p", project_path=str(root))
    assert result.outcome == "completed", result.summary
    records = ErrorKnowledge(root).all()
    assert records, "the quota failure should have been written down"
    quota = next(r for r in records if r["class"] == "quota")
    assert quota["worker"] == "claude-code" and quota["status"] == "resolved"
    assert "Retried on kilo-code" in quota["recovery"] and "verified after retry" in quota["evidence"]
    assert any(e.type == "error.recorded" and e.payload["status"] == "resolved" for e in agent.bus.tail)
    # and it reached Shared Context for later work
    assert any(i["kind"] == "error" for i in agent.shared_context.list("p"))


def test_a_failure_that_stays_failed_is_recorded_open_and_never_resolved(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    (root / "alpha").mkdir(parents=True)
    agent = _agent(tmp_path)
    invoke = quota_then_ok({"claude-code", "kilo-code"})  # every worker is out of quota
    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric", invoke)
    result = agent.submit(MISSION, project_id="p", project_path=str(root))
    assert result.outcome != "completed"
    records = ErrorKnowledge(root).all()
    assert records and all(r["status"] != "resolved" for r in records)
    assert all(r["resolution"] == "" and r["evidence"] == "" for r in records)  # nothing claimed fixed


def test_earlier_lessons_reach_the_next_workers_brief(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    (root / "alpha").mkdir(parents=True)
    (root / "alpha" / "a.txt").write_text("alpha A.\n")
    prior = ErrorKnowledge(root)
    made = prior.record(summary="inspect alpha a.txt failed: file locked", diagnostic="locked by editor")
    prior.resolve(made["id"], resolution="closed the editor first", evidence="re-read ok")
    agent = _agent(tmp_path)
    invoke = quota_then_ok(set())
    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric", invoke)
    agent.submit(MISSION, project_id="p", project_path=str(root))
    briefs = " ".join(c["context"] for c in invoke.calls)
    assert "KNOWN ISSUES FROM EARLIER WORK" in briefs and "closed the editor first" in briefs
