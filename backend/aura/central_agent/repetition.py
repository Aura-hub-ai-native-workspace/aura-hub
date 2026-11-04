"""Detecting a model stuck in a loop — and nothing else.

A small model can fall into a verbatim cycle ("Exit the Workspace… Exit the
Project… Exit the Workspace…") and keep producing it until a token cap. That is
not an answer and must not be reported as one. This detector looks only at the
generated text: the tail is a unit repeated back to back at least ``min_repeats``
times, the unit being at least ``min_unit`` characters. A shorter or less regular
echo (a table, a list, a code block with similar lines) never qualifies, so a long
legitimate answer is not cut short.

It is deterministic and cheap (checked every ``step`` new characters), has no
model in the loop, and says where the first copy of the loop ends, so the text
before the loop can be kept.
"""
from __future__ import annotations

MIN_UNIT = 40          # a repeated unit shorter than this is style, not a loop
MIN_REPEATS = 3        # the same unit three times in a row
MAX_UNIT = 1500        # the longest cycle looked for
WINDOW = MIN_REPEATS * MAX_UNIT + 200
STEP = 128             # re-check after this many new characters


def find_loop(text: str, *, min_unit: int = MIN_UNIT, min_repeats: int = MIN_REPEATS,
              max_unit: int = MAX_UNIT) -> int | None:
    """Index just after the FIRST copy of a trailing loop, or None.

    ``text[:index]`` is the answer up to and including one copy of the repeated
    unit; everything after it is the loop.
    """
    n = len(text)
    tail = text[-(min_repeats * max_unit + 200):]
    offset = n - len(tail)
    m = len(tail)
    limit = min(max_unit, m // min_repeats)
    for unit in range(min_unit, limit + 1):
        a = tail[m - unit:]
        ok = True
        for k in range(2, min_repeats + 1):
            if tail[m - k * unit: m - (k - 1) * unit] != a:
                ok = False
                break
        if ok:
            # Walk back to where the periodicity really begins (character by
            # character, so the cut is not phase-shifted), then keep one copy.
            start = m - min_repeats * unit
            while start > 0 and tail[start - 1] == tail[start - 1 + unit]:
                start -= 1
            return offset + start + unit
    return None


class RepetitionGuard:
    """Feed streamed pieces; ``feed`` returns True once a loop is established."""

    def __init__(self) -> None:
        self._parts: list[str] = []
        self._len = 0
        self._checked_at = 0
        self.cut: int | None = None

    @property
    def text(self) -> str:
        return "".join(self._parts)

    def feed(self, piece: str) -> bool:
        self._parts.append(piece)
        self._len += len(piece)
        if self.cut is not None:
            return True
        if self._len - self._checked_at < STEP or self._len < MIN_UNIT * MIN_REPEATS:
            return False
        self._checked_at = self._len
        self.cut = find_loop(self.text)
        return self.cut is not None

    def useful_text(self) -> str:
        """What was written before the loop, plus one copy of its unit."""
        text = self.text
        return text[: self.cut] if self.cut is not None else text
