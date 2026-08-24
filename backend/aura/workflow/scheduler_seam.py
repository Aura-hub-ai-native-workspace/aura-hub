"""Scheduler fire seam — the ONLY way a schedule starts a workflow.

The seam does exactly one thing: call the canonical runner with an
automation trigger. It cannot approve, cannot execute nodes, cannot
bypass policy — it has no such parameters.
"""
from __future__ import annotations


async def fire_scheduled_workflow(runner, *, workflow: dict, project_id: str,
                                  project_path: str, rule_id: str,
                                  automation_run_id: str, cron: str) -> dict:
    """One scheduled fire → ONE canonical runner entry."""
    return await runner.start_workflow_run(
        workflow,
        project_id=project_id,
        project_path=project_path,
        trigger={"kind": "automation", "ruleId": rule_id,
                 "runId": automation_run_id, "event": f"schedule:{cron}"},
    )
