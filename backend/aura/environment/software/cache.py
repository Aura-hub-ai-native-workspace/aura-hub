"""The discovery cache — what the network said, kept apart from what AURA knows.

This store and the curated catalogue are deliberately different things,
and the separation is a security boundary rather than an optimisation:

    curated catalogue   in-repo, reviewed, carries InstallSpec/ProbeSpec.
                        The ONLY thing that can authorise an install.
    discovery cache     whatever a registry returned. Descriptions,
                        aliases, versions, provenance, timestamps.
                        Carries no install authority and never gains any.

Nothing here is ever promoted into the catalogue. A record can be shown
to a person, and it can be matched BY NAME against the catalogue to see
whether AURA already knows the software — but the match is what confers
installability, not the cached record. That is why `load` returns plain
descriptions and nothing resembling a command.

The cache exists so a second search for the same name does not hit the
network again, and so a machine that is offline can still show what it
learned when it was online — labelled stale, never presented as live.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass

from ...config import aura_home
from .identity import (
    Provenance,
    SoftwareKind,
    SoftwareRecord,
    Trust,
    canonical_id,
)

#: How long a registry answer stays fresh. Long enough to make repeat
#: searches free, short enough that a version does not go stale for days.
TTL_SECONDS = 6 * 60 * 60
#: Ceiling on cached queries; this is a convenience store, not a mirror.
MAX_ENTRIES = 500


def _path():
    return aura_home() / "software" / "discovery-cache.json"


@dataclass
class CachedQuery:
    query: str
    at: float
    records: list[SoftwareRecord]

    def age_seconds(self) -> float:
        return max(0.0, time.time() - self.at)

    def is_fresh(self) -> bool:
        return self.age_seconds() < TTL_SECONDS


def _record_to_json(r: SoftwareRecord) -> dict:
    # Only descriptive fields are persisted. Machine truth (installed,
    # verified, connected) is deliberately NOT cached: it is re-derived
    # from the live inventory on every search, so a stale cache can never
    # claim something is installed when it is not.
    return {
        "canonicalId": r.canonical_id,
        "displayName": r.display_name,
        "kind": r.kind.value,
        "summary": r.summary,
        "homepage": r.homepage,
        "repository": r.repository,
        "latestVersion": r.latest_version,
        "aliases": list(r.aliases),
        "executables": list(r.executables),
        "provenance": [
            {"source": p.source, "trust": p.trust.value,
             "identifier": p.identifier, "url": p.url,
             "version": p.version, "fetchedAt": p.fetched_at}
            for p in r.provenance
        ],
    }


def _record_from_json(d: dict) -> SoftwareRecord | None:
    name = str(d.get("displayName") or "")
    if not name:
        return None
    try:
        kind = SoftwareKind(str(d.get("kind") or "unknown"))
    except ValueError:
        kind = SoftwareKind.UNKNOWN
    prov: list[Provenance] = []
    for p in d.get("provenance") or []:
        if not isinstance(p, dict):
            continue
        try:
            trust = Trust(str(p.get("trust") or "unknown"))
        except ValueError:
            trust = Trust.UNKNOWN
        # A cached record can never claim curated trust: that would let a
        # stale file impersonate AURA's own catalogue.
        if trust is Trust.CURATED:
            trust = Trust.REGISTRY
        prov.append(Provenance(
            source=str(p.get("source") or "cache"), trust=trust,
            identifier=str(p.get("identifier") or name),
            url=str(p.get("url") or ""), version=str(p.get("version") or ""),
            fetched_at=str(p.get("fetchedAt") or "")))
    return SoftwareRecord(
        canonical_id=str(d.get("canonicalId") or canonical_id(name)),
        display_name=name, kind=kind,
        summary=str(d.get("summary") or ""),
        homepage=str(d.get("homepage") or ""),
        repository=str(d.get("repository") or ""),
        latest_version=str(d.get("latestVersion") or ""),
        aliases=[str(a) for a in (d.get("aliases") or []) if isinstance(a, str)],
        executables=[str(e) for e in (d.get("executables") or []) if isinstance(e, str)],
        provenance=prov,
    )


def _read_all() -> dict:
    try:
        raw = _path().read_text(encoding="utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def load(query: str) -> CachedQuery | None:
    """What a previous search for this term returned, if anything."""
    key = (query or "").strip().lower()
    if not key:
        return None
    entry = _read_all().get(key)
    if not isinstance(entry, dict):
        return None
    records = [r for r in (_record_from_json(d) for d in entry.get("records") or [])
               if r is not None]
    return CachedQuery(query=key, at=float(entry.get("at") or 0.0), records=records)


def store(query: str, records: list[SoftwareRecord]) -> None:
    """Remember what the network said. Best-effort: a cache that cannot
    be written must never break the search that produced it."""
    key = (query or "").strip().lower()
    if not key:
        return
    data = _read_all()
    data[key] = {"at": time.time(),
                 "records": [_record_to_json(r) for r in records[:25]]}
    if len(data) > MAX_ENTRIES:
        # Drop the oldest queries; this is a convenience store.
        for stale, _ in sorted(
                data.items(), key=lambda kv: float(kv[1].get("at") or 0.0)
        )[: len(data) - MAX_ENTRIES]:
            data.pop(stale, None)
    try:
        p = _path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, indent=1), encoding="utf-8")
    except OSError:
        pass


def clear() -> None:
    try:
        _path().unlink()
    except OSError:
        pass
