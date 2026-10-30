"""Composition-root Fabric host — frozen wiring-mode semantics.

One host backs the production app. It implements exactly the semantics of
fabric/index.ts wiring mode (verbatim Python port lives in
aura.fabric.routing.resolve_node_for; policy rules mirror
ScriptedHost.wiring, which is differential-tested against the TS oracle):

  • routing: explicit requested node is NEVER substituted; auto-selection
    follows catalogue order; unsupported/no-provider failures stay honest;
  • availability: authority preflight sees the SAME node catalogue that
    execution resolves against (one store, one projection);
  • grants: policy decides every call. There is no grant context and no
    approval step; a call the policy refuses is refused at once.
"""
from __future__ import annotations


class WiringHost:
    """The production FabricHost over the connected-node registry."""

    def __init__(self, nodes) -> None:
        # nodes: aura.persistence.nodes.ConnectedNodeStore (one registry)
        self._nodes = nodes

    # ── node catalogue projections ───────────────────────────────────────

    def present_nodes(self) -> list[dict]:
        return self._nodes.list_nodes()

    def provided_capabilities(self) -> set[str]:
        provided: set[str] = set()
        for n in self.present_nodes():
            provided.update(n.get("capabilities") or [])
        return provided

    def permissions_for(self, _capability: dict, _context: dict) -> dict[str, bool]:
        return {"read": True, "write": True, "execute": True,
                "autonomous": True, "network": True}

    def node_available(self, capability: dict) -> bool | None:
        # fabric/index.ts:153-159 — None unless the capability needs a node;
        # internal surfaces never depend on one.
        needed = capability.get("requiresNodeCapability")
        if not needed:
            return None
        if capability.get("surface") == "aura-internal":
            return True
        return needed in self.provided_capabilities()

    def resolve_node(self, capability: dict, context: dict,
                     can_use=None) -> dict:
        from .routing import resolve_node_for

        return resolve_node_for(capability, context,
                                self.present_nodes(), can_use)

