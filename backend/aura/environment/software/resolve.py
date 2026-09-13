"""One search, resolved through every layer AURA has — cheapest first.

    local inventory  →  curated catalogue  →  discovery cache  →  registries

The order is the whole design. Local truth is free and authoritative, the
curated catalogue is free and trusted, the cache is free and merely stale,
and only a query that none of those satisfy is worth a network call. A
user searching "git" on a machine that has git must never wait on npm.

Two rules hold everywhere below:

  1. Machine state is authoritative for `installed`, `verified` and
     `connected`. A cached or registry record can describe software, but
     it can never assert that it is present here. Those flags are read
     from the existing inventory on every search, never from cache.

  2. Registry metadata never becomes installation authority. Records are
     merged by canonical identity, and installability is then decided by
     `installability`, which consults the curated catalogue alone.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .. import hostplatform
from ..catalog import ALL
from ..inventory.service import get_inventory
from . import cache
from .classify import classify
from .identity import (
    Provenance,
    SoftwareKind,
    SoftwareRecord,
    SoftwareState,
    Trust,
    canonical_id,
    highest,
)
from .installability import apply_installability
from .sources import external_sources

#: Registries are consulted only when the local layers found nothing
#: worth showing. This is the "lazy" in lazy discovery.
EXTERNAL_MIN_QUERY = 2
DEFAULT_LIMIT = 12


@dataclass
class SearchOutcome:
    query: str
    records: list[SoftwareRecord] = field(default_factory=list)
    #: Which layers actually answered — shown to the user as the
    #: "Searching AURA catalogue… checking trusted sources…" trail.
    consulted: list[str] = field(default_factory=list)
    #: True when a network source was tried and could not be reached.
    offline: bool = False
    #: True when results include cached data older than its TTL.
    stale: bool = False
    detail: str = ""

    def to_dict(self) -> dict:
        return {
            "query": self.query,
            "results": [r.to_dict() for r in self.records],
            "consulted": list(self.consulted),
            "offline": self.offline,
            "stale": self.stale,
            "detail": self.detail,
        }


def _matches(query: str, *fields: str) -> bool:
    q = query.strip().lower()
    return any(q in (f or "").lower() for f in fields)


def _from_inventory(query: str, limit: int) -> list[SoftwareRecord]:
    """What this machine actually has. Never a network call."""
    try:
        inv = get_inventory(refresh=False, verify=False)
    except Exception:                       # inventory unreadable, not fatal
        return []
    out: list[SoftwareRecord] = []
    for item in getattr(inv, "items", []) or []:
        name = item.display_name or item.name
        if not _matches(query, name, item.name, *(item.aliases or [])):
            continue
        rec = SoftwareRecord(
            canonical_id=canonical_id(item.catalog_id or name),
            display_name=name,
            summary=item.description or "",
            category=item.category or "",
            latest_version=item.version or "",
            installed_version=item.version or "",
            executables=[item.command] if item.command else [],
            aliases=[a for a in (item.aliases or []) if a],
            catalog_id=item.catalog_id,
            installed=bool(item.installed),
            verified=bool(item.verified),
            connected=bool(item.connected),
            provenance=[Provenance(
                source="inventory", trust=Trust.MACHINE,
                identifier=item.key, version=item.version or "")],
        )
        rec.kind = classify(
            name=name, summary=rec.summary,
            executables=rec.executables, category=rec.category)
        # The ladder, from what the machine proved and nothing more.
        rec.state = highest(
            SoftwareState.INSTALLED if rec.installed else SoftwareState.UNKNOWN,
            SoftwareState.VERIFIED if rec.verified else SoftwareState.UNKNOWN,
            SoftwareState.CONNECTED if rec.connected else SoftwareState.UNKNOWN,
        )
        out.append(rec)
        if len(out) >= limit:
            break
    return out


def _from_catalogue(query: str, limit: int) -> list[SoftwareRecord]:
    """What AURA curates. Free, trusted, and offline-safe."""
    out: list[SoftwareRecord] = []
    for entry in ALL:
        if not _matches(query, entry.name, entry.id, entry.summary):
            continue
        rec = SoftwareRecord(
            canonical_id=canonical_id(entry.id),
            display_name=entry.name,
            summary=entry.summary,
            category=entry.category,
            homepage=entry.homepage,
            catalog_id=entry.id,
            platforms=(["linux", "darwin", "windows"] if entry.cross_platform
                       else [hostplatform.current()]),
            executables=[entry.probe.command] if entry.probe else [],
            provenance=[Provenance(
                source="catalog", trust=Trust.CURATED, identifier=entry.id,
                url=entry.homepage)],
            state=SoftwareState.CATALOGUE,
        )
        rec.add_alias(entry.id)
        rec.kind = classify(name=entry.name, summary=entry.summary,
                            executables=rec.executables, category=entry.category)
        out.append(rec)
        if len(out) >= limit:
            break
    return out


def _merge(into: list[SoftwareRecord], extra: list[SoftwareRecord]) -> None:
    """Fold new records into existing identities. One tool, one card.

    A tool that appears in the catalogue, the inventory, npm and PyPI is
    ONE result listing four sources — not four results. Descriptive gaps
    are filled from the incoming record; machine truth and curated
    identity already present are never overwritten by a weaker source.
    """
    by_id = {r.canonical_id: r for r in into}
    for rec in extra:
        existing = by_id.get(rec.canonical_id)
        if existing is None:
            into.append(rec)
            by_id[rec.canonical_id] = rec
            continue
        existing.provenance.extend(rec.provenance)
        for alias in [rec.display_name, *rec.aliases]:
            existing.add_alias(alias)
        for exe in rec.executables:
            if exe and exe not in existing.executables:
                existing.executables.append(exe)
        existing.summary = existing.summary or rec.summary
        existing.homepage = existing.homepage or rec.homepage
        existing.repository = existing.repository or rec.repository
        existing.latest_version = existing.latest_version or rec.latest_version
        existing.category = existing.category or rec.category
        if existing.kind in (SoftwareKind.UNKNOWN, SoftwareKind.LIBRARY):
            existing.kind = rec.kind
        existing.state = highest(existing.state, rec.state)


def _rank_key(query: str, r: SoftwareRecord):
    """Exact identity, then local truth, then trust. Never popularity."""
    q = canonical_id(query)
    return (
        0 if r.canonical_id == q else 1,
        0 if q in [canonical_id(a) for a in r.aliases] else 1,
        0 if r.connected else 1,
        0 if r.verified else 1,
        0 if r.installed else 1,
        0 if r.catalog_id else 1,
        {Trust.CURATED: 0, Trust.MACHINE: 1, Trust.REGISTRY: 2,
         Trust.UNKNOWN: 3}[r.trust_level()],
        r.display_name.lower(),
    )


def _platform_ok(r: SoftwareRecord) -> bool:
    if not r.platforms:
        return True                          # unstated is not "unsupported"
    return hostplatform.current() in r.platforms


def search(query: str, *, limit: int = DEFAULT_LIMIT,
           allow_external: bool = True) -> SearchOutcome:
    """Resolve one user query through every layer AURA has."""
    q = (query or "").strip()
    outcome = SearchOutcome(query=q)
    if not q:
        return outcome

    records: list[SoftwareRecord] = []

    local = _from_inventory(q, limit)
    outcome.consulted.append("inventory")
    _merge(records, local)

    curated = _from_catalogue(q, limit)
    outcome.consulted.append("catalog")
    _merge(records, curated)

    # A curated or locally-present answer is the answer. Going to the
    # network here would add latency and nothing else.
    satisfied = any(r.catalog_id or r.installed for r in records)

    if not satisfied:
        cached = cache.load(q)
        if cached and cached.records:
            outcome.consulted.append("cache")
            outcome.stale = not cached.is_fresh()
            _merge(records, cached.records)
            satisfied = cached.is_fresh()

    if allow_external and not satisfied and len(q) >= EXTERNAL_MIN_QUERY:
        discovered: list[SoftwareRecord] = []
        for source in external_sources():
            result = source.search(q, limit=limit)
            outcome.consulted.append(source.id)
            if result.unreachable:
                outcome.offline = True
                outcome.detail = outcome.detail or result.detail
            discovered.extend(result.records)
        if discovered:
            outcome.offline = False          # something answered
            _merge(records, discovered)
            cache.store(q, discovered)

    # Machine truth first, THEN the installability gate — so nothing is
    # demoted below what the machine already proved.
    for rec in records:
        apply_installability(rec)

    # Libraries are classified, kept in provenance, and not offered as
    # tools. A user searching for a dependency gets an honest answer
    # rather than a card implying AURA could use it.
    usable = [r for r in records
              if r.kind is not SoftwareKind.LIBRARY or r.installed or r.catalog_id]
    usable = [r for r in usable if _platform_ok(r)]
    usable.sort(key=lambda r: _rank_key(q, r))
    outcome.records = usable[:limit]
    if not outcome.records and not outcome.detail:
        outcome.detail = (
            "AURA could not verify this software from any trusted source."
            if not outcome.offline else
            "Trusted software sources could not be reached from this machine.")
    return outcome
