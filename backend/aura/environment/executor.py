"""System install executor — governed installation through the Capability Fabric.

This is the canonical Python implementation of system.install, matching the
TypeScript fabric/executors.ts systemInstall executor.

Security:
  - The nodeId comes from the caller, but the install command comes from
    the catalog. The caller cannot invent a command.
  - Only allow-listed installer binaries can be run (npm, pipx, cargo, gh)
  - No shell interpretation — argv arrays only
  - Privilege escalation (sudo) is only used for guided (root) installs
  - User-space installs go through the Fabric's bounded process execution
"""
from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
from dataclasses import dataclass
from typing import Any

from ..exec_ import INSTALL_TIMEOUT_MS, resolve_installer_binary
from .catalog import catalog_entry
from .install import is_plan, plan_install
from .probe import probe_node


def _process_group_kwargs() -> dict[str, Any]:
    """Put the installer in its own group so the whole tree can be stopped."""
    if sys.platform == "win32":  # pragma: no cover - Windows only
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _terminate_tree(proc: "asyncio.subprocess.Process") -> None:
    """Stop the installer and everything it spawned."""
    if proc.returncode is not None:
        return
    if sys.platform == "win32":  # pragma: no cover - Windows only
        try:
            proc.kill()
        except Exception:
            pass
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except Exception:
            pass


@dataclass
class InstallResult:
    install_outcome: str
    node_id: str
    privilege: str
    requires_user_action: bool
    command: str
    why: str
    exit_code: int | None = None
    timed_out: bool = False
    stdout: str = ""
    detail: str = ""


async def system_install_executor(invocation: dict) -> dict:
    """Execute system.install capability.

    Input: { nodeId: string }
    Context: standard Fabric invocation context
    """
    node_id = _s(invocation.get("input", {}).get("nodeId", "")).strip()
    if not node_id:
        return _no("No node was named, so there is nothing to install.")

    entry = catalog_entry(node_id)
    if entry is None:
        return _no(f"'{node_id}' is not a node in AURA's catalogue, so there is nothing to install.")

    plan = plan_install(entry)
    if not is_plan(plan):
        return _no(plan.reason)

    if plan.privilege == "root":
        result = InstallResult(
            install_outcome="guided",
            node_id=node_id,
            privilege="root",
            requires_user_action=True,
            command=plan.command,
            why=plan.why,
        )
        return {
            "ok": False,
            "detail": f"{entry.name} needs administrator rights to install, so AURA did not run anything. Run this yourself, then re-scan: {plan.command}",
            "output": _install_result_to_dict(result),
        }

    resolved = resolve_installer_binary(plan.bin)
    if not resolved.ok:
        return _no(f"{entry.name} could not be installed: {resolved.reason}")

    timeout_ms = invocation.get("context", {}).get("timeoutMs", INSTALL_TIMEOUT_MS)

    try:
        proc = await asyncio.create_subprocess_exec(
            plan.bin,
            *plan.args,
            cwd=os.environ.get("HOME", "/"),
            # An installer must never block waiting for a confirmation
            # nobody is there to give, and must never reach the operator's
            # terminal to ask for one.
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **_process_group_kwargs(),
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=timeout_ms / 1000
            )
            exit_code = proc.returncode
        except asyncio.TimeoutError:
            # Package managers fan out into child processes; killing only the
            # one we launched leaves those running against the same prefix.
            _terminate_tree(proc)
            await proc.wait()
            result = InstallResult(
                install_outcome="failed",
                node_id=node_id,
                privilege="user",
                requires_user_action=False,
                command=plan.command,
                why="The installer ran out of time and was stopped.",
                exit_code=-1,
                timed_out=True,
                stdout="",
            )
            return {
                "ok": False,
                "detail": f"{entry.name} was not installed. The installer ran out of time and was stopped.",
                "output": _install_result_to_dict(result),
            }
    except FileNotFoundError:
        return _no(f"{entry.name} could not be installed: {plan.bin} is not installed")
    except Exception as e:
        return _no(f"{entry.name} could not be installed: {e}")

    stdout = stdout_bytes.decode("utf-8", errors="replace")[:4000] if stdout_bytes else ""

    if exit_code != 0:
        why = f"The installer exited {exit_code}."
        result = InstallResult(
            install_outcome="failed",
            node_id=node_id,
            privilege="user",
            requires_user_action=False,
            command=plan.command,
            why=why,
            exit_code=exit_code,
            timed_out=False,
            stdout=stdout,
        )
        return {
            "ok": False,
            "detail": f"{entry.name} was not installed. {why} {stdout[:300]}".strip(),
            "output": _install_result_to_dict(result),
        }

    probe_result = probe_node(node_id, refresh=True)
    if not probe_result.present:
        result = InstallResult(
            install_outcome="unverified",
            node_id=node_id,
            privilege="user",
            requires_user_action=True,
            command=plan.command,
            why=f"The installer finished without an error, but {entry.name} still cannot be found on this machine.",
            exit_code=0,
            timed_out=False,
            stdout=stdout,
            detail=probe_result.detail,
        )
        return {
            "ok": False,
            "detail": f"{entry.name} reported a successful install, but AURA still cannot find it, so it is NOT being reported as installed. {probe_result.detail}",
            "output": _install_result_to_dict(result),
        }

    result = InstallResult(
        install_outcome="installed",
        node_id=node_id,
        privilege="user",
        requires_user_action=False,
        command=plan.command,
        why=f"{entry.name} is now installed and available.",
        exit_code=0,
        timed_out=False,
        stdout=stdout,
    )
    return {
        "ok": True,
        "detail": f"{entry.name} was successfully installed and verified.",
        "output": _install_result_to_dict(result),
    }


def _install_result_to_dict(result: InstallResult) -> dict[str, Any]:
    d: dict[str, Any] = {
        "installOutcome": result.install_outcome,
        "nodeId": result.node_id,
        "privilege": result.privilege,
        "requiresUserAction": result.requires_user_action,
        "command": result.command,
        "why": result.why,
    }
    if result.exit_code is not None:
        d["exitCode"] = result.exit_code
    if result.timed_out:
        d["timedOut"] = True
    if result.stdout:
        d["stdout"] = result.stdout
    if result.detail:
        d["detail"] = result.detail
    return d


def _s(v: Any, d: str = "") -> str:
    return v if isinstance(v, str) else d


def _ok(detail: str, output: Any = None) -> dict:
    r: dict[str, Any] = {"ok": True, "detail": detail}
    if output is not None:
        r["output"] = output
    return r


def _no(detail: str) -> dict:
    return {"ok": False, "detail": detail}
