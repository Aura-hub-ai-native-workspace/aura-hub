"""Worker selection must not choose a worker AURA cannot drive.

The production composition root hands the Central Agent a FabricConfig
whose own `executors` map is EMPTY and registers the real executors on
the CapabilityFabric instead. Selection therefore has to reach the
Fabric's registry to find `supportsNode`; when it does not, every
usability check silently degrades to "any node providing the role",
and a distinct-reviewer requirement can hand the review to a worker
with no proved binary while a usable, distinct one sits unused.

That failure is honest — dispatch refuses it — but the run is wasted,
so these tests pin the selection itself, not the refusal.
"""
from aura.central_agent.execution import ExecutionController
from aura.fabric import FabricConfig


class _Executor:
    capabilityId = "agent.delegate"

    @staticmethod
    def supportsNode(node: dict) -> bool:
        # Stands in for agent_delegate_supports_node: a worker is
        # drivable only once readiness proved a binary for it.
        return bool(node.get("binary"))


class _Fabric:
    def __init__(self, nodes, executors):
        self.executors = executors

        class _Host:
            def present_nodes(self_inner):
                return nodes

        self.host = _Host()


def _controller(nodes, cfg_executors, fabric_executors):
    cfg = FabricConfig(fabric=_Fabric(nodes, fabric_executors),
                       executors=cfg_executors)
    return ExecutionController.__new__(ExecutionController), cfg


def _match(nodes, cfg_executors, fabric_executors, exclude=None):
    ctl, cfg = _controller(nodes, cfg_executors, fabric_executors)
    ctl._cfg = cfg

    class _Task:
        capabilityId = "agent.delegate"

    return ctl._match_role(_Task(), "review", None, exclude=exclude or set())


UNPROVED = {"id": "claude-code", "name": "Claude Code", "binary": None,
            "capabilities": ["coding-agent", "terminal"]}
PROVED = {"id": "kilo-code", "name": "Kilo Code", "binary": "kilo",
          "capabilities": ["coding-agent", "terminal"]}
AUTHOR = {"id": "opencode", "name": "OpenCode", "binary": "opencode",
          "capabilities": ["coding-agent", "terminal"]}


class TestSelectionHonoursUsability:
    def test_reaches_fabric_registry_when_config_map_is_empty(self):
        """The production shape: executors={} on the config."""
        picked = _match([AUTHOR, UNPROVED, PROVED], {},
                        {"agent.delegate": _Executor()},
                        exclude={"opencode"})
        assert picked == "kilo-code", (
            "selection skipped the drivable distinct worker and chose one "
            "with no proved binary")

    def test_config_map_still_wins_when_present(self):
        picked = _match([AUTHOR, UNPROVED, PROVED],
                        {"agent.delegate": _Executor()}, {},
                        exclude={"opencode"})
        assert picked == "kilo-code"

    def test_no_usable_distinct_worker_fails_closed(self):
        """Nothing eligible returns None — never an unusable fallback."""
        picked = _match([AUTHOR, UNPROVED], {},
                        {"agent.delegate": _Executor()},
                        exclude={"opencode"})
        assert picked is None

    def test_absent_registry_keeps_role_only_matching(self):
        """With no executor anywhere the pre-existing behaviour stands:
        match on role provision, and let dispatch enforce usability."""
        picked = _match([UNPROVED, PROVED], {}, {})
        assert picked == "claude-code"
