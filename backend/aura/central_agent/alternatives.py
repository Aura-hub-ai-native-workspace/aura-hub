"""Alternative providers for a non-agent capability whose chosen node is unavailable.

A non-agent task can name the node that should carry it out. When that node
is not connected, does not provide what the capability needs, or cannot be
driven, Fabric routing refuses the task and never substitutes another node —
that refusal is deliberate and stays. What this module adds is the step
before it: finding out whether another node that is REALLY here could do the
same work, so the task can be pinned to it and sent through the same governed
path.

It decides nothing on its own authority. Every check is an existing one:

1. capability   — ``CapabilityDiscovery.available_for([capabilityId])``: the
                  capability must exist and the measured machine must satisfy it;
2. presence     — the Fabric host's ``present_nodes()``: only connected nodes
                  that provide the capability's ``requiresNodeCapability``;
3. execution    — the routing executor's ``supportsNode``: AURA must have a
                  verified way to drive the node;
4. policy       — ``AuthorityChecker.check_plan`` on the task pinned to the
                  candidate: a denied candidate is never selected;
5. billing      — ``workers.billing.decide``: a candidate the owner has not
                  allowed is never selected, and free ones are preferred.

A candidate is selected only when all five pass. Selection pins nothing and
runs nothing: the caller pins ``nodeId`` and dispatches, and Fabric validates
the pin again at invocation. Every rejected candidate is returned with the
check it failed and why, so "no alternative" is an explained answer.

Pure and read-only. Imports nothing beyond the standard library at module
level; the checks arrive as callables.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

#: The checks, in the order they are applied. A candidate's ``failed`` names
#: the first one it did not pass.
CHECKS = ("capability", "presence", "execution", "policy", "billing")


@dataclass(frozen=True)
class Candidate:
    nodeId: str
    name: str
    eligible: bool
    #: Which check rejected it ("" when eligible).
    failed: str = ""
    reason: str = ""
    #: The policy decision observed for this candidate ("" when not reached).
    policy: str = ""
    #: The billing verdict observed ("" when not reached).
    billing: str = ""
    free: bool = False

    def to_dict(self) -> dict:
        return {"nodeId": self.nodeId, "name": self.name, "eligible": self.eligible,
                "failed": self.failed, "reason": self.reason[:300],
                "policy": self.policy, "billing": self.billing, "free": self.free}


@dataclass(frozen=True)
class AlternativeChoice:
    #: Node id to pin, or None when nothing is eligible.
    selected: str | None
    #: Why this one (or why none).
    reason: str
    candidates: list[Candidate] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"selected": self.selected, "reason": self.reason,
                "candidates": [c.to_dict() for c in self.candidates]}

    def rejection_summary(self) -> str:
        """One line per rejected candidate, for the task's own outcome."""
        parts = [f"{c.name} ({c.failed}: {c.reason})" for c in self.candidates if not c.eligible]
        return "; ".join(parts)[:600]


def select_alternative(
    *,
    capability_id: str,
    needed: str | None,
    original_node: str | None,
    capability_available: tuple[bool, str],
    present_nodes: list[dict],
    can_use: Callable[[dict], bool] | None,
    has_executor: bool,
    policy_for: Callable[[str], tuple[str, str]],
    billing_for: Callable[[str], Any],
    is_free: Callable[[str], bool],
) -> AlternativeChoice:
    """Choose another connected node for ``capability_id``, or explain why none.

    ``capability_available`` is (available, reason) from capability discovery.
    ``policy_for(node_id)`` returns (decision, reason) from the policy engine's
    preflight for the task pinned to that node. ``billing_for(node_id)`` returns
    the billing module's decision object (``allowed``, ``billing``, ``reason``).
    """
    available, why = capability_available
    if not available:
        return AlternativeChoice(None, f"{capability_id} is not available on this machine: {why or 'not registered'}.")
    if not needed:
        # A capability that needs no node has no provider to swap: whatever
        # refused it was not the absence of a node.
        return AlternativeChoice(None, f"{capability_id} does not run on a node, so there is no other provider to choose.")
    if not has_executor:
        return AlternativeChoice(None, f"{capability_id} has no executor, so no node could carry it out.")

    candidates: list[Candidate] = []
    for node in present_nodes:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or "")
        if not node_id or node_id == (original_node or ""):
            continue
        if needed not in (node.get("capabilities") or []):
            continue  # not a provider at all: not a candidate, not a rejection
        name = str(node.get("name") or node_id)
        try:
            usable = True if can_use is None else bool(can_use(node))
        except Exception as exc:  # noqa: BLE001 — an unanswerable check is a refusal
            usable = False
            candidates.append(Candidate(node_id, name, False, "execution",
                                        f"its executor check failed ({exc})"))
            continue
        if not usable:
            candidates.append(Candidate(node_id, name, False, "execution",
                                        "AURA has no verified way to drive it"))
            continue
        try:
            decision, policy_reason = policy_for(node_id)
        except Exception as exc:  # noqa: BLE001 — fail closed
            decision, policy_reason = "deny", f"policy could not be evaluated ({exc})"
        if decision != "auto-execute":
            candidates.append(Candidate(node_id, name, False, "policy",
                                        policy_reason or "not permitted", policy=decision))
            continue
        try:
            bill = billing_for(node_id)
            allowed = bool(getattr(bill, "allowed", False))
            verdict = str(getattr(bill, "billing", "") or "")
            bill_reason = str(getattr(bill, "reason", "") or "")
        except Exception as exc:  # noqa: BLE001 — unknown billing is treated as paid
            allowed, verdict, bill_reason = False, "unknown", f"billing could not be read ({exc})"
        if not allowed:
            candidates.append(Candidate(node_id, name, False, "billing", bill_reason,
                                        policy=decision, billing=verdict))
            continue
        try:
            free = bool(is_free(node_id))
        except Exception:  # noqa: BLE001
            free = False
        candidates.append(Candidate(node_id, name, True, policy=decision, billing=verdict, free=free))

    eligible = [c for c in candidates if c.eligible]
    if not eligible:
        if not candidates:
            return AlternativeChoice(None, f"No other connected node provides {needed}.", candidates)
        return AlternativeChoice(None, f"No other connected node that provides {needed} passed every check.", candidates)
    # Free first; catalogue order breaks ties, exactly like Fabric's own routing.
    chosen = next((c for c in eligible if c.free), eligible[0])
    why = (f"{chosen.name} provides {needed}, can be driven, is permitted by policy and "
           + ("does not bill an account." if chosen.free else f"is allowed by billing ({chosen.billing})."))
    return AlternativeChoice(chosen.nodeId, why, candidates)
