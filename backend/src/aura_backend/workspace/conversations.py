"""Per-project, persistent AI history.

A port of packages/ai-service/src/conversations.ts.

**There is no global chat.** Every project owns its own set of
conversations, stored per project and loaded only for that project.
Opening another project loads that project's conversations; they never
mix.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from ..core.json_store import JsonStore
from ..fabric.types import now_iso
from .memory import gen_id

MAX_TITLE = 120
AUTO_TITLE = "New conversation"
Role = Literal["user", "assistant"]


@dataclass
class ConvMessage:
    id: str
    role: Role
    content: str
    at: str
    meta: Any = None
    error: bool | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "role": self.role,
            "content": self.content,
            "at": self.at,
        }
        if self.meta is not None:
            out["meta"] = self.meta
        if self.error is not None:
            out["error"] = self.error
        return out

    @staticmethod
    def from_json(raw: dict[str, Any]) -> ConvMessage:
        return ConvMessage(
            id=raw["id"],
            role=raw.get("role", "user"),
            content=raw.get("content", ""),
            at=raw.get("at", ""),
            meta=raw.get("meta"),
            error=raw.get("error"),
        )


@dataclass
class Conversation:
    id: str
    title: str
    created_at: str
    updated_at: str
    messages: list[ConvMessage] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "messages": [m.to_json() for m in self.messages],
        }

    @staticmethod
    def from_json(raw: dict[str, Any]) -> Conversation:
        return Conversation(
            id=raw["id"],
            title=raw.get("title", AUTO_TITLE),
            created_at=raw.get("createdAt", ""),
            updated_at=raw.get("updatedAt", ""),
            messages=[ConvMessage.from_json(m) for m in raw.get("messages", [])],
        )

    def summary(self) -> dict[str, Any]:
        last_user = next((m for m in reversed(self.messages) if m.role == "user"), None)
        return {
            "id": self.id,
            "title": self.title,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "messageCount": len(self.messages),
            "preview": (last_user.content if last_user else "")[:80],
        }


class ProjectConversations:
    def __init__(self, home: Path, project_id: str) -> None:
        self._store = JsonStore(home / "conversations" / f"{project_id}.json", default=[])
        raw = self._store.load()
        self._items: list[Conversation] = [
            Conversation.from_json(c) for c in raw if isinstance(c, dict) and c.get("id")
        ]

    def _save(self) -> None:
        self._store.save([c.to_json() for c in self._items])

    def list(self) -> list[dict[str, Any]]:
        """Summaries, most-recently-updated first."""
        return [
            c.summary()
            for c in sorted(self._items, key=lambda c: c.updated_at, reverse=True)
        ]

    def get(self, conversation_id: str) -> Conversation | None:
        return next((c for c in self._items if c.id == conversation_id), None)

    def create(self, title: str | None = None) -> Conversation:
        now = now_iso()
        conversation = Conversation(
            id=gen_id("conv"),
            title=((title or "").strip() or AUTO_TITLE)[:MAX_TITLE],
            created_at=now,
            updated_at=now,
        )
        self._items.insert(0, conversation)
        self._save()
        return conversation

    def rename(self, conversation_id: str, title: str) -> Conversation | None:
        conversation = self.get(conversation_id)
        if conversation is None:
            return None
        conversation.title = title.strip()[:MAX_TITLE] or conversation.title
        conversation.updated_at = now_iso()
        self._save()
        return conversation

    def remove(self, conversation_id: str) -> bool:
        before = len(self._items)
        self._items = [c for c in self._items if c.id != conversation_id]
        if len(self._items) == before:
            return False
        self._save()
        return True

    def append(
        self,
        conversation_id: str,
        role: Role,
        content: str,
        meta: Any = None,
        error: bool = False,
    ) -> ConvMessage | None:
        """Append a message; the first user turn auto-titles the thread."""
        conversation = self.get(conversation_id)
        if conversation is None:
            return None
        message = ConvMessage(
            id=gen_id("msg"), role=role, content=content, at=now_iso(),
            meta=meta, error=error,
        )
        conversation.messages.append(message)
        conversation.updated_at = message.at
        if role == "user" and conversation.title == AUTO_TITLE:
            conversation.title = content[:60] + ("…" if len(content) > 60 else "")
        self._save()
        return message

    def remove_last_assistant(self, conversation_id: str) -> bool:
        """Drop a trailing assistant turn, for Regenerate.

        A no-op unless the last message is from the assistant, so it can
        **never** remove a user turn.
        """
        conversation = self.get(conversation_id)
        if conversation is None or not conversation.messages:
            return False
        if conversation.messages[-1].role != "assistant":
            return False
        conversation.messages.pop()
        conversation.updated_at = now_iso()
        self._save()
        return True

    def history(self, conversation_id: str, n: int = 8) -> list[dict[str, Any]]:
        """Recent turns, as the pipeline's history shape."""
        conversation = self.get(conversation_id)
        if conversation is None:
            return []
        return [
            {"role": m.role, "content": m.content, "at": _epoch_ms(m.at)}
            for m in conversation.messages[-n:]
        ]

    def count(self) -> int:
        return len(self._items)


def _epoch_ms(iso: str) -> int:
    try:
        return int(datetime.fromisoformat(iso).timestamp() * 1000)
    except ValueError:
        return 0
