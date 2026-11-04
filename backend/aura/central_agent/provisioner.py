"""Getting a task the tools it needs — checked, governed, and reported.

When a plan's tasks declare tools they require (``requiresTools``: catalogue
node ids), the coordinator makes sure those tools exist BEFORE the task runs:

  check the machine → already there? reuse it
                    → missing: ask the provisioning guard (allowlisted,
                      non-privileged, catalogue-only)
                    → allowed: install through the governed ``tool.provision``
                      capability (policy, audit, bounded process), re-probe
                    → not allowed / failed: say exactly why, and block only
                      the tasks that needed it

Every step is a real event on the bus. Nothing here installs anything on
its own authority: the install is a Fabric invocation (audited, timed out,
process-group killed) of a capability whose executor enforces the rules in
``environment/provisioning.py``; a model or a caller can only name a
catalogue id. A failed install is never reported as installed, and a task is
resumed only once a fresh probe has found its tool.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..environment.catalog import catalog_entry
from ..environment.provisioning import decide
from .error_knowledge import sanitize
from .quota import classify_failure

#: One retry, and only for failures that are plausibly transient.
MAX_ATTEMPTS = 2
_TRANSIENT = frozenset({"network", "timeout"})


@dataclass
class Need:
    node_id: str
    task_ids: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)


def connect_verified_tool(node_id: str, version: str) -> bool:
    """Record a tool that a FRESH probe has just confirmed as a connected node.

    This is the same record POST /environment/connect writes, so the policy
    host sees the tool exactly as it would after a person connected it. Only
    catalogue local programs are recorded. Workers (AI runtimes) need their
    readiness handshake and are never connected here. Nothing is invented:
    the caller must have a present probe in hand.
    """
    from ..environment.catalog import catalog_entry
    from ..persistence.nodes import ConnectedNodeStore
    from ..workers import is_worker

    entry = catalog_entry(node_id)
    if entry is None or entry.transport != "local-process" or is_worker(node_id):
        return False
    ConnectedNodeStore().register(node_id, entry.name, list(entry.capabilities),
                                  internal=False, version=version or "")
    return True


class Provisioner:
    def __init__(self, invoke: Callable[[str, dict, dict], dict],
                 probe: Callable[[str], Any], emit: Callable[..., None], *,
                 decide_fn: Callable[[object], Any] = decide,
                 sleep: Callable[[float], None] = time.sleep,
                 connect: Callable[[str, str], Any] | None = None) -> None:
        self._invoke = invoke
        self._probe = probe
        self._emit = emit
        self._decide = decide_fn
        # Records a tool a fresh probe confirmed (see connect_verified_tool).
        self._connect = connect
        self._sleep = sleep

    @staticmethod
    def needs_for(plan: Any) -> list[Need]:
        """Tools the plan's tasks declare they need, merged per tool."""
        merged: dict[str, Need] = {}
        for task in getattr(plan, "tasks", []) or []:
            required = getattr(task, "requiresTools", None) or []
            for node_id in required:
                need = merged.setdefault(str(node_id), Need(str(node_id)))
                if task.id not in need.task_ids:
                    need.task_ids.append(task.id)
                reason = f"needed by task {task.id}: {str(task.description)[:100]}"
                if reason not in need.reasons:
                    need.reasons.append(reason)
        return list(merged.values())

    def ensure(self, needs: list[Need], *, session_id: str, request_id: str | None,
               project_id: str | None, should_stop: Callable[[], bool] = lambda: False) -> dict:
        tools: list[dict] = []
        blocked: dict[str, str] = {}
        for need in needs:
            record = self._ensure_one(need, session_id, request_id, project_id, should_stop)
            tools.append(record)
            if record["outcome"] not in ("reused", "installed"):
                for tid in need.task_ids:
                    blocked[tid] = (f"{record['name']} is needed for this task but is not available: "
                                    f"{record['detail']}")
        return {"tools": tools, "blocked": blocked, "ok": not blocked}

    # ── one tool ─────────────────────────────────────────────────────────

    def _mark_connected(self, node_id: str, version: str) -> None:
        """Recording a confirmed tool must never fail the run. If recording
        fails, policy still denies honestly rather than assuming a connection."""
        if self._connect is None:
            return
        try:
            self._connect(node_id, version)
        except Exception:  # noqa: BLE001
            # The run carries on, but a later "not connected" denial needs a
            # visible cause.
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "could not record %s %s as connected", node_id, version, exc_info=True)

    def _ensure_one(self, need: Need, session_id: str, request_id: str | None,
                    project_id: str | None, should_stop: Callable[[], bool]) -> dict:
        entry = catalog_entry(need.node_id)
        name = entry.name if entry else need.node_id
        base = {"nodeId": need.node_id, "name": name, "reason": "; ".join(need.reasons)[:300],
                "tasks": list(need.task_ids)}

        def event(stage: str, **extra: Any) -> None:
            self._emit("tool.provisioning", nodeId=need.node_id, name=name, stage=stage,
                       tasks=list(need.task_ids), **extra)

        event("checking", reason=base["reason"])
        try:
            present = self._probe(need.node_id)
        except Exception:  # noqa: BLE001 — an unreadable probe is "unknown", not "installed"
            present = None
        if present is not None and getattr(present, "present", False):
            version = str(getattr(present, "version", "") or "")
            event("present", version=version)
            self._mark_connected(need.node_id, version)
            return {**base, "outcome": "reused", "version": version,
                    "detail": f"{name} is already installed" + (f" ({version})" if version else "") + "."}

        decision = self._decide(need.node_id)
        if not getattr(decision, "allowed", False):
            code = getattr(decision, "code", "refused")
            event("blocked", code=code, detail=getattr(decision, "reason", ""),
                  command=getattr(decision, "command", None))
            return {**base, "outcome": "blocked", "code": code,
                    "command": getattr(decision, "command", None),
                    "detail": getattr(decision, "reason", "")}

        command = getattr(decision, "command", None)
        context: dict[str, Any] = {"actor": {"kind": "agent", "id": "central-agent:provisioner"},
                                   "projectId": project_id, "sessionId": session_id}
        if request_id:
            context["requestId"] = request_id
        last: dict = {}
        for attempt in range(1, MAX_ATTEMPTS + 1):
            if should_stop():
                event("cancelled")
                return {**base, "outcome": "cancelled", "detail": "Stopped before the install finished."}
            event("installing", command=command, attempt=attempt, method=(command or "").split(" ")[0])
            started = time.monotonic()
            try:
                result = self._invoke("tool.provision", {"nodeId": need.node_id,
                                                         "reason": base["reason"]}, context)
            except Exception as exc:  # noqa: BLE001 — reported, never swallowed
                result = {"outcome": "failed", "detail": f"The install could not run: {type(exc).__name__}",
                          "output": None}
            ms = round((time.monotonic() - started) * 1000)
            output = result.get("output") if isinstance(result.get("output"), dict) else {}
            outcome = str(result.get("outcome"))
            verified = (result.get("verification") or {}).get("passed")
            last = {"outcome": outcome, "ms": ms, "exit": output.get("exitCode"),
                    "tail": sanitize(str(output.get("stdout") or ""), 600),
                    "detail": sanitize(str(result.get("detail") or ""), 400)}
            if outcome == "succeeded" and verified is not False:
                # Independent confirmation: a fresh probe, not the installer's word.
                try:
                    now = self._probe(need.node_id)
                except Exception:  # noqa: BLE001
                    now = None
                if now is not None and getattr(now, "present", False):
                    version = str(getattr(now, "version", "") or "")
                    event("installed", durationMs=ms, exitCode=last["exit"], version=version,
                          outputTail=last["tail"], attempt=attempt)
                    self._mark_connected(need.node_id, version)
                    return {**base, "outcome": "installed", "version": version, "durationMs": ms,
                            "exitCode": last["exit"], "command": command, "attempt": attempt,
                            "detail": f"{name} was installed and a fresh probe confirmed it."}
                last["detail"] = "The installer finished but a fresh probe still cannot find the tool."
                break  # an installer that "worked" without the tool appearing will not on retry
            klass = classify_failure(last["detail"] + " " + last["tail"],
                                     timed_out=bool(output.get("timedOut")), exit_code=last["exit"])
            if klass not in _TRANSIENT or attempt == MAX_ATTEMPTS:
                break
            event("retrying", reason=klass, attempt=attempt)
            self._sleep(1.0)
        event("failed", durationMs=last.get("ms"), exitCode=last.get("exit"),
              detail=last.get("detail"), outputTail=last.get("tail"))
        return {**base, "outcome": "failed", "command": command, "exitCode": last.get("exit"),
                "durationMs": last.get("ms"), "outputTail": last.get("tail"),
                "detail": last.get("detail") or f"{name} could not be installed."}


__all__ = ["MAX_ATTEMPTS", "Need", "Provisioner"]
