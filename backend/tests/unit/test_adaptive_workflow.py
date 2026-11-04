"""The workflow engine is for work that benefits from it — and only then.

Simple questions, chat, and direct tasks never reach it. A plan's own shape
(dependency depth, conditional steps, tool prerequisites, many coordinated
tasks) decides, and the report names the path that really ran.
"""

from __future__ import annotations

import pytest

from aura.central_agent.service import CentralAgent
from aura.contracts.agent import AgentIntent, TaskPlan, TaskSpecification
from test_stopped_mission_view import _agent


def plan(tasks, acceptance=None):
    return TaskPlan(planId="plan-w", sessionId="agt-aaaaaaaaaaaa",
                    intent=AgentIntent(goal="g", expectedOutcome="e"), tasks=tasks,
                    createdAt="2026-10-20T00:00:00Z", acceptance=acceptance or [])


def t(tid, deps=(), **extra):
    return TaskSpecification(id=tid, description=tid, capabilityId="agent.delegate", dependsOn=list(deps), **extra)


def test_simple_plans_are_not_workflow_work():
    assert CentralAgent.workflow_assessment(plan([t("t1")])) == {
        "worthy": False, "reasons": [], "path": "single-step", "tasks": 1}
    assert not CentralAgent.workflow_assessment(plan([t("t1"), t("t2")]))["worthy"]  # independent tasks
    assert not CentralAgent.workflow_assessment(plan([t("t1"), t("t2", ["t1"])]))["worthy"]  # a short chain


def test_a_deep_chain_conditions_prerequisites_or_many_coordinated_tasks_are_worthy():
    deep = CentralAgent.workflow_assessment(plan([t("t1"), t("t2", ["t1"]), t("t3", ["t2"])]))
    assert deep["worthy"] and deep["path"] == "structured" and "3 tasks deep" in deep["reasons"][0]
    cond = CentralAgent.workflow_assessment(plan([t("t1"), t("t2", ["t1"], runWhen="upstream-reports-findings")]))
    assert cond["worthy"] and "conditional" in cond["reasons"][0]
    tools = CentralAgent.workflow_assessment(plan([t("t1", requiresTools=["pnpm"])]))
    assert tools["worthy"] and "prerequisites" in tools["reasons"][0]
    many = CentralAgent.workflow_assessment(plan([t("a"), t("b"), t("c", ["a"]), t("d", ["b"])]))
    assert many["worthy"] and "4 coordinated" in many["reasons"][0]


def test_only_an_explicit_saved_workflow_run_is_labelled_as_one():
    a = CentralAgent.workflow_assessment(plan([t("t1", route="workflow-run")]))
    assert a["path"] == "saved-workflow" and a["worthy"]
    assert CentralAgent.workflow_assessment(plan([t("t1"), t("t2", ["t1"]), t("t3", ["t2"])]))["path"] == "structured"


class Engine:
    """Stands in for the workflow engine. Running a SAVED workflow
    (start_run / resume_run) fails the test; the one-node interpreter that all
    governed effects use (run_ad_hoc) is recorded, not forbidden."""

    NODE_TO_CAPABILITY: dict = {}

    def __init__(self):
        self.ad_hoc = []

    def start_run(self, *a, **k):
        raise AssertionError("a saved workflow was started")

    resume_run = start_run

    def run_ad_hoc(self, *a, **k):
        self.ad_hoc.append(a)
        raise AssertionError("not reached: no capability maps to a node in this stub")


@pytest.fixture()
def guarded(tmp_path):
    from aura.executors import all_executors

    agent = _agent(tmp_path)
    for ex in all_executors(None):
        agent.fabric_cfg.fabric.register(ex)
    agent.controller.engine = Engine()
    return agent


def test_chat_never_starts_a_workflow_or_assesses_one(guarded):
    result, sid = guarded.chat("Explain how a state machine works, then compare it to a DAG.")
    assert result.outcome == "completed"
    assert "workflow.considered" not in [e.type for e in guarded.bus.tail if e.sessionId == sid]


def test_a_simple_task_starts_no_workflow_and_is_reported_single_step(guarded, tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    result = guarded.submit("Create hello.md containing hi", project_id="p", project_path=str(root))
    assert result.outcome == "completed" and (root / "hello.md").exists()
    ev = [e for e in guarded.bus.tail if e.type == "workflow.considered"]
    assert ev and ev[-1].payload["path"] == "single-step" and ev[-1].payload["worthy"] is False
