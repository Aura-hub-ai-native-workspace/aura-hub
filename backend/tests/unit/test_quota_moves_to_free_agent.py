"""When a paid agent reaches its limit the retry goes to a free agent, told to continue from the shared context."""
from types import SimpleNamespace as NS

from aura.central_agent.execution import ExecutionController


def test_free_agents_exclude_the_failed_and_the_paid_ones(monkeypatch):
    ctl = ExecutionController.__new__(ExecutionController)
    nodes = [{"id": "claude-code"}, {"id": "opencode"}, {"id": "kilo-code"}]
    monkeypatch.setattr(ctl, "_present_nodes", lambda: nodes, raising=False)
    assert ctl._free_agents({"opencode"}) == {"kilo-code"}
