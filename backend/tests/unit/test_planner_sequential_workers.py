"""Named workers joined by "then" are a verified hand-off chain, not a fan-out."""

from __future__ import annotations

from aura.central_agent.intent import heuristic_interpret
from aura.central_agent.planner import plan_delegated_work

CHAIN = ("Have opencode build the backend API in backend/, then have "
         "Kilo Code build the user interface in frontend/.")


def _plan(message: str):
    return plan_delegated_work(heuristic_interpret(message), "ses-1", "now")


class TestSequentialWorkerPlan:
    def test_each_stage_is_pinned_to_its_named_worker(self):
        plan = _plan(CHAIN)
        assert [t.nodeId for t in plan.tasks] == ["opencode", "kilo-code"]

    def test_later_stage_waits_for_and_receives_the_earlier_one(self):
        first, second = _plan(CHAIN).tasks
        assert first.dependsOn == [] and first.inputFrom == "literal"
        assert second.dependsOn == [first.id]
        assert second.inputFrom == "upstream-output"

    def test_every_stage_has_its_own_acceptance(self):
        plan = _plan(CHAIN)
        assert len(plan.acceptance) == len(plan.tasks)

    def test_parallel_request_still_fans_out(self):
        plan = _plan("Use Claude Code and Kilo Code in parallel, then report. "
                     "Inspect only, do not modify anything.")
        assert all(t.dependsOn == [] for t in plan.tasks)

    def test_one_named_worker_is_not_a_chain(self):
        plan = _plan("Have opencode add a multiply function, then review it.")
        assert plan.tasks[0].id == "implement"
