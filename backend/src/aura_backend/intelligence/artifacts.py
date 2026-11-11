"""Readers for the cached intelligence artifacts.

Ports of the `load*` functions in packages/ai-service/src/intelligence/.

**Readers only.** The generators that produce these artifacts — the
561-line identity scan, the module summarizer, the health engine — belong
to the intelligence pipeline, which is the remaining Phase 4 work. The
Context Fabric never generates: it loads, grades and reports. A section
whose artifact has not been produced reads `unknown`, which is the
designed behaviour rather than a gap being papered over.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..core.json_store import read_json

# The fingerprint has ONE definition, in `identity.py`, beside the
# generator that writes it. Re-deriving it here would be a second
# authority for a string that is compared byte-for-byte.
from .identity import IDENTITY_MARKERS, compute_fingerprint

compute_identity_fingerprint = compute_fingerprint

__all__ = [
    "IDENTITY_MARKERS", "compute_identity_fingerprint", "get_current_version",
    "identity_needs_regeneration", "load_identity", "load_repository_health",
    "load_repository_profile", "load_repository_summary", "load_version_history",
]


def load_identity(home: Path, project_id: str) -> dict[str, Any] | None:
    return read_json(home / "identity" / f"{project_id}.json", None)


def identity_needs_regeneration(home: Path, project_id: str, root: str) -> bool:
    existing = load_identity(home, project_id)
    if not existing:
        return True
    return existing.get("fingerprint") != compute_identity_fingerprint(root)


def load_repository_summary(home: Path, project_id: str) -> dict[str, Any] | None:
    return read_json(home / "summaries" / f"{project_id}.json", None)


def load_repository_profile(home: Path, project_id: str) -> dict[str, Any] | None:
    return read_json(home / "repo-profile" / f"{project_id}.json", None)


def load_repository_health(home: Path, project_id: str) -> dict[str, Any] | None:
    return read_json(home / "health" / f"{project_id}.json", None)


def load_version_history(home: Path, project_id: str) -> dict[str, Any] | None:
    return read_json(home / "versions" / f"{project_id}.json", None)


def get_current_version(home: Path, project_id: str) -> dict[str, Any] | None:
    history = load_version_history(home, project_id)
    if not history or not history.get("versions"):
        return None
    versions = history["versions"]
    index = history.get("current", 0) - 1
    return versions[index] if 0 <= index < len(versions) else None
