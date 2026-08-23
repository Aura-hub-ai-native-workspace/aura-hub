"""Safe file reader.

A port of packages/knowledge-coding/src/reader.ts.

Reads real files defensively: caps very large files at a byte limit,
detects binary content and skips it, tolerates invalid UTF-8, and turns
permission and IO errors into typed results rather than exceptions. It
never raises.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

SNIFF = 8192
# Above this share of control characters in the sample, treat as binary.
CONTROL_RATIO = 0.3
# Above this share of U+FFFD after a lossy decode, treat as binary.
REPLACEMENT_RATIO = 0.1


def sha1(data: bytes) -> str:
    """Real sha1 over file bytes, for change detection."""
    return hashlib.sha1(data).hexdigest()


@dataclass
class ReadResult:
    ok: bool
    bytes_read: int
    truncated: bool
    binary: bool
    lines: int
    checksum: str
    text: str | None = None
    error: dict[str, str] | None = None


def looks_binary(buf: bytes) -> bool:
    """Heuristic binary detection over a byte sample."""
    n = min(len(buf), SNIFF)
    if n == 0:
        return False
    suspicious = 0
    for i in range(n):
        b = buf[i]
        if b == 0:
            # NUL -> definitely binary.
            return True
        # Control characters outside tab/newline/CR/formfeed/escape.
        if b < 9 or (13 < b < 32):
            suspicious += 1
    return suspicious / n > CONTROL_RATIO


def replacement_ratio(text: str) -> float:
    if not text:
        return 0.0
    return text.count("�") / len(text)


def read_file_safe(abs_path: str, max_bytes: int) -> ReadResult:
    try:
        path = Path(abs_path)
        size = path.stat().st_size
        to_read = min(size, max_bytes)
        with path.open("rb") as handle:
            data = handle.read(to_read)
        checksum = sha1(data)
        truncated = size > max_bytes

        if looks_binary(data):
            return ReadResult(
                ok=True, bytes_read=len(data), truncated=truncated,
                binary=True, lines=0, checksum=checksum,
            )

        text = data.decode("utf-8", errors="replace")
        if replacement_ratio(text) > REPLACEMENT_RATIO:
            return ReadResult(
                ok=True, bytes_read=len(data), truncated=truncated,
                binary=True, lines=0, checksum=checksum,
            )

        return ReadResult(
            ok=True, text=text, bytes_read=len(data), truncated=truncated,
            binary=False, lines=1 + text.count("\n"), checksum=checksum,
        )
    except OSError as exc:
        return ReadResult(
            ok=False, bytes_read=0, truncated=False, binary=False, lines=0,
            checksum="",
            error={"code": getattr(exc, "errno", None) and _errno_name(exc) or "EUNKNOWN",
                   "message": str(exc)},
        )


def _errno_name(exc: OSError) -> str:
    import errno as _errno

    return _errno.errorcode.get(exc.errno or 0, "EUNKNOWN")
