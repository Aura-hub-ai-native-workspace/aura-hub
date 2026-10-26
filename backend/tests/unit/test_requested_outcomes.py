"""The request is the authority — regression tests for the false-success defect.

A real Tauri UI acceptance run produced a mission the app reported as
"Mission verified: every acceptance criterion is met" while NOTHING had
been implemented: the model's plan had turned a request to write
src/math.js into "store a workflow definition", and the plan's own
criterion ("the definition reads back") was met.

These tests pin the two guards that close it:

  · the handoff validator REFUSES a plan that does not address the
    deliverables the request named (nothing runs on such a plan);
  · the verification engine refuses to call an objective met when the
    request was never addressed — and a stored workflow graph is never
    evidence of source-code implementation.
"""
from __future__ import annotations

import pytest

from aura.central_agent.plan_handoff import HandoffError, validate_handoff
from aura.central_agent.requested import named_files
from aura.central_agent.verification import VerificationEngine
from aura.contracts.agent import (
    AgentIntent,
    TaskOutcome,
    TaskPlan,
    TaskSpecification,
    VerificationRequirement,
)


def _handoff(goal: str, tasks: list[dict], acceptance: list[str] | None = None) -> dict:
    return {
        "source": "planner", "planId": "pln-1", "revision": 1, "goal": goal,
        "tasks": tasks, "acceptance": acceptance or [],
    }


def _task(tid: str, title: str, target: str | None = None,
          files: list[str] | None = None, description: str = "",
          worker: str | None = None) -> dict:
    return {"id": tid, "title": title, "description": description,
            "targetFile": target, "files": files or [],
            "dependsOn": [], "worker": worker,
            "expectedOutput": f"{title} is done", "verification": "read it back",
            "requires": []}


def _plan(goal: str, tasks: list[TaskSpecification],
          acceptance: list[VerificationRequirement] | None = None) -> TaskPlan:
    intent = AgentIntent(goal=goal, expectedOutcome="the work is done")
    return TaskPlan(planId="pln-1", sessionId="agt-1", intent=intent,
                    tasks=tasks, acceptance=acceptance or [],
                    createdAt="2026-01-01T00:00:00Z")


def _spec(tid: str, capability: str | None = "agent.delegate",
          target: str | None = None, files: list[str] | None = None,
          description: str = "", kind: str = "read-back") -> TaskSpecification:
    return TaskSpecification(
        id=tid, description=description, capabilityId=capability,
        targetFile=target, files=files or [], inputFrom="literal",
        verification=VerificationRequirement(kind=kind, description="checked"))


def _outcome(tid: str, verified: bool | None = True, state: str = "done") -> TaskOutcome:
    return TaskOutcome(taskId=tid, state=state, performed=True,
                        verified=verified, detail="done")


# ── 1. a workflow graph is created, but the requested source files are not ──

def test_a_stored_workflow_graph_is_not_proof_the_requested_code_was_written():
    """The observed failure. The plan stored a workflow definition, its own
    criterion was met, and the app reported a verified mission — for a
    request to write source code that was never written."""
    goal = ("Create src/math.js exporting add and multiply, and "
            "tests/math.test.js using node:test")
    plan = _plan(
        goal,
        [_spec("t1", capability="workflow.create", kind="read-back",
               description="Compile the requested graph and store it as a "
                           "workflow definition")],
        [VerificationRequirement(kind="read-back", description="The requested "
                                  "workflow definition is stored and reads back.")],
    )
    rows = [_outcome("t1", verified=True)]
    accepted, unmet = VerificationEngine.verify_objective(plan, rows)
    assert accepted is False, "a stored graph hash is not proof of implementation"
    assert unmet, "the unmet reason must name the request, not the plan"
    assert any("src/math.js" in u for u in unmet)


def test_the_handoff_of_such_a_plan_is_refused_before_anything_runs():
    goal = ("Create src/math.js exporting add and multiply, and "
            "tests/math.test.js using node:test")
    raw = _handoff(goal, [_task("t1", "Compile the requested graph and store it "
                                 "as a workflow definition",
                                 target="workflow.json")])
    with pytest.raises(HandoffError) as err:
        validate_handoff(raw)
    assert "src/math.js" in str(err.value)


# ── 2. a requested file is missing from all planned tasks ──

def test_a_requested_file_missing_from_every_task_blocks_the_handoff():
    goal = "Add src/math.js and tests/math.test.js"
    raw = _handoff(goal, [_task("t1", "Create API endpoints", target="src/api/add.js")])
    with pytest.raises(HandoffError) as err:
        validate_handoff(raw)
    assert "src/math.js" in str(err.value)


def test_a_plan_that_targets_every_named_file_is_accepted():
    goal = "Add src/math.js and tests/math.test.js"
    raw = _handoff(goal, [
        _task("t1", "Create the module", target="src/math.js"),
        _task("t2", "Create the tests", target="tests/math.test.js"),
    ])
    out = validate_handoff(raw)
    assert [t["id"] for t in out["tasks"]] == ["t1", "t2"]


def test_a_plan_that_only_reads_the_named_file_still_counts_as_addressing_it():
    """"Write tests for src/app.js" names a file no task writes. A task that
    mentions it is addressing the request, so the plan is not refused."""
    goal = "Write tests for src/app.js"
    raw = _handoff(goal, [
        _task("t1", "Write the test suite", target="tests/app.test.js",
              description="Cover the behaviour of src/app.js"),
    ])
    out = validate_handoff(raw)
    assert out["tasks"][0]["id"] == "t1"


# ── 3. a task has an invalid scope/dependency relationship ──

def test_a_task_depending_on_an_unknown_task_is_refused():
    goal = "Add src/math.js"
    raw = _handoff(goal, [_task("t1", "Create the module", target="src/math.js")])
    raw["tasks"][0]["dependsOn"] = ["nope"]
    with pytest.raises(HandoffError) as err:
        validate_handoff(raw)
    assert "unknown task" in str(err.value)


def test_a_task_depending_on_itself_is_refused():
    goal = "Add src/math.js"
    raw = _handoff(goal, [_task("t1", "Create the module", target="src/math.js")])
    raw["tasks"][0]["dependsOn"] = ["t1"]
    with pytest.raises(HandoffError) as err:
        validate_handoff(raw)
    assert "depends on itself" in str(err.value)


# ── 4. all required files are created and relevant tests pass ──

def test_a_plan_that_addresses_the_request_and_verifies_is_accepted():
    goal = "Add src/math.js and tests/math.test.js"
    plan = _plan(
        goal,
        [_spec("t1", target="src/math.js", description="Create the module"),
         _spec("t2", target="tests/math.test.js", description="Create the tests")],
        [VerificationRequirement(kind="read-back", description="Both files exist",
                                  expect={"tasks": ["t1", "t2"]})],
    )
    rows = [_outcome("t1"), _outcome("t2")]
    accepted, unmet = VerificationEngine.verify_objective(plan, rows)
    assert accepted is True
    assert unmet == []


# ── 5. a task partially succeeds but one acceptance criterion remains unmet ──

def test_one_unmet_criterion_means_the_objective_is_not_met():
    goal = "Add src/math.js and tests/math.test.js"
    plan = _plan(
        goal,
        [_spec("t1", target="src/math.js", description="Create the module"),
         _spec("t2", target="tests/math.test.js", description="Create the tests")],
        [VerificationRequirement(kind="read-back", description="Both files exist",
                                  expect={"tasks": ["t1", "t2"]})],
    )
    rows = [_outcome("t1"), _outcome("t2", verified=False)]
    accepted, unmet = VerificationEngine.verify_objective(plan, rows)
    assert accepted is False
    assert any("t2" in u for u in unmet)


# ── 6. verification fails or required evidence is unavailable ──

def test_evidence_that_never_appeared_means_the_objective_is_not_met():
    """The task finished but its check did not confirm it: the objective is
    not met, and the unmet reason names the task."""
    goal = "Add src/math.js"
    plan = _plan(
        goal,
        [_spec("t1", target="src/math.js", description="Create the module")],
        [VerificationRequirement(kind="read-back", description="The file exists",
                                  expect={"tasks": ["t1"]})],
    )
    rows = [_outcome("t1", verified=False)]
    accepted, unmet = VerificationEngine.verify_objective(plan, rows)
    assert accepted is False
    assert any("t1" in u for u in unmet)


def test_a_blocked_task_means_the_objective_is_not_met():
    goal = "Add src/math.js"
    plan = _plan(
        goal,
        [_spec("t1", target="src/math.js", description="Create the module")],
        [VerificationRequirement(kind="read-back", description="The file exists",
                                  expect={"tasks": ["t1"]})],
    )
    rows = [_outcome("t1", verified=None, state="blocked")]
    accepted, unmet = VerificationEngine.verify_objective(plan, rows)
    assert accepted is False


# ── the shared rule itself ──

def test_named_files_finds_the_deliverables_a_request_names():
    assert named_files("Add src/math.js and tests/math.test.js") == [
        "src/math.js", "tests/math.test.js"]
    assert named_files("make a calculator app") == []


def test_a_request_that_asks_for_a_workflow_is_not_refused_for_it():
    """A workflow request is a legitimate request: the plan stores a
    definition, and that IS the work asked for."""
    goal = "Create a workflow named demo that runs the report"
    raw = _handoff(goal, [_task("t1", "Compile the requested graph and store it "
                                 "as a workflow definition", worker="opencode")])
    out = validate_handoff(raw)
    assert out["tasks"][0]["id"] == "t1"


def test_a_request_with_no_named_file_is_left_to_the_plan():
    goal = "Make the report better"
    raw = _handoff(goal, [_task("t1", "Improve the report", target="report.md")])
    out = validate_handoff(raw)
    assert out["tasks"][0]["id"] == "t1"
