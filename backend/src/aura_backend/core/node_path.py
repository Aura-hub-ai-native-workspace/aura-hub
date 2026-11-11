"""Node's `path` semantics where they differ from `os.path`.

One difference, and it is load-bearing: `path.relative(x, x)` is the
EMPTY STRING in Node, where `os.path.relpath(x, x)` is `"."`. That value
becomes the `path` field of the module-hierarchy root and the relative
path of any file compared against itself, so it reaches the wire.
"""

from __future__ import annotations

import os


def rel_path(target: str, start: str) -> str:
    """`path.relative(start, target)`."""
    relative = os.path.relpath(target, start)
    return "" if relative == "." else relative
