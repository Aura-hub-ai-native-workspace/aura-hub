"""How long a coding worker may run — the owner's call, not the transport's.

A worker's execution deadline is its OWN budget. It is not the model's
transport timeout (how long one HTTP request may take) and it is not the
planner's budget (how long Laya may think). Conflating them is what made a
healthy worker die at ten minutes while it was still doing the work.

The owner sets it in ``<AURA_HOME>/worker-policy.json``::

    {"workerTimeoutMs": 1800000}   # 30 minutes for one coding-agent run

A model, a plan or a task cannot widen it: the value is read from the
owner's file at dispatch, exactly like the billing policy beside it. Absent
or unusable file means the default below, never an unbounded wait.
"""
from __future__ import annotations

from typing import Any

#: Default wall-clock budget for ONE coding-agent execution.
#: A worker that edits a project does real work — installs, builds, tests —
#: and on a slow machine a single task can run for many minutes. Ten
#: minutes was killing healthy workers mid-task; half an hour is the
#: smallest budget that leaves room for a real one.
DEFAULT_WORKER_TIMEOUT_MS = 30 * 60_000

#: Ceiling on the owner's budget. A worker may run long, but not forever:
#: an unbounded wait is indistinguishable from a hang.
MAX_WORKER_TIMEOUT_MS = 6 * 60 * 60_000

#: Smallest budget that still lets a worker start and say something.
MIN_WORKER_TIMEOUT_MS = 60_000


def worker_timeout_ms(context: Any = None, home: Any = None) -> int:
    """The execution budget for one worker run, in milliseconds.

    An explicit per-invocation ``timeoutMs`` in the context wins: the
    workflow governor already sets one, and a caller that knows its own
    deadline has the better claim to it. Otherwise the owner's policy
    file decides, and the default applies when it does not say.

    The result is always bounded: never zero, never negative, never
    unbounded.
    """
    if isinstance(context, dict):
        raw = context.get("timeoutMs")
        if raw is not None:
            try:
                return max(MIN_WORKER_TIMEOUT_MS,
                           min(int(raw), MAX_WORKER_TIMEOUT_MS))
            except (TypeError, ValueError):
                pass  # fall through to the owner's budget
    from ..workers.billing import owner_setting

    raw = owner_setting("workerTimeoutMs", DEFAULT_WORKER_TIMEOUT_MS, home)
    try:
        ms = int(raw)
    except (TypeError, ValueError):
        ms = DEFAULT_WORKER_TIMEOUT_MS
    return max(MIN_WORKER_TIMEOUT_MS, min(ms, MAX_WORKER_TIMEOUT_MS))


__all__ = [
    "DEFAULT_WORKER_TIMEOUT_MS",
    "MAX_WORKER_TIMEOUT_MS",
    "MIN_WORKER_TIMEOUT_MS",
    "worker_timeout_ms",
]
