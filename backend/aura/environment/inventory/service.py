"""Assembling the machine inventory, and keeping it fresh cheaply.

The order matters and is the inversion this module exists for:

    machine → inventory sources → normalise → deduplicate
            → catalog enrichment → optional safe verification

The catalog is metadata applied at the end, not the question asked at the
start. Software AURA has never heard of is inventoried exactly as well as
software it ships a definition for.

Verification is the last step and the smallest one. Everything is already
``installed`` by the time it runs; probing only ever upgrades an item to
``verified``, and only for items whose provenance and location already
satisfy the execution policy.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any

from ..catalog import ALL
from ..observability import redact, scan_logger
from ..pathsec import effective_path
from ..provenance import ProvenanceIndex, build_index
from .identity import InventoryIndex, choose_version
from .model import (
    Evidence,
    InventoryItem,
    ItemKind,
    SourceKind,
    SourceReport,
    TrustLevel,
    now_iso,
)
from .sources import attribute_system_commands, collect_sources, enumerate_path

#: How long a full inventory stays usable without an explicit refresh.
#: Package databases change when a person installs something, which is rare
#: relative to how often a screen is opened.
INVENTORY_TTL_MS = 300_000

#: How many items may be verified by execution in one pass. Verification is
#: a convenience on top of a complete inventory, never the thing that makes
#: it complete, so this bound costs accuracy of `verified` and nothing else.
MAX_VERIFY = 60


@dataclass
class Inventory:
    """The whole machine, as far as it can be authoritatively established."""

    items: list[InventoryItem] = field(default_factory=list)
    sources: list[SourceReport] = field(default_factory=list)
    collected_at: str = ""
    duration_ms: int = 0
    verified_count: int = 0
    degraded: bool = False

    @property
    def counts(self) -> dict[str, int]:
        return {
            "total": len(self.items),
            "installed": sum(1 for i in self.items if i.installed),
            "detected": sum(1 for i in self.items if i.detected),
            "verified": sum(1 for i in self.items if i.verified),
            "usable": sum(1 for i in self.items if i.usable),
            "connected": sum(1 for i in self.items if i.connected),
            "applications": sum(1 for i in self.items if i.kind is ItemKind.APPLICATION),
            "cli": sum(1 for i in self.items if i.kind is ItemKind.CLI),
            "runtimes": sum(1 for i in self.items if i.kind is ItemKind.RUNTIME),
            "libraries": sum(1 for i in self.items if i.kind is ItemKind.LIBRARY),
            "packages": sum(1 for i in self.items if i.kind is ItemKind.PACKAGE),
        }


# ── catalog enrichment ──────────────────────────────────────────────────


def _catalog_lookup() -> dict[str, Any]:
    """Command name → catalog entry.

    Keyed strictly on the commands a catalog entry actually probes for.
    Matching on the entry's *id* as well was enough to identify the
    distribution's `neon` package — an HTTP/WebDAV library — as the Neon
    serverless-Postgres CLI, and report its `neon-config` version as
    Neon's. A catalog node is only that node if the machine has the command
    that node is defined by.
    """
    table: dict[str, Any] = {}
    for entry in ALL:
        if entry.probe is None:
            continue
        for candidate in entry.probe.candidates:
            name = candidate.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
            if name:
                table.setdefault(name.lower(), entry)
    return table


def _enrich_with_catalog(items: list[InventoryItem]) -> int:
    """Attach AURA's own knowledge to whatever the machine reported.

    This is the only place the catalog touches the inventory, and it can
    only add: a name AURA prefers, a category, and the node id that Connect
    later uses. Nothing is removed for being unknown.
    """
    table = _catalog_lookup()
    matched = 0
    for item in items:
        # Only commands the item genuinely provides count. Its package name
        # is not a command, and treating it as one produces confident
        # misidentifications.
        names = {c.lower() for c in item.provides}
        if item.command:
            names.add(item.command.lower())
        entry = next((table[n] for n in sorted(names) if n in table), None)
        if entry is None:
            continue
        matched += 1
        item.catalog_id = entry.id
        item.display_name = entry.name
        if item.category in ("unknown", ""):
            item.category = entry.category
        if not item.description:
            item.description = entry.summary
        if item.kind in (ItemKind.UNKNOWN, ItemKind.PACKAGE):
            item.kind = ItemKind.CLI
    return matched


# ── verification ────────────────────────────────────────────────────────


#: Kinds worth spending an execution on. A shared library recorded by the
#: distribution is already `installed` on the strongest possible evidence;
#: running it would tell nobody anything.
_WORTH_VERIFYING = (ItemKind.CLI, ItemKind.RUNTIME, ItemKind.APPLICATION, ItemKind.SDK)


def _verification_order(items: list[InventoryItem]) -> list[InventoryItem]:
    """Which items are worth spending an execution on.

    Verification is a small bonus on top of a complete inventory, so the
    budget goes where it changes an answer: tools AURA can actually drive,
    then other real commands. Sorting alphabetically instead spent the
    entire budget on `aalib`, `autoconf` and `babl` — all of them already
    known to be installed, none of them a thing anyone asked about.
    """
    ranked = [
        item
        for item in items
        if item.executable_path
        and item.trust_level is TrustLevel.TRUSTED
        and item.kind in _WORTH_VERIFYING
        # An authoritative package version is already the answer; running
        # the binary to learn what the distribution already recorded costs
        # an execution and tells us nothing new. Catalog tools are the
        # exception: AURA drives those, so it wants runtime confirmation
        # that the thing actually starts.
        and (item.catalog_id is not None or not item.package_version)
    ]
    ranked.sort(
        key=lambda item: (
            item.catalog_id is None,
            item.kind is not ItemKind.CLI and item.kind is not ItemKind.RUNTIME,
            # A command named after its own package is the package's real
            # entry point; a stray helper from the same package is not.
            (item.command or "").lower() != (item.package_name or item.name).lower(),
            item.name.lower(),
        )
    )
    return ranked


def _probe_target(item: InventoryItem) -> tuple[str | None, list[str]]:
    """The file to run and the arguments to run it with.

    A package installs many binaries and the one that answers a version
    question is not always the one the inventory happened to record first —
    the Rust package ships `rust-lld`, whose `--version` reports LLD's
    version, not Rust's. Where AURA has a catalog definition it names the
    right command explicitly, so that wins.
    """
    from ..catalog import catalog_entry
    from ..pathsec import effective_path as _path
    from ..pathsec import resolve_executable

    if item.catalog_id:
        entry = catalog_entry(item.catalog_id)
        if entry is not None and entry.probe is not None:
            for candidate in entry.probe.candidates:
                resolved = resolve_executable(candidate, _path())
                if resolved is not None:
                    return resolved, list(entry.probe.args)
    return item.executable_path, ["--version"]


def _verify(items: list[InventoryItem], index: ProvenanceIndex, budget: int) -> int:
    """Upgrade what can be safely upgraded from installed to verified."""
    from ..discovery import extract_version
    from ..pathsec import location_trust
    from ..procexec import ExecStatus, run_argv

    def verify_one(item: InventoryItem) -> bool:
        path, args = _probe_target(item)
        if path is None:
            return False
        provenance = index.classify(path)
        # A catalog node is an explicit, reviewed decision that AURA drives
        # this tool, and the command it runs comes from repository data
        # rather than from the machine. That is its own provenance — the
        # same policy the catalog scan has always used. Everything else must
        # be claimed by a package manager.
        allowed = provenance.trusted or item.catalog_id is not None
        item.execution_allowed = allowed
        if not allowed:
            item.trust_level = TrustLevel.UNTRUSTED
            item.trust_reason = provenance.detail or "no package manager claims this file"
            return False

        verdict = location_trust(path)
        if not verdict.executable:
            item.trust_level = TrustLevel.BLOCKED
            item.trust_reason = verdict.reason
            item.execution_allowed = False
            return False

        outcome = run_argv(
            [path, *args],
            timeout_ms=8000,
            path=effective_path(),
            pin=verdict.identity,
        )
        item.execution_performed = True
        if outcome.status is not ExecStatus.OK:
            item.add_evidence(
                Evidence(
                    source="probe",
                    kind=SourceKind.PATH,
                    location=path,
                    detail=f"version check did not succeed ({outcome.status.value})",
                )
            )
            return False

        version = extract_version(outcome.output)
        if version is None:
            item.add_evidence(
                Evidence(
                    source="probe",
                    kind=SourceKind.PATH,
                    location=path,
                    detail="ran cleanly but reported no readable version",
                )
            )
            return False

        item.verified = True
        item.usable = True
        item.add_evidence(
            Evidence(
                source="probe",
                kind=SourceKind.PATH,
                version=version,
                location=path,
                detail=f"reported {version} when asked",
            )
        )
        return True

    targets = _verification_order(items)[:budget]
    if not targets:
        return 0
    # Bounded concurrency, like the catalog scan: a handful of slow CLIs
    # should not serialise the whole pass.
    with ThreadPoolExecutor(max_workers=min(8, len(targets)), thread_name_prefix="aura-verify") as pool:
        futures = {pool.submit(verify_one, item): item for item in targets}
        return sum(1 for future in as_completed(futures) if _safe_result(future))


def _safe_result(future) -> bool:
    try:
        return bool(future.result())
    except Exception:
        return False


# ── collection ──────────────────────────────────────────────────────────


def collect_inventory(*, verify: bool = True, verify_budget: int = MAX_VERIFY) -> Inventory:
    """Read every applicable source and build the deduplicated inventory."""
    started = time.monotonic()
    index = InventoryIndex()
    reports: list[SourceReport] = []

    for result in collect_sources():
        reports.append(result.report)
        for item in result.items:
            index.add(item)

    # Commands a package says it installs become that package's identity, so
    # a later PATH entry joins it instead of becoming a second item.
    for item in list(index.items):
        for command in list(item.provides)[:64]:
            index.link_command(item, command)

    path_result = enumerate_path(index)
    reports.append(path_result.report)

    attributed = attribute_system_commands(index, list(index.items))
    if attributed:
        scan_logger().info(
            "attributed PATH commands to packages",
            extra={"aura_event": "inventory.attributed", "count": attributed},
        )

    items = index.items
    matched = _enrich_with_catalog(items)

    verified = 0
    if verify:
        try:
            verified = _verify(items, build_index(), verify_budget)
        except Exception as exc:
            scan_logger().warning(
                "inventory verification failed",
                extra={"aura_event": "inventory.verify_failed", "error": redact(str(exc))},
            )

    stamp = now_iso()
    for item in items:
        choose_version(item)
        item.last_seen = stamp
        if item.executable_path and item.verified:
            item.usable = True

    items.sort(key=lambda item: (item.display_name or item.name).lower())

    inventory = Inventory(
        items=items,
        sources=reports,
        collected_at=stamp,
        duration_ms=int((time.monotonic() - started) * 1000),
        verified_count=verified,
    )
    scan_logger().info(
        "machine inventory collected",
        extra={
            "aura_event": "inventory.collected",
            "duration_ms": inventory.duration_ms,
            "items": len(items),
            "verified": verified,
            "catalog_matched": matched,
            "sources": len([r for r in reports if r.available]),
        },
    )
    return inventory


# ── cache and incremental refresh ───────────────────────────────────────

_lock = threading.RLock()
_cached: tuple[float, Inventory] | None = None
_last_good: Inventory | None = None
_fingerprint: str | None = None
_inflight: dict[str, threading.Event] = {}
_inflight_result: dict[str, Inventory] = {}


def _machine_fingerprint() -> str:
    """A cheap signal that something about the machine changed.

    Not a checksum of every package: the modification times of the package
    databases and bin directories move whenever software is installed or
    removed, which is exactly the event that should force a re-read.
    """
    import os

    from ..pathsec import home_dir

    watched = [
        "/var/lib/pacman/local",
        "/var/lib/dpkg/status",
        "/var/lib/rpm",
        "/usr/share/applications",
        str(home_dir() / ".local/share/applications"),
        str(home_dir() / ".local/share/pipx/venvs"),
        str(home_dir() / ".local/share/uv/tools"),
        str(home_dir() / ".cargo/bin"),
    ]
    parts: list[str] = [effective_path()]
    for target in watched:
        try:
            parts.append(f"{target}:{os.stat(target).st_mtime_ns}")
        except OSError:
            parts.append(f"{target}:-")
    return "|".join(parts)


def get_inventory(*, refresh: bool = False, verify: bool = True) -> Inventory:
    """The inventory, collected at most once however many callers ask.

    ``refresh=False`` reuses a cached inventory while it is inside its TTL
    *and* the machine fingerprint has not moved, so installing something is
    visible immediately rather than after the TTL expires.
    """
    global _cached, _last_good, _fingerprint

    fingerprint = _machine_fingerprint()
    if not refresh:
        with _lock:
            cached = _cached
            known = _fingerprint
        if cached is not None and known == fingerprint:
            at, inventory = cached
            if (time.monotonic() - at) * 1000 < INVENTORY_TTL_MS:
                return inventory

    key = f"{verify}"
    with _lock:
        waiting = _inflight.get(key)
        leader = waiting is None
        event = waiting or threading.Event()
        if leader:
            _inflight[key] = event

    if not leader:
        if event.wait(timeout=120):
            with _lock:
                shared = _inflight_result.get(key)
            if shared is not None:
                return shared
        return _collect_and_store(fingerprint, verify)

    try:
        inventory = _collect_and_store(fingerprint, verify)
        with _lock:
            _inflight_result[key] = inventory
        return inventory
    finally:
        with _lock:
            _inflight.pop(key, None)
        event.set()
        with _lock:
            _inflight_result.pop(key, None)


def _collect_and_store(fingerprint: str, verify: bool) -> Inventory:
    global _cached, _last_good, _fingerprint
    try:
        inventory = collect_inventory(verify=verify)
    except Exception as exc:
        scan_logger().warning(
            "inventory collection failed; reusing the last good result",
            extra={"aura_event": "inventory.failed", "error": redact(str(exc))},
        )
        with _lock:
            fallback = _last_good
        if fallback is None:
            return Inventory(collected_at=now_iso(), degraded=True)
        stale = Inventory(
            items=fallback.items,
            sources=fallback.sources,
            collected_at=fallback.collected_at,
            duration_ms=fallback.duration_ms,
            verified_count=fallback.verified_count,
            degraded=True,
        )
        return stale

    with _lock:
        _cached = (time.monotonic(), inventory)
        _last_good = inventory
        _fingerprint = fingerprint
    return inventory


def clear_cache() -> None:
    global _cached, _last_good, _fingerprint
    with _lock:
        _cached = None
        _last_good = None
        _fingerprint = None


def machine_changed() -> bool:
    """True when the machine looks different from the cached inventory."""
    with _lock:
        known = _fingerprint
    return known is not None and known != _machine_fingerprint()


# ── serialisation, with pagination ──────────────────────────────────────


def inventory_to_dict(
    inventory: Inventory,
    *,
    offset: int = 0,
    limit: int | None = 200,
    kinds: set[str] | None = None,
    query: str | None = None,
) -> dict[str, Any]:
    """Serialise a page of the inventory without ever lying about the whole.

    ``total`` is the number of items that matched, not the number returned.
    A caller that wants everything pages through it; a caller that wants a
    screenful gets one and is told how much more there is.
    """
    selected = inventory.items
    if kinds:
        selected = [item for item in selected if item.kind.value in kinds]
    if query:
        needle = query.strip().lower()
        if needle:
            selected = [
                item
                for item in selected
                if needle in item.name.lower()
                or needle in (item.display_name or "").lower()
                or any(needle in alias.lower() for alias in item.aliases)
                or needle in (item.package_name or "").lower()
            ]

    total = len(selected)
    start = max(0, offset)
    page = selected[start:] if limit is None else selected[start : start + max(0, limit)]

    return {
        "items": [item.to_dict() for item in page],
        "total": total,
        "returned": len(page),
        "offset": start,
        "truncated": start + len(page) < total,
        "counts": inventory.counts,
        "sources": [report.to_dict() for report in inventory.sources],
        "collectedAt": inventory.collected_at,
        "durationMs": inventory.duration_ms,
        "degraded": inventory.degraded,
    }


def find_by_catalog_id(inventory: Inventory, catalog_id: str) -> InventoryItem | None:
    return next((item for item in inventory.items if item.catalog_id == catalog_id), None)


__all__ = [
    "INVENTORY_TTL_MS",
    "Inventory",
    "clear_cache",
    "collect_inventory",
    "find_by_catalog_id",
    "get_inventory",
    "inventory_to_dict",
    "machine_changed",
]
