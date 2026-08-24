"""aura.workflow — the Python workflow engine.

Executes validated workflow graphs through the ONE governed invocation path
(aura.fabric). This module is orchestration and state, never authority: a
node that wants an effect becomes exactly one fabric invoke, and policy,
approval parking, verification and audit happen inside the Fabric.

Semantics follow the frozen WorkflowRun contract (states never collapse;
evidence references the audit trail; resumable is stated on the record).
Resume legs are NEW runs with trigger {kind:'resume', of} chained to the
parked leg via mark_superseded — matching TS resume semantics.
"""

from .engine import EngineConfig, NodeOutcome, WorkflowEngine, make_stores

__all__ = ["EngineConfig", "NodeOutcome", "WorkflowEngine", "make_stores"]
