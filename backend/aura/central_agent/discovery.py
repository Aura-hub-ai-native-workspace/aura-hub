"""Capability discovery — what can this installation actually do?

Answers are assembled from the fabric manifest (source of truth) plus
sanitized external-tool registrations (MCP/plugin boundary). Discovery is
READ-ONLY: it grants nothing and never executes.
"""

from __future__ import annotations

from ..contracts import ToolDescriptor
from ..fabric.manifest import all_capabilities


class CapabilityDiscovery:
    def __init__(self, external_tools: list[ToolDescriptor] | None = None) -> None:
        self._external = list(external_tools or [])

    def available_for(self, capability_ids: list[str]) -> list[ToolDescriptor]:
        wanted = set(capability_ids)
        native = [
            ToolDescriptor(
                id=c.id,
                name=c.name,
                description=c.description,
                risk=c.risk,
                permissions=list(c.permissions),
                inputFields=[
                    {"name": f.name, "type": f.type, "required": f.required,
                     "description": f.description}
                    for f in c.input
                ],
                sideEffects=bool(c.permissions),
                reversible=not c.irreversible,
                available=True,
                source="aura-manifest",
                trust="verified",
            )
            for c in all_capabilities() if c.id in wanted
        ]
        external = [t for t in self._external if t.id in wanted]
        return native + external

    def all_tools(self) -> list[ToolDescriptor]:
        return self.available_for([c.id for c in all_capabilities()]) + list(self._external)
