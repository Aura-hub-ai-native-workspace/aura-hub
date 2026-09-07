"""Worker requirement matching — "a worker suitable for this task".

Thin deterministic layer over the existing node catalogue: a task states
a closed-vocabulary role, matching filters connected nodes to those that
provide the node-capability the role needs AND pass the executor's
usability check, and the winner travels the EXISTING explicit-nodeId path
(routing validates again at dispatch; never substitutes, only denies).

Advisory for routing, never authoritative: Fabric policy, the binary
allow-list, verified invocation, approval, and audit all still decide.
No cost/latency/health scoring, no ranking, no discovery — first eligible
node in catalogue order, exactly like existing auto-selection.
"""

from __future__ import annotations

from collections.abc import Callable

#: Role → node-capability the worker must provide. Closed on both ends:
#: unknown roles never reach here (contract literal + planner rejection).
ROLE_NODE_CAPABILITY = {
    "code": "coding-agent",
    "review": "coding-agent",
    "execute": "terminal",
}


def required_node_capability(role: str) -> str | None:
    return ROLE_NODE_CAPABILITY.get(role)


def match_worker(
    role: str,
    nodes: list[dict],
    usable: Callable[[dict], bool] | None = None,
) -> dict | None:
    """First node (catalogue order) providing what `role` needs and
    passing `usable`. Returns the node dict, or None when nothing is
    eligible — the caller fails closed, never falls back to an
    unsuitable worker."""
    needed = ROLE_NODE_CAPABILITY.get(role)
    if needed is None:
        return None
    check = usable or (lambda n: True)
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if needed not in (node.get("capabilities") or []):
            continue
        try:
            if not check(node):
                continue
        except Exception:
            continue
        return node
    return None


def node_satisfies_role(node: dict, role: str) -> bool:
    """Consistency check for an explicitly pinned node against a stated
    role. Usability is NOT decided here — dispatch re-checks it."""
    needed = ROLE_NODE_CAPABILITY.get(role)
    if needed is None:
        return False
    return isinstance(node, dict) and needed in (node.get("capabilities") or [])
