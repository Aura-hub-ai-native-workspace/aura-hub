"""Shared internals for the persistence layer.

Determinism primitives matter as much as the stores themselves: the
differential harness drives BOTH the TypeScript oracle and these ports
through identical clock/random sequences so persisted bytes can be compared
exactly (see backend/tests/differential/test_stores_diff.py).
"""

from __future__ import annotations

import datetime as _dt
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

# ── Node-compatible time formatting ─────────────────────────────────────────


def iso_from_ms(epoch_ms: int | float) -> str:
    """new Date(ms).toISOString() equivalent — millisecond precision, Z suffix."""
    dt = _dt.datetime.fromtimestamp(epoch_ms / 1000, tz=_dt.UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _base36_int(n: int) -> str:
    if n == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out


def js_random_base36(r: float, length: int = 6) -> str:
    """Math.random().toString(36).slice(2, 2+length) for an exact binary fraction.

    The differential harness feeds both languages random values of the form
    k/2^22, whose base-36 expansion is finite — so this reproduction is exact,
    not approximate.
    """
    frac = r - int(r)
    out = ""
    for _ in range(length + 4):  # margin; binary fractions terminate quickly
        frac *= 36
        d = int(frac)
        out += "0123456789abcdefghijklmnopqrstuvwxyz"[min(d, 35)]
        frac -= d
        if frac <= 0:
            break
    return out[:length]


def mulberry32(seed: int) -> Callable[[], float]:
    """The canonical 32-bit PRNG, bit-exact in Python (used by both harnesses)."""
    state = [seed & 0xFFFFFFFF]

    def rnd() -> float:
        t = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        state[0] = t

        def imul(a: int, b: int) -> int:
            return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF

        r = t
        r = imul(r ^ (r >> 15), (r | 1) & 0xFFFFFFFF)
        r ^= (r + (imul(r ^ (r >> 7), (r | 61) & 0xFFFFFFFF))) & 0xFFFFFFFF
        return ((r ^ (r >> 14)) & 0xFFFFFFFF) / 4294967296

    return rnd


def make_gen_id(clock: Callable[[], float], rand: Callable[[], float]) -> Callable[[str], str]:
    """genId mirror (workflow/types.ts:218): `${p}-${now36}-${rand36.slice(0,6)}`."""

    def gen_id(prefix: str) -> str:
        return f"{prefix}-{_base36_int(int(clock()))}-{js_random_base36(rand())}"

    return gen_id


def stepped_clock(start_ms: int, step_ms: int = 1000) -> Callable[[], float]:
    state = [start_ms]

    def tick() -> float:
        state[0] += step_ms
        return state[0]

    return tick


def counter_rand(step_denom: int = 4_194_304) -> Callable[[], float]:
    """k/2^22 ascending — exact binary fractions for base36 reproduction."""
    state = [1]

    def nxt() -> float:
        state[0] += 7  # coprime stride; still exact binary fractions
        return (state[0] % step_denom) / step_denom

    return nxt


# ── filesystem helpers ───────────────────────────────────────────────────────


def tree_digest(root: Path) -> dict[str, str]:
    """relpath → sha256 of every file under root (sorted). Used by diff tests."""
    import hashlib

    out: dict[str, str] = {}
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out[str(p.relative_to(root))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def normalize_tokens(text: str) -> str:
    """Mask CSPRNG artifacts (48-hex webhook tokens) before byte comparison."""
    import re

    return re.sub(r"\b[0-9a-f]{48}\b", "<TOKEN48>", text)


def rm_rf(path: Path) -> None:
    import shutil

    shutil.rmtree(path, ignore_errors=True)


__all__ = [
    "counter_rand",
    "iso_from_ms",
    "js_random_base36",
    "make_gen_id",
    "mulberry32",
    "normalize_tokens",
    "rm_rf",
    "stepped_clock",
    "tree_digest",
]

# silence linters about intentional re-export shape
_: Any = os
