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
    # Command substitution hides the command that actually runs from every
    # check below, so it stays refused. Plain chaining (`;`, `&&`, `||`)
    # does not: each chained part is checked on its own (_command_parts).
    (r"`", False),
    (r"\$\(", False),
)

_CHAIN_SPLIT = _re.compile(r";|&&|\|\||\||\n")


def _command_parts(command: str) -> list[str]:
    """The whole command plus every chained part, each stripped, so a
    pattern anchored at the start of a command also sees `x; rm -rf /`."""
    parts = [p.strip() for p in _CHAIN_SPLIT.split(command)]
    return [command, *[p for p in parts if p]]

_DENY_COMMAND = tuple(
    (_re.compile(p, _re.IGNORECASE), dest)
    for p, dest in _DENY_COMMAND_RES)



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


#: A Windows drive letter followed by a separator. Drive-relative forms
#: (``C:foo``) are NOT absolute and must not be treated as such; only
#: ``C:\\...`` / ``C:/...`` is. Case is preserved (Windows paths are
#: case-insensitive in reality, but treating differing cases as
#: distinct only ever DENIES, never allows, so no bypass is introduced).
_WIN_DRIVE_RE = _re.compile(r"^[A-Za-z]:/")


def _abs_marker(norm: str) -> bool:
    """True when the (slash-normalized) path is absolute on any platform.

    A POSIX absolute path starts with ``/``. A Windows absolute path
    starts with a drive letter followed by a separator (``C:/...``).
    Drive-relative (``C:foo``), UNC (``//host/share``) and bare
    relative paths are handled by their existing branches: UNC begins
    with ``/`` after normalization and resolves against cwd; a
    drive-relative form is treated as relative, which only ever denies
    an in-scope match, never allows one.
    """
    if norm.startswith("/"):
        return True
    return bool(_WIN_DRIVE_RE.match(norm))


def _inside_scope(target: str, scope_paths: list[str],
                  cwd: str = "") -> bool:
    norm = target.replace("\\", "/").strip()
    if not norm or norm.startswith("~"):
        return False
    if _abs_marker(norm):
        # Absolute paths resolve against the task cwd: inside-cwd
        # targets judge by their repo-relative form, outside-cwd
        # targets never qualify. Runtimes routinely pass absolute
        # paths for benign in-repo reads — including Windows
        # drive-letter paths (``C:/repo/work/f.txt``) which are
        # absolute but do not start with a slash.
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


#: Directories whose contents are secret material, matched as whole
#: path segments. `.git` covers the repository metadata directory only.
_SENSITIVE_DIRS = frozenset({".git", ".ssh", ".aws", ".gnupg", ".pki", "secrets"})
#: File names that are secret material, matched on the whole basename.
_SENSITIVE_NAMES = frozenset({
    "id_rsa", "id_ed25519", "credentials", "credentials.json",
    "secrets", "secrets.json",
})
#: File extensions that are key material, matched on the basename suffix.
_SENSITIVE_SUFFIXES = (".pem", ".key")


def _sensitive(target: str) -> str | None:
    """Segment-aware: a path is sensitive only when one of its segments is a
    secret directory, or its basename is a secret file name, a `.env` file,
    or key material. `config.keys.ts` and `credentials_helper.ts` are not."""
    parts = [p for p in target.replace("\\", "/").lower().split("/") if p]
    if not parts:
        return None
    for seg in parts[:-1]:
        if seg in _SENSITIVE_DIRS:
            return seg
    base = parts[-1]
    if base == ".env" or base.startswith(".env."):
        return ".env"
    if base in _SENSITIVE_NAMES or base.startswith("id_rsa") or base.startswith("id_ed25519"):
        return base
    if base.endswith(_SENSITIVE_SUFFIXES):
        return base.rsplit(".", 1)[-1]
    return None


def _sensitive_command(command: str) -> str | None:
    """A command touches secret material when one of its whitespace tokens,
    read as a path, does. Substring matching over the whole command string
    is not used: it blocked ordinary names that merely contain a fragment."""
    for token in command.split():
        seg = _sensitive(token.strip("'\""))
        if seg:
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
        seg = _sensitive_command(command)
        if seg:
            return ActionVerdict(
                DENY,
                f"command touches sensitive material '{seg}'",
                destructive=True)
        parts = _command_parts(command)
        for pattern, destructive in _DENY_COMMAND:
            if any(pattern.search(part) for part in parts):
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
