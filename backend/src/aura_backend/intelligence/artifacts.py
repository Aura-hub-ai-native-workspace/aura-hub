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

from ..core.js_number import js_number
from ..core.json_store import read_json
from ..core.node_time import mtime_ms

# The manifests whose mtimes define a project's identity fingerprint.
# Note this list differs from the profile's — it includes Makefile and
# CMakeLists.txt, because identity classifies native and kernel projects
# that have no package manifest at all.
IDENTITY_MARKERS = (
    "package.json", "requirements.txt", "pyproject.toml", "go.mod",
    "Cargo.toml", "pom.xml", "Makefile", "CMakeLists.txt",
)


def _mtime_ms(path: Path) -> float:
    try:
        return mtime_ms(path)
    except OSError:
        return 0


def compute_identity_fingerprint(root: str) -> str:
    base = Path(root)
    # Stringified exactly as the reference stringifies it: this value is
    # compared for equality, so one digit decides whether the whole
    # repository identity is regenerated.
    return "|".join(f"{m}:{js_number(_mtime_ms(base / m))}" for m in IDENTITY_MARKERS)


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
