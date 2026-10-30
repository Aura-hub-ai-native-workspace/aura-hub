"""The central agent decides; it does not hand the decision back to the person.

A local model often answers "Review this project for issues" with a question
("a code-level defect scan or a broader audit?"). In a Workspace with an open
project that question is the agent's job to settle, so the request proceeds with
the most useful reading and the summary states which one was taken. A question is
still asked when there is genuinely nothing to act on: no open project, a message
too short to carry intent, or a request the intent compiler judged impossible.
"""
from __future__ import annotations

from typing import Any

#: Fewer words than this carry no intent to decide about ("fix", "help").
MIN_WORDS = 3
DECIDED = ("Decided by the central agent: no clarification was asked. Take the most useful reading of the "
           "request and say which one was taken in the summary.")


def decide_instead_of_asking(intent: Any, *, user_message: str, has_project: bool) -> bool:
    """Clear a model-raised clarification when the agent can decide. True if it did."""
    if not getattr(intent, "needsClarification", False):
        return False
    if not has_project or getattr(intent, "ambiguity", "clear") == "impossible":
        return False
    if len((user_message or "").split()) < MIN_WORDS:
        return False
    intent.needsClarification = False
    intent.clarificationQuestion = None
    intent.constraints = [*list(getattr(intent, "constraints", None) or []), DECIDED]
    return True
