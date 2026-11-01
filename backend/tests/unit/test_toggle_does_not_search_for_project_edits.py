"""The web toggle permits research; a plain project edit does not trigger a search."""
from aura.central_agent.intent import IntentCompiler
from aura.central_agent.planner import TaskPlanner, apply_web_research_preference


def _plan(message: str, web: bool = True):
    intent = apply_web_research_preference(IntentCompiler(mode="heuristic").compile(message), web, message)
    return TaskPlanner().plan(intent, "agt-aaaaaa", "2026-11-01T00:00:00Z")


def test_a_footer_edit_with_the_toggle_on_has_no_search_task():
    plan = _plan("Add a small footer to index.html that says 2026 Simple Site. Plain HTML only.")
    assert [t.capabilityId for t in plan.tasks] == ["agent.delegate"]


def test_an_edit_that_asks_for_research_still_searches_first():
    plan = _plan("Implement a login page; search the web for the current OWASP password guidance and follow it.")
    assert plan.tasks[0].capabilityId == "web.research"
    assert plan.tasks[1].capabilityId == "agent.delegate"
