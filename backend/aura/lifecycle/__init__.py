"""Process lifecycle: instance ownership and orphan cleanup (issue #112).

``instance`` — the OS lock each AURA process holds for its whole life.
``procident`` — process liveness and start identity (pid reuse safe).
``registry`` — host (non-container) worker processes.
``reaper`` — the one rule for removing workers of dead instances.
"""

from __future__ import annotations

import logging

from . import instance, registry  # noqa: F401
from .reaper import reap_orphans  # noqa: F401

_log = logging.getLogger(__name__)


def reap_now(home, *, containers: bool = True, workers: bool = True) -> dict:
    """Reap orphans for ``home`` as the current instance. Never raises."""
    try:
        me = instance.acquire(home)
        report = reap_orphans(home, me, containers=containers, workers=workers)
    except Exception as exc:  # noqa: BLE001 — cleanup must never break the caller
        _log.exception("orphan cleanup failed")
        return {"error": f"{type(exc).__name__}: {exc}"}
    done = report.get("removedContainers") or report.get("terminatedWorkers")
    kept = report.get("keptContainers") or report.get("keptWorkers") or report.get("deferred")
    if done:
        _log.warning("removed orphaned workers of a previous AURA process: %s",
                     {k: report[k] for k in ("removedContainers", "terminatedWorkers")})
    if report.get("deferred") or report.get("skipped"):
        # Visible at the default level: a cleanup that could not run is not routine.
        _log.warning("orphan cleanup deferred or skipped: %s",
                     {k: report.get(k) for k in ("deferred", "skipped")})
    if kept:
        _log.info("orphan cleanup left items untouched: %s",
                  {k: report.get(k) for k in ("keptContainers", "keptWorkers")})
    return report
