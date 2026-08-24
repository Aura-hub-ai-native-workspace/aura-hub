"""Agent event bus — the observation seam of the central agent.

In-process for this milestone; the P10 API/SSE route will stream the same
AgentEvent payloads verbatim. The bus never mutates events and never
blocks: subscriber faults are contained per-subscriber.
"""

from __future__ import annotations

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
