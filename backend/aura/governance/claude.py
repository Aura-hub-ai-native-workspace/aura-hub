"""Claude adapter — AURA-authored runtime enforcement.

Genuine pre-execution boundaries, all owned by the runtime itself:

- `--allowedTools "Edit Write"` (already in the invocation): command
  execution is STRUCTURALLY impossible for this worker — there is no
  Bash tool to intercept because none is granted. COMMAND and
  PROCESS_SPAWN are therefore unsupported-by-construction, not merely
  ungated. NETWORK likewise: no fetch-capable tool is granted.
- `--add-dir <scope dirs>`: the runtime confines file tools to the
  working directories. AURA passes one directory per scope path, so
  out-of-scope writes are refused by Claude Code itself.
- `--settings <file>`: per-invocation settings with a PreToolUse hook
  (matcher Edit|Write) that runs BEFORE the tool call; exit 2 denies
  it with the stderr reason shown to the model. The hook is a static
  AURA script reading a per-invocation scope file — both outside the
  repo cwd, and settings-file writes are runtime-gated to persons /
  permission handlers, not to the model.

SUPPORTS: FILE_WRITE preflight (hook, verified live). FILE_READ by
directory confinement only — the hook matcher is Edit|Write, so reads
never reach it. FILE_DELETE / COMMAND / PROCESS_SPAWN / NETWORK are
not-granted: no tool exists for them, so there is nothing to intercept
and nothing that can happen.
"""

from __future__ import annotations

import os

#: What this wiring actually enforces, stated at the precision the
#: mechanism supports.
#:
#: "preflight"   AURA sees the action and can refuse it before it runs.
#: "confinement" the runtime bounds it; AURA does not see each attempt.
#: "not-granted" the tool does not exist for this worker, so the action
#:               cannot occur at all — stronger than governed, and a
#:               different fact from "AURA cannot govern this".
#: "allowlist"   only named tools may be used.
#:
#: FILE_READ was previously reported as "preflight". It is not: the
#: PreToolUse matcher below is Edit|Write, so a read never reaches the
#: hook. Reads are bounded by --add-dir instead, which is a real
#: boundary but a different one, and observed live — a governed review
#: task read files and produced zero action events.
SUPPORTS = {
    "COMMAND": "not-granted",
    "FILE_WRITE": "preflight",
    "FILE_DELETE": "not-granted",
    "FILE_READ": "confinement",
    "PROCESS_SPAWN": "not-granted",
    "TOOL_CALL": "allowlist",
    "NETWORK": "not-granted",
}

HOOK_NAME = "aura-claude-hook.py"
SETTINGS_NAME = "aura-claude-settings.json"
SCOPE_NAME = "scope.json"


def compile_settings(hook_path: str, scope_path: str) -> dict:
    """Settings JSON wiring the PreToolUse hook for Edit|Write."""
    return {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Edit|Write",
                    "hooks": [{
                        "type": "command",
                        "command": f"python3 {hook_path} {scope_path}",
                    }],
                }
            ]
        }
    }


def add_dirs(cwd: str, scope_paths: list[str]) -> list[str]:
    """Absolute directories confining the worker's file tools. Empty
    scope keeps the repo root (runtime default); every scope path must
    resolve inside the cwd or it is dropped (fail closed)."""
    if not scope_paths:
        return []
    out: list[str] = []
    for scope in scope_paths:
        candidate = os.path.normpath(os.path.join(cwd, scope))
        if candidate == cwd or candidate.startswith(cwd + os.sep):
            out.append(candidate)
    return out
