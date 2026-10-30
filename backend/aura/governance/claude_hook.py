#!/usr/bin/env python3
"""Claude PreToolUse hook — static AURA script, per-invocation scope.

Reads the tool call as JSON on stdin ({tool_name, tool_input}), decides
through aura.governance.actions.decide_action (the SAME deterministic
core as the opencode plugin mirrors), appends a bounded event to
$AURA_ACTION_LOG, and exits 0 (allow) or 2 (deny with stderr reason).

Failure behaviour (fail-closed). A governance failure never authorizes the
operation it was meant to govern; Claude treats only exit 2 as a block, so
every path that cannot reach a verdict exits 2:

  * hook input that is not a JSON object
  * a scope document that EXISTS but cannot be read, is empty or malformed,
    is not a JSON object, or carries fields of the wrong type
  * a governance core that cannot be loaded
  * any unexpected error while deciding
  * any verdict other than an explicit ALLOW

The one allowed exception is a scope document that is genuinely absent (no
path given, or no file at the path): then no per-task scope was staged, the
runtime's own directory confinement (--add-dir) is the boundary, and the call
is recorded as UNSCOPED, not as an allow by the governance core.

No imports beyond stdlib + the governance core. No secrets read, none
persisted: only task/worker/invocation correlation plus the target.
"""

from __future__ import annotations

import json
import os
import sys

_SCALARS = (str, int)


def _record(decision: str, reason: str, payload: dict | None = None,
            scope_doc: dict | None = None) -> None:
    log_path = os.environ.get("AURA_ACTION_LOG", "")
    if not log_path:
        return
    payload = payload if isinstance(payload, dict) else {}
    scope_doc = scope_doc if isinstance(scope_doc, dict) else {}
    try:
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "taskId": scope_doc.get("taskId"),
                "workerNodeId": scope_doc.get("nodeId"),
                "invocationId": scope_doc.get("invocationId"),
                "attemptId": scope_doc.get("attempt"),
                "actionType": "TOOL_CALL",
                "tool": str(payload.get("tool_name") or ""),
                "decision": decision,
                "reason": reason[:200],
                "destructive": False,
            }, default=str) + "\n")
    except OSError:
        pass


def _deny(reason: str, payload: dict | None = None,
          scope_doc: dict | None = None) -> int:
    """Refuse because governance could not decide. Logged as a DENY so the
    record and the exit code agree."""
    full = f"governance unavailable: {reason}"
    _record("DENY", full, payload, scope_doc)
    tool = str((payload or {}).get("tool_name") or "") if isinstance(payload, dict) else ""
    sys.stderr.write(f"AURA denied {tool}: {full}\n")
    return 2


def _validate_scope(doc: object) -> dict:
    """The scope document, or ValueError. Field types are checked here so a
    bad value is a refusal, not an exception later."""
    if not isinstance(doc, dict):
        raise ValueError("scope document is not a JSON object")
    paths = doc.get("scopePaths")
    if paths is not None and not (isinstance(paths, list) and all(isinstance(p, str) for p in paths)):
        raise ValueError("scopePaths must be a list of strings")
    for key in ("cwd", "auraRoot"):
        if doc.get(key) is not None and not isinstance(doc[key], str):
            raise ValueError(f"{key} must be a string")
    for key in ("taskId", "nodeId", "invocationId", "attempt", "at"):
        if doc.get(key) is not None and not isinstance(doc[key], _SCALARS):
            raise ValueError(f"{key} must be a string or number")
    seq = doc.get("seq")
    if seq is not None and (isinstance(seq, bool) or not isinstance(seq, int)):
        raise ValueError("seq must be an integer")
    return doc


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            raise ValueError("hook input is not a JSON object")
    except Exception as exc:
        return _deny(f"hook input unreadable: {exc}")

    if len(sys.argv) < 2:
        _record("UNSCOPED", "no scope document was staged; runtime confinement only", payload)
        return 0
    scope_path = sys.argv[1]
    if not os.path.lexists(scope_path):
        _record("UNSCOPED", "no scope document at the staged path; runtime confinement only", payload)
        return 0
    try:
        with open(scope_path, encoding="utf-8") as fh:
            scope_doc = _validate_scope(json.load(fh))
    except Exception as exc:
        return _deny(f"scope document unusable: {exc}", payload)

    # This file runs as a COPY staged under the AURA home, so walking up
    # from __file__ finds the home directory, not the package. The root
    # is staged into the scope document for exactly that reason; the
    # relative guess stays as a fallback for a hook run in place.
    for root in (str(scope_doc.get("auraRoot") or ""),
                 os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "..", "..")):
        if root and root not in sys.path:
            sys.path.insert(0, root)
    try:
        from aura.governance.actions import (
            FILE_WRITE,
            TaskContract,
            WorkerActionRequest,
            decide_action,
            summarize_event,
        )
    except Exception as exc:
        return _deny(f"governance core could not be loaded: {exc}", payload, scope_doc)

    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return _deny("tool_input is not an object", payload, scope_doc)
    target = str(tool_input.get("file_path") or "")
    req = WorkerActionRequest(
        taskId=str(scope_doc.get("taskId") or ""),
        workerNodeId=str(scope_doc.get("nodeId") or ""),
        invocationId=str(scope_doc.get("invocationId") or ""),
        attemptId=str(scope_doc.get("attempt") or "1"),
        sequence=int(scope_doc.get("seq", 0) or 0),
        actionType=FILE_WRITE,
        tool=str(payload.get("tool_name") or ""),
        target=target,
        cwd=str(scope_doc.get("cwd") or ""),
    )
    contract = TaskContract(
        taskId=req.taskId,
        scopePaths=list(scope_doc.get("scopePaths") or []),
        cwd=req.cwd,
        allowedTools=["Edit", "Write"],
        workerNodeId=req.workerNodeId,
    )
    verdict = decide_action(req, contract)
    log_path = os.environ.get("AURA_ACTION_LOG", "")
    if log_path:
        try:
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(summarize_event(
                    req, verdict,
                    scope_doc.get("at") or "")) + "\n")
        except OSError:
            pass
    if verdict.decision == "ALLOW":
        return 0
    # DENY, or anything that is not an explicit ALLOW, blocks.
    sys.stderr.write(f"AURA denied {req.tool}: {verdict.reason}\n")
    return 2


def _guarded() -> int:
    try:
        return main()
    except Exception as exc:  # noqa: BLE001 — an unexpected error must not allow
        return _deny(f"unexpected {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    sys.exit(_guarded())
