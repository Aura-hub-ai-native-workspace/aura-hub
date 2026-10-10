"""Artifact Store — tracks engineering outputs with versioning, provenance, and integrity.

Every engineering output — CAD model, schematic, PCB, firmware, BOM,
Gerber, test report — is tracked here with:
- Version history (semver)
- SHA-256 content hash (integrity)
- Provenance chain (who produced it, how, under what governance)
- Dependency links (what it depends on)
- Verification status

Storage: JSON file via aura.jsonutil (matches existing persistence patterns).
"""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from ..config import aura_path
from ..jsonutil import read_json_file, write_json_atomic
from .domain import (
    ArtifactProvenance,
    ArtifactRecord,
    ArtifactStatus,
    ArtifactType,
    new_id,
    now_iso,
)


class ArtifactStore:
    """Manages engineering artifacts with versioning and provenance.

    Provides:
    - Create artifact records
    - Version tracking (parent chain)
    - Content integrity (SHA-256)
    - Provenance chain
    - Dependency tracking
    - Status management
    - Lookup by type, status, agent
    """

    def __init__(self, project_id: str, home: Path | None = None) -> None:
        self._project_id = project_id
        self._home = home or aura_path()
        self._dir = self._home / "engineering-artifacts" / project_id
        self._index_file = self._dir / "index.json"
        self._artifacts: dict[str, ArtifactRecord] = {}
        self.load()

    # ── Persistence ─────────────────────────────────────────────────────

    def load(self) -> None:
        data = read_json_file(self._index_file, {"artifacts": [], "version": 1})
        self._artifacts = {}
        for ad in data.get("artifacts", []):
            artifact = ArtifactRecord.from_dict(ad)
            self._artifacts[artifact.id] = artifact

    def save(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        data = {
            "version": 1,
            "projectId": self._project_id,
            "artifacts": [a.to_dict() for a in self._artifacts.values()],
        }
        write_json_atomic(self._index_file, data)

    # ── CRUD ────────────────────────────────────────────────────────────

    def create(
        self,
        artifact_type: ArtifactType,
        name: str,
        version: str,
        file_path: str,
        file_hash: str,
        source: str = "",
        author_agent: str = "",
        parent_id: str = "",
        dependencies: list[str] | None = None,
        parameters: dict[str, Any] | None = None,
        constraints: dict[str, Any] | None = None,
        provenance: ArtifactProvenance | None = None,
        artifact_id: str = "",
    ) -> ArtifactRecord:
        """Create a new artifact record."""
        aid = artifact_id or new_id("artifact")
        artifact = ArtifactRecord(
            id=aid,
            artifact_type=artifact_type,
            name=name,
            version=version,
            file_path=file_path,
            file_hash=file_hash,
            source=source,
            author_agent=author_agent,
            parent_id=parent_id,
            dependencies=dependencies or [],
            parameters=parameters or {},
            constraints=constraints or {},
            provenance=provenance or ArtifactProvenance(),
        )
        self._artifacts[aid] = artifact
        self.save()
        return artifact

    def get(self, artifact_id: str) -> ArtifactRecord | None:
        return self._artifacts.get(artifact_id)

    def update(self, artifact_id: str, **kwargs: Any) -> ArtifactRecord | None:
        artifact = self._artifacts.get(artifact_id)
        if not artifact:
            return None
        for key, value in kwargs.items():
            snake = _camel_to_snake(key)
            if hasattr(artifact, snake):
                # Convert string values back to enums where appropriate
                if snake == "status" and isinstance(value, str):
                    value = ArtifactStatus(value)
                elif snake == "artifact_type" and isinstance(value, str):
                    value = ArtifactType(value)
                setattr(artifact, snake, value)
        artifact.updated_at = now_iso()
        self.save()
        return artifact

    def remove(self, artifact_id: str) -> bool:
        if artifact_id not in self._artifacts:
            return False
        del self._artifacts[artifact_id]
        self.save()
        return True

    # ── Versioning ──────────────────────────────────────────────────────

    def new_version(
        self,
        parent_id: str,
        version: str,
        file_path: str,
        file_hash: str,
        provenance: ArtifactProvenance | None = None,
    ) -> ArtifactRecord | None:
        """Create a new version of an existing artifact."""
        parent = self._artifacts.get(parent_id)
        if not parent:
            return None
        return self.create(
            artifact_type=parent.artifact_type,
            name=parent.name,
            version=version,
            file_path=file_path,
            file_hash=file_hash,
            source=parent.source,
            author_agent=parent.author_agent,
            parent_id=parent_id,
            dependencies=parent.dependencies,
            parameters=parent.parameters,
            constraints=parent.constraints,
            provenance=provenance or ArtifactProvenance(
                agent=parent.provenance.agent,
                capability=parent.provenance.capability,
                tool=parent.provenance.tool,
            ),
        )

    def version_history(self, artifact_id: str) -> list[ArtifactRecord]:
        """Get the full version history of an artifact (newest first)."""
        history = []
        current = self._artifacts.get(artifact_id)
        while current:
            history.append(current)
            current = self._artifacts.get(current.parent_id) if current.parent_id else None
        return history

    # ── Queries ─────────────────────────────────────────────────────────

    def list_artifacts(
        self,
        artifact_type: ArtifactType | None = None,
        status: ArtifactStatus | None = None,
        author_agent: str | None = None,
    ) -> list[ArtifactRecord]:
        results = list(self._artifacts.values())
        if artifact_type:
            results = [a for a in results if a.artifact_type == artifact_type]
        if status:
            results = [a for a in results if a.status == status]
        if author_agent:
            results = [a for a in results if a.author_agent == author_agent]
        return results

    def dependencies_of(self, artifact_id: str) -> list[ArtifactRecord]:
        """Get all artifacts this artifact depends on."""
        artifact = self._artifacts.get(artifact_id)
        if not artifact:
            return []
        return [self._artifacts[did] for did in artifact.dependencies if did in self._artifacts]

    def dependents_of(self, artifact_id: str) -> list[ArtifactRecord]:
        """Get all artifacts that depend on this artifact."""
        return [
            a for a in self._artifacts.values() if artifact_id in a.dependencies
        ]

    def stale_artifacts(self) -> list[ArtifactRecord]:
        """Get all artifacts marked as stale."""
        return [a for a in self._artifacts.values() if a.status == ArtifactStatus.STALE]

    def mark_stale(self, artifact_id: str) -> ArtifactRecord | None:
        """Mark an artifact as stale (dependencies changed)."""
        return self.update(artifact_id, status=ArtifactStatus.STALE.value)

    def mark_verified(self, artifact_id: str) -> ArtifactRecord | None:
        return self.update(artifact_id, status=ArtifactStatus.VERIFIED.value)

    def mark_failed(self, artifact_id: str) -> ArtifactRecord | None:
        return self.update(artifact_id, status=ArtifactStatus.FAILED.value)

    # ── Provenance ──────────────────────────────────────────────────────

    def set_provenance(
        self, artifact_id: str, provenance: ArtifactProvenance
    ) -> ArtifactRecord | None:
        artifact = self._artifacts.get(artifact_id)
        if not artifact:
            return None
        artifact.provenance = provenance
        artifact.updated_at = now_iso()
        self.save()
        return artifact

    def provenance_chain(self, artifact_id: str) -> list[dict[str, Any]]:
        """Get the full provenance chain for an artifact (newest first)."""
        chain = []
        current = self._artifacts.get(artifact_id)
        while current:
            chain.append({
                "artifactId": current.id,
                "name": current.name,
                "version": current.version,
                "provenance": current.provenance.to_dict(),
            })
            current = self._artifacts.get(current.parent_id) if current.parent_id else None
        return chain

    # ── Integrity ───────────────────────────────────────────────────────

    def verify_integrity(self, artifact_id: str, expected_hash: str | None = None) -> dict[str, Any]:
        """Verify artifact integrity against stored or expected hash."""
        artifact = self._artifacts.get(artifact_id)
        if not artifact:
            return {"ok": False, "error": "artifact not found"}
        hash_to_check = expected_hash or artifact.file_hash
        if artifact.file_hash == hash_to_check:
            return {"ok": True, "hash": artifact.file_hash}
        return {
            "ok": False,
            "expected": hash_to_check,
            "actual": artifact.file_hash,
            "error": "hash mismatch",
        }

    # ── Summary ─────────────────────────────────────────────────────────

    def summary(self) -> dict[str, Any]:
        by_type: dict[str, int] = defaultdict(int)
        by_status: dict[str, int] = defaultdict(int)
        for a in self._artifacts.values():
            by_type[a.artifact_type.value] += 1
            by_status[a.status.value] += 1
        return {
            "projectId": self._project_id,
            "totalArtifacts": len(self._artifacts),
            "byType": dict(by_type),
            "byStatus": dict(by_status),
        }


def _camel_to_snake(s: str) -> str:
    """Convert camelCase to snake_case."""
    out: list[str] = []
    for i, ch in enumerate(s):
        if ch.isupper() and i > 0 and s[i - 1].islower():
            out.append("_")
        out.append(ch.lower())
    return "".join(out)
