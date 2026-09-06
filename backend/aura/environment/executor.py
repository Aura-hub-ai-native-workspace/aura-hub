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
from dataclasses import dataclass
from typing import Any

from ..exec_ import INSTALL_TIMEOUT_MS, resolve_installer_binary
from .catalog import catalog_entry
from .hostplatform import is_windows

#: Installer chatter is kept for diagnosis, but bounded like any other output.
MAX_INSTALL_OUTPUT = 4000
from .install import is_plan, is_uninstall_plan, plan_install, plan_uninstall
from .probe import probe_node


def _process_group_kwargs() -> dict[str, Any]:
    """Put the installer in its own group so the whole tree can be stopped."""
    if is_windows():  # pragma: no cover - exercised via simulate()
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _terminate_tree(proc: "asyncio.subprocess.Process") -> None:
    """Stop the installer and everything it spawned."""
    if proc.returncode is not None:
        return
    if is_windows():  # pragma: no cover - exercised via simulate()
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
class InstallRun:
    """What happened when an installer actually ran."""

    status: str  # ok | failed | timeout | missing | error
    exit_code: int | None = None
    stdout: str = ""
    error: str = ""


async def run_install_plan(plan: Any, *, timeout_ms: int) -> InstallRun:
    """Run one validated install plan under the install-side guarantees.

    The HTTP route and the Fabric capability both install software, and both
    used to spawn the installer themselves. The HTTP copy had drifted: it
    left stdin attached to the operator's terminal and killed only the
    process it started. One implementation means one set of guarantees —
    stdin closed, own process group, whole tree terminated on timeout,
    bounded output — rather than two that agree until someone edits one.
    """
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
    except FileNotFoundError:
        return InstallRun(status="missing", error=f"{plan.bin} is not installed")
    except Exception as exc:
        return InstallRun(status="error", error=str(exc))

    try:
        stdout_bytes, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_ms / 1000)
    except asyncio.TimeoutError:
        # Package managers fan out into child processes; killing only the
        # one we launched leaves those running against the same prefix.
        _terminate_tree(proc)
        try:
            await proc.wait()
        except Exception:
            pass
        return InstallRun(status="timeout", exit_code=-1)
    except Exception as exc:
        _terminate_tree(proc)
        return InstallRun(status="error", error=str(exc))

    stdout = (stdout_bytes or b"").decode("utf-8", errors="replace")[:MAX_INSTALL_OUTPUT]
    code = proc.returncode
    return InstallRun(status="ok" if code == 0 else "failed", exit_code=code, stdout=stdout)


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

    run = await run_install_plan(plan, timeout_ms=timeout_ms)

    if run.status == "missing":
        return _no(f"{entry.name} could not be installed: {run.error}")
    if run.status == "error":
        return _no(f"{entry.name} could not be installed: {run.error}")
    if run.status == "timeout":
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

    exit_code = run.exit_code
    stdout = run.stdout

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


@dataclass
class UninstallResult:
    uninstall_outcome: str
    node_id: str
    privilege: str
    requires_user_action: bool
    command: str
    why: str
    exit_code: int | None = None
    timed_out: bool = False
    stdout: str = ""
    detail: str = ""


async def run_uninstall_plan(plan: Any, *, timeout_ms: int) -> InstallRun:
    """Run one validated uninstall plan under the same guarantees as install.

    Reuses run_install_plan so stdin stays closed, the whole process tree is
    terminated on timeout, and output stays bounded. A removal is not a
    separate execution primitive — only the argv differ.
    """
    return await run_install_plan(plan, timeout_ms=timeout_ms)


async def system_uninstall_executor(invocation: dict) -> dict:
    """Execute system.uninstall capability.

    Input: { nodeId: string }
    Context: standard Fabric invocation context
    """
    node_id = _s(invocation.get("input", {}).get("nodeId", "")).strip()
    if not node_id:
        return _no("No node was named, so there is nothing to uninstall.")

    entry = catalog_entry(node_id)
    if entry is None:
        return _no(f"'{node_id}' is not a node in AURA's catalogue, so there is nothing to uninstall.")

    plan = plan_uninstall(entry)
    if not is_uninstall_plan(plan):
        return _no(plan.reason)

    if plan.privilege == "root":
        result = UninstallResult(
            uninstall_outcome="guided",
            node_id=node_id,
            privilege="root",
            requires_user_action=True,
            command=plan.command,
            why=plan.why,
        )
        return {
            "ok": False,
            "detail": f"{entry.name} needs administrator rights to remove, so AURA did not run anything. Run this yourself, then re-scan: {plan.command}",
            "output": _uninstall_result_to_dict(result),
        }

    resolved = resolve_installer_binary(plan.bin)
    if not resolved.ok:
        return _no(f"{entry.name} could not be uninstalled: {resolved.reason}")

    timeout_ms = invocation.get("context", {}).get("timeoutMs", INSTALL_TIMEOUT_MS)

    run = await run_uninstall_plan(plan, timeout_ms=timeout_ms)

    if run.status == "missing":
        return _no(f"{entry.name} could not be uninstalled: {run.error}")
    if run.status == "error":
        return _no(f"{entry.name} could not be uninstalled: {run.error}")
    if run.status == "timeout":
        result = UninstallResult(
            uninstall_outcome="failed",
            node_id=node_id,
            privilege="user",
            requires_user_action=False,
            command=plan.command,
            why="The uninstaller ran out of time and was stopped.",
            exit_code=-1,
            timed_out=True,
            stdout="",
        )
        return {
            "ok": False,
            "detail": f"{entry.name} was not uninstalled. The uninstaller ran out of time and was stopped.",
            "output": _uninstall_result_to_dict(result),
        }

    exit_code = run.exit_code
    stdout = run.stdout

    if exit_code != 0:
        why = f"The uninstaller exited {exit_code}."
        result = UninstallResult(
            uninstall_outcome="failed",
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
            "detail": f"{entry.name} was not uninstalled. {why} {stdout[:300]}".strip(),
            "output": _uninstall_result_to_dict(result),
        }

    probe_result = probe_node(node_id, refresh=True)
    if probe_result.present:
        result = UninstallResult(
            uninstall_outcome="unverified",
            node_id=node_id,
            privilege="user",
            requires_user_action=True,
            command=plan.command,
            why=f"The uninstaller finished without an error, but {entry.name} can still be found on this machine.",
            exit_code=0,
            timed_out=False,
            stdout=stdout,
            detail=probe_result.detail,
        )
        return {
            "ok": False,
            "detail": f"{entry.name} reported a successful removal, but AURA can still find it, so it is NOT being reported as removed. {probe_result.detail}",
            "output": _uninstall_result_to_dict(result),
        }

    result = UninstallResult(
        uninstall_outcome="uninstalled",
        node_id=node_id,
        privilege="user",
        requires_user_action=False,
        command=plan.command,
        why=f"{entry.name} is now removed.",
        exit_code=0,
        timed_out=False,
        stdout=stdout,
    )
    return {
        "ok": True,
        "detail": f"{entry.name} was successfully uninstalled and verified as absent.",
        "output": _uninstall_result_to_dict(result),
    }


def _uninstall_result_to_dict(result: UninstallResult) -> dict[str, Any]:
    d: dict[str, Any] = {
        "uninstallOutcome": result.uninstall_outcome,
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
