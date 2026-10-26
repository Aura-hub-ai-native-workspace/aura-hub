"""One coding worker edits a project at a time.

A coding worker (an `agent.delegate` task) edits files in a project folder.
Two of them in the same folder at once race each other, so the product rule
is: **one worker per project, ever** — across tasks of one plan and across
separate sessions that happen to target the same project.

The scheduler already avoids planning two workers side by side. This lease
is the guarantee underneath it: before a worker's process starts, the task
acquires the project's lease; a second task for the same project waits
(and says so) until the first releases it, or gives up if the run is
stopped. The lease lives in this process, which is the only process that
launches workers, so a crashed backend can never leave a project stuck
"locked": the lock dies with it.

Different projects never wait for each other.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable


class LeaseCancelled(Exception):
    """The run was stopped while waiting for the project's worker slot."""


@dataclass
class Lease:
    project: str
    session_id: str
    task_id: str
    worker: str
    since: float = field(default_factory=time.monotonic)

    def as_dict(self) -> dict:
        return {"project": self.project, "sessionId": self.session_id, "taskId": self.task_id,
                "worker": self.worker, "heldForSeconds": round(time.monotonic() - self.since, 1)}


class ProjectWorkerLeases:
    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._held: dict[str, Lease] = {}

    def acquire(self, project: str, *, session_id: str, task_id: str, worker: str = "",
                cancelled: Callable[[], bool] = lambda: False,
                on_wait: Callable[[Lease], None] | None = None,
                poll: float = 0.2, timeout: float | None = 3600.0) -> Lease:
        """Take the project's worker slot, waiting while another worker has it."""
        if not project:
            raise ValueError("a worker lease needs a project key")
        deadline = None if timeout is None else time.monotonic() + timeout
        announced = False
        with self._cond:
            while True:
                holder = self._held.get(project)
                if holder is None:
                    lease = Lease(project, session_id, task_id, worker)
                    self._held[project] = lease
                    return lease
                if holder.session_id == session_id and holder.task_id == task_id:
                    return holder  # re-entrant for the very same task (a retry)
                if not announced and on_wait is not None:
                    announced = True
                    try:
                        on_wait(holder)
                    except Exception:  # noqa: BLE001 — telemetry must not break scheduling
                        pass
                if cancelled():
                    raise LeaseCancelled(f"stopped while waiting for the {project} worker slot")
                if deadline is not None and time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"another worker (task {holder.task_id}) kept the project's worker "
                        "slot for too long")
                self._cond.wait(poll)

    def release(self, lease: Lease) -> None:
        with self._cond:
            if self._held.get(lease.project) is lease:
                del self._held[lease.project]
            self._cond.notify_all()

    def holder(self, project: str) -> dict | None:
        with self._cond:
            held = self._held.get(project)
            return held.as_dict() if held else None

    def snapshot(self) -> list[dict]:
        with self._cond:
            return [lease.as_dict() for lease in self._held.values()]


#: The process-wide registry. One backend process launches all workers.
LEASES = ProjectWorkerLeases()

__all__ = ["LEASES", "Lease", "LeaseCancelled", "ProjectWorkerLeases"]
