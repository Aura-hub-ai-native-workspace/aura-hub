"""Executors — port of ai-service/fabric/executors.ts (real-effect subset).

Phase-5 registered set: filesystem.list/read/write, terminal.execute,
git.status/diff/branch/commit/push, agent.delegate (refusals + opencode
invocation), http.request, and the ProjectRegistry-backed internal
executors (project.list/create/open/inspect). Capabilities whose backing
subsystem has not migrated (mission.*, knowledge.*, memory.search,
workflow.run, governance.audit, system.install's InstallSpec flow) stay
UNREGISTERED — the Fabric reports `unsupported`, exactly as TypeScript
stays honest about its own 14-executor reality.

Nothing here decides policy. Nothing here grants authority.
"""

from __future__ import annotations

import os
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from ..exec_ import (
    git as run_git,
)
from ..exec_ import (
    parse_command,
    resolve_agent_binary,
    run_agent,
    safe_shell_with_code,
)

MAX_READ_BYTES = 512 * 1024
MAX_HTTP_BYTES = 512 * 1024


def _s(v: Any, d: str = "") -> str:
    return v if isinstance(v, str) else d


def _b(v: Any) -> bool:
    return v is True


def _node_fs_error(e: OSError, verb: str, path_str: str) -> RuntimeError:
    """Node-style fs error text so user-visible details match byte-for-byte."""
    import errno as _e

    if e.errno == _e.ENOENT:
        return RuntimeError(f"ENOENT: no such file or directory, {verb} '{path_str}'")
    if e.errno == _e.ENOTDIR:
        return RuntimeError(f"ENOTDIR: not a directory, {verb} '{path_str}'")
    if e.errno == _e.EISDIR:
        return RuntimeError(f"EISDIR: illegal operation on a directory, read '{path_str}'")
    return e


def inside(root: str, rel: str) -> str:
    root = os.path.abspath(root)
    abs_ = os.path.abspath(os.path.join(root, rel))
    if abs_ != root and not abs_.startswith(root + os.sep):
        raise ValueError(f"That path leaves the project directory: {rel}")
    return abs_


def cwd_of(inv: dict) -> str:
    cwd = inv["context"].get("cwd")
    if not cwd:
        raise RuntimeError("No project directory is set for this invocation. Open a project first.")
    return cwd


def _ok(detail: str, output: Any = None) -> dict:
    r = {"ok": True, "detail": detail}
    if output is not None:
        r["output"] = output
    return r


def _no(detail: str) -> dict:
    return {"ok": False, "detail": detail}


def _pass(kind: str, detail: str) -> dict:
    return {"passed": True, "kind": kind, "detail": detail}


def _fail(kind: str, detail: str) -> dict:
    return {"passed": False, "kind": kind, "detail": detail}


# ── filesystem ───────────────────────────────────────────────────────────────


async def filesystem_list(inv: dict) -> dict:
    root = cwd_of(inv)
    target = inside(root, _s(inv["input"].get("path"), "."))
    try:
        names = sorted(
            (e.name + "/" if e.is_dir() else e.name)
            for e in os.scandir(target))
    except OSError as e:
        raise _node_fs_error(e, "scandir", target) from e
    n = len(names)
    return _ok(f"{n} {'entry' if n == 1 else 'entries'}.", names)


async def filesystem_read(inv: dict) -> dict:
    root = cwd_of(inv)
    target = inside(root, _s(inv["input"].get("path")))
    try:
        size = os.path.getsize(target)
    except OSError as e:
        raise _node_fs_error(e, "stat", target) from e
    if size > MAX_READ_BYTES:
        return _no(f"That file is {round(size / 1024)}KB, over the {MAX_READ_BYTES // 1024}KB read limit. Read a narrower path.")
    try:
        with open(target, "r", encoding="utf-8", errors="strict") as fh:
            text = fh.read()
    except OSError as e:
        raise _node_fs_error(e, "open", target) from e
    return _ok(f"Read {size} bytes.", text)


def _fs_write_verify_target(inv):
    return inside(cwd_of(inv), _s(inv["input"].get("path")))


async def filesystem_write(inv: dict) -> dict:
    root = cwd_of(inv)
    target = inside(root, _s(inv["input"].get("path")))
    content = _s(inv["input"].get("content"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(content)
    rel = os.path.relpath(target, root)
    return _ok(f"Wrote {len(content.encode())} bytes to {rel}.", {"path": target})


async def filesystem_write_verify(inv: dict, _last: dict) -> dict:
    target = _fs_write_verify_target(inv)
    expected = _s(inv["input"].get("content"))
    try:
        with open(target, "r", encoding="utf-8") as fh:
            actual = fh.read()
        return (_pass("read-back", "Read the file back and the contents match exactly.")
                if actual == expected else
                _fail("read-back", "The file exists but its contents differ from what was written."))
    except OSError:
        return _fail("read-back", "The file could not be read back after writing.")


# ── terminal ─────────────────────────────────────────────────────────────────


async def terminal_execute(inv: dict) -> dict:
    cwd = cwd_of(inv)
    command = _s(inv["input"].get("command"))
    parsed = parse_command(command)
    if not parsed.ok:
        return _no(parsed.reason)
    res = await safe_shell_with_code(command, cwd, inv["context"].get("timeoutMs"))
    out_trimmed = res.out[:400]
    if res.code == 0:
        return _ok("Exit code 0.", {"stdout": res.out, "exitCode": 0})
    return {"ok": False, "detail": f"Exit code {res.code}. {out_trimmed}",
            "output": {"stdout": res.out, "exitCode": res.code}}


async def terminal_execute_verify(_inv: dict, result: dict) -> dict:
    exit_code = (result.get("output") or {}).get("exitCode")
    return (_pass("exit-code", "The command exited 0.") if exit_code == 0
            else _fail("exit-code", f"The command exited {exit_code if exit_code is not None else 'unknown'}."))


# ── coding agents ────────────────────────────────────────────────────────────

AGENT_INVOCATIONS = {
    "opencode": {
        "args": lambda task, cwd, model=None: (
            ["run", "--dir", cwd, *(["--model", model] if model else []), task]),
        "verifiedAgainst": "OpenCode 1.18.16",
    },
}
MAX_CONTEXT_CHARS = 12_000


def with_context(task: str, raw_context: str) -> str:
    context = raw_context.strip()
    if not context:
        return task
    body = (context[:MAX_CONTEXT_CHARS]
            + f"\n[context truncated by AURA at {MAX_CONTEXT_CHARS} characters]"
            if len(context) > MAX_CONTEXT_CHARS else context)
    return f"{body}\n\n<TASK>\n{task}\n</TASK>"


def agent_delegate_supports_node(node: dict) -> bool:
    bin_name = node.get("binary")
    return bool(bin_name) and resolve_agent_binary(bin_name).ok and bin_name in AGENT_INVOCATIONS


async def agent_delegate_run(inv: dict) -> dict:
    cwd = cwd_of(inv)
    task = _s(inv["input"].get("task")).strip()
    if not task:
        return _no("No task was given for the agent to carry out.")
    model = _s(inv["input"].get("model")).strip() or None
    brief = with_context(task, _s(inv["input"].get("context")))

    node = inv.get("node")
    if not node:
        return _no("No coding-agent node was resolved for this call, so nothing was run.")
    bin_name = node.get("binary")
    if not bin_name:
        return _no(f"{node['name']} has no executable recorded in the catalogue, so it cannot be run.")
    if not resolve_agent_binary(bin_name).ok:
        return _no(f"{node['name']} is not on the coding-agent allow-list, so it was not run.")
    spec = AGENT_INVOCATIONS.get(bin_name)
    if not spec:
        return _no(
            f"{node['name']} is connected, but AURA has no verified non-interactive invocation for it yet, "
            f"so nothing was run. Verified today: {', '.join(AGENT_INVOCATIONS)}.")

    args = spec["args"](brief, cwd, model)
    try:
        res = await run_agent(bin_name, args, cwd, inv["context"].get("timeoutMs"))
    except Exception as e:  # noqa: BLE001 — TS catches all too
        return _no(f"{node['name']} could not be run: {e}")

    output = {
        "stdout": res.out, "exitCode": res.code, "nodeId": node["id"],
        "agent": node["name"], "args": args,
        "timedOut": bool(res.timedOut), "signal": res.signal,
    }
    if res.code == 0:
        return _ok(f"{node['name']} completed the task. Exit code 0.", output)
    why = (f"{node['name']} ran out of time and was stopped. Its changes, if any, are partial."
           if res.timedOut else
           f"{node['name']} was terminated by {res.signal}." if res.signal else
           f"{node['name']} exited {res.code}.")
    return {"ok": False, "detail": f"{why} {res.out[:400]}".strip(), "output": output}


async def agent_delegate_verify(_inv: dict, result: dict) -> dict:
    exit_code = (result.get("output") or {}).get("exitCode")
    return (_pass("exit-code", "The agent exited 0.") if exit_code == 0
            else _fail("exit-code", f"The agent exited {exit_code if exit_code is not None else 'unknown'}."))


# ── git ──────────────────────────────────────────────────────────────────────


async def git_status(inv: dict) -> dict:
    res = await run_git(["status", "--short", "--branch"], cwd_of(inv))
    return _ok("Working tree has changes." if res.out else "Working tree is clean.",
               res.out or "clean")


async def git_diff(inv: dict) -> dict:
    args = ["diff", "--stat", "-p", "--no-color"]
    if _b(inv["input"].get("staged")):
        args.insert(1, "--cached")
    res = await run_git(args, cwd_of(inv))
    text = res.out if len(res.out) <= 60_000 else res.out[:60_000] + "\n…(truncated)"
    return _ok("Diff produced." if res.out else "No changes.", text or "no changes")


async def git_branch(inv: dict) -> dict:
    cwd = cwd_of(inv)
    name = _s(inv["input"].get("name")).strip()
    if not name:
        res = await run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
        return _ok(f"On branch {res.out}.", res.out)
    existing = await run_git(["rev-parse", "--verify", name], cwd)
    args = ["checkout", name] if existing.code == 0 else ["checkout", "-b", name]
    res = await run_git(args, cwd)
    if res.code != 0:
        return _no(res.out or "Branch operation failed.")
    return _ok(("Switched to " if existing.code == 0 else "Created and switched to ") + name + ".", name)


async def git_branch_verify(inv: dict, _last: dict) -> dict:
    name = _s(inv["input"].get("name")).strip()
    if not name:
        return _pass("read-back", "Reported the current branch.")
    res = await run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd_of(inv))
    return (_pass("read-back", f"HEAD is on {name}.") if res.out == name
            else _fail("read-back", f"Expected to be on {name}, but HEAD is on {res.out}."))


async def git_commit(inv: dict) -> dict:
    cwd = cwd_of(inv)
    message = _s(inv["input"].get("message")).split("\n")[0].strip()
    if not message:
        return _no("A commit message is required.")
    status = await run_git(["status", "--porcelain"], cwd)
    if not status.out:
        return _ok("Nothing to commit — the working tree is clean.", {"committed": False})
    await run_git(["add", "-A"], cwd)
    res = await run_git(["commit", "-m", message], cwd)
    if res.code != 0:
        return _no(res.out or "The commit failed.")
    return _ok(f"Committed: {message}", {"committed": True, "message": message})


async def git_commit_verify(inv: dict, result: dict) -> dict:
    if (result.get("output") or {}).get("committed") is False:
        return _pass("read-back", "Nothing needed committing, so there is nothing to verify.")
    message = _s(inv["input"].get("message")).split("\n")[0].strip()
    res = await run_git(["log", "-1", "--pretty=%s"], cwd_of(inv))
    return (_pass("read-back", "HEAD is the new commit.") if res.out == message
            else _fail("read-back", f'HEAD\'s subject is "{res.out}", not the message that was committed.'))


async def git_push(inv: dict) -> dict:
    cwd = cwd_of(inv)
    remote = _s(inv["input"].get("remote"), "origin")
    branch = _s(inv["input"].get("branch")) or (await run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).out
    res = await run_git(["push", remote, branch], cwd)
    if res.code == 0:
        return _ok(f"Pushed {branch} to {remote}.", {"remote": remote, "branch": branch, "exitCode": 0})
    return {"ok": False, "detail": res.out or "The push failed.", "output": {"exitCode": res.code}}


async def git_push_verify(_inv: dict, result: dict) -> dict:
    exit_code = (result.get("output") or {}).get("exitCode")
    return (_pass("exit-code", "git push exited 0.") if exit_code == 0
            else _fail("exit-code", f"git push exited {exit_code if exit_code is not None else 'unknown'}."))


# ── network ──────────────────────────────────────────────────────────────────


async def http_request(inv: dict) -> dict:
    url = _s(inv["input"].get("url"))
    if not url.lower().startswith(("http://", "https://")):
        return _no("Only http(s) URLs are allowed.")
    timeout_ms = min(inv["context"].get("timeoutMs") or 10_000, 30_000)
    method = (_s(inv["input"].get("method"), "GET")).upper()
    body = inv["input"].get("body")
    data = _s(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)

    class _BoundedReader:
        """Read up to MAX_HTTP_BYTES, mirroring Buffer.slice semantics."""

        def __init__(self, resp):
            self.resp = resp

        def read_bounded(self) -> bytes:
            return self.resp.read(MAX_HTTP_BYTES)

    try:
        import asyncio

        def do():
            with urllib.request.urlopen(req, timeout=timeout_ms / 1000) as resp:
                raw = resp.read(MAX_HTTP_BYTES)
                return resp.status, raw

        status, raw = await asyncio.to_thread(do)
        text = raw.decode("utf-8", errors="replace")
        reason = {200: "OK", 201: "Created", 204: "No Content", 400: "Bad Request",
                  404: "Not Found", 500: "Internal Server Error"}.get(status, "")
        return _ok(f"{status} {reason}".strip(), {"status": status, "text": text})
    except urllib.error.HTTPError as e:
        # urlopen raises non-2xx; Node fetch does NOT — normalize to status output
        raw = e.read(MAX_HTTP_BYTES) if hasattr(e, "read") else b""
        text = raw.decode("utf-8", errors="replace")
        return _ok(f"{e.code} {e.reason}", {"status": e.code, "text": text})
    except urllib.error.URLError as e:
        reason = getattr(getattr(e, "reason", None), "code", None) or getattr(e, "reason", e)
        import socket

        if isinstance(reason, socket.timeout):
            reason = "timeout"
        return _no(f"The request did not complete: {reason}")
    except TimeoutError:
        return _no("The request did not complete: timeout")


async def http_request_verify(_inv: dict, result: dict) -> dict:
    status = (result.get("output") or {}).get("status") or 0
    return (_pass("http-status", f"The endpoint answered {status}.") if 200 <= status < 400
            else _fail("http-status", f"The endpoint answered {status}, which is not a success status."))


# ── AURA internal (registry-backed) ─────────────────────────────────────────


def internal_executors(registry) -> list[dict]:
    """Registry-backed internals only; later-phase subsystems stay unregistered."""

    async def project_list(_inv):
        projects = registry.list_projects()
        n = len(projects)
        return _ok(f"{n} {'project' if n == 1 else 'projects'} registered.", projects)

    async def project_create(inv):
        name = _s(inv["input"].get("name")).strip()
        if not name:
            return _no("A project name is required.")
        parent_path = inv["input"].get("parentPath")
        record = registry.create_project(name=name, parent_path=_s(parent_path) if parent_path is not None else None)
        return _ok(f'Created "{name}".', record)

    async def project_create_verify(inv, _last):
        name = _s(inv["input"].get("name")).strip()
        return (_pass("read-back", "The project is in the registry.")
                if any(p["name"] == name for p in registry.list_projects())
                else _fail("read-back", "The project is not in the registry after creation."))

    async def project_open(inv):
        record = registry.open(_s(inv["input"].get("projectId")))
        return _ok("Project opened.", record)

    async def project_open_verify(inv, _last):
        current = registry.current_project()
        return (_pass("read-back", "It is the active project.")
                if current and current.get("id") == _s(inv["input"].get("projectId"))
                else _fail("read-back", "The active project did not change."))

    async def project_inspect(inv):
        profile = registry.profile(_s(inv["input"].get("projectId")))
        return _ok("Profile read.", profile) if profile else _no("That project has no generated profile yet.")

    return [
        {"capabilityId": "project.list", "run": project_list},
        {"capabilityId": "project.create", "run": project_create, "verify": project_create_verify},
        {"capabilityId": "project.open", "run": project_open, "verify": project_open_verify},
        {"capabilityId": "project.inspect", "run": project_inspect},
    ]


EXECUTOR_TABLE: dict[str, dict] = {
    "filesystem.list": {"run": filesystem_list},
    "filesystem.read": {"run": filesystem_read},
    "filesystem.write": {"run": filesystem_write, "verify": filesystem_write_verify},
    "terminal.execute": {"run": terminal_execute, "verify": terminal_execute_verify},
    "agent.delegate": {"run": agent_delegate_run, "verify": agent_delegate_verify,
                       "supportsNode": agent_delegate_supports_node},
    "git.status": {"run": git_status},
    "git.diff": {"run": git_diff},
    "git.branch": {"run": git_branch, "verify": git_branch_verify},
    "git.commit": {"run": git_commit, "verify": git_commit_verify},
    "git.push": {"run": git_push, "verify": git_push_verify},
    "http.request": {"run": http_request, "verify": http_request_verify},
}


class ExecutorAdapter:
    """Adapts the table to the Fabric's Executor protocol."""

    def __init__(self, capability_id: str, spec: dict) -> None:
        self.capabilityId = capability_id
        self._spec = spec

    def supportsNode(self, node: dict) -> bool:
        fn = self._spec.get("supportsNode")
        return fn(node) if fn else True

    async def run(self, invocation: dict) -> dict:
        try:
            return await self._spec["run"](invocation)
        except (ValueError, RuntimeError) as e:
            return {"ok": False, "detail": str(e)}

    async def verify(self, invocation: dict, result: dict) -> dict:
        fn = self._spec.get("verify")
        return await fn(invocation, result) if fn else {"passed": None, "kind": None,
                                                        "detail": "no verify implemented"}


def all_executors(registry=None) -> list[ExecutorAdapter]:
    adapters = [ExecutorAdapter(cid, spec) for cid, spec in EXECUTOR_TABLE.items()]
    for internal in internal_executors(registry) if registry else []:
        adapters.append(ExecutorAdapter(internal["capabilityId"],
                                        {"run": internal["run"],
                                         **({"verify": internal["verify"]} if internal.get("verify") else {})}))
    return adapters


_ = Callable  # parity note: TS types only
