"""Rule dry-run — what a rule WOULD do, without doing any of it.

Port of ai-service/src/automationDryRun.ts (+ schedule.ts validate/describe
helpers) composed ENTIRELY from canonical pieces: this module's own
condition evaluator, the scheduler's cron parser, and the workflow dry-run.
It creates no run, invokes no capability, opens no approval and writes
nothing — the report states that itself.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from .engine import evaluate_conditions
from .scheduler import next_after, parse_cron

DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday",
             "Friday", "Saturday"]


def _known(value: bool, reason: str) -> dict:
    return {"certainty": "known", "value": value, "reason": reason}


def _conditional(reason: str, depends_on: str) -> dict:
    return {"certainty": "conditional", "value": None, "reason": reason,
            "dependsOn": depends_on}


def _at_path(payload: dict, path: str) -> Any:
    cur: Any = payload
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


def next_fire(expression: str, after: datetime):
    parsed = parse_cron(expression)
    if not parsed.get("ok"):
        return parsed
    try:
        at = next_after(parsed["cron"], after)
    except Exception as exc:  # honest parse/occurrence failure
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "at": at}


def describe_cron(expression: str) -> str:
    parsed = parse_cron(expression)
    if not parsed.get("ok"):
        return f"invalid ({parsed.get('error')})"
    c = parsed["cron"]
    every_dom = len(c["dayOfMonth"]) == 31
    every_month = len(c["month"]) == 12
    every_dow = len(c["dayOfWeek"]) == 7
    minute = sorted(c["minute"])
    hour = sorted(c["hour"])
    at = f"{hour[0]:02d}:{minute[0]:02d}"
    if every_dom and every_month:
        if every_dow:
            if len(minute) == 60 and len(hour) == 24:
                return "every minute"
            if len(minute) == 1 and len(hour) == 24:
                return f"every hour at :{minute[0]:02d}"
            if len(minute) == 1 and len(hour) == 1:
                return f"daily at {at}"
        elif len(minute) == 1 and len(hour) == 1 and len(c["dayOfWeek"]) == 1:
            dow = sorted(c["dayOfWeek"])[0]
            return f"every {DAY_NAMES[dow]} at {at}"
    return expression


def validate_rule(rule: dict) -> list[dict]:
    """Is this rule storable and runnable? Refusals name the field."""
    issues: list[dict] = []
    trigger = rule.get("trigger") or {}

    if trigger.get("type") == "schedule":
        cron_expr = trigger.get("cron")
        if not cron_expr:
            issues.append({"field": "trigger.cron",
                           "message": "A scheduled rule needs a cron expression."})
        else:
            parsed = parse_cron(str(cron_expr))
            if not parsed.get("ok"):
                issues.append({"field": "trigger.cron", "message": parsed["error"]})
            elif not next_after(parsed["cron"], datetime.now()):
                issues.append({
                    "field": "trigger.cron",
                    "message": "That expression has no next occurrence, so the rule could never fire."})
        if not trigger.get("projectId"):
            issues.append({
                "field": "trigger.projectId",
                "message": "A scheduled rule must name the project it runs against — there is no event to infer one from."})
    elif trigger.get("cron"):
        issues.append({
            "field": "trigger.cron",
            "message": f"A cron expression only applies to a schedule trigger, not to \"{trigger.get('type')}\"."})

    for i, action in enumerate(rule.get("chain") or []):
        if action.get("action") != "run-workflow":
            continue
        wid = (action.get("config") or {}).get("workflowId")
        if not wid or not isinstance(wid, str):
            issues.append({
                "field": f"chain[{i}].config.workflowId",
                "message": "A run-workflow action must name the workflow it runs."})
    return issues


def dry_run_rule(*, rule: dict, resolve_workflow, dry_run_workflow,
                 sample_event: dict | None = None,
                 project_id: str | None = None) -> dict:
    """The service's own verdict on a rule. Evaluates conditions and policy;
    never executes an action."""
    unknowns: list[dict] = []
    issues = validate_rule(rule)

    # ── would the trigger be accepted? ──────────────────────────────
    trigger = rule.get("trigger") or {}
    schedule_info: dict | None = None
    if not rule.get("enabled", True):
        accepted = _known(False, "This rule is disabled, so no event reaches it.")
    elif trigger.get("type") == "schedule":
        cron_expr = str(trigger.get("cron") or "")
        nxt = next_fire(cron_expr, datetime.now())
        if not nxt.get("ok"):
            accepted = _known(False, f"The schedule cannot fire: {nxt.get('error')}")
        else:
            at_iso = nxt["at"].isoformat().replace("+00:00", "Z") if nxt.get("at") else None
            accepted = _known(True, "A schedule fires on the clock, so its trigger is always accepted.")
            schedule_info = {
                "cron": cron_expr,
                "description": describe_cron(cron_expr),
                # Stated, never selectable: the scheduler has no timezone DB.
                "nextFireAt": at_iso,
                "timezone": "local",
            }
            if not nxt.get("at"):
                unknowns.append({"what": "the next fire",
                                 "why": "This expression has no occurrence within the next four years."})
    elif sample_event is not None:
        type_matches = sample_event.get("type") == trigger.get("type")
        match_ok = True
        if type_matches and trigger.get("match"):
            for k, v in (trigger.get("match") or {}).items():
                if json.dumps(_at_path(sample_event.get("payload") or {}, k),
                              sort_keys=True) != json.dumps(v, sort_keys=True):
                    match_ok = False
                    break
        if type_matches and match_ok:
            accepted = _known(True, "The sample event matches this rule's trigger type and filter.")
        else:
            accepted = _known(
                False,
                "The sample event does not satisfy the trigger filter."
                if type_matches else
                f"The sample event is a \"{sample_event.get('type')}\", not a \"{trigger.get('type')}\".")
    else:
        accepted = _conditional(
            f"This rule fires when a \"{trigger.get('type')}\" event happens. Whether one happens is not something a dry run can decide.",
            "a real platform event")
        unknowns.append({
            "what": "whether the trigger fires",
            "why": "It depends on a future event. Supply a sample event to reason about a specific one."})

    # ── would the conditions pass? ──────────────────────────────────
    conditions = rule.get("conditions") or []
    evaluations: list[dict] = []
    if not conditions:
        outcome = _known(True, "This rule has no conditions, so nothing can block it.")
    elif sample_event is not None:
        evaluations = evaluate_conditions(sample_event.get("payload") or {}, conditions)
        passed = all(c.get("passed") for c in evaluations)
        outcome = _known(
            bool(passed),
            f"All {len(evaluations)} condition{'s' if len(evaluations) != 1 else ''} pass against this payload."
            if passed else
            f"{sum(1 for c in evaluations if not c.get('passed'))} of {len(evaluations)} conditions fail against this payload.")
    else:
        outcome = _conditional(
            f"{len(conditions)} condition{'s' if len(conditions) != 1 else ''} would be evaluated against the event payload.",
            "the payload of the event that fires")
        unknowns.append({
            "what": "the condition outcome",
            "why": "Conditions read the event payload, which does not exist until the event does."})

    # ── which actions, and what would they ask for? ─────────────────
    actions: list[dict] = []
    approvals_required: list[dict] = []
    denials: list[dict] = []
    capabilities_requested: set[str] = set()
    prior_continues = True
    for i, action in enumerate(rule.get("chain") or []):
        if i == 0:
            reached = (_known(True, "The first action runs whenever the conditions pass.")
                       if outcome["certainty"] == "known" and outcome["value"] is True
                       else _conditional("The first action runs if the conditions pass.",
                                         "the condition outcome"))
        elif prior_continues:
            reached = _conditional("This action runs if every earlier action in the chain succeeded.",
                                   "the outcome of the earlier actions")
        else:
            reached = _conditional("An earlier action stops the chain on failure, so this may not be reached.",
                                   "the outcome of the earlier actions")

        planned: dict[str, Any] = {
            "actionId": action.get("id"),
            "action": action.get("action"),
            "label": action.get("label"),
            "reached": reached,
            "capabilities": [],
            "continueOnError": action.get("continueOnError") is True,
        }

        if action.get("action") == "run-workflow":
            wid = str((action.get("config") or {}).get("workflowId") or "")
            wf = resolve_workflow(wid) if wid else None
            if wf is None:
                planned["workflow"] = {
                    "workflowId": wid, "workflowName": "", "dryRun": None,
                    "error": f'No workflow is stored under "{wid}".' if wid
                            else "This action names no workflow."}
            else:
                pid = project_id or (sample_event or {}).get("projectId") \
                    or trigger.get("projectId") or ""
                try:
                    report = dry_run_workflow(wf, pid)
                    planned["workflow"] = {"workflowId": wid,
                                           "workflowName": wf.get("name", ""),
                                           "dryRun": report}
                    for step in report.get("plan") or []:
                        if not step.get("capabilityId") or not step.get("policy"):
                            continue
                        capabilities_requested.add(step["capabilityId"])
                        planned["capabilities"].append({
                            "capabilityId": step["capabilityId"],
                            "decision": step["policy"]["decision"],
                            "rule": step["policy"]["rule"],
                            "risk": step["policy"]["risk"],
                            "wouldAskHuman": step.get("wouldAskHuman") is True,
                            "wouldBeDenied": step.get("wouldBeDenied") is True,
                        })
                    for a in report.get("approvalsRequired") or []:
                        approvals_required.append({"actionId": action.get("id"), **a})
                    for d in report.get("denials") or []:
                        denials.append({"actionId": action.get("id"), **d})
                    plan_types = {p.get("type") for p in report.get("plan") or []}
                    node_classes = {p.get("nodeClass") for p in report.get("plan") or []}
                    if "loop" in plan_types:
                        unknowns.append({
                            "what": f"how many times the loop in \"{wf.get('name')}\" repeats",
                            "why": "A loop repeats over its input, which does not exist yet."})
                    if "condition" in plan_types:
                        unknowns.append({
                            "what": f"which branch \"{wf.get('name')}\" takes",
                            "why": "A condition routes on data produced during the run."})
                    if "intelligence" in node_classes:
                        unknowns.append({
                            "what": f"what the AI nodes in \"{wf.get('name')}\" produce",
                            "why": "A model's output is not predictable, and neither is what a branch does with it."})
                    if not report.get("offlineCapable"):
                        unknowns.append({
                            "what": f"the responses \"{wf.get('name')}\" gets from external services",
                            "why": "A network call's result is not knowable in advance."})
                except Exception as exc:
                    planned["workflow"] = {"workflowId": wid,
                                           "workflowName": wf.get("name", ""),
                                           "dryRun": None, "error": str(exc)}

        actions.append(planned)
        prior_continues = action.get("continueOnError") is True

    # ── verdict ─────────────────────────────────────────────────────
    if issues:
        unattended = _known(False, f"This rule cannot run: {issues[0]['message']}")
    elif denials:
        unattended = _known(False, f"{len(denials)} action{'s' if len(denials) != 1 else ''} would be refused by policy.")
    elif approvals_required:
        unattended = _known(False, f"{len(approvals_required)} action{'s' if len(approvals_required) != 1 else ''} would stop and ask you.")
    elif accepted["certainty"] == "known" and accepted["value"] is False:
        unattended = _known(False, accepted["reason"])
    elif (outcome["certainty"] == "known" and outcome["value"] is True
          and accepted["certainty"] == "known"):
        unattended = _known(True, "Nothing in this rule needs a person, and nothing is refused.")
    else:
        unattended = _conditional(
            "Nothing needs a person, provided the trigger fires and the conditions pass.",
            "the trigger and the conditions")

    return {
        "ruleId": rule.get("id"),
        "ruleName": rule.get("name"),
        "enabled": rule.get("enabled", True),
        "at": datetime.now().astimezone().isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "issues": issues,
        "trigger": {"type": trigger.get("type"), "accepted": accepted,
                    **({"schedule": schedule_info} if schedule_info else {})},
        "conditions": {"outcome": outcome, "evaluations": evaluations},
        "actions": actions,
        "capabilitiesRequested": sorted(capabilities_requested),
        "approvalsRequired": approvals_required,
        "denials": denials,
        "wouldRunUnattended": unattended,
        "unknowns": unknowns,
        "sideEffects": {
            "automationRunsCreated": 0, "workflowRunsCreated": 0,
            "invocations": 0, "approvalsCreated": 0, "filesWritten": 0,
            "note": "A rule dry run evaluates conditions and policy. It creates no run, invokes no capability, opens no approval and writes nothing.",
        },
    }
