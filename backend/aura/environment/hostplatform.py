"""The one place the environment subsystem asks which operating system it is on.

Platform checks used to be spread over six modules in three different forms —
``IS_WINDOWS`` module constants, ``sys.platform`` comparisons and
``platform.system()`` calls. Constants in particular are read once at import,
so the Windows and macOS code paths could not be exercised at all from a
Linux machine: a test could patch one module's constant and the next module
would still believe it was on Linux.

Everything now goes through :func:`current`, which is a *call*, so
:func:`simulate` can put the whole subsystem on a different operating system
for the length of a block. That turns "we think this works on Windows" into a
deterministic test.

What simulation can and cannot do
---------------------------------
It drives *our* branching: which probe candidate is tried, which directories
are searched, whether ``PATHEXT`` applies, how a process tree is terminated,
which package managers are asked. It does not change the kernel underneath —
``os.sep`` stays ``/`` on Linux, POSIX permissions still exist, and a real
``.exe`` still will not run. Tests written against it are **mock verified**,
never native verified, and the suite says so in those words.
"""
from __future__ import annotations

import sys
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from enum import Enum


class Platform(str, Enum):
    LINUX = "linux"
    MACOS = "macos"
    WINDOWS = "windows"


def _detect() -> Platform:
    if sys.platform == "win32":
        return Platform.WINDOWS
    if sys.platform == "darwin":
        return Platform.MACOS
    return Platform.LINUX


#: The real operating system, resolved once — this genuinely cannot change.
NATIVE: Platform = _detect()

#: A per-context override. A ContextVar rather than a global so a simulating
#: test cannot leak its pretend platform into a concurrently running one.
_simulated: ContextVar[Platform | None] = ContextVar("aura_simulated_platform", default=None)


def current() -> Platform:
    """The platform the environment subsystem should behave as."""
    return _simulated.get() or NATIVE


def is_windows() -> bool:
    return current() is Platform.WINDOWS


def is_macos() -> bool:
    return current() is Platform.MACOS


def is_linux() -> bool:
    return current() is Platform.LINUX


def is_simulated() -> bool:
    """True when behaviour is being driven by :func:`simulate`."""
    return _simulated.get() is not None


def path_sep() -> str:
    """The PATH separator for the current (possibly simulated) platform."""
    return ";" if is_windows() else ":"


@contextmanager
def simulate(platform: Platform) -> Iterator[Platform]:
    """Behave as ``platform`` for the duration of the block.

    Intended for tests and for reasoning about foreign platforms. Production
    code must never call this; the architecture test asserts that it does not.
    """
    token = _simulated.set(platform)
    try:
        yield platform
    finally:
        _simulated.reset(token)
