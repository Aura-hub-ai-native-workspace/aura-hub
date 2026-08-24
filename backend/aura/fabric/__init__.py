"""aura.fabric — the ONE execution authority of the Python backend.

Port target: capability-fabric (P4). The invoke pipeline consumes
aura.policy (decisions), aura.audit (trail) and aura.approvals (gates);
it introduces no decision path of its own. Callers — including the
central agent — can reach an effect ONLY through `invoke_fabric`.
"""

from .executors import (
    WorkflowCreateExecutor,
    WorkflowListExecutor,
    builtin_executors,
)
from .invoke import (
    Executor,
    FabricConfig,
    NO_VERIFICATION,
    describe_authority,
    describe_target,
    invoke_fabric,
    summarize_input,
    validate_input,
)
from .manifest import BUILTIN_MANIFEST, CapabilityDescriptor, CapabilityField, describe_capability

__all__ = [
    "BUILTIN_MANIFEST",
    "CapabilityDescriptor",
    "CapabilityField",
    "NO_VERIFICATION",
    "Executor",
    "FabricConfig",
    "WorkflowCreateExecutor",
    "WorkflowListExecutor",
    "builtin_executors",
    "describe_capability",
    "describe_authority",
    "describe_target",
    "invoke_fabric",
    "summarize_input",
    "validate_input",
]
