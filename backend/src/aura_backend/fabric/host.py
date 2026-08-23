"""The decisions the Fabric refuses to make for itself.

A port of the `FabricHost` port in packages/capability-fabric/src/fabric.ts
and its implementation in packages/ai-service/src/fabric/index.ts.

Each of these four is a security boundary, and each is deliberately the
host's job rather than the Fabric's:

  * `permissions_for` can only NARROW — never widen.
  * `node_available` is the input to the `no-provider` floor.
  * `resolve_node` refuses a named node; it never substitutes one.
  * `request_approval` returns False when nobody can be asked. **No UI
    means no implicit yes.**
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from ..policy.types import Grants
from .routing import resolve_node_for
from .scopes import LOCAL_GRANTS, RunScopeRegistry
from .types import (
    ApprovalRequest,
    CapabilityDescriptor,
    InvocationContext,
    NodeRef,
    NodeResolution,
)


class FabricHost(Protocol):
    def permissions_for(
        self, capability: CapabilityDescriptor, context: InvocationContext
    ) -> Grants: ...

    def node_available(self, capability: CapabilityDescriptor) -> bool | None: ...

    # Optional. A host that leaves this None keeps the older
    # boolean-only behaviour.
    resolve_node: (
        Callable[
            [CapabilityDescriptor, InvocationContext, Callable[[NodeRef], bool] | None],
            NodeResolution,
        ]
        | None
    )

    async def request_approval(
        self, request: ApprovalRequest, context: InvocationContext
    ) -> bool: ...


@dataclass
class ServiceFabricHost:
    """The host this service supplies.

    Approval handling is deliberately conservative: the service has no UI,
    so it cannot ask anyone anything. An invocation that needs
    authorization is therefore **parked, not performed**. The desktop
    carries the approval UI and re-invokes with an explicit grant.

    A service that auto-granted its own approvals would make the entire
    policy layer decorative.
    """

    run_scopes: RunScopeRegistry = field(default_factory=RunScopeRegistry)
    # Read at decision time, not construction time, so a node connected
    # mid-session takes effect immediately.
    provided_node_capabilities: Callable[[], set[str]] = field(default=lambda: set())
    # Nodes present right now, IN CATALOGUE ORDER — the order is the
    # documented routing tie-break, not an incidental detail.
    present_nodes: Callable[[], list[NodeRef]] = field(default=list)

    def permissions_for(
        self, capability: CapabilityDescriptor, context: InvocationContext
    ) -> Grants:
        scoped = self.run_scopes.for_run(context.run_id)
        return scoped if scoped is not None else LOCAL_GRANTS

    def node_available(self, capability: CapabilityDescriptor) -> bool | None:
        if not capability.requires_node_capability:
            return None
        # Internal AURA capabilities never depend on an external node.
        if capability.surface == "aura-internal":
            return True
        provided = self.provided_node_capabilities()
        if not provided:
            return False
        return capability.requires_node_capability in provided

    def resolve_node(
        self,
        capability: CapabilityDescriptor,
        context: InvocationContext,
        can_use: Callable[[NodeRef], bool] | None = None,
    ) -> NodeResolution:
        return resolve_node_for(capability, context, self.present_nodes(), can_use)

    async def request_approval(
        self, request: ApprovalRequest, context: InvocationContext
    ) -> bool:
        # Granted only if THIS call carried an explicit authorization for
        # every capability in the request. A grant never outlives the
        # invocation that carried it.
        approved = set(context.approved_capabilities or ())
        return all(item.capability_id in approved for item in request.items)
