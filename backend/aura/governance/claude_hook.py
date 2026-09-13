#!/usr/bin/env python3
"""Claude PreToolUse hook — static AURA script, per-invocation scope.

Reads the tool call as JSON on stdin ({tool_name, tool_input}), decides
through aura.governance.actions.decide_action (the SAME deterministic
core as the opencode plugin mirrors), appends a bounded event to
$AURA_ACTION_LOG, and exits 0 (allow) or 2 (deny with stderr reason).

No imports beyond stdlib + the governance core. No secrets read, none
persisted: only task/worker/invocation correlation plus the target.
"""

from __future__ import annotations

import json
import os
import sys


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        return 0  # unreadable hook input fails open to the runtime's own
        # confinement (--add-dir); never invent a denial from a parse error
    if len(sys.argv) < 2:
        return 0
    try:
        with open(sys.argv[1], encoding="utf-8") as fh:
            scope_doc = json.load(fh)
    except Exception:
        return 0
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
        # Fail open to the runtime's own confinement (--add-dir), but
        # NEVER silently: an unenforced hook that logs nothing would let
        # the run be reported as governed when it was not.
        log_path = os.environ.get("AURA_ACTION_LOG", "")
        if log_path:
            try:
                with open(log_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps({
                        "taskId": scope_doc.get("taskId"),
                        "workerNodeId": scope_doc.get("nodeId"),
                        "invocationId": scope_doc.get("invocationId"),
                        "attemptId": scope_doc.get("attempt"),
                        "actionType": "TOOL_CALL",
                        "tool": str(payload.get("tool_name") or ""),
                        "decision": "UNAVAILABLE",
                        "reason": f"governance core unavailable: {exc}"[:200],
                        "destructive": False,
                    }) + "\n")
            except OSError:
                pass
        return 0

    tool_input = payload.get("tool_input") or {}
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
    if verdict.decision == "DENY":
        sys.stderr.write(f"AURA denied {req.tool}: {verdict.reason}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
