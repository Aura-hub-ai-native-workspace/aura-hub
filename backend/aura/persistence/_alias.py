"""Shared store plumbing."""

from __future__ import annotations

import re


class CamelAlias:
    """Resolve TS-style camelCase attribute names onto snake_case methods.

    The differential harness addresses both implementations with the SAME
    op names (the TypeScript ones), so the Python ports accept e.g.
    ``ensureVersionForRun`` and dispatch to :meth:`ensure_version_for_run`.
    """

    def __getattr__(self, name: str):  # noqa: D105
        if name.startswith("__"):
            raise AttributeError(name)
        snake = re.sub(r"(?<!^)([A-Z])", r"_\1", name).lower()
        if snake != name:
            target = getattr(self, snake, None)
            if callable(target):
                return target
        if name == "import":
            target = getattr(self, "import_workflow", None)
            if callable(target):
                return target
        raise AttributeError(name)
