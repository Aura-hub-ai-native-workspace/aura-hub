"""Capability model — what a machine capability IS, once measured.

A Capability describes a real, detected tool: what it is called, where
the executable lives, which version answered, whether it is usable, and
what AURA may do with it. Every field is either measured (probe output)
or curated (the action table); nothing is inferred from a name alone.

Two vocabularies meet here and must not be confused:

- ``ActionRisk`` grades a MACHINE action (git status reads files; `rm`
  deletes them). It informs planning and review prompts.
- The Fabric's ``RiskLevel`` (low/medium/high) governs CAPABILITIES
  (git.status, filesystem.write) and is the only thing authority reads.

The registry maps between them where a machine action backs a governed
capability, but one never silently becomes the other.
"""

from __future__ import annotations

from typing import Literal

from ..contracts._base import ContractModel

#: What is known about a capability right now. ``unknown`` is honest:
#: a timeout never disproves presence, and presence is never claimed
#: from a stale cache.
Availability = Literal["available", "unavailable", "unknown"]

#: Health is SEPARATE from availability. An executable can exist while
#: its daemon is down (docker), or answer while its endpoint is
#: unreachable (ollama). Planners need both facts, not one blurred bit.
Health = Literal["healthy", "degraded", "unreachable", "unchecked", "unknown"]

#: Where a capability came from. SYSTEM/PROJECT/PROVIDER exist today;
#: MCP/PLUGIN/APPLICATION/REMOTE are reserved extension points — the
#: field is closed so a new source cannot smuggle itself in, but adding
#: one is a one-line change plus its detector.
Source = Literal[
    "system", "project", "provider", "mcp", "plugin", "application", "remote",
]

#: Machine-action risk. READ_ONLY actions never change state; LOW_RISK
#: actions change only the project's own derived state (build outputs,
#: installed dev dependencies); MODIFY changes project or user state;
#: DESTRUCTIVE deletes or forcibly rewrites; IRREVERSIBLE leaves the
#: machine or the outside world (a pushed branch, a sent request).
ActionRisk = Literal[
    "read-only", "low-risk", "modify", "destructive", "irreversible",
]

#: Closed category taxonomy for grouping and search. A capability has
#: exactly one; queries match it plus its actions.
Category = Literal[
    "development", "version-control", "containers", "browsers",
    "documents", "media", "system", "ai", "network", "database",
    "applications",
]


class CapabilityAction(ContractModel):
    """One thing AURA may do with a capability.

    ``argv`` is a FIXED template naming the resolved executable slot
    (``{exe}``) plus constant arguments only — never formatted with
    model output. Resolution substitutes the measured path; anything
    needing caller-supplied operands is composed by the governed
    executor that owns the capability, not by this table.
    """

    name: str
    description: str = ""
    risk: ActionRisk = "read-only"
    #: Fixed argument template, e.g. ["{exe}", "--version"]. Constant
    #: strings only; resolution refuses templates with any other shape.
    argv: list[str] = []
    #: When True the action must not run without a human decision upstream
    #: (the registry never decides that itself — it only reports it).
    requires_approval: bool = False


class Capability(ContractModel):
    """One measured machine capability. Serializable and prompt-safe:
    paths and versions are machine facts, never secrets — the registry
    never stores environment dumps, keys, or credential files.
    """

    id: str
    name: str
    category: Category = "system"
    description: str = ""
    source: Source = "system"
    #: Bare executable name, e.g. "git". Never a path from outside.
    executable: str | None = None
    #: Measured absolute path, or None when not resolved.
    executable_path: str | None = None
    version: str | None = None
    availability: Availability = "unknown"
    health: Health = "unchecked"
    #: Why unavailable/unknown/degraded, in plain words. Always set
    #: when availability != "available" — "unknown" without a reason
    #: is how a gap hides.
    reason: str = ""
    actions: list[CapabilityAction] = []
    #: Other capability ids (or service names like "docker-daemon")
    #: this one needs in order to be USEFUL, e.g. docker → daemon.
    requirements: list[str] = []
    #: How to get it, when the existing install affordances know —
    #: otherwise None, never an invented command.
    install_hint: str | None = None
    metadata: dict = {}


class Resolution(ContractModel):
    """The answer to 'which actual executable performs (capability, action)?'

    Either ``ok`` with a measured path and fixed argv, or ``ok=False``
    with the honest reason. There is no third state and no fallback
    command: an unresolvable request is refused, not reinterpreted.
    """

    ok: bool
    capability_id: str
    action: str = ""
    executable_path: str | None = None
    argv: list[str] = []
    version: str | None = None
    risk: ActionRisk = "read-only"
    reason: str = ""
