"""Automation subsystem: engine + scheduler + the workflow action handler.

The `run-workflow` action is THE convergence point with Phase 6: it calls
WorkflowRunner.start_workflow_run with an automation trigger and carries NO
approvedCapabilities — scheduled/event runs park under ask-user policy
exactly like manual ones.
"""
from __future__ import annotations

from .engine import (
    AutomationEngine,
    evaluate_condition,
    evaluate_conditions,
    merge_config,
    partial_match,
    retry_delay,
)
from .scheduler import AutomationScheduler, next_after, parse_cron


def make_workflow_action(runner, projects):
    """Host-injected handler binding automation to the canonical runner.

    Returns ActionResult{ok, summary?, produced?}; NEVER grants approvals
    (no approved_capabilities parameter exists on this path).
    """

    async def run_workflow_action(ctx, config):
        workflow_id = (config or {}).get("workflowId")
        if not workflow_id:
            return {"ok": False, "error": "no workflowId configured"}
        wf = runner._workflows_get(workflow_id) if hasattr(runner, "_workflows_get") else None
        if wf is None and getattr(runner, "workflows", None):
            wf = runner.workflows.get(workflow_id)
        if not wf:
            return {"ok": False, "error": f'No workflow is stored under "{workflow_id}".'}
        project_path = ctx["projectPath"]
        started = await runner.start_workflow_run(
            wf, project_id=ctx["projectId"], project_path=project_path,
            inputs=config.get("inputs") or {},
            trigger={"kind": "automation", "ruleId": ctx["ruleId"],
                     "runId": ctx["runId"], "event": ctx["event"]["type"]},
        )
        run, result = started["run"], started["result"]
        produced = {"kind": "workflow-run", "workflowId": workflow_id,
                    "runId": run["id"], "state": result["runState"]}
        ok = result["runState"] in ("succeeded", "awaiting-approval")
        detail = f'{wf.get("name")} — {result["runState"]}, run {run["id"]}'
        return ({"ok": True, "summary": detail, "produced": produced} if ok
                else {"ok": False, "error": detail, "produced": produced})

    return run_workflow_action


__all__ = [
    "AutomationEngine",
    "AutomationScheduler",
    "evaluate_condition",
    "evaluate_conditions",
    "make_workflow_action",
    "merge_config",
    "next_after",
    "parse_cron",
    "partial_match",
    "retry_delay",
]
