"""Capability discovery — what can this installation actually do?

Answers are assembled from the fabric manifest (source of truth) plus
sanitized external-tool registrations (MCP/plugin boundary). Discovery is
READ-ONLY: it grants nothing and never executes.
"""

from __future__ import annotations

from ..contracts import ToolDescriptor
from ..fabric.manifest import all_capabilities


class CapabilityDiscovery:
    def __init__(self, external_tools: list[ToolDescriptor] | None = None,
                 capability_registry=None) -> None:
        self._external = list(external_tools or [])
        # Optional machine grounding: when a registry is present,
        # governed capabilities with a real machine dependency report
        # the MEASURED availability instead of assuming it. Without a
        # registry this behaves exactly as before (existing callers and
        # tests are unaffected).
        self._registry = capability_registry

    def _machine_ok(self, capability_id: str) -> tuple[bool, str]:
        """Does the machine satisfy this capability's machine needs?
        No registry, or no listed needs, means no new information —
        decided by manifest + authority exactly as before."""
        if self._registry is None:
            return True, ""
        try:
            from ..capabilities.tools import CAPABILITY_MACHINE_NEEDS

            needs = CAPABILITY_MACHINE_NEEDS.get(capability_id, [])
        except Exception:
            return True, ""
        if not needs:
            return True, ""
        missing = []
        for need in needs:
            try:
                if not self._registry.has(need):
                    missing.append(need)
            except Exception:
                missing.append(need)
        if missing:
            return False, ("measured machine lacks "
                           + ", ".join(sorted(missing)))
        return True, ""

    def available_for(self, capability_ids: list[str]) -> list[ToolDescriptor]:
        wanted = set(capability_ids)
        native = []
        for c in all_capabilities():
            if c.id not in wanted:
                continue
            machine_ok, machine_reason = self._machine_ok(c.id)
            native.append(ToolDescriptor(
                id=c.id,
                name=c.name,
                description=(c.description if machine_ok else
                             f"{c.description} [machine: {machine_reason}]"),
                risk=c.risk,
                permissions=list(c.permissions),
                inputFields=[
                    {"name": f.name, "type": f.type, "required": f.required,
                     "description": f.description}
                    for f in c.input
                ],
                sideEffects=bool(c.permissions),
                # Manifest entries may omit `irreversible`; absent means the
                # frozen descriptor makes no such claim → treat as reversible
                # for the read-only discovery view (never widens authority).
                reversible=not getattr(c, "irreversible", False),
                available=machine_ok,
                source="aura-manifest",
                trust="verified",
            ))
        external = [t for t in self._external if t.id in wanted]
        return native + external

    def all_tools(self) -> list[ToolDescriptor]:
        return self.available_for([c.id for c in all_capabilities()]) + list(self._external)
