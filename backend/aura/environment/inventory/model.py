"""The shape of a complete machine inventory.

One installed thing is one :class:`InventoryItem`, however many places it
was found. The places themselves are kept as :class:`Evidence`, because
"npm says 1.2.3 and the binary says 1.2.4" is information an engineer needs,
not a conflict to resolve by picking one.

The states are deliberately five, not one boolean:

``installed``  an authoritative source says it is on this machine
``detected``   AURA saw the file or the record itself
``verified``   AURA ran it, safely, and it reported a version
``usable``     verified *and* reachable as a command right now
``connected``  AURA has an integration wired to it

A package database can establish ``installed`` without anything being
executed. That is the whole point: completeness comes from reading
authoritative records, not from running software.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any


class ItemKind(str, Enum):
    """What sort of thing this is, as far as the machine is concerned."""

    APPLICATION = "application"
    """A GUI application: a .desktop entry, an .app bundle, an AppImage."""

    CLI = "cli"
    """A command an engineer would type."""

    RUNTIME = "runtime"
    """A language runtime or interpreter."""

    SDK = "sdk"
    """A toolchain or development kit."""

    LIBRARY = "library"
    """Something installed as a dependency rather than for its own sake."""

    PACKAGE = "package"
    """A package-manager record with no clearer classification."""

    UNKNOWN = "unknown"


class TrustLevel(str, Enum):
    """Whether AURA may execute this, and why."""

    TRUSTED = "trusted"
    UNTRUSTED = "untrusted"
    BLOCKED = "blocked"
    UNKNOWN = "unknown"


class SourceKind(str, Enum):
    """The class of authority a source speaks with."""

    OS_PACKAGE = "os-package"
    LANGUAGE_PACKAGE = "language-package"
    APPLICATION = "application"
    PATH = "path"
    VERSION_MANAGER = "version-manager"
    CATALOG = "catalog"


@dataclass(frozen=True)
class Evidence:
    """One source's account of one item. Never merged away, only collected."""

    source: str
    kind: SourceKind
    package: str | None = None
    version: str | None = None
    location: str | None = None
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "kind": self.kind.value,
            "package": self.package,
            "version": self.version,
            "location": self.location,
            "detail": self.detail,
        }


@dataclass
class InventoryItem:
    """One installed thing, with everything known about it."""

    key: str
    name: str
    display_name: str = ""
    kind: ItemKind = ItemKind.UNKNOWN
    category: str = "unknown"

    version: str | None = None
    #: Every version any source reported, in source order. More than one
    #: means the sources disagree, which is shown rather than resolved.
    versions: list[str] = field(default_factory=list)

    install_location: str | None = None
    executable_path: str | None = None
    command: str | None = None

    package_manager: str | None = None
    package_name: str | None = None
    package_version: str | None = None

    publisher: str | None = None
    description: str | None = None

    installed: bool = False
    detected: bool = False
    verified: bool = False
    usable: bool = False
    connected: bool = False

    execution_allowed: bool = False
    execution_performed: bool = False
    trust_level: TrustLevel = TrustLevel.UNKNOWN
    trust_reason: str = ""

    aliases: list[str] = field(default_factory=list)
    #: Same-named commands further along PATH that this one takes precedence over.
    shadowed: list[str] = field(default_factory=list)
    evidence: list[Evidence] = field(default_factory=list)
    last_seen: str = ""

    #: Every identity this item answers to, used for merging (see identity.py).
    keys: set[str] = field(default_factory=set)
    #: Commands the item's package metadata says it provides.
    provides: set[str] = field(default_factory=set)
    #: The catalog node this was matched to, when one applies.
    catalog_id: str | None = None

    @property
    def sources(self) -> list[str]:
        seen: list[str] = []
        for item in self.evidence:
            if item.source not in seen:
                seen.append(item.source)
        return seen

    @property
    def version_conflict(self) -> bool:
        """Two sources disagree about what is installed."""
        distinct = {_normalise_version(v) for v in self.versions if v}
        return len(distinct) > 1

    def add_evidence(self, item: Evidence) -> None:
        self.evidence.append(item)
        if item.version and item.version not in self.versions:
            self.versions.append(item.version)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.key,
            "key": self.key,
            "name": self.name,
            "displayName": self.display_name or self.name,
            "kind": self.kind.value,
            "category": self.category,
            "version": self.version,
            "versions": list(self.versions),
            "versionConflict": self.version_conflict,
            "installLocation": self.install_location,
            "executablePath": self.executable_path,
            "command": self.command,
            "packageManager": self.package_manager,
            "packageName": self.package_name,
            "packageVersion": self.package_version,
            "publisher": self.publisher,
            "description": self.description,
            "installed": self.installed,
            "detected": self.detected,
            "verified": self.verified,
            "usable": self.usable,
            "connected": self.connected,
            "executionAllowed": self.execution_allowed,
            "executionPerformed": self.execution_performed,
            "trustLevel": self.trust_level.value,
            "trustReason": self.trust_reason,
            "aliases": sorted(self.aliases),
            "shadowed": list(self.shadowed),
            "sources": self.sources,
            "evidence": [e.to_dict() for e in self.evidence],
            "catalogId": self.catalog_id,
            "lastSeen": self.last_seen,
        }


def _normalise_version(value: str) -> str:
    """Compare versions the way a person would.

    Distributions decorate upstream versions with their own release and
    epoch (``1:2.45.1-3``); those are the same software as ``2.45.1`` and
    reporting a conflict for them would be noise.
    """
    text = value.strip().lstrip("vV")
    if ":" in text:
        text = text.split(":", 1)[1]
    if "-" in text:
        head = text.split("-", 1)[0]
        if head:
            text = head
    return text


@dataclass
class SourceReport:
    """What one inventory source was able to say, and how completely.

    A source that is not installed is ``available=False`` — which is not the
    same as "there is no software of this kind", and the difference has to
    survive all the way to the operator.
    """

    name: str
    kind: SourceKind
    available: bool = True
    items: int = 0
    total: int = 0
    truncated: bool = False
    duration_ms: int = 0
    error: str = ""
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind.value,
            "available": self.available,
            "items": self.items,
            "total": self.total,
            "truncated": self.truncated,
            "durationMs": self.duration_ms,
            "error": self.error or None,
            "detail": self.detail or None,
        }


@dataclass
class SourceResult:
    """One source's contribution: what it found, and how it went."""

    report: SourceReport
    items: list[InventoryItem] = field(default_factory=list)


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
