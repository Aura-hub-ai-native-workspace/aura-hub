"""Config home resolution — Python mirror of packages/ai-service/src/persist.ts:22-25.

Default home: ~/.aura, override with AURA_HOME. Deliberately NO mkdir side
effect here (the TS version creates on access); directory creation belongs to
the persistence writers so reads never mutate the filesystem.
"""

from __future__ import annotations

import os
from pathlib import Path


def aura_home() -> Path:
    override = os.environ.get("AURA_HOME")
    if override:
        return Path(override)
    return Path.home() / ".aura"


def aura_path(*parts: str) -> Path:
    return aura_home().joinpath(*parts)
