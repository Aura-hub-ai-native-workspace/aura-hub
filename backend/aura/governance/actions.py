"""Worker action model + deterministic governance decision.

WorkerActionRequest carries an externally actionable operation to the
EXISTING authority machinery (task contract, scope, cwd, allow-lists).
decide_action is pure and local: no model, no network, no I/O —
microseconds per action, so the hot path never waits on reasoning.
A deviation is reasoned about LATER by the Central Agent correction
loop, never inside the decision.

Action categories reflect what runtimes can genuinely observe:
- FILE_WRITE / FILE_DELETE / FILE_READ: structured tool args (fully
  mediated pre-execution where the runtime exposes tool hooks).
- COMMAND: argv/pattern policy pre-execution (best-effort — shell
  strings cannot be fully mediated) + post-hoc delta verification.
- PROCESS_SPAWN: covered through COMMAND argv policy.
- TOOL_CALL: other named tools, allow-listed per worker.
- NETWORK: UNSUPPORTED — no runtime here exposes network interception;
  capability gating stays the boundary. Never claim otherwise.
"""

from __future__ import annotations

import re as _re
from dataclasses import dataclass, field

# Categories a runtime may genuinely observe. Support is declared per
# worker adapter (see adapters' SUPPORTS maps) — never assumed.
COMMAND = "COMMAND"
FILE_WRITE = "FILE_WRITE"
FILE_DELETE = "FILE_DELETE"
FILE_READ = "FILE_READ"
PROCESS_SPAWN = "PROCESS_SPAWN"
TOOL_CALL = "TOOL_CALL"
NETWORK = "NETWORK"

ALLOW = "ALLOW"
DENY = "DENY"

#: Destructive argv patterns denied pre-execution for COMMAND actions.
#: Best-effort layer over argv-only execution (the executor allow-list
#: and post-hoc delta verification stay active underneath).
#: (pattern, destructive). Stacking/substitution (;, backticks, $())
#: is refused as a unit but NON-destructive — runtimes and workers emit
#: such commands in benign recon, so the call is denied and the worker
#: adapts. Self-termination is reserved for attempts that signal
#: boundary-probing or exfiltration (sensitive paths, destructive
#: verbs, privilege escalation, pipe-to-shell, remote shells).
_DENY_COMMAND_RES = (
    (r"(^|\s)(rm\s+(-[^ ]*\s+)*-(r|R|f).*(/|\*)|rm\s+-rf?\s+/)", True),
    (r"(^|\s)(mkfs|dd\s+|shutdown|reboot|halt|poweroff)\b", True),
    (r"(^|\s)(sudo|su|doas|runas)\b", True),
    (r"(^|\s)(chmod|chown)\b", True),
    (r"\|\s*(sh|bash|zsh|fish)\b", True),
    (r"(curl|wget)\b.*\|\s*(sh|bash)\b", True),
    (r"(^|\s)(nc|ncat|netcat|ssh|scp)\b", True),
    (r"(^|\s)(nohup|setsid|daemon)\b", False),
    (r";", False),
    (r"`", False),
    (r"\$\(", False),
)

_DENY_COMMAND = tuple(
    (_re.compile(p, _re.IGNORECASE), dest)
    for p, dest in _DENY_COMMAND_RES)


#: Sensitive path segments never readable/writable through governed tools.
_SENSITIVE_SEGMENTS = (".env", ".git/", ".ssh/", ".aws/", "secrets",
                       ".gnupg", ".pki", "id_rsa", "id_ed25519", ".pem",
                       ".key", "credentials")

@dataclass
class WorkerActionRequest:
    """One externally actionable operation. Correlation is mandatory:
    no anonymous worker actions."""

    taskId: str
    workerNodeId: str
    invocationId: str
    attemptId: str
    sequence: int
    actionType: str
    # What is being acted on (all optional, bounded, secret-free):
    tool: str = ""          # tool identifier, e.g. "edit", "bash"
    argv: list[str] = field(default_factory=list)
    command: str = ""       # raw command string where the runtime gives one
    target: str = ""        # file path / URL / process spec
    cwd: str = ""


@dataclass
class TaskContract:
    """The authority already granted for this task. Restated per action —
    the worker can never widen it through action parameters."""

    taskId: str
    scopePaths: list[str] = field(default_factory=list)
    cwd: str = ""
    allowedTools: list[str] = field(default_factory=list)
    workerNodeId: str = ""


@dataclass
class ActionVerdict:
    decision: str  # ALLOW | DENY
    reason: str = ""
    destructive: bool = False  # hard violation: stop the worker, not just
    # the action (the runtime self-terminates on these)


def _inside_scope(target: str, scope_paths: list[str],
                  cwd: str = "") -> bool:
    norm = target.replace("\\", "/").strip()
    if not norm or norm.startswith("~"):
        return False
    if norm.startswith("/"):
        # Absolute paths resolve against the task cwd: inside-cwd
        # targets judge by their repo-relative form, outside-cwd
        # targets never qualify. Runtimes routinely pass absolute
        # paths for benign in-repo reads.
        base = cwd.replace("\\", "/").rstrip("/")
        if not base or not (norm == base or norm.startswith(base + "/")):
            return False
        norm = norm[len(base):].lstrip("/")
        if not norm:
            return True  # the cwd root itself: reading, not writing
    parts = norm.split("/")
    if ".." in parts or "." in parts or "" in parts:
        return False
    if not scope_paths:
        return True
    return any(norm == s.rstrip("/") or norm.startswith(s.rstrip("/") + "/")
               for s in scope_paths)


def _sensitive(target: str) -> str | None:
    lowered = target.replace("\\", "/").lower()
    for seg in _SENSITIVE_SEGMENTS:
        if seg in lowered:
            return seg
    return None


def decide_action(req: WorkerActionRequest,
                  contract: TaskContract) -> ActionVerdict:
    """Deterministic ALLOW/DENY for one action. Fails closed: anything
    malformed, uncorrelated, out of contract, or outside scope is DENY."""
    if req.taskId != contract.taskId:
        return ActionVerdict(DENY, "action names a different task")
    if contract.workerNodeId and req.workerNodeId != contract.workerNodeId:
        return ActionVerdict(DENY, "action names a different worker")
    if not req.invocationId or not req.attemptId or req.sequence < 0:
        return ActionVerdict(DENY, "action lacks correlation identity")
    if req.actionType == NETWORK:
        return ActionVerdict(
            DENY, "network actions are unsupported by governed workers")
    if contract.allowedTools and req.tool \
            and req.tool not in contract.allowedTools:
        return ActionVerdict(
            DENY, f"tool '{req.tool}' is not allowed for this task")

    if req.actionType in (FILE_WRITE, FILE_DELETE, FILE_READ):
        if not req.target:
            return ActionVerdict(DENY, "file action names no target")
        seg = _sensitive(req.target)
        if seg:
            return ActionVerdict(
                DENY, f"target touches sensitive material '{seg}'",
                destructive=True)
        if not _inside_scope(req.target, contract.scopePaths,
                             contract.cwd):
            return ActionVerdict(
                DENY,
                f"target '{req.target}' is outside the task scope",
                destructive=req.actionType != FILE_READ)
        return ActionVerdict(ALLOW, "target inside task scope")

    if req.actionType in (COMMAND, PROCESS_SPAWN):
        command = req.command or " ".join(req.argv)
        if not command.strip():
            return ActionVerdict(DENY, "empty command")
        seg = _sensitive(command)
        if seg:
            return ActionVerdict(
                DENY,
                f"command touches sensitive material '{seg}'",
                destructive=True)
        for pattern, destructive in _DENY_COMMAND:
            if pattern.search(command):
                return ActionVerdict(
                    DENY,
                    f"command matches denied pattern "
                    f"'{pattern.pattern[:40]}'",
                    destructive=destructive)
        return ActionVerdict(ALLOW, "command passes argv policy")

    if req.actionType == TOOL_CALL:
        # Named-tool allow-list is the whole check; the runtime mediates.
        return ActionVerdict(ALLOW, "tool allowed for this task")

    return ActionVerdict(
        DENY, f"unknown action type '{req.actionType}'")


def summarize_event(req: WorkerActionRequest, verdict: ActionVerdict,
                    at: str) -> dict:
    """Bounded, secret-free event record for the action log / bus."""
    def _clip(value: str, limit: int = 500) -> str:
        return value if len(value) <= limit else value[:limit] + "…"

    return {
        "taskId": req.taskId,
        "workerNodeId": req.workerNodeId,
        "invocationId": req.invocationId,
        "attemptId": req.attemptId,
        "sequence": int(req.sequence),
        "at": at,
        "actionType": req.actionType,
        "tool": _clip(req.tool, 64),
        "target": _clip(req.target),
        "command": _clip(req.command),
        "decision": verdict.decision,
        "reason": _clip(verdict.reason, 200),
        "destructive": bool(verdict.destructive),
    }
