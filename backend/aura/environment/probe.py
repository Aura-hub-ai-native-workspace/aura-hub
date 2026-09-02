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
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .catalog import CatalogEntry, catalog_entry, entries_for_scan

PROBE_TIMEOUT_MS = 4000
HTTP_TIMEOUT_MS = 2500
CACHE_TTL_MS = 30_000
SCAN_CONCURRENCY = 8

# In-memory cache for probe results (mirrors TS environment.ts cache)
_probe_cache: dict[str, tuple[float, "ProbeResult"]] = {}

# Cached npm global bin (computed once per process)
_npm_global_bin: str | None = None
_npm_global_bin_resolved: bool = False


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


def _get_cached(node_id: str) -> ProbeResult | None:
    entry = _probe_cache.get(node_id)
    if entry is None:
        return None
    at, result = entry
    if (time.time() - at) * 1000 < CACHE_TTL_MS:
        return result
    _probe_cache.pop(node_id, None)
    return None


def _set_cache(node_id: str, result: ProbeResult) -> None:
    _probe_cache[node_id] = (time.time(), result)


def _clear_cache() -> None:
    _probe_cache.clear()


def _home_dir() -> Path:
    return Path(os.path.expanduser("~"))


def _npm_global_bin_cached() -> str | None:
    """Resolve npm global bin directory once, handling custom prefix."""
    global _npm_global_bin, _npm_global_bin_resolved
    if _npm_global_bin_resolved:
        return _npm_global_bin
    _npm_global_bin_resolved = True
    try:
        # Use shutil.which to find npm without shell
        npm_bin = shutil.which("npm")
        if npm_bin is None:
            # Try common locations if not on PATH
            for cand in [
                _home_dir() / ".npm-global/bin/npm",
                _home_dir() / ".local/bin/npm",
                Path("/usr/local/bin/npm"),
                Path("/usr/bin/npm"),
            ]:
                if cand.exists():
                    npm_bin = str(cand)
                    break
        if npm_bin is None:
            return None
        result = subprocess.run(
            [npm_bin, "config", "get", "prefix"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=str(_home_dir()),
        )
        prefix = result.stdout.strip()
        if prefix and prefix != "undefined":
            # On Windows, npm bin is <prefix> directly; on Unix <prefix>/bin
            # We handle both by checking platform
            import platform
            if platform.system() == "Windows":
                bin_dir = prefix
            else:
                bin_dir = os.path.join(prefix, "bin")
            # Validate it looks like a bin dir (contains npm or previous)
            _npm_global_bin = bin_dir
            return bin_dir
        return None
    except Exception:
        return None


def _effective_path() -> str:
    """Build augmented PATH: inherited + known user/system locations + npm global bin."""
    home = _home_dir()
    parts: list[str] = []
    seen: set[str] = set()

    # Start with inherited PATH
    existing = os.environ.get("PATH", "")
    if existing:
        for p in existing.split(os.pathsep):
            if p and p not in seen:
                parts.append(p)
                seen.add(p)

    # Known user-level locations (deterministic, no shell sourcing)
    candidates: list[Path] = []
    # npm global bin (dynamic, covers custom prefix like ~/.npm-global/bin)
    npm_bin = _npm_global_bin_cached()
    if npm_bin and npm_bin not in seen:
        candidates.append(Path(npm_bin))

    # Standard user locations
    candidates.extend([
        home / ".local/bin",
        home / "bin",
        home / ".opencode/bin",
        home / ".cargo/bin",
        home / ".bun/bin",
        home / "go/bin",
        home / ".deno/bin",
        home / ".npm-global/bin",
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
        Path("/usr/bin"),
        Path("/bin"),
        Path("/usr/local/sbin"),
        Path("/usr/sbin"),
        Path("/sbin"),
    ])

    # Windows-specific already handled via npm_bin above, but add others
    import platform
    if platform.system() == "Windows":
        appdata = os.environ.get("APPDATA")
        if appdata:
            candidates.append(Path(appdata) / "npm")
        program_data = os.environ.get("ProgramData")
        if program_data:
            candidates.append(Path(program_data) / "chocolatey/bin")
        candidates.extend([
            home / "scoop/shims",
            home / "AppData/Roaming/npm",
        ])

    for c in candidates:
        s = str(c)
        if s and s not in seen:
            # Only add if directory exists or is npm_bin (already checked)
            # We add regardless to allow which to find it if later created
            parts.append(s)
            seen.add(s)

    return os.pathsep.join(parts)


def _resolve_executable(command: str) -> str | None:
    """Resolve executable via augmented PATH, respecting PATHEXT on Windows."""
    # Use augmented PATH for robust discovery
    path = _effective_path()
    # shutil.which respects PATHEXT on Windows and X_OK on POSIX
    resolved = shutil.which(command, path=path)
    if resolved:
        return resolved
    # Fallback: direct check for known locations if which fails
    home = _home_dir()
    import platform
    # Check explicit candidate files
    for base in [
        home / ".local/bin" / command,
        home / ".npm-global/bin" / command,
        home / ".opencode/bin" / command,
        home / ".cargo/bin" / command,
        home / ".bun/bin" / command,
        Path("/opt/homebrew/bin") / command,
        Path("/usr/local/bin") / command,
        Path("/usr/bin") / command,
    ]:
        # On Windows, also try with PATHEXT extensions
        if platform.system() == "Windows":
            pathext = os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(";")
            for ext in pathext:
                ext = ext.strip()
                if not ext:
                    continue
                cand = Path(str(base) + ext.lower())
                if cand.exists() and cand.is_file():
                    return str(cand)
                cand2 = Path(str(base) + ext)
                if cand2.exists() and cand2.is_file():
                    return str(cand2)
        else:
            if base.exists() and base.is_file():
                # Check executable
                if os.access(str(base), os.X_OK):
                    return str(base)
                return str(base)
    return None


def _run_probe(entry: CatalogEntry) -> ProbeResult:
    if entry.probe is None:
        return ProbeResult(
            present=False,
            detail="No dependable way to detect this tool across platforms, so the Hub does not guess.",
        )

    started = time.time()
    try:
        # argv-only, no shell — command from catalog only
        # Use _resolve_executable to give better error if not found, but still attempt direct run
        # for OS resolver fallback
        proc = subprocess.run(
            [entry.probe.command] + entry.probe.args,
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_MS / 1000,
            cwd=os.path.expanduser("~"),
            env={**os.environ, "PATH": _effective_path()},
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
        # Provide augmented PATH evidence
        resolved = _resolve_executable(entry.probe.command)
        if resolved:
            return ProbeResult(
                present=False,
                latency_ms=latency_ms,
                detail=f"{entry.probe.command} was found at {resolved} but did not execute.",
            )
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
    if not refresh:
        cached = _get_cached(node_id)
        if cached is not None:
            return cached

    entry = catalog_entry(node_id)
    if entry is None:
        result = ProbeResult(present=False, detail="That node is not in the catalog.")
        _set_cache(node_id, result)
        return result

    if entry.transport == "internal":
        result = ProbeResult(present=True, detail="Built into AURA Hub.")
        _set_cache(node_id, result)
        return result
    elif entry.transport == "local-process":
        result = _run_probe(entry)
        _set_cache(node_id, result)
        return result
    elif entry.transport == "http":
        result = _run_http_probe(entry)
        _set_cache(node_id, result)
        return result
    elif entry.transport == "api-key":
        result = ProbeResult(
            present=False,
            detail="Connect this provider in AI Settings — the Hub reuses that key rather than asking for a second one.",
        )
        _set_cache(node_id, result)
        return result
    elif entry.transport == "oauth":
        result = ProbeResult(
            present=False,
            detail="Catalogued for planning. No connector has been built for this service yet.",
        )
        _set_cache(node_id, result)
        return result
    else:
        result = ProbeResult(present=False, detail=f"Unknown transport type: {entry.transport}")
        _set_cache(node_id, result)
        return result


def scan_environment(node_ids: list[str] | None = None, refresh: bool = False) -> ScanResult:
    entries = entries_for_scan()
    if node_ids:
        entries = [e for e in entries if e.id in node_ids]

    results: dict[str, ProbeResult] = {}
    found = 0

    if refresh:
        # Bypass cache for explicit refresh
        _clear_cache()

    # Bounded concurrency: 6-8 workers, failure-isolated per probe
    if len(entries) <= 1:
        for entry in entries:
            try:
                result = probe_node(entry.id, refresh=refresh)
            except Exception as e:
                result = ProbeResult(present=False, detail=f"Probe for {entry.id} failed: {e}")
            results[entry.id] = result
            if result.present:
                found += 1
    else:
        max_workers = min(SCAN_CONCURRENCY, len(entries))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_id = {}
            for entry in entries:
                # Each probe isolated; refresh flag controls cache
                fut = executor.submit(probe_node, entry.id, refresh)
                future_to_id[fut] = entry.id
            for fut in as_completed(future_to_id):
                nid = future_to_id[fut]
                try:
                    # Per-probe timeout slightly above probe timeout to avoid hanging scan
                    result = fut.result(timeout=(PROBE_TIMEOUT_MS + 1000) / 1000)
                except Exception as e:
                    result = ProbeResult(present=False, detail=f"Probe for {nid} failed: {e}")
                results[nid] = result
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
