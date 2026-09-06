"""aura.central_agent — the intelligence/orchestration layer.

The agent REASONS; aura.policy DECIDES; aura.fabric EXECUTES and audits.
Nothing in this package spawns processes, writes project files, contacts
networks or decides authority. Public entry point: CentralAgent.submit().
"""

from .authority import AuthorityChecker
from .discovery import CapabilityDiscovery
from .events import EventBus
from .execution import ExecutionController, ExecutionOutcome
from .intent import (
    IntentCompilationError,
    IntentCompiler,
    ModelPort,
    ScriptedModelPort,
    heuristic_interpret,
)
from .mcp_gateway import McpGateway, McpRegistrationError, sanitize_external_tool
from .planner import MAX_TASKS, PlanningError, TaskPlanner, topo_order
from .service import CentralAgent
from .session import AgentSessionStore
from .supervisor import (
    MAX_CORRECTION_ATTEMPTS,
    CorrectionRecord,
    RunVerdict,
    TaskVerdict,
    build_correction,
    decide_run,
    decide_task,
    validate_correction_scope,
)
from .verification import VerificationEngine
from .workflow_compiler import CompilationError, WorkflowCompiler

__all__ = [
    "MAX_TASKS",
    "AgentSessionStore",
    "AuthorityChecker",
    "CapabilityDiscovery",
    "CentralAgent",
    "CompilationError",
    "EventBus",
    "ExecutionController",
    "ExecutionOutcome",
    "IntentCompilationError",
    "IntentCompiler",
    "McpGateway",
    "McpRegistrationError",
    "ModelPort",
    "CorrectionRecord",
    "MAX_CORRECTION_ATTEMPTS",
    "PlanningError",
    "RunVerdict",
    "ScriptedModelPort",
    "TaskPlanner",
    "TaskVerdict",
    "build_correction",
    "decide_run",
    "decide_task",
    "validate_correction_scope",
    "VerificationEngine",
    "WorkflowCompiler",
    "heuristic_interpret",
    "sanitize_external_tool",
    "topo_order",
]
