"""Change intelligence.

Ports of the analysers in
packages/ai-service/src/intelligence/changeIntelligence.ts.

The change log is a single WORKSPACE-WIDE file whose entries carry a file
path but no project id, which is why attribution is by path prefix and
why the Context Fabric refuses to attribute entries that are not absolute.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from ..core.json_store import read_json
from .staleness import parse_iso_ms

WEEK_MS = 7 * 24 * 60 * 60 * 1000
HOUR_MS = 60 * 60 * 1000
BURST_WINDOW = 5
MAX_IMPACT = 100
IMPACT_PER_CHANGE = 10
HOTSPOT_THRESHOLD = 50


def load_change_log(home: Path) -> dict[str, Any] | None:
    return read_json(home / "changes" / "log.json", None)


def analyze_change_patterns(log: dict[str, Any]) -> list[dict[str, Any]]:
    entries = log.get("entries", [])
    file_changes: dict[str, list[float]] = {}
    for entry in entries:
        file_changes.setdefault(entry["file"], []).append(
            parse_iso_ms(entry["timestamp"]) or 0
        )

    patterns: list[dict[str, Any]] = []
    now = time.time() * 1000

    for file, timestamps in file_changes.items():
        if len(timestamps) >= 3:
            recent = [t for t in timestamps if t > now - WEEK_MS]
            if len(recent) >= 2:
                patterns.append({
                    "pattern": "frequently_changed",
                    "frequency": len(timestamps),
                    "files": [file],
                    "lastOccurrence": _iso(max(timestamps)),
                })

    ordered = sorted(entries, key=lambda e: parse_iso_ms(e["timestamp"]) or 0)
    for i in range(len(ordered) - BURST_WINDOW):
        window = ordered[i:i + BURST_WINDOW]
        span = (parse_iso_ms(window[4]["timestamp"]) or 0) - (
            parse_iso_ms(window[0]["timestamp"]) or 0
        )
        if span < HOUR_MS:
            patterns.append({
                "pattern": "change_burst",
                "frequency": BURST_WINDOW,
                "files": [e["file"] for e in window],
                "lastOccurrence": window[4]["timestamp"],
            })
    return patterns


def calculate_change_impact(log: dict[str, Any]) -> list[dict[str, Any]]:
    stats: dict[str, dict[str, Any]] = {}
    for entry in log.get("entries", []):
        existing = stats.setdefault(
            entry["file"], {"changes": 0, "lastChange": entry["timestamp"]}
        )
        existing["changes"] += 1
        existing["lastChange"] = max(existing["lastChange"], entry["timestamp"])

    impacts = [
        {
            "file": file,
            "impactScore": min(MAX_IMPACT, s["changes"] * IMPACT_PER_CHANGE),
            # Would need a dependency graph; the reference says so too.
            "dependents": 0,
            "recentChanges": s["changes"],
        }
        for file, s in stats.items()
    ]
    impacts.sort(key=lambda i: i["impactScore"], reverse=True)
    return impacts


def get_change_velocity(log: dict[str, Any], days: int = 7) -> float:
    cutoff = time.time() * 1000 - days * 24 * 60 * 60 * 1000
    recent = [
        e for e in log.get("entries", [])
        if (parse_iso_ms(e["timestamp"]) or 0) > cutoff
    ]
    return len(recent) / days


def detect_hotspots(log: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "file": impact["file"],
            "score": impact["impactScore"],
            "reason": f"Changed {impact['recentChanges']} times",
        }
        for impact in calculate_change_impact(log)[:10]
        if impact["impactScore"] >= HOTSPOT_THRESHOLD
    ]


def _iso(ms: float) -> str:
    from datetime import UTC, datetime

    dt = datetime.fromtimestamp(ms / 1000, tz=UTC)
    return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}.{dt.microsecond // 1000:03d}Z"


def save_change_log(home: Path, log: dict[str, Any]) -> None:
    from ..core.json_store import atomic_write_json

    atomic_write_json(home / "changes" / "log.json", log)


def record_change(
    home: Path, file: str, change_type: str, now: str,
    lines_added: int | None = None, lines_removed: int | None = None,
) -> None:
    log = load_change_log(home) or {"entries": [], "patterns": [], "generatedAt": now}
    # `linesAdded`/`linesRemoved` are `undefined` when not supplied, and
    # `JSON.stringify` drops them — so the key is absent on disk, not null.
    entry: dict[str, Any] = {"file": file, "timestamp": now, "type": change_type}
    if lines_added is not None:
        entry["linesAdded"] = lines_added
    if lines_removed is not None:
        entry["linesRemoved"] = lines_removed
    log["entries"].append(entry)

    if len(log["entries"]) > 1000:
        log["entries"] = log["entries"][-1000:]

    log["generatedAt"] = now
    save_change_log(home, log)


def generate_change_report(log: dict[str, Any]) -> str:
    from ..core.js_number import to_fixed

    velocity = get_change_velocity(log)
    patterns = analyze_change_patterns(log)
    hotspots = detect_hotspots(log)

    lines = [
        f"Change Velocity: {to_fixed(velocity, 1)} changes/day",
        f"Total Changes: {len(log.get('entries') or [])}",
        f"Patterns Detected: {len(patterns)}",
        f"Hotspots: {len(hotspots)}",
    ]
    if hotspots:
        lines.append("\nHotspot Files:")
        for hotspot in hotspots[:5]:
            lines.append(f"  - {hotspot['file']} (score: {hotspot['score']})")
    return "\n".join(lines)
