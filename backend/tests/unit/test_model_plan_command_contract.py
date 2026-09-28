"""t3 regression — a model-proposed command-execution task must never
survive planning.

Live acceptance (Phase 2, test D) exposed this as a mid-run failure:

    t3: command is required. Correct the argument and call it again.

Root cause: ``TaskPlanner.plan_from_model`` validated only that a
proposed capability is KNOWN — but a model-proposed task bound to a
command-execution capability (``sandbox.execute``, ``terminal.execute``)
is unfillable by construction: its contract requires a ``command``
argument the planner's own prompt forbids the model from supplying
("no shell commands, no binaries"). The plan passed planning cleanly and
only died at dispatch, when the Fabric's contract check rejected the
argument-free invocation. A plan-time contract violation must be caught
at plan time — fail closed in the planner, not mid-run in the executor.
"""

from __future__ import annotations

import pytest

from aura.central_agent.planner import (
    PlanningError,
    TaskPlanner,
)
from aura.contracts import AgentIntent


def _intent():
    return AgentIntent(goal="run the verification", expectedOutcome="done")


def _planner(nodes=("opencode",)):
    return TaskPlanner(
        known_capabilities=lambda: {
            "agent.delegate", "sandbox.execute", "terminal.execute",
            "git.status", "filesystem.write",
        },
        known_nodes=lambda: set(nodes),
    )


def _sandbox_task(**kw):
    """Exactly the shape the live model produced for t3: bound to a
    command capability, structured verification prose, but — as the
    Phase F contract requires — NO command in the input."""
    base = {
        "id": "t3",
        "description": "run the project's tests to verify the change",
        "capabilityId": "sandbox.execute",
        "input": {"cwd": ".", "timeout_ms": 30000},
        "verificationKind": "exit-code",
        "verification": "tests exit 0",
    }
    base.update(kw)
    return base


class TestModelPlanCannotBindCommandCapabilities:
    def test_sandbox_execute_without_command_rejected_at_plan_time(self):
        """The t3 repro: a model task on sandbox.execute with no command
        must fail in the PLANNER with a structured error, never reach
        dispatch (where it died as 'command is required')."""
        with pytest.raises(PlanningError, match="sandbox.execute"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_sandbox_task()]})

    def test_terminal_execute_without_command_rejected_at_plan_time(self):
        with pytest.raises(PlanningError, match="terminal.execute"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_sandbox_task(
                    id="t4", capabilityId="terminal.execute")]})

    def test_downstream_task_still_rejected(self):
        """A correctly-commanded downstream task must not rescue an
        invalid upstream binding."""
        with pytest.raises(PlanningError, match="sandbox.execute"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [
                    _sandbox_task(),
                    {"id": "t4", "description": "use the result",
                     "capabilityId": "agent.delegate",
                     "input": {"task": "use it"},
                     "verificationKind": "audit-only",
                     "verification": "reported",
                     "dependsOn": ["t3"]},
                ]})

    def test_error_names_the_task(self):
        """The rejection must be a structured, task-named validation
        error — not a generic failure."""
        with pytest.raises(PlanningError,
                           match="proposes command execution"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_sandbox_task()]})


class TestCommandTaskStillRejectedWithCommand:
    def test_explicit_command_still_rejected(self):
        """Even a supplied command does not make the binding valid: shell
        commands are model-forbidden by the Phase F contract regardless
        of argument completeness. The deterministic planner and direct
        Fabric users remain the only sanctioned routes to these caps."""
        with pytest.raises(PlanningError, match="command execution"):
            _planner().plan_from_model(
                _intent(), "ses-1", "now",
                {"tasks": [_sandbox_task(
                    input={"command": "pytest -q"})]})


class TestLegitimateCapsUnaffected:
    def test_delegate_and_git_still_plan(self):
        """No collateral damage: the documented Phase F surface (delegate,
        git, filesystem) plans exactly as before."""
        plan = _planner().plan_from_model(
            _intent(), "ses-1", "now",
            {"tasks": [
                {"id": "a", "description": "check state",
                 "capabilityId": "git.status", "input": {},
                 "verificationKind": "audit-only",
                 "verification": "status reported"},
                {"id": "b", "description": "do work",
                 "capabilityId": "agent.delegate",
                 "input": {"task": "fix the thing"},
                 "verificationKind": "exit-code",
                 "verification": "worker exits 0",
                 "dependsOn": ["a"]},
            ]})
        assert [t.id for t in plan.tasks] == ["t1", "t2"]
