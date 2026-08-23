"""Route a capability to a node.

A port of `resolveNodeFor` in packages/ai-service/src/fabric/index.ts.

The rules, in order:

  1. No `requires_node_capability` -> no node needed.
  2. `aura-internal` -> runs inside AURA, no node needed.
  3. A node was REQUESTED -> it must exist, be present, and provide the
     capability. Any failure denies. **A requested node is never silently
     swapped for one that would have worked** — substitution is exactly
     the quiet behavior routing exists to prevent.
  4. Nothing requested -> the first present provider in CATALOGUE ORDER.
     Deterministic and documented, never arbitrary.
"""

from __future__ import annotations

from collections.abc import Callable

from .types import CapabilityDescriptor, InvocationContext, NodeRef, NodeResolution


def resolve_node_for(
    capability: CapabilityDescriptor,
    context: InvocationContext,
    present: list[NodeRef],
    can_use: Callable[[NodeRef], bool] | None = None,
) -> NodeResolution:
    needed = capability.requires_node_capability
    if not needed:
        return NodeResolution(ok=True)
    if capability.surface == "aura-internal":
        return NodeResolution(ok=True)

    def usable(node: NodeRef) -> bool:
        return can_use(node) if can_use else True

    requested = (context.node_id or "").strip()
    if requested:
        node = next((n for n in present if n.id == requested), None)
        if node is None:
            # Deliberately does not distinguish "never existed" from "not
            # running": both mean the caller cannot have what they asked
            # for, and the reason names the node so it is actionable.
            return NodeResolution(
                ok=False,
                code="unknown-node",
                reason=(
                    f"'{requested}' is not a connected node on this machine. "
                    "Connect it, or omit the node to let AURA choose."
                ),
            )
        if needed not in node.capabilities:
            return NodeResolution(
                ok=False,
                code="node-lacks-capability",
                reason=(
                    f"{node.name} does not provide {needed}, "
                    f"which {capability.name.lower()} needs."
                ),
            )
        if not usable(node):
            # Refused, not redirected.
            return NodeResolution(
                ok=False,
                code="node-unsupported",
                reason=(
                    f"{node.name} provides {needed}, but AURA has no verified way to "
                    "drive it yet, so nothing was run."
                ),
            )
        return NodeResolution(ok=True, node=node)

    # Catalogue order, filtered to what the executor can actually drive.
    node = next((n for n in present if needed in n.capabilities and usable(n)), None)
    if node is None:
        providers = [n for n in present if needed in n.capabilities]
        if providers:
            names = ", ".join(p.name for p in providers)
            return NodeResolution(
                ok=False,
                code="node-unsupported",
                reason=(
                    f"{names} provide {needed}, but AURA has no verified way to drive "
                    "any of them yet."
                ),
            )
        return NodeResolution(
            ok=False,
            code="no-provider",
            reason=(
                f"Nothing connected provides {needed} yet. Connect a node that does "
                "and this becomes available."
            ),
        )
    return NodeResolution(ok=True, node=node)
