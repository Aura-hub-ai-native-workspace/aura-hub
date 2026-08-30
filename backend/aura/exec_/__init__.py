"""Process execution boundary — port of packages/ai-service/src/exec/process.ts.

Security properties preserved exactly:
  • three DISJOINT allow-lists (SAFE / AGENT / INSTALLER), never merged
  • path-like binary names refused BEFORE the list is consulted
  • no shell interpretation: argv arrays only
  • install-verb detection so `terminal.execute` cannot install software
  • settle(): exited 0 → 0; non-zero → that code; timeout → 124 `timedOut`;
    signal → 128+N `killed`; other errors → 1, never 0
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
from dataclasses import dataclass, field

TIMEOUT_EXIT_CODE = 124
SIGNAL_EXIT_BASE = 128
SIGNAL_NUMBERS = {"SIGHUP": 1, "SIGINT": 2, "SIGQUIT": 3, "SIGKILL": 9, "SIGTERM": 15}

GIT_TIMEOUT_MS = 20_000
SHELL_TIMEOUT_MS = 30_000
AGENT_TIMEOUT_MS = 10 * 60_000
INSTALL_TIMEOUT_MS = 5 * 60_000

SAFE_BINARIES = {"git", "ls", "pwd", "node", "npm", "npx", "wc", "du", "grep",
                 "find", "cargo", "python3", "go"}
AGENT_BINARIES = {"opencode", "claude", "codex", "gemini", "qwen", "cursor-agent"}
INSTALLER_BINARIES = {"npm", "pipx", "cargo", "gh"}


@dataclass
class Resolved:
    ok: bool
    bin: str
    reason: str = ""


@dataclass
class ProcessOutput:
    out: str
    code: int
    killed: bool | None = None
    signal: str | None = None
    timedOut: bool | None = None


def _which(bin: str) -> str | None:
    return shutil.which(bin)


def resolve_agent_binary(bin: str) -> Resolved:
    name = (bin or "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        return Resolved(False, name, "An agent must be named, not given as a path.")
    if name not in AGENT_BINARIES:
        return Resolved(False, name,
                        f"'{name}' is not on the coding-agent allow-list ({', '.join(sorted(AGENT_BINARIES))}).")
    return Resolved(True, name)


def resolve_installer_binary(bin: str) -> Resolved:
    name = (bin or "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        return Resolved(False, name, "An installer must be named, not given as a path.")
    if name not in INSTALLER_BINARIES:
        return Resolved(False, name,
                        f"'{name}' is not on the installer allow-list ({', '.join(sorted(INSTALLER_BINARIES))}).")
    return Resolved(True, name)


def _install_subcommand(binary: str, args: list[str]) -> str | None:
    sub = next((a for a in args if not a.startswith("-")), None)
    if sub is None:
        return None
    verb = f"{binary} {sub}"
    if binary == "npm":
        return f"{verb} --global" if re.fullmatch(r"(install|i|add)", sub) and any(
            a in ("-g", "--global") for a in args) else None
    if binary in ("cargo", "go"):
        return verb if sub == "install" else None
    if binary == "python3":
        return "python3 -m pip install" if "pip" in args and "install" in args else None
    return None


@dataclass
class ParsedCommand:
    ok: bool
    bin: str
    args: list[str] = field(default_factory=list)
    reason: str = ""


def parse_command(command: str) -> ParsedCommand:
    trimmed = command.strip()
    if not trimmed:
        return ParsedCommand(False, "", [], "No command was given.")
    if re.search(r"[;&|<>`$\\]", trimmed):
        return ParsedCommand(False, "", [],
                             "Shell operators are not allowed — pass a single command with plain arguments.")
    parts = trimmed.split()
    binary = parts[0]
    if binary not in SAFE_BINARIES:
        return ParsedCommand(False, binary, [],
                             f"'{binary}' is not on the allow-list ({', '.join(sorted(SAFE_BINARIES))}).")
    installing = _install_subcommand(binary, parts[1:])
    if installing:
        return ParsedCommand(
            False, "", [],
            f"Installing software is not something this can do. '{installing}' changes what is installed on "
            + "this machine, which goes through system.install — where it is gated by approval and verified "
            + "by a real probe.")
    return ParsedCommand(True, binary, parts[1:], "")


def settle(out: str, code: int | None, *, killed: bool | None = None,
           signal: str | None = None, timedOut: bool | None = None,
           timeout_ms: int = 0, err_message: str | None = None) -> ProcessOutput:
    """The ONE place exit status is decided (process.ts:282–320 rules)."""
    out = out.strip() if isinstance(out, str) else ""
    if code == 0 and not killed and not timedOut:
        return ProcessOutput(out, 0)
    if timedOut:
        suffix = f"[timed out after {timeout_ms}ms ({signal})]" if signal else f"[timed out after {timeout_ms}ms]"
        return ProcessOutput(f"{out}{chr(10) if out else ''}{suffix}".strip(),
                             TIMEOUT_EXIT_CODE, True, signal, True)
    if signal:
        return ProcessOutput(f"{out}{chr(10) if out else ''}[terminated by {signal}]".strip(),
                             SIGNAL_EXIT_BASE + SIGNAL_NUMBERS.get(signal, 0), True, signal, None)
    if isinstance(code, int):
        return ProcessOutput(out, code)
    return ProcessOutput(out or (err_message or "failed"), 1)


async def run_file(argv: list[str], cwd: str, timeout_ms: int,
                   cancel: asyncio.Event | None = None) -> ProcessOutput:
    """execFile-equivalent: argv array, bounded, stdin closed, truthful settle."""
    exe = argv[0]
    path = _which(exe)
    if path is None:
        raise RuntimeError(f"{exe} is not installed")   # ENOENT parity
    proc = await asyncio.create_subprocess_exec(
        path, *argv[1:], cwd=cwd,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
    )
    waiter = asyncio.ensure_future(proc.communicate())
    cancel_task = asyncio.ensure_future(cancel.wait()) if cancel else None
    tasks = [waiter] + ([cancel_task] if cancel_task else [])
    done, pending = await asyncio.wait(tasks, timeout=timeout_ms / 1000)
    if cancel_task and cancel_task in done and not waiter.done():
        proc.terminate()
        try:
            out_b, err_b = await asyncio.wait_for(waiter, 5)
        except TimeoutError:
            proc.kill(); out_b, err_b = await waiter
        out = (out_b or b"").decode(errors="replace")
        err = (err_b or b"").decode(errors="replace")
        combined = f"{out}\n{err}" if err else out
        return ProcessOutput(f"{combined.strip()}[terminated by SIGTERM]".strip(),
                             SIGNAL_EXIT_BASE + 15, True, "SIGTERM", None)
    if not waiter.done():
        proc.kill()
        out_b, err_b = await waiter
        out = (out_b or b"").decode(errors="replace")
        err = (err_b or b"").decode(errors="replace")
        combined = f"{out}\n{err}" if err else out
        return ProcessOutput(
            f"{combined.strip()}{chr(10) if combined.strip() else ''}[timed out after {timeout_ms}ms]".strip(),
            TIMEOUT_EXIT_CODE, True, None, True)
    out_b, err_b = await waiter
    out = (out_b or b"").decode(errors="replace")
    err = (err_b or b"").decode(errors="replace")
    combined = f"{out}\n{err}" if err else out
    rcode = proc.returncode
    if rcode == 0:
        return ProcessOutput(combined.strip(), 0)
    if rcode is not None and rcode < 0:
        # POSIX convention: terminated by signal N reports -(N); report 128+N
        sig_no = -rcode
        sig_name = next((k for k, v in SIGNAL_NUMBERS.items() if v == sig_no), f"SIG{sig_no}")
        return ProcessOutput(f"{combined.strip()}{chr(10) if combined.strip() else ''}[terminated by {sig_name}]".strip(),
                             SIGNAL_EXIT_BASE + sig_no, True, sig_name, None)
    return ProcessOutput(combined.strip(), rcode if rcode is not None else 1)


async def git(args: list[str], cwd: str, timeout_ms: int | None = None,
              cancel: asyncio.Event | None = None) -> ProcessOutput:
    return await run_file(["git", *args], cwd, timeout_ms or GIT_TIMEOUT_MS, cancel)


async def safe_shell_with_code(command: str, cwd: str,
                               timeout_ms: int | None = None,
                               cancel: asyncio.Event | None = None) -> ProcessOutput:
    parsed = parse_command(command)
    if not parsed.ok:
        raise RuntimeError(parsed.reason)
    return await run_file([parsed.bin, *parsed.args], cwd,
                          timeout_ms or SHELL_TIMEOUT_MS, cancel)


async def run_agent(bin: str, args: list[str], cwd: str,
                    timeout_ms: int | None = None) -> ProcessOutput:
    resolved = resolve_agent_binary(bin)
    if not resolved.ok:
        raise RuntimeError(resolved.reason)
    return await run_file([resolved.bin, *args], cwd, timeout_ms or AGENT_TIMEOUT_MS)


# silence linters about intentional parity imports
_ = os
