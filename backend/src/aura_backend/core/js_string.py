"""JavaScript string operations that differ from Python's.

`String.prototype.slice` counts UTF-16 code units, so `s.slice(0, 300)`
can cut an astral character in half and produces a different result from
Python's `s[:300]` whenever the text contains one. The reference slices
file contents constantly — README prose, source heads, snippets — so a
document with an emoji in the first 300 characters would otherwise
produce a different summary in each backend.
"""

from __future__ import annotations


def _needs_utf16(text: str) -> bool:
    return any(ord(c) > 0xFFFF for c in text)


def slice_utf16(text: str, start: int = 0, end: int | None = None) -> str:
    """`text.slice(start, end)` with JavaScript's UTF-16 indexing.

    A lone surrogate produced by cutting an astral character in half is
    what JavaScript yields; Python cannot represent it, so the half is
    dropped instead. That is the one place this cannot be identical, and
    it is reported rather than hidden — see `sliced_surrogate`.
    """
    if not _needs_utf16(text):
        return text[start:end]
    units = text.encode("utf-16-le")
    end_unit = len(units) // 2 if end is None else end
    chunk = units[start * 2 : end_unit * 2]
    return chunk.decode("utf-16-le", errors="ignore")


def sliced_surrogate(text: str, start: int = 0, end: int | None = None) -> bool:
    """True when the slice would split an astral character.

    The only case where `slice_utf16` cannot be byte-identical to
    JavaScript. Call sites that care can report it instead of pretending.
    """
    if not _needs_utf16(text):
        return False
    units = text.encode("utf-16-le")
    end_unit = len(units) // 2 if end is None else end
    chunk = units[start * 2 : end_unit * 2]
    try:
        chunk.decode("utf-16-le")
    except UnicodeDecodeError:
        return True
    return False
