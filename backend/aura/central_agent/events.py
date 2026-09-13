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


class _StreamLagged(Exception):
    """A live consumer fell behind LIVE_QUEUE_MAX frames. The route must
    tell the client to resubscribe from its last seen sequence rather
    than silently skipping history."""


class EventBus:
    #: Live subscribers that fall this far behind are dropped and told to
    #: resubscribe from their last seen sequence (at-least-once delivery
    #: + client dedupe = effectively-once; audit stays authoritative).
    LIVE_QUEUE_MAX = 200
    #: Cap on one replay window: reconnects never dump the whole tail.
    REPLAY_MAX = 200

    def __init__(self, tail_limit: int = 500) -> None:
        self._subscribers: list[Subscriber] = []
        self._tail: list[AgentEvent] = []
        self._tail_limit = tail_limit
        self._seq = 0

    def subscribe(self, fn: Subscriber) -> Callable[[], None]:
        self._subscribers.append(fn)
        return lambda: self._subscribers.remove(fn) if fn in self._subscribers else None

    def subscriber_count(self) -> int:
        """Live subscriber count — lets tests prove disconnect cleanup."""
        return len(self._subscribers)

    def emit(self, event: AgentEvent) -> None:
        self._seq += 1
        try:
            event = event.model_copy(update={"seq": self._seq})
        except Exception:
            pass  # a foreign-shaped event still fans out; seq is best-effort
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

    def tail_after(self, session_filter: str | None = None,
                   after: int | None = None,
                   limit: int = REPLAY_MAX) -> list[AgentEvent]:
        """Bounded replay window: tail events for one session (plus the
        global "-" channel) with `seq` strictly greater than `after`.
        Monotonic per stream because the bus counter is monotonic."""
        out = [e for e in self._tail
               if (not session_filter or e.sessionId in (session_filter, "-"))
               and (after is None or (e.seq or 0) > after)]
        return out[-limit:]

    def subscribe_live(self, session_filter: str | None = None):
        """Live-follow subscription for one HTTP stream.

        Returns (pump, close) where pump() blocks on the next matching
        event (or raises queue.Empty) and close() unsubscribes. Slow
        consumers are dropped after LIVE_QUEUE_MAX buffered frames —
        pump then raises _StreamLagged so the route can emit a resync
        directive instead of silently skipping history.
        """
        q: queue.Queue = queue.Queue(maxsize=self.LIVE_QUEUE_MAX)
        lagged = {"dropped": 0}

        def push(event: AgentEvent) -> None:
            if session_filter and event.sessionId not in (session_filter, "-"):
                return
            try:
                q.put_nowait(event)
            except queue.Full:
                lagged["dropped"] += 1

        unsubscribe = self.subscribe(push)

        def pump(timeout: float | None = None) -> AgentEvent:
            try:
                return q.get(timeout=timeout)
            except queue.Empty:
                if lagged["dropped"]:
                    lagged["dropped"] = 0
                    raise _StreamLagged()
                raise

        return pump, unsubscribe

    def tail_stream(self, session_filter: str | None = None) -> list[str]:
        """Serialized tail for one session, WITHOUT live following.

        Kept for the legacy stdlib host. The canonical Starlette route
        uses tail_after + subscribe_live instead.
        """
        return [json.dumps(event.model_dump(), ensure_ascii=False)
                for event in self._tail
                if not session_filter or event.sessionId in (session_filter, "-")]

    def subscribe_stream(self, session_filter: str | None = None):
        """Generator over serialized events: replays the tail, then follows
        live. Terminates when the consumer closes the connection."""
        q: queue.Queue[str] = queue.Queue(maxsize=1000)

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

