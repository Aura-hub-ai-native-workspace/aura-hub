"""AURA Context Fabric — the contract.

A port of packages/ai-service/src/context/types.ts.

A `ContextView` is ONE project's understanding, at ONE moment, in a shape
every downstream surface can consume without re-deriving it. This module
defines vocabulary only. It computes nothing.

Two rules govern every field here:

1. **Unknown is not empty.** A section that was never computed is
   `unknown`; a section that was computed and found nothing is `fresh`
   with an empty payload. Collapsing the two would let an agent read "no
   recent commits" when the truth is "nobody looked".

2. **Nothing is invented.** Every value is projected from an existing
   authority. Where an authority cannot answer, the field is `unknown`
   and says why.

The Context Fabric is READ-ONLY.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from ..core.js_number import to_js_numbers

CONTRACT_VERSION = 1

# fresh — computed, and nothing has changed since
# stale — computed, but the repository moved underneath it
# unknown — never computed, or the authority could not answer
Freshness = Literal["fresh", "stale", "unknown"]

CapabilityAvailability = Literal["available", "approval", "not-drivable", "unavailable"]

ContextSurface = Literal[
    "general", "coding", "debugging", "architecture", "git",
    "testing", "mission", "planning", "review",
]

# Surface → the existing repository intent. One-way, total, explicit.
# This introduces no second intent system: it is a caller-facing alias
# for the vocabulary `intelligence/contextAssembler.ts` already owns.
SURFACE_INTENT: dict[str, str] = {
    "general": "project_overview",
    "coding": "code_search",
    "debugging": "debugging",
    "architecture": "architecture",
    "git": "project_overview",
    "testing": "testing",
    "mission": "project_overview",
    "planning": "architecture",
    "review": "refactoring",
}


@dataclass
class EnvironmentSnapshot:
    """The environment as the caller last measured it.

    Supplied rather than scanned: the service already holds the result of
    the one environment scanner, and composing context must never trigger
    a second scan.
    """

    scanned_at: str | None
    # Present nodes in catalogue order.
    nodes: list[dict[str, Any]] = field(default_factory=list)
    provided_capabilities: list[str] = field(default_factory=list)


@dataclass
class Section:
    """A section that may legitimately have no answer yet."""

    value: Any
    freshness: Freshness
    generated_at: str | None = None
    # Why it is stale or unknown. Absent when fresh.
    reason: str | None = None

    def to_json(self) -> dict[str, Any]:
        # `generatedAt` is explicitly `null` in the reference and survives
        # serialization; only `reason` is `undefined` when fresh, and
        # `JSON.stringify` drops it. The difference is visible to every
        # client, so it is reproduced rather than tidied.
        payload = {
            "value": self.value,
            "freshness": self.freshness,
            "generatedAt": self.generated_at,
        }
        if self.reason is not None:
            payload["reason"] = self.reason
        return payload


@dataclass
class ContextProject:
    """L0 — identity. Cheap enough to always carry."""

    id: str
    name: str
    # Absolute path from the registry. Never guessed.
    root: str
    type: str
    language: str
    # True when this project is the one the pipeline currently has mounted.
    mounted: bool
    last_opened_at: str | None

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "root": self.root,
            "type": self.type, "language": self.language,
            "mounted": self.mounted, "lastOpenedAt": self.last_opened_at,
        }


@dataclass
class ContextConstraint:
    """A rule the consuming agent must obey — a fact, not advice."""

    id: str
    text: str

    def to_json(self) -> dict[str, str]:
        return {"id": self.id, "text": self.text}


@dataclass
class ContextGit:
    """L4 — current git state."""

    branch: str
    dirty: bool
    changed_files: int
    recent_commits: list[dict[str, str]] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "branch": self.branch, "dirty": self.dirty,
            "changedFiles": self.changed_files,
            "recentCommits": self.recent_commits,
        }

    @classmethod
    def from_json(cls, raw: dict[str, Any]) -> ContextGit:
        return cls(
            branch=raw.get("branch", ""),
            dirty=bool(raw.get("dirty")),
            changed_files=int(raw.get("changedFiles", 0)),
            recent_commits=raw.get("recentCommits") or [],
        )


@dataclass
class ContextUnavailable:
    """A project that could not be resolved.

    Returned INSTEAD of a view, so a caller can never mistake "no such
    project" for "an empty project".
    """

    project_id: str
    reason: str

    def to_json(self) -> dict[str, Any]:
        return {
            "contractVersion": CONTRACT_VERSION,
            "status": "unavailable",
            "projectId": self.project_id,
            "reason": self.reason,
        }


@dataclass
class ContextView:
    """Everything AURA knows about ONE project, right now, with the
    provenance of each part attached.

    A `ContextView` never mixes projects.
    """

    # The project's context version, from intelligence versioning.
    # None when no snapshot has ever been taken — never a fabricated 0.
    context_version: int | None
    composed_at: str
    surface: str
    # The worst freshness across all known sections.
    freshness: Freshness
    project: ContextProject
    repository: Section
    changes: Section
    git: Section
    environment: Section
    capabilities: Section
    missions: Section
    activity: Section
    constraints: list[ContextConstraint]

    def to_json(self) -> dict[str, Any]:
        return to_js_numbers({
            "contractVersion": CONTRACT_VERSION,
            "contextVersion": self.context_version,
            "composedAt": self.composed_at,
            "surface": self.surface,
            "freshness": self.freshness,
            "project": self.project.to_json(),
            "repository": self.repository.to_json(),
            "changes": self.changes.to_json(),
            "git": self.git.to_json(),
            "environment": self.environment.to_json(),
            "capabilities": self.capabilities.to_json(),
            "missions": self.missions.to_json(),
            "activity": self.activity.to_json(),
            "constraints": [c.to_json() for c in self.constraints],
        })


ContextResult = ContextView | ContextUnavailable


def is_unavailable(result: ContextResult) -> bool:
    return isinstance(result, ContextUnavailable)
