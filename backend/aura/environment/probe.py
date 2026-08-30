"""Environment probe — the canonical transport for measuring real machine state.

This is the Python equivalent of the TypeScript environment.ts probe functions.
It is the ONLY place side effects enter the Connected Environment domain.

Security invariant: The command and arguments ALWAYS come from the catalog
entry looked up by id, never from the request. A client can ask "probe the
node called `docker`"; it can never ask "run this string". Combined with
subprocess (no shell) this means there is no path from an HTTP request to
arbitrary command execution.
"""
from __future__ import annotations

import os
import re
import subprocess
import time
from dataclasses import dataclass
from typing import Any

from .catalog import CatalogEntry, catalog_entry, entries_for_scan

PROBE_TIMEOUT_MS = 4000
HTTP_TIMEOUT_MS = 2500
CACHE_TTL_MS = 30_000


def _now() -> str:
    from datetime import UTC, datetime
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class ProbeResult:
    present: bool
    detail: str
    version: str | None = None
    latency_ms: int | None = None


@dataclass
class ScanResult:
    results: dict[str, ProbeResult]
    scanned_at: str
    found: int


def _extract_version(output: str) -> str | None:
    match = re.search(r"\d+\.\d+(\.\d+)?([-.][0-9A-Za-z.]+)?", output)
    if match:
        return match.group(0)
    lines = output.strip().split("\n")
    if lines:
        return lines[0][:40]
    return None


def _run_probe(entry: CatalogEntry) -> ProbeResult:
    if entry.probe is None:
        return ProbeResult(
            present=False,
            detail="No dependable way to detect this tool across platforms, so the Hub does not guess.",
        )

    started = time.time()
    try:
        proc = subprocess.run(
            [entry.probe.command] + entry.probe.args,
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_MS / 1000,
            cwd=os.path.expanduser("~"),
        )
        latency_ms = int((time.time() - started) * 1000)

        output = (proc.stdout or "") + (proc.stderr or "")
        output = output.strip()

        if output:
            version = _extract_version(output)
            return ProbeResult(
                present=True,
                version=version,
                latency_ms=latency_ms,
                detail=f"Found {entry.name}{' ' + version if version else ''} on this machine.",
            )

        code = proc.returncode
        if code != 0:
            return ProbeResult(
                present=False,
                latency_ms=latency_ms,
                detail=f"{entry.name} did not answer the version check (exit {code}).",
            )
        return ProbeResult(
            present=False,
            latency_ms=latency_ms,
            detail=f"{entry.name} did not produce output.",
        )

    except FileNotFoundError:
        latency_ms = int((time.time() - started) * 1000)
        return ProbeResult(
            present=False,
            latency_ms=latency_ms,
            detail=f"{entry.probe.command} is not on PATH. Install {entry.name}, or connect something else that provides the same capability.",
        )
    except subprocess.TimeoutExpired:
        latency_ms = int((time.time() - started) * 1000)
        return ProbeResult(
            present=False,
            latency_ms=latency_ms,
            detail=f"{entry.name} did not respond within {PROBE_TIMEOUT_MS}ms.",
        )
    except Exception as e:
        latency_ms = int((time.time() - started) * 1000)
        return ProbeResult(
            present=False,
            latency_ms=latency_ms,
            detail=f"Probe for {entry.name} failed: {e}",
        )


def _run_http_probe(entry: CatalogEntry) -> ProbeResult:
    if not entry.endpoint:
        return ProbeResult(present=False, detail="No endpoint is defined for this node.")

    started = time.time()
    try:
        import urllib.request
        req = urllib.request.Request(entry.endpoint)
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_MS / 1000) as resp:
            latency_ms = int((time.time() - started) * 1000)
            body = resp.read().decode("utf-8", errors="replace")
            version = _extract_version(body)
            return ProbeResult(
                present=True,
                version=version,
                latency_ms=latency_ms,
                detail=f"{entry.name} is running locally and answering on {entry.endpoint}.",
            )
    except urllib.error.URLError as e:
        latency_ms = int((time.time() - started) * 1000)
        return ProbeResult(
            present=False,
            latency_ms=latency_ms,
            detail=f"{entry.name} is not answering on {entry.endpoint}: {e.reason}",
        )
    except Exception as e:
        latency_ms = int((time.time() - started) * 1000)
        return ProbeResult(
            present=False,
            latency_ms=latency_ms,
            detail=f"{entry.name} probe failed: {e}",
        )


def probe_node(node_id: str, refresh: bool = False) -> ProbeResult:
    entry = catalog_entry(node_id)
    if entry is None:
        return ProbeResult(present=False, detail="That node is not in the catalog.")

    if entry.transport == "internal":
        return ProbeResult(present=True, detail="Built into AURA Hub.")
    elif entry.transport == "local-process":
        return _run_probe(entry)
    elif entry.transport == "http":
        return _run_http_probe(entry)
    elif entry.transport == "api-key":
        return ProbeResult(
            present=False,
            detail="Connect this provider in AI Settings — the Hub reuses that key rather than asking for a second one.",
        )
    elif entry.transport == "oauth":
        return ProbeResult(
            present=False,
            detail="Catalogued for planning. No connector has been built for this service yet.",
        )
    else:
        return ProbeResult(present=False, detail=f"Unknown transport type: {entry.transport}")


def scan_environment(node_ids: list[str] | None = None, refresh: bool = False) -> ScanResult:
    entries = entries_for_scan()
    if node_ids:
        entries = [e for e in entries if e.id in node_ids]

    results: dict[str, ProbeResult] = {}
    found = 0

    for entry in entries:
        result = probe_node(entry.id, refresh=refresh)
        results[entry.id] = result
        if result.present:
            found += 1

    return ScanResult(
        results=results,
        scanned_at=_now(),
        found=found,
    )


def probe_result_to_dict(result: ProbeResult) -> dict[str, Any]:
    d: dict[str, Any] = {"present": result.present, "detail": result.detail}
    if result.version is not None:
        d["version"] = result.version
    if result.latency_ms is not None:
        d["latencyMs"] = result.latency_ms
    return d


def scan_result_to_dict(result: ScanResult) -> dict[str, Any]:
    return {
        "results": {k: probe_result_to_dict(v) for k, v in result.results.items()},
        "scannedAt": result.scanned_at,
        "found": result.found,
    }
