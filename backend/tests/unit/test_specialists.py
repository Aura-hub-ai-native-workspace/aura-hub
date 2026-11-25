"""AURA's six specialists: fixed identities, fixed runtimes, deterministic assignment."""
import aura.central_agent.execution as ex
from aura.central_agent.execution import ExecutionController, ExecutionOutcome
from aura.central_agent.specialists import (
    KILO, OPENCODE, all_specialists, execution_guidance, roster, specialist_for,
)
from aura.fabric import FabricConfig
from types import SimpleNamespace

OPENCODE_NODE = {"id": "opencode", "name": "OpenCode", "binary": "opencode", "capabilities": ["coding-agent", "terminal"]}
KILO_NODE = {"id": "kilo-code", "name": "Kilo Code", "binary": "kilo", "capabilities": ["coding-agent", "terminal"]}
CLAUDE_NODE = {"id": "claude-code", "name": "Claude Code", "binary": "claude", "capabilities": ["coding-agent"]}


def test_there_are_exactly_six_with_the_established_runtimes():
    assert {s.name: s.runtime for s in all_specialists()} == {
        "Researcher": OPENCODE,
        "Planner": OPENCODE,
        "Frontend Builder": OPENCODE,
        "Backend Builder": KILO,
        "Debugger": KILO,
        "Reviewer / Fixer": KILO,
    }


def test_role_decides_the_specialist_when_the_brief_cannot_change_it():
    assert specialist_for("research", "fix the login bug").id == "researcher"
    assert specialist_for("planning", "anything").id == "planner"
    assert specialist_for("review", "build the footer").id == "reviewer-fixer"
    assert specialist_for("testing", "").id == "reviewer-fixer"


def test_code_work_is_split_by_what_the_brief_is_about():
    assert specialist_for("code", "Change the header colour and make the navbar responsive").id == "frontend-builder"
    assert specialist_for("code", "Add a POST /api/students endpoint backed by the database").id == "backend-builder"
    assert specialist_for("code", "The export fails with a traceback; find the root cause").id == "debugger"
    # Building error handling is not chasing a failure.
    assert specialist_for("code", "Add error handling to the payments API endpoint").id == "backend-builder"
    # Nothing to go on: service work is the default, never a guess at the interface.
    assert specialist_for("code", "Carry out the requested change").id == "backend-builder"


def test_no_role_and_the_operator_terminal_role_are_nobodys_specialist_work():
    assert specialist_for(None, "build it") is None
    assert specialist_for("execute", "npm test") is None
    assert specialist_for("unknown-role", "x") is None


def test_roster_reports_real_runtime_availability_and_never_guesses():
    by_id = {s["id"]: s for s in roster({"opencode"})}
    assert by_id["researcher"]["runtimeAvailable"] is True
    assert by_id["debugger"]["runtimeAvailable"] is False
    assert all(s["runtimeAvailable"] is None for s in roster(None))


def test_specialist_accountability_reaches_the_delegated_task_without_granting_authority():
    guidance = execution_guidance("frontend-builder")
    assert "AURA SPECIALIST: Frontend Builder" in guidance
    assert "React and TypeScript development" in guidance
    assert "does not grant additional tools or permissions" in guidance
    assert execution_guidance("unknown") == ""


def test_assigned_specialist_guidance_reaches_the_real_fabric_invocation(monkeypatch):
    ctl = _controller([OPENCODE_NODE])
    ctl._model_registry = None
    captured = {}

    def invoke(capability, payload, context, _cfg):
        captured.update(payload)
        assert capability == "agent.delegate"
        return {
            "outcome": "succeeded",
            "detail": "Agent completed.",
            "verification": {"passed": True, "detail": "Process exited 0."},
            "invocationId": "inv-test",
            "output": {"stdout": "done", "exitCode": 0, "nodeId": "opencode", "agent": "OpenCode"},
        }

    monkeypatch.setattr(ex, "invoke_fabric", invoke)
    task = SimpleNamespace(
        id="t1", capabilityId="agent.delegate", workerRole="code",
        description="Restyle the workspace header component",
        input={"task": "Restyle the workspace header component", "context": "Project uses React."},
        inputFrom="literal", dependsOn=[], nodeId=None, missionId=None,
        verification=SimpleNamespace(kind="process-exit", description="Process exits successfully."),
    )
    outcome = ExecutionOutcome()

    ctl._invoke_single(task, None, None, outcome)

    context = captured["context"]
    assert "AURA SPECIALIST: Frontend Builder" in context
    assert "React and TypeScript development" in context
    assert "Project uses React." in context
    assert "Task assignment: Restyle the workspace header component" in context
    assert "Expected deliverable:" in context
    assert "process-exit — Process exits successfully." in context
    assert outcome.worker_assignments["t1"]["specialist"] == "frontend-builder"


class _Executor:
    capabilityId = "agent.delegate"

    @staticmethod
    def supportsNode(node):
        return bool(node.get("binary"))


class _Fabric:
    def __init__(self, nodes):
        self.executors = {"agent.delegate": _Executor()}

        class _Host:
            def present_nodes(self_inner):
                return nodes

        self.host = _Host()


class _Laya:
    def is_small_edit(self, brief):
        return False

    def choose_worker(self, brief, candidates):
        return {"worker": candidates[-1]["id"], "probability": 0.8}


def _task(brief):
    class _Task:
        id = "t1"
        capabilityId = "agent.delegate"
        description = brief
        input = {"task": brief}
    return _Task()


def _controller(nodes):
    ctl = ExecutionController.__new__(ExecutionController)
    ctl._cfg = FabricConfig(fabric=_Fabric(nodes), executors={})
    return ctl


def test_the_assigned_runtime_takes_the_step_when_it_is_eligible(monkeypatch):
    monkeypatch.setattr(ex, "laya_advisor", lambda: _Laya())
    ctl = _controller([CLAUDE_NODE, KILO_NODE, OPENCODE_NODE])
    assert ctl._match_role(_task("Restyle the sidebar component"), "code", None) == "opencode"
    assert ctl._laya_picks["t1"] == {"worker": "opencode", "name": "OpenCode", "specialist": "frontend-builder",
                                     "specialistName": "Frontend Builder", "assigned": True}
    assert ctl._match_role(_task("Add a database migration for the users table"), "code", None) == "kilo-code"
    assert ctl._match_role(_task("Review the change"), "review", None) == "kilo-code"
    assert ctl._match_role(_task("Investigate how auth works"), "research", None) == "opencode"


def test_another_eligible_worker_is_chosen_when_the_assigned_runtime_is_absent(monkeypatch):
    monkeypatch.setattr(ex, "laya_advisor", lambda: _Laya())
    ctl = _controller([OPENCODE_NODE, CLAUDE_NODE])  # no Kilo for the Backend Builder
    picked = ctl._match_role(_task("Add a database migration for the users table"), "code", None)
    assert picked == "claude-code"
    assert "assigned" not in ctl._laya_picks["t1"]


def test_an_independent_review_never_reuses_the_builder_even_if_it_is_the_assigned_runtime(monkeypatch):
    monkeypatch.setattr(ex, "laya_advisor", lambda: _Laya())
    ctl = _controller([KILO_NODE, OPENCODE_NODE])
    assert ctl._match_role(_task("Review the change"), "review", None, exclude={"kilo-code"}) == "opencode"


def test_a_fix_still_returns_to_the_worker_that_built_the_change(monkeypatch):
    monkeypatch.setattr(ex, "laya_advisor", lambda: _Laya())
    ctl = _controller([KILO_NODE, OPENCODE_NODE])
    assert ctl._match_role(_task("Fix the failing test"), "code", None, prefer={"opencode"}) == "opencode"
    assert ctl._laya_picks["t1"]["returned"] is True
