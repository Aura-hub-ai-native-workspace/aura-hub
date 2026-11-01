"""With no text model, a web question becomes read-only research done by a coding agent."""
from types import SimpleNamespace

from aura.central_agent.intent import IntentCompiler
from aura.central_agent.planner import TaskPlanner, apply_web_research_preference
from aura.central_agent.service import CentralAgent


def _service(model_port=None):
    svc = CentralAgent.__new__(CentralAgent)
    svc.intents = SimpleNamespace(model_port=model_port)
    svc.events = []
    svc._emit = lambda type_, sid, **payload: svc.events.append((type_, payload))
    return svc


def _intent(message="What is the latest stable version of Node.js?", web=True):
    # Compile, then apply the person's web-research toggle, exactly as the service does.
    return apply_web_research_preference(IntentCompiler(mode="heuristic").compile(message), web, message)


def test_a_web_question_without_a_model_is_handed_to_a_worker_as_read_only_research():
    svc, intent = _service(), _intent()
    assert list(intent.requiredCapabilities) == ["web.research"]
    svc._research_by_worker(intent, "agt-aaaaaa")
    assert intent.requiredCapabilities == ["agent.delegate"]
    assert intent.delegateReadOnly is True and intent.webResearch is False
    assert "Question: What is the latest stable version of Node.js?" in intent.delegateTask
    assert svc.events and svc.events[0][0] == "ceo.say"
    plan = TaskPlanner().plan(intent, "agt-aaaaaa", "2026-10-31T00:00:00Z")
    assert [t.id for t in plan.tasks] == ["investigate"]
    assert plan.tasks[0].workerRole == "research"


def test_nothing_changes_when_a_model_exists_or_research_is_off_or_it_is_not_research():
    for svc, intent in ((_service(model_port=object()), _intent()),
                        (_service(), _intent(web=False)),
                        (_service(), _intent("create a file called a.txt containing hi"))):
        before = list(intent.requiredCapabilities)
        svc._research_by_worker(intent, "agt-aaaaaa")
        assert list(intent.requiredCapabilities) == before
        assert svc.events == []
