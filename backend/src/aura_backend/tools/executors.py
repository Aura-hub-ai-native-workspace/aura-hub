"""The real implementations behind the manifest.

A port of the machine-facing half of
packages/ai-service/src/fabric/executors.ts.

Every executor here delegates to something that already exists: the
Phase 6 execution layer for spawning, the Phase 8 catalogue and scanner
for node knowledge. Nothing is reimplemented.

Only capabilities registered here can actually run. Everything else in the
manifest resolves to `unsupported` at call time, which is how a 33-entry
capability list stays honest about a 12-executor reality.

Verification is real where a read-back exists: a written file by reading
it back, a committed file by `git log`, a command by its exit code, an
HTTP call by its status. Where no check exists the executor omits
`verify` and the Fabric reports "no mechanical check" rather than a pass.

**The ten AURA-internal executors are deliberately absent.** They delegate
to the workspace manager, which is Phase 3 and not yet migrated. Adding
stubs would make the manifest lie about what can run; leaving them out
means they report `unsupported`, which is true.
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any

import httpx

from ..environment.catalog import catalog_entry
from ..environment.scanner import EnvironmentScanner
from ..execution import (
    ProcessNotInstalled,
    ProcessRefused,
    SpawnOptions,
    git,
    parse_command,
    plan_install,
    resolve_agent_binary,
    run_agent,
    run_installer,
    safe_shell_with_code,
)
from ..execution.install import InstallPlan, InstallSpec
from ..fabric.types import ExecutorResult, Invocation, VerificationReport

MAX_READ_BYTES = 512 * 1024
MAX_HTTP_BYTES = 512 * 1024
MAX_DIFF_CHARS = 60_000

_HTTP_URL = re.compile(r"^https?://", re.IGNORECASE)


def _s(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) else default


def _b(value: Any) -> bool:
    return value is True


def _ok(detail: str, output: Any = None) -> ExecutorResult:
    return ExecutorResult(ok=True, detail=detail, output=output)


def _no(detail: str) -> ExecutorResult:
    return ExecutorResult(ok=False, detail=detail)


def _pass(kind, detail: str) -> VerificationReport:
    return VerificationReport(passed=True, kind=kind, detail=detail)


def _fail(kind, detail: str) -> VerificationReport:
    return VerificationReport(passed=False, kind=kind, detail=detail)


def inside(root: str, rel: str) -> Path:
    """Resolve a caller path INSIDE a root; reject traversal.

    Both sides are resolved before comparison, so a symlink or a `..`
    cannot walk out of the project by taking a route the string form does
    not show.
    """
    base = Path(root).resolve()
    target = (base / rel).resolve()
    if target != base and base not in target.parents:
        raise ValueError(f"That path leaves the project directory: {rel}")
    return target


def cwd_of(inv: Invocation) -> str:
    """The directory an invocation operates in, or a clear failure.

    Resolved by the host from the project registry — never supplied by
    the caller.
    """
    cwd = inv.context.cwd
    if not cwd:
        raise ValueError(
            "No project directory is set for this invocation. Open a project first."
        )
    return cwd


# ══════════════════════════════════════════════════════════════════
#  Filesystem
# ══════════════════════════════════════════════════════════════════


class FilesystemList:
    capability_id = "filesystem.list"

    async def run(self, inv: Invocation) -> ExecutorResult:
        target = inside(cwd_of(inv), _s(inv.input.get("path"), "."))
        entries = await asyncio.to_thread(lambda: sorted(os.scandir(target), key=lambda e: e.name))
        names = sorted(f"{e.name}/" if e.is_dir() else e.name for e in entries)
        return _ok(f"{len(names)} {'entry' if len(names) == 1 else 'entries'}.", names)


class FilesystemRead:
    capability_id = "filesystem.read"

    async def run(self, inv: Invocation) -> ExecutorResult:
        target = inside(cwd_of(inv), _s(inv.input.get("path")))
        size = await asyncio.to_thread(lambda: target.stat().st_size)
        if size > MAX_READ_BYTES:
            return _no(
                f"That file is {round(size / 1024)}KB, over the "
                f"{MAX_READ_BYTES // 1024}KB read limit. Read a narrower path."
            )
        text = await asyncio.to_thread(target.read_text, "utf-8")
        return _ok(f"Read {size} bytes.", text)


class FilesystemWrite:
    capability_id = "filesystem.write"

    async def run(self, inv: Invocation) -> ExecutorResult:
        root = cwd_of(inv)
        target = inside(root, _s(inv.input.get("path")))
        content = _s(inv.input.get("content"))

        def write() -> int:
            target.parent.mkdir(parents=True, exist_ok=True)
            data = content.encode("utf-8")
            target.write_bytes(data)
            return len(data)

        written = await asyncio.to_thread(write)
        relative = os.path.relpath(target, Path(root).resolve())
        return _ok(f"Wrote {written} bytes to {relative}.", {"path": str(target)})

    async def verify(self, inv: Invocation, _result) -> VerificationReport:
        try:
            target = inside(cwd_of(inv), _s(inv.input.get("path")))
            actual = await asyncio.to_thread(target.read_text, "utf-8")
        except (OSError, ValueError):
            return _fail("read-back", "The file could not be read back after writing.")
        return (
            _pass("read-back", "Read the file back and the contents match exactly.")
            if actual == _s(inv.input.get("content"))
            else _fail("read-back", "The file exists but its contents differ from what was written.")
        )


# ══════════════════════════════════════════════════════════════════
#  Terminal
# ══════════════════════════════════════════════════════════════════


class TerminalExecute:
    capability_id = "terminal.execute"

    async def run(self, inv: Invocation) -> ExecutorResult:
        cwd = cwd_of(inv)
        command = _s(inv.input.get("command"))
        # Refuse before running, with the allow-list in the message, so the
        # refusal is actionable rather than a bare failure.
        parsed = parse_command(command)
        if not parsed.ok:
            return _no(parsed.reason)

        result = await asyncio.to_thread(
            safe_shell_with_code,
            command,
            SpawnOptions(cwd=cwd, timeout_ms=inv.context.timeout_ms),
        )
        output = {"stdout": result.out, "exitCode": result.code}
        if result.code == 0:
            return _ok("Exit code 0.", output)
        return ExecutorResult(
            ok=False,
            detail=f"Exit code {result.code}. {result.out[:400]}",
            output=output,
        )

    async def verify(self, _inv: Invocation, result) -> VerificationReport:
        exit_code = (result.output or {}).get("exitCode") if isinstance(result.output, dict) else None
        return (
            _pass("exit-code", "The command exited 0.")
            if exit_code == 0
            else _fail("exit-code", f"The command exited {exit_code if exit_code is not None else 'unknown'}.")
        )


# ══════════════════════════════════════════════════════════════════
#  Coding agents
# ══════════════════════════════════════════════════════════════════

# How to ask each agent to do one task and then exit.
#
# Only agents whose CLI has actually been run and checked appear here.
# Guessing a flag would produce the exact failure this file exists to
# avoid — a capability that reports success while nothing happened — so an
# installed agent with no verified entry is refused BY NAME instead.
#
# The task text is always the LAST element and is never concatenated into
# a string, so it reaches the spawner as a single opaque argument.
AGENT_INVOCATIONS: dict[str, dict[str, Any]] = {
    # `opencode run` is the documented non-interactive mode: it performs
    # the work and exits, where bare `opencode` opens a TUI. `--dir` pins
    # it to the project directory.
    "opencode": {
        "args": lambda task, cwd, model: [
            "run", "--dir", cwd, *(["--model", model] if model else []), task
        ],
        "verified_against": "OpenCode 1.18.16",
    },
}

# How much context may ride along with a task. The whole brief reaches the
# CLI as ONE argv element, and Windows caps a command line at 32,767
# characters. Staying well under that keeps the same call working on every
# platform rather than failing only on one.
MAX_CONTEXT_CHARS = 12_000


def with_context(task: str, raw_context: str) -> str:
    """Compose the brief an agent actually receives.

    AURA's context, then the task, fenced so the agent can tell
    orientation from instruction. Truncation is announced in the text
    itself — an agent that silently received half its context would reason
    confidently from a fragment.
    """
    context = (raw_context or "").strip()
    if not context:
        return task
    body = (
        f"{context[:MAX_CONTEXT_CHARS]}\n"
        f"[context truncated by AURA at {MAX_CONTEXT_CHARS} characters]"
        if len(context) > MAX_CONTEXT_CHARS
        else context
    )
    return f"{body}\n\n<TASK>\n{task}\n</TASK>"


class AgentDelegate:
    capability_id = "agent.delegate"

    def supports_node(self, node) -> bool:
        """Which coding agents AURA can actually drive.

        Six catalogue entries declare `coding-agent`, but a node is only
        usable if its binary is on the agent allow-list AND has a verified
        non-interactive invocation. Declaring that here lets the Fabric
        route around an unusable agent before policy, instead of choosing
        one and failing at spawn time.
        """
        binary = node.binary
        return bool(binary) and resolve_agent_binary(binary).ok and binary in AGENT_INVOCATIONS

    async def run(self, inv: Invocation) -> ExecutorResult:
        # Confinement first: the agent runs in the project directory the
        # host resolved from the registry, never one the caller supplied.
        cwd = cwd_of(inv)
        task = _s(inv.input.get("task")).strip()
        if not task:
            return _no("No task was given for the agent to carry out.")
        model = _s(inv.input.get("model")).strip() or None
        # Context is CONSUMED, never composed here. Assembling repository
        # understanding in this file would create a second one beside
        # Repository Intelligence, and the two would drift.
        brief = with_context(task, _s(inv.input.get("context")))

        # Routing is the Fabric's job. This executor does not search the
        # catalogue or probe anything: it is handed the node that policy
        # was evaluated against, and refuses if it was not.
        node = inv.node
        if node is None:
            return _no("No coding-agent node was resolved for this call, so nothing was run.")
        binary = node.binary
        if not binary:
            return _no(
                f"{node.name} has no executable recorded in the catalogue, so it cannot be run."
            )
        # The allow-list is enforced again here, at the point of execution —
        # routing decides WHICH node, never whether its binary may be spawned.
        if not resolve_agent_binary(binary).ok:
            return _no(f"{node.name} is not on the coding-agent allow-list, so it was not run.")
        spec = AGENT_INVOCATIONS.get(binary)
        # A resolved node whose CLI has not been verified FAILS. It is never
        # silently swapped for one that would have worked — that
        # substitution is exactly what routing must not do.
        if spec is None:
            verified = ", ".join(AGENT_INVOCATIONS)
            return _no(
                f"{node.name} is connected, but AURA has no verified non-interactive "
                f"invocation for it yet, so nothing was run. Verified today: {verified}."
            )

        args = spec["args"](brief, cwd, model)
        try:
            res = await asyncio.to_thread(
                run_agent, binary, args,
                SpawnOptions(cwd=cwd, timeout_ms=inv.context.timeout_ms),
            )
        except (ProcessRefused, ProcessNotInstalled, Exception) as exc:  # noqa: BLE001
            return _no(f"{node.name} could not be run: {exc}")

        # `nodeId` travels with the result so the work is attributable to
        # the agent that did it rather than to "some coding agent".
        output = {
            "stdout": res.out,
            "exitCode": res.code,
            "nodeId": node.id,
            "agent": node.name,
            "args": args,
            "timedOut": bool(res.timed_out),
            "signal": res.signal,
        }
        if res.code == 0:
            return _ok(f"{node.name} completed the task. Exit code 0.", output)
        # A run that was cut short is reported as cut short, not as a
        # generic failure — the operator needs to know it may be half-done.
        if res.timed_out:
            why = f"{node.name} ran out of time and was stopped. Its changes, if any, are partial."
        elif res.signal:
            why = f"{node.name} was terminated by {res.signal}."
        else:
            why = f"{node.name} exited {res.code}."
        return ExecutorResult(
            ok=False, detail=f"{why} {res.out[:400]}".strip(), output=output
        )

    async def verify(self, _inv: Invocation, result) -> VerificationReport:
        exit_code = (result.output or {}).get("exitCode") if isinstance(result.output, dict) else None
        return (
            _pass("exit-code", "The agent exited 0.")
            if exit_code == 0
            else _fail("exit-code", f"The agent exited {exit_code if exit_code is not None else 'unknown'}.")
        )


# ══════════════════════════════════════════════════════════════════
#  Installation
# ══════════════════════════════════════════════════════════════════


class SystemInstall:
    """Governed installation.

    Four honest outcomes, never widened: installed, guided, failed,
    unverified.
    """

    capability_id = "system.install"

    def __init__(self, scanner: EnvironmentScanner) -> None:
        self._scanner = scanner

    async def run(self, inv: Invocation) -> ExecutorResult:
        node_id = _s(inv.input.get("nodeId")).strip()
        if not node_id:
            return _no("No node was named, so there is nothing to install.")

        # The catalogue is the only source of truth for what may be
        # installed. An id that is not in it is refused before anything
        # else happens.
        entry = catalog_entry(node_id)
        if entry is None:
            return _no(
                f"'{node_id}' is not a node in AURA's catalogue, so there is nothing to install."
            )

        spec = (
            InstallSpec(
                method=entry.install.method,
                package=entry.install.package,
                privilege=entry.install.privilege,
                distro=entry.install.distro,
            )
            if entry.install
            else None
        )
        plan = await asyncio.to_thread(
            plan_install, name=entry.name, homepage=entry.homepage, spec=spec
        )

        # No install spec, or nothing verified for this machine. An honest
        # "AURA does not know how" — never a guessed package name.
        if not isinstance(plan, InstallPlan):
            return _no(plan.reason)

        # ── root tier: AURA executes NOTHING ──────────────────────────
        if plan.privilege == "root":
            result = {
                "installOutcome": "guided",
                "nodeId": node_id,
                "privilege": "root",
                "requiresUserAction": True,
                "command": plan.command,
                "why": plan.why,
            }
            # `ok: False` satisfies the Fabric contract; the payload carries
            # the real answer. Callers branch on `installOutcome`, never on
            # `ok` — a guided handoff is not a failure.
            return ExecutorResult(
                ok=False,
                detail=(
                    f"{entry.name} needs administrator rights to install, so AURA did not "
                    f"run anything. Run this yourself, then re-scan: {plan.command}"
                ),
                output=result,
            )

        # ── user tier: governed, bounded, then VERIFIED ───────────────
        try:
            res = await asyncio.to_thread(
                run_installer, plan.bin, plan.args,
                # cwd is the user's home rather than a project: installing a
                # global tool is not project work, and pointing an installer
                # at a project root invites it to write lockfiles there.
                SpawnOptions(
                    cwd=os.environ.get("HOME") or str(Path.home()),
                    timeout_ms=inv.context.timeout_ms,
                ),
            )
        except Exception as exc:  # noqa: BLE001
            return _no(f"{entry.name} could not be installed: {exc}")

        base = {
            "nodeId": node_id,
            "privilege": "user",
            "command": plan.command,
            "exitCode": res.code,
            "timedOut": bool(res.timed_out),
            "stdout": res.out[:4000],
        }

        if res.code != 0:
            if res.timed_out:
                why = "The installer ran out of time and was stopped."
            elif res.signal:
                why = f"The installer was terminated by {res.signal}."
            else:
                why = f"The installer exited {res.code}."
            return ExecutorResult(
                ok=False,
                detail=f"{entry.name} was not installed. {why} {res.out[:300]}".strip(),
                output={**base, "installOutcome": "failed", "requiresUserAction": False, "why": why},
            )

        # Exit 0 is a CLAIM. The probe is the EVIDENCE.
        #
        # An installer can succeed while leaving nothing runnable — wrong
        # package, a binary outside PATH, a partial write. Reporting that
        # as installed is exactly the confident-but-wrong failure this
        # codebase refuses, so a clean exit with no detectable tool is
        # `unverified`. `refresh=True` is mandatory: the cached answer was
        # taken before the install.
        probe = await self._scanner.probe_node(node_id, refresh=True)
        if not probe.present:
            return ExecutorResult(
                ok=False,
                detail=(
                    f"{entry.name} reported a successful install, but AURA still cannot "
                    f"find it, so it is NOT being reported as installed. {probe.detail}"
                ),
                output={
                    **base,
                    "installOutcome": "unverified",
                    "requiresUserAction": True,
                    "why": (
                        f"The installer finished without an error, but {entry.name} still "
                        "cannot be found on this machine."
                    ),
                    "probe": {"present": False, "detail": probe.detail},
                },
            )

        version = f" ({probe.version})" if probe.version else ""
        return _ok(
            f"{entry.name} is installed and verified{version}.",
            {
                **base,
                "installOutcome": "installed",
                "requiresUserAction": False,
                "probe": {
                    "present": True,
                    "version": probe.version,
                    "detail": probe.detail,
                },
            },
        )

    async def verify(self, _inv: Invocation, result) -> VerificationReport:
        """Re-states the probe, and passes ONLY for `installed`.

        `guided` deliberately fails verification: nothing was installed, so
        there is nothing to verify. The distinction the user sees comes
        from `installOutcome`, not from this report.
        """
        out = result.output if isinstance(result.output, dict) else None
        if not out:
            return _fail("read-back", "The installer returned no result to verify.")
        outcome = out.get("installOutcome")
        if outcome == "installed":
            version = (out.get("probe") or {}).get("version")
            suffix = f" {version}" if version else ""
            return _pass("read-back", f"A fresh probe found {out.get('nodeId')}{suffix}.")
        if outcome == "guided":
            return _fail(
                "read-back",
                "Nothing was installed — this needs administrator rights and is waiting on you.",
            )
        if outcome == "unverified":
            return _fail(
                "read-back",
                f"The installer exited 0 but a fresh probe still cannot find {out.get('nodeId')}.",
            )
        return _fail("read-back", out.get("why") or "The installer did not succeed.")


# ══════════════════════════════════════════════════════════════════
#  Git — all through the shared primitive
# ══════════════════════════════════════════════════════════════════


async def _git(args: list[str], cwd: str):
    return await asyncio.to_thread(git, args, SpawnOptions(cwd=cwd))


class GitStatus:
    capability_id = "git.status"

    async def run(self, inv: Invocation) -> ExecutorResult:
        res = await _git(["status", "--short", "--branch"], cwd_of(inv))
        return _ok(
            "Working tree has changes." if res.out else "Working tree is clean.",
            res.out or "clean",
        )


class GitDiff:
    capability_id = "git.diff"

    async def run(self, inv: Invocation) -> ExecutorResult:
        args = ["diff", "--stat", "-p", "--no-color"]
        if _b(inv.input.get("staged")):
            args.insert(1, "--cached")
        res = await _git(args, cwd_of(inv))
        text = (
            f"{res.out[:MAX_DIFF_CHARS]}\n…(truncated)"
            if len(res.out) > MAX_DIFF_CHARS
            else res.out
        )
        return _ok("Diff produced." if res.out else "No changes.", text or "no changes")


class GitBranch:
    capability_id = "git.branch"

    async def run(self, inv: Invocation) -> ExecutorResult:
        cwd = cwd_of(inv)
        name = _s(inv.input.get("name")).strip()
        if not name:
            res = await _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
            return _ok(f"On branch {res.out}.", res.out)
        existing = await _git(["rev-parse", "--verify", name], cwd)
        args = ["checkout", name] if existing.code == 0 else ["checkout", "-b", name]
        res = await _git(args, cwd)
        if res.code != 0:
            return _no(res.out or "Branch operation failed.")
        return _ok(
            f"Switched to {name}." if existing.code == 0 else f"Created and switched to {name}.",
            name,
        )

    async def verify(self, inv: Invocation, _result) -> VerificationReport:
        name = _s(inv.input.get("name")).strip()
        if not name:
            return _pass("read-back", "Reported the current branch.")
        res = await _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd_of(inv))
        return (
            _pass("read-back", f"HEAD is on {name}.")
            if res.out == name
            else _fail("read-back", f"Expected to be on {name}, but HEAD is on {res.out}.")
        )


class GitCommit:
    capability_id = "git.commit"

    async def run(self, inv: Invocation) -> ExecutorResult:
        cwd = cwd_of(inv)
        message = _s(inv.input.get("message")).split("\n")[0].strip()
        if not message:
            return _no("A commit message is required.")
        status = await _git(["status", "--porcelain"], cwd)
        if not status.out:
            return _ok("Nothing to commit — the working tree is clean.", {"committed": False})
        await _git(["add", "-A"], cwd)
        res = await _git(["commit", "-m", message], cwd)
        if res.code != 0:
            return _no(res.out or "The commit failed.")
        return _ok(f"Committed: {message}", {"committed": True, "message": message})

    async def verify(self, inv: Invocation, result) -> VerificationReport:
        if isinstance(result.output, dict) and result.output.get("committed") is False:
            return _pass("read-back", "Nothing needed committing, so there is nothing to verify.")
        message = _s(inv.input.get("message")).split("\n")[0].strip()
        res = await _git(["log", "-1", "--pretty=%s"], cwd_of(inv))
        return (
            _pass("read-back", "HEAD is the new commit.")
            if res.out == message
            else _fail(
                "read-back",
                f'HEAD\'s subject is "{res.out}", not the message that was committed.',
            )
        )


class GitPush:
    capability_id = "git.push"

    async def run(self, inv: Invocation) -> ExecutorResult:
        cwd = cwd_of(inv)
        remote = _s(inv.input.get("remote"), "origin")
        branch = _s(inv.input.get("branch"))
        if not branch:
            branch = (await _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).out
        res = await _git(["push", remote, branch], cwd)
        if res.code == 0:
            return _ok(
                f"Pushed {branch} to {remote}.",
                {"remote": remote, "branch": branch, "exitCode": res.code},
            )
        return ExecutorResult(
            ok=False, detail=res.out or "The push failed.", output={"exitCode": res.code}
        )

    async def verify(self, _inv: Invocation, result) -> VerificationReport:
        exit_code = (result.output or {}).get("exitCode") if isinstance(result.output, dict) else None
        return (
            _pass("exit-code", "git push exited 0.")
            if exit_code == 0
            else _fail("exit-code", f"git push exited {exit_code if exit_code is not None else 'unknown'}.")
        )


# ══════════════════════════════════════════════════════════════════
#  Network
# ══════════════════════════════════════════════════════════════════


class HttpRequest:
    capability_id = "http.request"

    async def run(self, inv: Invocation) -> ExecutorResult:
        url = _s(inv.input.get("url"))
        if not _HTTP_URL.match(url):
            return _no("Only http(s) URLs are allowed.")
        timeout = min((inv.context.timeout_ms or 10_000), 30_000) / 1000
        body = inv.input.get("body")
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                response = await client.request(
                    _s(inv.input.get("method"), "GET").upper(),
                    url,
                    content=None if body is None else _s(body),
                )
            text = response.content[:MAX_HTTP_BYTES].decode("utf-8", errors="replace")
            return _ok(
                f"{response.status_code} {response.reason_phrase}",
                {"status": response.status_code, "text": text},
            )
        except httpx.TimeoutException:
            return _no("The request did not complete: timeout")
        except Exception as exc:  # noqa: BLE001
            # The underlying cause matters: the Fabric's retry classifier
            # keys off it, so flattening every network blip into one
            # message would turn transient failures into hard ones.
            return _no(f"The request did not complete: {exc}")

    async def verify(self, _inv: Invocation, result) -> VerificationReport:
        status = (result.output or {}).get("status", 0) if isinstance(result.output, dict) else 0
        return (
            _pass("http-status", f"The endpoint answered {status}.")
            if 200 <= status < 400
            else _fail("http-status", f"The endpoint answered {status}, which is not a success status.")
        )


def machine_executors(scanner: EnvironmentScanner) -> list[Any]:
    """Every executor that genuinely works today.

    Capabilities absent from this list (GitHub, browser, and the ten
    AURA-internal ones that need Phase 3's workspace manager) stay in the
    manifest so missions can plan around them, and report `unsupported`
    when called.
    """
    return [
        FilesystemList(),
        FilesystemRead(),
        FilesystemWrite(),
        TerminalExecute(),
        AgentDelegate(),
        SystemInstall(scanner),
        GitStatus(),
        GitDiff(),
        GitBranch(),
        GitCommit(),
        GitPush(),
        HttpRequest(),
    ]
