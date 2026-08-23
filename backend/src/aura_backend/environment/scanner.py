"""The Connected Environment's real transport.

A port of packages/ai-service/src/environment.ts.

This is where the architecture stops being a model and touches the
machine. Everything here is genuine: `docker --version` really runs, a
real version string comes back, and a tool that is absent really is
absent. Nothing is simulated and no result is invented.

**Security boundary — read this before adding anything.** The command and
arguments ALWAYS come from the catalogue entry looked up by id, never from
the request body. A client can ask "probe the node called `docker`"; it
can never ask "run this string". Combined with argv spawning and no shell,
there is no path from an HTTP request to arbitrary command execution —
which matters a great deal for a service that binds a local port.
"""

from __future__ import annotations

import asyncio
import re
import subprocess
import time
from dataclasses import dataclass
from typing import Any

import httpx

from ..execution.which import UnsafeArgumentError, launch_spec
from ..fabric.types import now_iso
from .catalog import CATALOG, CatalogEntry, catalog_entry

PROBE_TIMEOUT_MS = 4000
HTTP_TIMEOUT_MS = 2500
CACHE_TTL_MS = 30_000
# Keep the scan from spawning a hundred processes at once on a laptop.
CONCURRENCY = 8
PROBE_MAX_BUFFER = 256 * 1024

# No leading \b: in `v24.7.0` there is no word boundary between `v` and
# `2` (both are word characters), so a leading \b would skip the major
# version entirely and report `7.0`. Match the first digit run instead.
_VERSION = re.compile(r"\d+\.\d+(\.\d+)?([-.][0-9A-Za-z.]+)?")


@dataclass(frozen=True)
class ProbeResult:
    present: bool
    detail: str
    version: str | None = None
    latency_ms: int | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"present": self.present, "detail": self.detail}
        if self.version is not None:
            out["version"] = self.version
        if self.latency_ms is not None:
            out["latencyMs"] = self.latency_ms
        return out


@dataclass
class ScanResult:
    results: dict[str, ProbeResult]
    scanned_at: str
    # How many of the scanned nodes were actually found.
    found: int

    def to_json(self) -> dict[str, Any]:
        return {
            "results": {k: v.to_json() for k, v in self.results.items()},
            "scannedAt": self.scanned_at,
            "found": self.found,
        }


def extract_version(output: str) -> str | None:
    """Pull a version out of whatever the tool decided to print.

    Tools are wildly inconsistent (`git version 2.43.0`, `Docker version
    27.0.3, build …`, `v20.11.1`, `Python 3.12.3`), so this takes the
    first dotted number sequence and gives up gracefully rather than
    guessing.
    """
    line = next((line.strip() for line in output.split("\n") if line.strip()), None)
    if not line:
        return None
    match = _VERSION.search(line)
    return match.group(0) if match else line[:40]


class EnvironmentScanner:
    """Probes, with a short cache.

    Probes are cheap but not free, so results are cached briefly. A user
    who just installed something can force a fresh read with `refresh` —
    and `system.install`'s verification does exactly that, because a
    cached answer taken before the install would report the tool still
    missing, or worse, still present after a failure.
    """

    def __init__(self) -> None:
        self._cache: dict[str, tuple[float, ProbeResult]] = {}

    def invalidate(self, node_id: str | None = None) -> None:
        if node_id is None:
            self._cache.clear()
        else:
            self._cache.pop(node_id, None)

    async def probe_node(self, node_id: str, refresh: bool = False) -> ProbeResult:
        """Probe one catalogued node.

        Transports the service cannot complete (OAuth services,
        credentialed providers) return an honest, non-failing result
        rather than a fabricated status.
        """
        entry = catalog_entry(node_id)
        if entry is None:
            return ProbeResult(present=False, detail="That node is not in the catalog.")

        if not refresh:
            hit = self._cache.get(node_id)
            if hit and (time.monotonic() - hit[0]) * 1000 < CACHE_TTL_MS:
                return hit[1]

        if entry.transport == "local-process":
            result = await self._run_probe(entry)
        elif entry.transport == "http":
            result = await self._run_http_probe(entry)
        elif entry.transport == "internal":
            result = ProbeResult(present=True, detail="Built into AURA Hub.")
        elif entry.transport == "api-key":
            result = ProbeResult(
                present=False,
                detail=(
                    "Connect this provider in AI Settings — the Hub reuses that key "
                    "rather than asking for a second one."
                ),
            )
        else:  # oauth
            result = ProbeResult(
                present=False,
                detail=(
                    "Catalogued for planning. No connector has been built for this "
                    "service yet."
                ),
            )

        self._cache[node_id] = (time.monotonic(), result)
        return result

    async def _run_probe(self, entry: CatalogEntry) -> ProbeResult:
        probe = entry.probe
        if probe is None:
            return ProbeResult(
                present=False,
                detail=(
                    "No dependable way to detect this tool across platforms, so the "
                    "Hub does not guess."
                ),
            )
        started = time.monotonic()
        try:
            # Resolve to a real file before spawning. On Unix this changes
            # nothing; on Windows it is the difference between a true and a
            # false answer, because everything npm installs is a `.cmd`
            # shim that cannot be spawned directly — without this, every
            # one would report ENOENT and AURA would tell the user a tool
            # they have installed is missing.
            spec = launch_spec(probe.command, list(probe.args))
        except UnsafeArgumentError as exc:
            # One unprobeable entry must not take the whole scan down.
            return ProbeResult(
                present=False,
                detail=f"{entry.name} could not be probed safely on this platform: {exc}",
            )

        try:
            completed = await asyncio.to_thread(
                subprocess.run,
                [spec.target.file, *spec.target.args],
                capture_output=True,
                timeout=PROBE_TIMEOUT_MS / 1000,
                shell=False,
                check=False,
            )
            code: str | None = None
            stdout, stderr = completed.stdout, completed.stderr
        except FileNotFoundError:
            code, stdout, stderr = "ENOENT", b"", b""
        except subprocess.TimeoutExpired as exc:
            code = "ETIMEDOUT"
            stdout = exc.stdout or b""
            stderr = exc.stderr or b""
        except OSError as exc:
            code = type(exc).__name__
            stdout, stderr = b"", b""

        latency_ms = int((time.monotonic() - started) * 1000)
        raw = (stdout or b"")[:PROBE_MAX_BUFFER] + (stderr or b"")[:PROBE_MAX_BUFFER]
        output = raw.decode("utf-8", errors="replace").strip()

        # Several tools (notably `java -version`) print to stderr, and some
        # exit non-zero while being perfectly present. Presence is decided
        # by "did we get recognisable output", not by exit code.
        if output:
            version = extract_version(output)
            return ProbeResult(
                present=True,
                version=version,
                latency_ms=latency_ms,
                detail=(
                    f"Found {entry.name} {version} on this machine."
                    if version
                    else f"Found {entry.name} on this machine."
                ),
            )

        if code == "ENOENT":
            return ProbeResult(
                present=False,
                latency_ms=latency_ms,
                detail=(
                    f"{probe.command} is not on PATH. Install {entry.name}, or connect "
                    "something else that provides the same capability."
                ),
            )
        suffix = f" ({code})" if code else ""
        return ProbeResult(
            present=False,
            latency_ms=latency_ms,
            detail=(
                f"{entry.name} did not answer the version check{suffix}. It may be "
                "installed but not on PATH for this session."
            ),
        )

    async def _run_http_probe(self, entry: CatalogEntry) -> ProbeResult:
        endpoint = entry.endpoint
        if not endpoint:
            return ProbeResult(present=False, detail="No endpoint is defined for this node.")
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_MS / 1000) as client:
                response = await client.get(endpoint)
            latency_ms = int((time.monotonic() - started) * 1000)
            if response.status_code >= 400:
                return ProbeResult(
                    present=False,
                    latency_ms=latency_ms,
                    detail=(
                        f"{entry.name} is reachable but answered {response.status_code}. "
                        "Start it, or the Hub will route model work elsewhere."
                    ),
                )
            return ProbeResult(
                present=True,
                latency_ms=latency_ms,
                version=extract_version(response.text),
                detail=f"{entry.name} is running locally and answering on {endpoint}.",
            )
        except Exception:  # noqa: BLE001 - any failure to reach it means "not answering"
            return ProbeResult(
                present=False,
                latency_ms=int((time.monotonic() - started) * 1000),
                detail=(
                    f"{entry.name} is not answering on {endpoint}. Start it and scan "
                    "again, or connect a hosted provider instead."
                ),
            )

    async def scan(self, ids: list[str] | None = None, refresh: bool = False) -> ScanResult:
        """Scan the machine.

        By default this only touches nodes the service can genuinely
        measure. Probing 105 catalogue entries to tell the user 90 of them
        are "not installed" would be noise dressed up as information.
        """
        if ids:
            candidates = [e for e in (catalog_entry(i) for i in ids) if e is not None]
        else:
            candidates = list(CATALOG)
        entries = [
            e
            for e in candidates
            if (e.transport == "local-process" and e.probe)
            or (e.transport == "http" and e.endpoint)
            or e.transport == "internal"
        ]

        semaphore = asyncio.Semaphore(CONCURRENCY)

        async def one(entry: CatalogEntry) -> ProbeResult:
            async with semaphore:
                return await self.probe_node(entry.id, refresh)

        probed = await asyncio.gather(*(one(e) for e in entries))
        results = {entry.id: result for entry, result in zip(entries, probed)}
        return ScanResult(
            results=results,
            scanned_at=now_iso(),
            found=sum(1 for r in probed if r.present),
        )
