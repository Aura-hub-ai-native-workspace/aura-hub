"""At dispatch Laya chooses among eligible workers; small edits default to OpenCode; fixes return to the builder."""
import aura.central_agent.execution as ex
from aura.central_agent.execution import ExecutionController
from aura.fabric import FabricConfig

OPENCODE = {"id": "opencode", "name": "OpenCode", "binary": "opencode", "capabilities": ["coding-agent", "terminal"]}
KILO = {"id": "kilo-code", "name": "Kilo Code", "binary": "kilo", "capabilities": ["coding-agent", "terminal"]}


class _Executor:
    capabilityId = "agent.delegate"

    @staticmethod
    def supportsNode(node):
        return bool(node.get("binary"))


class _Fabric:
    def __init__(self, nodes):
        self.executors = {"agent.delegate": _Executor()}

        class _Host:
            def present_nodes(self_inner):
                return nodes

        self.host = _Host()


class _Laya:
    def __init__(self, small=False, pick="kilo-code"):
        self.small, self.pick = small, pick

    def is_small_edit(self, brief):
        return self.small

    def choose_worker(self, brief, candidates):
        ids = [c["id"] for c in candidates]
        return {"worker": self.pick, "probability": 0.9} if self.pick in ids else None


class _Task:
    id = "implement"
    capabilityId = "agent.delegate"
    description = "Carry out the requested change"
    input = {"task": "Change the header colour"}


def _controller(nodes):
    ctl = ExecutionController.__new__(ExecutionController)
    ctl._cfg = FabricConfig(fabric=_Fabric(nodes), executors={})
    return ctl


def test_a_small_edit_goes_to_opencode_even_when_laya_would_pick_another(monkeypatch):
    monkeypatch.setattr(ex, "laya_advisor", lambda: _Laya(small=True, pick="kilo-code"))
    ctl = _controller([KILO, OPENCODE])
    assert ctl._match_role(_Task(), "code", None) == "opencode"
    assert ctl._laya_picks["implement"]["small"] is True


def test_a_larger_change_goes_to_the_worker_laya_chooses(monkeypatch):
    monkeypatch.setattr(ex, "laya_advisor", lambda: _Laya(small=False, pick="kilo-code"))
    ctl = _controller([OPENCODE, KILO])
    assert ctl._match_role(_Task(), "code", None) == "kilo-code"


def test_a_fix_returns_to_the_builder_when_it_is_eligible(monkeypatch):
    monkeypatch.setattr(ex, "laya_advisor", lambda: _Laya(small=False, pick="kilo-code"))
    ctl = _controller([OPENCODE, KILO])
    assert ctl._match_role(_Task(), "code", None, prefer={"opencode"}) == "opencode"
    assert ctl._laya_picks["implement"]["returned"] is True


def test_the_review_is_never_given_back_to_the_builder(monkeypatch):
    monkeypatch.setattr(ex, "laya_advisor", lambda: _Laya(small=True, pick="opencode"))
    ctl = _controller([OPENCODE, KILO])
    # OpenCode built it, so it is barred; the only worker left is chosen even for a "small" change.
    assert ctl._match_role(_Task(), "review", None, exclude={"opencode"}) == "kilo-code"


def test_laya_not_ready_falls_back_to_the_first_eligible_worker_and_says_so(monkeypatch):
    class _NotReady(_Laya):
        def choose_worker(self, brief, candidates):
            return None

    monkeypatch.setattr(ex, "laya_advisor", lambda: _NotReady())
    ctl = _controller([KILO, OPENCODE])
    assert ctl._match_role(_Task(), "code", None) == "kilo-code"
    assert ctl._laya_picks["implement"]["fallback"] is True
