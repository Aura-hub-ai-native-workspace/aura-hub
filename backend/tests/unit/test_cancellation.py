"""Cancellation: a real stop, a terminal answer, and no way back in.

STOP is an authority decision. These tests are mostly about what must
NOT happen after one — the run must not correct itself, must not retry,
must not be resurrected by an approval that was pending, and must never
end up reported as success.
"""

from __future__ import annotations

import threading
import time

from aura.central_agent.runcontrol import RunControl

# ── the signal itself ────────────────────────────────────────────────

class TestCancellationToken:
    def test_the_second_stop_is_the_same_answer_as_the_first(self):
        control = RunControl()
        first = control.request_cancel("agt-1", "stop")
        second = control.request_cancel("agt-1", "stop again")
        assert first["firstRequest"] is True
        assert second["firstRequest"] is False
        # The record keeps the FIRST decision, not the latest click.
        assert second["reason"] == "stop"
        assert second["requestedAt"] == first["requestedAt"]

    def test_a_stop_before_the_run_starts_is_seen_by_the_run(self):
        """STOP can arrive in the gap between submit and dispatch."""
        control = RunControl()
        control.request_cancel("agt-1")
        assert control.begin("agt-1").cancelled is True

    def test_a_normal_run_ending_drops_its_token(self):
        control = RunControl()
        control.begin("agt-1")
        control.clear("agt-1")
        assert control.token_for("agt-1") is None

    def test_a_cancelled_token_is_not_dropped_by_the_normal_path(self):
        """Nothing in the ordinary end-of-run path may clear a stop."""
        control = RunControl()
        control.request_cancel("agt-1")
        control.clear("agt-1")
        assert control.is_cancelled("agt-1") is True
        control.release("agt-1")          # only an explicit resume
        assert control.is_cancelled("agt-1") is False

    def test_the_signal_crosses_threads(self):
        """The request arrives on the API thread; the worker waits on an
        executor thread. If it did not cross, STOP would do nothing."""
        control = RunControl()
        token = control.begin("agt-1")
        seen = threading.Event()

        def worker():
            if token.wait(5):
                seen.set()

        t = threading.Thread(target=worker)
        t.start()
        time.sleep(0.05)
        control.request_cancel("agt-1")
        t.join(5)
        assert seen.is_set()

    def test_the_record_names_what_was_in_flight(self):
        control = RunControl()
        token = control.begin("agt-1")
        token.note_dispatch("implement", worker_node_id="opencode")
        record = control.request_cancel("agt-1", "user pressed stop")
        assert record["taskId"] == "implement"
        assert record["workerNodeId"] == "opencode"

    def test_a_dispatch_after_the_stop_cannot_rewrite_the_record(self):
        control = RunControl()
        token = control.begin("agt-1")
        token.note_dispatch("implement", worker_node_id="opencode")
        control.request_cancel("agt-1")
        token.note_dispatch("review", worker_node_id="claude-code")
        assert token.snapshot()["taskId"] == "implement"


# ── the run ──────────────────────────────────────────────────────────

def _ok(inv, node, stdout="done"):
    return {"invocationId": inv, "outcome": "succeeded", "detail": "done",
            "verification": {"passed": True, "kind": "exit-code",
                             "detail": "exit 0"},
            "policy": {"decision": "auto-execute", "rule": "r",
                       "risk": "high", "reason": ""},
            "at": "2026-09-08T00:00:00Z",
            "output": {"stdout": stdout, "exitCode": 0, "nodeId": node,
                       "agent": node, "scopePaths": ["src"],
                       "scopeCheck": {"supported": True, "allowed": True,
                                      "changed": ["src/util.py"],
                                      "outside": [], "detail": ""}}}


def _stopped(inv, node):
    """What the executor returns for a worker the token terminated."""
    return {"invocationId": inv, "outcome": "failed",
            "detail": "stopped by cancellation",
            "verification": {"passed": None, "kind": "exit-code",
                             "detail": ""},
            "policy": {"decision": "auto-execute", "rule": "r",
                       "risk": "high", "reason": ""},
            "at": "2026-09-08T00:00:00Z",
            "output": {"stdout": "partial", "exitCode": 143, "nodeId": node,
                       "agent": node, "cancelled": True}}


def _agent(tmp_path):
    from aura.approvals import ApprovalLedger
    from aura.audit import AuditStore
    from aura.central_agent import AgentSessionStore, CentralAgent
    from aura.central_agent.runcontrol import RunControl
    from aura.executors import all_executors
    from aura.fabric import CapabilityFabric, FabricConfig
    from aura.fabric.host import WiringHost

    audit = AuditStore(tmp_path / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)

    class _Nodes:
        def list_nodes(self):
            return [
                {"id": "opencode", "name": "OpenCode", "binary": "opencode",
                 "capabilities": ["coding-agent", "terminal"]},
                {"id": "claude-code", "name": "Claude Code",
                 "binary": "claude", "capabilities": ["coding-agent"]},
            ]

    fabric = CapabilityFabric(WiringHost(_Nodes()))
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.use_ledger(ledger)
    cfg = FabricConfig(fabric=fabric, audit_store=audit, ledger=ledger,
                       permissions={"read": True, "write": True},
                       executors={e.capabilityId: e
                                  for e in all_executors(None)})
    agent = CentralAgent(fabric_cfg=cfg,
                         session_store=AgentSessionStore(tmp_path))
    agent.controller.engine = None
    agent.runs = RunControl()          # isolated from other tests
    return agent


class TestCancellingARun:
    MULTI = ("Implement auth in src and have another AI review it")

    def test_a_stop_mid_flight_ends_the_run_as_cancelled(
            self, tmp_path, monkeypatch):
        agent = _agent(tmp_path)
        seen: list[str] = []

        def fake_invoke(cap, payload, context, cfg):
            tid = context["taskId"]
            seen.append(tid)
            token = context.get("cancelToken")
            if tid == "implement":
                # The user stops while this worker is running.
                token.request("user pressed stop")
                return _stopped("inv-1", "opencode")
            return _ok(f"inv-{tid}", "claude-code")

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)
        result = agent.submit(self.MULTI, project_id="p",
                              project_path=str(tmp_path))
        assert result.outcome == "cancelled"
        assert result.status == "cancelled"
        # The downstream worker never ran.
        assert seen == ["implement"]

    def test_a_cancelled_run_never_reports_success(self, tmp_path,
                                                   monkeypatch):
        """Invariant 1. The whole point of the feature."""
        agent = _agent(tmp_path)

        def fake_invoke(cap, payload, context, cfg):
            context["cancelToken"].request("stop")
            return _stopped("inv-1", "opencode")

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)
        result = agent.submit(self.MULTI, project_id="p",
                              project_path=str(tmp_path))
        assert result.outcome == "cancelled"
        assert "completed" not in result.summary.lower()
        assert result.verified == []

    def test_a_worker_that_finishes_as_the_stop_lands_is_still_cancelled(
            self, tmp_path, monkeypatch):
        """Race A. The user's decision outranks the exit code."""
        agent = _agent(tmp_path)

        def fake_invoke(cap, payload, context, cfg):
            context["cancelToken"].request("stop")
            return _ok("inv-1", "opencode")      # succeeded anyway

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)
        result = agent.submit("Add a multiply function in src",
                              project_id="p", project_path=str(tmp_path))
        assert result.outcome == "cancelled"

    def test_a_stop_before_dispatch_starts_nothing(self, tmp_path,
                                                   monkeypatch):
        """Race K."""
        agent = _agent(tmp_path)
        dispatched: list[str] = []

        def fake_invoke(cap, payload, context, cfg):
            dispatched.append(context["taskId"])
            return _ok("inv-1", "opencode")

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)
        session = agent.sessions.create("p")
        agent.sessions.save(session)
        agent.runs.request_cancel(session.sessionId, "stopped early")
        result = agent.submit("Add a multiply function in src",
                              session=session, project_path=str(tmp_path))
        assert result.outcome == "cancelled"
        assert dispatched == []

    def test_a_cancelled_run_is_not_corrected(self, tmp_path, monkeypatch):
        """Invariant 10. A terminated worker looks exactly like a worker
        that deviated and died; correcting it would restart the work the
        user just stopped."""
        agent = _agent(tmp_path)
        attempts: list[str] = []

        def fake_invoke(cap, payload, context, cfg):
            attempts.append(payload.get("task", "")[:20])
            context["cancelToken"].request("stop")
            out = _stopped("inv-1", "opencode")
            out["output"]["scopeDeviation"] = True
            out["output"]["scopeCheck"] = {
                "supported": True, "allowed": False, "changed": ["rogue.txt"],
                "outside": ["rogue.txt"], "detail": "outside scope"}
            return out

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)
        result = agent.submit("Add a multiply function in src",
                              project_id="p", project_path=str(tmp_path))
        assert result.outcome == "cancelled"
        assert len(attempts) == 1, "a correction was dispatched anyway"
        assert agent.sessions.load(
            agent.sessions.last_session_id).correctionChain == []


class TestCancellationIsTerminal:
    def _park_then_cancel(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path)

        def fake_invoke(cap, payload, context, cfg):
            ledger = agent.fabric_cfg.ledger
            ledger.register("inv:apr-1", {
                "id": "apr-1", "state": "pending",
                "requestedAt": "2026-09-08T00:00:00Z", "summary": "run it",
                "rule": "risk", "items": [{
                    "invocationId": "inv-1",
                    "capabilityId": "agent.delegate", "title": "Delegate",
                    "detail": "", "risk": "high", "irreversible": True,
                    "fingerprint": "fp"}]})
            return {"invocationId": "inv-1", "outcome": "awaiting-approval",
                    "detail": "waiting", "approvalId": "apr-1",
                    "verification": {"passed": None, "kind": "exit-code",
                                     "detail": ""},
                    "policy": {"decision": "require-approval", "rule": "risk",
                               "risk": "high", "reason": ""},
                    "at": "2026-09-08T00:00:00Z", "output": {}}

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)
        result = agent.submit("Add a multiply function in src",
                              project_id="p", project_path=str(tmp_path))
        assert result.outcome == "awaiting-approval"
        sid = agent.sessions.last_session_id
        agent.request_cancel(sid, "stop while parked")
        return agent, sid

    def test_a_stop_while_parked_invalidates_the_approval(
            self, tmp_path, monkeypatch):
        """Race F + invariant 3: a grant decided after the stop must not
        be spendable, or the run comes back from the dead holding an
        authorisation nobody wants."""
        agent, sid = self._park_then_cancel(tmp_path, monkeypatch)
        request = agent.fabric_cfg.ledger.by_id("apr-1")
        assert request["state"] == "denied"
        assert "cancel" in (request.get("decidedBy") or "").lower()

    def test_a_stale_approval_cannot_resurrect_a_cancelled_run(
            self, tmp_path, monkeypatch):
        agent, sid = self._park_then_cancel(tmp_path, monkeypatch)
        result = agent.resume(sid)
        assert result.outcome == "cancelled"

    def test_the_stop_survives_a_restart(self, tmp_path, monkeypatch):
        """A brand-new agent over the same store comes back cancelled and
        does NOT continue on its own."""
        agent, sid = self._park_then_cancel(tmp_path, monkeypatch)
        fresh = _agent(tmp_path)
        session = fresh.sessions.load(sid)
        assert session.cancellation is not None
        assert session.cancellation["cancelled"] is True
        assert fresh.resume(sid).outcome == "cancelled"

    def test_recovery_is_explicit_and_makes_a_new_attempt(
            self, tmp_path, monkeypatch):
        agent, sid = self._park_then_cancel(tmp_path, monkeypatch)
        dispatched: list[dict] = []

        def fake_invoke(cap, payload, context, cfg):
            dispatched.append(dict(context))
            return _ok("inv-2", "opencode")

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)
        result = agent.resume(sid, resume_cancelled=True)
        assert result.outcome == "completed", result.summary
        # A NEW attempt: it does not carry the grant the cancellation
        # invalidated, so the work is re-authorised rather than replayed.
        assert dispatched and dispatched[0].get("approvalId") is None
        session = agent.sessions.load(sid)
        assert session.cancellation.get("resumedAt")
