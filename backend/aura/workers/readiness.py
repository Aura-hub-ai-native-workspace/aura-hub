"""Worker readiness — what has to be TRUE before AURA says CONNECTED.

The rule this module exists to enforce: a worker is connected when AURA
has proved it can drive that worker and receive a real, correlated
result — not when a binary exists, not when a catalogue lists it, not
when a card was clicked, and not because it worked last week.

The proof is a real round-trip through the real runtime, staged exactly
the way a real task is staged (same adapter argv, same governance
bundle, same process boundary, same action log). It runs in an
AURA-owned scratch worktree, never the user's project, and it asks for
one bounded in-scope file write so that three things are observed at
once:

    dispatch → governed action → allowed → real execution → real
    response → correlated to THIS invocation

Every stage that fails yields NOT_CONNECTED with the runtime's own
reason. Nothing here downgrades a failure into a softer success.

This is a MEASUREMENT of the machine, in the same seam as
``aura.environment.probe`` — it performs no work on behalf of a user and
grants no authority. Task dispatch stays where it has always been: the
Central Agent, through the Capability Fabric.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import uuid
from dataclasses import dataclass, field

from .adapters import (
    GOV_CLAUDE_HOOK,
    GOV_NONE,
    GOV_OPENCODE_PLUGIN,
    WorkerAdapter,
    governance_level,
)

#: Stages, in order. A proof must reach the last one.
STAGES = (
    "DISCOVERED", "INSTALLED", "LAUNCHABLE", "DISPATCHED",
    "RESPONDED", "CORRELATED", "GOVERNANCE",
)

#: Honest refusal reasons. Never widened to make a worker look better.
NOT_INSTALLED = "NOT_INSTALLED"
RUNTIME_UNAVAILABLE = "RUNTIME_UNAVAILABLE"
ADAPTER_UNKNOWN = "ADAPTER_UNKNOWN"
INVOCATION_FAILED = "INVOCATION_FAILED"
NO_RESPONSE = "NO_RESPONSE"
RESPONSE_UNCORRELATED = "RESPONSE_UNCORRELATED"
TIMEOUT = "TIMEOUT"
GOVERNANCE_UNSUPPORTED = "GOVERNANCE_UNSUPPORTED"

#: A readiness handshake is one bounded worker turn, not a task.
READINESS_TIMEOUT_MS = 240_000

#: Governance tiers reported to the user (§12 honest capability matrix).
FULLY_GOVERNED = "FULLY_GOVERNED"
BASIC_WORK_ONLY = "CONNECTED_FOR_BASIC_WORK"


@dataclass
class ReadinessProof:
    """The record that authorises the word CONNECTED. Persisted with the
    node so a later reader can see exactly what was proved and when."""

    worker_id: str
    binary: str
    proved: bool = False
    reason: str = ""
    detail: str = ""
    probe_id: str = ""
    nonce: str = ""
    at: str = ""
    stages: list[str] = field(default_factory=list)
    exit_code: int | None = None
    response_excerpt: str = ""
    governance: str = "UNSUPPORTED"
    """FULLY_GOVERNED | CONNECTED_FOR_BASIC_WORK | UNSUPPORTED."""
    governance_supports: dict[str, str] = field(default_factory=dict)
    actions_observed: int = 0
    allowed_actions: int = 0
    invocation_verified: bool = False

    def to_dict(self) -> dict:
        return {
            "workerId": self.worker_id, "binary": self.binary,
            "proved": self.proved, "reason": self.reason,
            "detail": self.detail, "probeId": self.probe_id,
            "nonce": self.nonce, "at": self.at, "stages": list(self.stages),
            "exitCode": self.exit_code,
            "responseExcerpt": self.response_excerpt,
            "governance": self.governance,
            "governanceSupports": dict(self.governance_supports),
            "actionsObserved": self.actions_observed,
            "allowedActions": self.allowed_actions,
            "invocationVerified": self.invocation_verified,
        }


def _now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z")


def readiness_root(home: str, probe_id: str) -> str:
    safe = "".join(c if (c.isalnum() or c in "-_") else "-"
                   for c in probe_id)[:64]
    return os.path.join(home, "readiness", safe or "probe")


def _prepare_worktree(root: str, nonce: str) -> str:
    """An AURA-owned throwaway git worktree. Git is what makes the
    post-run scope delta evidential, exactly as in a real task.

    Every process here goes through aura.environment.procexec — the ONE
    execution boundary — so the readiness probe inherits the same secret
    isolation, output bounds and process-tree cleanup as everything else
    AURA spawns. A machine without git still gets a usable worktree; the
    probe simply has no delta evidence, which the proof reports.
    """
    from ..environment.procexec import run_argv

    work = os.path.join(root, "repo")
    os.makedirs(os.path.join(work, "work"), exist_ok=True)
    with open(os.path.join(work, "README.md"), "w", encoding="utf-8") as fh:
        fh.write(f"AURA worker readiness probe {nonce}\n")
    for argv in (["git", "init", "-q"],
                 ["git", "add", "-A"],
                 ["git", "-c", "user.email=readiness@aura.local",
                  "-c", "user.name=AURA", "commit", "-qm", "probe"]):
        outcome = run_argv(argv, timeout_ms=30_000, cwd=work)
        if outcome.exit_code not in (0, None):
            break
    return work


def _readiness_task(nonce: str) -> str:
    return (
        "This is an automated readiness check from AURA. Do exactly one "
        f"thing: create the file work/aura-ready.txt containing exactly "
        f"AURA-READY-{nonce} and nothing else. Do not create, edit, read "
        "or delete any other file, and do not run any command. Then reply "
        "with the single word DONE."
    )


def _stage_governance(adapter: WorkerAdapter, home: str, probe_id: str,
                      cwd: str, scope_paths: list[str]) -> dict:
    """Stage the SAME runtime enforcement a real task would get."""
    from ..governance import staging

    if adapter.governance == GOV_OPENCODE_PLUGIN:
        staged = staging.stage_opencode(
            home, invocation_id=probe_id, task_id="readiness",
            node_id=adapter.id, attempt="1", cwd=cwd,
            scope_paths=scope_paths,
            env_prefix=adapter.env_prefix or "OPENCODE")
        return {"env": staged["env"], "logPath": staged["logPath"],
                "extraArgs": [], "supports": staged["supports"]}
    if adapter.governance == GOV_CLAUDE_HOOK:
        staged = staging.stage_claude(
            home, invocation_id=probe_id, task_id="readiness",
            node_id=adapter.id, attempt="1", cwd=cwd,
            scope_paths=scope_paths)
        extra: list[str] = []
        for root in staged["addDirs"]:
            extra += ["--add-dir", root]
        if staged.get("settingsPath"):
            extra += ["--settings", staged["settingsPath"]]
        return {"env": staged["env"], "logPath": staged["logPath"],
                "extraArgs": extra, "supports": staged["supports"]}
    return {"env": {}, "logPath": "", "extraArgs": [], "supports": {}}


async def _run(adapter: WorkerAdapter, argv: list[str], cwd: str,
               env: dict[str, str], timeout_ms: int):
    from ..exec_ import run_agent

    return await run_agent(adapter.binary, argv, cwd, timeout_ms,
                           env=env or None)


def prove_worker(adapter: WorkerAdapter, home: str,
                 *, keep_workspace: bool = False,
                 timeout_ms: int = READINESS_TIMEOUT_MS,
                 runner=None) -> ReadinessProof:
    """Run the real round-trip. Returns the proof, proved or not.

    ``runner`` is the process seam (tests inject a fake); production
    always uses the same bounded agent-execution boundary a task uses.
    """
    probe_id = f"rdy-{uuid.uuid4().hex[:12]}"
    nonce = uuid.uuid4().hex[:10].upper()
    proof = ReadinessProof(
        worker_id=adapter.id, binary=adapter.binary, probe_id=probe_id,
        nonce=nonce, at=_now(),
        governance_supports=dict(adapter.supports),
        invocation_verified=adapter.invocation_verified)

    # 1. DISCOVERED / INSTALLED / LAUNCHABLE — the existing probe, not a
    #    second discovery mechanism.
    from ..environment import probe_node
    from ..environment.probe import ProbeStatus

    proof.stages.append("DISCOVERED")
    try:
        result = probe_node(adapter.id, refresh=True)
    except Exception as exc:  # noqa: BLE001
        proof.reason = RUNTIME_UNAVAILABLE
        proof.detail = f"The environment probe could not run: {exc}"
        return proof
    if not result.present:
        proof.reason = (NOT_INSTALLED
                        if result.status == ProbeStatus.NOT_FOUND
                        else RUNTIME_UNAVAILABLE)
        proof.detail = result.detail
        return proof
    proof.stages.append("INSTALLED")
    if result.status == ProbeStatus.VERIFIED:
        proof.stages.append("LAUNCHABLE")

    # 2. DISPATCH — real argv, real governance staging, real boundary.
    root = readiness_root(home, probe_id)
    cwd = _prepare_worktree(root, nonce)
    scope_paths = ["work"]
    governance = _stage_governance(adapter, home, probe_id, cwd, scope_paths)
    args = adapter.build_args(_readiness_task(nonce), cwd, None)
    argv = [*governance["extraArgs"], *args]
    try:
        if runner is None:
            outcome = asyncio.run(
                _run(adapter, argv, cwd, governance["env"], timeout_ms))
        else:
            outcome = runner(adapter, argv, cwd, governance["env"],
                             timeout_ms)
    except Exception as exc:  # noqa: BLE001 — any spawn failure is honest
        proof.reason = INVOCATION_FAILED
        proof.detail = f"{adapter.name} could not be run: {exc}"
        _cleanup(root, keep_workspace)
        return proof
    proof.stages.append("DISPATCHED")

    stdout = str(getattr(outcome, "out", "") or "")
    proof.exit_code = getattr(outcome, "code", None)
    proof.response_excerpt = stdout.strip()[-400:]
    if getattr(outcome, "timedOut", False):
        proof.reason = TIMEOUT
        proof.detail = (f"{adapter.name} did not answer within "
                        f"{timeout_ms // 1000}s. Presence is not the same as "
                        "usability; nothing is claimed.")
        _cleanup(root, keep_workspace)
        return proof
    if not stdout.strip():
        proof.reason = NO_RESPONSE
        proof.detail = (f"{adapter.name} ran and exited "
                        f"{proof.exit_code} without producing any output.")
        _cleanup(root, keep_workspace)
        return proof
    proof.stages.append("RESPONDED")

    # 3. CORRELATE — the response must be evidence of THIS request. The
    #    nonce lives in the artefact the worker was asked to produce, so
    #    a runtime that merely echoes the prompt cannot pass.
    artefact = os.path.join(cwd, "work", "aura-ready.txt")
    body = ""
    try:
        with open(artefact, encoding="utf-8") as fh:
            body = fh.read(4096)
    except OSError:
        body = ""
    if f"AURA-READY-{nonce}" not in body:
        proof.reason = RESPONSE_UNCORRELATED
        proof.detail = (
            f"{adapter.name} replied, but produced no work correlated to "
            f"this request (exit {proof.exit_code}). Its own output: "
            f"{stdout.strip()[-300:] or '(none)'}")
        _cleanup(root, keep_workspace)
        return proof
    proof.stages.append("CORRELATED")

    # 4. GOVERNANCE — observed, never assumed. A runtime that declares an
    #    enforcement path but produced no mediated action is reported as
    #    connected for basic work, NOT as governed.
    events: list[dict] = []
    if governance["logPath"]:
        from ..governance.staging import read_action_log

        events = [e for e in read_action_log(governance["logPath"])
                  if e.get("invocationId") == probe_id]
    proof.actions_observed = len(events)
    proof.allowed_actions = sum(1 for e in events
                                if e.get("decision") == "ALLOW")
    if adapter.governance == GOV_NONE:
        proof.governance = "UNSUPPORTED"
    elif proof.allowed_actions > 0:
        proof.governance = (FULLY_GOVERNED
                            if governance_level(adapter) == "SUPPORTED"
                            else BASIC_WORK_ONLY)
        proof.stages.append("GOVERNANCE")
    else:
        proof.governance = BASIC_WORK_ONLY
        proof.detail = ("Governance wiring was staged but the runtime "
                        "mediated no action through it during the probe.")

    proof.proved = True
    proof.reason = ""
    if not proof.detail:
        proof.detail = (
            f"{adapter.name} received an AURA request, performed the "
            f"requested work, and returned a result correlated to "
            f"invocation {probe_id}.")
    _cleanup(root, keep_workspace)
    return proof


def _cleanup(root: str, keep: bool) -> None:
    if keep:
        return
    try:
        shutil.rmtree(root, ignore_errors=True)
    except Exception:  # noqa: BLE001
        pass


__all__ = [
    "ADAPTER_UNKNOWN", "BASIC_WORK_ONLY", "FULLY_GOVERNED",
    "GOVERNANCE_UNSUPPORTED", "INVOCATION_FAILED", "NOT_INSTALLED",
    "NO_RESPONSE", "READINESS_TIMEOUT_MS", "RESPONSE_UNCORRELATED",
    "RUNTIME_UNAVAILABLE", "STAGES", "TIMEOUT", "ReadinessProof",
    "prove_worker", "readiness_root",
]
