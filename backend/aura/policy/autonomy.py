"""Workspace-scoped autonomous execution.

Why this exists: ``agent.delegate`` is declared ``risk: high`` +
``irreversible: true`` because an UNBOUNDED delegation lets the worker
touch anything. That floor is correct for the open case — and it is also
why asking AURA to build a website inside an explicitly approved project
parked on an approval gate instead of working.

The distinction this module draws, and the ONLY distinction the policy
engine honors:

* unbounded delegation (no scope, or scope outside the approved project,
  or no explicit user opt-in) → floors hold, approval stays required;
* scope-CONFINED routine work inside a project the user explicitly put
  into autonomous mode → the blast radius is bounded by the project root
  plus post-hoc verification, so the Fabric may auto-execute.

The grant is built server-side on every invocation from the autonomy
store (explicit per-project opt-in) plus path checks against the
project's registered root. It is never user config, never agent input,
and never weakens deny decisions or destructive/human-only floors.
"""

from __future__ import annotations

import os
from typing import Any

from ..config import aura_path
from ..jsonutil import read_json_file, write_json_atomic

AUTONOMY_FILE = "autonomy.json"

#: Capabilities a workspace grant may EVER cover. Everything else —
#: git history, publishing, network calls, installs, approvals — keeps
#: its existing decision no matter what the grant says.
ROUTINE_CAPABILITIES = frozenset({
    "agent.delegate",
    "filesystem.write",
    "terminal.execute",
})

#: Path parts (lowercased) that change real coding-agent configuration.
#: A worker rewriting these rewrites how agents behave — always approval.
AGENT_CONFIG_PARTS = frozenset({
    ".claude", ".codex", ".opencode", "opencode.json", "opencode.jsonc",
    ".aider.conf.yml", ".aider.model.settings.yml", "agents.md",
})

#: Basename rules for credential material (case-insensitive).
_CRED_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".asc", ".gpg", ".kdbx")


def _is_credential_path(rel: str) -> bool:
    low = rel.replace("\\", "/").lower()
    base = low.rsplit("/", 1)[-1]
    if base == ".env" or base.startswith(".env."):
        return True
    if base.endswith(_CRED_SUFFIXES):
        return True
    parts = low.split("/")
    if ".ssh" in parts:
        return True
    for needle in ("credential", "secret", "passwd", "private_key",
                   "id_rsa", "id_ed25519", "api_key", "apikey", "auth_token"):
        if needle in low:
            return True
    return False


def _is_agent_config_path(rel: str) -> bool:
    parts = rel.replace("\\", "/").lower().split("/")
    return any(p in AGENT_CONFIG_PARTS for p in parts)


def _confine(root: str, rel: str) -> str | None:
    """Absolute confined path, or None when it escapes the root.

    Mirrors the executor's ``inside()`` semantics (realpath + normcase)
    so the grant check and the enforcement check agree.
    """
    if "~" in rel:
        return None
    real_root = os.path.realpath(os.path.abspath(root))
    abs_ = os.path.realpath(os.path.abspath(os.path.join(real_root, rel)))
    if os.path.normcase(abs_) != os.path.normcase(real_root) and not \
            os.path.normcase(abs_).startswith(os.path.normcase(real_root + os.sep)):
        return None
    return abs_


class AutonomyStore:
    """Per-project autonomous-mode opt-in. Server-side, user-explicit.

    Stored in ``AURA_HOME/autonomy.json`` — deliberately NOT in
    ``projects.json``, whose bare-array shape is a cross-service contract
    with the TypeScript oracle that would drop unknown keys on rewrite.
    Absent file, absent project, or malformed entry all read as disabled.
    """

    def __init__(self, home: str | os.PathLike[str] | None = None) -> None:
        base = aura_path() if home is None else str(home)
        self._file = os.path.join(base, AUTONOMY_FILE)

    def _load(self) -> dict[str, Any]:
        data = read_json_file(self._file, {})
        return data if isinstance(data, dict) else {}

    def is_enabled(self, project_id: str) -> bool:
        rec = self._load().get(project_id)
        return bool(isinstance(rec, dict) and rec.get("enabled") is True)

    def scope_root(self, project_id: str) -> str | None:
        rec = self._load().get(project_id)
        root = rec.get("scopeRoot") if isinstance(rec, dict) else None
        return root if isinstance(root, str) and root else None

    def set_enabled(self, project_id: str, enabled: bool,
                    scope_root: str | None = None) -> dict[str, Any]:
        from datetime import UTC, datetime
        data = self._load()
        if enabled:
            data[project_id] = {
                "enabled": True,
                "enabledAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "scopeRoot": scope_root or "",
            }
        else:
            data.pop(project_id, None)
        write_json_atomic(self._file, data)
        return {"projectId": project_id, "autonomous": enabled,
                "scopeRoot": scope_root or ""}


# ── dev-command allowlist ─────────────────────────────────────────────
# terminal.execute already rejects shell operators, non-allowlisted
# binaries and installs (parse_command). This SECOND layer decides which
# of those pre-bounded commands count as routine dev work.

_DEV_SUBCOMMANDS: dict[str, frozenset[str] | None] = {
    # binary -> allowed argv[1] values; None = binary alone only.
    "npm": frozenset({"run", "test", "t", "exec"}),
    "npx": frozenset({"tsc", "vitest", "eslint", "vite", "playwright"}),
    "pytest": frozenset(),      # any args: test runner, confined cwd
    "cargo": frozenset({"test", "build", "check", "clippy", "fmt"}),
    "go": frozenset({"test", "build", "vet", "fmt"}),
    "git": frozenset({"status", "diff", "log", "branch", "show", "rev-parse", "ls-files"}),
    "ls": frozenset(),
    "node": None,               # script path checked separately
    "python3": None,            # -m pytest / script path checked separately
}

_NPX_FORBIDDEN_FLAGS = frozenset({"-p", "--package", "--yes", "-y", "--quiet"})


def _dev_command_ok(command: str, root: str) -> bool:
    parts = (command or "").strip().split()
    if not parts:
        return False
    binary, args = parts[0], parts[1:]
    if binary not in _DEV_SUBCOMMANDS:
        return False
    low_args = [a.lower() for a in args]
    # Publishing / installing / destructive subcommands are never routine,
    # even though parse_command already refuses installers (defense in depth).
    for bad in ("install", "publish", "deploy", "login", "pack",
                "uninstall", "remove", "rm", "push", "clean"):
        if bad in low_args:
            return False
    if binary == "npm":
        # `npm run <script>` runs the project's own scripts — ordinary dev
        # work inside an opted-in project. Bare `npm run` lists scripts.
        return bool(args) and args[0].lower() in ("run", "test", "t", "exec")
    if binary == "npx":
        if not args or args[0] not in _DEV_SUBCOMMANDS["npx"]:
            return False
        return not any(f in args for f in _NPX_FORBIDDEN_FLAGS)
    if binary == "node":
        return len(args) == 1 and args[0].endswith((".js", ".mjs", ".cjs")) \
            and _confine(root, args[0]) is not None \
            and not _is_credential_path(args[0]) and not _is_agent_config_path(args[0])
    if binary == "python3":
        if args[:2] == ["-m", "pytest"]:
            return True
        return len(args) == 1 and args[0].endswith(".py") \
            and _confine(root, args[0]) is not None \
            and not _is_credential_path(args[0]) and not _is_agent_config_path(args[0])
    allowed = _DEV_SUBCOMMANDS[binary]
    if allowed is not None and args and args[0].lower() not in allowed:
        # `ls`/`pytest` bare or with paths/flags is fine; git/cargo/go need
        # a known read-only-or-build subcommand.
        if binary in ("ls", "pytest"):
            pass
        else:
            return False
    # Path arguments must stay inside the project.
    for a in args:
        if a.startswith("-"):
            continue
        if "/" in a or "\\" in a or a in (".", "..") or a.startswith("."):
            if _confine(root, a) is None:
                return False
            if _is_credential_path(a) or _is_agent_config_path(a):
                return False
    return True


def _scopes_confine(scopes: list[str], root: str) -> bool:
    if not scopes:
        return False
    for s in scopes:
        if not isinstance(s, str) or not s.strip():
            return False
        if _confine(root, s.strip()) is None:
            return False
        if _is_credential_path(s) or _is_agent_config_path(s):
            return False
    return True


def build_grant(capability_id: str, invocation_input: dict[str, Any],
                context: dict[str, Any], *, project_root: str | None,
                autonomous: bool) -> dict[str, Any] | None:
    """Server-side autonomy grant for ONE invocation, or None.

    Every None below is a deliberate refusal: no opt-in, no project, no
    root, non-routine capability, unconfined scope, credential or agent-
    config paths, non-dev commands. The caller (invoke path) supplies
    project_root from the registry and autonomous from the store; the
    agent's own input can never manufacture a grant.
    """
    if not autonomous or not project_root:
        return None
    project_id = context.get("projectId")
    if not project_id or capability_id not in ROUTINE_CAPABILITIES:
        return None
    if not os.path.isdir(project_root):
        return None
    inp = invocation_input or {}

    if capability_id == "agent.delegate":
        scopes = inp.get("scopePaths") or []
        if not isinstance(scopes, list):
            return None
        if not scopes:
            # Unscoped delegation is the unbounded case the floor exists
            # for — no grant. (The planner binds the project scope for
            # autonomous projects before dispatch; see central_agent.)
            return None
        if not _scopes_confine([str(s) for s in scopes], project_root):
            return None
        kind = "delegate-bounded"
    elif capability_id == "filesystem.write":
        path = inp.get("path")
        if not isinstance(path, str) or not path.strip():
            return None
        if _confine(project_root, path.strip()) is None:
            return None
        if _is_credential_path(path) or _is_agent_config_path(path):
            return None
        kind = "write-bounded"
    elif capability_id == "terminal.execute":
        command = inp.get("command")
        if not isinstance(command, str) or not _dev_command_ok(command, project_root):
            return None
        kind = "dev-command"
    else:
        return None

    return {
        "projectId": project_id,
        "root": os.path.realpath(os.path.abspath(project_root)),
        "kind": kind,
        "capabilities": [capability_id],
    }
