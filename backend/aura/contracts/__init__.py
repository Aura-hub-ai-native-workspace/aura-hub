"""Contract models — Pydantic implementations of docs/migration/schemas/*.

Rules (mission §5):
  - These models NEVER redefine a frozen vocabulary; every enum mirrors the
    schema exactly.
  - `extra="allow"` everywhere: unknown fields are PRESERVED through
    round-trips, never dropped (frozen loaders tolerate extras; so do we).
  - Wire naming is camelCase, matching the frozen artifacts verbatim — no
    alias gymnastics, what you see on disk is the field name.
"""

from .agent import (
    AgentEvent,
    AgentIntent,
    AgentMessage,
    AgentResult,
    AgentSession,
    AgentVerificationReport,
    AuthorityRequirement,
    CapabilityRequirement,
    CompiledWorkflowRef,
    EvidenceBundle,
    ExecutionPlan,
    IntentEntity,
    SingleInvocation,
    TaskOutcome,
    TaskPlan,
    TaskSpecification,
    ToolDescriptor,
    VerificationRequirement,
)
from .approvals import ApprovalItem, ApprovalRequest
from .audit import AuditRecord, InvocationActor
from .automation_rule import AutomationRule, RetryPolicy, RuleAction, RuleTrigger
from .automation_run import ActionRunState, AutomationRun, RunTimelineEntry
from .policy import PolicyConfig
from .providers_store import ProviderCredential, ProvidersStore
from .schedule_state import ScheduleState
from .workflow_def import WfEdge, WfNode, Workflow
from .workflow_run import (
    AgentBeat,
    AgentBounds,
    AgentResume,
    AgentTrace,
    EvidenceRef,
    NodeRunRecord,
    RunTrigger,
    StateTransition,
    WorkflowRun,
)
from .workflow_version import WorkflowVersion

__all__ = [
    "AgentEvent",
    "AgentIntent",
    "AgentMessage",
    "AgentResult",
    "AgentSession",
    "AgentVerificationReport",
    "AuthorityRequirement",
    "CapabilityRequirement",
    "CompiledWorkflowRef",
    "EvidenceBundle",
    "ExecutionPlan",
    "IntentEntity",
    "SingleInvocation",
    "TaskOutcome",
    "TaskPlan",
    "TaskSpecification",
    "ToolDescriptor",
    "VerificationRequirement",
    "ActionRunState",
    "AgentBeat",
    "AgentBounds",
    "AgentResume",
    "AgentTrace",
    "ApprovalItem",
    "ApprovalRequest",
    "AuditRecord",
    "AutomationRule",
    "AutomationRun",
    "EvidenceRef",
    "InvocationActor",
    "NodeRunRecord",
    "PolicyConfig",
    "ProviderCredential",
    "ProvidersStore",
    "RetryPolicy",
    "RuleAction",
    "RuleTrigger",
    "RunTimelineEntry",
    "RunTrigger",
    "ScheduleState",
    "StateTransition",
    "WfEdge",
    "WfNode",
    "Workflow",
    "WorkflowRun",
    "WorkflowVersion",
]
