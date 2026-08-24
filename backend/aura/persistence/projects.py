"""ProjectRegistry — port of ai-service/src/projects.ts (cwd authority).

Execution directories come from THIS registry, never from request input.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

from ..config import aura_path
from ..jsonutil import read_json_file, write_json_file


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s[:60] or "project"


class ProjectRegistry:
    def __init__(self, clock=_now) -> None:
        self._file = aura_path("projects.json")
        self._items: list[dict] = []
        self._current_id: str | None = None
        self._profiles: dict[str, dict] = {}
        self.clock = clock
        self.load()

    # persistence -------------------------------------------------------------

    def load(self) -> None:
        data = read_json_file(self._file, {"projects": [], "current": None})
        self._items = [p for p in (data.get("projects") or []) if isinstance(p, dict)]
        self._current_id = data.get("current")

    def save(self) -> None:
        write_json_file(self._file, {"projects": self._items,
                                     "current": self._current_id})

    # queries -------------------------------------------------------------------

    def list_projects(self) -> list[dict]:
        return list(self._items)

    def get(self, pid: str) -> dict | None:
        return next((p for p in self._items if p["id"] == pid), None)

    def current_project(self) -> dict | None:
        return self.get(self._current_id) if self._current_id else None

    def profile(self, pid: str) -> dict | None:
        return self._profiles.get(pid)

    # mutations -------------------------------------------------------------------

    def add(self, inp: dict) -> dict:
        abs_ = os.path.abspath(inp["path"])
        if not os.path.isdir(abs_):
            raise RuntimeError(f"No folder exists at {abs_}")
        if any(os.path.abspath(p["path"]) == abs_ for p in self._items):
            raise RuntimeError("That folder is already registered as a project.")
        name = (inp.get("name") or os.path.basename(abs_))[:80]
        rec = {
            "id": f"proj-{slug(name)}-{len(self._items) + 1}",
            "name": name,
            "path": abs_,
            "type": inp.get("type") or "generic",
            "language": inp.get("language") or "",
            "icon": inp.get("icon") or "",
            "createdAt": self.clock(),
        }
        self._items.append(rec)
        self.save()
        return rec

    def create_project(self, name: str, parent_path: str | None = None) -> dict:
        parent = parent_path or os.path.join(os.path.expanduser("~"), "aura-projects")
        os.makedirs(parent, exist_ok=True)
        base = slug(name)
        path = os.path.join(parent, base)
        n = 2
        while os.path.exists(path):
            path = os.path.join(parent, f"{base}-{n}"); n += 1
        os.makedirs(path)
        return self.add({"name": name, "path": path})

    def open(self, pid: str) -> dict:
        rec = self.get(pid)
        if not rec:
            raise RuntimeError(f"No project with id '{pid}'")
        self._current_id = pid
        self.save()
        return rec
