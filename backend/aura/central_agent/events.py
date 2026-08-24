"""Agent event bus — the observation seam of the central agent.

In-process for this milestone; the P10 API/SSE route will stream the same
AgentEvent payloads verbatim. The bus never mutates events and never
blocks: subscriber faults are contained per-subscriber.
"""

from __future__ import annotations

import json
import queue
from collections.abc import Callable

from ..contracts import AgentEvent

Subscriber = Callable[[AgentEvent], None]


class EventBus:
    def __init__(self, tail_limit: int = 500) -> None:
        self._subscribers: list[Subscriber] = []
        self._tail: list[AgentEvent] = []
        self._tail_limit = tail_limit

    def subscribe(self, fn: Subscriber) -> Callable[[], None]:
        self._subscribers.append(fn)
        return lambda: self._subscribers.remove(fn) if fn in self._subscribers else None

    def emit(self, event: AgentEvent) -> None:
        self._tail.append(event)
        if len(self._tail) > self._tail_limit:
            del self._tail[: len(self._tail) - self._tail_limit]
        for fn in list(self._subscribers):
            try:
                fn(event)
            except Exception:
                pass  # one bad observer never breaks an execution

    @property
    def tail(self) -> list[AgentEvent]:
        return list(self._tail)

    def clear_tail(self) -> None:
        self._tail.clear()

    def subscribe_stream(self, session_filter: str | None = None):
        """Generator over serialized events: replays the tail, then follows
        live. Terminates when the consumer closes the connection."""
        q: "queue.Queue[str]" = queue.Queue(maxsize=1000)

        def push(event: AgentEvent) -> None:
            if session_filter and event.sessionId not in (session_filter, "-"):
                return
            try:
                q.put_nowait(json.dumps(event.model_dump(), ensure_ascii=False))
            except queue.Full:
                pass  # drop for a slow consumer; audit stays authoritative

        unsubscribe = self.subscribe(push)
        try:
            for event in self._tail:
                if not session_filter or event.sessionId in (session_filter, "-"):
                    yield json.dumps(event.model_dump(), ensure_ascii=False)
            while True:
                item = q.get()
                if item is None:
                    return
                yield item
        finally:
            unsubscribe()

    def close_stream(self) -> None:
        self._tail.clear()

