"""Per-project persistent memory.

A port of packages/ai-service/src/memory.ts.

Every project has its own store that survives restarts. Memory holds real
events the user or the AI produced: conversations, decisions,
accepted/rejected answers, corrections, pinned knowledge.

Recall is keyword overlap with a pin bonus — **not** embeddings. There is
no vector retrieval anywhere in this product, and adding one here would
silently change every recall result.
"""

from __future__ import annotations

import random
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from ..core.json_store import JsonStore
from ..fabric.types import now_iso

MemoryKind = Literal[
    "conversation", "decision", "code", "accepted", "rejected",
    "correction", "pinned", "learning", "diagnosis",
]

MAX_TITLE = 160
MAX_BODY = 4000

_STOP = frozenset({
    "the", "a", "an", "is", "are", "to", "of", "in", "on", "and", "or", "for",
    "how", "what", "where", "does", "do", "this", "that", "with", "it", "be",
})
_WORDS = re.compile(r"[^a-z0-9]+")
_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(n: int) -> str:
    if n == 0:
        return "0"
    out = ""
    while n:
        out = _ALPHABET[n % 36] + out
        n //= 36
    return out


def gen_id(prefix: str) -> str:
    """Mirrors the reference's `<prefix>_<base36 ms>_<5 random>` shape."""
    suffix = "".join(random.choice(_ALPHABET) for _ in range(5))
    return f"{prefix}_{_base36(int(time.time() * 1000))}_{suffix}"


def keywords(text: str) -> set[str]:
    return {w for w in _WORDS.split(text.lower()) if len(w) > 2 and w not in _STOP}


@dataclass
class MemoryItem:
    id: str
    kind: MemoryKind
    title: str
    body: str
    pinned: bool
    at: str

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "body": self.body,
            "pinned": self.pinned,
            "at": self.at,
        }

    @staticmethod
    def from_json(raw: dict[str, Any]) -> MemoryItem:
        return MemoryItem(
            id=raw["id"],
            kind=raw.get("kind", "conversation"),
            title=raw.get("title", ""),
            body=raw.get("body", ""),
            pinned=bool(raw.get("pinned", False)),
            at=raw.get("at", ""),
        )


class ProjectMemory:
    def __init__(self, home: Path, project_id: str) -> None:
        self._store = JsonStore(home / "memory" / f"{project_id}.json", default=[])
        raw = self._store.load()
        self._items: list[MemoryItem] = [
            MemoryItem.from_json(r) for r in raw if isinstance(r, dict) and r.get("id")
        ]

    def _save(self) -> None:
        self._store.save([i.to_json() for i in self._items])

    def list(self) -> list[MemoryItem]:
        """Pinned first, then most recent."""
        return sorted(self._items, key=lambda i: (not i.pinned, _descending(i.at)))

    def stats(self) -> dict[str, int]:
        return {
            "total": len(self._items),
            "pinned": sum(1 for i in self._items if i.pinned),
            "decisions": sum(1 for i in self._items if i.kind == "decision"),
            "corrections": sum(1 for i in self._items if i.kind == "correction"),
        }

    def add(
        self, kind: MemoryKind, title: str, body: str, pinned: bool | None = None
    ) -> MemoryItem:
        item = MemoryItem(
            id=gen_id("mem"),
            kind=kind,
            title=title[:MAX_TITLE],
            body=body[:MAX_BODY],
            pinned=pinned if pinned is not None else kind == "pinned",
            at=now_iso(),
        )
        self._items.append(item)
        self._save()
        return item

    def set_pinned(self, item_id: str, pinned: bool) -> MemoryItem | None:
        item = next((i for i in self._items if i.id == item_id), None)
        if item is None:
            return None
        item.pinned = pinned
        self._save()
        return item

    def remove(self, item_id: str) -> bool:
        before = len(self._items)
        self._items = [i for i in self._items if i.id != item_id]
        if len(self._items) == before:
            return False
        self._save()
        return True

    def recall(self, query: str, limit: int = 4) -> list[MemoryItem]:
        """The memory items most relevant to a query.

        Ranking is keyword overlap plus a pin bonus. **No fabrication** —
        an empty store returns nothing rather than something plausible.
        """
        if not self._items:
            return []
        wanted = keywords(query)
        scored = []
        for item in self._items:
            present = keywords(f"{item.title} {item.body}")
            overlap = len(wanted & present)
            score = overlap + (0.5 if item.pinned else 0)
            if score > 0:
                scored.append((score, item))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [item for _score, item in scored[:limit]]


class _Descending(str):
    """Sort a string descending inside an ascending sort key."""

    def __lt__(self, other: object) -> bool:  # type: ignore[override]
        return str(self) > str(other)


def _descending(value: str) -> _Descending:
    return _Descending(value)
