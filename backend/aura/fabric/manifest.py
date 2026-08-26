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

    def __getattr__(self, name: str) -> Any:
        try:
            return object.__getattribute__(self, "_d")[name]
        except KeyError:
            raise AttributeError(name) from None

    @property
    def permissions(self) -> list[str]:
        return list(self._d.get("permissions") or [])


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
