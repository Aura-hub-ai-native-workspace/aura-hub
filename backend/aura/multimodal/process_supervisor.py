"""Enforceable execution timeouts via process isolation.

A thread watchdog cannot interrupt hung native code (model load, OCR,
PDF parsing). The only enforceable supervisor on POSIX is a separate
process that the parent can ``terminate()`` after the budget expires.

Usage::

    from .process_supervisor import run_isolated

    outcome = run_isolated(_convert_task, payload, timeout_s=120.0)
    if outcome.timed_out:
        ...  # worker was SIGTERM/SIGKILLed; no result, nothing half-written

The worker entry point must be a module-level (picklable) callable taking
a single JSON-compatible payload dict and returning a JSON-compatible
dict. File paths cross the boundary as strings; converted content comes
back as data, never as shared memory.
"""

from __future__ import annotations

import multiprocessing as _mp
import queue
import time
from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class IsolatedOutcome:
    """Result of one supervised run."""

    ok: bool = False
    timed_out: bool = False
    crashed: bool = False
    result: Any = None
    error: str = ""
    elapsed_s: float = 0.0


def _worker_entrypoint(target: Callable[[dict], dict], payload: dict,
                       out_queue: Any) -> None:
    try:
        out_queue.put({"ok": True, "result": target(payload)})
    except Exception as exc:  # worker-side failure, reported not raised
        out_queue.put({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def run_isolated(target: Callable[[dict], dict], payload: dict,
                 timeout_s: float) -> IsolatedOutcome:
    """Run ``target(payload)`` in a spawned child with a hard timeout.

    On timeout the child is terminated (SIGTERM, then SIGKILL after a
    5 s grace period) and ``timed_out=True`` is returned. Nothing the
    child half-wrote is trusted: callers must treat timeout as
    no-result, not partial-result.
    """
    started = time.monotonic()
    ctx = _mp.get_context("spawn")
    out_queue: Any = ctx.Queue()
    proc = ctx.Process(target=_worker_entrypoint,
                       args=(target, payload, out_queue))
    proc.start()
    proc.join(timeout_s)
    elapsed = time.monotonic() - started

    if proc.is_alive():
        proc.terminate()
        proc.join(5.0)
        if proc.is_alive():
            proc.kill()
            proc.join(5.0)
        return IsolatedOutcome(ok=False, timed_out=True, elapsed_s=elapsed,
                               error=f"conversion exceeded {timeout_s}s budget")

    try:
        message = out_queue.get_nowait()
    except queue.Empty:
        return IsolatedOutcome(ok=False, crashed=True, elapsed_s=elapsed,
                               error="worker exited without a result "
                                     f"(exitcode={proc.exitcode})")
    if proc.exitcode not in (0, None) and not message.get("ok"):
        return IsolatedOutcome(ok=False, crashed=True, elapsed_s=elapsed,
                               error=message.get("error", "worker failed"))
    if not message.get("ok"):
        return IsolatedOutcome(ok=False, elapsed_s=elapsed,
                               error=message.get("error", "worker failed"))
    return IsolatedOutcome(ok=True, result=message.get("result"),
                           elapsed_s=elapsed)


def max_workers_for_machine(maximum: int = 2) -> int:
    """Sane default worker cap: Docling model workers are GB-scale."""
    try:
        import os

        cpu = os.cpu_count() or 2
    except Exception:
        cpu = 2
    return max(1, min(maximum, cpu // 2 or 1))
