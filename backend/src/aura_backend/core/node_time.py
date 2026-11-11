"""One definition of `mtimeMs`.

Node reports a file's modification time as a **double** built the way
libuv builds it:

    mtimeMs = tv_sec * 1000 + tv_nsec / 1e6

That is NOT the same double as `st_mtime_ns / 1e6`. Both are correct to
within a rounding error, and they differ by one unit in the last place
often enough to matter, because the value is **stringified into
fingerprints**:

    ns/1e6                    →  1787501494393.2349
    tv_sec * 1000 + ns/1e6    →  1787501494393.235   ← what Node prints

A fingerprint is compared for equality, so one ULP is the difference
between "the project is unchanged" and "regenerate everything". A
profile or identity artifact written by the TypeScript backend must read
as current under the Python backend, and vice versa — which it only does
if both compute this number identically.

`st_mtime * 1000` is worse again: `st_mtime` is already a lossy float
before the multiplication.

Every mtime the backend exposes or fingerprints goes through here.
"""

from __future__ import annotations

import math
import os

_NS_PER_S = 10**9


def mtime_ms_from_ns(nanoseconds: int) -> float:
    """Node's `mtimeMs` for a modification time given in nanoseconds."""
    return (nanoseconds // _NS_PER_S) * 1000 + (nanoseconds % _NS_PER_S) / 1e6


def mtime_ms(path: str | os.PathLike[str]) -> float:
    """Node's `mtimeMs` for a path. Raises `OSError` like `stat` does."""
    return mtime_ms_from_ns(os.stat(path).st_mtime_ns)


def stat_mtime_ms(stat_result: os.stat_result) -> float:
    """Node's `mtimeMs` from an already-taken `stat`."""
    return mtime_ms_from_ns(stat_result.st_mtime_ns)


def date_ms_from_stat(stat_result: os.stat_result) -> int:
    """The integer millisecond Node's `stat.mtime` Date carries.

    Measured against the real `fs.statSync().mtime.getTime()`: Node
    ROUNDS HALF UP, not truncating and not to even. A modification time
    of `…000.5` ms becomes `…001` there, `…000` under Python's `round`
    (banker's) and `…000` under `trunc`.
    """
    return math.floor(mtime_ms_from_ns(stat_result.st_mtime_ns) + 0.5)
