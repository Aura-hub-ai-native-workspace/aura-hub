"""Graceful shutdown of the local API, for platforms that have no SIGTERM.

On Unix the desktop shell stops the backend with SIGTERM, which uvicorn already
turns into a graceful exit. Windows has no SIGTERM, so without a route the shell
can only call TerminateProcess after waiting out its grace period. This adds the
route, and the three properties that make it safe to have:

* It is never open. The instance guard (``instance_guard.py``) already refuses
  every route except ``/health`` and ``/instance/proof`` unless the request
  carries this launch's token. When no token is configured the guard is inert,
  and this route is then refused outright, so a hand-run or test backend has no
  way to be stopped over HTTP by whoever can reach the port.
* ``x-aura-shutdown: 1`` is also required, the same header the Node service
  demands, which a web page cannot send cross-origin (it would need a CORS
  preflight the service does not allow).
* It is idempotent and non-blocking. The first request flips uvicorn's own
  ``should_exit`` flag and answers at once; later requests report that a stop
  is already under way. Nothing waits on the server from inside a request
  handler, so the request that starts the shutdown cannot deadlock it.

Lifecycle policy (the same as for SIGTERM): stop accepting connections, let
in-flight HTTP requests finish for up to ``GRACEFUL_TIMEOUT_S``, then exit.
Background work that runs on daemon threads ends with the process. The shell
keeps its own bounded fallback: it force-terminates a process that is still
alive five seconds after asking.
"""
from __future__ import annotations

import threading
from collections.abc import Callable

#: How long uvicorn lets in-flight requests finish. Shorter than the shell's
#: five-second fallback, so a clean exit wins over a forced one.
GRACEFUL_TIMEOUT_S = 3
SHUTDOWN_HEADER = b"x-aura-shutdown"


class ShutdownCoordinator:
    """Holds the one way this process stops itself, and remembers it was used."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop: Callable[[], None] | None = None
        self._requested = False

    def bind(self, stop: Callable[[], None]) -> None:
        """Called by the entry point once it owns a server that can stop."""
        with self._lock:
            self._stop = stop

    def request(self) -> tuple[int, dict]:
        """Start the shutdown. Returns (HTTP status, truthful body)."""
        with self._lock:
            if self._stop is None:
                return 503, {"ok": False, "error": "this process has no server it can stop"}
            if self._requested:
                return 200, {"ok": True, "shuttingDown": True, "alreadyRequested": True}
            try:
                self._stop()
            except Exception as exc:  # noqa: BLE001 - reported, and a retry stays possible
                return 500, {"ok": False, "error": f"shutdown could not be started: {type(exc).__name__}"}
            self._requested = True
            return 200, {"ok": True, "shuttingDown": True, "alreadyRequested": False}
