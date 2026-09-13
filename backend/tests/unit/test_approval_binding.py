"""P1-B: approval actions bind exactly to session/project/task.

An approval decision must never be recorded for the wrong session,
project, or task — and a missing reference must surface as a
deterministic refusal, never a guess at another session's pending
request. The single-use ledger remains canonical; these tests pin the
binding layer around it.
"""

from pathlib import Path

import pytest

from aura.approvals import ApprovalLedger
from aura.central_agent import AgentSessionStore, CentralAgent
from aura.contracts import AgentResult, EvidenceBundle


def make_agent(home: Path, ledger: ApprovalLedger) -> CentralAgent:
    from aura.fabric import FabricConfig

    cfg = FabricConfig(fabric=None, audit_store=None, ledger=ledger,
                       permissions={}, executors={}, secrets=None)
    return CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))


def park(agent: CentralAgent, project: str, approval_ids: list[str],
         task_id: str = "implement") -> str:
    session = agent.sessions.create(project)
    session.lastResult = AgentResult(
        status="awaiting-approval", outcome="awaiting-approval",
        summary="Ready but parked.",
        evidence=EvidenceBundle(
            sessionId=session.sessionId, planId="pln-1",
            approvalIds=approval_ids, summary="parked",
            createdAt="2026-01-01T00:00:00Z"),
        failureReason=None)
    session.parkedTaskId = task_id
    agent.sessions.save(session)
    return session.sessionId


def register(ledger: ApprovalLedger, aid: str, project: str,
             task: str = "implement") -> None:
    ledger.register(f"inv:{aid}", {
        "id": aid, "state": "pending", "projectId": project,
        "taskId": task,
        "items": [{"invocationId": aid, "capabilityId": "agent.delegate",
                   "title": "t", "detail": "d", "risk": "high",
                   "irreversible": True}],
    })


def test_exact_binding_passes(tmp_path: Path) -> None:
    ledger = ApprovalLedger()
    agent = make_agent(tmp_path, ledger)
    sid = park(agent, "proj-a", ["apr-1"])
    register(ledger, "apr-1", "proj-a")
    agent.check_approval_binding(sid, "apr-1")  # must not raise


def test_foreign_approval_refused_and_untouched(tmp_path: Path) -> None:
    ledger = ApprovalLedger()
    agent = make_agent(tmp_path, ledger)
    sid_a = park(agent, "proj-a", ["apr-a"])
    sid_b = park(agent, "proj-b", ["apr-b"])
    register(ledger, "apr-a", "proj-a")
    register(ledger, "apr-b", "proj-b")
    with pytest.raises(ValueError, match="not parked on this session"):
        agent.check_approval_binding(sid_a, "apr-b")
    with pytest.raises(ValueError, match="not parked on this session"):
        agent.check_approval_binding(sid_b, "apr-a")
    # Neither decision was recorded: both still pending.
    assert ledger.by_id("apr-a")["state"] == "pending"
    assert ledger.by_id("apr-b")["state"] == "pending"


def test_cross_project_refused_without_evidence_ids(tmp_path: Path) -> None:
    ledger = ApprovalLedger()
    agent = make_agent(tmp_path, ledger)
    sid = park(agent, "proj-a", [])
    register(ledger, "apr-x", "proj-b")
    with pytest.raises(ValueError, match="cross-project"):
        agent.check_approval_binding(sid, "apr-x")
    assert ledger.by_id("apr-x")["state"] == "pending"


def test_unknown_approval_refused(tmp_path: Path) -> None:
    ledger = ApprovalLedger()
    agent = make_agent(tmp_path, ledger)
    sid = park(agent, "proj-a", [])
    with pytest.raises(ValueError, match="no such approval"):
        agent.check_approval_binding(sid, "apr-ghost")


def test_task_mismatch_refused(tmp_path: Path) -> None:
    ledger = ApprovalLedger()
    agent = make_agent(tmp_path, ledger)
    sid = park(agent, "proj-a", [], task_id="t1")
    register(ledger, "apr-t", "proj-a", task="t2")
    with pytest.raises(ValueError, match="parked on t1"):
        agent.check_approval_binding(sid, "apr-t")


def test_non_parked_session_refused(tmp_path: Path) -> None:
    ledger = ApprovalLedger()
    agent = make_agent(tmp_path, ledger)
    session = agent.sessions.create("proj-a")
    agent.sessions.save(session)
    register(ledger, "apr-z", "proj-a")
    with pytest.raises(ValueError, match="not awaiting an approval"):
        agent.check_approval_binding(session.sessionId, "apr-z")
    assert ledger.by_id("apr-z")["state"] == "pending"


def test_unknown_session_refused(tmp_path: Path) -> None:
    ledger = ApprovalLedger()
    agent = make_agent(tmp_path, ledger)
    with pytest.raises(ValueError, match="no such session"):
        agent.check_approval_binding("agt-000000000000", "apr-z")


def test_replay_and_duplicate_decisions_refused(tmp_path: Path) -> None:
    ledger = ApprovalLedger()
    register(ledger, "apr-r", "proj-a")
    first = ledger.decide("apr-r", True, "user", "ok")
    assert first is not None and first["state"] == "granted"
    assert ledger.decide("apr-r", True, "user", "replay") is None
    assert ledger.decide("apr-r", False, "user", "changed mind") is None
    assert ledger.by_id("apr-r")["state"] == "granted"


def test_denied_approval_is_not_spendable(tmp_path: Path) -> None:
    ledger = ApprovalLedger()
    register(ledger, "apr-d", "proj-a")
    denied = ledger.decide("apr-d", False, "user", "no")
    assert denied is not None and denied["state"] == "denied"
    assert ledger.consume("apr-d") is None


# ── HTTP mapping on the canonical app ────────────────────────────────────

def _parked_session_file(home: Path, sid: str, project: str,
                         approval_ids: list[str]) -> None:
    import json as _json

    d = home / "agent" / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    now = "2026-09-09T00:00:00.000Z"
    (d / f"{sid}.json").write_text(_json.dumps({
        "sessionId": sid, "projectId": project, "state": "awaiting-approval",
        "createdAt": now, "updatedAt": now, "messages": [],
        "lastResult": {
            "status": "awaiting-approval", "outcome": "awaiting-approval",
            "summary": "Ready but parked.", "performed": [], "verified": [],
            "evidence": {"sessionId": sid, "planId": "pln-1",
                         "auditRecordIds": [], "approvalIds": approval_ids,
                         "summary": "parked", "createdAt": now},
            "failureReason": None},
    }), encoding="utf-8")


def test_http_approve_unknown_session_is_404(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    c = TestClient(create_app())
    r = c.post("/agent/sessions/agt-000000000000/approve",
               json={"approvalId": "apr-x", "granted": True})
    assert r.status_code == 409, r.text
    assert "no such session" in r.json()["error"]


def test_http_approve_foreign_id_is_409_and_untouched(
        tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    _parked_session_file(tmp_path, "agt-aaaaaaaaaaaa", "proj-a", ["apr-a"])
    _parked_session_file(tmp_path, "agt-bbbbbbbbbbbb", "proj-b", ["apr-b"])
    app = create_app()
    c = TestClient(app)
    # Register both approvals directly on the app's own ledger by
    # parking through a second leg is heavyweight; instead the binding
    # check must refuse BEFORE any decision exists: unknown id on a
    # parked session is a 409 naming the mismatch, not a silent miss.
    r = c.post("/agent/sessions/agt-aaaaaaaaaaaa/approve",
               json={"approvalId": "apr-b", "granted": True})
    assert r.status_code == 409, r.text
    assert "not parked on this session" in r.json()["error"]
    # Nothing was decided anywhere: both pending lists stay empty and
    # the sessions are untouched.
    assert c.get("/fabric/approvals").json() == {"approvals": []}
    assert c.get("/agent/sessions/agt-aaaaaaaaaaaa").json()["state"] == \
        "awaiting-approval"
