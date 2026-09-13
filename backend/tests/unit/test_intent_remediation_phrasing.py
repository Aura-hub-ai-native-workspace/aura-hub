"""Intent must recognise the plain-English shapes of "review it, then
fix what the reviewer finds, and prove it".

These phrasings are how people actually ask. Missing one does not fail
loudly — it silently plans a shorter DAG, so the reviewer's findings
have no task to land in and the run reports success having fixed
nothing. Every case here is pinned to the plan it must produce.
"""
from aura.central_agent.intent import IntentCompiler
from aura.central_agent.planner import plan_delegated_work


def _tasks(message: str) -> list[str]:
    intent = IntentCompiler(mode="heuristic").compile(message)
    if not getattr(intent, "delegateTask", None):
        return []
    return [t.id for t in plan_delegated_work(intent, "ses", "now").tasks]


class TestRemediationPhrasing:
    def test_pronoun_remediation_plans_the_fix(self):
        """"fix it" — the pronoun form, which is the common one."""
        assert _tasks(
            "Build a small authentication feature for this project. Have "
            "another AI review the implementation. If the reviewer finds "
            "a problem, fix it and verify everything."
        ) == ["implement", "review", "remediate"]

    def test_reviewer_as_a_noun_still_means_a_review(self):
        assert _tasks("Refactor this and fix anything the reviewer finds.") \
            == ["implement", "review", "remediate"]

    def test_address_that_is_remediation(self):
        assert _tasks("Add a parser, have it reviewed, and address that.") \
            == ["implement", "review", "remediate"]

    def test_remediation_without_a_review_is_just_the_work(self):
        """No review means "fix it" IS the task, not a follow-up to one —
        a remediate task here would be a second implementation waiting on
        findings that nobody was asked to produce."""
        assert _tasks("Fix the login bug.") == ["implement"]

    def test_review_alone_plans_no_remediation(self):
        assert _tasks("Add a parser and have another AI review it.") \
            == ["implement", "review"]

    def test_a_question_delegates_nothing(self):
        assert _tasks("What does this repo do?") == []


class TestProofPhrasing:
    def test_verify_everything_asks_for_proof(self):
        intent = IntentCompiler(mode="heuristic").compile(
            "Add login and verify everything.")
        assert intent.delegateProve is True

    def test_named_proof_still_recognised(self):
        intent = IntentCompiler(mode="heuristic").compile(
            "Add login and make sure the tests pass.")
        assert intent.delegateProve is True

    def test_no_proof_request_stays_false(self):
        intent = IntentCompiler(mode="heuristic").compile("Add login.")
        assert intent.delegateProve is False
