"""Canonical software identity, and how much AURA has actually proven.

Three things live here and nothing else: what a piece of software IS
(one identity, however many registries describe it), what AURA has
PROVEN about it, and what it may therefore be shown as.

The evidence ladder is the load-bearing idea. Every state below is a
claim someone could act on, so each is only reachable from a specific
piece of real evidence:

    CATALOGUE    AURA's curated knowledge names it
    DISCOVERED   an external source described it
    INSTALLABLE  a TRUSTED, curated InstallSpec exists for it
    INSTALLED    the machine inventory found it here
    VERIFIED     the existing probe ran it and read a version back
    CONNECTED    the existing connection path proved a round trip
    AURA_READY   AURA can actually delegate to it

A higher state is never inferred from a lower one. In particular
INSTALLABLE is NOT implied by "the package exists": a package existing
on npm, having a README, a repository, a bin field or a download link
are discovery signals, not installation authority. Only the curated
catalogue confers that, which is why `installability` is computed from
the catalogue alone and never from anything a network returned.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum


class SoftwareState(str, Enum):
    """What AURA can honestly say about one piece of software."""

    UNKNOWN = "UNKNOWN"
    #: An external source described it; AURA has no curated knowledge.
    DISCOVERED = "DISCOVERED"
    #: AURA's curated catalogue names it, but nothing is proven locally.
    CATALOGUE = "CATALOGUE"
    #: Described, but AURA will not offer to install it.
    UNTRUSTED = "UNTRUSTED"
    #: Known, but not installable on THIS platform.
    UNSUPPORTED = "UNSUPPORTED"
    #: A curated InstallSpec exists and applies to this platform.
    INSTALLABLE = "INSTALLABLE"
    #: The machine inventory found it on this machine.
    INSTALLED = "INSTALLED"
    #: The existing probe executed it and read a version.
    VERIFIED = "VERIFIED"
    #: The existing connection path proved a real round trip.
    CONNECTED = "CONNECTED"
    #: AURA can delegate to it now.
    AURA_READY = "AURA_READY"


#: Ordering for "do not claim more than was proven". Compared, never summed.
_RANK: dict[SoftwareState, int] = {
    SoftwareState.UNKNOWN: 0,
    SoftwareState.UNTRUSTED: 1,
    SoftwareState.UNSUPPORTED: 1,
    SoftwareState.DISCOVERED: 2,
    SoftwareState.CATALOGUE: 3,
    SoftwareState.INSTALLABLE: 4,
    SoftwareState.INSTALLED: 5,
    SoftwareState.VERIFIED: 6,
    SoftwareState.CONNECTED: 7,
    SoftwareState.AURA_READY: 8,
}


def rank(state: SoftwareState) -> int:
    return _RANK.get(state, 0)


def highest(*states: SoftwareState) -> SoftwareState:
    """The strongest state among those actually established."""
    best = SoftwareState.UNKNOWN
    for s in states:
        if rank(s) > rank(best):
            best = s
    return best


class SoftwareKind(str, Enum):
    """What KIND of thing this is — decided by classification evidence.

    The distinction that matters commercially is TOOL vs LIBRARY. A
    registry is mostly libraries; surfacing them as things AURA can use
    would bury the handful of real tools under thousands of transitive
    dependencies.
    """

    WORKER = "worker"          # an AI runtime AURA delegates work to
    CLI_TOOL = "cli-tool"
    APPLICATION = "application"
    RUNTIME = "runtime"
    SERVICE = "service"
    FRAMEWORK = "framework"
    SDK = "sdk"
    LIBRARY = "library"        # NOT offered as an AURA tool
    UNKNOWN = "unknown"


#: Kinds a user can meaningfully add to AURA as a tool.
USABLE_KINDS = frozenset({
    SoftwareKind.WORKER, SoftwareKind.CLI_TOOL, SoftwareKind.APPLICATION,
    SoftwareKind.RUNTIME, SoftwareKind.SERVICE,
})


class Trust(str, Enum):
    """Where the claim came from. Never a substitute for an InstallSpec."""

    CURATED = "curated"        # AURA's own in-repo catalogue
    MACHINE = "machine"        # this machine's inventory / package managers
    REGISTRY = "registry"      # a structured public registry (npm, PyPI)
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Provenance:
    """One source's account of a piece of software. Kept, never merged away."""

    source: str                # "catalog" | "inventory" | "npm" | "pypi"
    trust: Trust
    identifier: str            # the id THAT source uses
    url: str = ""
    version: str = ""
    fetched_at: str = ""


_SLUG_RE = re.compile(r"[^a-z0-9]+")
#: npm scopes and common packaging suffixes that do not change identity.
_NOISE = ("-cli", "-cli-tool", ".js", "-js", "-bin", "-core", "-tool")


def canonical_id(name: str) -> str:
    """One identity for the many names a single tool is published under.

    ``OpenCode``, ``opencode``, ``opencode-cli`` and ``@scope/opencode``
    are one tool; showing them as four results would be the duplicate
    problem this exists to prevent. Deliberately conservative — it folds
    packaging noise only, never two genuinely different names.
    """
    raw = (name or "").strip().lower()
    if raw.startswith("@") and "/" in raw:      # npm scope
        raw = raw.split("/", 1)[1]
    for suffix in _NOISE:
        if raw.endswith(suffix) and len(raw) > len(suffix) + 1:
            raw = raw[: -len(suffix)]
            break
    slug = _SLUG_RE.sub("-", raw).strip("-")
    return slug or "unknown"


@dataclass
class SoftwareRecord:
    """One piece of software, however many sources described it."""

    canonical_id: str
    display_name: str
    kind: SoftwareKind = SoftwareKind.UNKNOWN
    summary: str = ""
    category: str = ""
    homepage: str = ""
    repository: str = ""
    latest_version: str = ""
    aliases: list[str] = field(default_factory=list)
    platforms: list[str] = field(default_factory=list)
    #: Executables this software is expected to put on PATH. Classification
    #: evidence and probe hints — NEVER an install command.
    executables: list[str] = field(default_factory=list)
    provenance: list[Provenance] = field(default_factory=list)

    #: The curated catalogue id, when AURA actually knows this software.
    #: This — and only this — is what can make it installable.
    catalog_id: str | None = None

    state: SoftwareState = SoftwareState.UNKNOWN
    #: Machine truth, from the existing inventory/probe/connection paths.
    installed: bool = False
    verified: bool = False
    connected: bool = False
    installed_version: str = ""
    #: Why the state is what it is, in the user's language.
    reason: str = ""

    def trust_level(self) -> Trust:
        for want in (Trust.CURATED, Trust.MACHINE, Trust.REGISTRY):
            if any(p.trust == want for p in self.provenance):
                return want
        return Trust.UNKNOWN

    def sources(self) -> list[str]:
        seen: list[str] = []
        for p in self.provenance:
            if p.source not in seen:
                seen.append(p.source)
        return seen

    def add_alias(self, alias: str) -> None:
        a = (alias or "").strip()
        if a and a not in self.aliases and a != self.display_name:
            self.aliases.append(a)

    def to_dict(self) -> dict:
        return {
            "canonicalId": self.canonical_id,
            "displayName": self.display_name,
            "kind": self.kind.value,
            "summary": self.summary,
            "category": self.category,
            "homepage": self.homepage,
            "repository": self.repository,
            "latestVersion": self.latest_version,
            "aliases": list(self.aliases),
            "platforms": list(self.platforms),
            "executables": list(self.executables),
            "catalogId": self.catalog_id,
            "state": self.state.value,
            "installed": self.installed,
            "verified": self.verified,
            "connected": self.connected,
            "installedVersion": self.installed_version,
            "reason": self.reason,
            "trust": self.trust_level().value,
            "sources": self.sources(),
            "provenance": [
                {"source": p.source, "trust": p.trust.value,
                 "identifier": p.identifier, "url": p.url,
                 "version": p.version, "fetchedAt": p.fetched_at}
                for p in self.provenance
            ],
            # The ONE field the UI may use to decide whether to offer an
            # install. False for everything AURA has not curated.
            "installable": self.state is SoftwareState.INSTALLABLE,
        }
