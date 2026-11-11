"""AI Index Versioning.

A port of packages/ai-service/src/intelligence/versioning.ts.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..core.json_store import atomic_write_json, read_json


def _file(home: Path, project_id: str) -> Path:
    return home / "versions" / f"{project_id}.json"


def load_version_history(home: Path, project_id: str) -> dict[str, Any] | None:
    return read_json(_file(home, project_id), None)


def save_version_history(home: Path, history: dict[str, Any]) -> None:
    atomic_write_json(_file(home, history["projectId"]), history)


def create_version(
    home: Path, project_id: str, artifact_hashes: dict[str, str],
    metadata: dict[str, Any], now: str,
) -> dict[str, Any]:
    history = load_version_history(home, project_id) or {
        "projectId": project_id, "versions": [], "current": 0,
    }

    new_version = {
        # The NEXT number is the length before trimming, so once more than
        # twenty versions exist the numbers stop matching the positions.
        "version": len(history["versions"]) + 1,
        "timestamp": now,
        "artifactHashes": artifact_hashes,
        "metadata": metadata,
    }

    history["versions"].append(new_version)
    history["current"] = new_version["version"]

    if len(history["versions"]) > 20:
        history["versions"] = history["versions"][-20:]

    save_version_history(home, history)
    return new_version


def get_current_version(home: Path, project_id: str) -> dict[str, Any] | None:
    history = load_version_history(home, project_id)
    if not history or not history.get("versions"):
        return None
    versions = history["versions"]
    index = history.get("current", 0) - 1
    # `versions[current - 1] ?? null` — an out-of-range index is null, and
    # a NEGATIVE index is `undefined` in JavaScript rather than wrapping.
    return versions[index] if 0 <= index < len(versions) else None


def get_version(home: Path, project_id: str, version: int) -> dict[str, Any] | None:
    history = load_version_history(home, project_id)
    if not history:
        return None
    return next((v for v in history["versions"] if v["version"] == version), None)


def compare_versions(
    home: Path, project_id: str, v1: int, v2: int
) -> dict[str, list[str]]:
    version1 = get_version(home, project_id, v1)
    version2 = get_version(home, project_id, v2)
    if not version1 or not version2:
        return {"added": [], "removed": [], "changed": []}

    artifacts1 = list(version1["artifactHashes"])
    artifacts2 = list(version2["artifactHashes"])
    set1, set2 = set(artifacts1), set(artifacts2)

    return {
        "added": [a for a in artifacts2 if a not in set1],
        "removed": [a for a in artifacts1 if a not in set2],
        "changed": [a for a in artifacts1 if a in set2
                    and version1["artifactHashes"][a] != version2["artifactHashes"][a]],
    }


def rollback_to_version(
    home: Path, project_id: str, target_version: int
) -> dict[str, Any] | None:
    history = load_version_history(home, project_id)
    if not history:
        return None
    target = next((v for v in history["versions"] if v["version"] == target_version), None)
    if not target:
        return None
    history["current"] = target_version
    save_version_history(home, history)
    return target


def generate_artifact_hash(content: str) -> str:
    """The reference's 32-bit rolling hash, in JavaScript's arithmetic.

    Three things have to match exactly: iteration over UTF-16 code units
    (`charCodeAt`, so an astral character is two steps), wraparound to a
    signed 32-bit integer (`hash |= 0`), and `Number.prototype.toString(16)`
    — which renders a negative value as `-` followed by the magnitude in
    hex, NOT as two's complement.
    """
    hash_value = 0
    for code_unit in _utf16_code_units(content):
        hash_value = ((hash_value << 5) - hash_value) + code_unit
        # `hash |= 0` — truncate to a signed 32-bit integer.
        hash_value &= 0xFFFFFFFF
        if hash_value >= 0x80000000:
            hash_value -= 0x100000000
    if hash_value < 0:
        return "-" + format(-hash_value, "x")
    return format(hash_value, "x")


def _utf16_code_units(text: str):
    for char in text:
        point = ord(char)
        if point > 0xFFFF:
            point -= 0x10000
            yield 0xD800 + (point >> 10)
            yield 0xDC00 + (point & 0x3FF)
        else:
            yield point


def get_version_stats(home: Path, project_id: str) -> dict[str, Any]:
    history = load_version_history(home, project_id)
    if not history or not history.get("versions"):
        return {"totalVersions": 0, "currentVersion": 0,
                "oldestVersion": None, "newestVersion": None}
    versions = history["versions"]
    return {
        "totalVersions": len(versions),
        "currentVersion": history["current"],
        "oldestVersion": versions[0]["timestamp"] if versions else None,
        "newestVersion": versions[-1]["timestamp"] if versions else None,
    }
