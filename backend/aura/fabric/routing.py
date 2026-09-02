"""resolveNodeFor — verbatim port of ai-service/fabric/index.ts:74-136.

Rules, in order:
  1. no requiresNodeCapability -> no node
  2. aura-internal surface     -> no node
  3. REQUESTED node must exist, be present, provide the capability, and be
     usable; any failure denies and NEVER substitutes another node
  4. nothing requested         -> first present provider in catalogue order
"""

from __future__ import annotations

from collections.abc import Callable


def resolve_node_for(
    capability: dict,
    context: dict,
    present: list[dict],
    can_use: Callable[[dict], bool] | None = None,
) -> dict:
    needed = capability.get("requiresNodeCapability")
    if not needed:
        return {"ok": True}
    if capability.get("surface") == "aura-internal":
        return {"ok": True}

    usable = (lambda n: True) if can_use is None else can_use

    requested = (context.get("nodeId") or "").strip()
    if requested:
        node = next((n for n in present if n["id"] == requested), None)
        if node is None:
            return {
                "ok": False, "code": "unknown-node",
                "reason": f"'{requested}' is not a connected node on this machine. Connect it, or omit the node to let AURA choose.",
            }
        if needed not in node.get("capabilities", []):
            return {
                "ok": False, "code": "node-lacks-capability",
                "reason": f"{node['name']} does not provide {needed}, which {capability['name'].lower()} needs.",
            }
        if not usable(node):
            return {
                "ok": False, "code": "node-unsupported",
                "reason": f"{node['name']} provides {needed}, but AURA has no verified way to drive it yet, so nothing was run.",
            }
        return {"ok": True, "node": node}

    node = next((n for n in present if needed in n.get("capabilities", []) and usable(n)), None)
    if node is None:
        providers = [n for n in present if needed in n.get("capabilities", [])]
        if providers:
            return {
                "ok": False, "code": "node-unsupported",
                "reason": f"{', '.join(p['name'] for p in providers)} provide {needed}, but AURA has no verified way to drive any of them yet.",
            }
        return {
            "ok": False, "code": "no-provider",
            "reason": f"Nothing connected provides {needed} yet. Connect a node that does and this becomes available.",
        }
    return {"ok": True, "node": node}
