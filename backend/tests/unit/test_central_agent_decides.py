"""The agent settles ambiguity itself when it has a project to work in (autonomy policy)."""
from types import SimpleNamespace as NS

from aura.central_agent.autonomy import DECIDED, decide_instead_of_asking


def _intent(**kw):
    return NS(**{"needsClarification": True, "clarificationQuestion": "Which one?", "ambiguity": "ambiguous",
                 "constraints": ["keep it small"], **kw})


def test_a_substantive_request_in_an_open_project_is_decided_not_asked():
    i = _intent()
    assert decide_instead_of_asking(i, user_message="Review this project for issues.", has_project=True)
    assert i.needsClarification is False and i.clarificationQuestion is None
    assert i.constraints == ["keep it small", DECIDED]


def test_it_still_asks_when_there_is_nothing_to_act_on():
    for kw, msg, proj in ((dict(), "fix", True), (dict(), "Review this project for issues.", False),
                          (dict(ambiguity="impossible"), "Review this project for issues.", True)):
        i = _intent(**kw)
        assert not decide_instead_of_asking(i, user_message=msg, has_project=proj)
        assert i.needsClarification is True and i.clarificationQuestion == "Which one?"


def test_a_clear_intent_is_untouched():
    i = _intent(needsClarification=False)
    assert not decide_instead_of_asking(i, user_message="Review this project for issues.", has_project=True)
    assert i.constraints == ["keep it small"]
