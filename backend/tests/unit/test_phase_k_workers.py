"""Phase K — real workers, honest connection, governed delegation.

The property under test throughout: AURA never claims more than it has
proved. A binary on PATH is not a connection, a reply is not a result, a
familiar flag is not an enforcement point, and a registry row a client
wrote is not evidence of anything.
"""

from __future__ import annotations

import json

import pytest

from aura.workers import (
    adapter_for_id,
    connect_worker,
    describe_workers,
    is_worker,
    matrix_rows,
)
from aura.workers.adapters import ADAPTERS, verified_invocations
from aura.workers.readiness import ReadinessProof, prove_worker


class _Out:
    """Minimal ProcessOutput stand-in for the runner seam."""

    def __init__(self, out="", code=0, timedOut=False, signal=None):
        self.out, self.code = out, code
        self.timedOut, self.signal = timedOut, signal


def _store(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    from aura.persistence.nodes import ConnectedNodeStore

    return ConnectedNodeStore()


# ── A. worker descriptors ────────────────────────────────────────────

class TestDescriptors:
    def test_six_workers_are_first_class_and_the_list_is_open(self):
        ids = [a.id for a in ADAPTERS]
        assert {"opencode", "claude-code", "kilo-code", "codex-cli",
                "gemini-cli", "qwen-cli"} <= set(ids)
        # Nothing caps the catalogue at six; adding a worker is adding a
        # row, and every consumer iterates.
        assert len(ids) == len(set(ids))

    def test_only_verified_shapes_are_dispatchable(self):
        table = verified_invocations()
        assert set(table) == {"opencode", "claude", "kilo"}
        for binary in ("codex", "gemini", "qwen"):
            assert binary not in table, (
                f"{binary} has no verified invocation and must not be "
                "dispatchable by default")

    def test_workers_are_not_tools(self):
        assert is_worker("opencode") and is_worker("kilo-code")
        assert not is_worker("git")
        assert not is_worker("github-cli")


# ── B. connection truth ──────────────────────────────────────────────

class TestConnectionTruth:
    def test_nothing_is_connected_without_a_proof(self, tmp_path,
                                                  monkeypatch):
        nodes = _store(tmp_path, monkeypatch)
        workers = describe_workers(nodes, probe=False)
        assert all(not w.connected for w in workers)
        assert all(w.governance == "NOT_CONNECTED" for w in workers)

    def test_a_registry_row_alone_never_connects_a_worker(
            self, tmp_path, monkeypatch):
        """The exact fake this phase exists to make impossible: a row in
        the connected-node registry claiming the capability."""
        nodes = _store(tmp_path, monkeypatch)
        nodes.register("opencode", "OpenCode", ["coding-agent"])
        worker = next(w for w in describe_workers(nodes, probe=False)
                      if w.id == "opencode")
        assert worker.connected is False

    def test_wire_registration_cannot_state_a_runtime_or_a_proof(
            self, tmp_path, monkeypatch):
        """POST /fabric/nodes reaches `register`, and `register` builds
        its record from scratch. A client cannot inject `binary` or a
        readiness proof, so it cannot make a worker dispatchable."""
        nodes = _store(tmp_path, monkeypatch)
        nodes.register("opencode", "OpenCode", ["coding-agent"])
        record = nodes.get("opencode")
        assert "binary" not in record
        assert "readiness" not in record

        from aura.executors import agent_delegate_supports_node

        assert agent_delegate_supports_node(record) is False

    def test_wire_registration_downgrades_a_proved_worker(
            self, tmp_path, monkeypatch):
        """Re-registering through the wire seam drops the proof rather
        than leaving a stale connection behind. Fail closed."""
        nodes = _store(tmp_path, monkeypatch)
        nodes.register_worker("opencode", "OpenCode", ["coding-agent"],
                              binary="opencode",
                              readiness={"proved": True})
        assert nodes.get("opencode")["binary"] == "opencode"
        nodes.register("opencode", "OpenCode", ["coding-agent"])
        assert "binary" not in nodes.get("opencode")

    def test_a_failed_proof_is_persisted_with_its_reason(
            self, tmp_path, monkeypatch):
        nodes = _store(tmp_path, monkeypatch)

        def failing(adapter, home):
            return ReadinessProof(
                worker_id=adapter.id, binary=adapter.binary, proved=False,
                reason="NO_RESPONSE",
                detail="ran and exited 1 without producing any output")

        descriptor, proof = connect_worker("opencode", nodes, str(tmp_path),
                                           prover=failing)
        assert proof["proved"] is False
        assert descriptor.connected is False
        assert descriptor.reason == "NO_RESPONSE"
        # and the runtime binding was NOT recorded
        assert "binary" not in nodes.get("opencode")

    def test_a_successful_proof_connects_and_makes_dispatch_possible(
            self, tmp_path, monkeypatch):
        nodes = _store(tmp_path, monkeypatch)

        def passing(adapter, home):
            return ReadinessProof(
                worker_id=adapter.id, binary=adapter.binary, proved=True,
                probe_id="rdy-1", governance="FULLY_GOVERNED",
                allowed_actions=1, actions_observed=1,
                detail="received a request and returned a correlated result")

        descriptor, proof = connect_worker("opencode", nodes, str(tmp_path),
                                           prover=passing)
        assert descriptor.connected is True
        assert descriptor.governance == "FULLY_GOVERNED"
        record = nodes.get("opencode")
        assert record["binary"] == "opencode"

        from aura.executors import agent_delegate_supports_node

        assert agent_delegate_supports_node(record) is True

    def test_unknown_worker_is_refused_not_invented(self, tmp_path,
                                                    monkeypatch):
        nodes = _store(tmp_path, monkeypatch)
        descriptor, proof = connect_worker("not-a-worker", nodes,
                                           str(tmp_path))
        assert descriptor is None
        assert proof["reason"] == "ADAPTER_UNKNOWN"


# ── C/D. the handshake itself ────────────────────────────────────────

def _probe_ok(monkeypatch):
    from aura.environment.probe import ProbeStatus

    class _R:
        present, version = True, "1.0.0"
        status, detail = ProbeStatus.VERIFIED, "found"

    monkeypatch.setattr("aura.environment.probe_node",
                        lambda *_a, **_k: _R())


class TestHandshake:
    def test_a_reply_without_correlated_work_is_not_a_connection(
            self, tmp_path, monkeypatch):
        """A runtime that answers but produces nothing AURA asked for has
        not proved it can be delegated to."""
        _probe_ok(monkeypatch)
        adapter = adapter_for_id("opencode")

        def runner(_a, _argv, _cwd, _env, _t):
            return _Out(out="DONE", code=0)   # says done, wrote nothing

        proof = prove_worker(adapter, str(tmp_path), runner=runner)
        assert proof.proved is False
        assert proof.reason == "RESPONSE_UNCORRELATED"
        assert "RESPONDED" in proof.stages
        assert "CORRELATED" not in proof.stages

    def test_silence_is_not_a_connection(self, tmp_path, monkeypatch):
        _probe_ok(monkeypatch)
        adapter = adapter_for_id("opencode")
        proof = prove_worker(adapter, str(tmp_path),
                             runner=lambda *_a: _Out(out="", code=0))
        assert proof.proved is False
        assert proof.reason == "NO_RESPONSE"

    def test_a_timeout_is_reported_as_a_timeout(self, tmp_path,
                                                monkeypatch):
        _probe_ok(monkeypatch)
        adapter = adapter_for_id("opencode")
        proof = prove_worker(
            adapter, str(tmp_path),
            runner=lambda *_a: _Out(out="…", code=124, timedOut=True))
        assert proof.proved is False
        assert proof.reason == "TIMEOUT"

    def test_correlated_work_proves_the_round_trip(self, tmp_path,
                                                  monkeypatch):
        """The nonce lives in the artefact the worker was asked to
        produce, so echoing the prompt cannot pass."""
        _probe_ok(monkeypatch)
        adapter = adapter_for_id("opencode")
        seen: dict = {}

        def runner(_a, argv, cwd, env, _t):
            seen["argv"], seen["cwd"], seen["env"] = argv, cwd, env
            import os
            import re

            nonce = re.search(r"AURA-READY-([0-9A-F]+)", " ".join(argv))
            os.makedirs(os.path.join(cwd, "work"), exist_ok=True)
            with open(os.path.join(cwd, "work", "aura-ready.txt"), "w") as fh:
                fh.write(f"AURA-READY-{nonce.group(1)}")
            return _Out(out="DONE", code=0)

        proof = prove_worker(adapter, str(tmp_path), runner=runner)
        assert proof.proved is True, proof.detail
        assert proof.reason == ""
        assert "CORRELATED" in proof.stages
        # It went through the REAL adapter shape and the REAL governance
        # bundle, not a side channel.
        assert seen["argv"][:2] == ["run", "--dir"]
        assert "OPENCODE_CONFIG" in seen["env"]

    def test_a_stale_nonce_cannot_satisfy_a_later_probe(
            self, tmp_path, monkeypatch):
        """A leftover artefact from an earlier probe must not count: the
        worktree is per-probe and the nonce is per-probe."""
        _probe_ok(monkeypatch)
        adapter = adapter_for_id("opencode")

        def runner(_a, _argv, cwd, _env, _t):
            import os

            os.makedirs(os.path.join(cwd, "work"), exist_ok=True)
            with open(os.path.join(cwd, "work", "aura-ready.txt"), "w") as fh:
                fh.write("AURA-READY-STALEVALUE")
            return _Out(out="DONE", code=0)

        proof = prove_worker(adapter, str(tmp_path), runner=runner)
        assert proof.proved is False
        assert proof.reason == "RESPONSE_UNCORRELATED"

    def test_governance_tier_reflects_what_was_observed(
            self, tmp_path, monkeypatch):
        """Staging governance is not the same as observing it work."""
        _probe_ok(monkeypatch)
        adapter = adapter_for_id("opencode")

        def runner(_a, argv, cwd, env, _t):
            import os
            import re

            nonce = re.search(r"AURA-READY-([0-9A-F]+)", " ".join(argv))
            os.makedirs(os.path.join(cwd, "work"), exist_ok=True)
            with open(os.path.join(cwd, "work", "aura-ready.txt"), "w") as fh:
                fh.write(f"AURA-READY-{nonce.group(1)}")
            return _Out(out="DONE", code=0)

        proof = prove_worker(adapter, str(tmp_path), runner=runner)
        # The fake worker mediated nothing through the plugin, so the
        # honest tier is "connected, not governed live".
        assert proof.proved is True
        assert proof.governance == "CONNECTED_FOR_BASIC_WORK"

    def test_a_runtime_with_no_interception_point_reports_unsupported(
            self, tmp_path, monkeypatch):
        _probe_ok(monkeypatch)
        adapter = adapter_for_id("codex-cli")

        def runner(_a, argv, cwd, env, _t):
            import os
            import re

            nonce = re.search(r"AURA-READY-([0-9A-F]+)", " ".join(argv))
            os.makedirs(os.path.join(cwd, "work"), exist_ok=True)
            with open(os.path.join(cwd, "work", "aura-ready.txt"), "w") as fh:
                fh.write(f"AURA-READY-{nonce.group(1)}")
            return _Out(out="DONE", code=0)

        proof = prove_worker(adapter, str(tmp_path), runner=runner)
        assert proof.proved is True
        assert proof.governance == "UNSUPPORTED"
        assert proof.governance_supports["FILE_WRITE"] == "unsupported"

    def test_a_missing_binary_is_not_installed_not_broken(
            self, tmp_path, monkeypatch):
        from aura.environment.probe import ProbeStatus

        class _R:
            present, version = False, ""
            status, detail = ProbeStatus.NOT_FOUND, "no such executable"

        monkeypatch.setattr("aura.environment.probe_node",
                            lambda *_a, **_k: _R())
        proof = prove_worker(adapter_for_id("gemini-cli"), str(tmp_path))
        assert proof.proved is False
        assert proof.reason == "NOT_INSTALLED"


# ── E/F. deterministic multi-worker planning ─────────────────────────

class TestDelegationPlanning:
    def test_implement_and_review_plans_two_workers_with_handoff(self):
        from aura.central_agent.intent import heuristic_interpret
        from aura.central_agent.planner import TaskPlanner

        intent = heuristic_interpret(
            "Implement token refresh in src/auth and have another AI "
            "review it")
        plan = TaskPlanner().plan(intent, "agt-1", "2026-09-08T00:00:00Z")

        assert [t.id for t in plan.tasks] == ["implement", "review"]
        assert [t.workerRole for t in plan.tasks] == ["code", "review"]
        # The reviewer consumes AURA's verified evidence, not the other
        # worker's context, and cannot start before it exists.
        review = plan.tasks[1]
        assert review.inputFrom == "upstream-output"
        assert review.dependsOn == ["implement"]
        # Both tasks carry the same task contract.
        assert plan.tasks[0].input["scopePaths"] == ["src/auth"]
        assert review.input["scopePaths"] == ["src/auth"]
        # Objective acceptance covers BOTH, so "implemented" alone is
        # never success.
        assert plan.acceptance[0].expect["tasks"] == ["implement", "review"]

    def test_a_single_implementation_plans_one_worker(self):
        from aura.central_agent.intent import heuristic_interpret
        from aura.central_agent.planner import TaskPlanner

        intent = heuristic_interpret("Implement a login endpoint under backend/api")
        plan = TaskPlanner().plan(intent, "agt-1", "2026-09-08T00:00:00Z")
        assert [t.id for t in plan.tasks] == ["implement"]
        assert plan.tasks[0].workerRole == "code"

    def test_a_guessed_scope_never_becomes_a_task_contract(self):
        from aura.central_agent.intent import heuristic_interpret
        from aura.central_agent.planner import TaskPlanner

        intent = heuristic_interpret("Implement retries in order to fix flakiness")
        plan = TaskPlanner().plan(intent, "agt-1", "2026-09-08T00:00:00Z")
        # "in order" is English, not a path.
        assert "scopePaths" not in plan.tasks[0].input

    def test_review_alone_never_plans_a_dispatch(self):
        from aura.central_agent.intent import heuristic_interpret

        intent = heuristic_interpret("review the code please")
        assert intent.requiredCapabilities == []
        assert intent.needsClarification is True


# ── E. worker selection fails closed ─────────────────────────────────

class TestSelection:
    def test_no_eligible_worker_fails_the_task_closed(self, tmp_path):
        from aura.central_agent.execution import ExecutionController
        from aura.central_agent.intent import heuristic_interpret
        from aura.central_agent.planner import TaskPlanner
        from aura.fabric import FabricConfig

        plan = TaskPlanner().plan(
            heuristic_interpret("Implement a login endpoint under backend/api"),
            "agt-1", "2026-09-08T00:00:00Z")

        class _Host:
            def present_nodes(self):
                return []                     # nothing connected

        cfg = FabricConfig(fabric=type("F", (), {"host": _Host()})())
        controller = ExecutionController(cfg, engine=None)
        result = controller.execute(plan, "p1")
        outcome = result.outcomes[0]
        assert outcome.state == "failed"
        assert outcome.performed is False
        assert "no connected worker satisfies role 'code'" in outcome.detail

    def test_a_worker_without_a_proved_runtime_is_not_eligible(self,
                                                               tmp_path):
        """A node that provides coding-agent but has no proved runtime
        binding must not be selected — it cannot actually be driven."""
        from aura.central_agent.worker_match import match_worker
        from aura.executors import agent_delegate_supports_node

        nodes = [{"id": "opencode", "name": "OpenCode",
                  "capabilities": ["coding-agent"]}]     # no binary
        assert match_worker("code", nodes,
                            agent_delegate_supports_node) is None


# ── R. the frontend is never the authority ───────────────────────────

class TestAuthority:
    def test_a_worker_binary_may_be_named_never_pathed(self, tmp_path,
                                                       monkeypatch):
        nodes = _store(tmp_path, monkeypatch)
        with pytest.raises(ValueError):
            nodes.register_worker("opencode", "OpenCode", ["coding-agent"],
                                  binary="../../usr/bin/evil",
                                  readiness={"proved": True})

    def test_matrix_never_reports_a_cell_it_did_not_measure(
            self, tmp_path, monkeypatch):
        nodes = _store(tmp_path, monkeypatch)
        rows = matrix_rows(describe_workers(nodes, probe=False))
        assert all(row["realResponse"] is False for row in rows)
        assert all(row["connected"] is False for row in rows)
        # The table is JSON-clean for the report, with no None cells.
        assert json.loads(json.dumps(rows)) == rows


# ── multi-leg resume: the path a real approval-gated run takes ────────

def _agent_with_two_workers(tmp_path):
    """The production shape: two proved workers, real ledger, real audit,
    heuristic intent (no model provider), single-invocation route."""
    from aura.approvals import ApprovalLedger
    from aura.audit import AuditStore
    from aura.central_agent import AgentSessionStore, CentralAgent
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
    fabric.attach_approval_store(lambda: [], lambda _r: None)
    fabric._ledger = ledger
    execs = {e.capabilityId: e for e in all_executors(None)}
    cfg = FabricConfig(fabric=fabric, policy_config={},
                       permissions={"read": True, "write": True},
                       executors=execs, audit_store=audit, ledger=ledger)
    agent = CentralAgent(fabric_cfg=cfg,
                         session_store=AgentSessionStore(tmp_path))
    agent.controller.engine = None
    return agent, ledger


def _park(ledger, apr_id):
    """Park the way the Fabric parks: a REAL pending request in the real
    ledger, so the human decision and the single-use spend that follow
    are the production ones."""
    ledger.register(f"inv:{apr_id}", {
        "id": apr_id, "state": "pending",
        "requestedAt": "2026-09-08T00:00:00.000Z",
        "summary": "worker dispatch", "rule": "risk",
        "items": [{"invocationId": f"inv-{apr_id}",
                   "capabilityId": "agent.delegate",
                   "title": "Delegate to coding agent", "detail": "",
                   "risk": "high", "irreversible": True,
                   "fingerprint": apr_id}],
    })
    return {"invocationId": f"inv-{apr_id}", "outcome": "awaiting-approval",
            "detail": "waiting", "approvalId": apr_id,
            "verification": {"passed": None, "kind": "exit-code",
                             "detail": ""},
            "policy": {"decision": "require-approval", "rule": "risk",
                       "risk": "high", "reason": ""},
            "at": "2026-09-08T00:00:00.000Z", "output": {}}


def _done(inv, node, stdout, deviation=None):
    output = {"stdout": stdout, "exitCode": 0, "nodeId": node,
              "agent": node, "scopePaths": ["src"],
              "scopeCheck": {"supported": True, "allowed": not deviation,
                             "changed": deviation or ["src/util.py"],
                             "outside": deviation or [], "detail": ""}}
    if deviation:
        output["scopeDeviation"] = True
    return {"invocationId": inv, "outcome": "succeeded",
            "detail": "done",
            "verification": {"passed": not deviation, "kind": "exit-code",
                             "detail": "exit 0"},
            "policy": {"decision": "require-approval", "rule": "risk",
                       "risk": "high", "reason": ""},
            "at": "2026-09-08T00:00:00.000Z", "output": output}


class TestApprovalGatedMultiWorkerRun:
    """agent.delegate always requires approval, so in production the real
    dispatch happens on a RESUMED leg. Everything the first leg does for
    a multi-task plan has to happen there too, or a two-worker run cannot
    get past its second approval."""

    def test_two_tasks_two_approvals_reach_completion(self, tmp_path,
                                                      monkeypatch):
        agent, ledger = _agent_with_two_workers(tmp_path)
        seen: list[dict] = []

        def fake_invoke(cap, payload, context, cfg):
            seen.append({"task": context.get("taskId"),
                         "node": context.get("nodeId"),
                         "approval": context.get("approvalId"),
                         "text": payload.get("task", "")})
            if not context.get("approvalId"):
                return _park(ledger, f"apr-{context['taskId']}-{len(seen)}")
            node = context.get("nodeId") or "opencode"
            return _done(f"inv-{context['taskId']}", node,
                         f"{context['taskId']} complete")

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)

        result = agent.submit(
            "Implement a multiply function in src/util.py under src and "
            "have another AI review it",
            project_id="p", project_path=str(tmp_path))
        sid = agent.sessions.last_session_id

        rounds = 0
        while result.outcome == "awaiting-approval" and rounds < 6:
            rounds += 1
            apr = result.evidence.approvalIds[0]
            assert ledger.decide(apr, True, "user", "ok") is not None, \
                f"approval {apr} was already decided — the grant was " \
                "spent on the wrong task"
            result = agent.resume(sid)

        assert result.outcome == "completed", result.summary
        # Both tasks ran, each after its OWN human decision.
        dispatched = [s for s in seen if s["approval"]]
        assert [s["task"] for s in dispatched] == ["implement", "review"]
        # …and by two DIFFERENT workers, which is what "another AI" means.
        assert dispatched[0]["node"] != dispatched[1]["node"]
        # The reviewer received AURA's verified evidence, not a paste.
        assert "AURA-VERIFIED-RESULT" in dispatched[1]["text"]
        assert "implement complete" in dispatched[1]["text"]

    def test_verified_work_is_never_re_executed_across_legs(
            self, tmp_path, monkeypatch):
        agent, ledger = _agent_with_two_workers(tmp_path)
        dispatches: list[str] = []

        def fake_invoke(cap, payload, context, cfg):
            if not context.get("approvalId"):
                return _park(ledger,
                             f"apr-{context['taskId']}-{len(dispatches)}")
            dispatches.append(context["taskId"])
            return _done(f"inv-{context['taskId']}",
                         context.get("nodeId") or "opencode", "ok")

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)
        result = agent.submit(
            "Implement a divide function in src/util.py under src and "
            "have another AI review it",
            project_id="p", project_path=str(tmp_path))
        sid = agent.sessions.last_session_id
        for _ in range(6):
            if result.outcome != "awaiting-approval":
                break
            ledger.decide(result.evidence.approvalIds[0], True, "user", "ok")
            result = agent.resume(sid)

        assert result.outcome == "completed", result.summary
        # Exactly one real dispatch per task: the settled side effects of
        # the first worker are never repeated by a later leg.
        assert dispatches == ["implement", "review"]

    def test_a_deviation_on_a_resumed_leg_enters_the_correction_loop(
            self, tmp_path, monkeypatch):
        """The deviation ALWAYS lands on a resumed leg in production.
        Ending the run as 'failed' there made the correction loop
        unreachable outside tests that skip the approval gate."""
        agent, ledger = _agent_with_two_workers(tmp_path)
        attempts: list[str] = []

        def fake_invoke(cap, payload, context, cfg):
            text = payload.get("task", "")
            if not context.get("approvalId"):
                return _park(ledger,
                             f"apr-{context['taskId']}-{len(attempts)}")
            attempts.append(context["taskId"])
            if text.startswith("CORRECTION"):
                return _done("inv-corrected", "opencode", "corrected")
            return _done("inv-deviated", "opencode", "wrote too much",
                         deviation=["rogue.txt"])

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)
        result = agent.submit(
            "Implement a modulo function in src/util.py under src",
            project_id="p", project_path=str(tmp_path))
        sid = agent.sessions.last_session_id
        ledger.decide(result.evidence.approvalIds[0], True, "user", "ok")
        result = agent.resume(sid)

        session = agent.sessions.load(sid)
        assert session.correctionChain, (
            "a governed deviation on a resumed leg must produce a "
            "correction record, not a bare failure")
        # The correction is a NEW question for the human: a granted
        # approval for the original attempt never authorises the retry.
        assert result.outcome == "awaiting-approval"
        assert any(a.startswith("implement-correction") or a == "implement"
                   for a in attempts)

    def test_a_correction_does_not_strand_the_rest_of_the_plan(
            self, tmp_path, monkeypatch):
        """After a correction verifies, the tasks that depend on the
        corrected one must still run. Rebuilding the remainder without
        the already-verified predecessor made the dependant name a task
        the plan no longer contained, which reads as a deadlock — a run
        that had corrected itself successfully then stranded."""
        agent, ledger = _agent_with_two_workers(tmp_path)
        dispatched: list[str] = []

        def fake_invoke(cap, payload, context, cfg):
            if not context.get("approvalId"):
                return _park(ledger,
                             f"apr-{context['taskId']}-{len(dispatched)}")
            tid = context["taskId"]
            dispatched.append(tid)
            text = payload.get("task", "")
            node = context.get("nodeId") or "opencode"
            if text.startswith("CORRECTION"):
                return _done("inv-corrected", node, "corrected in scope")
            if tid == "implement":
                return _done("inv-deviated", node, "wrote too much",
                             deviation=["rogue.txt"])
            return _done(f"inv-{tid}", node, f"{tid} complete")

        monkeypatch.setattr(
            "aura.central_agent.execution.invoke_fabric", fake_invoke)
        result = agent.submit(
            "Implement a power function in src/util.py under src and have "
            "another AI review it",
            project_id="p", project_path=str(tmp_path))
        sid = agent.sessions.last_session_id
        for _ in range(8):
            if result.outcome != "awaiting-approval":
                break
            ledger.decide(result.evidence.approvalIds[0], True, "user", "ok")
            result = agent.resume(sid)

        assert result.outcome == "completed", result.summary
        assert "review" in dispatched, (
            "the reviewing worker never ran after the correction")
        session = agent.sessions.load(sid)
        assert session.correctionChain, "no correction was recorded"


# ── Phase K security surfaces ────────────────────────────────────────

class TestGovernanceCannotBeSpoofed:
    def test_a_registry_claim_never_changes_what_is_enforced(
            self, tmp_path, monkeypatch):
        """A record could claim any governance tier. What is actually
        staged comes from the ADAPTER — the code that was verified
        against the runtime — so a record cannot talk AURA into
        enforcing more, or less, than it can."""
        import aura.executors as ex

        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        node = {"id": "codex-cli", "name": "Codex CLI",
                "readiness": {"proved": True,
                              "governance": "FULLY_GOVERNED",
                              "governanceSupports": {"FILE_WRITE": "preflight"}}}
        bundle = ex._stage_governance(
            {"id": "inv-1", "context": {"taskId": "t1"}, "node": node},
            "codex", "/repo", "do it", ["src"])
        assert bundle["logPath"] == ""
        assert bundle["env"] == {}

    def test_an_action_from_another_invocation_is_not_counted(
            self, tmp_path, monkeypatch):
        """Governance evidence is per-invocation. A log line carrying a
        different invocation id — a stale run, or another worker writing
        to the same path — must not be read as this probe's proof."""
        _probe_ok(monkeypatch)
        adapter = adapter_for_id("opencode")

        def runner(_a, argv, cwd, env, _t):
            import json
            import os
            import re

            nonce = re.search(r"AURA-READY-([0-9A-F]+)", " ".join(argv))
            os.makedirs(os.path.join(cwd, "work"), exist_ok=True)
            with open(os.path.join(cwd, "work", "aura-ready.txt"), "w") as fh:
                fh.write(f"AURA-READY-{nonce.group(1)}")
            with open(env["AURA_ACTION_LOG"], "a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "invocationId": "inv-somebody-else",
                    "actionType": "FILE_WRITE", "tool": "write",
                    "decision": "ALLOW", "target": "x"}) + "\n")
            return _Out(out="DONE", code=0)

        proof = prove_worker(adapter, str(tmp_path), runner=runner)
        assert proof.proved is True
        assert proof.actions_observed == 0
        assert proof.governance == "CONNECTED_FOR_BASIC_WORK"


class TestWorkerIdentity:
    def test_a_dispatch_never_reuses_another_worker_for_a_review(self):
        """The exclusion is identity-based, so a second worker that
        merely looks similar is still a second worker, and the SAME
        worker is barred however it is described."""
        from aura.central_agent.worker_match import match_worker

        nodes = [
            {"id": "opencode", "name": "OpenCode",
             "capabilities": ["coding-agent"]},
            {"id": "claude-code", "name": "Claude Code",
             "capabilities": ["coding-agent"]},
        ]
        picked = match_worker("review", nodes, exclude={"opencode"})
        assert picked["id"] == "claude-code"
        assert match_worker("review", nodes,
                            exclude={"opencode", "claude-code"}) is None


class TestGovernanceMatrixIsHonest:
    def test_claude_does_not_claim_preflight_for_reads(self):
        """The PreToolUse matcher is Edit|Write, so a read never reaches
        the hook. Observed live: a governed review task read files and
        produced zero action events. Reads ARE bounded (--add-dir), but
        that is confinement, not mediation, and the matrix says so."""
        from aura.governance import claude

        assert claude.SUPPORTS["FILE_READ"] == "confinement"
        assert claude.SUPPORTS["FILE_WRITE"] == "preflight"
        # No Bash tool is granted, so these cannot happen at all — a
        # different fact from "AURA cannot govern them".
        for action in ("COMMAND", "PROCESS_SPAWN", "NETWORK",
                       "FILE_DELETE"):
            assert claude.SUPPORTS[action] == "not-granted"

    def test_the_matrix_has_exactly_one_definition(self):
        """The adapter reports what the governance module enforces. Two
        copies would drift, and the drifting one is what the UI shows."""
        from aura.governance import claude, opencode

        assert adapter_for_id("claude-code").supports == claude.SUPPORTS
        assert adapter_for_id("opencode").supports == opencode.SUPPORTS
        assert adapter_for_id("kilo-code").supports == opencode.SUPPORTS

    def test_network_is_never_claimed_by_any_worker(self):
        """No runtime here exposes a reliable network interception
        point. Claiming one would be the most dangerous kind of false
        confidence, so it is asserted rather than assumed."""
        for adapter in ADAPTERS:
            assert adapter.supports["NETWORK"] in (
                "unsupported", "not-granted"), adapter.id


# ── N. persistence / recovery across a restart ───────────────────────

class TestApprovalSurvivesARestart:
    """A human decision taken after AURA restarts has to authorise the
    call it was taken for. The fabric and the ledger both restore
    approvals from the same file but parse their own dicts, so before
    this was fixed the grant landed on one copy while the other — the
    one that actually gates execution — stayed pending, and the call was
    refused as if the action had changed."""

    @staticmethod
    def _stack(home):
        from aura.approvals import ApprovalLedger, usable_pending
        from aura.audit import AuditStore
        from aura.fabric import CapabilityFabric, FabricConfig
        from aura.fabric.host import WiringHost
        from aura.jsonutil import read_json_file, write_json_atomic

        ap_file = home / "fabric-approvals.json"

        def load():
            return [r for r in read_json_file(ap_file, [])
                    if usable_pending(r)]

        def save(reqs):
            write_json_atomic(ap_file, reqs)

        audit = AuditStore(home / "audit" / "trail.jsonl")
        ledger = ApprovalLedger(audit_append=audit.append)
        ledger.attach_store(load, save)

        class _Nodes:
            def list_nodes(self):
                return [{"id": "opencode", "name": "OpenCode",
                         "binary": "opencode",
                         "capabilities": ["coding-agent", "terminal"]}]

        fabric = CapabilityFabric(WiringHost(_Nodes()))
        fabric.attach_approval_store(load, save)
        fabric.attach_audit_store(audit.load, audit.append)
        fabric.use_ledger(ledger)

        ran: list[dict] = []

        class _Exec:
            capabilityId = "agent.delegate"

            def supportsNode(self, _node):
                return True

            async def run(self, invocation):
                ran.append(dict(invocation.get("context") or {}))
                return {"ok": True, "detail": "done",
                        "output": {"stdout": "ok", "exitCode": 0}}

            async def verify(self, _inv, _res):
                return {"passed": True, "kind": "exit-code", "detail": "0"}

        fabric.executors["agent.delegate"] = _Exec()
        cfg = FabricConfig(fabric=fabric, audit_store=audit, ledger=ledger,
                           permissions={"read": True, "write": True})
        return cfg, ledger, ran

    def test_a_grant_taken_after_a_restart_authorises_the_call(
            self, tmp_path, monkeypatch):
        from aura.fabric import invoke_fabric

        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        payload = {"task": "do the thing", "scopePaths": ["src"]}
        context = {"actor": {"kind": "agent", "id": "central-agent"},
                   "projectId": "p", "taskId": "t1", "cwd": str(tmp_path)}

        cfg, _ledger, _ran = self._stack(tmp_path)
        parked = invoke_fabric("agent.delegate", payload, dict(context), cfg)
        assert parked["outcome"] == "awaiting-approval"
        approval_id = parked["approvalId"]

        # RESTART: everything is rebuilt from the files on disk.
        cfg2, ledger2, ran2 = self._stack(tmp_path)
        assert ledger2.decide(approval_id, True, "user", "ok") is not None

        spent = invoke_fabric(
            "agent.delegate", payload,
            {**context, "approvalId": approval_id}, cfg2)
        assert spent["outcome"] == "succeeded", spent["detail"]
        assert len(ran2) == 1

    def test_the_refusal_reason_distinguishes_the_three_causes(self):
        """The user-facing sentence is frozen by the TS oracle and says
        "the action or its arguments changed" for every cause. That
        collapse is what hid the restart bug: a grant recorded on a
        different copy of the record read exactly like a changed action.
        The diagnostic reason keeps the three apart, so the next such
        failure is legible even though the wire text cannot change."""
        from aura.fabric import _named_refusal

        assert "no longer exists" in _named_refusal(None, False)
        assert "different action" in _named_refusal(
            {"state": "granted"}, False)
        assert "not been decided" in _named_refusal(
            {"state": "pending"}, True)
        assert "already spent" in _named_refusal(
            {"state": "granted", "consumedAt": "now"}, True)
        assert "declined" in _named_refusal({"state": "denied"}, True)

    def test_a_replay_is_still_refused_after_a_restart(self, tmp_path,
                                                       monkeypatch):
        """Single-use survives the restart too: adopting the ledger must
        share the record, not resurrect a spent grant."""
        from aura.fabric import invoke_fabric

        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        payload = {"task": "do the thing", "scopePaths": ["src"]}
        context = {"actor": {"kind": "agent", "id": "central-agent"},
                   "projectId": "p", "taskId": "t1", "cwd": str(tmp_path)}
        cfg, ledger, _ = self._stack(tmp_path)
        approval_id = invoke_fabric(
            "agent.delegate", payload, dict(context), cfg)["approvalId"]

        cfg2, ledger2, ran2 = self._stack(tmp_path)
        ledger2.decide(approval_id, True, "user", "ok")
        assert invoke_fabric(
            "agent.delegate", payload,
            {**context, "approvalId": approval_id},
            cfg2)["outcome"] == "succeeded"

        cfg3, _l3, ran3 = self._stack(tmp_path)
        replay = invoke_fabric("agent.delegate", payload,
                               {**context, "approvalId": approval_id}, cfg3)
        assert replay["outcome"] == "awaiting-approval"
        assert ran3 == [], "a spent grant must not run anything again"
