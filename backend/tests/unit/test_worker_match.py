"""Phase G — worker requirement matching ("a suitable worker").

Pure matching plus controller integration: roles narrow routing to
eligible, usable workers; unsatisfiable roles fail closed before any
dispatch; explicit nodeId keeps working and is role-checked.
"""

from __future__ import annotations

import pytest

from aura.central_agent.planner import PlanningError, TaskPlanner
from aura.central_agent.worker_match import (
    match_worker,
    node_satisfies_role,
    required_node_capability,
)
from aura.contracts import AgentIntent, TaskPlan, TaskSpecification


def _nodes():
    return [
        {"id": "codex", "name": "Codex",
         "capabilities": ["coding-agent"]},
        {"id": "opencode", "name": "OpenCode",
         "capabilities": ["coding-agent", "terminal"]},
    ]


def _intent():
    return AgentIntent(goal="g", expectedOutcome="o")


# ── pure matching ─────────────────────────────────────────────────────

class TestMatchWorker:
    def test_code_selects_first_coding_agent(self):
        assert match_worker("code", _nodes())["id"] == "codex"

    def test_execute_requires_terminal(self):
        assert match_worker("execute", _nodes())["id"] == "opencode"

    def test_review_uses_coding_agent(self):
        assert match_worker("review", _nodes())["id"] == "codex"

    def test_no_eligible_returns_none(self):
        assert match_worker("execute", [_nodes()[0]]) is None
        assert match_worker("nonsense", _nodes()) is None

    def test_usability_filters(self):
        node = match_worker("code", _nodes(),
                            usable=lambda n: n["id"] == "opencode")
        assert node["id"] == "opencode"
        assert match_worker("code", _nodes(),
                            usable=lambda n: False) is None

    def test_role_capability_map(self):
        assert required_node_capability("code") == "coding-agent"
        assert required_node_capability("execute") == "terminal"
        assert required_node_capability("nope") is None

    def test_node_satisfies_role(self):
        assert node_satisfies_role(_nodes()[1], "execute") is True
        assert node_satisfies_role(_nodes()[0], "execute") is False
        assert node_satisfies_role(_nodes()[0], "code") is True


# ── controller integration ────────────────────────────────────────────

class _Host:
    def __init__(self, nodes):
        self._nodes = nodes

    def present_nodes(self):
        return list(self._nodes)


class _Fabric:
    def __init__(self, nodes):
        self.host = _Host(nodes)


class _Cfg:
    def __init__(self, nodes, usable=None):
        self.fabric = _Fabric(nodes)

        class _Exe:
            @staticmethod
            def supportsNode(node):
                return usable(node) if usable else True

        self.executors = {"agent.delegate": _Exe()}


def _controller(nodes, usable=None):
    from aura.central_agent.execution import ExecutionController

    controller = ExecutionController.__new__(ExecutionController)
    controller._cfg = _Cfg(nodes, usable)
    controller.engine = None
    return controller


def _ok(monkeypatch, seen):
    def fake_invoke(capability_id, payload, context, cfg):
        seen.append((capability_id, dict(payload), dict(context)))
        return {"invocationId": "inv-1", "outcome": "succeeded",
                "detail": "done",
                "verification": {"passed": True, "kind": "exit-code",
                                 "detail": ""},
                "policy": {"decision": "auto-execute", "rule": "x",
                           "risk": "low", "reason": ""},
                "at": "now",
                "output": {"stdout": "ok", "exitCode": 0}}

    monkeypatch.setattr("aura.central_agent.execution.invoke_fabric",
                        fake_invoke)


def _plan(task):
    return TaskPlan(planId="pln-g", sessionId="ses-g", intent=_intent(),
                    tasks=[task], createdAt="now")


def _task(**kw):
    base = dict(id="t1", description="work", capabilityId="agent.delegate",
                input={"task": "do it"})
    base.update(kw)
    return TaskSpecification(**base)


class TestControllerMatching:
    def test_role_resolves_to_eligible_node(self, monkeypatch):
        seen = []
        _ok(monkeypatch, seen)
        result = _controller(_nodes()).execute(
            _plan(_task(workerRole="execute")), project_id="p")
        assert result.outcomes[0].state == "done"
        assert seen[0][2]["nodeId"] == "opencode"

    def test_no_role_keeps_default_routing(self, monkeypatch):
        seen = []
        _ok(monkeypatch, seen)
        result = _controller(_nodes()).execute(
            _plan(_task()), project_id="p")
        assert result.outcomes[0].state == "done"
        assert "nodeId" not in seen[0][2]

    def test_unsatisfiable_role_fails_without_dispatch(
            self, monkeypatch):
        seen = []
        _ok(monkeypatch, seen)
        result = _controller([_nodes()[0]]).execute(
            _plan(_task(workerRole="execute")), project_id="p")
        assert seen == []
        assert result.outcomes[0].state == "failed"
        assert result.outcomes[0].performed is False
        assert "execute" in result.outcomes[0].detail

    def test_unusable_eligible_node_fails_closed(self, monkeypatch):
        seen = []
        _ok(monkeypatch, seen)
        result = _controller(
            _nodes(), usable=lambda n: False).execute(
            _plan(_task(workerRole="code")), project_id="p")
        assert seen == []
        assert result.outcomes[0].state == "failed"

    def test_pinned_node_role_mismatch_fails(self, monkeypatch):
        seen = []
        _ok(monkeypatch, seen)
        result = _controller(_nodes()).execute(
            _plan(_task(nodeId="codex", workerRole="execute")),
            project_id="p")
        assert seen == []
        assert result.outcomes[0].state == "failed"

    def test_pinned_node_role_consistent_used(self, monkeypatch):
        seen = []
        _ok(monkeypatch, seen)
        result = _controller(_nodes()).execute(
            _plan(_task(nodeId="codex", workerRole="code")),
            project_id="p")
        assert result.outcomes[0].state == "done"
        assert seen[0][2]["nodeId"] == "codex"


# ── model proposal surface ────────────────────────────────────────────

class TestProposalRole:
    def _planner(self):
        return TaskPlanner(
            known_capabilities=lambda: {"agent.delegate"},
            known_nodes=lambda: {"opencode"})

    def test_role_accepted(self):
        plan = self._planner().plan_from_model(_intent(), "s", "now", {
            "tasks": [{"description": "review it",
                       "capabilityId": "agent.delegate",
                       "input": {"task": "review"},
                       "workerRole": "review",
                       "verificationKind": "exit-code",
                       "verification": "exit 0"}]})
        assert plan.tasks[0].workerRole == "review"

    def test_unknown_role_rejected(self):
        with pytest.raises(PlanningError, match="worker role"):
            self._planner().plan_from_model(_intent(), "s", "now", {
                "tasks": [{"description": "x",
                           "capabilityId": "agent.delegate",
                           "input": {"task": "x"},
                           "workerRole": " cheapest ",
                           "verificationKind": "exit-code",
                           "verification": "exit 0"}]})
