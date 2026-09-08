"""Worker runtime adapters — the ONE description of how each worker runs.

This is an integration seam, not a second orchestrator. It states, per
worker identity, what AURA knows about actually driving that runtime:
the non-interactive argv shape, which governance wiring (if any) the
runtime genuinely honours, and what that wiring can actually enforce.

Two rules govern every entry:

1. ``invocation_verified`` is True only when AURA has observed the exact
   argv shape drive that runtime non-interactively to a real result. It
   is a claim about code, not about this machine — a verified shape on an
   unauthenticated machine still yields NOT_CONNECTED.
2. ``supports`` is evidence, never analogy. A runtime does not inherit
   another runtime's enforcement because their flags look alike; Phase J
   is the reason that rule exists. Anything unproven is "unsupported".

Adding a worker is adding a row here. The list is deliberately not capped
at six, and nothing downstream assumes a fixed set.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from ..governance import claude as _claude_gov
from ..governance import opencode as _opencode_gov

#: Enforcement wiring kinds. Each names a real mechanism owned by the
#: runtime itself — never something AURA reconstructs after the fact.
GOV_OPENCODE_PLUGIN = "opencode-plugin"   # config + tool.execute.before plugin
GOV_CLAUDE_HOOK = "claude-hook"           # --add-dir + PreToolUse hook
GOV_NONE = "none"                         # no proven interception point

#: What a fully-unenforceable runtime reports for every action type.
NO_ENFORCEMENT = {
    "COMMAND": "unsupported",
    "FILE_WRITE": "unsupported",
    "FILE_DELETE": "unsupported",
    "FILE_READ": "unsupported",
    "PROCESS_SPAWN": "unsupported",
    "TOOL_CALL": "unsupported",
    "NETWORK": "unsupported",
}


@dataclass(frozen=True)
class WorkerAdapter:
    """One worker identity and everything AURA knows about driving it."""

    id: str
    """Catalogue node id — the identity used everywhere else (routing,
    task pins, evidence). Never the binary name."""

    name: str
    binary: str

    build_args: Callable[[str, str, str | None], list[str]]
    """(task, cwd, model) -> argv after the binary. The task text is
    always the LAST positional so runtime flags can be prefixed."""

    governance: str = GOV_NONE
    supports: dict[str, str] = field(default_factory=lambda: dict(NO_ENFORCEMENT))

    invocation_verified: bool = False
    """True only when the argv shape above has been observed driving the
    real runtime to a real result. False keeps the worker undispatchable
    until AURA proves a round-trip on THIS machine (see readiness)."""

    verified_against: str = ""
    """What was observed, and when — the provenance of the two claims."""

    env_prefix: str = ""
    """Config env-var prefix for opencode-family governance staging
    (OPENCODE_CONFIG / KILO_CONFIG …). Empty for other kinds."""

    notes: str = ""


def _opencode_args(task: str, cwd: str, model: str | None) -> list[str]:
    return ["run", "--dir", cwd, *(["--model", model] if model else []), task]


def _claude_args(task: str, _cwd: str, _model: str | None) -> list[str]:
    # `claude -p` is the documented non-interactive mode. The tool
    # allow-list is least-privilege by construction: no Bash, no bypass
    # flags — the worker can edit files but cannot execute commands.
    return ["-p", task, "--allowedTools", "Edit Write"]


def _kilo_args(task: str, cwd: str, model: str | None) -> list[str]:
    # --dir is LOAD-BEARING: bare `kilo run` writes to the parent
    # directory instead of cwd, escaping confinement. Never drop it.
    return ["run", "--dir", cwd, *(["--model", model] if model else []), task]


def _codex_args(task: str, cwd: str, model: str | None) -> list[str]:
    # `codex exec` is the documented non-interactive mode; -C sets the
    # working root and -s workspace-write is the sandbox that keeps
    # writes inside it. Observed live to be accepted and to reach the
    # model; a real result was NOT obtained on the verification machine
    # (account quota), so the shape stays unverified.
    return ["exec", "-C", cwd, "-s", "workspace-write",
            *(["-m", model] if model else []), task]


def _gemini_args(task: str, _cwd: str, model: str | None) -> list[str]:
    # Candidate shape only — never observed by AURA against a real
    # runtime. Stays unverified until a readiness proof succeeds.
    return [*(["-m", model] if model else []), "-p", task]


def _qwen_args(task: str, _cwd: str, model: str | None) -> list[str]:
    # Candidate shape only. Observed to start non-interactively on the
    # verification machine, but the runtime failed before producing any
    # result (provider endpoint error), so nothing is verified.
    return [*(["-m", model] if model else []), "--approval-mode", "yolo",
            task]


#: The worker catalogue. Order is catalogue order for auto-selection.
ADAPTERS: tuple[WorkerAdapter, ...] = (
    WorkerAdapter(
        id="opencode", name="OpenCode", binary="opencode",
        build_args=_opencode_args,
        governance=GOV_OPENCODE_PLUGIN, env_prefix="OPENCODE",
        supports=dict(_opencode_gov.SUPPORTS),
        invocation_verified=True,
        verified_against="OpenCode 1.18.16 (`run --dir`); governance proven Phase J",
    ),
    WorkerAdapter(
        id="claude-code", name="Claude Code", binary="claude",
        build_args=_claude_args,
        governance=GOV_CLAUDE_HOOK,
        supports=dict(_claude_gov.SUPPORTS),
        invocation_verified=True,
        verified_against="Claude Code print mode (`-p`); governance proven Phase J",
        notes=("COMMAND/PROCESS_SPAWN/NETWORK are unsupported by "
               "construction: the tool is never granted, so there is "
               "nothing to intercept."),
    ),
    WorkerAdapter(
        id="kilo-code", name="Kilo Code", binary="kilo",
        build_args=_kilo_args,
        governance=GOV_OPENCODE_PLUGIN, env_prefix="KILO",
        supports=dict(_opencode_gov.SUPPORTS),
        invocation_verified=True,
        verified_against=(
            "kilo 7.5.14 (`run --dir`); governance proven live 2026-09-08 — "
            "KILO_CONFIG/KILO_CONFIG_DIR loaded the AURA plugin, "
            "tool.execute.before DENIED an out-of-scope write before "
            "execution, worker self-terminated (exit 42), forbidden file "
            "never created"),
    ),
    WorkerAdapter(
        id="codex-cli", name="Codex CLI", binary="codex",
        build_args=_codex_args,
        governance=GOV_NONE, supports=dict(NO_ENFORCEMENT),
        invocation_verified=False,
        verified_against="",
        notes=("`codex exec` accepts the shape and reaches the model, but "
               "AURA has never observed a completed result from it, and no "
               "pre-execution interception point has been proven. Codex "
               "also exits 0 on provider errors, so exit code alone is not "
               "evidence of success."),
    ),
    WorkerAdapter(
        id="gemini-cli", name="Gemini CLI", binary="gemini",
        build_args=_gemini_args,
        governance=GOV_NONE, supports=dict(NO_ENFORCEMENT),
        invocation_verified=False,
        notes="Candidate invocation shape; never observed against the runtime.",
    ),
    WorkerAdapter(
        id="qwen-cli", name="Qwen Code", binary="qwen",
        build_args=_qwen_args,
        governance=GOV_NONE, supports=dict(NO_ENFORCEMENT),
        invocation_verified=False,
        notes=("Starts non-interactively, but no completed result has ever "
               "been observed and no interception point is proven."),
    ),
)

BY_ID: dict[str, WorkerAdapter] = {a.id: a for a in ADAPTERS}
BY_BINARY: dict[str, WorkerAdapter] = {a.binary: a for a in ADAPTERS}


def adapter_for_binary(binary: str) -> WorkerAdapter | None:
    return BY_BINARY.get((binary or "").strip())


def adapter_for_id(worker_id: str) -> WorkerAdapter | None:
    return BY_ID.get((worker_id or "").strip())


def verified_invocations() -> dict[str, dict]:
    """The verified-in-code invocation table, in the shape the executor
    has always consumed. Unverified adapters are absent by construction —
    a worker AURA cannot prove it can drive is never dispatched."""
    return {
        a.binary: {"args": a.build_args, "verifiedAgainst": a.verified_against}
        for a in ADAPTERS if a.invocation_verified
    }


#: Every file action is accounted for by SOME real boundary. "bounded"
#: is not the same as "AURA sees each attempt", which is why the matrix
#: keeps the distinction — but a worker whose file behaviour cannot
#: escape is genuinely supervised, and one where an action type is
#: simply ungoverned is not.
_BOUNDED = ("preflight", "policy", "confinement", "not-granted",
            "allowlist")


def governance_level(adapter: WorkerAdapter | None) -> str:
    """Honest capability tier for a worker's real-time supervision."""
    if adapter is None or adapter.governance == GOV_NONE:
        return "UNSUPPORTED"
    if all(adapter.supports.get(k) in _BOUNDED
           for k in ("FILE_WRITE", "FILE_DELETE", "FILE_READ")):
        return "SUPPORTED"
    if any(v in _BOUNDED for v in adapter.supports.values()):
        return "PARTIALLY_SUPPORTED"
    return "UNSUPPORTED"


__all__ = [
    "ADAPTERS", "BY_BINARY", "BY_ID", "GOV_CLAUDE_HOOK", "GOV_NONE",
    "GOV_OPENCODE_PLUGIN", "NO_ENFORCEMENT", "WorkerAdapter",
    "adapter_for_binary", "adapter_for_id", "governance_level",
    "verified_invocations",
]
