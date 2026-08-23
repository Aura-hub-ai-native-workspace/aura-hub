"""The workspace façade.

A narrow port of packages/ai-service/src/workspace.ts — narrow on purpose.
The reference's `WorkspaceManager` is 1336 lines because it also owns
missions, workflows, diagnosis, providers and intelligence, none of which
have been migrated. Porting the whole class now would mean stubbing five
subsystems, and a stub that answers is worse than a capability that says
`unsupported`.

What lives here is the project side: the registry, profiles, per-project
memory and conversations, and the one thing everything else waits on —
**resolving a project id to a directory**.

That last one is the security boundary this phase exists to establish. An
execution's `cwd` comes from the registry, by id. It is never taken from a
request body, and there is no code path here that accepts one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .conversations import ProjectConversations
from .memory import MemoryKind, ProjectMemory
from .profile import ProjectProfile, get_or_build_profile, load_profile
from .projects import ProjectRecord, ProjectRegistry, ProjectRejected, slug

# A project NAME may not contain anything that could make it a path.
_UNSAFE_NAME = re.compile(r"[/\\]|^\.\.?$")


@dataclass
class OpenResult:
    project: ProjectRecord
    profile: ProjectProfile

    def to_json(self) -> dict[str, Any]:
        return {"project": self.project.to_json(), "profile": self.profile.to_json()}


class WorkspaceManager:
    def __init__(self, home: Path) -> None:
        self._home = home
        self.registry = ProjectRegistry(home)
        self._current_project_id: str | None = None

    # ── projects ─────────────────────────────────────────────────────

    def list_projects(self) -> list[ProjectRecord]:
        return self.registry.list()

    @property
    def current_project_id(self) -> str | None:
        """The project currently open, if any.

        Read-only by construction: the Context Fabric needs to report
        whether a project is mounted, and must not be able to change it.
        """
        return self._current_project_id

    def current_project(self) -> ProjectRecord | None:
        if self._current_project_id is None:
            return None
        return self.registry.get(self._current_project_id)

    def add_project(
        self, path: str, name: str | None = None, icon: str | None = None
    ) -> OpenResult:
        """Register an existing folder, and profile it immediately.

        The profile is what fills in `type` and `language` on the record,
        so those describe what is actually in the folder rather than what
        a caller claimed.
        """
        record = self.registry.add(path=path, name=name)
        profile = get_or_build_profile(self._home, record.id, record.path, force=True)
        record = self.registry.update(
            record.id,
            type=profile.type,
            language=profile.primary_language,
            icon=icon or record.icon,
        )
        return OpenResult(project=record, profile=profile)

    def create_project(self, name: str, parent_path: str | None = None) -> OpenResult:
        """Create a new folder and register it.

        The name is checked for path separators before it is used as a
        directory name — this is the one place a caller-supplied string
        becomes part of a path, so it is the one place that has to refuse.
        """
        clean = name.strip()[:80]
        if not clean:
            raise ProjectRejected("Project name is required")
        if _UNSAFE_NAME.search(clean):
            raise ProjectRejected("Project name cannot contain path separators")

        parent = Path((parent_path or "").strip() or (Path.home() / "AuraProjects"))
        target = (parent / slug(clean)).resolve()
        if target.exists():
            raise ProjectRejected(f"A folder already exists at {target}")

        target.mkdir(parents=True)
        (target / "README.md").write_text(f"# {clean}\n", encoding="utf-8")
        return self.add_project(path=str(target), name=clean)

    def rename_project(self, project_id: str, name: str) -> ProjectRecord:
        return self.registry.update(project_id, name=name)

    def set_favorite(self, project_id: str, favorite: bool) -> ProjectRecord:
        return self.registry.update(project_id, favorite=favorite)

    def remove_project(self, project_id: str) -> bool:
        if self._current_project_id == project_id:
            self._current_project_id = None
        return self.registry.remove(project_id)

    def open(self, project_id: str) -> OpenResult:
        project = self.registry.get(project_id)
        if project is None:
            raise KeyError(f"no such project: {project_id}")
        self.registry.touch(project_id)
        profile = get_or_build_profile(self._home, project.id, project.path)
        self._current_project_id = project.id
        return OpenResult(project=project, profile=profile)

    def profile(self, project_id: str) -> ProjectProfile | None:
        return load_profile(self._home, project_id)

    # ── the boundary everything else waits on ────────────────────────

    def cwd_for(self, project_id: str | None) -> str | None:
        """The directory a project's work runs in.

        Resolved from the registry, by id. A caller names a PROJECT; it
        never names a directory. This is what stops `/fabric/invoke` from
        being able to point execution anywhere on the machine.

        Returns None for an unknown project, so the executor refuses with
        "no project directory" rather than silently running somewhere.
        """
        if not project_id:
            return None
        record = self.registry.get(project_id)
        if record is None:
            return None
        # A registered path that has since been deleted, or replaced by a
        # file, is not a working directory — and pretending otherwise
        # would surface as a confusing spawn error much later.
        path = Path(record.path)
        return str(path) if path.is_dir() else None

    # ── per-project stores ───────────────────────────────────────────

    def memory_of(self, project_id: str) -> ProjectMemory:
        return ProjectMemory(self._home, project_id)

    def list_memory(self, project_id: str) -> list[dict[str, Any]]:
        return [i.to_json() for i in self.memory_of(project_id).list()]

    def add_memory(
        self, project_id: str, kind: MemoryKind, title: str, body: str, pinned: bool = False
    ) -> dict[str, Any]:
        return self.memory_of(project_id).add(kind, title, body, pinned).to_json()

    def pin_memory(self, project_id: str, item_id: str, pinned: bool) -> dict[str, Any] | None:
        item = self.memory_of(project_id).set_pinned(item_id, pinned)
        return item.to_json() if item else None

    def remove_memory(self, project_id: str, item_id: str) -> bool:
        return self.memory_of(project_id).remove(item_id)

    def search_memory(self, project_id: str, query: str) -> list[dict[str, Any]]:
        """The reference filters the full list by substring when a query is
        given, and returns everything when it is not."""
        items = self.memory_of(project_id).list()
        if not query:
            return [i.to_json() for i in items]
        needle = query.lower()
        return [
            i.to_json() for i in items if needle in f"{i.title} {i.body}".lower()
        ]

    def conversations_of(self, project_id: str) -> ProjectConversations:
        return ProjectConversations(self._home, project_id)
