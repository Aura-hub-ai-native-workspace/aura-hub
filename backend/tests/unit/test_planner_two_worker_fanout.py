"""Explicit two-runtime read-only requests fan out into two wired tasks.

A single generic `agent.delegate` of the whole message is the correct
answer for "have an agent do X". When the person instead names TWO
distinct runtimes and orders them to work independently without
modifying anything, one task collapses the split they asked for and
gives verification nothing to compare. The planner must preserve that
distinction.
"""

from __future__ import annotations

from aura.central_agent.intent import heuristic_interpret
from aura.central_agent.planner import (
    _named_distinct_workers,
    _plan_parallel_two_worker,
    plan_delegated_work,
)

TWO_WORKER = (
    "Use two independent AI workers in parallel on this same project. "
    "Have Claude Code inspect the backend architecture and Kilo Code "
    "inspect the frontend architecture. Neither task should modify files."
)


def _two_worker_intent():
    return heuristic_interpret(TWO_WORKER)


class TestParallelTwoWorkerDetection:
    def test_two_named_workers_found(self):
        workers = _named_distinct_workers(TWO_WORKER)
        assert [node for _, _, node in workers] == ["claude-code", "kilo-code"]

    def test_single_worker_request_is_not_matched(self):
        intent = heuristic_interpret(
            "Have Kilo Code inspect the frontend architecture.")
        assert _named_distinct_workers(
            getattr(intent, "delegateTask", "")) is None

    def test_not_matched_without_independence(self):
        intent = heuristic_interpret(
            "Have Claude Code and Kilo Code both contribute to this task."
        )
        assert _plan_parallel_two_worker(intent, "ses", "now") is None


class TestParallelTwoWorkerPlan:
    def test_fans_out_two_tasks(self):
        plan = _plan_parallel_two_worker(_two_worker_intent(), "ses-1", "now")
        assert plan is not None
        assert len(plan.tasks) == 2

    def test_each_task_pinned_to_its_worker(self):
        plan = _plan_parallel_two_worker(_two_worker_intent(), "ses-1", "now")
        by_id = {t.id: t for t in plan.tasks}
        assert by_id["delegate-claude"].nodeId == "claude-code"
        assert by_id["delegate-kilo"].nodeId == "kilo-code"

    def test_each_task_gets_its_own_instruction(self):
        plan = _plan_parallel_two_worker(_two_worker_intent(), "ses-1", "now")
        by_id = {t.id: t for t in plan.tasks}
        assert "backend" in by_id["delegate-claude"].input["task"]
        assert "frontend" in by_id["delegate-kilo"].input["task"]

    def test_no_task_writes(self):
        plan = _plan_parallel_two_worker(_two_worker_intent(), "ses-1", "now")
        for t in plan.tasks:
            assert t.capabilityId in ("agent.delegate", None)
            assert t.workerRole == "research"
            assert t.input.get("expectChange") is not True
            assert t.dependsOn == []

    def test_through_public_planner_front_door(self):
        """The fan-out is on the real path, not a side door."""
        plan = plan_delegated_work(_two_worker_intent(), "ses-1", "now")
        assert len(plan.tasks) == 2
        caps = {t.capabilityId for t in plan.tasks}
        assert caps == {"agent.delegate"}


class TestHeaderNamingBothWorkers:
    """A header that names both workers must not cut the instructions.

    Regression: "Claude Code and Kilo Code: … Claude Code, inspect a.txt …"
    gave Claude the task text "and", so it ran with nothing to do.
    """

    MESSAGE = (
        "Claude Code and Kilo Code: work in parallel and independently, "
        "without modifying anything. Claude Code, inspect alpha/a.txt and "
        "report its contents. Kilo Code, inspect alpha/b.txt and report its "
        "contents."
    )

    def test_each_worker_receives_its_own_instruction(self):
        plan = _plan_parallel_two_worker(heuristic_interpret(self.MESSAGE), "ses", "now")
        by_id = {t.id: t for t in plan.tasks}
        assert "alpha/a.txt" in by_id["delegate-claude"].input["task"]
        assert "alpha/b.txt" in by_id["delegate-kilo"].input["task"]

    def test_no_worker_gets_a_bare_connective(self):
        plan = _plan_parallel_two_worker(heuristic_interpret(self.MESSAGE), "ses", "now")
        for t in plan.tasks:
            assert len(t.input["task"].split()) >= 4
            assert t.input["task"].lower() not in ("and", "")

    def test_shared_constraint_is_carried_to_both(self):
        plan = _plan_parallel_two_worker(heuristic_interpret(self.MESSAGE), "ses", "now")
        for t in plan.tasks:
            assert "without modifying anything" in t.input["task"]


def test_header_phrasing_through_the_live_front_door():
    """plan_delegated_work is the path a real submit takes. The multi-worker
    planner runs first for two names; it must split the same way."""
    from aura.central_agent.planner import plan_delegated_work

    msg = TestHeaderNamingBothWorkers.MESSAGE
    plan = plan_delegated_work(heuristic_interpret(msg), "ses", "now")
    by_id = {t.id: t for t in plan.tasks}
    assert "alpha/a.txt" in by_id["delegate-claude"].input["task"]
    assert "alpha/b.txt" in by_id["delegate-kilo"].input["task"]
    assert by_id["delegate-claude"].input["task"].lower() != "and"


class TestEvidenceBinding:
    """A task that names a file must show it read that file; one criterion
    per task keeps an evidenced worker from covering an unevidenced one."""

    MESSAGE = TestHeaderNamingBothWorkers.MESSAGE

    def _plan(self):
        from aura.central_agent.planner import plan_delegated_work
        return plan_delegated_work(heuristic_interpret(self.MESSAGE), "ses", "now")

    def test_each_task_requires_its_own_file(self):
        by_id = {t.id: t for t in self._plan().tasks}
        assert by_id["delegate-claude"].input["requiredEvidence"] == ["alpha/a.txt"]
        assert by_id["delegate-kilo"].input["requiredEvidence"] == ["alpha/b.txt"]
        assert by_id["delegate-claude"].verification.kind == "evidence-present"

    def test_one_criterion_per_task_with_that_tasks_kind(self):
        acc = self._plan().acceptance
        assert len(acc) == 2
        for criterion in acc:
            (task_id,) = criterion.expect["tasks"]
            assert criterion.kind == "evidence-present"
            assert task_id in ("delegate-claude", "delegate-kilo")

    def test_a_task_naming_no_file_keeps_process_verification(self):
        from aura.central_agent.planner import _bind_evidence
        from aura.contracts.agent import TaskSpecification
        t = TaskSpecification(id="x", description="look into the design",
                              capabilityId="agent.delegate")
        _bind_evidence([t])
        assert t.verification.kind != "evidence-present"
        assert "requiredEvidence" not in (t.input or {})

    def test_model_proposed_evidence_key_is_not_honoured(self):
        """requiredEvidence is AURA-owned: a proposal in the raw input must
        not survive planning, so a model cannot add or drop what is checked."""
        from aura.central_agent.planner import _DELEGATE_INPUT_KEYS
        assert "requiredEvidence" not in _DELEGATE_INPUT_KEYS
