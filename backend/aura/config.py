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


def inside_aura_home(path: str | Path) -> bool:
    """True for a path inside the data folder (not the folder itself)."""
    try:
        rel = Path(os.path.abspath(path)).relative_to(os.path.abspath(aura_home()))
    except ValueError:
        return False
    return rel != Path(".")


_protected: set[str] = set()


def protect_aura_home() -> None:
    """Make the data folder owner-only (0700), once per process.

    It holds encrypted keys with the seed that unlocks them, account files
    and logs. Mirrors persist.ts protectHome: skipped on Windows (the
    profile folder is already private) and for a folder that is the user's
    home itself or a filesystem root. Only called by writers.
    """
    home = os.path.abspath(aura_home())
    if os.name == "nt" or home in _protected:
        return
    _protected.add(home)
    if home == os.path.abspath(Path.home()) or home == os.path.dirname(home):
        return
    try:
        os.makedirs(home, mode=0o700, exist_ok=True)
        if os.stat(home).st_mode & 0o777 != 0o700:
            os.chmod(home, 0o700)
    except OSError:
        pass
