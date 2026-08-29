"""Manifest views over THIS backend's canonical capability registry.

`aura.fabric` loads its manifest from the frozen JSON shipped beside it;
this module exposes the attribute-style views the central agent's planner
and context assembler read (`c.id`, `c.description`, `c.risk`). It is a
read-only projection of ONE registry — never a second manifest.
"""
from __future__ import annotations

from typing import Any


class CapabilityView:
    """Attribute access over a canonical descriptor dict."""

    __slots__ = ("_d",)

    def __init__(self, d: dict[str, Any]) -> None:
        object.__setattr__(self, "_d", d)

    # Documented optional fields of the CapabilityDescriptor contract; a
    # frozen entry may omit them and the agent layer reads them directly.
    _DEFAULTS = {
        "description": "",
        "risk": "low",
        "permissions": [],
        "irreversible": False,
        "requiresNodeCapability": None,
        "verify": None,
        "output": "",
        "category": "general",
        "surface": "aura-internal",
    }

    def __getattr__(self, name: str) -> Any:
        data = object.__getattribute__(self, "_d")
        if name in data:
            return data[name]
        if name in self._DEFAULTS:
            return self._DEFAULTS[name]
        raise AttributeError(name) from None

    @property
    def permissions(self) -> list[str]:
        return list(self._d.get("permissions") or [])

    @property
    def input(self) -> list["CapabilityView"]:
        # Frozen manifests store input fields as JSON objects; the agent
        # layer reads them as attribute views (f.name, f.type, ...).
        return [CapabilityView(f) for f in self._d.get("input") or []]


def _registry() -> list[dict[str, Any]]:
    # The in-memory MANIFEST is the single live truth: it starts as the
    # frozen file and grows through governed registration (mcp_bridge).
    from . import MANIFEST

    return MANIFEST


def all_capabilities() -> list[CapabilityView]:
    return [CapabilityView(d) for d in _registry()]


def describe_capability(capability_id: str) -> CapabilityView | None:
    for d in _registry():
        if d.get("id") == capability_id:
            return CapabilityView(d)
    return None
