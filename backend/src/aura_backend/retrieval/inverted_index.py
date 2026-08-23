"""A real keyword index with BM25 ranking.

A port of packages/knowledge-coding/src/store/invertedIndex.ts.

**No vectors.** This is the whole retrieval mechanism of the product:
code-aware tokenization, term→chunk postings with frequencies, per-chunk
lengths, BM25 scoring, and exact/prefix/bounded-fuzzy term expansion.
Replacing it with an embedding store would silently change every result
the product has ever returned, which is why the constants below are
copied rather than chosen.

`chunk_terms` is the canonical serialized form; postings and lengths are
derived from it, so persistence is compact and reload is exact.

Ordering note: JavaScript `Map` and `Set` iterate in insertion order, and
the reference's output arrays come from `[...set]`. Python's `set` has no
order, so ordered dicts are used wherever the reference's output order is
observable.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Literal

K1 = 1.5
B = 0.75

ExpansionKind = Literal["exact", "prefix", "fuzzy"]

_WORD = re.compile(r"[A-Za-z0-9_$]+")
_SPLIT_PARTS = re.compile(r"[_$\-]+")
_CAMEL_LOWER_UPPER = re.compile(r"([a-z0-9])([A-Z])")
_CAMEL_UPPER_WORD = re.compile(r"([A-Z]+)([A-Z][a-z])")
_WHITESPACE = re.compile(r"\s+")

MIN_TOKEN = 2
MAX_TOKEN = 40


@dataclass
class RawHit:
    chunk_id: str
    score: float
    # Query tokens that contributed.
    matched: list[str] = field(default_factory=list)
    # 'bm25' plus the expansion kinds used.
    reasons: list[str] = field(default_factory=list)


def split_identifier(token: str) -> list[str]:
    """`parseHTTPResponse` -> `parse`, `HTTP`, `Response`."""
    out: list[str] = []
    for part in _SPLIT_PARTS.split(token):
        if not part:
            continue
        camel = _CAMEL_LOWER_UPPER.sub(r"\1 \2", part)
        camel = _CAMEL_UPPER_WORD.sub(r"\1 \2", camel)
        out.extend(_WHITESPACE.split(camel))
    return out


def tokenize(text: str) -> list[str]:
    """Code-aware tokenization: the whole token AND its sub-tokens."""
    out: list[str] = []
    for token in _WORD.findall(text):
        lower = token.lower()
        if MIN_TOKEN <= len(lower) <= MAX_TOKEN:
            out.append(lower)
        for sub in split_identifier(token):
            s = sub.lower()
            if MIN_TOKEN <= len(s) <= MAX_TOKEN and s != lower:
                out.append(s)
    return out


def edit_distance(a: str, b: str, max_distance: int) -> int:
    """Bounded Levenshtein — returns a distance capped at `max + 1`.

    The cap matters: it lets the row-minimum check bail out early, which
    is what makes scanning every index term for fuzzy matches affordable.
    """
    if abs(len(a) - len(b)) > max_distance:
        return max_distance + 1
    prev = list(range(len(b) + 1))
    cur = [0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        cur[0] = i
        row_min = cur[0]
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            row_min = min(row_min, cur[j])
        if row_min > max_distance:
            return max_distance + 1
        prev = cur[:]
    return prev[len(b)]


class InvertedIndex:
    def __init__(self) -> None:
        # term -> {chunk_id: term frequency}
        self._postings: dict[str, dict[str, int]] = {}
        # chunk_id -> [(term, count), ...]  — the canonical form
        self._chunk_terms: dict[str, list[tuple[str, int]]] = {}
        self._lengths: dict[str, int] = {}
        self._total_len = 0

    @property
    def chunk_count(self) -> int:
        return len(self._lengths)

    @property
    def _avgdl(self) -> float:
        return self._total_len / self.chunk_count if self.chunk_count else 1

    def add(self, chunk_id: str, text: str) -> None:
        if chunk_id in self._chunk_terms:
            self.remove(chunk_id)
        tokens = tokenize(text)
        tf: dict[str, int] = {}
        for token in tokens:
            tf[token] = tf.get(token, 0) + 1

        entries: list[tuple[str, int]] = []
        for term, count in tf.items():
            entries.append((term, count))
            self._postings.setdefault(term, {})[chunk_id] = count
        self._chunk_terms[chunk_id] = entries
        self._lengths[chunk_id] = len(tokens)
        self._total_len += len(tokens)

    def remove(self, chunk_id: str) -> None:
        entries = self._chunk_terms.get(chunk_id)
        if entries is None:
            return
        for term, _count in entries:
            posting = self._postings.get(term)
            if posting is not None:
                posting.pop(chunk_id, None)
                if not posting:
                    del self._postings[term]
        self._total_len -= self._lengths.get(chunk_id, 0)
        self._lengths.pop(chunk_id, None)
        del self._chunk_terms[chunk_id]

    def _expand(
        self, token: str, modes: set[str], max_distance: int
    ) -> list[tuple[str, float, str]]:
        """Expand one query token into matching index terms with weights."""
        hits: list[tuple[str, float, str]] = []
        if token in self._postings:
            hits.append((token, 1.0, "exact"))

        if "prefix" in modes and len(token) >= 2:
            for term in self._postings:
                if term != token and term.startswith(token):
                    hits.append((term, 0.5, "prefix"))

        if "fuzzy" in modes and len(token) >= 4:
            for term in self._postings:
                if term == token or term.startswith(token):
                    continue
                if abs(len(term) - len(token)) > max_distance:
                    continue
                distance = edit_distance(token, term, max_distance)
                if distance <= max_distance:
                    weight = 0.35 * (1 - distance / (max_distance + 1))
                    hits.append((term, weight, "fuzzy"))
        return hits

    def search(
        self, query_tokens: list[str], modes: set[str], max_distance: int
    ) -> list[RawHit]:
        n = self.chunk_count
        if n == 0:
            return []
        avgdl = self._avgdl

        # chunk_id -> accumulated score, matched tokens, reasons.
        # Ordered dicts stand in for JS Map/Set, whose insertion order the
        # reference's output arrays inherit.
        acc: dict[str, dict[str, Any]] = {}
        unique_q = list(dict.fromkeys(query_tokens))

        for qtok in unique_q:
            for term, weight, kind in self._expand(qtok, modes, max_distance):
                posting = self._postings.get(term)
                if not posting:
                    continue
                df = len(posting)
                idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
                for chunk_id, tf in posting.items():
                    dl = self._lengths.get(chunk_id, avgdl)
                    norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (dl / avgdl)))
                    entry = acc.get(chunk_id)
                    if entry is None:
                        entry = {"score": 0.0, "matched": {}, "reasons": {"bm25": None}}
                        acc[chunk_id] = entry
                    entry["score"] += weight * idf * norm
                    entry["matched"][qtok] = None
                    entry["reasons"][kind] = None

        hits = [
            RawHit(
                chunk_id=chunk_id,
                score=entry["score"],
                matched=list(entry["matched"]),
                reasons=list(entry["reasons"]),
            )
            for chunk_id, entry in acc.items()
        ]
        # Stable sort by descending score, matching the reference's stable
        # comparator over a Map that iterates in insertion order.
        hits.sort(key=lambda h: h.score, reverse=True)
        return hits

    # ── Serialization (canonical = chunk_terms) ──────────────────────

    def to_json(self) -> dict[str, Any]:
        return {
            "chunkTerms": [[cid, [list(e) for e in entries]]
                           for cid, entries in self._chunk_terms.items()]
        }

    @staticmethod
    def from_json(data: dict[str, Any]) -> InvertedIndex:
        index = InvertedIndex()
        for chunk_id, entries in data.get("chunkTerms", []):
            pairs = [(term, count) for term, count in entries]
            index._chunk_terms[chunk_id] = pairs
            length = 0
            for term, count in pairs:
                index._postings.setdefault(term, {})[chunk_id] = count
                length += count
            index._lengths[chunk_id] = length
            index._total_len += length
        return index
