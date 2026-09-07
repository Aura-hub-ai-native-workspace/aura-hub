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

SUPPORTS: FILE_WRITE / FILE_DELETE / FILE_READ (preflight via hook +
directory confinement). COMMAND / PROCESS_SPAWN / NETWORK:
unsupported-by-construction (tool never granted).
"""

from __future__ import annotations

import os

SUPPORTS = {
    "COMMAND": "unsupported",
    "FILE_WRITE": "preflight",
    "FILE_DELETE": "preflight",
    "FILE_READ": "preflight",
    "PROCESS_SPAWN": "unsupported",
    "TOOL_CALL": "allowlist",
    "NETWORK": "unsupported",
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
