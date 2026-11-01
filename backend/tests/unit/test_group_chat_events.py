"""The events the group chat is built from are real event types: they are accepted, not dropped."""
from aura.contracts import AgentEvent


def _event(type_: str, **payload) -> AgentEvent:
    return AgentEvent(type=type_, sessionId="agt-aaaaaa", at="2026-10-31T00:00:00Z", payload=payload)


def test_task_output_and_ceo_say_are_valid_events():
    assert _event("task.output", taskId="t1", stream="stdout", line="writing index.html").type == "task.output"
    assert _event("ceo.say", kind="handoff", text="OpenCode finished the step.").type == "ceo.say"
