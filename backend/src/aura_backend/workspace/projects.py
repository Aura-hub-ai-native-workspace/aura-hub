"""The real, persistent project library.

A port of packages/ai-service/src/projects.ts.

A project is a pointer to a real folder on disk plus metadata. The
registry is the single source of truth for which workspace anything
mounts, and — load-bearing for the whole security model — **the only
place a `cwd` comes from**. An execution never receives a directory a
caller supplied.

No sample projects are ever seeded. An empty registry means the user has
not added a project yet.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..core.json_store import JsonStore
from ..fabric.types import now_iso

COLORS = ("#3b6bff", "#1fb567", "#f5a524", "#7c5cff", "#e5484d", "#0ea5e9")

_NON_SLUG = re.compile(r"[^a-z0-9]+")
_EDGE_DASH = re.compile(r"^-+|-+$")


def slug(name: str) -> str:
    """Lowercase, dash-separated, and never empty.

    Ids produced here become path segments under the AURA home, which is
    why the character class is a whitelist rather than a blacklist.
    """
    out = _EDGE_DASH.sub("", _NON_SLUG.sub("-", name.lower()))
    return out or "project"


@dataclass
class ProjectRecord:
    id: str
    name: str
    # Absolute path to the real project folder.
    path: str
    # Coarse project type, detected from the folder (see profile.py).
    type: str
    # Primary language, detected from the folder.
    language: str
    icon: str
    color: str
    favorite: bool
    created_at: str
    last_opened_at: str | None

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "path": self.path,
            "type": self.type,
            "language": self.language,
            "icon": self.icon,
            "color": self.color,
            "favorite": self.favorite,
            "createdAt": self.created_at,
            "lastOpenedAt": self.last_opened_at,
        }

    @staticmethod
    def from_json(raw: dict[str, Any]) -> ProjectRecord:
        return ProjectRecord(
            id=raw["id"],
            name=raw.get("name", ""),
            path=raw.get("path", ""),
            type=raw.get("type", "unknown"),
            language=raw.get("language", "unknown"),
            icon=raw.get("icon", "folder"),
            color=raw.get("color", COLORS[0]),
            favorite=bool(raw.get("favorite", False)),
            created_at=raw.get("createdAt", ""),
            last_opened_at=raw.get("lastOpenedAt"),
        )


class ProjectNotFound(Exception):
    pass


class ProjectRejected(Exception):
    """The folder is not something AURA will register."""


class ProjectRegistry:
    def __init__(self, home: Path) -> None:
        self._store = JsonStore(home / "projects.json", default=[])
        raw = self._store.load()
        self._items: list[ProjectRecord] = [
            ProjectRecord.from_json(r) for r in raw if isinstance(r, dict) and r.get("id")
        ]

    def _save(self) -> None:
        self._store.save([p.to_json() for p in self._items])

    def list(self) -> list[ProjectRecord]:
        """Most-recently-opened first, then most-recently-created."""
        return sorted(
            self._items,
            key=lambda p: p.last_opened_at or p.created_at,
            reverse=True,
        )

    def get(self, project_id: str) -> ProjectRecord | None:
        return next((p for p in self._items if p.id == project_id), None)

    def _unique_id(self, base: str) -> str:
        candidate = slug(base)
        n = 1
        while any(p.id == candidate for p in self._items):
            n += 1
            candidate = f"{slug(base)}-{n}"
        return candidate

    def add(
        self,
        path: str,
        name: str | None = None,
        type_: str = "unknown",
        language: str = "unknown",
        icon: str = "folder",
    ) -> ProjectRecord:
        """Add a real, existing folder as a project.

        Rejects paths that do not exist or are not directories — it never
        fabricates a project, and it never creates the folder as a side
        effect of being asked to register one.
        """
        absolute = Path(path).resolve()
        if not absolute.is_dir():
            raise ProjectRejected(f"not a directory: {absolute}")
        if any(Path(p.path).resolve() == absolute for p in self._items):
            raise ProjectRejected(f"project already added: {absolute}")

        display = ((name or "").strip() or absolute.name)[:80]
        record = ProjectRecord(
            id=self._unique_id(display),
            name=display,
            path=str(absolute),
            type=type_,
            language=language,
            icon=icon,
            color=COLORS[len(self._items) % len(COLORS)],
            favorite=False,
            created_at=now_iso(),
            last_opened_at=None,
        )
        self._items.append(record)
        self._save()
        return record

    def update(self, project_id: str, **patch: Any) -> ProjectRecord:
        record = self.get(project_id)
        if record is None:
            raise ProjectNotFound(f"no such project: {project_id}")
        if patch.get("name") is not None:
            record.name = patch["name"].strip()[:80] or record.name
        for field in ("favorite", "type", "language", "icon", "color"):
            if patch.get(field) is not None:
                setattr(record, field, patch[field])
        self._save()
        return record

    def touch(self, project_id: str) -> ProjectRecord | None:
        record = self.get(project_id)
        if record is None:
            return None
        record.last_opened_at = now_iso()
        self._save()
        return record

    def remove(self, project_id: str) -> bool:
        """Remove a project from the registry.

        **Never deletes the folder itself.** Forgetting a project and
        destroying a user's work are not the same operation, and this one
        is the former.
        """
        before = len(self._items)
        self._items = [p for p in self._items if p.id != project_id]
        if len(self._items) == before:
            return False
        self._save()
        return True
