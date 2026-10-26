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
        assert seen["argv"][:2] == ["run", "--auto"]
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
    from aura.audit import AuditStore
    from aura.central_agent import AgentSessionStore, CentralAgent
    from aura.executors import all_executors
    from aura.fabric import CapabilityFabric, FabricConfig
    from aura.fabric.host import WiringHost

    audit = AuditStore(tmp_path / "audit" / "trail.jsonl")
    ledger = None

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
    execs = {e.capabilityId: e for e in all_executors(None)}
    cfg = FabricConfig(fabric=fabric, policy_config={},
                       permissions={"read": True, "write": True},
                       executors=execs, audit_store=audit)
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
