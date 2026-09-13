"""Per-invocation governance staging — AURA-owned policy on disk.

For each agent.delegate dispatch to a supported worker, AURA writes one
directory (outside the repo cwd, under the AURA home) containing the
runtime's own enforcement wiring, all compiled from the task contract:

  opencode: aura-governance.json (OPENCODE_CONFIG) + plugin/
            aura-governance.ts (OPENCODE_CONFIG_DIR) + actions.jsonl
  kilo:     the SAME bundle under KILO_CONFIG / KILO_CONFIG_DIR —
            verified live against the kilo runtime, not assumed from
            the shared engine lineage
  claude:   scope.json + aura-claude-settings.json (--settings) +
            actions.jsonl (--add-dir flags returned separately)

The worker cannot reach these files through its own tools: they live
outside its cwd, opencode's external_directory guard denies outside
touches, and claude's file tools are confined to --add-dir roots.
Post-hoc snapshot/delta verification still runs underneath.
"""

from __future__ import annotations

import json
import os

from . import claude as _claude
from . import opencode as _opencode

GOV_DIRNAME = "gov"


def gov_dir(home: str, invocation_id: str) -> str:
    safe = "".join(
        c if (c.isalnum() or c in "-_") else "-" for c in invocation_id)[:64]
    return os.path.join(home, GOV_DIRNAME, safe or "inv")


def _write(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def stage_opencode(home: str, *, invocation_id: str, task_id: str,
                   node_id: str, attempt: str, cwd: str,
                   scope_paths: list[str],
                   env_prefix: str = "OPENCODE") -> dict:
    """Write opencode-family governance files. Returns env additions +
    log path.

    ``env_prefix`` selects which runtime reads the bundle. OpenCode and
    Kilo share the same config/plugin surface and the same
    ``tool.execute.before`` interception point, verified independently
    against each runtime — the prefix is the only difference, so one
    staging routine serves both instead of a duplicated adapter."""
    root = gov_dir(home, invocation_id)
    plugin_dir = os.path.join(root, "config-dir", "plugin")
    config_path = os.path.join(root, _opencode.CONFIG_NAME)
    plugin_path = os.path.join(plugin_dir, _opencode.PLUGIN_NAME)
    log_path = os.path.join(root, "actions.jsonl")
    policy = {
        "taskId": task_id,
        "nodeId": node_id,
        "invocationId": invocation_id,
        "attempt": attempt,
        "cwd": cwd,
        "scopePaths": list(scope_paths),
    }
    _write(config_path, json.dumps(
        _opencode.compile_config(scope_paths), indent=2))
    _write(plugin_path, _opencode.compile_plugin(policy))
    _write(log_path, "")
    prefix = (env_prefix or "OPENCODE").strip().upper()
    return {
        "env": {
            f"{prefix}_CONFIG": config_path,
            f"{prefix}_CONFIG_DIR": os.path.join(root, "config-dir"),
            "AURA_ACTION_LOG": log_path,
        },
        "configPath": config_path,
        "pluginPath": plugin_path,
        "logPath": log_path,
        "supports": dict(_opencode.SUPPORTS),
    }


def stage_claude(home: str, *, invocation_id: str, task_id: str,
                 node_id: str, attempt: str, cwd: str,
                 scope_paths: list[str]) -> dict:
    """Write claude governance files. Returns settings path, --add-dir
    roots, env additions, and log path."""
    from .claude_hook import __file__ as _hook_src  # path only

    root = gov_dir(home, invocation_id)
    hook_path = os.path.join(root, _claude.HOOK_NAME)
    scope_path = os.path.join(root, _claude.SCOPE_NAME)
    settings_path = os.path.join(root, _claude.SETTINGS_NAME)
    log_path = os.path.join(root, "actions.jsonl")
    with open(_hook_src, encoding="utf-8") as fh:
        hook_src = fh.read()
    _write(hook_path, hook_src)
    # The hook runs as a COPY under the AURA home, so it cannot find the
    # governance core by walking up from its own file. The root travels
    # in the scope document instead — AURA-owned data the worker cannot
    # reach, resolved once here where the answer is actually known.
    aura_root = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(_hook_src))))
    _write(scope_path, json.dumps({
        "taskId": task_id, "nodeId": node_id,
        "invocationId": invocation_id, "attempt": attempt,
        "cwd": cwd, "scopePaths": list(scope_paths),
        "auraRoot": aura_root,
    }, indent=2))
    _write(settings_path, json.dumps(
        _claude.compile_settings(hook_path, scope_path), indent=2))
    _write(log_path, "")
    try:
        os.chmod(hook_path, 0o755)
    except OSError:
        pass
    return {
        "settingsPath": settings_path,
        "addDirs": _claude.add_dirs(cwd, scope_paths),
        "env": {"AURA_ACTION_LOG": log_path},
        "hookPath": hook_path,
        "scopePath": scope_path,
        "logPath": log_path,
        "supports": dict(_claude.SUPPORTS),
    }


def read_action_log(log_path: str, limit: int = 500) -> list[dict]:
    """Parse the JSONL action log, bounded. Malformed lines are skipped
    (they can never become authority); the file itself stays on disk as
    evidence alongside the audit trail."""
    events: list[dict] = []
    try:
        with open(log_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict):
                    events.append(record)
                if len(events) >= limit:
                    break
    except OSError:
        pass
    return events
