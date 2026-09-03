"""Environment probe — the canonical transport for measuring real machine state.

This is the only place side effects enter the Connected Environment domain.

Security invariant: the command and arguments always come from the catalog
entry looked up by id, never from the request. A client can ask "probe the
node called `docker`"; it can never ask "run this string". Every execution
goes through :mod:`aura.environment.procexec`, which closes stdin, withholds
the parent's secrets, bounds output, and kills the whole process tree.

Correctness invariant: a probe is VERIFIED only when the command exited zero
*and* reported a readable version. Producing bytes is not evidence — a tool
that prints ``error: unrecognized flag --version`` to stderr and exits 2 is
broken, not installed, and must never show up as usable. Equally, a probe
that timed out is TIMEOUT, not NOT_FOUND: failing to answer in four seconds
is not proof of absence.
"""
from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from .catalog import BY_ID, CatalogEntry, catalog_entry, entries_for_scan
from .discovery import (
    DiscoveryReport,
    ToolStatus,
    discover_tools,
    discovered_to_dict,
    extract_version,
)
from .ospackages import (
    OsInventory,
    discover_os_packages,
    inventory_to_dict,
    packages_to_list,
)
from .pathsec import LocationTrust, effective_path, location_trust, resolve_executable
from .procexec import ExecStatus, run_argv
from .provenance import ProvenanceIndex, build_index, layers_to_meta, layers_to_packages

#: Version checks for Node- and JVM-backed CLIs routinely take seconds on a
#: cold page cache. The old four-second budget was tight enough that
#: `opencode` and `gemini` flipped to "not installed" whenever a scan ran
#: alongside anything else on the machine.
PROBE_TIMEOUT_MS = 12_000
HTTP_TIMEOUT_MS = 2_500

#: How long a measurement stays usable without an explicit refresh.
PROBE_CACHE_TTL_MS = 30_000
DISCOVERY_CACHE_TTL_MS = 120_000

SCAN_CONCURRENCY = 8


class ProbeStatus(str, Enum):
    """The distinct conclusions a probe can reach."""

    VERIFIED = "verified"
    """Ran, exited zero, reported a version."""

    UNVERIFIED = "unverified"
    """Ran and exited zero but said nothing AURA could read as a version."""

    NOT_FOUND = "not-found"
    """No such executable anywhere on the effective PATH."""

    FAILED = "failed"
    """The executable exists and ran, but the version check failed."""

    TIMEOUT = "timeout"
    """Did not answer in time. Presence is unknown, not disproved."""

    BLOCKED = "blocked"
    """Found, but in a location AURA will not execute from."""

    INTERNAL = "internal"
    """Built into AURA Hub; nothing is executed."""

    NEEDS_AUTH = "needs-auth"
    """Reachable only once the operator connects credentials."""

    UNSUPPORTED = "unsupported"
    """No dependable cross-platform way to detect this node."""


@dataclass
class ProbeResult:
    present: bool
    detail: str
    version: str | None = None
    latency_ms: int | None = None
    status: ProbeStatus = ProbeStatus.UNVERIFIED
    executable: str | None = None
    exit_code: int | None = None
    #: Which package installed the file that answered, when one can be named.
    #: Lets the UI link a catalog node to its package evidence by identity
    #: rather than by guessing that "cloudflare" and "wrangler" are related.
    origin: str | None = None
    package: str | None = None
    manager: str | None = None


@dataclass
class ScanResult:
    results: dict[str, ProbeResult]
    scanned_at: str
    found: int
    discovery: DiscoveryReport | None = None
    packages: list[dict[str, Any]] = field(default_factory=list)
    package_sources: list[dict[str, Any]] = field(default_factory=list)
    os_inventory: OsInventory | None = None
    not_installed: list[dict[str, Any]] = field(default_factory=list)
    not_installed_total: int = 0


def _now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ── caches ──────────────────────────────────────────────────────────────
#
# Every layer is cached, with its own lifetime. Discovery used to be exempt,
# which meant a "cached" scan still executed dozens of binaries and took
# fifteen seconds — the layers had visibly different freshness and the
# expensive one was always cold.

@dataclass
class _DiscoveryLayer:
    """Everything the discovery pass produced, cached and expired as a unit."""

    report: DiscoveryReport
    packages: list[dict[str, Any]]
    package_sources: list[dict[str, Any]]
    os_inventory: OsInventory
    index: ProvenanceIndex | None = None


_cache_lock = threading.RLock()
_probe_cache: dict[str, tuple[float, ProbeResult]] = {}
_discovery_cache: tuple[float, _DiscoveryLayer] | None = None


def _cache_key(node_id: str) -> str:
    """Probe results depend on PATH, so PATH is part of their identity."""
    return f"{node_id}\0{hash(effective_path())}"


def _get_cached(node_id: str) -> ProbeResult | None:
    key = _cache_key(node_id)
    with _cache_lock:
        entry = _probe_cache.get(key)
        if entry is None:
            return None
        at, result = entry
        if (time.monotonic() - at) * 1000 < PROBE_CACHE_TTL_MS:
            return result
        _probe_cache.pop(key, None)
        return None


def _set_cache(node_id: str, result: ProbeResult) -> None:
    with _cache_lock:
        _probe_cache[_cache_key(node_id)] = (time.monotonic(), result)


def _clear_cache() -> None:
    """Drop every cached layer, including memoised package-manager state."""
    global _discovery_cache
    with _cache_lock:
        _probe_cache.clear()
        _discovery_cache = None


# ── catalog probes ──────────────────────────────────────────────────────


def _run_probe(entry: CatalogEntry) -> ProbeResult:
    assert entry.probe is not None  # guarded by the caller
    path = effective_path()
    command = entry.probe.command

    # Each candidate in turn: the platform-appropriate one is whichever
    # actually exists here (see ProbeSpec.fallbacks).
    resolved: str | None = None
    for candidate in entry.probe.candidates:
        resolved = resolve_executable(candidate, path)
        if resolved is not None:
            command = candidate
            break

    if resolved is None:
        return ProbeResult(
            present=False,
            status=ProbeStatus.NOT_FOUND,
            detail=(
                f"{entry.probe.command} is not on PATH. Install {entry.name}, or connect "
                "something else that provides the same capability."
            ),
        )

    verdict = location_trust(resolved)
    if verdict.trust is not LocationTrust.TRUSTED:
        return ProbeResult(
            present=False,
            status=ProbeStatus.BLOCKED,
            executable=resolved,
            detail=(
                f"{command} resolves to {resolved}, which AURA will not run: {verdict.reason}. "
                "Fix the permissions on that location, or remove it from PATH, and scan again."
            ),
        )

    outcome = run_argv(
        [resolved, *entry.probe.args],
        timeout_ms=PROBE_TIMEOUT_MS,
        cwd=os.path.expanduser("~"),
        path=path,
    )

    if outcome.status is ExecStatus.TIMEOUT:
        return ProbeResult(
            present=False,
            status=ProbeStatus.TIMEOUT,
            executable=resolved,
            latency_ms=outcome.duration_ms,
            detail=(
                f"{entry.name} was found at {resolved} but did not answer within "
                f"{PROBE_TIMEOUT_MS}ms, so AURA cannot confirm its version."
            ),
        )
    if outcome.status is ExecStatus.DENIED:
        return ProbeResult(
            present=False,
            status=ProbeStatus.FAILED,
            executable=resolved,
            latency_ms=outcome.duration_ms,
            detail=f"{entry.name} was found at {resolved} but this account may not execute it.",
        )
    if outcome.status in (ExecStatus.NOT_FOUND, ExecStatus.ERROR):
        return ProbeResult(
            present=False,
            status=ProbeStatus.FAILED,
            executable=resolved,
            latency_ms=outcome.duration_ms,
            detail=(
                f"{entry.name} was found at {resolved} but could not be run"
                f"{': ' + outcome.error if outcome.error else '.'}"
            ),
        )
    if outcome.status is ExecStatus.FAILED:
        return ProbeResult(
            present=False,
            status=ProbeStatus.FAILED,
            executable=resolved,
            exit_code=outcome.exit_code,
            latency_ms=outcome.duration_ms,
            detail=(
                f"{entry.name} is at {resolved} but its version check exited "
                f"{outcome.exit_code}, so AURA is not reporting it as usable."
            ),
        )

    version = extract_version(outcome.output)
    if version is None:
        return ProbeResult(
            present=False,
            status=ProbeStatus.UNVERIFIED,
            executable=resolved,
            latency_ms=outcome.duration_ms,
            detail=(
                f"{entry.name} is at {resolved} and ran cleanly, but did not report a version "
                "AURA could read."
            ),
        )

    return ProbeResult(
        present=True,
        status=ProbeStatus.VERIFIED,
        version=version,
        executable=resolved,
        exit_code=outcome.exit_code,
        latency_ms=outcome.duration_ms,
        detail=f"Found {entry.name} {version} at {resolved}.",
    )


def _run_http_probe(entry: CatalogEntry) -> ProbeResult:
    """Ask a locally running service whether it is answering.

    Loopback only: the environment scan measures this machine, and a catalog
    entry that pointed anywhere else would turn a scan into an outbound
    request the operator did not ask for.
    """
    import urllib.error
    import urllib.parse
    import urllib.request

    if not entry.endpoint:
        return ProbeResult(
            present=False,
            status=ProbeStatus.UNSUPPORTED,
            detail="No endpoint is defined for this node.",
        )

    host = (urllib.parse.urlparse(entry.endpoint).hostname or "").lower()
    if host not in ("127.0.0.1", "::1", "localhost"):
        return ProbeResult(
            present=False,
            status=ProbeStatus.UNSUPPORTED,
            detail=f"{entry.name} is catalogued with a non-local endpoint, which AURA will not call.",
        )

    started = time.monotonic()
    try:
        request = urllib.request.Request(entry.endpoint, method="GET")
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_MS / 1000) as response:
            latency = int((time.monotonic() - started) * 1000)
            body = response.read(64 * 1024).decode("utf-8", errors="replace")
            return ProbeResult(
                present=True,
                status=ProbeStatus.VERIFIED,
                version=extract_version(body),
                latency_ms=latency,
                executable=entry.endpoint,
                detail=f"{entry.name} is running locally and answering on {entry.endpoint}.",
            )
    except urllib.error.URLError as exc:
        return ProbeResult(
            present=False,
            status=ProbeStatus.NOT_FOUND,
            latency_ms=int((time.monotonic() - started) * 1000),
            detail=f"{entry.name} is not answering on {entry.endpoint}: {exc.reason}",
        )
    except Exception as exc:
        return ProbeResult(
            present=False,
            status=ProbeStatus.FAILED,
            latency_ms=int((time.monotonic() - started) * 1000),
            detail=f"{entry.name} probe failed: {exc}",
        )


def probe_node(node_id: str, refresh: bool = False) -> ProbeResult:
    if not refresh:
        cached = _get_cached(node_id)
        if cached is not None:
            return cached

    entry = catalog_entry(node_id)
    if entry is None:
        # Not cached: an unknown id is a caller mistake, not machine state.
        return ProbeResult(
            present=False,
            status=ProbeStatus.UNSUPPORTED,
            detail="That node is not in the catalog.",
        )

    if entry.transport == "internal":
        result = ProbeResult(present=True, status=ProbeStatus.INTERNAL, detail="Built into AURA Hub.")
    elif entry.transport == "local-process":
        if entry.probe is None:
            result = ProbeResult(
                present=False,
                status=ProbeStatus.UNSUPPORTED,
                detail=(
                    f"{entry.name} has no dependable command to detect it across platforms, "
                    "so the Hub does not guess at its presence."
                ),
            )
        else:
            result = _run_probe(entry)
    elif entry.transport == "http":
        result = _run_http_probe(entry)
    elif entry.transport == "api-key":
        result = ProbeResult(
            present=False,
            status=ProbeStatus.NEEDS_AUTH,
            detail=(
                "Connect this provider in AI Settings — the Hub reuses that key rather than "
                "asking for a second one."
            ),
        )
    elif entry.transport == "oauth":
        result = ProbeResult(
            present=False,
            status=ProbeStatus.UNSUPPORTED,
            detail="Catalogued for planning. No connector has been built for this service yet.",
        )
    else:
        result = ProbeResult(
            present=False,
            status=ProbeStatus.UNSUPPORTED,
            detail=f"Unknown transport type: {entry.transport}",
        )

    _set_cache(node_id, result)
    return result


# ── discovery layer, cached as a unit ───────────────────────────────────


def _catalog_exclusions(
    results: dict[str, ProbeResult], index: ProvenanceIndex
) -> tuple[set[str], set[str], set[tuple[str, str]]]:
    """What discovery must not report again.

    Three keys, because one is not enough:

    ``real_paths``
        The file a catalog probe actually ran. Excluding by resolved path is
        what stops a catalog tool reappearing as an "unknown" one under a
        different name; the old name-only exclusion missed every alias.
    ``names``
        Catalog commands and ids, for tools that were not found this scan.
    ``packages``
        The package a catalog tool belongs to. Cloudflare's npm package also
        installs ``cf-wrangler``, which is neither a separate tool nor a
        useful card — it is the same install, seen from another entry point.
    """
    from .pathsec import real_target

    real_paths: set[str] = set()
    names: set[str] = set()
    packages: set[tuple[str, str]] = set()

    for entry in BY_ID.values():
        if entry.probe is not None:
            for candidate in entry.probe.candidates:
                names.add(os.path.basename(candidate).lower())
        names.add(entry.id.lower())
        names.add(entry.name.lower().replace(" ", "-"))

    for result in results.values():
        if not result.executable or result.status is ProbeStatus.BLOCKED:
            continue
        if not os.path.isabs(result.executable):
            continue
        real_paths.add(real_target(result.executable))
        provenance = index.classify(result.executable)
        if provenance.manager and provenance.package:
            packages.add((provenance.manager, provenance.package))

    return real_paths, names, packages


def _run_discovery(results: dict[str, ProbeResult], max_probe: int) -> _DiscoveryLayer:
    index: ProvenanceIndex = build_index()
    real_paths, names, owned_packages = _catalog_exclusions(results, index)
    report = discover_tools(
        index,
        exclude_real_paths=real_paths,
        exclude_names=names,
        exclude_packages=owned_packages,
        max_probe=max_probe,
    )

    interest = {name.lower() for name in names}
    interest.update(tool.name.lower() for tool in report.tools)
    return _DiscoveryLayer(
        report=report,
        packages=layers_to_packages(index),
        package_sources=layers_to_meta(index),
        os_inventory=discover_os_packages(of_interest=interest),
        index=index,
    )


def _discovery_layer(
    results: dict[str, ProbeResult], *, refresh: bool, max_probe: int
) -> _DiscoveryLayer:
    global _discovery_cache
    if not refresh:
        with _cache_lock:
            cached = _discovery_cache
        if cached is not None:
            at, layer = cached
            if (time.monotonic() - at) * 1000 < DISCOVERY_CACHE_TTL_MS:
                return layer

    layer = _run_discovery(results, max_probe)
    with _cache_lock:
        _discovery_cache = (time.monotonic(), layer)
    return layer


def _annotate_provenance(results: dict[str, ProbeResult], index: ProvenanceIndex | None) -> None:
    """Record which package installed each catalog tool that was found."""
    if index is None:
        return
    for result in results.values():
        if not result.executable or not os.path.isabs(result.executable):
            continue
        provenance = index.classify(result.executable)
        result.origin = provenance.origin.value
        result.package = provenance.package
        result.manager = provenance.manager


# ── scanning ────────────────────────────────────────────────────────────


def _default_max_probe() -> int:
    """The discovery budget.

    Deliberately not conditioned on being under test. The previous
    implementation used a budget of five whenever ``PYTEST_CURRENT_TEST`` was
    set, so the value that actually shipped was the one no test ever
    exercised. This reads an explicit override instead, and the default is
    the production value everywhere.
    """
    raw = os.environ.get("AURA_ENV_MAX_PROBE")
    if raw:
        try:
            return max(0, int(raw))
        except ValueError:
            pass
    from .discovery import MAX_UNKNOWN_PROBE

    return MAX_UNKNOWN_PROBE


def _not_installed_view(results: dict[str, ProbeResult], limit: int = 60) -> tuple[list[dict[str, Any]], int]:
    """Catalog nodes that are not usable, and how many there are in total.

    Counting the truncated list was the old bug: the number shown to the user
    was capped at the display limit rather than being the real total.
    """
    absent: list[dict[str, Any]] = []
    for entry in BY_ID.values():
        if entry.category == "hub" or entry.transport == "internal":
            continue
        result = results.get(entry.id)
        if result is not None and result.present:
            continue
        if result is None:
            reason = "not-scanned"
            detail = f"{entry.name} was not included in this scan."
        else:
            reason = result.status.value
            detail = result.detail
        absent.append(
            {
                "id": entry.id,
                "name": entry.name,
                "category": entry.category,
                "homepage": entry.homepage,
                "reason": reason,
                "detail": detail,
                "installable": entry.install is not None,
            }
        )
    absent.sort(key=lambda item: item["name"].lower())
    return absent[:limit], len(absent)


@dataclass
class _ScanJob:
    """One in-flight scan, shared by every caller that asked for it."""

    event: threading.Event = field(default_factory=threading.Event)
    result: ScanResult | None = None
    error: BaseException | None = None


# A scan is expensive and the answer is shared. Callers that arrive while one
# is running wait for it instead of starting a second storm of subprocesses.
# Followers hold the job object directly rather than looking the answer back
# up in a dict, because the leader has to remove that entry to let the next
# scan start — and a follower waking after the removal would run its own.
_scan_lock = threading.Lock()
_scan_inflight: dict[str, _ScanJob] = {}


def scan_environment(node_ids: list[str] | None = None, refresh: bool = False) -> ScanResult:
    """Measure the machine. Concurrent identical scans share one measurement."""
    key = f"{refresh}\0{','.join(sorted(node_ids)) if node_ids else '*'}"

    with _scan_lock:
        job = _scan_inflight.get(key)
        leader = job is None
        if leader:
            job = _ScanJob()
            _scan_inflight[key] = job

    assert job is not None

    if not leader:
        # Bounded, so a wedged leader cannot strand every other caller.
        if job.event.wait(timeout=(PROBE_TIMEOUT_MS * 4) / 1000):
            if job.result is not None:
                return job.result
            if job.error is not None:
                raise job.error
        return _scan_uncached(node_ids, refresh)

    try:
        job.result = _scan_uncached(node_ids, refresh)
        return job.result
    except BaseException as exc:
        job.error = exc
        raise
    finally:
        with _scan_lock:
            _scan_inflight.pop(key, None)
        job.event.set()


def _scan_uncached(node_ids: list[str] | None, refresh: bool) -> ScanResult:
    entries = entries_for_scan()
    if node_ids:
        wanted = set(node_ids)
        entries = [e for e in entries if e.id in wanted]

    if refresh:
        _clear_cache()

    results: dict[str, ProbeResult] = {}
    if entries:
        workers = min(SCAN_CONCURRENCY, len(entries))
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="aura-probe") as pool:
            futures = {pool.submit(probe_node, e.id, refresh): e.id for e in entries}
            for future in as_completed(futures):
                node_id = futures[future]
                try:
                    results[node_id] = future.result()
                except Exception as exc:  # one probe must never sink the scan
                    results[node_id] = ProbeResult(
                        present=False,
                        status=ProbeStatus.FAILED,
                        detail=f"Probe for {node_id} failed: {exc}",
                    )

    # `found` counts tools on this machine. AURA's own subsystems are always
    # "present" and would otherwise inflate every count by five.
    found = 0
    for node_id, result in results.items():
        if not result.present or result.status is ProbeStatus.INTERNAL:
            continue
        entry = BY_ID.get(node_id)
        if entry is not None and entry.category == "hub":
            continue
        found += 1

    discovery: DiscoveryReport | None = None
    packages: list[dict[str, Any]] = []
    package_sources: list[dict[str, Any]] = []
    os_inventory: OsInventory | None = None
    if node_ids is None:
        try:
            layer = _discovery_layer(results, refresh=refresh, max_probe=_default_max_probe())
            discovery = layer.report
            packages = layer.packages
            package_sources = layer.package_sources
            os_inventory = layer.os_inventory
            _annotate_provenance(results, layer.index)
        except Exception:
            discovery = DiscoveryReport()
            packages, package_sources, os_inventory = [], [], OsInventory(available=False)

    not_installed, not_installed_total = _not_installed_view(results)

    return ScanResult(
        results=results,
        scanned_at=_now(),
        found=found,
        discovery=discovery,
        packages=packages,
        package_sources=package_sources,
        os_inventory=os_inventory,
        not_installed=not_installed,
        not_installed_total=not_installed_total,
    )


# ── serialisation ───────────────────────────────────────────────────────


def probe_result_to_dict(result: ProbeResult) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "present": result.present,
        "detail": result.detail,
        "status": result.status.value,
    }
    if result.version is not None:
        payload["version"] = result.version
    if result.latency_ms is not None:
        payload["latencyMs"] = result.latency_ms
    if result.executable is not None:
        payload["executable"] = result.executable
    if result.exit_code is not None:
        payload["exitCode"] = result.exit_code
    if result.origin is not None:
        payload["origin"] = result.origin
    if result.package is not None:
        payload["package"] = result.package
    if result.manager is not None:
        payload["manager"] = result.manager
    return payload


def scan_result_to_dict(result: ScanResult) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "results": {k: probe_result_to_dict(v) for k, v in result.results.items()},
        "scannedAt": result.scanned_at,
        "found": result.found,
    }

    if result.discovery is not None:
        report = result.discovery
        payload["discovered"] = [discovered_to_dict(t) for t in report.tools]
        payload["discoveredCount"] = len(report.tools)
        payload["verifiedCount"] = sum(1 for t in report.tools if t.status is ToolStatus.VERIFIED)
        payload["discovery"] = {
            "totalCandidates": report.total_candidates,
            "scannedCandidates": report.scanned_candidates,
            "reportedCandidates": report.reported_candidates or len(report.tools),
            "truncated": report.truncated,
            "directoriesScanned": report.directories_scanned,
            "skippedDirectories": report.skipped_directories,
        }

    payload["packages"] = result.packages
    payload["packagesCount"] = len(result.packages)
    payload["packageSources"] = result.package_sources

    if result.os_inventory is not None:
        payload["osPackages"] = packages_to_list(result.os_inventory)
        payload["osPackagesCount"] = len(result.os_inventory.packages)
        payload["osInventory"] = inventory_to_dict(result.os_inventory)
    else:
        payload["osPackages"] = []
        payload["osPackagesCount"] = 0

    payload["notInstalled"] = result.not_installed
    payload["notInstalledCount"] = result.not_installed_total
    return payload
