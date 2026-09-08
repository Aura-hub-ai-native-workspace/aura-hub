"""Run control — the ONE place a run can be cancelled.

Cancellation is an authority question, not a UI gesture: pressing STOP
has to reach a real process, and the answer has to survive a restart.
This module owns the signal and nothing else. It plans nothing, executes
nothing, and decides no policy — the Central Agent still drives the run,
the Fabric still executes it, and the supervisor still judges it.

Three properties the rest of the system relies on:

  idempotent   the second STOP is the same answer as the first, with the
               first one's timestamp and reason. A user who clicks twice
               has not cancelled twice.
  in-flight    the token reaches the worker that is running RIGHT NOW,
               through the invocation context, so termination is a real
               signal to a real process group — not a flag noticed after
               the worker finishes on its own.
  precedent    once requested, cancellation wins. It is never cleared by
               a worker that completes moments later, and it survives
               into the session record so no later leg resurrects it.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

#: Why a run stopped. Only a person cancels; the other two exist so the
#: record can distinguish a user's decision from the system's own limits.
BY_USER = "user"
BY_TIMEOUT = "timeout"
BY_SHUTDOWN = "shutdown"


def _now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z")


@dataclass
class CancellationToken:
    """One run's stop signal, shared by the agent loop and the worker.

    A threading.Event rather than an asyncio one on purpose: the request
    arrives on the HTTP thread while the worker runs on an executor
    thread with its own loop, and the executor bridges it to asyncio at
    the point where it actually waits on a process.
    """

    session_id: str
    _event: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    requested_at: str = ""
    reason: str = ""
    requested_by: str = ""
    #: What the run was doing when STOP arrived. Recorded for evidence;
    #: never used to decide anything.
    task_id: str = ""
    invocation_id: str = ""
    worker_node_id: str = ""

    def request(self, reason: str = "", by: str = BY_USER) -> dict:
        """Ask this run to stop. Safe to call any number of times."""
        with self._lock:
            first = not self._event.is_set()
            if first:
                self.requested_at = _now()
                self.reason = (reason or "cancelled by the user")[:400]
                self.requested_by = by
                self._event.set()
            return {**self.snapshot(), "accepted": True, "firstRequest": first}

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def wait(self, timeout: float | None = None) -> bool:
        return self._event.wait(timeout)

    def note_dispatch(self, task_id: str, invocation_id: str = "",
                      worker_node_id: str = "") -> None:
        """Record what is in flight, so a cancellation record can name it."""
        with self._lock:
            if not self._event.is_set():
                self.task_id = task_id or self.task_id
                self.invocation_id = invocation_id or self.invocation_id
                self.worker_node_id = worker_node_id or self.worker_node_id

    def snapshot(self) -> dict:
        return {
            "sessionId": self.session_id,
            "cancelled": self._event.is_set(),
            "requestedAt": self.requested_at,
            "reason": self.reason,
            "requestedBy": self.requested_by,
            "taskId": self.task_id,
            "invocationId": self.invocation_id,
            "workerNodeId": self.worker_node_id,
        }


class RunControl:
    """Live tokens, keyed by session. One instance per Central Agent.

    A token outlives the run leg that created it: STOP pressed while a
    leg is settling still lands, and a leg that starts afterwards sees an
    already-cancelled token and refuses to dispatch. Tokens are dropped
    only when a run reaches a terminal state that is not cancellation.
    """

    def __init__(self) -> None:
        self._tokens: dict[str, CancellationToken] = {}
        self._lock = threading.Lock()

    def begin(self, session_id: str) -> CancellationToken:
        """The token for this run, creating one if the run is new.

        A session that was cancelled keeps its cancelled token: starting
        a new leg must not quietly clear a decision the user made.
        """
        with self._lock:
            token = self._tokens.get(session_id)
            if token is None:
                token = CancellationToken(session_id=session_id)
                self._tokens[session_id] = token
            return token

    def token_for(self, session_id: str) -> CancellationToken | None:
        with self._lock:
            return self._tokens.get(session_id)

    def request_cancel(self, session_id: str, reason: str = "",
                       by: str = BY_USER) -> dict:
        """Stop this run. Registers a token if the run has not started —
        a STOP that arrives a moment before dispatch must still be seen
        by the leg that is about to begin."""
        token = self.begin(session_id)
        return token.request(reason, by)

    def is_cancelled(self, session_id: str) -> bool:
        token = self.token_for(session_id)
        return bool(token and token.cancelled)

    def clear(self, session_id: str) -> None:
        """Forget a run that ended without being cancelled. A cancelled
        token is deliberately NOT cleared here — only an explicit resume
        may lift it, so nothing in the normal path can resurrect the run.
        """
        with self._lock:
            token = self._tokens.get(session_id)
            if token is not None and not token.cancelled:
                del self._tokens[session_id]

    def release(self, session_id: str) -> None:
        """Drop the token entirely. The ONLY caller is an explicit user
        resume of a cancelled run, which starts a fresh attempt."""
        with self._lock:
            self._tokens.pop(session_id, None)

    def active(self) -> list[dict]:
        with self._lock:
            return [t.snapshot() for t in self._tokens.values()]


#: The process-wide control surface. One authority, like the ledger.
RUN_CONTROL = RunControl()


__all__ = ["BY_SHUTDOWN", "BY_TIMEOUT", "BY_USER", "RUN_CONTROL",
           "CancellationToken", "RunControl"]
